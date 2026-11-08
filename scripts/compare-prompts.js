import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareCases } from './ai-benchmark.js';
import { runModel } from './ai-benchmark.js';
import {
  CliError, argumentsFor, required, readJson, datasetRecords, aiSettings, loadAi, sourceSnapshot,
  sha256, writePrivateJson, protectInputs, isMain, printError, languages
} from './ai-common.js';

const help = `Парное сравнение промптов без изменения официальной выгрузки.

npm run ai:compare-prompts -- --dataset <path> --version-file <snapshot> --allow-draft

  --suite development|holdout|all    default: all; holdout размечен до первого прогона v2
  --development-gold <path>          default: tests/fixtures/ai-gold.draft.json
  --holdout-gold <path>              default: tests/fixtures/ai-holdout.draft.json
  --prompts <v1,v2>                  default: v1,v2; одна и та же модель, конфигурация и схема
  --delay-ms <0..60000>              целое число; default: 4000; между вызовами, вне latency
  --output <path>                    default: data/ai-results/prompt-comparison-<time>.json
  --allow-draft                      требуется для неподтверждённых людьми labels

Порядок версий чередуется между диалогами. Обе версии вызываются заново на каждом диалоге.
Разметка не передаётся модели. Промпт и метрики не меняются во время опыта.
Несовпадение с draft — не доказанная ошибка; совпавшие ссылки требуют проверки по смыслу.
Официальные results/dev/results.json и журнал полного DEV не перезаписываются.
`;

export function comparisonStats(cases, promptVersion) {
  let matched = 0, clearMatched = 0, clearTotal = 0;
  const evaluations = cases.map(c => c.evaluations[promptVersion]).filter(Boolean);
  for (const entry of cases) {
    const output = entry.evaluations[promptVersion]?.output;
    const uncertain = new Set(entry.uncertain_criterion_ids);
    for (const expected of entry.expected) {
      const actual = output?.results.find(r => r.criterion_id === expected.criterion_id);
      const agrees = actual?.answer === expected.answer && actual?.raw_score === expected.raw_score;
      if (agrees) matched++;
      if (!uncertain.has(expected.criterion_id)) {
        clearTotal++;
        if (agrees) clearMatched++;
      }
    }
  }
  const completed = evaluations.filter(e => e.output).length;
  return { cases: cases.length, evaluated: evaluations.length, completed, failed: evaluations.length - completed,
    matched_criteria: matched, total_criteria: cases.length * 8,
    agreement: cases.length ? matched / (cases.length * 8) : null,
    predeclared_clear_matched: clearMatched, predeclared_clear_total: clearTotal,
    predeclared_clear_agreement: clearTotal ? clearMatched / clearTotal : null,
    mean_latency_ms: evaluations.length ? Math.round(evaluations.reduce((n, e) => n + e.latency_ms, 0) / evaluations.length) : null,
    attempts: evaluations.reduce((n, e) => n + e.attempt_count, 0),
    json_contract_error_attempts: evaluations.reduce((n, e) => n + e.json_error_attempts, 0) };
}

export function summarizeComparison(report) {
  return Object.fromEntries(Object.keys(report.suites).map(suite => {
    const cases = report.cases.filter(c => c.suite === suite);
    return [suite, Object.fromEntries(report.prompts.map(prompt => [prompt, {
      all: comparisonStats(cases, prompt),
      languages: Object.fromEntries(languages.map(language => [language, comparisonStats(cases.filter(c => c.language === language), prompt)]))
    }]))];
  }));
}

function validateDelay(delayMs) {
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60000)
    throw new CliError('--delay-ms должен быть целым числом от 0 до 60000.');
  return delayMs;
}

