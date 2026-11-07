import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvaluator } from '../server/services/ai.js';
import { createApp } from '../server/app.js';
import { createStore } from '../server/store.js';

test('teammate evaluator integrates with server jobs scoring diagnostics and persistent cache', async () => {
  const diagnosticDir = await mkdtemp(join(tmpdir(), 'tumo-integration-'));
  const store = createStore();
  let calls = 0;
  const evaluator = createEvaluator({ apiKey: 'synthetic-test-key', model: 'test-provider', diagnosticDir,
    fetchImpl: async (url, options) => {
      calls++;
      const request = JSON.parse(options.body);
      const input = JSON.parse(request.messages[1].content);
      const results = input.checklist_version.criteria.map(c => ({ criterion_id: c.criterion_id,
        answer: c.answer_type === 'scale' ? 'scale' : 'no', raw_score: c.is_gross_error ? null : 0,
        explanation: 'Проверен весь диалог', evidence_message_nos: [1], checked_range: { from: 1, to: 1 }, na_reason: null }));
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results }) } }] }));
    } });
  const server = createApp(store, {}, { model: 'test-provider', prompt_version: 'v1', evaluateDialogue: evaluator }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const conversation = store.add('conversation', { conversation_id: 'integration', group_id: 'TEST', language: 'KZ',
    channel: 'agent chat', transcript: [{ timestamp: '00:01', speaker: 'operator', text: 'Сәлеметсіз бе!', message_no: 1 }] });
  const body = { conversation_id: conversation.id, checklist_version: store.list('checklist_version')[0].id };
  async function start() {
    const response = await fetch(base + '/evaluation-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 202);
    const job = await response.json();
    for (let i = 0; i < 100; i++) {
      const state = await (await fetch(base + '/evaluation-jobs/' + job.id)).json();
      if (['completed', 'failed'].includes(state.status)) return state;
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('Timed out');
  }
  try {
    const first = await start();
    assert.equal(first.status, 'completed');
    const result = await (await fetch(base + '/evaluations/' + first.evaluation_id)).json();
    assert.equal(result.final_score.total, 0);
    assert.equal(result.model, 'test-provider');
    assert.equal(result.final_results.length, 8);
    assert.equal((await start()).cache_hit, true);
    assert.equal(calls, 1);
  } finally {
    await new Promise(r => server.close(r)); store.db.close();
    await rm(diagnosticDir, { recursive: true, force: true });
  }
});

