import { parseArgs } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { validateConfig } from '../server/checklists.js';
import { validateResults } from '../server/validate-results.js';

export const languages = ['RU', 'KZ', 'EN'];
export const text = value => typeof value === 'string' && value.trim().length > 0;
export class CliError extends Error {
  constructor(message, kind = 'configuration') {
    super(message);
    this.kind = kind;
  }
}

export function argumentsFor(options, args = process.argv.slice(2)) {
  try {
    return parseArgs({ options: { ...options, help: { type: 'boolean', short: 'h' } }, args,
      strict: true, allowPositionals: false }).values;
  } catch {
    throw new CliError('Неверные аргументы. Список параметров: --help.');
  }
}

export function required(values, name) {
  if (!text(values[name])) throw new CliError(`Обязателен --${name}.`);
  return values[name];
}

export function apiBase(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error();
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url;
  } catch {
    throw new CliError('--api-base должен быть HTTP(S)-адресом без credentials, query и fragment.');
  }
}

export async function apiGet(base, endpoint) {
  try {
    const response = await fetch(new URL(endpoint, base), { headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw new CliError(`API: HTTP ${response.status}.`, 'http_error');
    try { return await response.json(); } catch (error) {
      if (['TimeoutError', 'AbortError'].includes(error.name)) throw error;
      throw new CliError('API вернул невалидный JSON.', 'invalid_api_response');
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (['TimeoutError', 'AbortError'].includes(error.name))
      throw new CliError('API не ответил за 15 секунд.', 'timeout');
    throw new CliError('Не удалось получить данные API (сеть или запрещённый redirect).', 'network');
  }
}

export async function checklistVersion(base, id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new CliError('--version должен содержать UUID существующей версии, не latest и не v1.');
  const checklists = await apiGet(base, 'api/checklists');
  const version = await apiGet(base, `api/checklist-versions/${encodeURIComponent(id)}`);
  if (!Array.isArray(checklists) || !version || typeof version.id !== 'string'
    || version.id.toLowerCase() !== id.toLowerCase()
    || !checklists.some(c => c?.id === version.checklist_id))
    throw new CliError('Версия не принадлежит чек-листам выбранного API.', 'invalid_api_response');
  try { validateConfig(version); } catch {
    throw new CliError('API вернул неверную конфигурацию восьми критериев.', 'invalid_api_response');
  }
  if (version.rounding_digits !== 2)
    throw new CliError('Неподдерживаемое округление выбранной версии.', 'invalid_api_response');
  return version;
}

export async function readJson(path, label) {
  let raw;
  try { raw = await readFile(path, 'utf8'); } catch {
    throw new CliError(`Не удалось прочитать ${label}.`, 'filesystem');
  }
  try { return JSON.parse(raw); } catch {
    throw new CliError(`${label}: неверный JSON.`, 'invalid_input');
  }
}

export function datasetRecords(payload) {
  if (payload && Object.hasOwn(payload, 'isSuccess') && payload.isSuccess !== true)
    throw new CliError('Dataset содержит неуспешный ответ организаторов.', 'invalid_input');
  const records = Array.isArray(payload) ? payload : payload?.records ?? payload?.data?.records;
  if (!Array.isArray(records) || !records.length)
    throw new CliError('Dataset: нужен непустой array, {records} или {isSuccess:true,data:{records}}.', 'invalid_input');
  return records;
}

export function findConversation(records, id) {
  const matches = records.filter(c => c && (c.conversation_id === id || c.id === id));
  if (matches.length !== 1)
    throw new CliError(matches.length ? 'ID диалога неоднозначен в наборе.' : 'Диалог не найден в наборе.', 'invalid_input');
  return matches[0];
}

export function normalizeConversation(record) {
  if (!record || !text(record.conversation_id) || !languages.includes(record.language)
    || !['agent chat', 'voice call'].includes(record.channel)
    || !Array.isArray(record.transcript) || !record.transcript.length
    || record.transcript.some((m, i) => !m || !['client', 'operator', 'bot', 'system'].includes(m.speaker)
      || typeof m.text !== 'string' || !text(m.timestamp)
      || (m.message_no !== undefined && m.message_no !== i + 1)))
    throw new CliError('Неверный формат диалога или нумерация transcript (ожидается 1-based).', 'invalid_input');
  return { ...(text(record.id) ? { id: record.id } : {}),
    conversation_id: record.conversation_id, language: record.language, channel: record.channel,
    audio_url: record.audio_url ?? null,
    transcript: record.transcript.map((m, i) => ({ message_no: i + 1, timestamp: m.timestamp,
      speaker: m.speaker, text: m.text })) };
}

export function aiSettings() {
  const apiKey = process.env.AI_API_KEY?.trim();
  if (!apiKey) throw new CliError('Не задан AI_API_KEY. Запустите node --env-file-if-exists=.env scripts/…; ключ не выводится.');
  const milliseconds = (name, fallback) => {
    const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
    if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)
      throw new CliError(`Неверное положительное значение ${name}.`);
    return value;
  };
  return Object.freeze({ apiKey, baseUrl: process.env.AI_BASE_URL,
    timeoutMs: milliseconds('AI_TIMEOUT_MS', 55000),
    requestTimeoutMs: milliseconds('AI_REQUEST_TIMEOUT_MS', 35000),
    diagnosticDir: process.env.AI_DIAGNOSTIC_DIR });
}

export async function loadAi() {
  let ai;
  try { ai = await import('../server/services/ai.js'); } catch {
    throw new CliError('Не удалось загрузить server/services/ai.js. Нужен готовый AI-модуль и корректные AI_* настройки.');
  }
  if (!text(ai.model) || ai.prompt_version !== 'v1' || typeof ai.evaluateDialogue !== 'function'
    || typeof ai.createEvaluator !== 'function')
    throw new CliError('AI-модуль должен экспортировать model, prompt_version=v1, evaluateDialogue и createEvaluator.');
  return ai;
}

export function validateOutput(output, conversation, version, model, promptVersion) {
  if (!output || output.model !== model || output.prompt_version !== promptVersion
    || Object.keys(output).sort().join(',') !== 'model,prompt_version,results')
    throw new CliError('Метаданные ответа не совпали с выбранной моделью/промптом или нарушен формат ответа.', 'invalid_output');
  validateResultSet(output.results, conversation, version);
}

export function validateResultSet(results, conversation, version) {
  const allowed = new Set(['criterion_id', 'answer', 'raw_score', 'explanation',
    'evidence_message_nos', 'checked_range', 'na_reason']);
  if (Array.isArray(results) && results.some(r => r && (Object.keys(r).some(key => !allowed.has(key))
    || (r.na_reason != null && typeof r.na_reason !== 'string'))))
    throw new CliError('Результат содержит поля вне стандартной схемы.', 'invalid_output');
  const evidenceIssues = [];
  if (Array.isArray(results)) for (const r of results) {
    const criterionId = version.criteria.find(c => c.criterion_id === r?.criterion_id)?.criterion_id ?? null;
    if (Array.isArray(r?.evidence_message_nos) && r.evidence_message_nos.some(n =>
      !Number.isInteger(n) || n < 1 || n > conversation.transcript.length))
      evidenceIssues.push({ criterion_id: criterionId, kind: 'invalid_evidence_index' });
    const range = r?.checked_range;
    if (range != null && (typeof range !== 'object' || Array.isArray(range)
      || Object.keys(range).sort().join(',') !== 'from,to'
      || !Number.isInteger(range.from) || !Number.isInteger(range.to)
      || range.from < 1 || range.to > conversation.transcript.length || range.from > range.to))
      evidenceIssues.push({ criterion_id: criterionId, kind: 'invalid_checked_range' });
  }
  try {
    if (evidenceIssues.length) throw new Error();
    validateResults(conversation, version, results);
  } catch {
    const error = new CliError('Ответ не прошёл проверку критериев, баллов или evidence.', 'invalid_output');
    error.evidence_issues = evidenceIssues;
    throw error;
  }
}

export async function measureEvaluation(evaluate, conversation, version, timeoutMs) {
  const controller = new AbortController();
  const started = performance.now();
  let timer;
  try {
    const output = await Promise.race([
      Promise.resolve().then(() => evaluate(conversation, version, { signal: controller.signal })),
      new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort();
        reject(new CliError('Истекло время оценки модели.', 'timeout'));
      }, timeoutMs); })
    ]);
    return { output, latency_ms: Math.round(performance.now() - started) };
  } catch (error) {
    return { error, latency_ms: Math.round(performance.now() - started) };
  } finally { clearTimeout(timer); }
}

