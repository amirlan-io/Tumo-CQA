import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultConfig } from '../server/checklists.js';
import { prepareInput } from '../server/services/ai-contract.js';
import { sha256 } from '../scripts/ai-common.js';
import { evaluateResearch } from '../scripts/hypothesis-client.js';
import { buildPlan, guardRunDir, main, requestForTask, runStudy } from '../scripts/hypothesis-study.js';

// Invented records, credentials and transport only. Never load .env, DEV, gold or H5 reviews.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts/hypothesis-study.js');
const BASE = await readFile(new URL('../server/prompts/evaluate-v2.txt', import.meta.url), 'utf8');
const KEY = 'synthetic-study-credential-not-a-real-key';
const CONTEXT = 'PRIVATE_SYNTHETIC_DEV_TRANSCRIPT';
const IDS = ['p1-ru-014', 'p1-kz-008', 'p1-en-013', 'p1-en-015', 'p1-kz-003', 'p1-en-014', 'p4-ru-001', 'p1-ru-001'];
const ALL = Array.from({ length: 8 }, (_, i) => `c${i + 1}`);
const CONFIG = { baseUrl: 'https://openrouter.ai/api/v1', model: 'synthetic/study-model', timeoutMs: 3000,
  requestTimeoutMs: 1000, maxTokens: 777, structuredOutput: 'json_schema', provider: '', reasoningEffort: '' };
const ORIGINAL = 'Порог первой реакции 3 минуты, теги и вложения не оцениваются.';
const CLARIFIED = 'Порог первой реакции (включая SLA 3 минуты), теги и вложения исключены из оценки. Не снижайте оценку за эти параметры.';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const exec = promisify(execFile);
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

function fixture(overrides = {}) {
  const records = IDS.map(id => ({ conversation_id: id, language: id.includes('-kz-') ? 'KZ' : id.includes('-en-') ? 'EN' : 'RU',
    channel: id.startsWith('p4-') ? 'voice call' : 'agent chat', audio_url: 'https://audio.example.invalid/?signed=DO_NOT_SEND',
    expected_oracle: { DO_NOT_SEND: true }, priors: 'DO_NOT_SEND', reference_material: 'DO_NOT_SEND',
    transcript: [{ timestamp: '00:00', speaker: 'client', text: `${CONTEXT}: синтетический вопрос.` },
      { timestamp: '00:10', speaker: 'operator', text: `${CONTEXT}: синтетический ответ.` }] }));
  const version = { ...structuredClone(defaultConfig), id: 'synthetic-source-version', version: 17, checklist_id: 'source-checklist' };
  const config = { ...CONFIG, ...overrides.config };
  const plan = buildPlan({ records, version, basePrompt: BASE, ...overrides, config });
  return { records, version, config, plan };
}

async function setup(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cqa-study-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { ...fixture(overrides), directory, runDir: join(directory, 'private-run') };
}

function request(ctx, task) { return requestForTask({ ...ctx, task }); }
function modelInput(args) {
  const input = prepareInput(args.conversation, args.version);
  input.checklist_version.criteria = input.checklist_version.criteria.filter(c => args.criterionIds.includes(c.criterion_id));
  if (Object.hasOwn(args, 'referenceMaterial')) input.reference_material = args.referenceMaterial;
  return input;
}
function resultSet(input) {
  return input.checklist_version.criteria.map(c => ({ criterion_id: c.criterion_id,
    answer: c.is_gross_error ? 'no' : c.answer_type === 'scale' ? 'scale' : 'yes',
    raw_score: c.is_gross_error ? null : c.answer_type === 'scale' ? Math.max(...c.scale.map(s => s.value)) : 1,
    explanation: 'Синтетический ответ без обязательного префикса.', evidence_message_nos: [2],
    checked_range: c.is_gross_error ? { from: 1, to: 2 } : null, na_reason: null }));
}
function fakeResult(args, status = 'ok') {
  const input = modelInput(args);
  const result = { status, request_sha256: hash(JSON.stringify({ prompt: args.prompt, input })), attempts: [],
    diagnostic_paths: [], usage: [], resolved_models: [CONFIG.model], providers: [], research: null, latency_ms: 0 };
  if (status === 'ok') result.output = { model: CONFIG.model, prompt_version: args.promptVersion, results: resultSet(input) };
  else result.error = { kind: 'network', code: 'AI_UNAVAILABLE', message: 'Синтетическая сетевая ошибка.' };
  return result;
}
const fakeEvaluate = async args => fakeResult(args);
const run = (ctx, overrides = {}) => runStudy({ ...ctx, evaluate: fakeEvaluate, delayMs: 0, ...overrides });
const artifact = (ctx, name) => join(ctx.runDir, name);
const journal = ctx => readJson(artifact(ctx, 'study-results.json'));
const errorKind = kind => error => { assert.equal(error.kind, kind); assert.ok(!error.message.includes(KEY)); return true; };

async function privateArtifacts(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await privateArtifacts(path));
    else {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.ok(!path.endsWith('.tmp'));
      const raw = await readFile(path, 'utf8');
      assert.ok(!raw.includes(KEY), 'Credentials must not reach any artifact');
      paths.push({ path, raw });
    }
  }
  return paths;
}

