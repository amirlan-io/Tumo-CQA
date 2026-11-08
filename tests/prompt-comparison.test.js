import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { defaultConfig } from '../server/checklists.js';
import * as runtimeAi from '../server/services/ai.js';
import { createOutputContract, prepareInput } from '../server/services/ai-contract.js';
import { checkApproval, prepareCases } from '../scripts/ai-benchmark.js';
import { CliError, freeze, loadAi } from '../scripts/ai-common.js';
import { comparePrompts, comparisonStats, summarizeComparison } from '../scripts/compare-prompts.js';

// Synthetic inputs and temporary output only. Neither .env nor the private dataset is loaded.
const MODEL = 'synthetic/prompt-comparison-model';
const API_KEY = 'synthetic-prompt-comparison-credential-not-a-real-key';
const PRIVATE_TEXT = 'SYNTHETIC_TRANSCRIPT_NOT_FOR_REPORT';
const GOLD_ONLY = 'SYNTHETIC_GOLD_NEVER_SEND_TO_MODEL';
const AUDIO_URL = 'https://audio.example.invalid/synthetic.wav?signature=synthetic-private-signature';
const V1_SHA256 = '8c367aa0d5eaaa387940febae39b3b1c20e48be12c84cd1ec2a7f6955ee5de00';
const SETTINGS = Object.freeze({ apiKey: API_KEY, timeoutMs: 2000, requestTimeoutMs: 1000 });
const execute = promisify(execFile);
const aiUrl = new URL('../server/services/ai.js', import.meta.url).href;
const commonUrl = new URL('../scripts/ai-common.js', import.meta.url).href;
const comparisonUrl = new URL('../scripts/compare-prompts.js', import.meta.url).href;

beforeEach(t => {
  const blocked = t.mock.method(globalThis, 'fetch', () => assert.fail('Real network is forbidden in prompt-comparison tests'));
  t.after(() => assert.equal(blocked.mock.callCount(), 0, 'Use an injected fake fetch or evaluator factory'));
});

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cqa-prompt-comparison-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function versionFixture() {
  return { ...structuredClone(defaultConfig), rounding_digits: 2,
    id: '11111111-1111-4111-8111-111111111111',
    checklist_id: '22222222-2222-4222-8222-222222222222', version: 7,
    created_at: '2026-01-01T00:00:00.000Z' };
}

function resultsFor(conversation, version) {
  return version.criteria.map(criterion => ({
    criterion_id: criterion.criterion_id,
    answer: criterion.is_gross_error ? 'no' : criterion.answer_type === 'scale' ? 'scale' : 'yes',
    raw_score: criterion.is_gross_error ? null : criterion.answer_type === 'scale'
      ? Math.max(...criterion.scale.map(step => step.value)) : 1,
    explanation: 'Критерий проверен по исходным репликам оператора.',
    evidence_message_nos: criterion.is_gross_error ? [] : [conversation.transcript.length],
    checked_range: criterion.is_gross_error ? { from: 1, to: conversation.transcript.length } : null,
    na_reason: null
  }));
}

function casesFor(version, count = 3, prefix = 'development') {
  return Array.from({ length: count }, (_, index) => {
    const conversation = { id: `synthetic-internal-${prefix}-${index}`,
      conversation_id: `synthetic-${prefix}-${index}`, language: ['RU', 'KZ', 'EN'][index % 3],
      channel: index === 0 ? 'voice call' : 'agent chat', audio_url: index === 0 ? AUDIO_URL : null,
      transcript: [
        { speaker: 'client', text: 'Где посмотреть историю операций?' },
        { speaker: 'system', text: PRIVATE_TEXT },
        { speaker: 'bot', text: 'Запрос передан оператору.' },
        { speaker: 'operator', text: 'Здравствуйте, я Анна. Откройте «Историю». Если нужна помощь, напишите. До свидания!' }
      ].map((message, i) => ({ ...message, message_no: i + 1, timestamp: `2026-01-01T10:00:0${i}Z` })) };
    const results = resultsFor(conversation, version);
    for (const result of results) result.explanation = `Черновая разметка: ${GOLD_ONLY}.`;
    return { conversation, gold: { conversation_id: conversation.conversation_id,
      language: conversation.language, channel: conversation.channel,
      uncertain_criterion_ids: [], review_notes: GOLD_ONLY, results } };
  });
}

function change(results, id, fields) {
  const result = results.find(result => result.criterion_id === id);
  assert.ok(result, `Missing synthetic criterion ${id}`);
  Object.assign(result, fields);
}

function negative(results, id) {
  change(results, id, { answer: 'no', raw_score: 0, checked_range: { from: 1, to: 4 } });
}

function outputFor(options, conversation, version) {
  return { model: options.model, prompt_version: options.promptVersion, results: resultsFor(conversation, version) };
}

function fakeAi(handler = (options, conversation, version) => {
  options.onAttempt({ attempt: 1, status: 'valid', validation_errors: [], elapsed_ms: 1,
    diagnostic_id: `${conversation.conversation_id}-${options.promptVersion}` });
  return outputFor(options, conversation, version);
}) {
  const factories = [], calls = [];
  const ai = Object.freeze({ model: 'unused/global-model', prompt_version: 'v1',
    supportedPromptVersions: Object.freeze(['v1', 'v2']),
    evaluateDialogue: () => assert.fail('Comparison must not use the shared default evaluator'),
    createEvaluator(options) {
      factories.push(options);
      let invocations = 0;
      return async (...args) => {
        assert.equal(++invocations, 1, 'Each case/prompt pair needs a fresh evaluator call');
        assert.equal(args.length, 3);
        const [conversation, version, runtime] = args;
        assert.deepEqual(Object.keys(runtime), ['signal']);
        assert.ok(runtime.signal instanceof AbortSignal);
        assert.equal(runtime.signal.aborted, false);
        assert.ok(!JSON.stringify({ options, conversation, version }).includes(GOLD_ONLY), 'Gold must never enter evaluator arguments');
        calls.push({ options, conversation, version, runtime });
        return handler(options, conversation, version, runtime);
      };
    } });
  return { ai, factories, calls };
}

const compare = (suites, version, ai, extra = {}) => comparePrompts({
  suites, version, ai, model: MODEL, prompts: ['v1', 'v2'], settings: SETTINGS, ...extra
});

function completion(results) {
  return new Response(JSON.stringify({ model: 'synthetic/provider-resolved-model',
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results }) } }] }),
  { headers: { 'Content-Type': 'application/json' } });
}

