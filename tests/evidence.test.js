import test from 'node:test';
import assert from 'node:assert/strict';
import { validateResults } from '../server/validate-results.js';
import { defaultConfig, validateConfig } from '../server/checklists.js';

test('evidence quotes and checked ranges must refer to the actual transcript', () => {
  const version = validateConfig(defaultConfig);
  const conversation = { transcript: [{ text: 'Здравствуйте! Меня зовут Дана.' }] };
  const answers = version.criteria.map(c => ({ criterion_id: c.criterion_id,
    answer: c.answer_type === 'scale' ? 'scale' : 'no', raw_score: c.is_gross_error ? null : 0,
    explanation: 'Проверено', evidence_message_nos: [1], checked_range: { from: 1, to: 1 },
    evidence_quotes: [{ message_no: 1, quote: 'Меня зовут Дана' }] }));
  assert.doesNotThrow(() => validateResults(conversation, version, answers));
  const invalidRange = structuredClone(answers); invalidRange[0].checked_range.to = 2;
  assert.throws(() => validateResults(conversation, version, invalidRange));
  const invalidQuote = structuredClone(answers); invalidQuote[0].evidence_quotes[0].quote = 'Выдуманная цитата';
  assert.throws(() => validateResults(conversation, version, invalidQuote));
});
