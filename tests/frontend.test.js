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
      beforeParse(window) {
        window.HTMLElement.prototype.scrollIntoView = function () {};
        window.fetch = (path, options) => fetch(new URL(path, url), options);
      } });
    const doc = dom.window.document;
    const find = label => [...doc.querySelectorAll('button')].find(b => b.textContent === label);
    await until(() => find('Открыть UI-1 · RU'));
    find('Импортировать JSON').click();
    await until(() => doc.querySelector('#cqa-status').textContent.includes('Выберите JSON-файл'));
    assert.equal(find('Импортировать JSON').disabled, false);
    find('Открыть UI-1 · RU').click();
    await until(() => find('Оценить через ИИ'));
    find('Оценить через ИИ').click();
    await until(() => doc.body.textContent.includes('Итог · 0.00'));
    assert.equal(store.list('evaluation').length, 1);
    find('Оценить группу через ИИ').click();
    await until(() => doc.body.textContent.includes('100%'));
    assert.equal(store.list('job').at(-1).cache_hit, true);
    assert.equal(store.list('evaluation').length, 2);
    find('Доказательство · 1').click();
    await until(() => doc.querySelector('li.cqa-evidence'));
    const comment = doc.querySelector('details textarea');
    comment.value = 'Проверьте приветствие';
    find('Подать апелляцию').click();
    await until(() => store.list('appeal').length === 1);
    find('Апелляции').click();
    await until(() => find('Апелляция 1 · на рассмотрении'));
    find('Апелляция 1 · на рассмотрении').click();
    await until(() => find('Изменить ответ'));
    const reason = [...doc.querySelectorAll('label')].find(l => l.firstChild.textContent === 'Причина решения').querySelector('textarea');
    reason.value = 'Приветствие подтверждено';
    const answer = [...doc.querySelectorAll('label')].find(l => l.firstChild.textContent === 'Ответ').querySelector('select');
    answer.value = 'yes';
    find('Изменить ответ').click();
    await until(() => doc.body.textContent.includes('Текущий итог · 10.00'));
    assert.equal(store.list('decision').length, 1);
    assert.equal(dom.window.location.hash, '#appeals');
    find('Чек-листы').click();
    await until(() => find('Сохранить новую версию'));
    find('Добавить критерий').click();
    assert.equal(doc.querySelectorAll('.cqa-criterion-editor').length, 9);
    [...doc.querySelectorAll('.cqa-criterion-editor')].at(-1).querySelector('button').click();
    assert.equal(doc.querySelectorAll('.cqa-criterion-editor').length, 8);
    const inputs = [...doc.querySelectorAll('textarea')];
    inputs[0].value = 'Заменённый через интерфейс критерий';
    find('Сохранить новую версию').click();
    await until(() => store.list('checklist_version').length === 2);
    assert.equal(store.list('checklist_version')[1].criteria[0].text, 'Заменённый через интерфейс критерий');
    assert.notEqual(store.list('checklist_version')[0].criteria[0].text, 'Заменённый через интерфейс критерий');
    assert.equal(store.list('evaluation')[0].checklist_version, store.list('checklist_version')[0].id);
    const newName = [...doc.querySelectorAll('label')].find(l => l.firstChild.textContent === 'Название нового чек-листа').querySelector('input');
    newName.value = 'Чек-лист команды';
    find('Создать на основе текущего').click();
    await until(() => store.list('checklist').length === 2);
    assert.equal(dom.window.location.hash, '#checklists');
  } finally {
    dom?.window.close();
    await new Promise(r => server.close(r)); store.db.close();
  }
});

