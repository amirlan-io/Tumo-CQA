import { validateAnswers } from './checklists.js';
const fail = message => Object.assign(new Error(message), {status:400});
const text = x => typeof x === 'string' && x.trim().length > 0;
export function validateResults(conversation, version, results) {
 if (!Array.isArray(results) || !results.length) throw fail('Нужны результаты');
    const ids = new Set();
    for (const r of results) {
      if (!r || !text(r.criterion_id) || ids.has(r.criterion_id) || !text(r.explanation)
        || !['yes', 'no', 'scale', 'na'].includes(r.answer)
        || !(r.raw_score === null || (Number.isFinite(r.raw_score) && r.raw_score >= 0))
        || !Array.isArray(r.evidence_message_nos)
        || r.evidence_message_nos.some(n => !Number.isInteger(n) || n < 1 || n > conversation.transcript.length)
        || (r.answer === 'na' && (!text(r.na_reason) || r.raw_score !== null)))
        throw fail('Неверный результат критерия');
      ids.add(r.criterion_id);
    }
    validateAnswers(version, results);
}
