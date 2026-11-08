import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultConfig, validateConfig } from '../server/checklists.js';
import { prepareInput, createOutputContract } from '../server/services/ai-contract.js';
import { buildSubmission, validateSubmission } from '../server/services/submission.js';
import { loadSubmissionDataset, publicEvaluation, prepareResults, main } from '../scripts/prepare-results.js';

// Only synthetic PROD10/DEV65, temporary files and fake credentials; never load .env or private data.
const MODEL = 'synthetic/preparation-model';
const PROMPT = 'v1';
const API_KEY = 'synthetic-preparation-credential-not-a-real-key';
const AUDIO_URL = 'https://audio.example.invalid/synthetic.wav?signature=synthetic-signed-url';
const PRIVATE_TEXT = 'SYNTHETIC_TRANSCRIPT_NOT_FOR_EXPORT';

beforeEach(t => {
  const blocked = t.mock.method(globalThis, 'fetch', () => assert.fail('Unexpected fetch: real network is forbidden'));
  t.after(() => assert.equal(blocked.mock.callCount(), 0, 'Use an explicit fake fetch for CLI integration'));
});

function fixture(split = 'prod') {
  const version = { ...validateConfig(defaultConfig),
    id: '11111111-1111-4111-8111-111111111111',
    checklist_id: '22222222-2222-4222-8222-222222222222', version: 7,
    created_at: '2026-01-01T00:00:00.000Z' };
  const count = split === 'dev' ? 65 : 10;
  const records = Array.from({ length: count }, (_, index) => ({
    id: `synthetic-database-id-${index}`,
    conversation_id: `synthetic-${split}-source-${count - index}`,
    channel: split === 'dev' && index >= 60 ? 'voice call' : 'agent chat',
    language: ['RU', 'KZ', 'EN'][index % 3],
    audio_url: split === 'dev' && index >= 60 ? AUDIO_URL : null,
    transcript: [
      { speaker: 'client', text: 'Где посмотреть историю операций?' },
      { speaker: 'system', text: PRIVATE_TEXT },
      { speaker: 'bot', text: 'Запрос передан оператору.' },
      { speaker: 'operator', text: 'Здравствуйте, я Анна. Откройте «Историю». Если нужна помощь, напишите. До свидания!' }
    ].map((message, i) => ({ ...message, timestamp: `2026-01-01T10:00:0${i}Z` }))
  }));
  const payload = { isSuccess: true, data: { dataset_group_id: split.toUpperCase(), total_records: count, records } };
  return { split, version, payload, conversations: loadSubmissionDataset(payload, split) };
}

function outputFor(conversation, version, model = MODEL) {
  return { model, prompt_version: PROMPT, results: version.criteria.map(criterion => ({
    criterion_id: criterion.criterion_id,
    answer: criterion.is_gross_error ? 'no' : criterion.answer_type === 'scale' ? 'scale' : 'yes',
    raw_score: criterion.is_gross_error ? null : criterion.answer_type === 'scale'
      ? Math.max(...criterion.scale.map(step => step.value)) : 1,
    explanation: `Критерий ${criterion.criterion_id} проверен по исходным репликам оператора.`,
    evidence_message_nos: criterion.is_gross_error ? [] : [conversation.transcript.length],
    checked_range: criterion.is_gross_error ? { from: 1, to: conversation.transcript.length } : null,
    na_reason: null
  })) };
}

function change(output, id, fields) {
  const result = output.results.find(result => result.criterion_id === id);
  assert.ok(result, `Missing synthetic criterion ${id}`);
  Object.assign(result, fields);
}

function factory(ctx, handler = (conversation, version, onAttempt) => {
  onAttempt({ attempt: 1, status: 'valid', validation_errors: [], elapsed_ms: 1,
    diagnostic_id: conversation.conversation_id });
  return outputFor(conversation, version);
}) {
  return onAttempt => {
    ctx.factoryCalls++;
    return async (conversation, version, runtime) => {
      ctx.calls.push(conversation.conversation_id);
      assert.ok(runtime.signal instanceof AbortSignal);
      return handler(conversation, version, onAttempt, runtime);
    };
  };
}

