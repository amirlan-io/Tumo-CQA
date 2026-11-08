import { createHash } from 'node:crypto';
import { validateResults } from './validate-results.js';

function jobErrorMessage(error) {
  if (error?.timeout) return 'Превышено время ожидания ИИ. Повторите запуск.';
  if (error?.code === 'AI_UNAVAILABLE' && error.providerStatus === 429)
    return 'Провайдер ИИ ограничил число запросов. Повторите запуск позже.';
  if (error?.code === 'AI_UNAVAILABLE' && [401, 403].includes(error.providerStatus))
    return 'Провайдер ИИ отклонил доступ. Проверьте ключ и права на модель.';
  switch (error?.code) {
    case 'AI_CONFIG': return 'Проверьте настройки подключения ИИ.';
    case 'AI_UNAVAILABLE': return 'Провайдер ИИ недоступен. Повторите запуск позже.';
    case 'AI_INVALID_RESPONSE': return 'Ответ модели не прошёл проверку. Повторите оценку.';
    case 'AI_REFUSED': return 'Модель отказалась оценивать диалог.';
    default: return 'Не удалось получить корректную оценку ИИ. Повторите запуск.';
  }
}

export function installJobs(app, store, get, { evaluateDialogue, model, prompt_version, timeoutMs = 60000 } = {}) {
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
      const conversation = get('conversation', job.conversation_id);
      const version = get('checklist_version', job.checklist_version);
      const cacheKey = model && prompt_version ? createHash('sha256').update(JSON.stringify({
        conversation_id: conversation.id, transcript: conversation.transcript, language: conversation.language,
        channel: conversation.channel, audio_url: conversation.audio_url,
        criteria: version.criteria, rounding_digits: version.rounding_digits, model, prompt_version
      })).digest('hex') : null;
      const cached = cacheKey ? store.list('ai_cache').find(c => c.key === cacheKey) : null;
      const output = cached?.output ?? await Promise.race([
        Promise.resolve().then(() => evaluateDialogue(get('conversation', job.conversation_id),
          get('checklist_version', job.checklist_version), { signal: controller.signal })),
        new Promise((resolve, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(Object.assign(new Error('timeout'), { timeout: true }));
        }, timeoutMs); })
      ]);
      if (!output || typeof output.model !== 'string' || !output.model.trim()
        || typeof output.prompt_version !== 'string' || !output.prompt_version.trim()) throw new Error('Invalid metadata');
      if ((model && output.model !== model) || (prompt_version && output.prompt_version !== prompt_version)) throw new Error('Model configuration mismatch');
      validateResults(get('conversation', job.conversation_id), get('checklist_version', job.checklist_version), output.results);
      store.transaction(() => {
        if (cacheKey && !cached) store.add('ai_cache', { key: cacheKey, output });
        const evaluation = store.add('evaluation', { conversation_id: job.conversation_id,
          checklist_version: job.checklist_version, model: output.model, prompt_version: output.prompt_version,
          results: output.results }, job.conversation_id);
        store.update('job', id, { status: 'completed', cache_hit: Boolean(cached), evaluation_id: evaluation.id, finished_at: new Date().toISOString() });
      });
    } catch (error) {
      store.update('job', id, { status: 'failed', error: jobErrorMessage(error),
        finished_at: new Date().toISOString() });
    } finally { clearTimeout(timer); }
  }
  function enqueue(conversation_id, checklist_version) {
    const existing = store.list('job').find(j => j.conversation_id === conversation_id && j.checklist_version === checklist_version
      && ['queued', 'running'].includes(j.status));
    if (existing) return existing;
    const job = store.add('job', { conversation_id, checklist_version, status: 'queued', error: null, evaluation_id: null, cache_hit: false });
    queue = queue.then(() => run(job.id)).catch(() => {});
    return job;
  }
  app.post('/api/evaluation-jobs', (req, res) => {
    const { conversation_id, checklist_version } = req.body ?? {};
    if (typeof conversation_id !== 'string' || typeof checklist_version !== 'string')
      return res.status(400).json({ error: 'Нужны conversation_id и checklist_version' });
    get('conversation', conversation_id); get('checklist_version', checklist_version);
    if (typeof evaluateDialogue !== 'function') return res.status(503).json({ error: 'Модуль ИИ ещё не подключён' });
    const job = enqueue(conversation_id, checklist_version);
    res.status(202).location(`/api/evaluation-jobs/${job.id}`).json(job);
  });
  function batchView(batch) {
    const jobs = batch.job_ids.map(id => get('job', id));
    const completed = jobs.filter(j => j.status === 'completed').length;
    const failed = jobs.filter(j => j.status === 'failed').length;
    return { ...batch, total: jobs.length, completed, failed,
      processed: completed + failed, progress: Math.round(100 * (completed + failed) / jobs.length),
      status: completed + failed === jobs.length ? (failed ? 'completed_with_errors' : 'completed')
        : jobs.some(j => j.status !== 'queued') ? 'running' : 'queued', jobs };
  }
  app.post('/api/evaluation-batches', (req, res) => {
    const { group_id, checklist_version } = req.body ?? {};
    if (typeof group_id !== 'string' || !group_id.trim() || typeof checklist_version !== 'string')
      return res.status(400).json({ error: 'Нужны group_id и checklist_version' });
    get('checklist_version', checklist_version);
    if (typeof evaluateDialogue !== 'function') return res.status(503).json({ error: 'Модуль ИИ ещё не подключён' });
    const conversations = store.list('conversation').filter(c => c.group_id === group_id);
    if (!conversations.length) return res.status(404).json({ error: 'Набор не загружен или пуст' });
    const batch = store.transaction(() => store.add('batch', { group_id, checklist_version,
      job_ids: conversations.map(c => enqueue(c.id, checklist_version).id) }));
    res.status(202).location(`/api/evaluation-batches/${batch.id}`).json(batchView(batch));
  });
  app.get('/api/evaluation-batches', (req, res) => res.json(store.list('batch').map(batchView)));
  app.get('/api/evaluation-batches/:id', (req, res) => res.json(batchView(get('batch', req.params.id))));
  app.post('/api/evaluation-batches/:id/retry', (req, res) => {
    const previous = get('batch', req.params.id);
    if (typeof evaluateDialogue !== 'function') return res.status(503).json({ error: 'Модуль ИИ ещё не подключён' });
    const failed = previous.job_ids.map(id => get('job', id)).filter(j => j.status === 'failed');
    if (!failed.length) return res.status(409).json({ error: 'В пакете нет ошибок для повторной оценки' });
    const batch = store.transaction(() => store.add('batch', { group_id: previous.group_id,
      checklist_version: previous.checklist_version, retry_of: previous.id,
      job_ids: failed.map(j => enqueue(j.conversation_id, j.checklist_version).id) }));
    res.status(202).json(batchView(batch));
  });
  app.get('/api/evaluation-jobs', (req, res) => res.json(store.list('job')));
  app.get('/api/evaluation-jobs/:id', (req, res) => res.json(get('job', req.params.id)));
}