async function runtimeSetup(t) {
  const diagnosticDir = await temporary(t);
  const requests = [];
  const settings = { ...SETTINGS, model: MODEL, baseUrl: 'https://provider.example.invalid/v1',
    maxTokens: 512, structuredOutput: 'json_schema', provider: '', reasoningEffort: '', diagnosticDir,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url: String(url), body });
      const input = JSON.parse(body.messages[1].content);
      return completion(resultsFor(input.conversation, input.checklist_version));
    } };
  return { diagnosticDir, requests, settings };
}

async function child(source, directory, environment = {}) {
  const { stdout, stderr } = await execute(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: directory, timeout: 20000, maxBuffer: 1024 * 1024,
    // Do not inherit AI credentials, NODE_OPTIONS, env-file flags or user configuration.
    env: { LANG: 'C.UTF-8', ...environment }
  });
  assert.equal(stderr, '');
  return JSON.parse(stdout);
}

const noFile = path => assert.rejects(stat(path), { code: 'ENOENT' });

function assertPrivate(raw) {
  for (const forbidden of [API_KEY, PRIVATE_TEXT, AUDIO_URL, 'synthetic-private-signature', GOLD_ONLY, 'PRIVATE_PROVIDER_BODY'])
    assert.ok(!raw.includes(forbidden), `Report must not contain ${forbidden}`);
}

test('v1 remains byte-for-byte the original prompt; supported versions are frozen and loadAi accepts metadata', async () => {
  const v1 = await readFile(new URL('../server/prompts/evaluate-v1.txt', import.meta.url));
  assert.equal(createHash('sha256').update(v1).digest('hex'), V1_SHA256, 'Do not edit the established v1 prompt');
  assert.ok(['v1', 'v2'].every(prompt => runtimeAi.supportedPromptVersions.includes(prompt)));
  assert.equal(Object.isFrozen(runtimeAi.supportedPromptVersions), true);
  assert.throws(() => runtimeAi.supportedPromptVersions.push('v3'), TypeError);
  assert.equal(typeof runtimeAi.evaluateDialogue, 'function');
  assert.equal(await loadAi(), runtimeAi);
});

test('isolated imports default to v1, opt into v2 through AI_PROMPT_VERSION, and never call an API', async t => {
  const directory = await temporary(t);
  for (const selected of ['', 'v2']) {
    const metadata = await child(`
      import assert from 'node:assert/strict';
      let fetches = 0;
      globalThis.fetch = () => { fetches++; throw new Error('Forbidden network'); };
      const ai = await import(${JSON.stringify(aiUrl)});
      const { loadAi } = await import(${JSON.stringify(commonUrl)});
      assert.equal(await loadAi(), ai);
      process.stdout.write(JSON.stringify({ prompt_version: ai.prompt_version,
        supported: ai.supportedPromptVersions, frozen: Object.isFrozen(ai.supportedPromptVersions),
        evaluator: typeof ai.evaluateDialogue, factory: typeof ai.createEvaluator, fetches }));
    `, directory, { AI_PROMPT_VERSION: selected });
    assert.deepEqual(metadata, { prompt_version: selected || 'v1', supported: runtimeAi.supportedPromptVersions,
      frozen: true, evaluator: 'function', factory: 'function', fetches: 0 });
  }
});

test('runtime selects each prompt, schema name, returned metadata and private diagnostics without changing v1 or globals', async t => {
  const version = versionFixture();
  const [{ conversation }] = casesFor(version, 1);
  const before = structuredClone({ conversation, version });
  const exportedPrompt = runtimeAi.prompt_version;
  const defaultEvaluator = runtimeAi.evaluateDialogue;
  const ctx = await runtimeSetup(t);
  const texts = Object.fromEntries(await Promise.all(['v1', 'v2'].map(async prompt =>
    [prompt, await readFile(new URL(`../server/prompts/evaluate-${prompt}.txt`, import.meta.url), 'utf8')])));
  assert.notEqual(texts.v1, texts.v2);
  const selected = ['v1', 'v2', undefined, 'v1'];
  for (const promptVersion of selected) {
    const options = { ...ctx.settings, ...(promptVersion === undefined ? {} : { promptVersion }) };
    const output = await runtimeAi.createEvaluator(options)(conversation, version);
    assert.deepEqual(output, { model: MODEL, prompt_version: promptVersion ?? exportedPrompt,
      results: resultsFor(conversation, version) });
  }
  assert.equal(ctx.requests.length, selected.length);
  const records = await Promise.all((await readdir(ctx.diagnosticDir)).map(async name => {
    const path = join(ctx.diagnosticDir, name);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    return JSON.parse(await readFile(path, 'utf8'));
  }));
  assert.equal(records.length, selected.length);
  assert.equal(new Set(records.map(record => record.diagnostic_id)).size, selected.length);
  for (const [index, request] of ctx.requests.entries()) {
    const prompt = selected[index] ?? exportedPrompt;
    assert.equal(request.url, 'https://provider.example.invalid/v1/chat/completions');
    assert.equal(request.body.model, MODEL);
    assert.equal(request.body.temperature, 0);
    assert.equal(request.body.messages.length, 2);
    assert.deepEqual(request.body.messages[0], { role: 'system', content: texts[prompt] });
    assert.deepEqual(JSON.parse(request.body.messages[1].content), prepareInput(conversation, version));
    assert.deepEqual(request.body.response_format.json_schema, { name: `dialogue_evaluation_${prompt}`,
      strict: true, schema: createOutputContract(prepareInput(conversation, version)).schema });
  }
  assert.deepEqual(ctx.requests[0].body, ctx.requests.at(-1).body, 'Selecting v2 must not mutate later v1 requests');
  assert.deepEqual(ctx.requests[2].body, ctx.requests[selected.indexOf(exportedPrompt)].body, 'Default selection must equal explicit selection');
  for (const prompt of ['v1', 'v2']) {
    const expectedCount = selected.filter(value => (value ?? exportedPrompt) === prompt).length;
    const matching = records.filter(record => record.prompt_version === prompt);
    assert.equal(matching.length, expectedCount);
    for (const record of matching) {
      assert.equal(record.model, MODEL);
      assert.equal(record.conversation_id, conversation.conversation_id);
      assert.equal(record.checklist_version, version.id);
      assert.equal(record.status, 'valid');
      assert.equal(record.attempt, 1);
    }
  }
  assert.equal(runtimeAi.prompt_version, exportedPrompt);
  assert.equal(runtimeAi.evaluateDialogue, defaultEvaluator);
  assert.deepEqual({ conversation, version }, before);
  assert.equal(createHash('sha256').update(await readFile(new URL('../server/prompts/evaluate-v1.txt', import.meta.url))).digest('hex'), V1_SHA256);
});