test('pure deterministic frozen plan predeclares exactly 40 tasks, six hypotheses and fixed counterbalancing', () => {
  const ctx = fixture(), before = structuredClone({ records: ctx.records, version: ctx.version, config: ctx.config });
  const again = buildPlan({ ...ctx, basePrompt: BASE, config: { ...ctx.config, apiKey: KEY, fetchImpl: () => { throw new Error(); } } });
  assert.deepEqual(again, ctx.plan);
  assert.deepEqual({ records: ctx.records, version: ctx.version, config: ctx.config }, before);
  const { plan } = ctx;
  assert.equal(plan.schema_version, 'hypotheses-plan-1');
  assert.equal(plan.tasks.length, 40);
  assert.equal(new Set(plan.tasks.map(t => t.id)).size, 40);
  assert.deepEqual(plan.run_order, ['H1', 'H2', 'H3', 'H4', 'H6']);
  assert.deepEqual(plan.hypotheses.map(h => [h.id, h.task_count]), [['H1', 8], ['H2', 8], ['H3', 12], ['H4', 6], ['H5', 0], ['H6', 6]]);
  assert.deepEqual(plan.tasks.map(t => t.hypothesis), [...Array(8).fill('H1'), ...Array(8).fill('H2'),
    ...Array(12).fill('H3'), ...Array(6).fill('H4'), ...Array(6).fill('H6')]);
  for (const h of ['H1', 'H2']) {
    const tasks = plan.tasks.filter(t => t.hypothesis === h);
    assert.deepEqual(tasks.map(t => t.conversation_id), (h === 'H1' ? IDS.slice(0, 4)
      : ['p1-kz-003', 'p1-en-014', 'p1-kz-008', 'p4-ru-001']).flatMap(id => [id, id]));
    assert.deepEqual(tasks.map(t => t.condition), ['control', h === 'H1' ? 'clarified' : 'proof',
      h === 'H1' ? 'clarified' : 'proof', 'control', 'control', h === 'H1' ? 'clarified' : 'proof',
      h === 'H1' ? 'clarified' : 'proof', 'control']);
  }
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.tasks) && Object.isFrozen(plan.prompt_texts.v2));
  assert.throws(() => { plan.tasks[0].criterion_ids.push('c9'); }, TypeError);
  assert.equal(plan.source_originalDEV_sha256, sha256(ctx.records));
  assert.equal(plan.hashes.dataset_sha256, sha256(ctx.records));
  assert.equal(plan.hashes.version_sha256, sha256(ctx.version));
  assert.equal(plan.hashes.prompt_sha256, hash(BASE));
  assert.equal(plan.hashes.config_sha256, sha256(plan.resolved_config));
  assert.deepEqual(plan.source_version, { id: ctx.version.id, version: 17, name: ctx.version.name });
  assert.ok(!JSON.stringify(plan).includes(KEY));
  assert.ok(!Object.hasOwn(plan.resolved_config, 'apiKey') && !Object.hasOwn(plan.resolved_config, 'fetchImpl'));
  for (const prompt of Object.values(plan.prompt_texts)) assert.equal(prompt.sha256, hash(prompt.text));
});

test('H1 changes only the specified c6 clause; both arms blind version identity, preserving name and all eight rules', () => {
  const ctx = fixture(), before = structuredClone(ctx.version);
  for (const id of IDS.slice(0, 4)) {
    const tasks = ctx.plan.tasks.filter(t => t.hypothesis === 'H1' && t.conversation_id === id);
    const control = request(ctx, tasks.find(t => t.condition === 'control'));
    const clarified = request(ctx, tasks.find(t => t.condition === 'clarified'));
    assert.equal(control.version.id, null);
    assert.equal(control.version.version, null);
    assert.equal(clarified.version.id, null);
    assert.equal(clarified.version.version, null);
    assert.equal(control.version.name, ctx.version.name);
    assert.equal(clarified.version.name, ctx.version.name);
    assert.equal(control.prompt, BASE);
    assert.equal(control.promptVersion, 'v2');
    assert.equal(control.version.criteria[5].text, before.criteria[5].text);
    assert.equal(clarified.version.criteria[5].text, before.criteria[5].text.replace(ORIGINAL, CLARIFIED));
    clarified.version.criteria[5].text = control.version.criteria[5].text;
    assert.deepEqual(control, clarified);
    assert.deepEqual(control.criterionIds, ALL);
  }
  assert.deepEqual(ctx.version, before, 'Never overwrite the source API snapshot');
  assert.deepEqual(ctx.plan.transformations.H1, { criterion_id: 'c6', from: ORIGINAL, to: CLARIFIED, replacements: 1,
    both_arms_version_identity: { id: null, version: null }, preserve_name: true });
});

test('H2 preserves exact v2 control and original rubric, adding only one common proof addendum and first marker', () => {
  const ctx = fixture();
  for (const id of ['p1-kz-003', 'p1-en-014', 'p1-kz-008', 'p4-ru-001']) {
    const tasks = ctx.plan.tasks.filter(t => t.hypothesis === 'H2' && t.conversation_id === id);
    const control = request(ctx, tasks.find(t => t.condition === 'control'));
    const proof = request(ctx, tasks.find(t => t.condition === 'proof'));
    assert.equal(control.prompt, BASE);
    assert.equal(proof.promptVersion, 'h2-proof-v1');
    assert.equal(proof.prompt, BASE.replace('Версия промпта: v2.', 'Версия промпта: h2-proof-v1.')
      + `\n${ctx.plan.transformations.H2.addendum}\n`);
    assert.match(proof.prompt, /Факт \[N\]:/u);
    assert.match(proof.prompt, /Проверка \[from-to\]: действие не найдено/u);
    assert.match(proof.prompt, /максимум два коротких предложения/u);
    const { prompt, promptVersion, ...unchanged } = proof;
    assert.deepEqual(unchanged, (({ prompt, promptVersion, ...rest }) => rest)(control));
    assert.equal(control.version.id, ctx.version.id);
    assert.equal(control.version.version, 17);
  }
  assert.equal(ctx.plan.hypotheses.find(h => h.id === 'H2').explanation_prefix_is_metric_only, true);
});

test('H3 uses three genuine one-criterion tasks, with only count phrases and marker changed in the unit prompt', () => {
  const ctx = fixture();
  let expected = BASE.replace('Версия промпта: v2.', 'Версия промпта: h3-unit-v1.');
  for (const [from, to] of ctx.plan.transformations.H3.count_replacements) expected = expected.replace(from, to);
  assert.equal(ctx.plan.prompt_texts['h3-unit-v1'].text, expected);
  assert.doesNotMatch(expected, /восьм/iu);
  for (const id of ['p1-ru-001', 'p1-kz-008', 'p1-en-015']) {
    const tasks = ctx.plan.tasks.filter(t => t.hypothesis === 'H3' && t.conversation_id === id);
    assert.equal(tasks.length, 4);
    assert.deepEqual(tasks.map(t => t.criterion_ids), [ALL, ['c2'], ['c6'], ['c7']]);
    assert.equal(tasks[0].condition, 'control');
    for (const task of tasks) {
      const args = request(ctx, task), input = modelInput(args);
      assert.equal(input.checklist_version.criteria.length, task.criterion_ids.length);
      assert.equal(args.version.criteria.length, 8, 'The native client validates the full rubric before subsetting');
      assert.equal(args.promptVersion, task.condition === 'control' ? 'v2' : 'h3-unit-v1');
      assert.ok(!JSON.stringify(args).includes('expected_oracle'));
      assert.ok(!JSON.stringify(args).includes('DO_NOT_SEND'));
    }
  }
});

test('H4 tasks reuse stable H3 baseline IDs and have identical client arguments, without labels, nonces or altered promptVersion', () => {
  const ctx = fixture();
  for (const task of ctx.plan.tasks.filter(t => t.hypothesis === 'H4')) {
    assert.deepEqual(task.depends_on, [`H3:${task.conversation_id}:control`]);
    const baseline = ctx.plan.tasks.find(t => t.id === task.depends_on[0]);
    assert.deepEqual(request(ctx, task), request(ctx, baseline));
    assert.equal(request(ctx, task).promptVersion, 'v2');
    assert.deepEqual(Object.keys(request(ctx, task)).sort(), ['conversation', 'criterionIds', 'prompt', 'promptVersion', 'version']);
  }
  assert.equal(ctx.plan.hypotheses.find(h => h.id === 'H4').replicate_1_task_ids.length, 3);
  assert.match(ctx.plan.hypotheses.find(h => h.id === 'H4').metric, /текста output/u);
});

