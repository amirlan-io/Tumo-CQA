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
    const version = (await request('/checklists')).data[0].latest_version;
    const answers = version.criteria.map(c => ({ criterion_id: c.criterion_id, answer: c.answer_type === 'scale' ? 'scale' : 'no', raw_score: c.is_gross_error ? null : 0, explanation: 'Проверено', evidence_message_nos: [1] }));
    const evaluation = await request('/evaluations', { conversation_id: imported.data[0].id,
      checklist_version: version.id, results: answers });
    assert.equal(evaluation.status, 201);
    const edited = structuredClone(version);
    edited.criteria[0].text = 'Новый критерий';
    edited.criteria[0].allow_na = true;
    edited.criteria[0].na_rule = 'Новое условие';
    const nextVersion = await request(`/checklists/${version.checklist_id}/versions`, edited);
    assert.equal(nextVersion.status, 201);
    assert.equal(nextVersion.data.version, 2);
    assert.notEqual(nextVersion.data.id, version.id);
    assert.equal((await request(`/checklist-versions/${version.id}`)).data.criteria[0].text, version.criteria[0].text);
    const bad = structuredClone(edited);
    bad.criteria[0].weight = -1;
    assert.equal((await request(`/checklists/${version.checklist_id}/versions`, bad)).status, 400);
    const invalidAnswers = structuredClone(answers);
    invalidAnswers[0] = { ...invalidAnswers[0], answer: 'na', raw_score: null, na_reason: 'Причина' };
    assert.equal((await request('/evaluations', { conversation_id: imported.data[0].id,
      checklist_version: version.id, results: invalidAnswers })).status, 400);
    assert.equal((await request('/evaluations', { conversation_id: imported.data[0].id,
      checklist_version: nextVersion.data.id, results: invalidAnswers })).status, 201);
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
    assert.equal(final.original_score.total, 0);
    assert.equal(final.final_score.total, 10);
    const second = await request('/appeals', appealBody);
    const confirmed = await request(`/appeals/${second.data.id}/decision`, { action: 'confirm', reason: 'Подтверждаю текущую оценку' });
    assert.equal(confirmed.data.evaluation.final_score.total, 10);
    const naAppeal = await request('/appeals', { ...appealBody, criterion_id: 'c3' });
    const naDecision = await request(`/appeals/${naAppeal.data.id}/decision`, { action: 'change', reason: 'Идентификация не нужна',
      replacement: { answer: 'na', raw_score: null, na_reason: 'Общий вопрос' } });
    assert.equal(naDecision.data.evaluation.final_score.total, 12.5);
    assert.equal(naDecision.data.evaluation.original_score.total, 0);
    const invalidAppeal = await request('/appeals', { ...appealBody, criterion_id: 'c6' });
    assert.equal((await request(`/appeals/${invalidAppeal.data.id}/decision`, { action: 'change', reason: 'Проверка шкалы',
      replacement: { answer: 'scale', raw_score: 8 } })).status, 400);
    assert.equal((await request(`/evaluations/${evaluation.data.id}`)).data.final_score.total, 12.5);
    assert.equal((await request('/import', { group_id: 'BAD', records: [{}] })).status, 400);
    assert.equal(store.list('conversation').length, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.db.close();
  }
});