test('v2 repair keeps its selected prompt, JSON schema and diagnostic metadata for both attempts', async t => {
  const version = versionFixture();
  const [{ conversation }] = casesFor(version, 1);
  const ctx = await runtimeSetup(t);
  const attempts = [], bodies = [];
  const evaluate = runtimeAi.createEvaluator({ ...ctx.settings, promptVersion: 'v2',
    onAttempt: event => attempts.push(event), fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1 ? new Response('not JSON') : completion(resultsFor(conversation, version));
    } });
  assert.equal((await evaluate(conversation, version)).prompt_version, 'v2');
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].messages.slice(0, 2), bodies[0].messages);
  assert.deepEqual(bodies[1].response_format, bodies[0].response_format);
  assert.equal(bodies[1].response_format.json_schema.name, 'dialogue_evaluation_v2');
  assert.equal(bodies[1].messages.length, 3);
  assert.deepEqual(attempts.map(attempt => attempt.status), ['invalid', 'valid']);
  const records = await Promise.all((await readdir(ctx.diagnosticDir)).map(async name => JSON.parse(await readFile(join(ctx.diagnosticDir, name), 'utf8'))));
  assert.deepEqual(records.map(record => record.attempt).sort(), [1, 2]);
  assert.ok(records.every(record => record.prompt_version === 'v2' && record.model === MODEL));
});

test('unknown, empty, inherited-property and path-like prompt versions fail AI_CONFIG before fetch or diagnostics', async t => {
  const version = versionFixture();
  const [{ conversation }] = casesFor(version, 1);
  const ctx = await runtimeSetup(t);
  for (const promptVersion of ['unsupported', '', 'V2', '__proto__', 'constructor', '../v2', '../../.env', 'v2/../v1', '/tmp/evaluate-v2.txt']) {
    await assert.rejects(runtimeAi.createEvaluator({ ...ctx.settings, promptVersion })(conversation, version),
      { code: 'AI_CONFIG', status: 503 }, `Invalid prompt version ${promptVersion}`);
  }
  assert.equal(ctx.requests.length, 0);
  assert.deepEqual(await readdir(ctx.diagnosticDir), []);
});

test('synthetic default responses satisfy the actual strict eight-criterion contract', () => {
  const version = versionFixture();
  for (const { conversation } of casesFor(version)) {
    const results = resultsFor(conversation, version);
    assert.deepEqual(createOutputContract(prepareInput(conversation, version)).parse(JSON.stringify({ results })), { results, errors: [] });
    assert.equal(results[7].answer, 'no');
    assert.equal(results[7].raw_score, null);
    assert.deepEqual(results[7].checked_range, { from: 1, to: 4 });
  }
});

test('comparison makes fresh sequential paired calls in alternating order across suites without passing labels or mutating exports', async () => {
  const version = freeze(versionFixture());
  const development = casesFor(version, 2);
  const holdout = casesFor(version, 1, 'holdout');
  const suites = freeze({ development, holdout });
  const before = structuredClone(suites);
  const exportedPrompt = runtimeAi.prompt_version;
  const defaultEvaluator = runtimeAi.evaluateDialogue;
  let active = 0, maxActive = 0;
  const ctx = fakeAi(async (options, conversation, selectedVersion) => {
    maxActive = Math.max(maxActive, ++active);
    await Promise.resolve();
    active--;
    options.onAttempt({ attempt: 1, status: 'valid' });
    return outputFor(options, conversation, selectedVersion);
  });
  const settings = Object.freeze({ ...SETTINGS, model: 'unused/settings-model', promptVersion: 'unused/settings-prompt' });
  const report = await compare(suites, version, ctx.ai, { settings });
  assert.equal(maxActive, 1);
  const expected = [[development[0], 'v1'], [development[0], 'v2'],
    [development[1], 'v2'], [development[1], 'v1'], [holdout[0], 'v1'], [holdout[0], 'v2']];
  assert.equal(ctx.factories.length, 6);
  assert.equal(ctx.calls.length, 6);
  assert.equal(new Set(ctx.factories).size, 6);
  assert.equal(new Set(ctx.factories.map(options => options.onAttempt)).size, 6);
  for (const [index, [entry, prompt]] of expected.entries()) {
    const call = ctx.calls[index];
    assert.equal(call.options, ctx.factories[index]);
    assert.equal(call.conversation, entry.conversation, 'Each pair must use the same conversation');
    assert.equal(call.version, version, 'All prompts must use the same checklist snapshot');
    assert.equal(call.options.promptVersion, prompt);
    assert.equal(call.options.model, MODEL);
    assert.equal(call.options.apiKey, API_KEY);
    assert.equal(call.options.timeoutMs, SETTINGS.timeoutMs);
    assert.deepEqual(Object.keys(call.options).sort(), ['apiKey', 'model', 'onAttempt', 'promptVersion', 'requestTimeoutMs', 'timeoutMs']);
  }
  assert.equal(report.schema_version, 'prompt-comparison-1.0');
  assert.equal(report.status, 'completed');
  assert.equal(report.preliminary, true);
  assert.equal(report.model, MODEL);
  assert.deepEqual(report.prompts, ['v1', 'v2']);
  assert.deepEqual(report.suites, { development: { cases: 2 }, holdout: { cases: 1 } });
  assert.deepEqual(report.cases.map(row => row.prompt_order), [['v1', 'v2'], ['v2', 'v1'], ['v1', 'v2']]);
  assert.ok(Number.isFinite(Date.parse(report.started_at)));
  assert.ok(Number.isFinite(Date.parse(report.finished_at)));
  for (const row of report.cases) {
    assert.deepEqual(Object.keys(row.expected[0]).sort(), ['answer', 'criterion_id', 'raw_score']);
    for (const prompt of report.prompts) {
      const result = row.evaluations[prompt];
      assert.equal(result.output.model, MODEL);
      assert.equal(result.output.prompt_version, prompt);
      assert.equal(result.output.results.length, 8);
      assert.equal(result.status, 'matched');
      assert.equal(result.attempt_count, 1);
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.failures, []);
    }
  }
  assert.deepEqual(suites, before);
  assert.equal(ctx.ai.prompt_version, 'v1');
  assert.equal(settings.promptVersion, 'unused/settings-prompt');
  assert.equal(runtimeAi.prompt_version, exportedPrompt);
  assert.equal(runtimeAi.evaluateDialogue, defaultEvaluator);
  assertPrivate(JSON.stringify(report));
});