test('H5 has purpose and zero tasks; H6 has only two clearly synthetic cases and numeric-only reference contrasts', () => {
  const ctx = fixture(), { plan } = ctx;
  assert.equal(plan.tasks.filter(t => t.hypothesis === 'H5').length, 0);
  assert.equal(plan.hypotheses.find(h => h.id === 'H5').task_count, 0);
  assert.deepEqual(Object.keys(plan.synthetic_conversations), ['research-kb-ru', 'research-kb-en']);
  assert.match(plan.synthetic_conversations['research-kb-ru'].transcript[1].text, /Учебный Демо-Дельта/u);
  assert.match(plan.synthetic_conversations['research-kb-en'].transcript[1].text, /Training Demo-Rho/u);
  assert.equal(plan.synthetic_conversations['research-kb-ru'].transcript[0].text, 'Сколько условных единиц стоит учебная операция?');
  for (const [id, field, supports, contradicts] of [['research-kb-ru', 'fee_units', 5, 7], ['research-kb-en', 'processing_days', 2, 5]]) {
    const conversation = plan.synthetic_conversations[id];
    assert.ok(!IDS.includes(id) && !/^p\d-/u.test(id));
    assert.equal(conversation.transcript.length, 2);
    assert.deepEqual(conversation.transcript.map(m => [m.timestamp, m.speaker]), [['00:00', 'client'], ['00:10', 'operator']]);
    const tasks = plan.tasks.filter(t => t.hypothesis === 'H6' && t.conversation_id === id);
    assert.deepEqual(tasks.map(t => t.condition), ['absent', 'supports', 'contradicts']);
    assert.equal(tasks[0].reference_material, null);
    assert.deepEqual(tasks[1].reference_material.facts, { [field]: supports });
    assert.deepEqual(tasks[2].reference_material.facts, { [field]: contradicts });
    const changed = structuredClone(tasks[2].reference_material);
    changed.facts[field] = supports;
    assert.deepEqual(tasks[1].reference_material, changed);
    assert.ok(!/supports|contradicts|condition|score|oracle/u.test(JSON.stringify(changed)));
    for (const task of tasks) {
      const args = request(ctx, task);
      assert.equal(args.promptVersion, 'h6-reference-v1');
      assert.equal(args.prompt, BASE.replace('Версия промпта: v2.', 'Версия промпта: h6-reference-v1.')
        + `\n${plan.transformations.H6.addendum}\n`);
      assert.deepEqual(args.version, prepareInput(ctx.records[0], ctx.version).checklist_version);
      assert.deepEqual(args.criterionIds, ALL);
      assert.deepEqual(args.referenceMaterial, task.reference_material);
      assert.ok(!JSON.stringify(args).includes('expected_oracle'));
    }
  }
  assert.deepEqual(plan.metrics_for_parent_only.H6.expected_oracle, { supports: 20, contradicts: 0, absent: null });
  assert.match(plan.transformations.H6.addendum, /не вводит новых правил N\/A/u);
  assert.equal(ctx.records.length, IDS.length, 'Never append synthetic cases to DEV');
  assert.deepEqual(plan.tasks.filter(t => t.hypothesis === 'H6' && t.reference_material).map(t => [t.reference_material.source, t.reference_material.title]),
    Array(4).fill([plan.tasks[35].reference_material.source, plan.tasks[35].reference_material.title]));
});

test('buildPlan rejects missing/duplicate real IDs, wrong rubric, non-unique clause and leftover eight-count instructions', () => {
  const ctx = fixture(), args = { ...ctx, basePrompt: BASE };
  assert.throws(() => buildPlan({ ...args, records: ctx.records.slice(1) }));
  assert.throws(() => buildPlan({ ...args, records: [...ctx.records, ctx.records[0]] }));
  for (const clause of ['Иной текст.', `${ORIGINAL} ${ORIGINAL}`]) {
    const version = structuredClone(ctx.version);
    version.criteria[5].text = clause;
    assert.throws(() => buildPlan({ ...args, version }));
  }
  assert.throws(() => buildPlan({ ...args, version: { ...ctx.version, criteria: ctx.version.criteria.slice(1) } }));
  assert.throws(() => buildPlan({ ...args, basePrompt: `${BASE}\nЕщё восемь результатов.` }));
  assert.throws(() => buildPlan({ ...args, basePrompt: BASE.replace('Версия промпта: v2.', 'Версия промпта: v1.') }));
  assert.throws(() => buildPlan({ ...args, records: [...ctx.records, { conversation_id: 'research-kb-ru' }] }));
});

