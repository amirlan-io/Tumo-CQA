import express from 'express';
import { buildSubmission } from './submission.js';
import { fileURLToPath } from 'node:url';
import { validateResults } from './validate-results.js';
import { installJobs } from './jobs.js';
import { importRecords } from './import.js';
import { fetchDataset } from './organizer.js';
import { installChecklists, validateAnswers, validateConfig } from './checklists.js';
import { evaluationView, applyDecisions, calculateScore } from './score.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const text = value => typeof value === 'string' && value.trim().length > 0;

export function createApp(store, organizer = {}, ai = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/frontend', express.static(fileURLToPath(new URL('../frontend', import.meta.url))));
  app.get('/', (req, res) => res.redirect('/frontend/'));
  app.use(express.json({ limit: '5mb' }));
  const get = (kind, id) => {
    const row = store.get(kind, id);
    if (!row) throw fail('Запись не найдена', 404);
    return row;
  };
  app.get('/api/conversations/:id/audio', async (req, res) => {
    const { audio_url } = get('conversation', req.params.id);
    if (!audio_url) throw fail('Запись недоступна.', 404);
    const source = new URL(audio_url);
    if (source.protocol !== 'https:' ||
        source.hostname !== 'ec88f21f1accecf38e20095a9fe175.a5.environment.api.powerplatform.com')
      throw fail('Источник записи не поддерживается.', 404);
    let target;
    try {
      const page = await fetch(source, { redirect: 'error', signal: AbortSignal.timeout(8000) });
      if (!page.ok || !page.headers.get('content-type')?.startsWith('text/html')) throw new Error();
      const html = await page.text();
      const link = html.match(/<source\s+src="([^"]+)"/i)?.[1];
      if (!link) throw new Error();
      target = new URL(link.replaceAll('&amp;', '&'), source);
      if (target.protocol !== 'https:' || target.hostname !== 'freedomholdingcorporation.crm11.dynamics.com' ||
          target.username || target.password) throw new Error();
    } catch {
      throw fail('Не удалось получить аудиозапись. Откройте ссылку на запись звонка.', 502);
    }
    res.set('Cache-Control', 'private, no-store').redirect(307, target.href);
  });
  app.post('/api/checklist-versions/:id/preview-weights', (req, res) => {
    const version = get('checklist_version', req.params.id);
    const { group_id, criteria } = req.body ?? {};
    if (!text(group_id)) throw fail('Укажите группу диалогов.');
    const draft = validateConfig({ name: version.name, criteria });
    const proposed = new Map(draft.criteria.map(criterion => [criterion.criterion_id, criterion]));
    const withoutWeight = ({ weight, ...rule }) => JSON.stringify(rule);
    if (proposed.size !== version.criteria.length || version.criteria.some(criterion => {
      const candidate = proposed.get(criterion.criterion_id);
      return !candidate || withoutWeight(candidate) !== withoutWeight(criterion);
    })) throw fail('Для предпросмотра меняйте только веса. Новые правила требуют новой оценки.');

    const ids = new Set(store.list('conversation').filter(c => c.group_id === group_id.trim()).map(c => c.id));
    const latest = new Map();
    for (const evaluation of store.list('evaluation')) {
      if (evaluation.model && evaluation.checklist_version === version.id && ids.has(evaluation.conversation_id))
        latest.set(evaluation.conversation_id, evaluation);
    }
    if (!latest.size) throw fail('В группе нет оценок ИИ по выбранной версии.', 404);
    const pairs = [...latest.values()].map(evaluation => ({
      before: calculateScore(version, evaluation.results).total,
      after: calculateScore(draft, evaluation.results).total
    })).filter(pair => pair.before !== null && pair.after !== null);
    if (!pairs.length) throw fail('Нет диалогов с итоговым баллом при обоих наборах весов.');
    const average = key => Number((pairs.reduce((sum, pair) => sum + pair[key], 0) / pairs.length).toFixed(2));
    res.json({ compared: pairs.length, group_total: ids.size, before: average('before'), after: average('after'),
      increased: pairs.filter(pair => pair.after > pair.before).length,
      decreased: pairs.filter(pair => pair.after < pair.before).length });
  });
  app.post('/api/exports/submission', (req, res) => {
    const payload = buildSubmission(store, req.body);
    res.type('application/json').attachment('results.json').send(JSON.stringify(payload, null, 2));
  });
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  installChecklists(app, store, get);
  installJobs(app, store, get, ai);
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
    const version = get('checklist_version', checklist_version);
    validateResults(conversation, version, results);
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
