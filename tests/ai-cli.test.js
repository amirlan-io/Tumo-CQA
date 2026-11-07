import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.js';
import { createApp } from '../server/app.js';
import { defaultConfig } from '../server/checklists.js';
import { checkApproval, prepareCases, runModel, selectedModels } from '../scripts/ai-benchmark.js';
import { apiBase, checklistVersion, datasetRecords, safeError, protectInputs, writePrivateJson } from '../scripts/ai-common.js';

function syntheticBenchmark() {
  const version = { ...structuredClone(defaultConfig), rounding_digits: 2 };
  const records = [];
  const cases = [];
  for (const language of ['RU', 'KZ', 'EN']) for (let i = 0; i < 3; i++) {
    const conversation_id = `synthetic-${language}-${i}`;
    const channel = language === 'RU' && i === 0 ? 'voice call' : 'agent chat';
    records.push({ conversation_id, language, channel, audio_url: null,
      transcript: [
        { timestamp: '00:00', speaker: 'client', text: 'Вопрос клиента.' },
        { timestamp: '00:01', speaker: 'bot', text: 'Контекст.' },
        { timestamp: '00:02', speaker: 'system', text: 'Оператор подключён.' },
        { timestamp: '00:03', speaker: 'operator', text: 'Ответ оператора.' }
      ] });
    cases.push({ conversation_id, language, channel, results: version.criteria.map(c => ({
      criterion_id: c.criterion_id,
      answer: c.is_gross_error ? 'yes' : c.criterion_id === 'c2' ? 'na' : c.answer_type === 'scale' ? 'scale' : 'yes',
      raw_score: c.is_gross_error || c.criterion_id === 'c2' ? null : c.answer_type === 'scale' ? Math.max(...c.scale.map(s => s.value)) : 1,
      explanation: 'Синтетический пример для проверки расчёта метрик, не оценки качества модели.',
      evidence_message_nos: [4], checked_range: null,
      na_reason: c.criterion_id === 'c2' ? 'Данных было достаточно.' : null
    })) });
  }
  return { version, records, gold: { status: 'draft', approved_by: null, checklist_criteria: version.criteria, cases } };
}

test('benchmark refuses unapproved gold unless explicitly preliminary', () => {
  const { gold, records, version } = syntheticBenchmark();
  assert.throws(() => prepareCases(gold, records, version, false), /не утверждён/);
  assert.equal(prepareCases(gold, records, version, true).length, 9);
  gold.status = 'approved';
  assert.throws(() => checkApproval(gold, false), /approved_by/);
  gold.approved_by = 'Synthetic test reviewer';
  assert.equal(prepareCases(gold, records, version, false).length, 9);
});

test('gold must match the whole current rubric, sample balance and required edge cases', async t => {
  const changes = [
    ['changed text', f => { f.version.criteria[0].text = 'Заменённый критерий.'; }],
    ['changed weights', f => { f.version.criteria[0].weight++; f.version.criteria[1].weight--; }],
    ['changed scale description', f => { f.version.criteria[3].scale[0].description = 'Иная ступень.'; }],
    ['not enough cases', f => { f.gold.cases.pop(); }],
    ['repeated ID', f => { f.gold.cases[1] = f.gold.cases[0]; }],
    ['language imbalance', f => { f.gold.cases[6].language = 'RU'; f.records[6].language = 'RU'; }],
    ['no call', f => { f.gold.cases[0].channel = f.records[0].channel = 'agent chat'; }],
    ['no gross error', f => { for (const c of f.gold.cases) c.results.at(-1).answer = 'no'; }],
    ['no N/A', f => { for (const c of f.gold.cases) Object.assign(c.results[1], { answer: 'yes', raw_score: 1, na_reason: null }); }]
  ];
  for (const [label, change] of changes) await t.test(label, () => {
    const fixture = structuredClone(syntheticBenchmark());
    // Separate the snapshots: edits to current config must not edit reference labels.
    fixture.version = structuredClone(fixture.version);
    change(fixture);
    assert.throws(() => prepareCases(fixture.gold, fixture.records, fixture.version, true));
  });
});