test('native mocked client runs all 40 sequentially: 31 full and 9 unit bodies, private raw diagnostics, identical H3/H4 hashes', async t => {
  const ctx = await setup(t), requests = [], progress = [];
  let active = 0, maxActive = 0, calls = 0;
  const config = { ...ctx.config, apiKey: KEY, diagnosticDir: join(ctx.directory, 'MUST_NOT_WRITE'),
    fetchImpl: async (url, init) => {
      assert.ok(requests.length < 40, 'No real fetch or unexpected repair');
      assert.equal(String(url), 'https://openrouter.ai/api/v1/chat/completions');
      assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
      assert.equal(init.redirect, 'error');
      const body = JSON.parse(init.body), input = JSON.parse(body.messages[1].content);
      assert.equal(body.model, CONFIG.model);
      assert.equal(body.temperature, 0);
      assert.equal(body.max_tokens, 777);
      assert.deepEqual(body.provider, { require_parameters: true, allow_fallbacks: false });
      assert.equal(body.messages.length, 2);
      assert.ok(!init.body.includes('DO_NOT_SEND') && !init.body.includes('expected_oracle') && !init.body.includes(KEY));
      requests.push({ raw: init.body, body, input });
      return new Response(JSON.stringify({ model: 'synthetic/resolved', provider: 'Synthetic Provider',
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 },
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results: resultSet(input) }) } }] }), { status: 200 });
    } };
  const evaluate = async args => {
    const saved = await journal(ctx);
    assert.equal(saved.entries.length, calls, 'Checkpoint must precede the next request');
    assert.equal((await readJson(artifact(ctx, 'plan.json'))).plan_sha256, ctx.plan.plan_sha256);
    assert.equal(args.config.diagnosticDir, artifact(ctx, 'diagnostics'));
    assert.ok(!JSON.stringify({ ...args, config: undefined }).includes('DO_NOT_SEND'));
    calls++;
    active++;
    maxActive = Math.max(maxActive, active);
    try { return await evaluateResearch(args); } finally { active--; }
  };
  const report = await run(ctx, { evaluate, config, onProgress: event => progress.push(event) });
  assert.equal(maxActive, 1);
  assert.equal(requests.length, 40);
  assert.deepEqual(report.summary, { total: 40, completed: 40, ok: 40, error: 0, pending: 0 });
  assert.equal(report.status, 'completed');
  assert.equal(report.plan_sha256, ctx.plan.plan_sha256);
  assert.equal(report.entries.filter(e => e.result.output.results.length === 1).length, 9);
  assert.equal(report.entries.filter(e => e.result.output.results.length === 8).length, 31);
  for (const [index, entry] of report.entries.entries()) {
    const { input, body, raw } = requests[index], task = ctx.plan.tasks[index];
    assert.equal(entry.task_id, task.id);
    assert.equal(entry.result.status, 'ok');
    assert.equal(entry.result.request_sha256, hash(raw));
    assert.deepEqual(entry.result.usage, [{ prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 }]);
    assert.deepEqual(entry.result.resolved_models, ['synthetic/resolved']);
    assert.deepEqual(entry.result.providers, ['Synthetic Provider']);
    assert.equal(input.checklist_version.criteria.length, task.criterion_ids.length);
    assert.equal(body.response_format.json_schema.schema.properties.results.minItems, task.criterion_ids.length);
    assert.equal(body.response_format.json_schema.schema.properties.results.maxItems, task.criterion_ids.length);
    assert.deepEqual(body.response_format.json_schema.schema.properties.results.items.properties.criterion_id.enum, task.criterion_ids);
    assert.ok(entry.started_at && entry.finished_at);
    assert.equal(entry.result.diagnostic_paths.length, 1);
    assert.ok(entry.result.diagnostic_paths[0].startsWith(artifact(ctx, 'diagnostics')));
    const diagnostic = await readJson(entry.result.diagnostic_paths[0]);
    assert.equal(diagnostic.status, 'valid');
    assert.ok(diagnostic.raw_response);
    if (task.hypothesis === 'H4') {
      assert.equal(entry.request_hash_matches_baseline, true);
      const baselineIndex = report.entries.findIndex(e => e.task_id === task.depends_on[0]);
      assert.equal(entry.result.request_sha256, report.entries[baselineIndex].result.request_sha256);
      assert.equal(raw, requests[baselineIndex].raw);
    }
  }
  assert.equal((await stat(ctx.runDir)).mode & 0o777, 0o700);
  assert.equal((await stat(artifact(ctx, 'diagnostics'))).mode & 0o777, 0o700);
  const artifacts = await privateArtifacts(ctx.runDir);
  assert.equal(artifacts.length, 42);
  assert.ok(artifacts.every(file => !file.raw.includes('DO_NOT_SEND')));
  assert.ok(!artifacts.find(file => file.path.endsWith('plan.json')).raw.includes(CONTEXT));
  assert.deepEqual(await readdir(ctx.directory), ['private-run']);
  assert.ok(!JSON.stringify(progress).includes(CONTEXT) && !JSON.stringify(progress).includes(KEY));
  assert.equal(progress.filter(e => e.status === 'attempt').length, 40);
  assert.ok(!JSON.stringify(report.resolved_config).includes(KEY));
  assert.ok(!Object.hasOwn(report.resolved_config, 'apiKey') && !Object.hasOwn(report.resolved_config, 'fetchImpl'));
  assert.equal(report.resolved_config.diagnosticDir, artifact(ctx, 'diagnostics'));
});

test('partial limit leaves pending, checkpoints every terminal error, resumes without repeating successes or failures', async t => {
  const ctx = await setup(t), seen = [];
  const evaluate = async args => {
    assert.equal((await journal(ctx)).entries.length, seen.length);
    seen.push(modelInput(args));
    return fakeResult(args, seen.length === 2 ? 'error' : 'ok');
  };
  const first = await run(ctx, { evaluate, maxNew: 2, selectedHypotheses: 'H1' });
  assert.deepEqual(first.summary, { total: 40, completed: 2, ok: 1, error: 1, pending: 38 });
  assert.equal(first.status, 'partial');
  const originalEntries = structuredClone(first.entries), planBytes = await readFile(artifact(ctx, 'plan.json'));
  const originalPlanStat = await stat(artifact(ctx, 'plan.json'));
  const second = await run(ctx, { evaluate, maxNew: 1, selectedHypotheses: 'H1' });
  assert.equal(seen.length, 3);
  assert.equal(second.entries[2].task_id, ctx.plan.tasks[2].id);
  assert.deepEqual(second.entries.slice(0, 2), originalEntries);
  await run(ctx, { evaluate, selectedHypotheses: 'H1' });
  const finished = await run(ctx, { evaluate, selectedHypotheses: 'H1' });
  assert.equal(seen.length, 8, 'No automatic transport retry, failed-task retry or best-of');
  assert.deepEqual(finished.summary, { total: 40, completed: 8, ok: 7, error: 1, pending: 32 });
  assert.deepEqual(await readFile(artifact(ctx, 'plan.json')), planBytes);
  assert.equal((await stat(artifact(ctx, 'plan.json'))).ino, originalPlanStat.ino);
  assert.equal((await stat(artifact(ctx, 'plan.json'))).mtimeMs, originalPlanStat.mtimeMs);
  assert.ok(!(await readdir(ctx.runDir)).includes('.lock'));
});

test('maxNew=0 persists a key-free plan and pending journal without needing an API key or any evaluator', async t => {
  const ctx = await setup(t);
  const report = await runStudy({ ...ctx, maxNew: 0, config: ctx.config });
  assert.deepEqual(report.summary, { total: 40, completed: 0, ok: 0, error: 0, pending: 40 });
  assert.deepEqual((await readJson(artifact(ctx, 'plan.json'))), ctx.plan);
  assert.equal(report.status, 'partial');
  await privateArtifacts(ctx.runDir);
});

