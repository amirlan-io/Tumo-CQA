import { AsyncLocalStorage } from 'node:async_hooks';
import {
  CliError, aiSettings, apiBase, argumentsFor, attemptRecord, canonical, checklistVersion,
  datasetRecords, findConversation, freeze, isMain, languages, loadAi, measureEvaluation,
  normalizeConversation, printError, protectInputs, readJson, required, safeError, sha256,
  sourceSnapshot, text, validateOutput, validateResultSet, writePrivateJson
} from './ai-common.js';

const help = `Последовательный benchmark реальных моделей по неизменяемому gold.

node --env-file-if-exists=.env scripts/ai-benchmark.js \\
  --version <UUID> --dataset <path> [параметры]

  --api-base <URL>       default: http://127.0.0.1:3000
  --version <UUID>       обязательная сохранённая версия (не latest)
  --dataset <path>       обязательный локальный набор диалогов
  --gold <path>          default: tests/fixtures/ai-gold.draft.json
  --models <a,b>         default: AI_MODEL (или model AI-модуля),openai/gpt-4.1-mini
  --output <path>        default: data/ai-results/benchmark.json
  --allow-draft         разрешить неутверждённый gold; report всегда preliminary
  -h, --help

Без --allow-draft нужны status=approved и непустой approved_by.
Нужен AI_API_KEY. .env загружает только node --env-file-if-exists=.env.
Оценки платные; transcript передаётся AI-провайдеру, но не включается в report.
Несовпадения answer+raw_score и сбои дают exitCode=1; evidence требует ручного аудита.`;

export function checkApproval(gold, allowDraft) {
  if (!gold || !['draft', 'approved'].includes(gold.status))
    throw new CliError('Gold должен иметь status draft или approved.', 'invalid_gold');
  if (!allowDraft && (gold.status !== 'approved' || !text(gold.approved_by)))
    throw new CliError('Gold не утверждён: нужны status=approved и непустой approved_by. Для предварительного прогона есть --allow-draft.', 'invalid_gold');
}

export function prepareCases(gold, records, version, allowDraft) {
  checkApproval(gold, allowDraft);
  if (!Array.isArray(gold.checklist_criteria)
    || canonical(gold.checklist_criteria) !== canonical(version.criteria))
    throw new CliError('Полный snapshot критериев gold не совпал с выбранной API-версией. Сначала пересмотрите и согласуйте gold.', 'invalid_gold');
  if (!Array.isArray(gold.cases) || gold.cases.length < 9)
    throw new CliError('В gold нужно не менее 9 кейсов.', 'invalid_gold');
  const ids = new Set();
  const counts = Object.fromEntries(languages.map(language => [language, 0]));
  let hasVoice = false;
  let hasNa = false;
  let hasGrossError = false;
  const cases = gold.cases.map(entry => {
    if (!entry || !text(entry.conversation_id) || ids.has(entry.conversation_id)
      || !languages.includes(entry.language) || !['agent chat', 'voice call'].includes(entry.channel))
      throw new CliError('Gold: неверный или повторный ID, язык или канал кейса.', 'invalid_gold');
    ids.add(entry.conversation_id);
    const conversation = normalizeConversation(findConversation(records, entry.conversation_id));
    if (conversation.language !== entry.language || conversation.channel !== entry.channel)
      throw new CliError('Язык или канал кейса gold не совпал с dataset.', 'invalid_gold');
    try { validateResultSet(entry.results, conversation, version); } catch {
      throw new CliError('Gold: невалидные результаты, evidence или checked_range для реального диалога.', 'invalid_gold');
    }
    counts[entry.language]++;
    hasVoice ||= entry.channel === 'voice call';
    hasNa ||= entry.results.some(r => r.answer === 'na');
    hasGrossError ||= entry.results.some(r => r.answer === 'yes'
      && version.criteria.some(c => c.criterion_id === r.criterion_id && c.is_gross_error));
    return { conversation: freeze(structuredClone(conversation)), gold: freeze(structuredClone(entry)) };
  });
  if (languages.some(language => counts[language] < 3) || !hasVoice || !hasNa || !hasGrossError)
    throw new CliError('Gold: нужно >=3 кейса для каждого RU/KZ/EN, voice call, N/A и yes для is_gross_error.', 'invalid_gold');
  return freeze(cases);
}

export function selectedModels(value, defaultModel) {
  const models = value === undefined ? [process.env.AI_MODEL || defaultModel, 'openai/gpt-4.1-mini']
    : value.split(',').map(model => model.trim());
  if (models.some(model => !text(model) || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$/.test(model)))
    throw new CliError('--models должен содержать непустые ID моделей через запятую.');
  return [...new Set(models)];
}

const evidence = result => ({
  evidence_message_nos: [...new Set(result.evidence_message_nos)].sort((a, b) => a - b),
  checked_range: result.checked_range == null ? null
    : { from: result.checked_range.from, to: result.checked_range.to }
});

