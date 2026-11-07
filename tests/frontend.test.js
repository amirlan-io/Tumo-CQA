import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createApp } from '../server/app.js';
import { createStore } from '../server/store.js';

async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('UI condition timed out');
}
test('frontend served by backend launches real jobs and batches through service adapter', async () => {
  const store = createStore();
  const ai = { model: 'test', prompt_version: 'v1', evaluateDialogue: async (c, v) => ({ model: 'test', prompt_version: 'v1',
    results: v.criteria.map(c => ({ criterion_id: c.criterion_id, answer: c.answer_type === 'scale' ? 'scale' : 'no',
      raw_score: c.is_gross_error ? null : 0, explanation: 'Test', evidence_message_nos: [1] })) }) };
  const server = createApp(store, {}, ai).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  store.add('conversation', { conversation_id: 'UI-1', group_id: 'DEV', channel: 'agent chat', language: 'RU',
    transcript: [{ message_no: 1, timestamp: '00:01', speaker: 'operator', text: 'Здравствуйте' }] });
  const url = `http://127.0.0.1:${server.address().port}/frontend/`;
  let dom;
  try {
    dom = await JSDOM.fromURL(url, { resources: 'usable', runScripts: 'dangerously',
      beforeParse(window) { window.fetch = (path, options) => fetch(new URL(path, url), options); } });
    const doc = dom.window.document;
    const find = label => [...doc.querySelectorAll('button')].find(b => b.textContent === label);
    await until(() => find('Открыть UI-1 · RU'));
    find('Открыть UI-1 · RU').click();
    await until(() => find('Оценить через ИИ'));
    find('Оценить через ИИ').click();
    await until(() => doc.body.textContent.includes('Итог · 0.00'));
    assert.equal(store.list('evaluation').length, 1);
    find('Оценить группу через ИИ').click();
    await until(() => doc.body.textContent.includes('100%'));
    assert.equal(store.list('job').at(-1).cache_hit, true);
    assert.equal(store.list('evaluation').length, 2);
  } finally {
    dom?.window.close();
    await new Promise(r => server.close(r)); store.db.close();
  }
});

