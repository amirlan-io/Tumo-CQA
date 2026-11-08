import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile, mkdir, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildSubmission, validateSubmission, validateSubmissionVersion, validateSubmissionError } from '../server/services/submission.js';
import { prepareInput, createOutputContract } from '../server/services/ai-contract.js';
import {
  CliError, argumentsFor, required, apiBase, checklistVersion, readJson, datasetRecords,
  normalizeConversation, aiSettings, loadAi, measureEvaluation, safeError, attemptRecord,
  sha256, canonical, sourceSnapshot, protectInputs, writePrivateJson, isMain, printError
} from './ai-common.js';

const help = `Подготовка официальной сдачи JSON 1.0 — исходная рубрика, реальные оценки, серверный score.

npm run results:prepare -- --split dev --dataset <path> --version <UUID> --team <название>

  --split dev|prod          DEV: 65 (60 чатов + 5 звонков); PROD: 10 чатов
  --dataset <path>          полный исходный JSON организаторов
  --version <UUID>          версия из API (default API http://127.0.0.1:3000)
  --api-base <URL>          адрес существующего сервера
  --version-file <path>     вместо API: ранее сохранённый полный объект версии из API
  --team <название>         точное название команды; либо TEAM_NAME в окружении
  --output <path>           default: results/<split>/results.json
  --journal <path>          default: data/ai-results/<split>-preparation.json
  --concurrency <1..3>      default: 1; серверная очередь не изменяется
  --delay-ms <n>            пауза перед следующим диалогом в каждом worker; default: 1000
  --max-new <n>             обработать максимум n ещё не обработанных диалогов за запуск
  --prepare-only           только закрытый журнал; название команды пока не требуется
  --export-only            выгрузить завершённый журнал без вызова модели
  --validate-only          проверить существующий output без вызова модели
  --retry-errors           явно заново оценить только ошибки и ещё не обработанные диалоги

Один repair остаётся внутри evaluateDialogue. Сеть/HTTP не повторяются автоматически.
Возобновление возможно только с теми же данными, версией, моделью, промптом и настройками.
Журнал приватный; официальный файл не содержит transcript, audio_url и сырого ответа API.
При неполном журнале output НЕ создаётся; при ошибках сохраняются status=error, не нулевые баллы.
`;

export function loadSubmissionDataset(payload, split) {
  const conversations = datasetRecords(payload).map(normalizeConversation);
  const expected = split === 'dev' ? 65 : split === 'prod' ? 10 : null;
  if (!expected || conversations.length !== expected) throw new CliError('Нужен полный DEV из 65 диалогов или PROD из 10 чатов.', 'invalid_input');
  const ids = new Set(conversations.map(c => c.conversation_id));
  const calls = conversations.filter(c => c.channel === 'voice call').length;
  if (ids.size !== expected || calls !== (split === 'dev' ? 5 : 0))
    throw new CliError('Неверный набор: повторные ID, либо не 60 чатов + 5 звонков DEV / 10 чатов PROD.', 'invalid_input');
  const metadata = payload?.data;
  if (metadata?.total_records !== undefined && metadata.total_records !== expected)
    throw new CliError('total_records не совпадает с полным размером набора.', 'invalid_input');
  if (typeof metadata?.dataset_group_id === 'string'
    && ((metadata.dataset_group_id.toUpperCase() === 'DEV') !== (split === 'dev')))
    throw new CliError('Группа набора не соответствует dev/prod.', 'invalid_input');
  return conversations;
}

function checkOutput(output, conversation, version, modelName, promptVersion) {
  if (!output || Object.keys(output).sort().join(',') !== 'model,prompt_version,results'
    || output.model !== modelName || output.prompt_version !== promptVersion)
    throw new CliError('Модель или версия промпта не совпали с зафиксированным запуском.', 'invalid_output');
  const parsed = createOutputContract(prepareInput(conversation, version)).parse(JSON.stringify({ results: output.results }));
  if (parsed.errors.length) throw new CliError('Ответ не прошёл строгую проверку AI-контракта.', 'invalid_output');
}

export function publicEvaluation(entry) {
  return entry.status === 'ok'
    ? { conversation_id: entry.conversation_id, status: 'ok', output: entry.output }
    : { conversation_id: entry.conversation_id, status: 'error', error: entry.error };
}