function summarize(rows) {
  const completed = rows.filter(row => row.output !== null);
  const matched = completed.reduce((sum, row) => sum + row.matched_criteria, 0);
  return { count: rows.length, completed: completed.length, failed: rows.length - completed.length,
    matched_criteria: matched, mismatched_criteria: completed.length * 8 - matched,
    mismatched_cases: completed.filter(row => row.status === 'mismatch').length,
    criteria_accuracy: completed.length ? matched / (completed.length * 8) : null,
    criteria_accuracy_including_failed: rows.length ? matched / (rows.length * 8) : null,
    mean_latency_ms: rows.length ? Math.round(rows.reduce((sum, row) => sum + row.latency_ms, 0) / rows.length) : null,
    attempt_count: rows.reduce((sum, row) => sum + row.attempt_count, 0),
    json_error_attempts: rows.reduce((sum, row) => sum + row.json_error_attempts, 0),
    needs_human_review: rows.reduce((sum, row) => sum + row.needs_human_review.length, 0) };
}

export async function runModel({ model, ai, settings, cases, version, assertContract = async () => {} }) {
  const report = { model, status: 'completed', cases: [], errors: [], failures: [], needs_human_review: [] };
  const context = new AsyncLocalStorage();
  let evaluate;
  let setupError;
  try {
    await assertContract();
    evaluate = ai.createEvaluator({ ...settings, model, onAttempt(event) {
      const active = context.getStore();
      if (active?.open) active.records.push(attemptRecord(event));
    } });
    if (typeof evaluate !== 'function') throw new CliError('createEvaluator не вернул функцию.');
  } catch (error) { setupError = error; }

  for (const entry of cases) {
    const conversation = entry.conversation;
    const reference = { model, conversation_id: entry.gold.conversation_id,
      language: entry.gold.language, channel: entry.gold.channel };
    const row = { conversation_id: reference.conversation_id, language: reference.language, channel: reference.channel,
      status: 'failed', latency_ms: 0, attempt_count: 0, json_error_attempts: 0, attempts: [],
      matched_criteria: null, total_criteria: 8, needs_human_review: [], output: null };
    const active = { records: [], open: true };
    let error = setupError;
    if (!error) {
      try { await assertContract(); } catch (cause) { error = setupError = cause; }
    }
    if (!error) {
      const measured = await context.run(active, () => measureEvaluation(evaluate,
        conversation, version, settings.timeoutMs));
      active.open = false;
      row.latency_ms = measured.latency_ms;
      error = measured.error;
      if (!error) {
        try {
          // Keep the actual validated model output, not a reconstructed or gold-corrected result.
          const output = structuredClone(measured.output);
          validateOutput(output, conversation, version, model, ai.prompt_version);
          row.output = output;
        } catch (cause) { error = cause; }
      }
    }
    active.open = false;
    row.attempts = active.records;
    row.attempt_count = row.attempts.length;
    row.json_error_attempts = row.attempts.filter(attempt =>
      ['invalid', 'invalid_json', 'schema_error', 'validation_error'].includes(attempt.status)).length;
    if (error) {
      const safe = safeError(error, row.attempts);
      const problem = { ...reference, ...safe };
      if (error instanceof CliError && error.evidence_issues?.length)
        problem.evidence_issues = error.evidence_issues;
      if (safe.kind === 'invalid_output') {
        row.status = 'invalid_output';
        report.errors.push(problem);
      } else report.failures.push(problem);
    } else {
      row.matched_criteria = 0;
      for (const expected of entry.gold.results) {
        const actual = row.output.results.find(result => result.criterion_id === expected.criterion_id);
        if (actual.answer === expected.answer && actual.raw_score === expected.raw_score) row.matched_criteria++;
        else report.errors.push({ ...reference, kind: 'answer_score_mismatch', criterion_id: expected.criterion_id,
          expected: { answer: expected.answer, raw_score: expected.raw_score },
          actual: { answer: actual.answer, raw_score: actual.raw_score } });
        const expectedEvidence = evidence(expected);
        const actualEvidence = evidence(actual);
        if (canonical(expectedEvidence) !== canonical(actualEvidence)) {
          row.needs_human_review.push(expected.criterion_id);
          report.needs_human_review.push({ ...reference, criterion_id: expected.criterion_id,
            status: 'needs_human_review', reason: 'evidence_differs_from_gold',
            expected: expectedEvidence, actual: actualEvidence });
        }
      }
      row.status = row.matched_criteria === 8 ? 'matched' : 'mismatch';
    }
    report.cases.push(row);
  }
  report.summary = summarize(report.cases);
  report.languages = Object.fromEntries(languages.map(language =>
    [language, summarize(report.cases.filter(row => row.language === language))]));
  if (report.errors.length || report.failures.length) report.status = 'failed';
  return report;
}