test('pacing waits only between calls across suites and stays outside evaluation latency', async t => {
  const version = versionFixture();
  const suites = freeze({ development: casesFor(version, 2), holdout: casesFor(version, 1, 'holdout') });
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const events = [], checkpoints = [];
  const ctx = fakeAi((options, conversation, selectedVersion) => {
    events.push(`call:${options.promptVersion}`);
    now += 7;
    options.onAttempt({ attempt: 1, status: 'valid', elapsed_ms: 7 });
    return outputFor(options, conversation, selectedVersion);
  });
  const report = await compare(suites, version, ctx.ai, {
    delayMs: 4000,
    wait: async milliseconds => {
      assert.equal(checkpoints.length, ctx.calls.length, 'Each result must be checkpointed before waiting');
      events.push(`wait:${milliseconds}`);
      now += milliseconds;
    },
    onCheckpoint: current => { checkpoints.push(structuredClone(current)); }
  });
  assert.deepEqual(events, ['call:v1', 'wait:4000', 'call:v2', 'wait:4000',
    'call:v2', 'wait:4000', 'call:v1', 'wait:4000', 'call:v1', 'wait:4000', 'call:v2']);
  assert.equal(ctx.calls.length, 6);
  assert.equal(now, 6 * 7 + 5 * 4000);
  assert.equal(report.methodology.delay_ms, 4000);
  for (const row of report.cases) for (const prompt of report.prompts) {
    assert.equal(row.evaluations[prompt].latency_ms, 7);
    assert.equal(report.summary[row.suite][prompt].all.mean_latency_ms, 7);
  }
  assert.equal(checkpoints.length, 7);
  assert.deepEqual(checkpoints.at(-1), report);
});

test('omitted or zero delay never waits; empty suites also skip a positive delay', async () => {
  const version = versionFixture();
  for (const delayMs of [undefined, 0]) {
    const ctx = fakeAi();
    const report = await compare({ development: casesFor(version, 1) }, version, ctx.ai, {
      delayMs, wait: () => assert.fail('Zero delay must not schedule a wait')
    });
    assert.equal(ctx.calls.length, 2);
    assert.equal(report.methodology.delay_ms, 0);
  }
  const ctx = fakeAi();
  const report = await compare({ development: [] }, version, ctx.ai, {
    delayMs: 60000, wait: () => assert.fail('No calls means no waits')
  });
  assert.equal(ctx.factories.length, 0);
  assert.equal(ctx.calls.length, 0);
  assert.equal(report.methodology.delay_ms, 60000);
  assert.equal(report.status, 'completed');
});

test('invalid delays reject before any evaluator, wait, contract check or checkpoint', async t => {
  const version = versionFixture();
  const cases = freeze(casesFor(version, 1));
  for (const delayMs of [NaN, Infinity, -Infinity, -1, 0.5, 60001, '0', null]) await t.test(String(delayMs), async () => {
    const ctx = fakeAi();
    await assert.rejects(compare({ development: cases }, version, ctx.ai, {
      delayMs,
      wait: () => assert.fail('Invalid delay must not wait'),
      assertContract: () => assert.fail('Invalid delay must fail preflight'),
      onCheckpoint: () => assert.fail('Invalid delay must not write a checkpoint')
    }), { kind: 'configuration', message: /--delay-ms/ });
    assert.equal(ctx.factories.length, 0);
    assert.equal(ctx.calls.length, 0);
  });
});

test('checkpoints are snapshots of running incomplete pairs; only the final checkpoint is complete', async () => {
  const version = versionFixture();
  const cases = freeze(casesFor(version, 2));
  const ctx = fakeAi();
  const checkpoints = [];
  const report = await compare({ development: cases }, version, ctx.ai, {
    onCheckpoint: current => { checkpoints.push(structuredClone(current)); }
  });
  assert.equal(checkpoints.length, 5);
  const first = checkpoints[0];
  assert.equal(first.status, 'running');
  assert.equal(Object.hasOwn(first, 'finished_at'), false);
  assert.equal(first.cases.length, 1);
  assert.deepEqual(Object.keys(first.cases[0].evaluations), ['v1']);
  assert.equal(first.summary.development.v1.all.completed, 1);
  assert.equal(first.summary.development.v2.all.evaluated, 0);
  assert.equal(first.summary.development.v2.all.failed, 0, 'Pending must not be counted as a failed evaluation');
  assert.equal(first.summary.development.v2.all.matched_criteria, 0);
  assert.equal(first.summary.development.v2.all.total_criteria, 8);
  assert.equal(checkpoints[1].status, 'running');
  assert.deepEqual(Object.keys(checkpoints[1].cases[0].evaluations), ['v1', 'v2']);
  assert.deepEqual(Object.keys(checkpoints[2].cases[1].evaluations), ['v2']);
  for (const checkpoint of checkpoints.slice(0, -1)) assert.equal(checkpoint.status, 'running');
  assert.deepEqual(checkpoints.at(-1), report);
  assert.equal(report.status, 'completed');
  for (const prompt of report.prompts) assert.equal(report.summary.development[prompt].all.completed, 2);
  assert.deepEqual(Object.keys(first.cases[0].evaluations), ['v1'], 'Captured partial checkpoints must remain partial');
});

test('full agreement includes all eight criteria; only predeclared uncertainty changes the clear denominator', async () => {
  const version = versionFixture();
  const cases = casesFor(version, 2);
  cases[0].gold.uncertain_criterion_ids = ['c1', 'c8'];
  cases[1].gold.uncertain_criterion_ids = ['c4'];
  freeze(cases);
  const ctx = fakeAi((options, conversation, selectedVersion) => {
    options.onAttempt({ attempt: 1, status: 'valid' });
    const output = outputFor(options, conversation, selectedVersion);
    if (options.promptVersion === 'v2') {
      negative(output.results, 'c1');
      if (conversation === cases[0].conversation) change(output.results, 'c8', { answer: 'yes', evidence_message_nos: [4], checked_range: null });
    }
    return output;
  });
  const report = await compare({ development: cases }, version, ctx.ai);
  assert.equal(report.status, 'completed', 'Valid disagreements are not transport failures');
  const v1 = report.summary.development.v1.all;
  const v2 = report.summary.development.v2.all;
  assert.equal(v1.total_criteria, 16);
  assert.equal(v1.matched_criteria, 16);
  assert.equal(v1.predeclared_clear_total, 13);
  assert.equal(v1.predeclared_clear_matched, 13);
  assert.equal(v2.total_criteria, 16);
  assert.equal(v2.matched_criteria, 13);
  assert.equal(v2.agreement, 13 / 16);
  assert.equal(v2.predeclared_clear_total, 13);
  assert.equal(v2.predeclared_clear_matched, 12, 'An undeclared mismatch must remain in the clear subset');
  assert.equal(v2.predeclared_clear_agreement, 12 / 13);
  assert.equal(v2.failed, 0);
  assert.deepEqual(report.cases.map(row => row.uncertain_criterion_ids), [['c1', 'c8'], ['c4']]);
  assert.deepEqual(summarizeComparison(report), report.summary);
});