export function safeError(error, attempts = []) {
  if (error instanceof CliError) return { kind: error.kind, message: error.message };
  // Never print provider/OS error messages: they can contain keys, signed URLs or input.
  const signature = `${error?.name ?? ''} ${error?.kind ?? ''} ${error?.code ?? ''} ${error?.status ?? ''} ${error?.cause?.code ?? ''} ${error?.message ?? ''}`;
  if (error?.timeout || /timeout|timed out|ETIMEDOUT|AbortError|тайм.?аут|истекло.*время|превышен.*время/i.test(signature))
    return { kind: 'timeout', message: 'Истекло время запроса к модели.' };
  if (/ECONN|ENOTFOUND|EAI_AGAIN|network|fetch failed|socket|сеть|соединен/i.test(signature))
    return { kind: 'network', message: 'Сетевая ошибка при обращении к модели.' };
  if (error?.code === 'AI_INVALID_RESPONSE' || attempts.at(-1)?.status === 'invalid')
    return { kind: 'invalid_output', message: 'Модель не вернула валидный JSON по схеме.' };
  if (Number.isInteger(error?.status) || /http|rate.?limit|unauthorized|forbidden/i.test(signature))
    return { kind: 'http_error', message: 'Провайдер модели вернул HTTP-ошибку.' };
  if (/json|schema|validat|invalid.*(output|result)|невалид|валидац/i.test(signature)
    || attempts.at(-1)?.status === 'invalid')
    return { kind: 'invalid_output', message: 'Модель не вернула валидный JSON по схеме.' };
  return { kind: 'evaluation_error', message: 'Оценка не выполнена; проверьте безопасную диагностику AI-модуля.' };
}

