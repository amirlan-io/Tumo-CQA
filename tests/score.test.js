import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, validateConfig } from '../server/checklists.js';
import { calculateScore, applyDecisions } from '../server/score.js';

const version = validateConfig(defaultConfig);
const full = () => version.criteria.map(c => ({ criterion_id: c.criterion_id,
  answer: c.is_gross_error ? 'no' : c.answer_type === 'scale' ? 'scale' : 'yes',
  raw_score: c.is_gross_error ? null : c.answer_type === 'scale' ? Math.max(...c.scale.map(s => s.value)) : 1 }));

test('full score and sections, gross error does not zero score', () => {
  const answers = full();
  const score = calculateScore(version, answers);
  assert.equal(score.total, 100);
  assert.deepEqual(score.sections.map(s => s.points), [25, 40, 35, 0]);
  answers[7].answer = 'yes';
  assert.equal(calculateScore(version, answers).gross_error, true);
  assert.equal(calculateScore(version, answers).total, 100);
});
test('scale 7 of 10 yields 10.5 points at weight 15', () => {
  const answers = full(); answers[5].raw_score = 7;
  const score = calculateScore(version, answers);
  assert.equal(score.total, 95.5);
  assert.equal(score.criteria[5].points, 10.5);
});
test('N/A redistributes all weights; total uses unrounded contributions', () => {
  const answers = full();
  answers[2] = { criterion_id: 'c3', answer: 'na', raw_score: null, na_reason: 'Общий вопрос' };
  answers[3].raw_score = 0;
  const score = calculateScore(version, answers);
  assert.equal(score.applicable_weight, 80);
  assert.equal(score.total, 75);
  assert.equal(score.criteria[0].effective_weight, 12.5);
  answers[1] = { criterion_id: 'c2', answer: 'na', raw_score: null, na_reason: 'Запрос ясен' };
  assert.equal(calculateScore(version, answers).total, 69.23);
});
test('no applicable weighted criteria yields null, gross flag survives', () => {
  const custom = structuredClone(version);
  custom.criteria.forEach(c => { if (!c.is_gross_error) { c.allow_na = true; c.na_rule = 'Условие'; } });
  const answers = full().map((a, i) => i === 7 ? { ...a, answer: 'yes' }
    : { ...a, answer: 'na', raw_score: null, na_reason: 'Условие' });
  const score = calculateScore(custom, answers);
  assert.equal(score.total, null);
  assert.equal(score.gross_error, true);
  assert.ok(score.sections.every(s => s.points === null));
});
test('confirmation preserves changed score, later change wins, originals immutable', () => {
  const original = full();
  const final = applyDecisions(original, [
    { criterion_id: 'c1', action: 'change', replacement: { answer: 'no', raw_score: 0 } },
    { criterion_id: 'c1', action: 'confirm' }
  ]);
  assert.equal(calculateScore(version, final).total, 90);
  assert.equal(calculateScore(version, original).total, 100);
  assert.throws(() => calculateScore(version, [...original.slice(0, 7), original[0]]));
  const invalid = full(); invalid[5].raw_score = 8;
  assert.throws(() => calculateScore(version, invalid));
});
