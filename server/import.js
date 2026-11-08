const fail = message => Object.assign(new Error(message), { status: 400 });
const text = value => typeof value === 'string' && value.trim().length > 0;
export function importRecords(store, input) {
    if (!input || typeof input !== 'object') throw fail('Нужны group_id и records');
    const { group_id, records } = input;
    if (!text(group_id) || !Array.isArray(records) || !records.length || records.length > 1000)
      throw fail('Нужны group_id и массив records (1–1000 диалогов)');
    for (const c of records) {
      if (!c || !text(c.conversation_id) || !['RU', 'KZ', 'EN'].includes(c.language)
        || !['agent chat', 'voice call'].includes(c.channel)
        || !Array.isArray(c.transcript) || !c.transcript.length
        || c.transcript.some(m => !m || !['client', 'operator', 'bot', 'system'].includes(m.speaker)
          || typeof m.text !== 'string' || !text(m.timestamp))) throw fail('Неверный формат диалога');
      if (c.audio_url != null) {
        try {
          if (typeof c.audio_url !== 'string') throw new Error();
          const url = new URL(c.audio_url);
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
        } catch { throw fail('audio_url должен быть HTTP(S)-ссылкой или null'); }
      }
    }
    const result = store.transaction(() => records.map(c => {
      const existing = store.list('conversation').find(x => x.group_id === group_id && x.conversation_id === c.conversation_id);
      if (existing) return existing;
      return store.add('conversation', { group_id, conversation_id: c.conversation_id,
        channel: c.channel, language: c.language, audio_url: c.audio_url ?? null,
        transcript: c.transcript.map((m, i) => ({ timestamp: m.timestamp, speaker: m.speaker, text: m.text, message_no: i + 1 })) });
    }));
    return result;
}