test('transport and invalid-JSON failures are safe, remain unmatched, and contribute attempts and failure denominators', async () => {
  const version = versionFixture();
  const cases = freeze(casesFor(version, 3));
  const ctx = fakeAi((options, conversation, selectedVersion) => {
    const index = cases.findIndex(entry => entry.conversation === conversation);
    if (options.promptVersion === 'v2' && index === 1) {
      options.onAttempt({ attempt: 1, status: 'network_error', elapsed_ms: 2 });
      throw Object.assign(new Error(`fetch failed PRIVATE_PROVIDER_BODY ${API_KEY} ${PRIVATE_TEXT}`), { code: 'ECONNRESET' });
    }
    if (options.promptVersion === 'v2' && index === 2) {
      for (const attempt of [1, 2]) options.onAttempt({ attempt, status: 'invalid', validation_errors: ['invalid JSON'], elapsed_ms: 3 });
      throw Object.assign(new Error(`PRIVATE_PROVIDER_BODY ${API_KEY}`), { code: 'AI_INVALID_RESPONSE', status: 502 });
    }
    options.onAttempt({ attempt: 1, status: 'valid', elapsed_ms: 1 });
    return outputFor(options, conversation, selectedVersion);
  });
  const checkpoints = [], pauses = [];
  const report = await compare({ development: cases }, version, ctx.ai, {
    delayMs: 25,
    wait: async milliseconds => {
      assert.equal(checkpoints.length, ctx.calls.length, 'Failures must also be checkpointed before waiting');
      pauses.push(milliseconds);
    },
    onCheckpoint: current => { checkpoints.push(structuredClone(current)); }
  });
  assert.equal(ctx.calls.length, 6);
  assert.deepEqual(pauses, [25, 25, 25, 25, 25]);
  assert.equal(checkpoints.length, 7);
  assert.equal(checkpoints[2].cases[1].evaluations.v2.status, 'failed');
  assert.equal(checkpoints[5].cases[2].evaluations.v2.status, 'invalid_output');
  assert.equal(report.status, 'completed_with_failures');
  assert.equal(checkpoints.at(-1).status, 'completed_with_failures');
  const network = report.cases[1].evaluations.v2;
  assert.equal(network.output, null);
  assert.equal(network.status, 'failed');
  assert.equal(network.matched_criteria, null);
  assert.deepEqual(network.failures.map(error => error.kind), ['network']);
  assert.deepEqual(network.errors, []);
  const invalid = report.cases[2].evaluations.v2;
  assert.equal(invalid.output, null);
  assert.equal(invalid.status, 'invalid_output');
  assert.equal(invalid.matched_criteria, null);
  assert.deepEqual(invalid.errors.map(error => error.kind), ['invalid_output']);
  assert.deepEqual(invalid.failures, []);
  const stats = report.summary.development.v2.all;
  assert.equal(stats.cases, 3);
  assert.equal(stats.evaluated, 3);
  assert.equal(stats.completed, 1);
  assert.equal(stats.failed, 2);
  assert.equal(stats.matched_criteria, 8);
  assert.equal(stats.total_criteria, 24);
  assert.equal(stats.agreement, 1 / 3, 'Failed calls must not inflate agreement');
  assert.equal(stats.predeclared_clear_total, 24);
  assert.equal(stats.predeclared_clear_agreement, 1 / 3);
  assert.equal(stats.attempts, 4);
  assert.equal(stats.json_contract_error_attempts, 2);
  assert.ok(Number.isInteger(stats.mean_latency_ms) && stats.mean_latency_ms >= 0);

  assert.equal(report.summary.development.v2.languages.KZ.failed, 1);
  assertPrivate(JSON.stringify(report));
});

test('wrong prompt metadata from an evaluator is rejected instead of relabelled to match the requested prompt', async () => {
  const version = versionFixture();
  const cases = freeze(casesFor(version, 2));
  const ctx = fakeAi((options, conversation, selectedVersion) => ({ ...outputFor(options, conversation, selectedVersion), prompt_version: 'v1' }));
  const report = await compare({ development: cases }, version, ctx.ai);
  assert.equal(report.status, 'completed_with_failures');
  assert.equal(report.summary.development.v1.all.completed, 2);
  assert.equal(report.summary.development.v2.all.completed, 0);
  assert.equal(report.summary.development.v2.all.agreement, 0);
  for (const row of report.cases) {
    assert.equal(row.evaluations.v2.output, null);
    assert.equal(row.evaluations.v2.errors[0].kind, 'invalid_output');
  }
});

