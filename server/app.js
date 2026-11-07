import express from 'express';
import { fileURLToPath } from 'node:url';

import { importRecords } from './import.js';
import { fetchDataset } from './organizer.js';
import { installChecklists, validateAnswers } from './checklists.js';
import { evaluationView, applyDecisions } from './score.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const text = value => typeof value === 'string' && value.trim().length > 0;

export function createApp(store, organizer = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/frontend', express.static(fileURLToPath(new URL('../frontend', import.meta.url))));

  app.use(express.json({ limit: '5mb' }));
  const get = (kind, id) => {
    const row = store.get(kind, id);
    if (!row) throw fail('Запись не найдена', 404);
    return row;
  };
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  installChecklists(app, store, get);
  app.get('/api/conversations', (req, res) => res.json(store.list('conversation')));
  app.get('/api/conversations/:id', (req, res) => res.json(get('conversation', req.params.id)));
  app.post('/api/import', (req, res) => res.status(201).json(importRecords(store, req.body)));
  app.post('/api/import/organizer', async (req, res) => {
    const data = await fetchDataset(req.body.group_id, organizer);
    try {
      const records = importRecords(store, data);
      res.status(201).json({ group_id: data.group_id, count: records.length, records });
    } catch (error) {
      if (error.status === 400) throw fail('API организаторов вернул неверные диалоги', 502);
      throw error;
    }
  });
  app.get('/api/evaluations', (req, res) => res.json(store.list('evaluation').map(e => evaluationView(store, e))));
  app.get('/api/exports/evaluations.csv', (req, res) => {
    const cell = value => {
      let s = value == null ? '' : String(value);
      if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
      return '"' + s.replaceAll('"', '""') + '"';
    };
    const rows = [['evaluation_id', 'conversation_id', 'language', 'checklist_version', 'original_total', 'final_total', 'gross_error']];
    for (const e of store.list('evaluation')) {
      const view = evaluationView(store, e);
      const c = get('conversation', e.conversation_id);
      rows.push([e.id, c.conversation_id, c.language, e.checklist_version,
        view.original_score.total, view.final_score.total, view.final_score.gross_error]);
    }
    res.type('text/csv; charset=utf-8').attachment('evaluations.csv').send('\uFEFF' + rows.map(r => r.map(cell).join(',')).join('\r\n'));
  });
  app.post('/api/evaluations', (req, res) => {
    const { conversation_id, checklist_version, results } = req.body;
    const conversation = get('conversation', conversation_id);
    if (!text(checklist_version) || !Array.isArray(results) || !results.length)
      throw fail('Нужны checklist_version и results');
    const ids = new Set();
    const version = get('checklist_version', checklist_version);
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
    validateAnswers(version, results);
    res.status(201).json(evaluationView(store, store.add('evaluation', { conversation_id, checklist_version, results }, conversation_id)));
  });
  app.get('/api/evaluations/:id', (req, res) => {
    const original = get('evaluation', req.params.id);
    res.json(evaluationView(store, original));
  });
  app.get('/api/appeals', (req, res) => res.json(store.list('appeal').map(a => ({ ...a,
    decision: store.list('decision').find(d => d.appeal_id === a.id) ?? null }))));
  app.get('/api/appeals/:id', (req, res) => {
    const appeal = get('appeal', req.params.id);
    const evaluation = evaluationView(store, get('evaluation', appeal.evaluation_id));
    const conversation = get('conversation', evaluation.conversation_id);
    const version = get('checklist_version', evaluation.checklist_version);
    const original = evaluation.results.find(r => r.criterion_id === appeal.criterion_id);
    const current = evaluation.final_results.find(r => r.criterion_id === appeal.criterion_id);
    res.json({ ...appeal, decision: evaluation.decisions.find(d => d.appeal_id === appeal.id) ?? null,
      criterion: version.criteria.find(c => c.criterion_id === appeal.criterion_id),
      original, current, conversation, evaluation,
      evidence: conversation.transcript.filter(m => current.evidence_message_nos.includes(m.message_no)) });
  });
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
      if (action === 'change') {
        const evaluation = get('evaluation', appeal.evaluation_id);
        const version = get('checklist_version', evaluation.checklist_version);
        const current = applyDecisions(evaluation.results, store.list('decision').filter(d => d.evaluation_id === evaluation.id));
        validateAnswers(version, current.map(r => r.criterion_id === appeal.criterion_id ? { ...r, ...replacement } : r));
      }
      if (store.list('decision').some(d => d.appeal_id === appeal.id)) throw fail('Решение уже сохранено', 409);
      return store.add('decision', { appeal_id: appeal.id, evaluation_id: appeal.evaluation_id,
        criterion_id: appeal.criterion_id, action, reason: reason.trim(),
        replacement: action === 'change' ? { answer: replacement.answer, raw_score: replacement.raw_score,
          na_reason: replacement.na_reason ?? null } : null }, appeal.id);
    });
    res.status(201).json({ ...result, evaluation: evaluationView(store, get('evaluation', appeal.evaluation_id)) });
  });
  app.use((req, res) => res.status(404).json({ error: 'Адрес не найден' }));
  app.use((error, req, res, next) => {
    const status = error.status ?? 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: status >= 500 ? 'Ошибка сервера' : error.message });
  });
  return app;
}