test('H5 parent-owned invalid JSON files are neither read nor overwritten, including on resume', async t => {
  const ctx = await setup(t);
  await mkdir(ctx.runDir, { mode: 0o700 });
  const names = ['h5-blind-request.json', 'h5-selection-key.json', 'h5-independent-review.json'];
  for (const name of names) await writeFile(artifact(ctx, name), `PARENT_ONLY_NOT_JSON:${name}`, { mode: 0o600 });
  const before = await Promise.all(names.map(name => stat(artifact(ctx, name))));
  await run(ctx, { maxNew: 1, selectedHypotheses: 'H6' });
  await run(ctx, { maxNew: 1, selectedHypotheses: 'H6' });
  for (const [i, name] of names.entries()) {
    assert.equal(await readFile(artifact(ctx, name), 'utf8'), `PARENT_ONLY_NOT_JSON:${name}`);
    assert.equal((await stat(artifact(ctx, name))).ino, before[i].ino);
    assert.equal((await stat(artifact(ctx, name))).mtimeMs, before[i].mtimeMs);
  }
});

test('one-process lock rejects concurrent runners and existing stale locks without automatic stealing', async t => {
  const ctx = await setup(t);
  let started, finish;
  const began = new Promise(resolve => { started = resolve; });
  const deferred = new Promise(resolve => { finish = resolve; });
  const running = run(ctx, { maxNew: 1, evaluate: async args => { started(); await deferred; return fakeResult(args); } });
  await began;
  try {
    assert.equal((await stat(artifact(ctx, '.lock'))).mode & 0o777, 0o600);
    const held = await readFile(artifact(ctx, '.lock'), 'utf8');
    assert.equal(JSON.parse(held).pid, process.pid);
    await assert.rejects(run(ctx), errorKind('locked'));
    assert.equal(await readFile(artifact(ctx, '.lock'), 'utf8'), held);
  } finally { finish(); }
  await running;
  await writeFile(artifact(ctx, '.lock'), 'stale-parent-lock', { mode: 0o600 });
  await assert.rejects(run(ctx), errorKind('locked'));
  assert.equal(await readFile(artifact(ctx, '.lock'), 'utf8'), 'stale-parent-lock');
});

test('all input/config/plan fingerprints are checked before API, and a different immutable plan is never overwritten', async t => {
  const ctx = await setup(t);
  await run(ctx, { maxNew: 0 });
  const bytes = await readFile(artifact(ctx, 'plan.json')), journalBytes = await readFile(artifact(ctx, 'study-results.json'));
  let calls = 0;
  const evaluate = async args => { calls++; return fakeResult(args); };
  const changedRecords = structuredClone(ctx.records);
  changedRecords[0].transcript[0].text += ' изменён';
  const changedVersion = structuredClone(ctx.version);
  changedVersion.criteria[0].weight++;
  changedVersion.criteria[1].weight--;
  const changedPlan = structuredClone(ctx.plan);
  changedPlan.tasks.reverse();
  for (const override of [{ records: changedRecords }, { version: changedVersion }, { plan: changedPlan },
    { config: { ...ctx.config, model: 'different/model' } }, { config: { ...ctx.config, maxTokens: 800 } }])
    await assert.rejects(run(ctx, { ...override, evaluate }), errorKind('contract_changed'));
  const other = fixture({ config: { model: 'other/model' } });
  await assert.rejects(run(ctx, { plan: other.plan, config: other.config, evaluate }), errorKind('contract_changed'));
  assert.equal(calls, 0);
  assert.deepEqual(await readFile(artifact(ctx, 'plan.json')), bytes);
  assert.deepEqual(await readFile(artifact(ctx, 'study-results.json')), journalBytes);
});

test('raw ORIGINAL DEV bytes and version snapshot fingerprints reject changes before API, including between checkpoints', async t => {
  const ctx = await setup(t);
  const datasetPath = join(ctx.directory, 'original-dev.json'), versionPath = join(ctx.directory, 'version.json');
  const datasetBytes = JSON.stringify({ records: ctx.records }), versionBytes = JSON.stringify(ctx.version);
  await writeFile(datasetPath, datasetBytes);
  await writeFile(versionPath, versionBytes);
  const sourceHashes = { dataset: { path: datasetPath, sha256: hash(datasetBytes) }, version: { path: versionPath, sha256: hash(versionBytes) } };
  ctx.plan = buildPlan({ ...ctx, basePrompt: BASE, sourceHashes });
  assert.equal(ctx.plan.source_originalDEV_sha256, hash(datasetBytes));
  assert.notEqual(ctx.plan.source_originalDEV_sha256, sha256(ctx.records), 'Raw source bytes, not transformed DEV');
  await writeFile(datasetPath, `${datasetBytes}\n`);
  let calls = 0;
  const evaluate = async args => { calls++; return fakeResult(args); };
  await assert.rejects(run(ctx, { evaluate }), errorKind('contract_changed'));
  assert.equal(calls, 0);
  await writeFile(datasetPath, datasetBytes);
  await writeFile(versionPath, `${versionBytes}\n`);
  await assert.rejects(run(ctx, { evaluate }), errorKind('contract_changed'));
  assert.equal(calls, 0);
  await writeFile(versionPath, versionBytes);
  await assert.rejects(run(ctx, { maxNew: 2, evaluate: async args => {
    calls++;
    await writeFile(datasetPath, `${datasetBytes}\n`);
    return fakeResult(args);
  } }), errorKind('contract_changed'));
  assert.equal(calls, 1);
  assert.equal((await journal(ctx)).entries.length, 1);
  await assert.rejects(run(ctx, { evaluate }), errorKind('contract_changed'));
  assert.equal(calls, 1);
});

test('source/helper/study and prompt hashes are verified; no tests/docs/.env paths enter runtime snapshots', async t => {
  const ctx = await setup(t);
  for (const path of ['scripts/hypothesis-study.js', 'scripts/hypothesis-client.js', 'scripts/ai-common.js', 'server/prompts/evaluate-v2.txt']) {
    const raw = await readFile(join(ROOT, path));
    const files = { [path]: hash(raw) };
    const plan = buildPlan({ ...ctx, basePrompt: BASE, sourceHashes: { files } });
    await run(ctx, { plan, runDir: join(ctx.directory, `valid-${path.replaceAll('/', '-')}`), maxNew: 0 });
    const changed = buildPlan({ ...ctx, basePrompt: BASE, sourceHashes: { files: { [path]: '0'.repeat(64) } } });
    await assert.rejects(run(ctx, { plan: changed, runDir: join(ctx.directory, 'bad'), evaluate: () => assert.fail('API must not run') }), errorKind('contract_changed'));
  }
  for (const path of ['tests/hypothesis-study.test.js', 'docs/ai.md', '.env']) {
    const plan = buildPlan({ ...ctx, basePrompt: BASE, sourceHashes: { files: { [path]: '0'.repeat(64) } } });
    await assert.rejects(run(ctx, { plan, runDir: join(ctx.directory, 'disallowed'), maxNew: 0 }), errorKind('contract_changed'));
  }
});