async function setup(t, split = 'prod') {
  const directory = await mkdtemp(join(tmpdir(), 'cqa-prepare-results-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = fixture(split);
  const ctx = { ...input, directory, calls: [], factoryCalls: 0 };
  ctx.options = { conversations: input.conversations, version: input.version, split,
    journalPath: join(directory, 'preparation.json'), modelName: MODEL, promptVersion: PROMPT,
    fingerprint: { implementation: 'synthetic-source-snapshot', base_url: 'https://api.example.invalid/v1',
      structured_output: 'json_schema', max_tokens: '4096', provider: null, reasoning_effort: null },
    timeoutMs: 2000, concurrency: 1, delayMs: 0, apiKey: API_KEY };
  ctx.options.evaluateFactory = factory(ctx);
  return ctx;
}

const ids = conversations => conversations.map(conversation => conversation.conversation_id);
const journalAt = async ctx => JSON.parse(await readFile(ctx.options.journalPath, 'utf8'));
const noLock = ctx => assert.rejects(stat(`${ctx.options.journalPath}.lock`), { code: 'ENOENT' });
const noFile = path => assert.rejects(stat(path), { code: 'ENOENT' });
const rejectFactory = () => assert.fail('Preflight/export/resume must not create an evaluator');

function official(input, entries) {
  return buildSubmission({ teamName: 'Синтетическая команда', modelName: MODEL,
    conversations: input.conversations, version: input.version, split: input.split,
    evaluations: entries.map(publicEvaluation) });
}

function assertSafe(raw) {
  for (const forbidden of [API_KEY, AUDIO_URL, 'synthetic-signed-url', PRIVATE_TEXT, 'provider-private-response']) {
    assert.ok(!raw.includes(forbidden), `Must not leak ${forbidden}`);
  }
}

test('loadSubmissionDataset accepts full synthetic PROD10/DEV65 envelopes without replacing source IDs or mutating inputs', () => {
  for (const split of ['prod', 'dev']) {
    const input = fixture(split);
    const before = structuredClone(input.payload);
    for (const payload of [input.payload, input.payload.data.records, { records: input.payload.data.records }]) {
      const conversations = loadSubmissionDataset(payload, split);
      assert.equal(conversations.length, split === 'dev' ? 65 : 10);
      assert.deepEqual(ids(conversations), ids(input.payload.data.records));
      assert.equal(conversations.filter(c => c.channel === 'voice call').length, split === 'dev' ? 5 : 0);
      for (const conversation of conversations) {
        assert.notEqual(conversation.conversation_id, conversation.id);
        assert.deepEqual(conversation.transcript.map(m => m.message_no), [1, 2, 3, 4]);
      }
      if (split === 'dev') assert.equal(conversations.at(-1).audio_url, AUDIO_URL);
    }
    assert.deepEqual(input.payload, before);
  }
});

test('loadSubmissionDataset rejects incomplete, mixed, unsuccessful and malformed datasets', async t => {
  const cases = [
    ['PROD missing row', 'prod', f => f.payload.data.records.pop()],
    ['PROD extra row', 'prod', f => f.payload.data.records.push(structuredClone(f.payload.data.records[0]))],
    ['DEV missing row', 'dev', f => f.payload.data.records.pop()],
    ['duplicate source ID', 'prod', f => { f.payload.data.records[1].conversation_id = f.payload.data.records[0].conversation_id; }],
    ['missing source ID, even with database ID', 'prod', f => { delete f.payload.data.records[0].conversation_id; }],
    ['blank source ID', 'prod', f => { f.payload.data.records[0].conversation_id = ' '; }],
    ['PROD voice call', 'prod', f => { f.payload.data.records[0].channel = 'voice call'; }],
    ['DEV four calls', 'dev', f => { f.payload.data.records[60].channel = 'agent chat'; }],
    ['DEV six calls', 'dev', f => { f.payload.data.records[59].channel = 'voice call'; }],
    ['unknown channel', 'prod', f => { f.payload.data.records[0].channel = 'chat'; }],
    ['unknown language', 'prod', f => { f.payload.data.records[0].language = 'DE'; }],
    ['empty transcript', 'prod', f => { f.payload.data.records[0].transcript = []; }],
    ['missing timestamp', 'prod', f => { delete f.payload.data.records[0].transcript[0].timestamp; }],
    ['unknown speaker', 'prod', f => { f.payload.data.records[0].transcript[0].speaker = 'assistant'; }],
    ['non-1-based message number', 'prod', f => { f.payload.data.records[0].transcript[0].message_no = 0; }],
    ['isSuccess false', 'prod', f => { f.payload.isSuccess = false; }],
    ['isSuccess not boolean', 'prod', f => { f.payload.isSuccess = 'true'; }],
    ['mismatched total_records', 'prod', f => { f.payload.data.total_records = 65; }],
    ['string total_records', 'prod', f => { f.payload.data.total_records = '10'; }],
    ['DEV metadata for PROD', 'prod', f => { f.payload.data.dataset_group_id = 'DEV'; }],
    ['PROD metadata for DEV', 'dev', f => { f.payload.data.dataset_group_id = 'PROD'; }],
    ['unknown split', 'prod', f => { f.split = 'test'; }],
    ['missing records', 'prod', f => { delete f.payload.data.records; }]
  ];
  for (const [label, split, mutate] of cases) await t.test(label, () => {
    const input = fixture(split);
    mutate(input);
    assert.throws(() => loadSubmissionDataset(input.payload, input.split), { kind: 'invalid_input' });
  });
  assert.throws(() => loadSubmissionDataset(null, 'prod'), { kind: 'invalid_input' });
});

test('synthetic model defaults satisfy the real strict AI contract, including c8 no/null/range', () => {
  for (const split of ['prod', 'dev']) {
    const { conversations, version } = fixture(split);
    for (const conversation of [conversations[0], conversations.at(-1)]) {
      const output = outputFor(conversation, version);
      assert.deepEqual(Object.keys(output).sort(), ['model', 'prompt_version', 'results']);
      const parsed = createOutputContract(prepareInput(conversation, version)).parse(JSON.stringify({ results: output.results }));
      assert.deepEqual(parsed.errors, []);
      assert.deepEqual(parsed.results, output.results);
      assert.equal(output.results[7].raw_score, null);
      assert.deepEqual(output.results[7].checked_range, { from: 1, to: 4 });
    }
  }
});

test('publicEvaluation exposes only the exclusive public success/error shape', () => {
  const { conversations, version } = fixture();
  const output = outputFor(conversations[0], version);
  for (const status of ['ok', 'error']) {
    const entry = { conversation_id: conversations[0].conversation_id, status, output,
      error: 'Сетевая ошибка при обращении к модели.', error_kind: 'network',
      attempts: [{ raw_response: 'provider-private-response' }], latency_ms: 42,
      finished_at: '2026-01-01T00:00:00.000Z', transcript: PRIVATE_TEXT, audio_url: AUDIO_URL };
    const before = structuredClone(entry);
    assert.deepEqual(publicEvaluation(entry), status === 'ok'
      ? { conversation_id: entry.conversation_id, status: 'ok', output }
      : { conversation_id: entry.conversation_id, status: 'error', error: entry.error });
    assert.deepEqual(entry, before);
    assertSafe(JSON.stringify(publicEvaluation(entry)));
  }
});

test('maxNew checkpoints every completion privately, resumes only pending IDs and never calls a model after completion', async t => {
  const ctx = await setup(t);
  const inputBefore = structuredClone({ conversations: ctx.conversations, version: ctx.version });
  const progress = [];
  const onProgress = row => {
    progress.push(row);
    const checkpoint = JSON.parse(readFileSync(ctx.options.journalPath, 'utf8'));
    assert.equal(checkpoint.entries.length, row.completed);
    assert.equal(checkpoint.entries.find(entry => entry.conversation_id === row.conversation_id).status, row.status);
    if (process.platform !== 'win32') assert.equal(statSync(ctx.options.journalPath).mode & 0o777, 0o600);
    if (process.platform !== 'win32') assert.equal(statSync(`${ctx.options.journalPath}.lock`).mode & 0o777, 0o600);
    assert.equal(row.total, 10);
    assert.equal(row.attempts, 1);
    assert.ok(Number.isFinite(row.latency_ms) && row.latency_ms >= 0);
  };
  const first = await prepareResults({ ...ctx.options, maxNew: 2, onProgress });
  assert.deepEqual([first.completed, first.pending, first.ok, first.errors], [2, 8, 2, 0]);
  assert.deepEqual(ctx.calls, ids(ctx.conversations.slice(0, 2)));
  const firstEntries = structuredClone(first.entries);
  const checkpoint = await journalAt(ctx);
  assert.equal(checkpoint.schema_version, 'preparation-1.0');
  assert.deepEqual(checkpoint.checklist_version, ctx.version);
  assert.deepEqual(checkpoint.contract.fingerprint, ctx.options.fingerprint);
  assert.equal(checkpoint.contract.split, 'prod');
  assert.equal(checkpoint.contract.model, MODEL);
  assert.equal(checkpoint.contract.prompt_version, PROMPT);
  assert.match(checkpoint.contract.dataset_sha256, /^[a-f0-9]{64}$/);
  assert.match(checkpoint.contract.version_sha256, /^[a-f0-9]{64}$/);
  assertSafe(await readFile(ctx.options.journalPath, 'utf8'));
  await noLock(ctx);

  const second = await prepareResults({ ...ctx.options, maxNew: 3, onProgress });
  assert.deepEqual([second.completed, second.pending, second.ok, second.errors], [5, 5, 5, 0]);
  assert.deepEqual(second.entries.slice(0, 2), firstEntries);
  const complete = await prepareResults({ ...ctx.options, onProgress });
  assert.deepEqual([complete.completed, complete.pending, complete.ok, complete.errors], [10, 0, 10, 0]);
  assert.deepEqual(ctx.calls, ids(ctx.conversations));
  assert.equal(ctx.factoryCalls, 10);
  assert.deepEqual(progress.map(row => row.completed), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(complete.entries, (await journalAt(ctx)).entries);
  assert.deepEqual({ conversations: ctx.conversations, version: ctx.version }, inputBefore);
  for (const flags of [{}, { retryErrors: true }, { exportOnly: true }]) {
    const resumed = await prepareResults({ ...ctx.options, ...flags, evaluateFactory: rejectFactory });
    assert.deepEqual(resumed.entries, complete.entries);
    assert.equal(resumed.pending, 0);
  }
  assert.equal(ctx.calls.length, 10);
  validateSubmission(official(ctx, complete.entries), ctx);
  await noLock(ctx);
});

test('a complete synthetic DEV run keeps all 60 chats and five calls, with original source order', async t => {
  const ctx = await setup(t, 'dev');
  const prepared = await prepareResults({ ...ctx.options, concurrency: 3 });
  assert.deepEqual([prepared.completed, prepared.pending, prepared.ok, prepared.errors], [65, 0, 65, 0]);
  assert.equal(ctx.calls.length, 65);
  assert.equal(new Set(ctx.calls).size, 65);
  assert.deepEqual(ids(prepared.entries), ids(ctx.conversations));
  const document = official(ctx, prepared.entries);
  assert.equal(document.results.length, 65);
  assertSafe(JSON.stringify(document));
  await noLock(ctx);
});

test('concurrency 1..3 bounds active evaluations and preserves input order despite out-of-order completion', async t => {
  for (const concurrency of [1, 2, 3]) await t.test(`concurrency=${concurrency}`, async t => {
    const ctx = await setup(t);
    const releaseFirst = Promise.withResolvers();
    let active = 0, peak = 0;
    const finished = [];
    const evaluateFactory = factory(ctx, async (conversation, version, onAttempt) => {
      const index = ctx.conversations.indexOf(conversation);
      active++;
      peak = Math.max(peak, active);
      try {
        if (index === 0 && concurrency > 1) await releaseFirst.promise;
        else await delay(1);
        onAttempt({ attempt: 1, status: 'valid', validation_errors: [], diagnostic_id: conversation.conversation_id });
        finished.push(conversation.conversation_id);
        if (index === concurrency - 1) releaseFirst.resolve();
        return outputFor(conversation, version);
      } finally { active--; }
    });
    const prepared = await prepareResults({ ...ctx.options, concurrency, evaluateFactory });
    assert.equal(peak, concurrency);
    assert.equal(active, 0);
    assert.equal(new Set(ctx.calls).size, 10);
    if (concurrency > 1) assert.notEqual(finished[0], ctx.conversations[0].conversation_id);
    assert.deepEqual(ids(prepared.entries), ids(ctx.conversations));
    assert.deepEqual(ids((await journalAt(ctx)).entries), ids(ctx.conversations));
    assert.deepEqual(ids(official(ctx, prepared.entries).results), ids(ctx.conversations));
  });
});

test('attempt observers are isolated even for a shared evaluator and snapshot mutable event data', async t => {
  const ctx = await setup(t);
  let observer;
  const expected = new Map();
  const shared = async (conversation, version) => {
    const index = ctx.conversations.indexOf(conversation);
    ctx.calls.push(conversation.conversation_id);
    const event = { attempt: 1, status: 'invalid', elapsed_ms: 2,
      validation_errors: [`Синтетическая проверка ${conversation.conversation_id}`],
      diagnostic_id: `${conversation.conversation_id}-1`, raw_response: 'provider-private-response',
      audio_url: AUDIO_URL, authorization: API_KEY };
    observer(event);
    const first = { attempt: 1, status: 'invalid', elapsed_ms: 2,
      validation_errors: [...event.validation_errors], diagnostic_id: event.diagnostic_id };
    event.validation_errors.push('Не должно попасть в сохранённый snapshot.');
    await delay((index % 3) + 1);
    observer({ attempt: 2, status: 'valid', validation_errors: [], elapsed_ms: 3,
      diagnostic_id: `${conversation.conversation_id}-2` });
    expected.set(conversation.conversation_id, [first,
      { attempt: 2, status: 'valid', validation_errors: [], elapsed_ms: 3,
        diagnostic_id: `${conversation.conversation_id}-2` }]);
    return outputFor(conversation, version);
  };
  const prepared = await prepareResults({ ...ctx.options, concurrency: 3,
    evaluateFactory: onAttempt => { observer ??= onAttempt; return shared; } });
  for (const entry of prepared.entries) assert.deepEqual(entry.attempts, expected.get(entry.conversation_id));
  assertSafe(await readFile(ctx.options.journalPath, 'utf8'));
});

test('a timeout records an error, aborts the evaluator and ignores its late attempts/output', async t => {
  const ctx = await setup(t);
  const release = Promise.withResolvers(), lateDone = Promise.withResolvers();
  let signal;
  const evaluateFactory = factory(ctx, async (conversation, version, onAttempt, runtime) => {
    signal = runtime.signal;
    onAttempt({ attempt: 1, status: 'started', validation_errors: [] });
    await release.promise;
    onAttempt({ attempt: 2, status: 'valid', validation_errors: [], diagnostic_id: 'late-attempt' });
    lateDone.resolve();
    return outputFor(conversation, version);
  });
  t.after(() => release.resolve());
  const prepared = await prepareResults({ ...ctx.options, evaluateFactory, timeoutMs: 20, maxNew: 1 });
  assert.equal(signal.aborted, true);
  assert.deepEqual([prepared.ok, prepared.errors, prepared.pending], [0, 1, 9]);
  assert.equal(prepared.entries[0].error_kind, 'timeout');
  assert.equal(prepared.entries[0].attempts.length, 1);
  assert.equal(Object.hasOwn(prepared.entries[0], 'output'), false);
  const before = await readFile(ctx.options.journalPath, 'utf8');
  release.resolve();
  await lateDone.promise;
  await delay(0);
  assert.equal(prepared.entries[0].attempts.length, 1);
  assert.equal(await readFile(ctx.options.journalPath, 'utf8'), before);
  await noLock(ctx);
});

test('errors stay sanitized and terminal by default; retryErrors retries only errors, leaving every ok entry unchanged', async t => {
  const ctx = await setup(t);
  const failed = [1, 5, 7];
  const evaluateFactory = factory(ctx, (conversation, version, onAttempt) => {
    const index = ctx.conversations.indexOf(conversation);
    if (!failed.includes(index)) return outputFor(conversation, version);
    const invalid = index === 5;
    onAttempt({ attempt: 1, status: invalid ? 'invalid' : index === 1 ? 'network_error' : 'http_error',
      validation_errors: invalid ? ['Синтетическая ошибка схемы.'] : [], diagnostic_id: 'https://invalid.example.invalid/unsafe' });
    if (invalid) onAttempt({ attempt: 2, status: 'invalid', validation_errors: ['Синтетическая ошибка схемы.'] });
    throw Object.assign(new Error(`provider-private-response ${API_KEY} ${AUDIO_URL} ${PRIVATE_TEXT}`),
      index === 1 ? { code: 'ECONNRESET' } : invalid ? { code: 'AI_INVALID_RESPONSE', status: 502 } : { status: 429 });
  });
  const prepared = await prepareResults({ ...ctx.options, concurrency: 3, evaluateFactory });
  assert.deepEqual([prepared.completed, prepared.pending, prepared.ok, prepared.errors], [10, 0, 7, 3]);
  assert.equal(ctx.calls.length, 10, 'Network/HTTP failures must not be retried within this run');
  for (const [index, kind] of [[1, 'network'], [5, 'invalid_output'], [7, 'http_error']]) {
    const entry = prepared.entries[index];
    assert.equal(entry.status, 'error');
    assert.equal(entry.error_kind, kind);
    assert.ok(entry.error.trim());
    assert.ok(!/https?:\/\//i.test(entry.error));
    for (const key of ['output', 'results', 'score']) assert.equal(Object.hasOwn(entry, key), false);
    assert.equal(entry.attempts[0].diagnostic_id, null);
    assert.equal(entry.attempts.length, index === 5 ? 2 : 1);
  }
  assertSafe(await readFile(ctx.options.journalPath, 'utf8'));
  const document = official(ctx, prepared.entries);
  for (const index of failed) assert.deepEqual(document.results[index], {
    conversation_id: ctx.conversations[index].conversation_id, status: 'error', criteria: [], score: null,
    error: prepared.entries[index].error
  });
  assertSafe(JSON.stringify(document));
  const retained = await prepareResults({ ...ctx.options, evaluateFactory: rejectFactory });
  assert.deepEqual(retained.entries, prepared.entries);
  const before = structuredClone(prepared.entries);
  ctx.calls.length = 0;
  const retried = await prepareResults({ ...ctx.options, retryErrors: true, evaluateFactory: factory(ctx) });
  assert.deepEqual(ctx.calls, failed.map(index => ctx.conversations[index].conversation_id));
  assert.deepEqual([retried.completed, retried.pending, retried.ok, retried.errors], [10, 0, 10, 0]);
  for (const [index, entry] of retried.entries.entries()) {
    if (failed.includes(index)) {
      assert.equal(entry.status, 'ok');
      assert.equal(Object.hasOwn(entry, 'error'), false);
      assert.equal(entry.attempts.length, 1);
    } else assert.deepEqual(entry, before[index]);
  }
});

test('valid no answers, partial scales and N/A are retained exactly, not filled in or rescored by preparation', async t => {
  const ctx = await setup(t);
  const output = outputFor(ctx.conversations[0], ctx.version);
  change(output, 'c1', { answer: 'no', raw_score: 0, checked_range: { from: 1, to: 4 } });
  change(output, 'c2', { answer: 'na', raw_score: null, na_reason: 'Данных для ответа хватало с самого начала.' });
  change(output, 'c4', { raw_score: 10, checked_range: { from: 1, to: 4 } });
  change(output, 'c6', { raw_score: 4, checked_range: { from: 1, to: 4 } });
  const prepared = await prepareResults({ ...ctx.options, maxNew: 1, evaluateFactory: factory(ctx, () => output) });
  assert.deepEqual([prepared.ok, prepared.errors], [1, 0]);
  assert.deepEqual(prepared.entries[0].output, output);
  assert.deepEqual((await journalAt(ctx)).entries[0].output, output);
});

test('malformed model outputs become errors, never invented successful evaluations', async t => {
  const cases = [
    ['missing model', o => { delete o.model; }],
    ['different model', o => { o.model = 'synthetic/different-model'; }],
    ['different prompt', o => { o.prompt_version = 'v2'; }],
    ['extra metadata', o => { o.raw_response = 'provider-private-response'; }],
    ['missing results', o => { delete o.results; }],
    ['only seven criteria', o => { o.results.pop(); }],
    ['duplicate criterion', o => { o.results[1] = structuredClone(o.results[0]); }],
    ['unknown criterion', o => { o.results[0].criterion_id = 'unknown'; }],
    ['no without range', o => change(o, 'c1', { answer: 'no', raw_score: 0 })],
    ['partial scale without range', o => change(o, 'c4', { raw_score: 10 })],
    ['c8 no without range', o => change(o, 'c8', { checked_range: null })],
    ['c8 numeric score', o => change(o, 'c8', { raw_score: 0 })],
    ['invalid scale step', o => change(o, 'c6', { raw_score: 9 })],
    ['out-of-bounds evidence', o => change(o, 'c1', { evidence_message_nos: [5] })],
    ['zero-based evidence', o => change(o, 'c1', { evidence_message_nos: [0] })],
    ['duplicate evidence', o => change(o, 'c1', { evidence_message_nos: [4, 4] })],
    ['reversed range', o => change(o, 'c8', { checked_range: { from: 4, to: 1 } })],
    ['extra result field', o => change(o, 'c1', { evidence_quotes: ['Не входит в контракт.'] })],
    ['missing required result field', o => { delete o.results[0].na_reason; }],
    ['N/A not allowed', o => change(o, 'c1', { answer: 'na', raw_score: null, na_reason: 'Синтетическая причина.' })],
    ['N/A without reason', o => change(o, 'c2', { answer: 'na', raw_score: null })],
    ['non-Russian explanation', o => change(o, 'c1', { explanation: 'English only.' })]
  ];
  for (const [label, mutate] of cases) await t.test(label, async t => {
    const ctx = await setup(t);
    const output = outputFor(ctx.conversations[0], ctx.version);
    mutate(output);
    const prepared = await prepareResults({ ...ctx.options, maxNew: 1, evaluateFactory: factory(ctx, () => output) });
    assert.deepEqual([prepared.completed, prepared.pending, prepared.ok, prepared.errors], [1, 9, 0, 1]);
    assert.equal(ctx.calls.length, 1);
    assert.equal(prepared.entries[0].error_kind, 'invalid_output');
    assert.equal(Object.hasOwn(prepared.entries[0], 'output'), false);
    assert.deepEqual(publicEvaluation(prepared.entries[0]), {
      conversation_id: ctx.conversations[0].conversation_id, status: 'error', error: prepared.entries[0].error
    });
    assert.deepEqual((await journalAt(ctx)).entries, prepared.entries);
    await noLock(ctx);
  });
});

test('resume rejects input, version, model, prompt and fingerprint changes before any evaluator is created', async t => {
  const ctx = await setup(t);
  await prepareResults({ ...ctx.options, maxNew: 2 });
  const before = await readFile(ctx.options.journalPath, 'utf8');
  const cases = [
    ['source text', o => { o.conversations[0].transcript[0].text = 'Другой синтетический вопрос.'; }],
    ['source ID', o => { o.conversations[0].conversation_id = 'synthetic-replacement-id'; }],
    ['source order', o => { o.conversations.reverse(); }],
    ['source language', o => { o.conversations[0].language = 'EN'; }],
    ['source URL', o => { o.conversations[0].audio_url = AUDIO_URL; }],
    ['saved full version ID', o => { o.version.id = '33333333-3333-4333-8333-333333333333'; }],
    ['saved version revision', o => { o.version.version++; }],
    ['version metadata', o => { o.version.created_at = '2026-02-01T00:00:00.000Z'; }],
    ['rubric text', o => { o.version.criteria[0].text += ' Изменение.'; }],
    ['model', o => { o.modelName = 'synthetic/replacement-model'; }],
    ['prompt', o => { o.promptVersion = 'v2'; }],
    ['implementation fingerprint', o => { o.fingerprint.implementation = 'different-source-snapshot'; }],
    ['provider fingerprint', o => { o.fingerprint.provider = 'synthetic-provider'; }],
    ['request settings', o => { o.fingerprint.max_tokens = '8192'; }]
  ];
  for (const [label, mutate] of cases) await t.test(label, async () => {
    const options = { ...ctx.options, conversations: structuredClone(ctx.conversations),
      version: structuredClone(ctx.version), fingerprint: structuredClone(ctx.options.fingerprint),
      evaluateFactory: rejectFactory };
    mutate(options);
    await assert.rejects(prepareResults(options), error => {
      assert.ok(error.kind === 'contract_changed' || error.status === 400);
      return true;
    });
    assert.equal(await readFile(ctx.options.journalPath, 'utf8'), before);
    assert.equal(ctx.factoryCalls, 2);
    await noLock(ctx);
  });
});

test('invalid journals are rejected without rewriting or making model calls', async t => {
  const ctx = await setup(t);
  await prepareResults({ ...ctx.options, maxNew: 2 });
  const baseline = await journalAt(ctx);
  const cases = [
    ['malformed JSON', () => '{broken'],
    ['JSON null', () => 'null'],
    ['JSON false', () => 'false'],
    ['JSON zero', () => '0'],
    ['JSON empty string', () => '""'],
    ['JSON array', () => '[]'],
    ['missing schema', j => { delete j.schema_version; }],
    ['unknown schema', j => { j.schema_version = 'preparation-999'; }],
    ['missing contract', j => { delete j.contract; }],
    ['altered saved full version', j => { j.checklist_version.version++; }],
    ['entries not an array', j => { j.entries = {}; }],
    ['null entry', j => { j.entries[0] = null; }],
    ['unknown source ID', j => { j.entries[0].conversation_id = 'unknown-synthetic-source'; }],
    ['duplicate source ID', j => { j.entries.push(structuredClone(j.entries[0])); }],
    ['unknown status', j => { j.entries[0].status = 'pending'; }],
    ['missing successful output', j => { delete j.entries[0].output; }],
    ['corrupt successful model', j => { j.entries[0].output.model = 'synthetic/wrong-model'; }],
    ['corrupt successful prompt', j => { j.entries[0].output.prompt_version = 'v2'; }],
    ['corrupt successful criteria', j => { j.entries[0].output.results.pop(); }],
    ['corrupt successful checked_range', j => { j.entries[0].output.results[7].checked_range = null; }],
    ['error is not a string', j => { j.entries[0] = { conversation_id: j.entries[0].conversation_id, status: 'error', error: {} }; }],
    ['empty error reason', j => { j.entries[0] = { conversation_id: j.entries[0].conversation_id, status: 'error', error: ' ' }; }],
    ['unsafe error URL', j => { j.entries[0] = { conversation_id: j.entries[0].conversation_id, status: 'error', error: `Provider failed: ${AUDIO_URL}` }; }]
  ];
  for (const [label, corrupt] of cases) await t.test(label, async () => {
    const broken = structuredClone(baseline);
    const raw = corrupt(broken) ?? JSON.stringify(broken);
    await writeFile(ctx.options.journalPath, raw, { mode: 0o600 });
    let factories = 0, caught;
    try {
      await prepareResults({ ...ctx.options, maxNew: 1, evaluateFactory: onAttempt => {
        factories++;
        return async (conversation, version) => {
          onAttempt({ attempt: 1, status: 'valid' });
          return outputFor(conversation, version);
        };
      } });
    } catch (error) { caught = error; }
    assert.equal(factories, 0, 'A corrupt journal must be rejected before creating an evaluator');
    assert.ok(caught, 'A corrupt journal must not be silently accepted or replaced');
    assert.ok(['invalid_input', 'contract_changed', 'invalid_output'].includes(caught.kind));
    assert.equal(await readFile(ctx.options.journalPath, 'utf8'), raw, 'Never overwrite corrupt journal evidence');
    await noLock(ctx);
  });
});

test('private journal rejects an echoed API key without committing the output, and releases its lock', async t => {
  const ctx = await setup(t);
  const evaluateFactory = factory(ctx, (conversation, version) => {
    const output = outputFor(conversation, version);
    change(output, 'c1', { explanation: `Синтетическая случайная утечка: ${API_KEY}` });
    return output;
  });
  await assert.rejects(prepareResults({ ...ctx.options, maxNew: 1, evaluateFactory }), { kind: 'invalid_output' });
  assertSafe(await readFile(ctx.options.journalPath, 'utf8'));
  assert.deepEqual((await journalAt(ctx)).entries, []);
  if (process.platform !== 'win32') assert.equal((await stat(ctx.options.journalPath)).mode & 0o777, 0o600);
  await noLock(ctx);
  const resumed = await prepareResults({ ...ctx.options, maxNew: 1 });
  assert.deepEqual([resumed.completed, resumed.ok, resumed.errors], [1, 1, 0]);
});

test('attempt validation errors mask signed URLs before they reach the journal', async t => {
  const ctx = await setup(t);
  const prepared = await prepareResults({ ...ctx.options, maxNew: 1,
    evaluateFactory: factory(ctx, (conversation, version, onAttempt) => {
      onAttempt({ attempt: 1, status: 'invalid', validation_errors: [`Ошибка проверки ${AUDIO_URL}`] });
      throw Object.assign(new Error('provider-private-response'), { code: 'AI_INVALID_RESPONSE' });
    }) });
  assert.equal(prepared.entries[0].status, 'error');
  assert.ok(!/https?:\/\//i.test(prepared.entries[0].error));
  assertSafe(await readFile(ctx.options.journalPath, 'utf8'));
});

test('an exclusive lock prevents simultaneous runs without disturbing the active run', { timeout: 5000 }, async t => {
  const ctx = await setup(t);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  const running = prepareResults({ ...ctx.options, maxNew: 1,
    evaluateFactory: factory(ctx, async (conversation, version) => {
      entered.resolve();
      await release.promise;
      return outputFor(conversation, version);
    }) });
  const checkedRun = assert.doesNotReject(running);
  try {
    await entered.promise;
    if (process.platform !== 'win32') assert.equal((await stat(`${ctx.options.journalPath}.lock`)).mode & 0o777, 0o600);
    const before = await readFile(ctx.options.journalPath, 'utf8');
    await assert.rejects(prepareResults({ ...ctx.options, evaluateFactory: rejectFactory }), { kind: 'filesystem' });
    assert.equal(await readFile(ctx.options.journalPath, 'utf8'), before);
    assert.equal(ctx.calls.length, 1);
  } finally { release.resolve(); await checkedRun; }
  await noLock(ctx);
  const resumed = await prepareResults({ ...ctx.options, maxNew: 1 });
  assert.equal(resumed.completed, 2);
});

test('worker failure holds the lock until other active workers settle, then releases it for resume', { timeout: 5000 }, async t => {
  const ctx = await setup(t);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const failure = new Error('Synthetic evaluator factory failure');
  let factories = 0;
  t.after(() => release.resolve());
  const running = prepareResults({ ...ctx.options, concurrency: 2, maxNew: 2,
    evaluateFactory: () => {
      if (++factories === 1) throw failure;
      return async (conversation, version) => {
        entered.resolve();
        await release.promise;
        return outputFor(conversation, version);
      };
    } });
  const checkedFailure = assert.rejects(running, error => error === failure);
  try {
    await entered.promise;
    await assert.rejects(prepareResults({ ...ctx.options, evaluateFactory: rejectFactory }), { kind: 'filesystem' });
    if (process.platform !== 'win32') assert.equal((await stat(`${ctx.options.journalPath}.lock`)).mode & 0o777, 0o600);
  } finally { release.resolve(); await checkedFailure; }
  await noLock(ctx);
  assert.deepEqual(ids((await journalAt(ctx)).entries), [ctx.conversations[1].conversation_id]);
  const resumed = await prepareResults({ ...ctx.options, maxNew: 1 });
  assert.deepEqual(ids(resumed.entries), ids(ctx.conversations.slice(0, 2)));
  await noLock(ctx);
});

test('invalid batch limits fail before evaluating or creating a journal', async t => {
  const ctx = await setup(t);
  for (const [name, values] of [
    ['concurrency', [0, -1, 1.5, 4, '2', NaN]],
    ['delayMs', [-1, 0.5, 60001, '0', NaN]],
    ['maxNew', [0, -1, 1.5, '1', NaN]]
  ]) for (const value of values) await t.test(`${name}=${String(value)}`, async () => {
    await assert.rejects(prepareResults({ ...ctx.options, [name]: value, evaluateFactory: rejectFactory }), { kind: 'configuration' });
    await noFile(ctx.options.journalPath);
    await noLock(ctx);
  });
});

test('exportOnly needs an existing journal and never evaluates pending or failed rows', async t => {
  const ctx = await setup(t);
  await assert.rejects(prepareResults({ ...ctx.options, exportOnly: true, evaluateFactory: rejectFactory }), { kind: 'configuration' });
  await noFile(ctx.options.journalPath);
  await noLock(ctx);
  await prepareResults({ ...ctx.options, maxNew: 1,
    evaluateFactory: factory(ctx, () => { throw new Error('Synthetic network failure'); }) });
  const before = (await journalAt(ctx)).entries;
  const exported = await prepareResults({ ...ctx.options, exportOnly: true, retryErrors: true, evaluateFactory: rejectFactory });
  assert.deepEqual([exported.completed, exported.pending, exported.ok, exported.errors], [1, 9, 0, 1]);
  assert.deepEqual(exported.entries, before);
  assert.equal(ctx.calls.length, 1);
});

async function cliSetup(t) {
  const ctx = await setup(t);
  const savedEnv = process.env, savedExitCode = process.exitCode;
  // Replace rather than inherit AI_*: no local key, provider, diagnostics path or TEAM_NAME can affect these tests.
  process.env = { AI_MODEL: MODEL, AI_API_KEY: API_KEY, AI_BASE_URL: 'https://api.example.invalid/v1',
    AI_TIMEOUT_MS: '2000', AI_REQUEST_TIMEOUT_MS: '1000', AI_MAX_TOKENS: '4096',
    AI_STRUCTURED_OUTPUT: 'json_schema', AI_DIAGNOSTIC_DIR: join(ctx.directory, 'diagnostics') };
  process.exitCode = 0;
  t.after(() => { process.env = savedEnv; process.exitCode = savedExitCode; });
  ctx.logs = [];
  t.mock.method(console, 'log', (...values) => ctx.logs.push(values.join(' ')));
  ctx.datasetPath = join(ctx.directory, 'synthetic-prod.json');
  ctx.versionPath = join(ctx.directory, 'full-version.json');
  ctx.outputPath = join(ctx.directory, 'official.json');
  await writeFile(ctx.datasetPath, JSON.stringify(ctx.payload), { mode: 0o600 });
  await writeFile(ctx.versionPath, JSON.stringify(ctx.version), { mode: 0o600 });
  ctx.args = ['--split', 'prod', '--dataset', ctx.datasetPath, '--version-file', ctx.versionPath,
    '--journal', ctx.options.journalPath, '--output', ctx.outputPath, '--delay-ms', '0'];
  return ctx;
}

test('main --help and missing-team preflight work offline with a supplied full version and synthetic dataset', async t => {
  const ctx = await cliSetup(t);
  delete process.env.AI_API_KEY;
  await main(['--help']);
  assert.match(ctx.logs.join('\n'), /--prepare-only/);
  assert.match(ctx.logs.join('\n'), /--export-only/);
  assert.match(ctx.logs.join('\n'), /--validate-only/);
  await assert.rejects(main(ctx.args), error => {
    assert.match(error.message, /--team.*TEAM_NAME/);
    return true;
  });
  await noFile(ctx.outputPath);
  await noFile(ctx.options.journalPath);
});

test('main prepare-only needs no team; partial runs never export; completed export-only needs no API key or model calls', async t => {
  const ctx = await cliSetup(t);
  const requests = [];
  const fakeFetch = t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(String(url), 'https://api.example.invalid/v1/chat/completions');
    assert.equal(init.headers.Authorization, `Bearer ${API_KEY}`);
    const body = JSON.parse(init.body);
    const input = JSON.parse(body.messages.find(message => message.role === 'user').content);
    requests.push(input.conversation.conversation_id);
    if (requests.length === 2) throw new TypeError(`fetch failed: ${API_KEY} ${AUDIO_URL} provider-private-response`);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
      message: { content: JSON.stringify({ results: outputFor(input.conversation, ctx.version).results }) } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const datasetBefore = await readFile(ctx.datasetPath, 'utf8');
  const versionBefore = await readFile(ctx.versionPath, 'utf8');
  await main([...ctx.args, '--prepare-only', '--max-new', '2']);
  assert.equal(requests.length, 2, 'A network error must not get an implicit repair/retry');
  assert.equal((await journalAt(ctx)).entries.length, 2);
  assert.equal(process.exitCode, 0);
  await noFile(ctx.outputPath);

  await main([...ctx.args, '--team', 'Синтетическая команда', '--export-only']);
  assert.equal(requests.length, 2);
  assert.equal(process.exitCode, 2);
  await noFile(ctx.outputPath);
  process.exitCode = 0;
  await main([...ctx.args, '--team', 'Синтетическая команда', '--max-new', '3']);
  assert.equal(requests.length, 5);
  assert.equal((await journalAt(ctx)).entries.length, 5);
  assert.equal(process.exitCode, 2);
  await noFile(ctx.outputPath);

  process.exitCode = 0;
  await main([...ctx.args, '--prepare-only']);
  assert.equal(requests.length, 10);
  assert.deepEqual(requests, ids(ctx.conversations));
  assert.equal((await journalAt(ctx)).entries.length, 10);
  assert.equal(process.exitCode, 0);
  await noFile(ctx.outputPath);
  delete process.env.AI_API_KEY;
  fakeFetch.mock.mockImplementation(() => assert.fail('export-only must not call a provider'));
  await main([...ctx.args, '--team', 'Синтетическая команда', '--export-only']);
  assert.equal(fakeFetch.mock.callCount(), 10);
  assert.equal(process.exitCode, 1, 'A completed export with one real model failure remains a failed run');
  const document = JSON.parse(await readFile(ctx.outputPath, 'utf8'));
  validateSubmission(document, ctx);
  assert.equal(document.schema_version, '1.0');
  assert.deepEqual(ids(document.results), ids(ctx.conversations));
  assert.deepEqual(document.results[1], { conversation_id: ctx.conversations[1].conversation_id,
    status: 'error', criteria: [], score: null, error: (await journalAt(ctx)).entries[1].error });
  assert.equal(document.results.filter(row => row.status === 'ok').length, 9);
  assertSafe(JSON.stringify(document));
  assertSafe(ctx.logs.join('\n'));
  assertSafe(await readFile(ctx.options.journalPath, 'utf8'));
  if (process.platform !== 'win32') assert.equal((await stat(ctx.outputPath)).mode & 0o777, 0o600);
  assert.equal(await readFile(ctx.datasetPath, 'utf8'), datasetBefore);
  assert.equal(await readFile(ctx.versionPath, 'utf8'), versionBefore);
  await noLock(ctx);
});

test('main validate-only checks official schema, IDs and server scores from a saved full version without AI settings', async t => {
  const ctx = await cliSetup(t);
  process.env = {};
  const entries = ctx.conversations.map(conversation => ({ conversation_id: conversation.conversation_id,
    status: 'ok', output: outputFor(conversation, ctx.version) }));
  const document = official(ctx, entries);
  await writeFile(ctx.outputPath, JSON.stringify(document), { mode: 0o600 });
  await main([...ctx.args, '--validate-only']);
  assert.match(ctx.logs.join('\n'), /PASS: 10/);
  await noFile(ctx.options.journalPath);
  const cases = [
    ['schema extra field', d => { d.transcript = PRIVATE_TEXT; }],
    ['wrong server score', d => { d.results[0].score.final_score--; }],
    ['duplicate original ID', d => { d.results[1].conversation_id = d.results[0].conversation_id; }],
    ['missing criterion', d => { d.results[0].criteria.pop(); }]
  ];
  for (const [label, mutate] of cases) await t.test(label, async () => {
    const invalid = structuredClone(document);
    mutate(invalid);
    await writeFile(ctx.outputPath, JSON.stringify(invalid), { mode: 0o600 });
    const before = await readFile(ctx.outputPath, 'utf8');
    await assert.rejects(main([...ctx.args, '--validate-only']), { status: 400 });
    assert.equal(await readFile(ctx.outputPath, 'utf8'), before);
    await noFile(ctx.options.journalPath);
  });
});