test('comparisonStats and summarizeComparison handle failed, pending, all-uncertain and empty language groups deterministically', () => {
  const version = versionFixture();
  const expected = resultsFor({ transcript: Array(4) }, version).map(({ criterion_id, answer, raw_score }) => ({ criterion_id, answer, raw_score }));
  const evaluation = (latency, output, attempts, jsonErrors) => ({ latency_ms: latency, output, attempt_count: attempts, json_error_attempts: jsonErrors });
  const cases = [
    { suite: 'development', language: 'RU', expected, uncertain_criterion_ids: ['c1'], evaluations: {
      v1: evaluation(10, { results: structuredClone(expected) }, 1, 0),
      v2: evaluation(20, null, 2, 2) } },
    { suite: 'development', language: 'KZ', expected, uncertain_criterion_ids: ['c2', 'c8'], evaluations: {
      v1: evaluation(30, null, 1, 0) } },
    { suite: 'holdout', language: 'EN', expected, uncertain_criterion_ids: version.criteria.map(c => c.criterion_id), evaluations: {
      v1: evaluation(50, { results: structuredClone(expected) }, 2, 1) } }
  ];
  const report = freeze({ prompts: ['v1', 'v2'], suites: { development: { cases: 2 }, holdout: { cases: 1 } }, cases });
  const before = structuredClone(report);
  assert.deepEqual(comparisonStats(cases.slice(0, 2), 'v1'), {
    cases: 2, evaluated: 2, completed: 1, failed: 1, matched_criteria: 8, total_criteria: 16,
    agreement: 0.5, predeclared_clear_matched: 7, predeclared_clear_total: 13,
    predeclared_clear_agreement: 7 / 13, mean_latency_ms: 20, attempts: 2, json_contract_error_attempts: 0
  });
  const summary = summarizeComparison(report);
  assert.deepEqual(summary.development.v1.all, comparisonStats(cases.slice(0, 2), 'v1'));
  assert.equal(summary.development.v2.all.evaluated, 1);
  assert.equal(summary.development.v2.all.failed, 1);
  assert.equal(summary.development.v2.all.total_criteria, 16);
  assert.equal(summary.development.v2.all.mean_latency_ms, 20);
  assert.equal(summary.development.v2.all.json_contract_error_attempts, 2);
  assert.equal(summary.holdout.v1.all.predeclared_clear_total, 0);
  assert.equal(summary.holdout.v1.all.predeclared_clear_agreement, null);
  assert.equal(summary.holdout.v1.languages.EN.completed, 1);
  assert.deepEqual(summary.development.v1.languages.EN, {
    cases: 0, evaluated: 0, completed: 0, failed: 0, matched_criteria: 0, total_criteria: 0,
    agreement: null, predeclared_clear_matched: 0, predeclared_clear_total: 0,
    predeclared_clear_agreement: null, mean_latency_ms: null, attempts: 0, json_contract_error_attempts: 0
  });
  assert.deepEqual(report, before);
});

test('assertContract changes abort comparison before another paid call, without modifying source files', async () => {
  const version = versionFixture();
  const cases = freeze(casesFor(version, 2));
  let changed = false, checks = 0;
  const checkpoints = [];
  const ctx = fakeAi((options, conversation, selectedVersion) => {
    changed = true;
    return outputFor(options, conversation, selectedVersion);
  });
  const failure = new CliError('Synthetic contract changed', 'contract_changed');
  await assert.rejects(compare({ development: cases }, version, ctx.ai, {
    assertContract: async () => { checks++; if (changed) throw failure; },
    onCheckpoint: current => { checkpoints.push(structuredClone(current)); }
  }), error => error === failure);
  assert.ok(checks >= 2);
  assert.equal(ctx.factories.length, 1);
  assert.equal(ctx.calls.length, 1);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].status, 'running');
  assert.deepEqual(Object.keys(checkpoints[0].cases[0].evaluations), ['v1']);
  const untouched = fakeAi();
  await assert.rejects(compare({ development: cases }, version, untouched.ai, {
    assertContract: async () => { throw failure; }
  }), error => error === failure);
  assert.equal(untouched.factories.length, 0);
  assert.equal(untouched.calls.length, 0);
});

test('a contract change during a pause stops the next call and preserves the previous checkpoint', async () => {
  const version = versionFixture();
  const ctx = fakeAi();
  const checkpoints = [], pauses = [];
  let changed = false;
  const failure = new CliError('Synthetic contract changed while waiting', 'contract_changed');
  await assert.rejects(compare({ development: casesFor(version, 1) }, version, ctx.ai, {
    delayMs: 4000,
    wait: async milliseconds => { pauses.push(milliseconds); changed = true; },
    assertContract: async () => { if (changed) throw failure; },
    onCheckpoint: current => { checkpoints.push(structuredClone(current)); }
  }), error => error === failure);
  assert.deepEqual(pauses, [4000]);
  assert.equal(ctx.factories.length, 1);
  assert.equal(ctx.calls.length, 1);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].status, 'running');
  assert.deepEqual(Object.keys(checkpoints[0].cases[0].evaluations), ['v1']);
  assert.ok(checkpoints[0].cases[0].evaluations.v1.output);
});

test('too few or duplicate prompts reject before any evaluator is created', async t => {
  const version = versionFixture();
  const cases = freeze(casesFor(version, 2));
  for (const prompts of [[], ['v1'], ['v1', 'v1'], ['v2', 'v1', 'v2']]) await t.test(JSON.stringify(prompts), async () => {
    const ctx = fakeAi();
    let checkpoints = 0;
    await assert.rejects(compare({ development: cases }, version, ctx.ai, {
      prompts, onCheckpoint: () => { checkpoints++; }
    }), { kind: 'configuration' });
    assert.equal(ctx.factories.length, 0);
    assert.equal(ctx.calls.length, 0);
    assert.equal(checkpoints, 0);
  });
});

test('invalid predeclared uncertainty rejects before any evaluator is created', async t => {
  for (const uncertain of ['c1', {}, ['not-a-criterion'], ['c1', 'c1']]) await t.test(JSON.stringify(uncertain), async () => {
    const version = versionFixture();
    const cases = casesFor(version, 2);
    cases[0].gold.uncertain_criterion_ids = uncertain;
    const ctx = fakeAi();
    await assert.rejects(compare({ development: freeze(cases) }, version, ctx.ai), { kind: 'invalid_gold' });
    assert.equal(ctx.factories.length, 0);
    assert.equal(ctx.calls.length, 0);
  });
});

test('invalid uncertainty in a later suite must fail preflight before evaluating earlier valid cases', async () => {
  const version = versionFixture();
  const development = casesFor(version, 2);
  const holdout = casesFor(version, 1, 'holdout');
  holdout[0].gold.uncertain_criterion_ids = ['not-a-criterion'];
  const ctx = fakeAi();
  await assert.rejects(compare(freeze({ development, holdout }), version, ctx.ai), { kind: 'invalid_gold' });
  assert.equal(ctx.calls.length, 0, 'Validate all selected uncertainty IDs before any model call');
  assert.equal(ctx.factories.length, 0);
});