test('H4 alone requires all three successful baselines before any API; H3/H4 then yield three outputs per case', async t => {
  const ctx = await setup(t), seen = [];
  const evaluate = async args => { seen.push(args); return fakeResult(args); };
  await assert.rejects(run(ctx, { evaluate, selectedHypotheses: 'H4' }), errorKind('missing_dependency'));
  assert.equal(seen.length, 0);
  await run(ctx, { evaluate, selectedHypotheses: 'H3', maxNew: 1 });
  await assert.rejects(run(ctx, { evaluate, selectedHypotheses: 'H4' }), errorKind('missing_dependency'));
  assert.equal(seen.length, 1, 'Do not partially run H4 even when the first baseline exists');
  await run(ctx, { evaluate, selectedHypotheses: 'H3' });
  const report = await run(ctx, { evaluate, selectedHypotheses: 'H4' });
  assert.equal(seen.length, 18);
  for (const id of ['p1-ru-001', 'p1-kz-008', 'p1-en-015']) {
    const replicas = report.entries.filter(e => e.conversation_id === id && (e.hypothesis === 'H4' || e.task_id === `H3:${id}:control`));
    assert.equal(replicas.length, 3);
    assert.ok(replicas.every(e => e.result.output.results.length === 8));
    assert.equal(new Set(replicas.map(e => e.result.request_sha256)).size, 1);
  }
});

test('failed H3 baseline remains terminal, blocking H4; all-selection order never bypasses dependencies', async t => {
  const ctx = await setup(t), seen = [];
  const evaluate = async args => {
    seen.push(args);
    return fakeResult(args, args.conversation.conversation_id === 'p1-ru-001' && args.criterionIds.length === 8 ? 'error' : 'ok');
  };
  await assert.rejects(run(ctx, { evaluate }), errorKind('missing_dependency'));
  assert.equal(seen.length, 28, 'H1 + H2 + H3 only, no H4 or H6 calls');
  assert.equal((await journal(ctx)).summary.error, 1);
  await assert.rejects(run(ctx, { evaluate, selectedHypotheses: 'H4' }), errorKind('missing_dependency'));
  assert.equal(seen.length, 28);
});

test('H4 hash mismatch is checkpointed without changing the client return, stops execution and cannot be resumed past', async t => {
  const ctx = await setup(t);
  await run(ctx, { selectedHypotheses: 'H3' });
  let calls = 0;
  const evaluate = async args => { calls++; return { ...fakeResult(args), request_sha256: 'f'.repeat(64) }; };
  await assert.rejects(run(ctx, { evaluate, selectedHypotheses: 'H4' }), errorKind('contract_changed'));
  const saved = await journal(ctx), entry = saved.entries.at(-1);
  assert.equal(saved.entries.length, 13);
  assert.equal(entry.result.status, 'ok');
  assert.equal(entry.result.request_sha256, 'f'.repeat(64));
  assert.equal(entry.request_hash_matches_baseline, false);
  await assert.rejects(run(ctx, { evaluate, selectedHypotheses: 'H4' }), errorKind('contract_changed'));
  assert.equal(calls, 1);
});

test('journal header, duplicate entries, insecure mode and symlink artifacts fail closed', async t => {
  const ctx = await setup(t);
  await run(ctx, { maxNew: 1 });
  const original = await journal(ctx);
  for (const invalid of [{ ...original, plan_sha256: '0'.repeat(64) }, { ...original, source_originalDEV_sha256: '0'.repeat(64) },
    { ...original, entries: [null] }, { ...original, entries: [...original.entries, original.entries[0]] },
    { ...original, entries: [{ ...original.entries[0], result: { status: 'pending' } }] }]) {
    await writeFile(artifact(ctx, 'study-results.json'), JSON.stringify(invalid), { mode: 0o600 });
    await assert.rejects(run(ctx), errorKind('contract_changed'));
  }
  const external = join(ctx.directory, 'protected.json');
  await writeFile(external, 'PROTECTED');
  await rm(artifact(ctx, 'study-results.json'));
  await symlink(external, artifact(ctx, 'study-results.json'));
  await assert.rejects(run(ctx), errorKind('filesystem'));
  assert.equal(await readFile(external, 'utf8'), 'PROTECTED');
  await rm(artifact(ctx, 'study-results.json'));
  await writeFile(artifact(ctx, 'study-results.json'), JSON.stringify(original), { mode: 0o644 });
  await assert.rejects(run(ctx), errorKind('filesystem'));
});

test('private API tempdirs are allowed but CLI refuses public results, protected paths, data root and symlink escapes', async t => {
  const ctx = await setup(t);
  assert.equal(await guardRunDir(ctx.runDir), ctx.runDir);
  assert.equal(await guardRunDir(join(ROOT, 'data/ai-results/not-created-hypothesis-test'), true), join(ROOT, 'data/ai-results/not-created-hypothesis-test'));
  for (const path of [ctx.runDir, ROOT, join(ROOT, 'data'), join(ROOT, 'results'), join(ROOT, 'results/dev'), join(ROOT, 'server'), join(ROOT, 'data/../results')])
    await assert.rejects(guardRunDir(path, true), errorKind('configuration'));
  for (const path of [ROOT, join(ROOT, 'results/dev'), join(ROOT, 'server'), dirname(ROOT), '/'])
    await assert.rejects(run(ctx, { runDir: path, maxNew: 0 }), errorKind('configuration'));
  const target = join(ctx.directory, 'protected-target');
  await mkdir(target);
  const link = join(ctx.directory, 'symlink-run');
  await symlink(target, link);
  await assert.rejects(run(ctx, { runDir: link }), errorKind('filesystem'));
  await mkdir(ctx.runDir);
  await symlink(target, artifact(ctx, 'diagnostics'));
  await assert.rejects(run(ctx), errorKind('filesystem'));
  assert.deepEqual(await readdir(target), []);
  for (const name of ['plan.json', 'study-results.json', '.lock', 'diagnostics/original.json']) {
    const path = artifact(ctx, name);
    const plan = buildPlan({ ...ctx, basePrompt: BASE, sourceHashes: { dataset: { path, sha256: '0'.repeat(64) } } });
    await rm(artifact(ctx, 'diagnostics'), { force: true });
    await assert.rejects(run(ctx, { plan }), errorKind('configuration'));
    assert.ok(!(await readdir(ctx.runDir)).includes('.lock'));
  }
});

test('even a progress observer mutating the caller inputs cannot bypass the pre-API fingerprint check', async t => {
  const ctx = await setup(t);
  let calls = 0;
  await assert.rejects(run(ctx, { maxNew: 1, evaluate: async args => { calls++; return fakeResult(args); },
    onProgress: event => { if (event.status === 'running') ctx.records[0].transcript[0].text += ' changed by observer'; }
  }), errorKind('contract_changed'));
  assert.equal(calls, 0);
  assert.equal((await journal(ctx)).entries.length, 0);
});