export async function comparePrompts({ suites, model, prompts, ai, settings, version, delayMs = 0, wait = delay,
  assertContract = async () => {}, onCheckpoint = async () => {} }) {
  validateDelay(delayMs);
  if (prompts.length < 2 || new Set(prompts).size !== prompts.length)
    throw new CliError('Для сравнения нужны минимум две разные версии промпта.');
  for (const cases of Object.values(suites)) for (const entry of cases) {
    const uncertain = entry.gold.uncertain_criterion_ids ?? [];
    if (!Array.isArray(uncertain) || new Set(uncertain).size !== uncertain.length
      || uncertain.some(id => !version.criteria.some(c => c.criterion_id === id)))
      throw new CliError('Некорректные заранее объявленные uncertain_criterion_ids.', 'invalid_gold');
  }
  const report = { schema_version: 'prompt-comparison-1.0', status: 'running', preliminary: true,
    started_at: new Date().toISOString(), model, prompts,
    suites: Object.fromEntries(Object.entries(suites).map(([name, cases]) => [name, { cases: cases.length }])),
    methodology: {
      design: 'Fresh paired calls; prompt order alternates by case; same input, rubric, model and JSON contract.',
      delay_ms: delayMs,
      pacing: 'Wait only between evaluator calls, outside measured evaluation latency.',
      labels: 'Agent draft, not human-approved or organizer ground truth. Labels never enter model requests.',
      holdout: 'Held out from prompt design, not unseen by the earlier full-DEV v1 run.',
      clear_subset: 'Only predeclared uncertain_criterion_ids are excluded; no post-hoc exclusions.',
      evidence: 'Semantic correctness must be audited against source; numeric references alone are not proof.'
    }, cases: [] };
  let index = 0, evaluated = 0;
  for (const [suite, cases] of Object.entries(suites)) for (const entry of cases) {
    const uncertain = entry.gold.uncertain_criterion_ids ?? [];
    const order = index++ % 2 ? [...prompts].reverse() : [...prompts];
    const row = { suite, conversation_id: entry.gold.conversation_id, language: entry.gold.language,
      channel: entry.gold.channel, prompt_order: order, uncertain_criterion_ids: uncertain,
      expected: entry.gold.results.map(({ criterion_id, answer, raw_score }) => ({ criterion_id, answer, raw_score })),
      evaluations: {} };
    report.cases.push(row);
    for (const promptVersion of order) {
      if (evaluated && delayMs) await wait(delayMs);
      await assertContract();
      const wrappedAi = { prompt_version: promptVersion,
        createEvaluator: options => ai.createEvaluator({ ...options, promptVersion }) };
      const result = await runModel({ model, ai: wrappedAi, settings, cases: [entry], version, assertContract });
      evaluated++;
      row.evaluations[promptVersion] = { ...result.cases[0], errors: result.errors, failures: result.failures };
      report.summary = summarizeComparison(report);
      await onCheckpoint(report);
    }
  }
  await assertContract();
  report.summary = summarizeComparison(report);
  report.status = report.cases.some(c => prompts.some(p => !c.evaluations[p]?.output)) ? 'completed_with_failures' : 'completed';
  report.finished_at = new Date().toISOString();
  await onCheckpoint(report);
  return report;
}

async function snapshot() {
  return { ...await sourceSnapshot(),
    'scripts/compare-prompts.js': sha256(await readFile(new URL('./compare-prompts.js', import.meta.url), 'utf8')),
    'scripts/ai-common.js': sha256(await readFile(new URL('./ai-common.js', import.meta.url), 'utf8')) };
}

