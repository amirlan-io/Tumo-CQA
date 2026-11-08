import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import Ajv from 'ajv';
import { defaultConfig, validateConfig } from '../checklists.js';
import { calculateScore } from '../score.js';
import { validateResults } from '../validate-results.js';
import { prepareInput, createOutputContract } from './ai-contract.js';

export const officialCriteria = Object.freeze([
  'contact', 'discovery', 'identification', 'consultation', 'empathy', 'dialogue', 'closure', 'critical'
]);
const internalIds = officialCriteria.map((_, index) => `c${index + 1}`);
const originalCriteria = validateConfig(defaultConfig).criteria;
const modelModes = new Set(['local', 'external_api', 'hybrid']);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const fail = message => Object.assign(new Error(message), { status: 400 });
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

// A single private schema/validator avoids both caller mutation and per-export AJV caches.
const validateSchema = new Ajv({
  allErrors: true, strict: true, coerceTypes: false, useDefaults: false, removeAdditional: false
}).compile(JSON.parse(readFileSync(new URL('../schemas/submission-v1.json', import.meta.url), 'utf8')));

export function validateSubmissionVersion(version) {
  const config = validateConfig(version);
  const byId = new Map(config.criteria.map(criterion => [criterion.criterion_id, criterion]));
  const criteria = internalIds.map(id => byId.get(id));
  if (!isDeepStrictEqual(criteria, originalCriteria)) {
    throw fail('Официальная выгрузка требует исходную рубрику c1–c8 без изменений настроек, текста, весов и шкал.');
  }
  return { ...config, criteria };
}

function conversationSet(conversations, split) {
  if (!['dev', 'prod'].includes(split)) throw fail('Нужен split dev или prod.');
  const count = split === 'dev' ? 65 : 10;
  if (!Array.isArray(conversations) || conversations.length !== count) {
    throw fail(`Для ${split} нужно ровно ${count} исходных диалогов.`);
  }
  const byId = new Map();
  let calls = 0;
  for (const conversation of conversations) {
    // The database's id is deliberately not a fallback for the original conversation_id.
    if (!conversation || !nonempty(conversation.conversation_id) || byId.has(conversation.conversation_id)) {
      throw fail('Нужны уникальные исходные conversation_id, без подстановки ID базы.');
    }
    if (!['agent chat', 'voice call'].includes(conversation.channel)) throw fail('Неверный канал исходного диалога.');
    if (conversation.channel === 'voice call') calls++;
    byId.set(conversation.conversation_id, conversation);
  }
  if (calls !== (split === 'dev' ? 5 : 0)) {
    throw fail('DEV должен содержать 60 чатов и 5 звонков, PROD — 10 чатов.');
  }
  return byId;
}