test('onAttempt/progress expose only safe counters and IDs; exceptions are terminal sanitized errors, never retried', async t => {
  const ctx = await setup(t), progress = [];
  let calls = 0;
  const report = await run(ctx, { maxNew: 2, selectedHypotheses: 'H2', evaluate: async args => {
    calls++;
    args.onAttempt({ attempt: 1, status: KEY, validation_errors: [KEY, CONTEXT], diagnostic_id: KEY, raw_response: KEY });
    args.onAttempt({ attempt: 2, status: 'invalid', validation_errors: [KEY] });
    throw new Error(`${KEY} ${CONTEXT}`);
  }, onProgress: event => { progress.push(event); throw new Error(KEY); } });
  assert.equal(calls, 2);
  assert.equal(report.summary.error, 2);
  assert.equal(report.summary.pending, 38);
  const attempts = progress.filter(e => e.status === 'attempt');
  assert.equal(attempts.length, 4);
  assert.equal(attempts[0].attempt_status, 'unknown');
  for (const event of attempts) assert.deepEqual(Object.keys(event).sort(), ['attempt', 'attempt_status', 'conversation_id', 'hypothesis', 'status', 'task_id']);
  assert.ok(!JSON.stringify(progress).includes(KEY) && !JSON.stringify(progress).includes(CONTEXT));
  assert.ok(!JSON.stringify(report).includes(KEY) && !JSON.stringify(report).includes(CONTEXT));
  await privateArtifacts(ctx.runDir);
  await run(ctx, { maxNew: 0, selectedHypotheses: 'H2' });
  assert.equal(calls, 2);
});

test('native 429 has exactly one transport attempt and echoed secrets stay redacted in journal/raw private paths', async t => {
  const ctx = await setup(t);
  let calls = 0;
  const config = { ...ctx.config, apiKey: KEY, fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: `${KEY} provider failure` }, usage: { synthetic_echo: KEY } }), { status: 429 });
  } };
  const report = await run(ctx, { evaluate: evaluateResearch, config, maxNew: 1 });
  assert.equal(calls, 1);
  assert.equal(report.entries[0].result.error.kind, 'http_error');
  assert.equal(report.entries[0].result.attempts.length, 1);
  assert.equal(report.entries[0].result.usage[0].synthetic_echo, '[REDACTED]');
  await run(ctx, { evaluate: evaluateResearch, config, maxNew: 0 });
  assert.equal(calls, 1);
  const files = await privateArtifacts(ctx.runDir);
  assert.equal(files.length, 3);
});

test('explicit delay separates sequential calls; selection arrays never change the predeclared order', async t => {
  const ctx = await setup(t), starts = [], finishes = [];
  await run(ctx, { selectedHypotheses: ['H6', 'H1'], maxNew: 2, delayMs: 20, evaluate: async args => {
    starts.push(performance.now());
    assert.ok(IDS.includes(args.conversation.conversation_id), 'H1 still runs before H6');
    await delay(5);
    finishes.push(performance.now());
    return fakeResult(args);
  } });
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - finishes[0] >= 15);
});

test('settings use production defaults and supplied real options, not a hardcoded alternative model or key', () => {
  const ctx = fixture(), defaults = buildPlan({ ...ctx, basePrompt: BASE, config: {} });
  assert.deepEqual(defaults.resolved_config, { baseUrl: 'https://openrouter.ai/api/v1', model: 'stealth/crouton-alpha',
    timeoutMs: 55000, requestTimeoutMs: 35000, maxTokens: 4096, structuredOutput: 'json_schema', provider: null,
    reasoningEffort: 'minimal', diagnosticDir: 'diagnostics' });
  const configured = fixture({ config: { model: 'synthetic/custom-model', baseUrl: 'https://provider.example.invalid/v1',
    provider: 'Synthetic Provider', reasoningEffort: 'low', structuredOutput: 'json_object', maxTokens: '900' } });
  assert.equal(configured.plan.resolved_config.model, 'synthetic/custom-model');
  assert.equal(configured.plan.resolved_config.maxTokens, 900);
  assert.equal(configured.plan.resolved_config.structuredOutput, 'json_object');
  assert.equal(configured.plan.resolved_config.reasoningEffort, 'low');
  assert.equal(configured.plan.resolved_config.provider, 'Synthetic Provider');
  for (const baseUrl of ['http://provider.example.invalid', 'https://user:pass@provider.example.invalid',
    'https://provider.example.invalid/?key=secret', 'https://provider.example.invalid/#fragment',
    'https://provider.example.invalid/?', 'https://provider.example.invalid/#'])
    assert.throws(() => fixture({ config: { baseUrl } }), errorKind('configuration'));
});

test('null/array artifacts are rejected, never treated as an absent immutable plan or an empty journal', async t => {
  const ctx = await setup(t);
  await run(ctx, { maxNew: 0 });
  for (const name of ['plan.json', 'study-results.json']) {
    const path = artifact(ctx, name), original = await readFile(path);
    for (const value of ['null', '[]', '42']) {
      await writeFile(path, value);
      await assert.rejects(run(ctx, { evaluate: () => assert.fail('API must not run') }), errorKind('invalid_input'));
      assert.equal(await readFile(path, 'utf8'), value);
    }
    await writeFile(path, original);
  }
});

test('a saved plan modified or removed during a run blocks the next API, preserving the completed checkpoint', async t => {
  for (const removed of [false, true]) {
    const ctx = await setup(t);
    let calls = 0;
    await assert.rejects(run(ctx, { maxNew: 2, evaluate: async args => {
      calls++;
      if (removed) await rm(artifact(ctx, 'plan.json'));
      else {
        const saved = await readJson(artifact(ctx, 'plan.json'));
        saved.tasks.reverse();
        await writeFile(artifact(ctx, 'plan.json'), JSON.stringify(saved));
      }
      return fakeResult(args);
    } }), errorKind('contract_changed'));
    assert.equal(calls, 1);
    assert.equal((await journal(ctx)).entries.length, 1);
  }
});

test('H4 cannot accept an ok return without a body hash as an identical replicate', async t => {
  const ctx = await setup(t);
  await run(ctx, { selectedHypotheses: 'H3' });
  let calls = 0;
  const evaluate = async args => { calls++; return { ...fakeResult(args), request_sha256: null }; };
  await assert.rejects(run(ctx, { selectedHypotheses: 'H4', evaluate }), errorKind('contract_changed'));
  assert.equal((await journal(ctx)).entries.at(-1).request_hash_matches_baseline, false);
  await assert.rejects(run(ctx, { selectedHypotheses: 'H4', evaluate }), errorKind('contract_changed'));
  assert.equal(calls, 1);
});

