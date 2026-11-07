import express from 'express';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const text = value => typeof value === 'string' && value.trim().length > 0;

export function createApp(store) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '5mb' }));
  const get = (kind, id) => {
    const row = store.get(kind, id);
    if (!row) throw fail('Запись не найдена', 404);
    return row;
  };
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/api/conversations', (req, res) => res.json(store.list('conversation')));
  app.get('/api/conversations/:id', (req, res) => res.json(get('conversation', req.params.id)));
  app.post('/api/import', (req, res) => {
    const { group_id, records } = req.body;
    if (!text(group_id) || !Array.isArray(records) || !records.length || records.length > 1000)
      throw fail('Нужны group_id и массив records (1–1000 диалогов)');
    for (const c of records) {
      if (!text(c.conversation_id) || !['RU', 'KZ', 'EN'].includes(c.language)
        || !['agent chat', 'voice call'].includes(c.channel)
        || !Array.isArray(c.transcript) || !c.transcript.length
        || c.transcript.some(m => !m || !['client', 'operator', 'bot', 'system'].includes(m.speaker)
          || typeof m.text !== 'string' || !text(m.timestamp))) throw fail('Неверный формат диалога');
    }
    const result = store.transaction(() => records.map(c => {
      const existing = store.list('conversation').find(x => x.group_id === group_id && x.conversation_id === c.conversation_id);
      if (existing) return existing;
      return store.add('conversation', { group_id, conversation_id: c.conversation_id,
        channel: c.channel, language: c.language, audio_url: c.audio_url ?? null,
        transcript: c.transcript.map((m, i) => ({ timestamp: m.timestamp, speaker: m.speaker, text: m.text, message_no: i + 1 })) });
    }));
    res.status(201).json(result);
  });
  app.get('/api/evaluations', (req, res) => res.json(store.list('evaluation')));
  app.post('/api/evaluations', (req, res) => {
    const { conversation_id, checklist_version, results } = req.body;
    const conversation = get('conversation', conversation_id);
    if (!text(checklist_version) || !Array.isArray(results) || !results.length)
      throw fail('Нужны checklist_version и results');
    const ids = new Set();
    for (const r of results) {
      if (!r || !text(r.criterion_id) || ids.has(r.criterion_id) || !text(r.explanation)
        || !['yes', 'no', 'scale', 'na'].includes(r.answer)
        || !(r.raw_score === null || (Number.isFinite(r.raw_score) && r.raw_score >= 0))
        || !Array.isArray(r.evidence_message_nos)
        || r.evidence_message_nos.some(n => !Number.isInteger(n) || n < 1 || n > conversation.transcript.length)
        || (r.answer === 'na' && (!text(r.na_reason) || r.raw_score !== null)))
        throw fail('Неверный результат критерия');
      ids.add(r.criterion_id);
    }
    res.status(201).json(store.add('evaluation', { conversation_id, checklist_version, results }, conversation_id));
  });
  app.get('/api/evaluations/:id', (req, res) => {
    const original = get('evaluation', req.params.id);
    const decisions = store.list('decision').filter(d => d.evaluation_id === original.id);
    const final_results = original.results.map(r => {
      const decision = decisions.filter(d => d.criterion_id === r.criterion_id).at(-1);
      return decision?.action === 'change' ? { ...r, ...decision.replacement } : r;
    });
    res.json({ ...original, decisions, final_results });
  });
  app.get('/api/appeals', (req, res) => res.json(store.list('appeal').map(a => ({ ...a,
    decision: store.list('decision').find(d => d.appeal_id === a.id) ?? null }))));
  app.post('/api/appeals', (req, res) => {
    const { evaluation_id, criterion_id, comment } = req.body;
    const evaluation = get('evaluation', evaluation_id);
    if (!text(comment) || comment.length > 5000 || !evaluation.results.some(r => r.criterion_id === criterion_id))
      throw fail('Нужны существующий критерий и комментарий до 5000 символов');
    const open = store.list('appeal').some(a => a.evaluation_id === evaluation_id && a.criterion_id === criterion_id
      && !store.list('decision').some(d => d.appeal_id === a.id));
    if (open) throw fail('По этому критерию уже есть открытая апелляция', 409);
    res.status(201).json(store.add('appeal', { evaluation_id, criterion_id, comment: comment.trim() }, evaluation_id));
  });
  app.post('/api/appeals/:id/decision', (req, res) => {
    const appeal = get('appeal', req.params.id);
    const { action, reason, replacement } = req.body;
    if (!['confirm', 'change'].includes(action) || !text(reason) || reason.length > 5000)
      throw fail('Нужны action (confirm/change) и причина');
    if (action === 'change' && (!replacement || !['yes', 'no', 'scale', 'na'].includes(replacement.answer)
      || !(replacement.raw_score === null || (Number.isFinite(replacement.raw_score) && replacement.raw_score >= 0))
      || (replacement.answer === 'na' && (!text(replacement.na_reason) || replacement.raw_score !== null))))
      throw fail('Нужна корректная новая оценка');
    const result = store.transaction(() => {
      if (store.list('decision').some(d => d.appeal_id === appeal.id)) throw fail('Решение уже сохранено', 409);
      return store.add('decision', { appeal_id: appeal.id, evaluation_id: appeal.evaluation_id,
        criterion_id: appeal.criterion_id, action, reason: reason.trim(),
        replacement: action === 'change' ? { answer: replacement.answer, raw_score: replacement.raw_score,
          na_reason: replacement.na_reason ?? null } : null }, appeal.id);
    });
    res.status(201).json(result);
  });
  app.use((req, res) => res.status(404).json({ error: 'Адрес не найден' }));
  app.use((error, req, res, next) => {
    const status = error.status ?? 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: status >= 500 ? 'Ошибка сервера' : error.message });
  });
  return app;
}
