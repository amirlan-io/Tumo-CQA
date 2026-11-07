import {
  CliError, aiSettings, apiBase, apiGet, argumentsFor, checklistVersion, datasetRecords,
  findConversation, isMain, loadAi, measureEvaluation, normalizeConversation, printError,
  protectInputs, readJson, required, validateOutput, writePrivateJson
} from './ai-common.js';

const help = `Одиночная реальная AI-оценка (без записи в API/БД).

node --env-file-if-exists=.env scripts/ai-evaluate.js \\
  --version <UUID> --conversation <ID организаторов или UUID> [параметры]

  --api-base <URL>       default: http://127.0.0.1:3000
  --version <UUID>       обязательная сохранённая версия, latest не выбирается
  --conversation <ID>    обязательный ID диалога
  --dataset <path>       локальный JSON; без него диалог загружается из API
  --output <path>        default: data/ai-results/single.json
  -h, --help

Нужен AI_API_KEY; AI_* читаются из окружения, .env скрипт не загружает.
В output сохраняется только успешный {model,prompt_version,results}; latency — в консоли.
Запросы модели платные; transcript передаётся настроенному AI-провайдеру.`;

export async function main(args) {
  const values = argumentsFor({
    'api-base': { type: 'string', default: 'http://127.0.0.1:3000' },
    version: { type: 'string' }, conversation: { type: 'string' },
    dataset: { type: 'string' }, output: { type: 'string', default: 'data/ai-results/single.json' }
  }, args);
  if (values.help) { console.log(help); return; }
  const versionId = required(values, 'version');
  const conversationId = required(values, 'conversation');
  const base = apiBase(values['api-base']);
  const settings = aiSettings();
  protectInputs(required(values, 'output'), [values.dataset]);
  const version = await checklistVersion(base, versionId);
  let record;
  if (values.dataset !== undefined) {
    required(values, 'dataset');
    record = findConversation(datasetRecords(await readJson(values.dataset, 'dataset')), conversationId);
  } else {
    const records = await apiGet(base, 'api/conversations');
    if (!Array.isArray(records)) throw new CliError('API вернул неверный список диалогов.', 'invalid_api_response');
    const summary = findConversation(records, conversationId);
    if (typeof summary.id !== 'string') throw new CliError('У диалога из API отсутствует UUID.', 'invalid_api_response');
    record = await apiGet(base, `api/conversations/${encodeURIComponent(summary.id)}`);
    if (record?.id !== summary.id || record?.conversation_id !== summary.conversation_id)
      throw new CliError('Детальная карточка не совпала с выбранным диалогом.', 'invalid_api_response');
  }
  const conversation = normalizeConversation(record);
  const ai = await loadAi();
  const measured = await measureEvaluation(ai.evaluateDialogue, conversation, version, settings.timeoutMs);
  if (measured.error) throw measured.error;
  validateOutput(measured.output, conversation, version, ai.model, ai.prompt_version);
  await writePrivateJson(values.output, measured.output, settings.apiKey);
  console.table([{ model: measured.output.model, prompt_version: measured.output.prompt_version,
    criteria: measured.output.results.length, latency_ms: measured.latency_ms, status: 'saved' }]);
  console.log('Сохранён только валидный реальный ответ; время не добавлено в JSON.');
}

if (isMain(import.meta.url)) main().catch(printError);