test('isolated CLI --plan needs no key/API, captures env and all source hashes, then --run --max-new 0 resumes safely', async t => {
  const ctx = await setup(t), project = join(ctx.directory, 'isolated-project');
  // Exercise the real CLI guard without writing into this repository or its data directory.
  const sources = ['scripts/hypothesis-study.js', 'scripts/hypothesis-client.js', 'scripts/ai-common.js',
    'server/prompts/evaluate-v2.txt', 'server/services/ai.js', 'server/services/ai-contract.js',
    'server/checklists.js', 'server/validate-results.js'];
  for (const path of sources) {
    await mkdir(dirname(join(project, path)), { recursive: true });
    await cp(join(ROOT, path), join(project, path));
  }
  await writeFile(join(project, 'package.json'), JSON.stringify({ type: 'module' }));
  await symlink(join(ROOT, 'node_modules'), join(project, 'node_modules'));
  const datasetPath = join(ctx.directory, 'cli-dev.json'), versionPath = join(ctx.directory, 'cli-version.json');
  const originalBytes = JSON.stringify({ isSuccess: true, data: { records: ctx.records } });
  await writeFile(datasetPath, originalBytes);
  await writeFile(versionPath, JSON.stringify(ctx.version));
  const args = [join(project, 'scripts/hypothesis-study.js'), '--dataset', datasetPath, '--version-file', versionPath,
    '--run-dir', 'data/ai-results/hypotheses'];
  const options = { cwd: project, timeout: 10000, env: { ...process.env, AI_API_KEY: '',
    AI_BASE_URL: 'https://provider.example.invalid/v1', AI_MODEL: 'synthetic/env-model', AI_TIMEOUT_MS: '3000',
    AI_REQUEST_TIMEOUT_MS: '1000', AI_MAX_TOKENS: '999', AI_STRUCTURED_OUTPUT: 'json_object',
    AI_PROVIDER: 'Synthetic Env Provider', AI_REASONING_EFFORT: 'low', AI_DIAGNOSTIC_DIR: join(ctx.directory, 'DO_NOT_WRITE') } };
  const planned = await exec(process.execPath, [...args, '--plan'], options);
  assert.equal(planned.stderr, '');
  assert.equal(JSON.parse(planned.stdout).status, 'planned');
  assert.equal(JSON.parse(planned.stdout).tasks, 40);
  const runDir = join(project, 'data/ai-results/hypotheses'), planPath = join(runDir, 'plan.json');
  assert.deepEqual(await readdir(runDir), ['plan.json']);
  const plan = await readJson(planPath), bytes = await readFile(planPath), before = await stat(planPath);
  assert.equal(plan.source_originalDEV_sha256, hash(originalBytes));
  assert.equal(plan.resolved_config.model, 'synthetic/env-model');
  assert.equal(plan.resolved_config.provider, 'Synthetic Env Provider');
  assert.equal(plan.resolved_config.reasoningEffort, 'low');
  assert.equal(plan.resolved_config.maxTokens, 999);
  assert.equal(plan.resolved_config.structuredOutput, 'json_object');
  assert.equal(plan.resolved_config.baseUrl, options.env.AI_BASE_URL);
  assert.deepEqual(Object.keys(plan.hashes.source_sha256).sort(), sources.toSorted());
  for (const path of sources) assert.equal(plan.hashes.source_sha256[path], hash(await readFile(join(project, path))));
  assert.ok(!JSON.stringify(plan).includes('DO_NOT_WRITE'));
  assert.ok(!JSON.stringify(plan).includes('apiKey') && !JSON.stringify(plan).includes('fetchImpl'));
  const resumed = await exec(process.execPath, [...args, '--run', '--hypothesis', 'H1', '--max-new', '0'], options);
  assert.equal(JSON.parse(resumed.stdout).pending, 40);
  assert.deepEqual(await readFile(planPath), bytes);
  assert.equal((await stat(planPath)).mtimeMs, before.mtimeMs);
  assert.equal((await readJson(join(runDir, 'study-results.json'))).resolved_config.diagnosticDir, join(runDir, 'diagnostics'));
  assert.equal(await readFile(datasetPath, 'utf8'), originalBytes);
  const missingKey = await exec(process.execPath, [...args, '--run', '--hypothesis', 'H1', '--max-new', '1'], options)
    .then(() => assert.fail('Missing key was accepted'), error => error);
  assert.equal(missingKey.code, 1);
  assert.match(missingKey.stderr, /AI_API_KEY/u);
  assert.equal((await readJson(join(runDir, 'study-results.json'))).entries.length, 0);
  assert.deepEqual((await readdir(runDir)).sort(), ['plan.json', 'study-results.json']);
  assert.ok(!planned.stdout.includes(CONTEXT) && !resumed.stdout.includes(CONTEXT));
  await privateArtifacts(runDir);
});

test('CLI help is key-free; invalid modes, limits, H5, retry flag and unsafe output locations fail without API or writes', async t => {
  const ctx = await setup(t);
  const help = await exec(process.execPath, [SCRIPT, '--help'], { cwd: ROOT, timeout: 10000, env: { ...process.env, AI_API_KEY: '' } });
  assert.match(help.stdout, /40 задач/u);
  assert.match(help.stdout, /default: 4000/u);
  assert.match(help.stdout, /--plan/u);
  assert.match(help.stdout, /--hypothesis/u);
  assert.ok(!help.stdout.includes(KEY) && help.stderr === '');
  for (const args of [[], ['--plan', '--run'], ['--run'], ['--run', '--hypothesis', 'H5'], ['--plan', '--max-new', '1'],
    ['--run', '--hypothesis', 'H1', '--max-new', '-1'], ['--run', '--hypothesis', 'H1', '--delay-ms', 'NaN'],
    ['--run', '--hypothesis', 'H1', '--retry-failed']])
    await assert.rejects(main(args));
  for (const runDir of [ctx.runDir, join(ROOT, 'results'), join(ROOT, 'server')]) {
    const result = await exec(process.execPath, [SCRIPT, '--plan', '--dataset', join(ctx.directory, 'absent-input.json'),
      '--version-file', join(ctx.directory, 'absent-version.json'), '--run-dir', runDir],
    { cwd: ROOT, timeout: 10000, env: { ...process.env, AI_API_KEY: KEY } }).then(() => assert.fail('Unsafe CLI location accepted'), error => error);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /projectroot\/data/u);
    assert.ok(!result.stderr.includes(KEY) && !result.stdout.includes(KEY));
  }
  assert.deepEqual(await readdir(ctx.directory), []);
});