export async function main(args) {
  const values = argumentsFor({ dataset: { type: 'string' }, 'version-file': { type: 'string' },
    suite: { type: 'string', default: 'all' }, prompts: { type: 'string', default: 'v1,v2' },
    'delay-ms': { type: 'string', default: '4000' },
    'development-gold': { type: 'string', default: 'tests/fixtures/ai-gold.draft.json' },
    'holdout-gold': { type: 'string', default: 'tests/fixtures/ai-holdout.draft.json' },
    output: { type: 'string' }, 'allow-draft': { type: 'boolean', default: false } }, args);
  if (values.help) { console.log(help); return; }
  const delayMs = validateDelay(/^\d+$/.test(values['delay-ms']) ? Number(values['delay-ms']) : NaN);
  const datasetPath = required(values, 'dataset');
  const versionPath = required(values, 'version-file');
  if (!['all', 'development', 'holdout'].includes(values.suite)) throw new CliError('Нужен --suite development, holdout или all.');
  const outputPath = values.output ?? `data/ai-results/prompt-comparison-${values.suite}-${Date.now()}.json`;
  protectInputs(outputPath, [datasetPath, versionPath, values['development-gold'], values['holdout-gold']]);
  if (/[\\/]results[\\/](?:dev|prod)[\\/]results\.json$/.test(resolve(outputPath)) || existsSync(outputPath))
    throw new CliError('Отчёт сравнения не может заменять официальный results.json или существующий файл; выберите новый --output.');
  const settings = aiSettings();
  const ai = await loadAi();
  const prompts = values.prompts.split(',').map(v => v.trim());
  if (!Array.isArray(ai.supportedPromptVersions) || prompts.some(p => !ai.supportedPromptVersions.includes(p))
    || prompts.length < 2 || new Set(prompts).size !== prompts.length)
    throw new CliError('Укажите разные поддерживаемые версии промпта, например v1,v2.');
  const records = datasetRecords(await readJson(datasetPath, 'dataset'));
  const version = await readJson(versionPath, 'snapshot версии из API');
  const suites = {}, goldHashes = {};
  for (const suite of values.suite === 'all' ? ['development', 'holdout'] : [values.suite]) {
    const gold = await readJson(values[`${suite}-gold`], `gold ${suite}`);
    suites[suite] = prepareCases(gold, records, version, values['allow-draft']);
    goldHashes[suite] = sha256(gold);
  }
  if (suites.development && suites.holdout) {
    const ids = new Set(suites.development.map(e => e.gold.conversation_id));
    if (suites.holdout.some(e => ids.has(e.gold.conversation_id))) throw new CliError('Holdout пересекается с development.', 'invalid_gold');
  }
  const frozenSources = await snapshot();
  const frozen = {
    delay_ms: delayMs,
    source_sha256: frozenSources, gold_sha256: goldHashes, version_sha256: sha256(version),
    input_sha256: sha256(Object.fromEntries(Object.entries(suites).map(([name, cases]) => [name, cases.map(c => c.conversation)]))),
    request_settings: { temperature: 0, max_tokens: Number(process.env.AI_MAX_TOKENS ?? 4096),
      structured_output: process.env.AI_STRUCTURED_OUTPUT ?? 'json_schema', provider: process.env.AI_PROVIDER ?? null,
      reasoning_effort: process.env.AI_REASONING_EFFORT ?? (ai.model === 'stealth/crouton-alpha' ? 'minimal' : null),
      timeout_ms: settings.timeoutMs, request_timeout_ms: settings.requestTimeoutMs }
  };
  const assertContract = async () => {
    if (sha256(await snapshot()) !== sha256(frozenSources)) throw new CliError('Промпт или реализация изменились во время опыта; сравнение остановлено.', 'contract_changed');
  };
  const report = await comparePrompts({ suites, model: ai.model, prompts, ai, settings, version, delayMs, assertContract,
    onCheckpoint: async current => {
      await writePrivateJson(outputPath, { ...current, frozen }, settings.apiKey);
      const row = current.cases.at(-1);
      if (row) console.log(JSON.stringify({ suite: row.suite, id: row.conversation_id,
        completed_prompts: Object.keys(row.evaluations), status: current.status }));
    } });
  console.table(Object.entries(report.summary).flatMap(([suite, versions]) => Object.entries(versions).map(([prompt, stats]) => ({
    suite, prompt, matched: `${stats.all.matched_criteria}/${stats.all.total_criteria}`,
    predeclared_clear: `${stats.all.predeclared_clear_matched}/${stats.all.predeclared_clear_total}`,
    failed: stats.all.failed, mean_latency_ms: stats.all.mean_latency_ms, attempts: stats.all.attempts,
    json_contract_errors: stats.all.json_contract_error_attempts }))));
  console.log(`Report: ${outputPath}; ${report.status}; preliminary labels, not official accuracy.`);
  if (report.status !== 'completed') process.exitCode = 1;
}

if (isMain(import.meta.url)) main().catch(printError);