export function attemptRecord(event) {
  return { attempt: Number.isSafeInteger(event?.attempt) ? event.attempt : null,
    status: typeof event?.status === 'string' && /^[a-z_]{1,60}$/.test(event.status) ? event.status : 'unknown',
    validation_errors: structuredClone(event?.validation_errors ?? []),
    elapsed_ms: Number.isFinite(event?.elapsed_ms) ? event.elapsed_ms : null,
    diagnostic_id: typeof event?.diagnostic_id === 'string' && /^[a-zA-Z0-9._-]{1,200}$/.test(event.diagnostic_id)
      ? event.diagnostic_id : null };
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const sha256 = value => createHash('sha256').update(canonical(value)).digest('hex');
export function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export async function sourceSnapshot() {
  const hashes = {};
  const read = async path => {
    hashes[path] = createHash('sha256').update(await readFile(new URL(`../${path}`, import.meta.url))).digest('hex');
  };
  const walk = async path => {
    const entries = await readdir(new URL(`../${path}/`, import.meta.url), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && /\.(?:js|mjs|cjs|json|txt|md)$/.test(entry.name)) await read(child);
    }
  };
  try {
    // Capture prompt/schema implementations, not model-specific generated responses.
    await walk('server/prompts');
    await walk('server/services');
    await read('server/checklists.js');
    await read('server/validate-results.js');
  } catch { throw new CliError('Не удалось зафиксировать исходники промпта/схемы.', 'filesystem'); }
  return freeze(hashes);
}

export async function writePrivateJson(path, value, apiKey) {
  let serialized;
  try { serialized = JSON.stringify(value, null, 2) + '\n'; } catch {
    throw new CliError('Результат нельзя сериализовать в JSON.', 'invalid_output');
  }
  if (apiKey && (serialized.includes(apiKey) || serialized.includes(JSON.stringify(apiKey).slice(1, -1))))
    throw new CliError('Запись отменена: в результате обнаружен API key.', 'invalid_output');
  const directory = dirname(resolve(path));
  const temporary = join(directory, `.ai-${randomUUID()}.tmp`);
  let handle;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(serialized, 'utf8');
    await handle.close();
    handle = null;
    await rename(temporary, resolve(path));
  } catch {
    throw new CliError('Не удалось безопасно записать JSON-результат.', 'filesystem');
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

export function protectInputs(output, inputs) {
  if (inputs.some(input => input && resolve(input) === resolve(output)))
    throw new CliError('--output не должен перезаписывать dataset или gold.');
}
export const isMain = url => process.argv[1] && resolve(process.argv[1]) === fileURLToPath(url);
export function printError(error) {
  console.error(`Ошибка: ${safeError(error).message}`);
  process.exitCode = 1;
}