export function validateSubmissionError(error) {
  // Callers supply a public, sanitized reason, never a provider response or Error object.
  // Reject obvious credentials, URLs, raw JSON and stack traces rather than silently replacing it.
  if (!nonempty(error) || /[\u0000-\u001f\u007f-\u009f]|https?:\/\/|bearer\s|\bsk-[\w-]+|(?:api[_-]?key|authorization|access[_-]?token)\s*[:=]|[{}]|\bat\s+\S+\s*\(/iu.test(error)) {
    throw fail('error должен быть непустой безопасной строкой без исходных данных, ключей, URL и stack trace.');
  }
}

function parseOutput(conversation, config, output, modelName) {
  if (!exactKeys(output, ['model', 'prompt_version', 'results'])
    || output.model !== modelName || !nonempty(output.prompt_version)) {
    throw fail('Нужен output {model,prompt_version,results}: model должен совпадать с modelName, prompt_version не может быть пустым.');
  }
  let content;
  try {
    content = JSON.stringify({ results: output.results });
    // JSON.stringify must not erase extra undefined fields or turn invalid numbers into null.
    if (!isDeepStrictEqual(JSON.parse(content).results, output.results)) throw new Error();
  } catch {
    throw fail('Результаты output должны быть JSON без потери полей и значений.');
  }
  const input = prepareInput(conversation, config);
  const parsed = createOutputContract(input).parse(content);
  if (parsed.errors.length) throw fail(`Неверный AI output: ${parsed.errors.join('; ')}`);
  validateResults(conversation, config, parsed.results);
  return parsed.results;
}

function exportCriterion(result, index) {
  let rationale = result.explanation;
  if (result.answer === 'na') rationale += ` Причина N/A: ${result.na_reason}`;
  const evidence = new Set(result.evidence_message_nos);
  if (result.checked_range) {
    const { from, to } = result.checked_range;
    rationale += ` Проверены реплики ${from}–${to}.`;
    for (let messageNo = from; messageNo <= to; messageNo++) evidence.add(messageNo);
  }
  return {
    criterion_id: officialCriteria[index],
    value: result.answer === 'na' ? null : result.answer === 'scale' ? result.raw_score : result.answer === 'yes',
    rationale,
    evidence_turns: [...evidence].sort((a, b) => a - b)
  };
}

export function buildSubmission({ teamName, modelName, modelMode = 'external_api', conversations, version, evaluations, split }) {
  const config = validateSubmissionVersion(version);
  const sources = conversationSet(conversations, split);
  if (!nonempty(teamName) || !nonempty(modelName) || !modelModes.has(modelMode)) {
    throw fail('Нужны непустые teamName, modelName и modelMode local/external_api/hybrid.');
  }
  if (!Array.isArray(evaluations) || evaluations.length !== sources.size) {
    throw fail('Нужна ровно одна evaluation для каждого исходного диалога, включая ошибки.');
  }
  const byId = new Map();
  for (const evaluation of evaluations) {
    if (!evaluation || !sources.has(evaluation.conversation_id) || byId.has(evaluation.conversation_id)) {
      throw fail('В evaluations есть повторяющийся или неизвестный conversation_id.');
    }
    const keys = evaluation.status === 'ok' ? ['conversation_id', 'status', 'output']
      : ['conversation_id', 'status', 'error'];
    if (!['ok', 'error'].includes(evaluation.status) || !exactKeys(evaluation, keys)) {
      throw fail('Evaluation должна быть либо {conversation_id,status:ok,output}, либо {conversation_id,status:error,error}, без смешивания.');
    }
    byId.set(evaluation.conversation_id, evaluation);
  }
  const results = conversations.map(conversation => {
    const evaluation = byId.get(conversation.conversation_id);
    if (evaluation.status === 'error') {
      validateSubmissionError(evaluation.error);
      return { conversation_id: conversation.conversation_id, status: 'error', criteria: [], score: null, error: evaluation.error };
    }
    const answers = parseOutput(conversation, config, evaluation.output, modelName);
    const score = calculateScore(config, answers);
    return {
      conversation_id: conversation.conversation_id,
      status: 'ok',
      criteria: internalIds.map((id, index) => exportCriterion(answers.find(result => result.criterion_id === id), index)),
      score: { final_score: score.total, critical_flag: score.gross_error }
    };
  });
  return validateSubmission({ schema_version: '1.0', team_name: teamName, model: { mode: modelMode, name: modelName }, results },
    { conversations, split, version: config });
}

export function validateSubmission(document, { conversations, split, version } = {}) {
  if (!validateSchema(document)) {
    const errors = validateSchema.errors.slice(0, 20).map(error => `${error.instancePath || '/'}: ${error.message}`);
    throw fail(`Неверный формат submission 1.0: ${errors.join('; ')}`);
  }
  const config = validateSubmissionVersion(version);
  const sources = conversationSet(conversations, split);
  if (document.results.length !== sources.size) throw fail('Число результатов не совпадает с исходным набором.');
  const ids = new Set();
  for (const row of document.results) {
    if (!sources.has(row.conversation_id) || ids.has(row.conversation_id)) {
      throw fail('Результаты должны точно покрывать исходные conversation_id без пропусков и повторов.');
    }
    ids.add(row.conversation_id);
    if (row.status === 'error') {
      validateSubmissionError(row.error);
      continue;
    }
    const byCode = new Map(row.criteria.map(criterion => [criterion.criterion_id, criterion]));
    if (byCode.size !== officialCriteria.length || officialCriteria.some(code => !byCode.has(code))) {
      throw fail('Нужны все восемь официальных критериев ровно по одному разу.');
    }
    const conversation = sources.get(row.conversation_id);
    prepareInput(conversation, config);
    const answers = officialCriteria.map((code, index) => {
      const { value, rationale, evidence_turns } = byCode.get(code);
      const criterion = config.criteria[index];
      return {
        criterion_id: criterion.criterion_id,
        answer: value === null ? 'na' : criterion.answer_type === 'scale' ? 'scale' : value ? 'yes' : 'no',
        raw_score: value === null || criterion.is_gross_error ? null : criterion.answer_type === 'scale' ? value : value ? 1 : 0,
        explanation: rationale,
        evidence_message_nos: evidence_turns,
        checked_range: null,
        na_reason: value === null ? rationale : null
      };
    });
    validateResults(conversation, config, answers);
    if (row.score.critical_flag !== byCode.get('critical').value) throw fail('critical_flag должен совпадать с value критерия critical.');
    if (row.score.final_score !== calculateScore(config, answers).total) throw fail('final_score не совпадает с серверным calculateScore.');
  }
  return document;
}
