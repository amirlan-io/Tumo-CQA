import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { createApp } from '../server/app.js';

async function setup(ai) {
  const store = createStore();
  const app = createApp(store, {}, ai);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const request = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  const c = store.add('conversation', { transcript: [{ message_no: 1, text: 'Hello' }] });
  const v = store.list('checklist_version')[0];
  const body = { conversation_id: c.id, checklist_version: v.id };
  const output = { model: 'test-only', prompt_version: 'v1', results: v.criteria.map(c => ({ criterion_id: c.criterion_id,
    answer: c.answer_type === 'scale' ? 'scale' : 'no', raw_score: c.is_gross_error ? null : 0,
    explanation: 'Test', evidence_message_nos: [1] })) };
  return { store, request, body, output, close: async () => {
    await new Promise(r => server.close(r)); store.db.close();
  } };
}
async function terminal(ctx, id) {
  for (let i = 0; i < 100; i++) {
    const j = (await ctx.request(`/evaluation-jobs/${id}`)).data;
    if (['completed', 'failed'].includes(j.status)) return j;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error('Job did not finish');
}
test('job queued/running/completed, duplicate suppressed and result scored', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  let calls = 0;
  const ctx = await setup({ evaluateDialogue: async () => { calls++; await gate; return ctx.output; } });
  try {
    const job = await ctx.request('/evaluation-jobs', ctx.body);
    assert.equal(job.status, 202); assert.equal(job.data.status, 'queued');
    assert.equal((await ctx.request(`/evaluation-jobs/${job.data.id}`)).data.status, 'running');
    assert.equal((await ctx.request('/evaluation-jobs', ctx.body)).data.id, job.data.id);
    release();
    const done = await terminal(ctx, job.data.id);
    assert.equal(done.status, 'completed'); assert.equal(calls, 1);
    const e = (await ctx.request(`/evaluations/${done.evaluation_id}`)).data;
    assert.equal(e.model, 'test-only'); assert.equal(e.final_score.total, 0);
  } finally { release(); await ctx.close(); }
});
test('missing model is explicit 503 and creates no job', async () => {
  const ctx = await setup({});
  try { assert.equal((await ctx.request('/evaluation-jobs', ctx.body)).status, 503);
    assert.equal(ctx.store.list('job').length, 0);
    assert.equal((await ctx.request('/evaluation-jobs', {})).status, 400);
  } finally { await ctx.close(); }
});
test('provider errors, invalid results and timeout never save evaluations', async () => {
  for (const ai of [
    { evaluateDialogue: async () => { throw new Error('secret-key'); } },
    { evaluateDialogue: async () => {
      throw Object.assign(new Error('secret-key'), { code: 'AI_UNAVAILABLE', providerStatus: 429 });
    }, expectedError: /ограничил число запросов/ },
    { evaluateDialogue: async () => ({ model: 'test', prompt_version: 'v1', results: [] }) },
    { evaluateDialogue: () => new Promise(() => {}), timeoutMs: 10 }
  ]) {
    const ctx = await setup(ai);
    try {
      const job = await ctx.request('/evaluation-jobs', ctx.body);
      const failed = await terminal(ctx, job.data.id);
      assert.equal(failed.status, 'failed'); assert.ok(!failed.error.includes('secret'));
      if (ai.expectedError) assert.match(failed.error, ai.expectedError);
      assert.equal(ctx.store.list('evaluation').length, 0);
    } finally { await ctx.close(); }
  }
});
test('restart marks interrupted jobs failed', () => {
  const store = createStore();
  const j = store.add('job', { status: 'running' });
  createApp(store);
  assert.equal(store.get('job', j.id).status, 'failed');
  store.db.close();
});

test('batch continues after failure; cache reuses answers and invalidates changed criteria', async () => {
  let calls = 0;
  const ctx = await setup({ model: 'test-only', prompt_version: 'v1', evaluateDialogue: async c => {
    calls++;
    if (c.bad) throw new Error('Provider failure');
    return ctx.output;
  } });
  try {
    ctx.store.update('conversation', ctx.body.conversation_id, { group_id: 'DEV' });
    ctx.store.add('conversation', { group_id: 'DEV', bad: true, transcript: [{ message_no: 1, text: 'Bad' }] });
    assert.equal((await ctx.request('/evaluation-batches', { group_id: 'MISSING', checklist_version: ctx.body.checklist_version })).status, 404);
    const response = await ctx.request('/evaluation-batches', { group_id: 'DEV', checklist_version: ctx.body.checklist_version });
    assert.equal(response.status, 202);
    for (const id of response.data.job_ids) await terminal(ctx, id);
    const batch = (await ctx.request(`/evaluation-batches/${response.data.id}`)).data;
    assert.equal(batch.status, 'completed_with_errors');
    assert.equal(batch.progress, 100); assert.equal(batch.completed, 1); assert.equal(batch.failed, 1);
    const repeat = await ctx.request('/evaluation-jobs', ctx.body);
    const hit = await terminal(ctx, repeat.data.id);
    assert.equal(hit.cache_hit, true); assert.equal(calls, 2);
    const version = structuredClone(ctx.store.get('checklist_version', ctx.body.checklist_version));
    version.criteria[0].text = 'Changed criterion';
    const next = ctx.store.add('checklist_version', version);
    const changed = await ctx.request('/evaluation-jobs', { ...ctx.body, checklist_version: next.id });
    assert.equal((await terminal(ctx, changed.data.id)).cache_hit, false);
    assert.equal(calls, 3);
    assert.equal(ctx.store.list('ai_cache').length, 2);
    ctx.store.update('conversation', ctx.body.conversation_id, { transcript: [{ message_no: 1, text: 'Updated transcript' }] });
    const revised = await ctx.request('/evaluation-jobs', ctx.body);
    assert.equal((await terminal(ctx, revised.data.id)).cache_hit, false);
    assert.equal(calls, 4);
  } finally { await ctx.close(); }
});
