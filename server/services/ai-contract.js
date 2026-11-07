import Ajv from 'ajv';
import { validateConfig, validateAnswers } from '../checklists.js';

const ajv = new Ajv({ allErrors: true, strict: true });
const russian = /[а-яё]/iu;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export function prepareInput(conversation, version) {
  const config = validateConfig(version);
  if (!conversation || !['RU', 'KZ', 'EN'].includes(conversation.language)
    || !['agent chat', 'voice call'].includes(conversation.channel)
    || !Array.isArray(conversation.transcript) || !conversation.transcript.length
    || conversation.transcript.some(m => !m || !['client', 'operator', 'bot', 'system'].includes(m.speaker)
      || typeof m.text !== 'string' || !nonempty(m.timestamp))) {
    throw new Error('Нужен диалог с языком RU/KZ/EN и исходным транскриптом.');
  }
  return {
    checklist_version: { id: version.id ?? null, version: version.version ?? null, ...config },
    conversation: {
      conversation_id: conversation.conversation_id ?? conversation.id ?? null,
      channel: conversation.channel, language: conversation.language,
      transcript: conversation.transcript.map((m, i) => ({
        message_no: i + 1, timestamp: m.timestamp, speaker: m.speaker, text: m.text
      }))
    }
  };
}

export function createOutputContract(input) {
  const { criteria } = input.checklist_version;
  const messageCount = input.conversation.transcript.length;
  const messageNo = { type: 'integer', minimum: 1, maximum: messageCount };
  const schema = {
    type: 'object', additionalProperties: false, required: ['results'],
    properties: {
      results: {
        type: 'array', minItems: 8, maxItems: 8,
        items: {
          type: 'object', additionalProperties: false,
          required: ['criterion_id', 'answer', 'raw_score', 'explanation', 'evidence_message_nos', 'checked_range', 'na_reason'],
          properties: {
            criterion_id: { type: 'string', enum: criteria.map(c => c.criterion_id) },
            answer: { type: 'string', enum: ['yes', 'no', 'scale', 'na'] },
            raw_score: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] },
            explanation: { type: 'string', minLength: 1, maxLength: 4000 },
            evidence_message_nos: { type: 'array', items: messageNo, maxItems: messageCount },
            checked_range: {
              anyOf: [
                { type: 'null' },
                { type: 'object', additionalProperties: false, required: ['from', 'to'], properties: { from: messageNo, to: messageNo } }
              ]
            },
            na_reason: { anyOf: [{ type: 'string', minLength: 1, maxLength: 4000 }, { type: 'null' }] }
          }
        }
      }
    }
  };
  const validate = ajv.compile(schema);
  // The returned validator stays usable; do not retain a new schema for every dialogue.
  ajv.removeSchema(schema);
  function parse(content) {
    let output;
    try { output = JSON.parse(content); }
    catch { return { errors: ['Ответ не является JSON. Верни только JSON, без Markdown.'] }; }
    if (!validate(output)) {
      return { errors: validate.errors.slice(0, 20).map(e => `${e.instancePath || '/'}: ${e.message}`) };
    }
    const errors = [];
    const ids = new Set();
    for (const result of output.results) {
      const prefix = result.criterion_id;
      if (ids.has(prefix)) errors.push(`${prefix}: criterion_id повторяется.`);
      ids.add(prefix);
      const criterion = criteria.find(c => c.criterion_id === prefix);
      try { validateAnswers({ criteria: [criterion] }, [result]); }
      catch (error) { errors.push(`${prefix}: ${error.message}`); }
      if (!nonempty(result.explanation) || !russian.test(result.explanation)) errors.push(`${prefix}: нужно русское объяснение.`);
      if (result.answer === 'na') {
        if (!nonempty(result.na_reason) || !russian.test(result.na_reason)) errors.push(`${prefix}: нужна русская причина N/A.`);
      } else if (result.na_reason !== null) errors.push(`${prefix}: вне N/A na_reason должен быть null.`);
      if (new Set(result.evidence_message_nos).size !== result.evidence_message_nos.length) errors.push(`${prefix}: номера доказательств повторяются.`);
      const range = result.checked_range;
      if (range && range.from > range.to) errors.push(`${prefix}: from должен быть не больше to.`);
      const partial = criterion.answer_type === 'scale' && result.answer === 'scale'
        && result.raw_score < Math.max(...criterion.scale.map(s => s.value));
      if (!range && (result.answer === 'no' || partial || !result.evidence_message_nos.length)) {
        errors.push(`${prefix}: для отсутствия действия, частичной шкалы или пустых доказательств нужен checked_range.`);
      }
    }
    if (ids.size !== criteria.length) errors.push('Нужны все восемь уникальных criterion_id выбранной версии.');
    return errors.length ? { errors } : { results: criteria.map(c => output.results.find(r => r.criterion_id === c.criterion_id)), errors: [] };
  }
  return { schema, parse };
}
