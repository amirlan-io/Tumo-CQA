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
      if (r.checked_range != null) {
        const { from, to } = r.checked_range;
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > conversation.transcript.length)
          throw fail('Неверный проверенный диапазон реплик');
      }
      if (r.evidence_quotes != null) {
        const normalize = s => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
        if (!Array.isArray(r.evidence_quotes) || r.evidence_quotes.some(q => !q || !text(q.quote)
          || !r.evidence_message_nos.includes(q.message_no)
          || !normalize(conversation.transcript[q.message_no - 1]?.text ?? '').includes(normalize(q.quote))))
          throw fail('Цитата не найдена в указанной реплике');
      }
    }
    validateAnswers(version, results);
}