export async function prepareResults({ conversations, version, split, journalPath, modelName, promptVersion,
  fingerprint, evaluateFactory, timeoutMs = 55000, concurrency = 1, delayMs = 1000, maxNew = Infinity,
  retryErrors = false, exportOnly = false, apiKey, onProgress = () => {} }) {
  validateSubmissionVersion(version);
  loadSubmissionDataset(conversations, split);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3
    || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60000
    || !(maxNew === Infinity || (Number.isSafeInteger(maxNew) && maxNew > 0)))
    throw new CliError('Некорректные ограничения пакетного запуска.');
  const contract = { split, model: modelName, prompt_version: promptVersion,
    dataset_sha256: sha256(conversations), version_sha256: sha256(version), fingerprint };
  await mkdir(dirname(journalPath), { recursive: true, mode: 0o700 });
  let lock;
  try { lock = await open(`${journalPath}.lock`, 'wx', 0o600); }
  catch { throw new CliError('Журнал занят другим процессом или недоступен. Не запускайте подготовку дважды; после аварии проверьте оставшийся .lock.', 'filesystem'); }
  try {
    let journal, missing = false;
    try { journal = JSON.parse(await readFile(journalPath, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new CliError('Журнал повреждён или недоступен; автоматическое затирание запрещено.', 'invalid_input');
      missing = true;
    }
    if (missing) {
      if (exportOnly) throw new CliError('Для --export-only нужен существующий завершённый журнал.');
      journal = { schema_version: 'preparation-1.0', created_at: new Date().toISOString(), contract,
        checklist_version: version, entries: [] };
    }
    if (!journal || typeof journal !== 'object' || Array.isArray(journal)
      || journal.schema_version !== 'preparation-1.0' || canonical(journal.contract) !== canonical(contract)
      || canonical(journal.checklist_version) !== canonical(version) || !Array.isArray(journal.entries))
      throw new CliError('Журнал относится к другому набору, версии, модели, промпту или настройкам. Используйте отдельный --journal.', 'contract_changed');
    const sources = new Map(conversations.map(c => [c.conversation_id, c]));
    const entries = new Map();
    for (const entry of journal.entries) {
      const conversation = sources.get(entry?.conversation_id);
      if (!conversation || entries.has(entry.conversation_id) || !['ok', 'error'].includes(entry.status))
        throw new CliError('Журнал содержит неизвестный/повторный ID или некорректный статус.', 'invalid_input');
      if (entry.status === 'ok') checkOutput(entry.output, conversation, version, modelName, promptVersion);
      else {
        try { validateSubmissionError(entry.error); }
        catch { throw new CliError('В журнале ошибка без безопасной причины.', 'invalid_input'); }
      }
      entries.set(entry.conversation_id, entry);
    }
    let writes = Promise.resolve();
    const persist = () => {
      writes = writes.then(async () => {
        journal.entries = conversations.flatMap(c => entries.has(c.conversation_id) ? [entries.get(c.conversation_id)] : []);
        journal.updated_at = new Date().toISOString();
        await writePrivateJson(journalPath, journal, apiKey);
      });
      return writes;
    };
    await persist();
    const pending = exportOnly ? [] : conversations.filter(c => !entries.has(c.conversation_id)
      || (retryErrors && entries.get(c.conversation_id).status === 'error')).slice(0, maxNew);
    let next = 0;
    const context = new AsyncLocalStorage();
    const worker = async () => {
      let processed = 0;
      while (next < pending.length) {
        const conversation = pending[next++];
        if (processed++ && delayMs) await delay(delayMs);
        const attempts = [];
        const evaluate = evaluateFactory(event => {
          const active = context.getStore();
          if (active?.open) {
            const validationErrors = Array.isArray(event?.validation_errors) ? event.validation_errors.slice(0, 20).map(value => {
              let message = typeof value === 'string' ? value : 'Некорректная диагностическая запись.';
              if (apiKey) message = message.replaceAll(apiKey, '[REDACTED]');
              return message.replace(/https?:\/\/\S+/giu, '[URL удалён]').slice(0, 4000);
            }) : [];
            const record = attemptRecord({ ...event, validation_errors: validationErrors });
            if (apiKey && record.diagnostic_id?.includes(apiKey)) record.diagnostic_id = null;
            active.attempts.push(record);
          }
        });
        const active = { attempts, open: true };
        const measured = await context.run(active, () => measureEvaluation(evaluate, conversation, version, timeoutMs));
        active.open = false;
        let error = measured.error;
        if (!error) {
          try { checkOutput(measured.output, conversation, version, modelName, promptVersion); }
          catch (cause) { error = cause; }
        }
        const entry = { conversation_id: conversation.conversation_id, status: error ? 'error' : 'ok',
          latency_ms: measured.latency_ms, attempts, finished_at: new Date().toISOString(),
          ...(error ? { error: safeError(error, attempts).message, error_kind: safeError(error, attempts).kind }
            : { output: measured.output }) };
        entries.set(conversation.conversation_id, entry);
        await persist();
        onProgress({ conversation_id: entry.conversation_id, status: entry.status, latency_ms: entry.latency_ms,
          completed: entries.size, total: conversations.length, attempts: attempts.length });
      }
    };
    // Wait for every active worker even if a checkpoint write fails, before releasing the lock.
    const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
    const failedWorker = workers.find(result => result.status === 'rejected');
    if (failedWorker) throw failedWorker.reason;
    await writes;
    const ordered = conversations.flatMap(c => entries.has(c.conversation_id) ? [entries.get(c.conversation_id)] : []);
    return { journal, entries: ordered, completed: entries.size, pending: conversations.length - entries.size,
      ok: ordered.filter(e => e.status === 'ok').length, errors: ordered.filter(e => e.status === 'error').length };
  } finally {
    await lock.close();
    await unlink(`${journalPath}.lock`);
  }
}

async function implementationFingerprint() {
  const sources = { ...await sourceSnapshot() };
  for (const path of ['server/score.js', 'server/schemas/submission-v1.json'])
    sources[path] = sha256(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
  return sha256(sources);
}

export async function main(args) {
  const values = argumentsFor({
    split: { type: 'string' }, dataset: { type: 'string' }, version: { type: 'string' },
    'version-file': { type: 'string' }, 'api-base': { type: 'string', default: 'http://127.0.0.1:3000' },
    team: { type: 'string' }, output: { type: 'string' }, journal: { type: 'string' },
    concurrency: { type: 'string', default: '1' }, 'delay-ms': { type: 'string', default: '1000' },
    'max-new': { type: 'string' }, 'prepare-only': { type: 'boolean', default: false },
    'export-only': { type: 'boolean', default: false }, 'validate-only': { type: 'boolean', default: false },
    'retry-errors': { type: 'boolean', default: false }
  }, args);
  if (values.help) { console.log(help); return; }
  const split = required(values, 'split');
  const datasetPath = required(values, 'dataset');
  const outputPath = values.output ?? `results/${split}/results.json`;
  const journalPath = values.journal ?? `data/ai-results/${split}-preparation.json`;
  const conversations = loadSubmissionDataset(await readJson(datasetPath, 'dataset'), split);
  if (Boolean(values.version) === Boolean(values['version-file'])) throw new CliError('Укажите ровно один --version или --version-file.');
  const version = values['version-file'] ? await readJson(values['version-file'], 'snapshot версии')
    : await checklistVersion(apiBase(values['api-base']), values.version);
  validateSubmissionVersion(version);
  protectInputs(outputPath, [datasetPath, journalPath, values['version-file']]);
  protectInputs(journalPath, [datasetPath, values['version-file']]);
  const exclusive = ['prepare-only', 'export-only', 'validate-only'].filter(name => values[name]);
  if (exclusive.length > 1 || (values['export-only'] && values['retry-errors'])) throw new CliError('Режимы prepare/export/validate-only взаимоисключающие.');
  if (values['validate-only']) {
    const document = await readJson(outputPath, 'официальный файл');
    validateSubmission(document, { conversations, split, version });
    console.log(`PASS: ${document.results.length} уникальных исходных ID; JSON 1.0, восемь критериев, evidence и серверный score проверены.`);
    return;
  }
  const teamName = values.team ?? process.env.TEAM_NAME;
  if (!values['prepare-only'] && (typeof teamName !== 'string' || !teamName.trim()))
    throw new CliError('Нужно точное название команды: --team или TEAM_NAME. Для подготовки оценок до уточнения есть --prepare-only.');
  const ai = await loadAi();
  const settings = values['export-only'] ? { apiKey: process.env.AI_API_KEY, timeoutMs: 55000 } : aiSettings();
  const fingerprint = {
    implementation: await implementationFingerprint(), base_url: process.env.AI_BASE_URL ?? 'https://openrouter.ai/api/v1',
    structured_output: process.env.AI_STRUCTURED_OUTPUT ?? 'json_schema', max_tokens: process.env.AI_MAX_TOKENS ?? '4096',
    provider: process.env.AI_PROVIDER ?? null, reasoning_effort: process.env.AI_REASONING_EFFORT ?? null
  };
  const prepared = await prepareResults({ conversations, version, split, journalPath, modelName: ai.model,
    promptVersion: ai.prompt_version, fingerprint, apiKey: settings.apiKey, timeoutMs: settings.timeoutMs,
    concurrency: Number(values.concurrency), delayMs: Number(values['delay-ms']),
    maxNew: values['max-new'] === undefined ? Infinity : Number(values['max-new']), retryErrors: values['retry-errors'],
    exportOnly: values['export-only'], evaluateFactory: onAttempt => ai.createEvaluator({ ...settings, onAttempt }),
    onProgress: row => console.log(JSON.stringify(row)) });
  console.log(JSON.stringify({ split, completed: prepared.completed, pending: prepared.pending, ok: prepared.ok, errors: prepared.errors, journal: journalPath }));
  if (values['prepare-only']) return;
  if (prepared.pending) {
    console.log('Output не создан: не все диалоги обработаны. Продолжите с тем же журналом.');
    process.exitCode = 2;
    return;
  }
  const document = buildSubmission({ teamName, modelName: ai.model, modelMode: 'external_api', conversations, version,
    evaluations: prepared.entries.map(publicEvaluation), split });
  await writePrivateJson(outputPath, document, settings.apiKey);
  console.log(`Сохранён ${outputPath}: ${prepared.ok} ok, ${prepared.errors} error. Это реальные оценки модели, не экспертный gold.`);
  if (prepared.errors) process.exitCode = 1;
}

if (isMain(import.meta.url)) main().catch(printError);
