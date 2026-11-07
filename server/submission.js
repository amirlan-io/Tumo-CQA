import { defaultConfig, validateConfig } from './checklists.js';
import { validateResults } from './validate-results.js';
import { calculateScore } from './score.js';
const codes = ['contact','discovery','identification','consultation','empathy','dialogue','closure','critical'];
const fail = message => { throw Object.assign(new Error(message), {status:400}); };
export function buildSubmission(store, { dataset, group_id, checklist_version, model, mode = 'external_api', team_name = 'Tumo' } = {}) {
  if (!['dev','prod'].includes(dataset) || typeof group_id !== 'string' || !group_id.trim()
    || !['local','external_api','hybrid'].includes(mode) || typeof model !== 'string' || !model.trim()
    || typeof team_name !== 'string' || !team_name.trim()) fail('Нужны dataset dev/prod, group_id, checklist_version, model и корректный mode');
  if (group_id === 'DEMO') fail('Демонстрационная группа не предназначена для сдачи');
  const version = store.get('checklist_version', checklist_version);
  if (!version) fail('Версия чек-листа не найдена');
  const expected = validateConfig(defaultConfig).criteria;
  if (JSON.stringify(version.criteria) !== JSON.stringify(expected)) fail('Для формата 1.0 нужна исходная рубрика из восьми критериев. Изменённый чек-лист требует согласованного соответствия');
  const conversations = store.list('conversation').filter(c => c.group_id === group_id);
  if (conversations.length !== (dataset === 'dev' ? 65 : 10)) fail('Неверное число диалогов: DEV должен содержать 65, PROD — 10');
  if (new Set(conversations.map(c => c.conversation_id)).size !== conversations.length) fail('Повторяющиеся conversation_id');
  if (dataset === 'prod' && conversations.some(c => c.channel !== 'agent chat')) fail('PROD должен содержать только чаты');
  if (dataset === 'dev' && (conversations.filter(c => c.channel === 'agent chat').length !== 60
    || conversations.filter(c => c.channel === 'voice call').length !== 5)) fail('DEV должен содержать 60 чатов и 5 звонков');
  const jobs = store.list('job');
  const results = conversations.map(c => {
    const candidates = jobs.filter(j => j.conversation_id === c.id && j.checklist_version === checklist_version);
    const job = candidates.at(-1);
    const error = reason => ({conversation_id:c.conversation_id,status:'error',criteria:[],score:null,error:reason});
    if (!job) return error('Оценка ИИ не запускалась');
    if (job.status !== 'completed') return error(job.status === 'failed' ? 'Не удалось получить корректный ответ модели' : 'Оценка ещё не завершена');
    const evaluation = store.get('evaluation', job.evaluation_id);
    if (!evaluation || evaluation.conversation_id !== c.id || evaluation.checklist_version !== checklist_version
      || evaluation.model !== model || !evaluation.prompt_version) return error('Нет подтверждённой оценки выбранной модели');
    try { validateResults(c, version, evaluation.results); } catch { return error('Сохранённая оценка не прошла проверку'); }
    const score = calculateScore(version,evaluation.results);
    if (score.total === null) return error('Итог не рассчитывается: нет применимых весов');
    return {conversation_id:c.conversation_id,status:'ok',criteria:expected.map((criterion,i)=>{
      const r=evaluation.results.find(r=>r.criterion_id===criterion.criterion_id);
      const turns = r.evidence_message_nos.length ? r.evidence_message_nos : r.checked_range
        ? Array.from({length:r.checked_range.to-r.checked_range.from+1},(_,n)=>r.checked_range.from+n) : [];
      return {criterion_id:codes[i],value:r.answer==='na'?null:r.answer==='scale'?r.raw_score:r.answer==='yes',
        rationale:r.answer==='na'?r.explanation+' Причина N/A: '+r.na_reason:r.explanation,evidence_turns:turns};
    }),score:{final_score:score.total,critical_flag:score.gross_error}};
  });
  return {schema_version:'1.0',team_name:team_name.trim(),model:{mode,name:model},results};
}