test('development and holdout fixtures are disjoint nine-case drafts with the same rubric and no implicit human approval', async () => {
  const [development, holdout] = await Promise.all(['ai-gold', 'ai-holdout'].map(async name =>
    JSON.parse(await readFile(new URL(`./fixtures/${name}.draft.json`, import.meta.url), 'utf8'))));
  assert.deepEqual(development.checklist_criteria, holdout.checklist_criteria);
  assert.deepEqual(development.checklist_criteria, defaultConfig.criteria);
  const developmentIds = new Set(development.cases.map(entry => entry.conversation_id));
  assert.equal(holdout.cases.some(entry => developmentIds.has(entry.conversation_id)), false);
  for (const gold of [development, holdout]) {
    assert.equal(gold.status, 'draft');
    assert.equal(gold.approved_by, null);
    assert.equal(gold.cases.length, 9);
    assert.equal(new Set(gold.cases.map(entry => entry.conversation_id)).size, 9);
    assert.throws(() => checkApproval(gold, false), { kind: 'invalid_gold' });
    assert.throws(() => prepareCases(gold, [], versionFixture(), false), { kind: 'invalid_gold' });
    assert.doesNotThrow(() => checkApproval(gold, true));
    for (const language of ['RU', 'KZ', 'EN']) assert.equal(gold.cases.filter(entry => entry.language === language).length, 3);
    assert.ok(gold.cases.some(entry => entry.channel === 'voice call'));
    for (const entry of gold.cases) {
      assert.deepEqual(entry.results.map(result => result.criterion_id).sort(), gold.checklist_criteria.map(c => c.criterion_id).sort());
      const uncertain = entry.uncertain_criterion_ids ?? [];
      assert.ok(Array.isArray(uncertain));
      assert.equal(new Set(uncertain).size, uncertain.length);
      assert.ok(uncertain.every(id => gold.checklist_criteria.some(c => c.criterion_id === id)));
    }
  }
  assert.ok(holdout.cases.some(entry => entry.uncertain_criterion_ids?.length), 'Holdout exclusions must be declared before a run');
});

async function cliFixture(t) {
  const directory = await temporary(t);
  const version = versionFixture();
  const development = casesFor(version, 9);
  const holdout = casesFor(version, 9, 'holdout');
  const gold = entries => {
    const cases = structuredClone(entries.map(entry => entry.gold));
    change(cases[0].results, 'c2', { answer: 'na', raw_score: null, na_reason: 'Исходных данных достаточно.' });
    change(cases[0].results, 'c8', { answer: 'yes', raw_score: null, evidence_message_nos: [4], checked_range: null });
    cases[0].uncertain_criterion_ids = ['c2', 'c8'];
    return { status: 'draft', approved_by: null, checklist_criteria: structuredClone(version.criteria), cases };
  };
  const paths = { dataset: join(directory, 'dataset.json'), version: join(directory, 'version.json'),
    development: join(directory, 'development.json'), holdout: join(directory, 'holdout.json') };
  const values = { dataset: { records: [...development, ...holdout].map(entry => entry.conversation) },
    version, development: gold(development), holdout: gold(holdout) };
  const originals = {};
  for (const [name, path] of Object.entries(paths)) {
    originals[name] = JSON.stringify(values[name], null, 2) + '\n';
    await writeFile(path, originals[name], { mode: 0o600 });
  }
  const official = join(directory, 'results', 'dev', 'results.json');
  await mkdir(join(directory, 'results', 'dev'), { recursive: true });
  const sentinel = '{"official":"synthetic-do-not-overwrite"}\n';
  await writeFile(official, sentinel, { mode: 0o600 });
  return { directory, version, paths, originals, official, sentinel,
    args: ['--dataset', paths.dataset, '--version-file', paths.version,
      '--development-gold', paths.development, '--holdout-gold', paths.holdout] };
}

async function runCli(ctx, args, { delayMs = '0' } = {}) {
  const cliArgs = delayMs === null ? args : [`--delay-ms=${delayMs}`, ...args];
  return child(`
    import assert from 'node:assert/strict';
    import timers from 'node:timers/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const resultsFor = ${resultsFor.toString()};
    const calls = [], pauses = [];
    timers.setTimeout = async milliseconds => { pauses.push({ delay_ms: milliseconds, after_calls: calls.length }); };
    syncBuiltinESMExports();
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://provider.example.invalid/v1/chat/completions');
      const body = JSON.parse(init.body);
      const input = JSON.parse(body.messages[1].content);
      assert.deepEqual(Object.keys(input).sort(), ['checklist_version', 'conversation']);
      assert.equal(JSON.stringify(input).includes(${JSON.stringify(GOLD_ONLY)}), false);
      calls.push({ id: input.conversation.conversation_id, schema: body.response_format.json_schema.name,
        model: body.model, version: input.checklist_version });
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
        content: JSON.stringify({ results: resultsFor(input.conversation, input.checklist_version) })
      } }] }), { headers: { 'Content-Type': 'application/json' } });
    };
    console.log = () => {};
    console.table = () => {};
    const { main } = await import(${JSON.stringify(comparisonUrl)});
    let error = null;
    try { await main(${JSON.stringify(cliArgs)}); }
    catch (cause) { error = { kind: cause.kind, message: cause.message }; }
    process.stdout.write(JSON.stringify({ calls, pauses, error, exitCode: process.exitCode ?? 0 }));
  `, ctx.directory, { AI_API_KEY: API_KEY, AI_MODEL: MODEL, AI_PROMPT_VERSION: 'v2',
    AI_BASE_URL: 'https://provider.example.invalid/v1', AI_DIAGNOSTIC_DIR: join(ctx.directory, 'diagnostics'),
    AI_TIMEOUT_MS: '2000', AI_REQUEST_TIMEOUT_MS: '1000', AI_MAX_TOKENS: '512', AI_STRUCTURED_OUTPUT: 'json_schema' });
}

test('CLI requires --allow-draft and rejects unsupported or duplicate prompt selections before fetch', async t => {
  const ctx = await cliFixture(t);
  const output = join(ctx.directory, 'rejected.json');
  const refused = await runCli(ctx, [...ctx.args, '--output', output]);
  assert.equal(refused.error?.kind, 'invalid_gold');
  assert.match(refused.error.message, /не утверждён/);
  assert.deepEqual(refused.calls, []);
  await noFile(output);
  for (const prompts of ['v1', 'v1,v1', 'v1,unsupported', 'v1,../v2', 'v1,']) await t.test(prompts, async () => {
    const result = await runCli(ctx, [...ctx.args, '--allow-draft', '--prompts', prompts, '--output', output]);
    assert.equal(result.error?.kind, 'configuration');
    assert.deepEqual(result.calls, []);
    await noFile(output);
  });
});

test('CLI rejects invalid delays before calls, waits or output', async t => {
  const ctx = await cliFixture(t);
  const output = join(ctx.directory, 'invalid-delay.json');
  for (const delayMs of ['', ' ', 'NaN', 'Infinity', '-Infinity', '-1', '0.5', '60001', '1e3', '0x10'])
    await t.test(JSON.stringify(delayMs), async () => {
      const result = await runCli(ctx, [...ctx.args, '--allow-draft', '--output', output], { delayMs });
      assert.equal(result.error?.kind, 'configuration');
      assert.match(result.error.message, /--delay-ms/);
      assert.deepEqual(result.calls, []);
      assert.deepEqual(result.pauses, []);
      await noFile(output);
    });
  await noFile(join(ctx.directory, 'diagnostics'));
});