test('benchmark distinguishes answer mismatches, JSON failures, transport failures and evidence review', async () => {
  const { gold, records, version } = syntheticBenchmark();
  const cases = prepareCases(gold, records, version, true);
  let factoryCalls = 0;
  const ai = { prompt_version: 'v1', createEvaluator(options) {
    factoryCalls++;
    assert.equal(options.model, 'synthetic/model');
    return async conversation => {
      const index = cases.findIndex(c => c.gold.conversation_id === conversation.conversation_id);
      if (index === 1) throw Object.assign(new Error('secret transport error'), { code: 'AI_TIMEOUT', status: 504 });
      if (index === 2) {
        for (const attempt of [1, 2]) options.onAttempt({ attempt, status: 'invalid', validation_errors: ['invalid JSON'] });
        throw Object.assign(new Error('secret JSON response'), { code: 'AI_INVALID_RESPONSE', status: 502 });
      }
      options.onAttempt({ attempt: 1, status: 'valid', validation_errors: [] });
      const results = structuredClone(cases[index].gold.results);
      if (index === 0) Object.assign(results[0], { answer: 'no', raw_score: 0, checked_range: { from: 1, to: 4 } });
      return { model: options.model, prompt_version: 'v1', results };
    };
  } };
  const report = await runModel({ model: 'synthetic/model', ai, settings: { timeoutMs: 1000 }, cases, version });
  assert.equal(factoryCalls, 1);
  assert.equal(report.status, 'failed');
  assert.equal(report.summary.completed, 7);
  assert.equal(report.summary.failed, 2);
  assert.equal(report.summary.matched_criteria, 55);
  assert.equal(report.summary.mismatched_criteria, 1);
  assert.equal(report.summary.json_error_attempts, 2);
  assert.equal(report.languages.RU.failed, 2);
  assert.equal(report.languages.KZ.matched_criteria, 24);
  assert.equal(report.languages.EN.matched_criteria, 24);
  assert.deepEqual(report.failures.map(e => e.kind), ['timeout']);
  assert.ok(report.errors.some(e => e.kind === 'invalid_output'));
  assert.ok(report.errors.some(e => e.kind === 'answer_score_mismatch'));
  assert.equal(report.needs_human_review[0].status, 'needs_human_review');
  assert.ok(!JSON.stringify(report).includes('secret'));
});

test('checklist CLI uses real GET endpoints and the explicitly selected immutable version', async t => {
  const store = createStore();
  const server = createApp(store).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.db.close(); });
  const base = apiBase(`http://127.0.0.1:${server.address().port}`);
  const original = store.list('checklist_version')[0];
  const changed = structuredClone(original);
  changed.criteria[0].criterion_id = 'replacement';
  changed.criteria[0].text = 'Оператор не просил пароль.';
  const response = await fetch(new URL(`api/checklists/${original.checklist_id}/versions`, base), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changed)
  });
  assert.equal(response.status, 201);
  const current = await response.json();
  assert.equal((await checklistVersion(base, current.id)).criteria[0].criterion_id, 'replacement');
  assert.equal((await checklistVersion(base, original.id)).criteria[0].criterion_id, 'c1');
  await assert.rejects(checklistVersion(base, 'v1'), /UUID/);
});

test('model selection is explicit; error reporting never exposes provider messages', () => {
  assert.deepEqual(selectedModels('synthetic/a,synthetic/b,synthetic/a', 'unused'), ['synthetic/a', 'synthetic/b']);
  assert.throws(() => selectedModels('', 'unused'));
  assert.deepEqual(safeError(Object.assign(new Error('private raw reply'), { code: 'AI_INVALID_RESPONSE', status: 502 })).kind, 'invalid_output');
  assert.ok(!safeError(new Error('private provider reply')).message.includes('private'));
  assert.throws(() => apiBase('https://example.invalid/?key=private'));
  assert.throws(() => datasetRecords({ isSuccess: false, data: { records: [1] } }));
  assert.deepEqual(datasetRecords({ isSuccess: true, data: { records: [1] } }), [1]);
});

test('private output cannot overwrite inputs or include an API key', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cqa-cli-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'result.json');
  assert.throws(() => protectInputs(output, [output]));
  await assert.rejects(writePrivateJson(output, { explanation: 'synthetic credential' }, 'synthetic credential'));
  await writePrivateJson(output, { status: 'synthetic' }, 'synthetic credential');
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), { status: 'synthetic' });
  if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
});