export async function main(args) {
  const values = argumentsFor({
    'api-base': { type: 'string', default: 'http://127.0.0.1:3000' }, version: { type: 'string' },
    dataset: { type: 'string' }, gold: { type: 'string', default: 'tests/fixtures/ai-gold.draft.json' },
    models: { type: 'string' }, output: { type: 'string', default: 'data/ai-results/benchmark.json' },
    'allow-draft': { type: 'boolean', default: false }
  }, args);
  if (values.help) { console.log(help); return; }
  const versionId = required(values, 'version');
  required(values, 'dataset');
  required(values, 'gold');
  required(values, 'output');
  protectInputs(values.output, [values.dataset, values.gold]);
  const base = apiBase(values['api-base']);
  const settings = aiSettings();
  const gold = freeze(await readJson(values.gold, 'gold'));
  checkApproval(gold, values['allow-draft']);
  const records = datasetRecords(await readJson(values.dataset, 'dataset'));
  const version = freeze(await checklistVersion(base, versionId));
  const cases = prepareCases(gold, records, version, values['allow-draft']);
  const sources = await sourceSnapshot();
  const sourcesHash = sha256(sources);
  const assertContract = async () => {
    if (sha256(await sourceSnapshot()) !== sourcesHash)
      throw new CliError('Исходники промпта/схемы изменились во время benchmark; сравнение недействительно.', 'contract_changed');
  };
  const ai = await loadAi();
  await assertContract();
  const models = selectedModels(values.models, ai.model);
  if (models.some(model => model.includes(settings.apiKey)))
    throw new CliError('ID модели содержит API key; запуск отменён.');
  const frozen = freeze({ model_independent: true, prompt_version: ai.prompt_version,
    prompt_schema_sources_sha256: sources, prompt_schema_sha256: sourcesHash,
    checklist_version: version.id, checklist_id: version.checklist_id,
    checklist_criteria: structuredClone(version.criteria), rounding_digits: version.rounding_digits,
    gold_sha256: sha256(gold), gold_status: gold.status, approved_by: gold.approved_by ?? null,
    input_sha256: sha256(cases.map(entry => entry.conversation)),
    cases: cases.map(entry => ({ conversation_id: entry.gold.conversation_id,
      language: entry.gold.language, channel: entry.gold.channel,
      input_sha256: sha256(entry.conversation), gold_results_sha256: sha256(entry.gold.results) })) });
  const report = { status: 'running', preliminary: values['allow-draft'],
    started_at: new Date().toISOString(), frozen,
    methodology: {
      comparison: 'Exact answer AND raw_score, 8 criteria per case; no fallback model; sequential.',
      attempt_count: 'Number of onAttempt HTTP-response callbacks; unanswered network requests are not observable.',
      json_error_attempts: 'onAttempt invalid/invalid_json/schema_error/validation_error responses (JSON syntax or schema).',
      evidence: 'Indices/ranges are validated. Differences from gold only need human review; matching references do not guarantee semantic correctness.',
      privacy: 'No input transcript, audio URL, API key or raw provider error bodies. Valid model outputs are retained verbatim.'
    }, models: [], errors: [], failures: [], needs_human_review: [] };
  console.log(`${report.preliminary ? 'PRELIMINARY: ' : ''}${models.length} моделей × ${cases.length} кейсов. Реальные платные запросы, последовательно, без fallback.`);
  for (const model of models) {
    const result = await runModel({ model, ai, settings, cases, version, assertContract });
    report.models.push(result);
    report.errors.push(...result.errors);
    report.failures.push(...result.failures);
    report.needs_human_review.push(...result.needs_human_review);
  }
  try { await assertContract(); } catch (error) { report.failures.push(safeError(error)); }
  report.status = report.errors.length || report.failures.length ? 'failed' : 'completed';
  report.finished_at = new Date().toISOString();
  await writePrivateJson(values.output, report, settings.apiKey);
  console.table(report.models.flatMap(result => [['ALL', result.summary], ...Object.entries(result.languages)]
    .map(([language, stats]) => ({ model: result.model, language, count: stats.count, failed: stats.failed,
      matched_criteria: stats.matched_criteria, mismatched_criteria: stats.mismatched_criteria,
      accuracy: stats.criteria_accuracy === null ? 'n/a' : `${(100 * stats.criteria_accuracy).toFixed(1)}%`,
      latency_ms: stats.mean_latency_ms, attempts: stats.attempt_count, json_errors: stats.json_error_attempts,
      review: stats.needs_human_review }))));
  console.log(`Report: ${report.status}${report.preliminary ? ' (preliminary)' : ''}. Errors: ${report.errors.length}; failures: ${report.failures.length}; evidence needs_human_review: ${report.needs_human_review.length}.`);
  console.log('Evidence не признаны семантически верными автоматически: нужен ручной аудит ссылок и checked_range.');
  if (report.status === 'failed') process.exitCode = 1;
}

if (isMain(import.meta.url)) main().catch(printError);
