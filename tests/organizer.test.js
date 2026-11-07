import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchDataset } from '../server/organizer.js';
import { importRecords } from '../server/import.js';
import { createStore } from '../server/store.js';

const records = [{ conversation_id: 'voice-1', language: 'KZ', channel: 'voice call',
  audio_url: 'https://example.com/audio', transcript: [{ speaker: 'system', timestamp: '2026-11-07T10:00:00+05:00', text: 'Начало' }] }];
const payload = { isSuccess: true, data: { dataset_group_id: 'DEV', total_records: 1, records } };
const options = body => ({ url: 'https://example.com/api?sig=secret&group_id=OLD',
  fetchImpl: async url => {
    assert.equal(url.searchParams.get('sig'), 'secret');
    assert.equal(url.searchParams.get('group_id'), 'DEV');
    return new Response(JSON.stringify(body));
  } });

test('organizer dataset preserves roles, timestamps, audio and is idempotent', async () => {
  const store = createStore();
  try {
    const data = await fetchDataset('DEV', options(payload));
    const first = importRecords(store, data);
    assert.equal(first[0].transcript[0].timestamp, records[0].transcript[0].timestamp);
    assert.equal(first[0].audio_url, records[0].audio_url);
    assert.equal(first[0].transcript[0].speaker, 'system');
    assert.equal(importRecords(store, data)[0].id, first[0].id);
    assert.equal(store.list('conversation').length, 1);
    assert.throws(() => importRecords(store, { ...data, records: [...records, {}] }));
    assert.equal(store.list('conversation').length, 1);
  } finally { store.db.close(); }
});
test('organizer rejects invalid group, missing config, wrong group and incomplete response', async () => {
  await assert.rejects(fetchDataset('../bad', options(payload)), { status: 400 });
  await assert.rejects(fetchDataset('DEV', { url: '' }), { status: 503 });
  for (const body of [{ isSuccess: false }, { ...payload, data: { ...payload.data, dataset_group_id: 'OTHER' } },
    { ...payload, data: { ...payload.data, total_records: 65 } }]) {
    await assert.rejects(fetchDataset('DEV', options(body)), { status: 502 });
  }
});
test('organizer translates HTTP, non JSON, network and timeout failures', async () => {
  for (const [fetchImpl, status] of [
    [async () => new Response('Unavailable', { status: 503 }), 502],
    [async () => new Response('<html>'), 502],
    [async () => { throw new Error('network secret'); }, 502],
    [async () => { throw new DOMException('timeout', 'TimeoutError'); }, 504]
  ]) await assert.rejects(fetchDataset('DEV', { url: 'https://example.com', fetchImpl }), e => e.status === status && !e.message.includes('secret'));
});
