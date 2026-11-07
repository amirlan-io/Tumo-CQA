import { validateResults } from './validate-results.js';

export function installJobs(app, store, get, { evaluateDialogue, timeoutMs = 60000 } = {}) {
  // Interrupted calls cannot be resumed safely: preserve them as visible errors.
  for (const job of store.list('job')) if (['queued', 'running'].includes(job.status))
    store.update('job', job.id, { status: 'failed', error: 'Сервер перезапущен. Запустите оценку заново.', finished_at: new Date().toISOString() });
  let queue = Promise.resolve();
  async function run(id) {
    const job = get('job', id);
    store.update('job', id, { status: 'running', started_at: new Date().toISOString() });
    const controller = new AbortController();
    let timer;
    try {
      const output = await Promise.race([
        Promise.resolve().then(() => evaluateDialogue(get('conversation', job.conversation_id),
          get('checklist_version', job.checklist_version), { signal: controller.signal })),
        new Promise((resolve, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(Object.assign(new Error('timeout'), { timeout: true }));
        }, timeoutMs); })
      ]);
      if (!output || typeof output.model !== 'string' || !output.model.trim()
        || typeof output.prompt_version !== 'string' || !output.prompt_version.trim()) throw new Error('Invalid metadata');
      validateResults(get('conversation', job.conversation_id), get('checklist_version', job.checklist_version), output.results);
      store.transaction(() => {
        const evaluation = store.add('evaluation', { conversation_id: job.conversation_id,
          checklist_version: job.checklist_version, model: output.model, prompt_version: output.prompt_version,
          results: output.results }, job.conversation_id);
        store.update('job', id, { status: 'completed', evaluation_id: evaluation.id, finished_at: new Date().toISOString() });
      });
    } catch (error) {
      store.update('job', id, { status: 'failed', error: error.timeout
        ? 'Превышено время ожидания ИИ' : 'Не удалось получить корректную оценку ИИ. Повторите запуск.',
        finished_at: new Date().toISOString() });
    } finally { clearTimeout(timer); }
  }
  app.post('/api/evaluation-jobs', (req, res) => {
    const { conversation_id, checklist_version } = req.body ?? {};
    if (typeof conversation_id !== 'string' || typeof checklist_version !== 'string')
      return res.status(400).json({ error: 'Нужны conversation_id и checklist_version' });
    get('conversation', conversation_id); get('checklist_version', checklist_version);
    if (typeof evaluateDialogue !== 'function') return res.status(503).json({ error: 'Модуль ИИ ещё не подключён' });
    const existing = store.list('job').find(j => j.conversation_id === conversation_id && j.checklist_version === checklist_version
      && ['queued', 'running'].includes(j.status));
    if (existing) return res.status(202).location(`/api/evaluation-jobs/${existing.id}`).json(existing);
    const job = store.add('job', { conversation_id, checklist_version, status: 'queued', error: null, evaluation_id: null });
    res.status(202).location(`/api/evaluation-jobs/${job.id}`).json(job);
    queue = queue.then(() => run(job.id)).catch(() => {});
  });
  app.get('/api/evaluation-jobs', (req, res) => res.json(store.list('job')));
  app.get('/api/evaluation-jobs/:id', (req, res) => res.json(get('job', req.params.id)));
}