test('CLI defaults to 4000 ms, accepts 60000 ms and freezes the pacing setting', async t => {
  const ctx = await cliFixture(t);
  for (const [name, delayMs, expected] of [['default', null, 4000], ['maximum', '60000', 60000]])
    await t.test(name, async () => {
      const output = join(ctx.directory, `${name}-delay.json`);
      const result = await runCli(ctx, [...ctx.args, '--allow-draft', '--suite', 'development', '--output', output], { delayMs });
      assert.equal(result.error, null);
      assert.equal(result.exitCode, 0);
      assert.equal(result.calls.length, 18);
      assert.deepEqual(result.pauses, Array.from({ length: 17 }, (_, index) => ({ delay_ms: expected, after_calls: index + 1 })));
      const raw = await readFile(output, 'utf8');
      assertPrivate(raw);
      const report = JSON.parse(raw);
      assert.equal(report.methodology.delay_ms, expected);
      assert.equal(report.frozen.delay_ms, expected);
      assert.equal(report.status, 'completed');
    });
});

test('CLI protects every input snapshot and rejects a rubric mismatch before fetch', async t => {
  const ctx = await cliFixture(t);
  for (const path of Object.values(ctx.paths)) {
    const result = await runCli(ctx, [...ctx.args, '--allow-draft', '--output', path]);
    assert.equal(result.error?.kind, 'configuration');
    assert.deepEqual(result.calls, []);
  }
  const changedVersion = structuredClone(ctx.version);
  changedVersion.criteria[0].text = 'Другая формулировка критерия в выбранной версии.';
  const versionPath = join(ctx.directory, 'changed-version.json');
  await writeFile(versionPath, JSON.stringify(changedVersion));
  const output = join(ctx.directory, 'mismatch.json');
  const result = await runCli(ctx, [...ctx.args, '--allow-draft', '--version-file', versionPath, '--output', output]);
  assert.equal(result.error?.kind, 'invalid_gold');
  assert.deepEqual(result.calls, []);
  await noFile(output);
  for (const [name, path] of Object.entries(ctx.paths)) assert.equal(await readFile(path, 'utf8'), ctx.originals[name]);
});

test('CLI selects development, holdout or both, uses the full saved version, and writes private default reports without overwriting official results', async t => {
  for (const suite of ['development', 'holdout', 'all']) await t.test(suite, async t => {
    const ctx = await cliFixture(t);
    const result = await runCli(ctx, [...ctx.args, '--allow-draft', '--suite', suite]);
    assert.equal(result.error, null);
    assert.equal(result.exitCode, 0);
    const count = suite === 'all' ? 18 : 9;
    assert.equal(result.calls.length, count * 2);
    assert.deepEqual(result.pauses, []);
    const directory = join(ctx.directory, 'data', 'ai-results');
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const names = await readdir(directory);
    assert.equal(names.length, 1);
    assert.match(names[0], new RegExp(`^prompt-comparison-${suite}-[0-9]+\\.json$`));
    const path = join(directory, names[0]);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const raw = await readFile(path, 'utf8');
    assertPrivate(raw);
    const report = JSON.parse(raw);
    assert.equal(report.status, 'completed');
    assert.equal(report.preliminary, true);
    assert.equal(report.methodology.delay_ms, 0);
    assert.equal(report.frozen.delay_ms, 0);
    assert.deepEqual(report.prompts, ['v1', 'v2'], 'The global v2 opt-in must not replace the explicit paired prompts');
    assert.equal(report.cases.length, count);
    assert.deepEqual(Object.keys(report.suites), suite === 'all' ? ['development', 'holdout'] : [suite]);
    assert.equal(report.frozen.version_sha256.length, 64);
    assert.equal(report.frozen.source_sha256['server/prompts/evaluate-v1.txt'], V1_SHA256);
    assert.ok(report.frozen.source_sha256['server/prompts/evaluate-v2.txt']);
    assert.ok(report.frozen.source_sha256['scripts/compare-prompts.js']);
    assert.deepEqual(Object.keys(report.frozen.gold_sha256), Object.keys(report.suites));
    for (const [index, row] of report.cases.entries()) {
      const prompts = index % 2 ? ['v2', 'v1'] : ['v1', 'v2'];
      assert.deepEqual(row.prompt_order, prompts);
      assert.ok(row.conversation_id.startsWith(`synthetic-${row.suite}-`));
      for (const [offset, prompt] of prompts.entries()) {
        const call = result.calls[index * 2 + offset];
        assert.equal(call.id, row.conversation_id);
        assert.equal(call.schema, `dialogue_evaluation_${prompt}`);
        assert.equal(call.model, MODEL);
        assert.equal(call.version.id, ctx.version.id);
        assert.equal(call.version.version, ctx.version.version);
        assert.equal(call.version.rounding_digits, 2);
        assert.deepEqual(call.version.criteria, ctx.version.criteria);
        assert.equal(row.evaluations[prompt].output.prompt_version, prompt);
      }
    }
    assert.equal(await readFile(ctx.official, 'utf8'), ctx.sentinel);
    for (const [name, input] of Object.entries(ctx.paths)) assert.equal(await readFile(input, 'utf8'), ctx.originals[name]);
  });
});

test('CLI refuses official and existing output paths before any model call, pause or overwrite', async t => {
  const ctx = await cliFixture(t);
  const existing = join(ctx.directory, 'existing-report.json');
  await writeFile(existing, ctx.sentinel, { mode: 0o600 });
  const absent = [join(ctx.directory, 'nested', 'results', 'dev', 'results.json'),
    join(ctx.directory, 'results', 'prod', 'results.json')];
  for (const output of [ctx.official, ...absent, existing]) {
    const result = await runCli(ctx, [...ctx.args, '--allow-draft', '--suite', 'development', '--output', output], { delayMs: null });
    assert.equal(result.error?.kind, 'configuration', 'Official and existing outputs must fail preflight');
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.pauses, []);
  }
  assert.equal(await readFile(ctx.official, 'utf8'), ctx.sentinel);
  assert.equal(await readFile(existing, 'utf8'), ctx.sentinel);
  for (const output of absent) await noFile(output);
  await noFile(join(ctx.directory, 'diagnostics'));
});
