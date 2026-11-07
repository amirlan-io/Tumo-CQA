import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { createApp } from '../server/app.js';

test('import, evaluation, appeal and immutable review history', async () => {
  const store = createStore();
  const server = createApp(store).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const request = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    const input = { group_id: 'TEST', records: [{ conversation_id: 'test-1', language: 'RU',
      channel: 'agent chat', transcript: [{ speaker: 'operator', timestamp: '00:01', text: 'Здравствуйте' }] }] };
    const imported = await request('/import', input);
    assert.equal(imported.status, 201);
    const duplicate = await request('/import', input);
    assert.equal(duplicate.data[0].id, imported.data[0].id);
    const evaluation = await request('/evaluations', { conversation_id: imported.data[0].id,
      checklist_version: 'v1', results: [{ criterion_id: 'c1', answer: 'no', raw_score: 0,
        explanation: 'Не представился', evidence_message_nos: [1] }] });
    assert.equal(evaluation.status, 201);
    const appealBody = { evaluation_id: evaluation.data.id, criterion_id: 'c1', comment: 'Прошу проверить' };
    const appeal = await request('/appeals', appealBody);
    assert.equal(appeal.status, 201);
    assert.equal((await request('/appeals', appealBody)).status, 409);
    const decision = { action: 'change', reason: 'Исправлено проверяющим', replacement: { answer: 'yes', raw_score: 1 } };
    assert.equal((await request(`/appeals/${appeal.data.id}/decision`, decision)).status, 201);
    assert.equal((await request(`/appeals/${appeal.data.id}/decision`, decision)).status, 409);
    const final = (await request(`/evaluations/${evaluation.data.id}`)).data;
    assert.equal(final.results[0].answer, 'no');
    assert.equal(final.final_results[0].answer, 'yes');
    assert.equal(final.decisions.length, 1);
    assert.equal((await request('/import', { group_id: 'BAD', records: [{}] })).status, 400);
    assert.equal(store.list('conversation').length, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.db.close();
  }
});
