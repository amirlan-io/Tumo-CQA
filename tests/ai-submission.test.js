import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { defaultConfig, validateConfig } from '../server/checklists.js';
import { calculateScore } from '../server/score.js';
import { prepareInput, createOutputContract } from '../server/services/ai-contract.js';
import { buildSubmission, validateSubmission, validateSubmissionVersion, officialCriteria } from '../server/services/submission.js';

// Only synthetic transcripts and outputs: no provider, credentials or private dataset.
const MODEL = 'synthetic/submission-model';
const CODES = ['contact', 'discovery', 'identification', 'consultation', 'empathy', 'dialogue', 'closure', 'critical'];
const SAFE_ERROR = 'Не удалось получить ответ модели за отведённое время.';
const AUDIO_URL = 'https://audio.example.invalid/private.wav?signature=synthetic-private-value';

function fullResults(version) {
  return version.criteria.map(criterion => ({
    criterion_id: criterion.criterion_id,
    answer: criterion.is_gross_error ? 'no' : criterion.answer_type === 'scale' ? 'scale' : 'yes',
    raw_score: criterion.is_gross_error ? null : criterion.answer_type === 'scale'
      ? Math.max(...criterion.scale.map(step => step.value)) : 1,
    explanation: `Критерий ${criterion.criterion_id} проверен по исходным репликам.`,
    evidence_message_nos: criterion.is_gross_error ? [] : [6, 4],
    checked_range: criterion.is_gross_error ? { from: 1, to: 6 } : null,
    na_reason: null
  }));
}

function fixture(split = 'prod') {
  const version = { ...validateConfig(defaultConfig), id: 'synthetic-version-id', version: 1 };
  const conversations = Array.from({ length: split === 'dev' ? 65 : 10 }, (_, index) => ({
    id: `database-uuid-not-the-source-${index}`,
    conversation_id: `synthetic-source-${split}-${index + 1}`,
    channel: split === 'dev' && index >= 60 ? 'voice call' : 'agent chat',
    language: ['RU', 'KZ', 'EN'][index % 3],
    audio_url: AUDIO_URL,
    transcript: [
      { speaker: 'client', text: 'Здравствуйте. Где посмотреть историю операций?' },
      { speaker: 'system', text: 'SYNTHETIC_PRIVATE_TRANSCRIPT_EVENT' },
      { speaker: 'bot', text: 'Запрос передан оператору.' },
      { speaker: 'operator', text: 'Здравствуйте! Меня зовут Анна.' },
      { speaker: 'client', text: 'Нужна история за прошлый месяц.' },
      { speaker: 'operator', text: 'Откройте «Историю» и выберите месяц. Если нужна помощь, напишите. До свидания!' }
    ].map((message, messageIndex) => ({ ...message,
      timestamp: `2026-01-01T10:00:0${messageIndex}Z`, message_no: 700 + messageIndex }))
  }));
  const evaluations = conversations.map(conversation => ({ conversation_id: conversation.conversation_id,
    status: 'ok', output: { model: MODEL, prompt_version: 'synthetic-v1', results: fullResults(version) } }));
  return { teamName: 'Синтетическая команда', modelName: MODEL, conversations, version, evaluations, split };
}

function change(input, criterionId, fields, conversationIndex = 0) {
  const result = input.evaluations[conversationIndex].output.results.find(result => result.criterion_id === criterionId);
  assert.ok(result);
  Object.assign(result, fields);
  return result;
}

function official(document, code, conversationIndex = 0) {
  return document.results[conversationIndex].criteria.find(criterion => criterion.criterion_id === code);
}

function errorEvaluation(input, index = 0, error = SAFE_ERROR) {
  input.evaluations[index] = { conversation_id: input.conversations[index].conversation_id, status: 'error', error };
}

function keysReversed(object) {
  return Object.fromEntries(Object.entries(object).reverse());
}

test('builds the exact official PROD document using source IDs, fixed code order and server scores', () => {
  const input = fixture();
  const before = structuredClone(input);
  const document = buildSubmission(input);
  assert.deepEqual(officialCriteria, CODES);
  assert.ok(Object.isFrozen(officialCriteria));
  assert.deepEqual(Object.keys(document), ['schema_version', 'team_name', 'model', 'results']);
  assert.equal(document.schema_version, '1.0');
  assert.equal(document.team_name, input.teamName);
  assert.deepEqual(document.model, { mode: 'external_api', name: MODEL });
  assert.equal(document.results.length, 10);
  for (const [index, row] of document.results.entries()) {
    assert.deepEqual(Object.keys(row), ['conversation_id', 'status', 'criteria', 'score']);
    assert.equal(row.conversation_id, input.conversations[index].conversation_id);
    assert.notEqual(row.conversation_id, input.conversations[index].id);
    assert.equal(row.status, 'ok');
    assert.deepEqual(row.criteria.map(criterion => criterion.criterion_id), CODES);
    for (const criterion of row.criteria) {
      assert.deepEqual(Object.keys(criterion), ['criterion_id', 'value', 'rationale', 'evidence_turns']);
    }
    assert.deepEqual(row.score, { final_score: calculateScore(input.version, input.evaluations[index].output.results).total,
      critical_flag: false });
  }
  assert.equal(validateSubmission(document, input), document);
  assert.deepEqual(input, before);
  const raw = JSON.stringify(document);
  for (const forbidden of ['transcript', 'audio_url', AUDIO_URL, 'SYNTHETIC_PRIVATE_TRANSCRIPT_EVENT', 'database-uuid', 'prompt_version']) {
    assert.ok(!raw.includes(forbidden), `Export must not include ${forbidden}`);
  }
});

test('DEV contains exactly 65 records, including all 60 chats, five calls and processing errors', () => {
  const input = fixture('dev');
  errorEvaluation(input, 62);
  const document = buildSubmission(input);
  assert.equal(document.results.length, 65);
  assert.deepEqual(document.results.map(row => row.conversation_id), input.conversations.map(row => row.conversation_id));
  assert.deepEqual(document.results[62], { conversation_id: input.conversations[62].conversation_id,
    status: 'error', criteria: [], score: null, error: SAFE_ERROR });
  assert.equal(validateSubmission(JSON.parse(JSON.stringify(document)), input).results.length, 65);
});

test('accepts unordered evaluations, answers, rubric criteria and object keys without changing official order', () => {
  const input = fixture();
  input.version.name = 'Другое название той же рубрики';
  input.version.criteria = input.version.criteria.reverse().map(criterion => keysReversed({ ...criterion,
    text: ` ${criterion.text} `, scale: criterion.scale.map(keysReversed) }));
  for (const evaluation of input.evaluations) evaluation.output.results.reverse();
  input.evaluations.reverse();
  assert.deepEqual(validateSubmissionVersion(input.version).criteria.map(criterion => criterion.criterion_id),
    CODES.map((_, index) => `c${index + 1}`));
  const document = buildSubmission(input);
  assert.deepEqual(document.results.map(row => row.conversation_id), input.conversations.map(row => row.conversation_id));
  assert.deepEqual(document.results[0].criteria.map(row => row.criterion_id), CODES);
  document.results.reverse();
  document.results[0].criteria.reverse();
  assert.equal(validateSubmission(document, input), document, 'Standalone validation checks exact sets, not incidental array order');
});

test('maps booleans and raw scale steps without confusing false, zero, null or weighted points', () => {
  const input = fixture();
  change(input, 'c1', { answer: 'no', raw_score: 0, checked_range: { from: 1, to: 4 } });
  change(input, 'c6', { raw_score: 7, checked_range: { from: 1, to: 6 } });
  const document = buildSubmission(input);
  assert.equal(official(document, 'contact').value, false);
  assert.equal(official(document, 'discovery').value, true);
  assert.equal(official(document, 'critical').value, false, 'The gross-error raw_score null is not N/A');
  assert.equal(official(document, 'dialogue').value, 7, 'Export the raw 7/10, not weighted 10.5/15');
  assert.equal(official(document, 'consultation').value, 20);
  assert.equal(document.results[0].score.final_score, 85.5);
});

test('supports every official consultation and dialogue step, including numeric zero', () => {
  const input = fixture();
  const consultation = [0, 5, 10, 15, 20];
  const dialogue = [0, 4, 7, 10];
  consultation.forEach((raw_score, index) => change(input, 'c4', { raw_score, checked_range: { from: 1, to: 6 } }, index));
  dialogue.forEach((raw_score, index) => change(input, 'c6', { raw_score, checked_range: { from: 1, to: 6 } }, index));
  const document = buildSubmission(input);
  consultation.forEach((value, index) => assert.equal(official(document, 'consultation', index).value, value));
  dialogue.forEach((value, index) => assert.equal(official(document, 'dialogue', index).value, value));
});

test('preserves explanations, explicit N/A reasons, and the sorted union of every checked-range index', () => {
  const input = fixture();
  const explanation = ' Исходное объяснение сохранено без переписывания. ';
  const reason = 'Данных для ответа хватало с самого начала.';
  for (const id of ['c2', 'c3', 'c4', 'c7']) {
    change(input, id, { answer: 'na', raw_score: null, explanation, na_reason: `${reason} ${id}`,
      evidence_message_nos: [6, 1, 3], checked_range: { from: 2, to: 4 } });
  }
  const before = structuredClone(input);
  const document = buildSubmission(input);
  for (const [code, id] of [['discovery', 'c2'], ['identification', 'c3'], ['consultation', 'c4'], ['closure', 'c7']]) {
    const criterion = official(document, code);
    assert.equal(criterion.value, null);
    assert.equal(criterion.rationale, `${explanation} Причина N/A: ${reason} ${id} Проверены реплики 2–4.`);
    assert.deepEqual(criterion.evidence_turns, [1, 2, 3, 4, 6], 'Include bot/system turns and interior indices, not just endpoints');
  }
  assert.deepEqual(official(document, 'critical').evidence_turns, [1, 2, 3, 4, 5, 6]);
  assert.match(official(document, 'critical').rationale, /Проверены реплики 1–6\.$/u);
  assert.equal(official(document, 'contact').rationale, input.evaluations[0].output.results[0].explanation);
  assert.deepEqual(official(document, 'contact').evidence_turns, [4, 6]);
  assert.equal(document.results[0].score.final_score, 100, 'N/A redistributes weights instead of treating null as zero');
  assert.deepEqual(input, before);
});

test('critical_flag follows critical even at a perfect or zero score; it never zeroes the score', () => {
  const input = fixture();
  change(input, 'c8', { answer: 'yes', evidence_message_nos: [4], checked_range: null });
  for (const criterion of input.version.criteria) {
    if (criterion.is_gross_error) continue;
    change(input, criterion.criterion_id, { answer: criterion.answer_type === 'scale' ? 'scale' : 'no',
      raw_score: 0, checked_range: { from: 1, to: 6 } }, 1);
  }
  const document = buildSubmission(input);
  assert.equal(official(document, 'critical').value, true);
  assert.deepEqual(document.results[0].score, { final_score: 100, critical_flag: true });
  assert.deepEqual(document.results[1].score, { final_score: 0, critical_flag: false });
});

test('uses existing N/A redistribution and rounding, including the half-up 50.625 → 50.63 case', () => {
  const input = fixture();
  change(input, 'c2', { answer: 'na', raw_score: null, na_reason: 'Данных достаточно.' });
  change(input, 'c3', { answer: 'no', raw_score: 0, checked_range: { from: 1, to: 6 } });
  change(input, 'c4', { raw_score: 15, checked_range: { from: 1, to: 6 } });
  change(input, 'c6', { raw_score: 7, checked_range: { from: 1, to: 6 } });
  change(input, 'c7', { answer: 'no', raw_score: 0, checked_range: { from: 1, to: 6 } });
  change(input, 'c3', { answer: 'na', raw_score: null, na_reason: 'Общий вопрос.' }, 1);
  change(input, 'c2', { answer: 'na', raw_score: null, na_reason: 'Запрос ясен.' }, 1);
  change(input, 'c4', { raw_score: 0, checked_range: { from: 1, to: 6 } }, 1);
  change(input, 'c3', { answer: 'na', raw_score: null, na_reason: 'Общий вопрос.' }, 2);
  change(input, 'c4', { raw_score: 0, checked_range: { from: 1, to: 6 } }, 2);
  change(input, 'c5', { answer: 'no', raw_score: 0, checked_range: { from: 1, to: 6 } }, 2);
  change(input, 'c6', { raw_score: 7, checked_range: { from: 1, to: 6 } }, 2);
  const document = buildSubmission(input);
  assert.deepEqual(document.results.slice(0, 3).map(row => row.score.final_score), [59.41, 69.23, 50.63]);
  for (let index = 0; index < 3; index++) {
    assert.equal(document.results[index].score.final_score, calculateScore(input.version, input.evaluations[index].output.results).total);
  }
});

test('error records retain safe reasons and IDs without fabricated outputs, N/A or zero scores', () => {
  const input = fixture();
  input.conversations[0].transcript = [];
  input.conversations[1].language = 'unsupported';
  for (let index = 0; index < input.evaluations.length; index++) errorEvaluation(input, index);
  const document = buildSubmission(input);
  assert.equal(document.results.length, 10);
  for (const [index, row] of document.results.entries()) {
    assert.deepEqual(row, { conversation_id: input.conversations[index].conversation_id,
      status: 'error', criteria: [], score: null, error: SAFE_ERROR });
  }
  assert.equal(validateSubmission(document, input), document);
});

test('validates all model modes, nonempty team/model names and every successful output metadata', async t => {
  for (const modelMode of ['local', 'external_api', 'hybrid']) {
    const input = fixture();
    assert.equal(buildSubmission({ ...input, modelMode }).model.mode, modelMode);
  }
  const cases = [
    ['blank team', input => { input.teamName = '  '; }],
    ['blank model', input => { input.modelName = ''; }],
    ['invalid mode', input => { input.modelMode = 'cloud'; }],
    ['missing output model', input => { delete input.evaluations[0].output.model; }],
    ['mismatched model in last output', input => { input.evaluations.at(-1).output.model = 'different/model'; }],
    ['missing prompt version', input => { delete input.evaluations[0].output.prompt_version; }],
    ['blank prompt version in last output', input => { input.evaluations.at(-1).output.prompt_version = ' \n '; }],
    ['non-string prompt version', input => { input.evaluations[0].output.prompt_version = 1; }],
    ['extra output metadata', input => { input.evaluations[0].output.score = 100; }],
    ['extra undefined output metadata', input => { input.evaluations[0].output.extra = undefined; }]
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const input = fixture();
    mutate(input);
    assert.throws(() => buildSubmission(input));
  });
});

test('requires exactly one unmixed evaluation per original conversation', async t => {
  const cases = [
    ['missing evaluation', input => { input.evaluations.pop(); }],
    ['extra evaluation', input => { input.evaluations.push(structuredClone(input.evaluations[0])); }],
    ['duplicate ID', input => { input.evaluations[1].conversation_id = input.evaluations[0].conversation_id; }],
    ['unknown ID', input => { input.evaluations[0].conversation_id = 'not-a-source-ID'; }],
    ['database ID is not source ID', input => { input.evaluations[0].conversation_id = input.conversations[0].id; }],
    ['ok plus error', input => { input.evaluations[0].error = SAFE_ERROR; }],
    ['error plus output', input => { input.evaluations[0].status = 'error'; input.evaluations[0].error = SAFE_ERROR; }],
    ['missing output', input => { delete input.evaluations[0].output; }],
    ['missing error', input => { errorEvaluation(input); delete input.evaluations[0].error; }],
    ['unknown status', input => { input.evaluations[0].status = 'failed'; }],
    ['unwrapped evaluator output', input => { input.evaluations[0] = input.evaluations[0].output; }],
    ['extra evaluation property', input => { input.evaluations[0].extra = true; }]
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const input = fixture();
    mutate(input);
    assert.throws(() => buildSubmission(input));
  });
});

test('enforces the complete strict AI contract instead of accepting superficially scoreable answers', async t => {
  const cases = [
    ['numeric boolean raw score mismatch', input => change(input, 'c1', { raw_score: 0 })],
    ['boolean raw_score is not numeric', input => change(input, 'c1', { raw_score: true })],
    ['critical raw_score must be null', input => change(input, 'c8', { raw_score: 0 })],
    ['contact N/A forbidden', input => change(input, 'c1', { answer: 'na', raw_score: null, na_reason: 'Нет данных.' })],
    ['empathy N/A forbidden', input => change(input, 'c5', { answer: 'na', raw_score: null, na_reason: 'Нет данных.' })],
    ['dialogue N/A forbidden', input => change(input, 'c6', { answer: 'na', raw_score: null, na_reason: 'Нет данных.' })],
    ['critical N/A forbidden', input => change(input, 'c8', { answer: 'na', raw_score: null, na_reason: 'Нет данных.' })],
    ['wrong consultation step', input => change(input, 'c4', { raw_score: 7, checked_range: { from: 1, to: 6 } })],
    ['wrong dialogue step', input => change(input, 'c6', { raw_score: 5, checked_range: { from: 1, to: 6 } })],
    ['missing checked_range property', input => { delete input.evaluations[0].output.results[0].checked_range; }],
    ['missing na_reason property', input => { delete input.evaluations[0].output.results[0].na_reason; }],
    ['extra result property', input => change(input, 'c1', { evidence_quotes: [] })],
    ['extra undefined result property', input => change(input, 'c1', { extra: undefined })],
    ['nonfinite score cannot become null in JSON', input => change(input, 'c8', { raw_score: NaN })],
    ['duplicate criterion', input => { input.evaluations[0].output.results[1] = structuredClone(input.evaluations[0].output.results[0]); }],
    ['missing criterion', input => { input.evaluations[0].output.results.pop(); }],
    ['unknown criterion', input => change(input, 'c1', { criterion_id: 'greeting' })],
    ['blank explanation', input => change(input, 'c1', { explanation: ' \n ' })],
    ['non-Russian explanation', input => change(input, 'c1', { explanation: 'Everything is fine.' })],
    ['N/A reason required', input => change(input, 'c2', { answer: 'na', raw_score: null })],
    ['N/A reason must be Russian', input => change(input, 'c2', { answer: 'na', raw_score: null, na_reason: 'Not applicable.' })],
    ['non-N/A reason must be null', input => change(input, 'c1', { na_reason: 'Лишняя причина.' })],
    ['duplicate evidence', input => change(input, 'c1', { evidence_message_nos: [4, 4] })],
    ['zero-based evidence', input => change(input, 'c1', { evidence_message_nos: [0] })],
    ['out-of-bounds evidence', input => change(input, 'c1', { evidence_message_nos: [7] })],
    ['fractional evidence', input => change(input, 'c1', { evidence_message_nos: [1.5] })],
    ['string evidence is not coerced', input => change(input, 'c1', { evidence_message_nos: ['4'] })],
    ['missing evidence and range', input => change(input, 'c1', { evidence_message_nos: [] })],
    ['negative answer requires range', input => change(input, 'c1', { answer: 'no', raw_score: 0 })],
    ['partial scale requires range', input => change(input, 'c4', { raw_score: 15 })],
    ['critical no requires range even with evidence', input => change(input, 'c8', { evidence_message_nos: [4], checked_range: null })],
    ['reversed range', input => change(input, 'c1', { checked_range: { from: 4, to: 2 } })],
    ['out-of-bounds range', input => change(input, 'c1', { checked_range: { from: 1, to: 7 } })],
    ['zero-based range', input => change(input, 'c1', { checked_range: { from: 0, to: 4 } })],
    ['extra range field', input => change(input, 'c1', { checked_range: { from: 1, to: 4, extra: true } })],
    ['invalid successful conversation', input => { input.conversations[0].transcript[0].timestamp = ''; }]
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const input = fixture();
    mutate(input);
    const before = structuredClone(input);
    assert.throws(() => buildSubmission(input));
    assert.deepEqual(input, before, 'Validation must not coerce or repair invalid AI results');
  });
});

test('preflight rejects every normalized rubric change but leaves dynamic AI evaluation unrestricted', async t => {
  const cases = [
    ['ID set', version => { version.criteria[0].criterion_id = 'greeting'; }],
    ['text', version => { version.criteria[0].text += ' Новое условие.'; }],
    ['section', version => { version.criteria[0].section = 'Другой раздел'; }],
    ['weights with total still 100', version => { version.criteria[0].weight++; version.criteria[1].weight--; }],
    ['type', version => { Object.assign(version.criteria[0], { answer_type: 'scale', scale: [
      { value: 0, description: 'Нет.' }, { value: 1, description: 'Да.' }
    ] }); }],
    ['scale value', version => { version.criteria[3].scale[1].value = 6; }],
    ['scale description', version => { version.criteria[3].scale[1].description += ' Изменение.'; }],
    ['scale order', version => { version.criteria[5].scale.reverse(); }],
    ['N/A permission', version => { version.criteria[1].allow_na = false; }],
    ['N/A rule', version => { version.criteria[1].na_rule += ' Другое условие.'; }],
    ['gross-error flag', version => { version.criteria[7].is_gross_error = false; }]
  ];
  const baseline = fixture();
  const document = buildSubmission(baseline);
  for (const [name, mutate] of cases) await t.test(name, () => {
    const input = fixture();
    mutate(input.version);
    assert.doesNotThrow(() => validateConfig(input.version), 'Exercise a valid dynamic rubric, not just malformed settings');
    assert.throws(() => validateSubmissionVersion(input.version), /исходную рубрику/u);
    input.evaluations = [];
    assert.throws(() => buildSubmission(input), /исходную рубрику/u, 'Rubric preflight runs before evaluating the set');
    assert.throws(() => validateSubmission(document, input), /исходную рубрику/u);
  });
  const custom = fixture();
  custom.version.criteria[0].text += ' Динамическое правило.';
  const contract = createOutputContract(prepareInput(custom.conversations[0], custom.version));
  assert.deepEqual(contract.parse(JSON.stringify({ results: custom.evaluations[0].output.results })).errors, []);
  const normalized = validateSubmissionVersion(defaultConfig);
  normalized.criteria[0].text = 'Изменение возвращённой копии';
  assert.doesNotThrow(() => validateSubmissionVersion(defaultConfig), 'Callers cannot mutate the original rubric snapshot');
});

test('rejects wrong dataset sizes, channels, IDs and splits without substituting internal UUIDs', async t => {
  const cases = [
    ['missing source ID', input => { delete input.conversations[0].conversation_id; }],
    ['blank source ID', input => { input.conversations[0].conversation_id = ' '; }],
    ['duplicate source ID', input => { input.conversations[1].conversation_id = input.conversations[0].conversation_id; }],
    ['too few records', input => { input.conversations.pop(); }],
    ['too many records', input => { input.conversations.push(structuredClone(input.conversations[0])); }],
    ['PROD contains a call', input => { input.conversations[0].channel = 'voice call'; }],
    ['unknown channel', input => { input.conversations[0].channel = 'chat'; }],
    ['missing split', input => { delete input.split; }],
    ['unknown split', input => { input.split = 'test'; }],
    ['wrong split for dataset', input => { input.split = 'dev'; }]
  ];
  const document = buildSubmission(fixture());
  for (const [name, mutate] of cases) await t.test(name, () => {
    const input = fixture();
    mutate(input);
    assert.throws(() => buildSubmission(input));
    assert.throws(() => validateSubmission(document, input));
  });
  const dev = fixture('dev');
  dev.conversations[64].channel = 'agent chat';
  assert.throws(() => buildSubmission(dev), /60 чатов и 5 звонков/u);
  const shortDev = fixture('dev');
  shortDev.conversations.pop();
  assert.throws(() => buildSubmission(shortDev), /65/u);
});

test('standalone validation rejects missing/duplicate IDs and criteria, invalid evidence, flags and recomputed scores', async t => {
  const input = fixture();
  const baseline = buildSubmission(input);
  const cases = [
    ['duplicate conversation ID', document => { document.results[1].conversation_id = document.results[0].conversation_id; }],
    ['unknown conversation ID', document => { document.results[0].conversation_id = 'not-in-source'; }],
    ['internal UUID', document => { document.results[0].conversation_id = input.conversations[0].id; }],
    ['missing conversation', document => { document.results.pop(); }],
    ['duplicate criterion', document => { document.results[0].criteria[1] = structuredClone(document.results[0].criteria[0]); }],
    ['missing criterion', document => { document.results[0].criteria.pop(); }],
    ['unknown criterion', document => { document.results[0].criteria[0].criterion_id = 'c1'; }],
    ['duplicate evidence', document => { official(document, 'contact').evidence_turns = [4, 4]; }],
    ['out-of-bounds evidence', document => { official(document, 'contact').evidence_turns = [7]; }],
    ['zero evidence', document => { official(document, 'contact').evidence_turns = [0]; }],
    ['fractional evidence', document => { official(document, 'contact').evidence_turns = [1.5]; }],
    ['empty evidence', document => { official(document, 'contact').evidence_turns = []; }],
    ['blank rationale', document => { official(document, 'contact').rationale = ' \n '; }],
    ['false critical_flag mismatch', document => { official(document, 'critical').value = true; }],
    ['true critical_flag mismatch', document => { document.results[0].score.critical_flag = true; }],
    ['invented score', document => { document.results[0].score.final_score = 99.99; }],
    ['score recomputed from changed values', document => { official(document, 'contact').value = false; }],
    ['N/A requires redistribution', document => { official(document, 'consultation').value = null; document.results[0].score.final_score = 80; }],
    ['critical flag must not zero score', document => {
      official(document, 'critical').value = true;
      document.results[0].score = { final_score: 0, critical_flag: true };
    }]
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const document = structuredClone(baseline);
    mutate(document);
    const before = structuredClone(document);
    assert.throws(() => validateSubmission(document, input));
    assert.deepEqual(document, before, 'Standalone validation must not modify a rejected document');
  });
});

test('external UTF-8 schema is strict, requires every field, rejects extras and never coerces types', async t => {
  const schema = JSON.parse(readFileSync(new URL('../server/schemas/submission-v1.json', import.meta.url), 'utf8'));
  const validate = new Ajv({ allErrors: true, strict: true, coerceTypes: false }).compile(schema);
  const input = fixture();
  const baseline = buildSubmission(input);
  assert.equal(validate(baseline), true);
  const cases = [
    ['root extra', document => { document.extra = true; }],
    ['model extra', document => { document.model.prompt_version = 'v1'; }],
    ['row extra', document => { document.results[0].transcript = []; }],
    ['criterion extra', document => { official(document, 'contact').na_reason = 'Причина'; }],
    ['score extra', document => { document.results[0].score.gross_error = false; }],
    ['wrong schema version', document => { document.schema_version = '1.1'; }],
    ['boolean is not 1', document => { official(document, 'contact').value = 1; }],
    ['nullable boolean is not 0', document => { official(document, 'discovery').value = 0; }],
    ['number is not boolean', document => { official(document, 'consultation').value = true; }],
    ['wrong consultation step', document => { official(document, 'consultation').value = 7; }],
    ['wrong dialogue step', document => { official(document, 'dialogue').value = 5; }],
    ['weighted dialogue points are not a raw step', document => { official(document, 'dialogue').value = 10.5; }],
    ['numeric string', document => { official(document, 'dialogue').value = '10'; }],
    ['string final_score', document => { document.results[0].score.final_score = '100'; }],
    ['string evidence', document => { official(document, 'contact').evidence_turns = ['4']; }]
  ];
  for (const code of ['contact', 'empathy', 'dialogue', 'critical']) {
    cases.push([`${code} null forbidden`, document => { official(document, code).value = null; }]);
  }
  for (const [name, select, fields] of [
    ['root', document => document, ['schema_version', 'team_name', 'model', 'results']],
    ['model', document => document.model, ['mode', 'name']],
    ['row', document => document.results[0], ['conversation_id', 'status', 'criteria', 'score']],
    ['criterion', document => document.results[0].criteria[0], ['criterion_id', 'value', 'rationale', 'evidence_turns']],
    ['score', document => document.results[0].score, ['final_score', 'critical_flag']]
  ]) {
    for (const field of fields) cases.push([`missing ${name}.${field}`, document => { delete select(document)[field]; }]);
  }
  for (const [name, mutate] of cases) await t.test(name, () => {
    const document = structuredClone(baseline);
    mutate(document);
    const before = structuredClone(document);
    assert.equal(validate(document), false);
    assert.throws(() => validateSubmission(document, input));
    assert.deepEqual(document, before);
  });
  const invalid = structuredClone(baseline);
  invalid.team_name = ' ';
  invalid.model.name = '';
  assert.equal(validate(invalid), false);
  assert.ok(validate.errors.some(error => error.instancePath === '/team_name'));
  assert.ok(validate.errors.some(error => error.instancePath === '/model/name'), 'AJV collects all errors');
});

test('error records are strictly exclusive and reject unsafe or non-string reasons rather than leaking them', async t => {
  const input = fixture();
  errorEvaluation(input);
  const baseline = buildSubmission(input);
  const cases = [
    ['empty reason', document => { document.results[0].error = ''; }],
    ['whitespace reason', document => { document.results[0].error = ' '; }],
    ['object reason', document => { document.results[0].error = { message: SAFE_ERROR }; }],
    ['missing reason', document => { delete document.results[0].error; }],
    ['nonempty error criteria', document => { document.results[0].criteria = structuredClone(baseline.results[1].criteria); }],
    ['error score not null', document => { document.results[0].score = { final_score: 0, critical_flag: false }; }],
    ['error plus output', document => { document.results[0].output = {}; }],
    ['success plus error', document => { document.results[1].error = SAFE_ERROR; }]
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const document = structuredClone(baseline);
    mutate(document);
    assert.throws(() => validateSubmission(document, input));
  });
  for (const reason of ['', ' ', null, new Error(SAFE_ERROR), { message: SAFE_ERROR },
    AUDIO_URL, 'Provider: Bearer synthetic-credential', 'Provider key: sk-synthetic-secret',
    'api_key=synthetic-secret', '{"transcript":"private text"}', 'Error\n    at provider (private.js:1:1)']) {
    const invalid = fixture();
    errorEvaluation(invalid, 0, reason);
    assert.throws(() => buildSubmission(invalid));
    if (typeof reason === 'string') {
      const document = structuredClone(baseline);
      document.results[0].error = reason;
      assert.throws(() => validateSubmission(document, input));
    }
  }
});

test('validation is per-dialogue, reusable, immutable and independent of previous transcript lengths', () => {
  const long = fixture();
  const baseline = buildSubmission(long);
  const short = fixture();
  for (const [index, conversation] of short.conversations.entries()) {
    conversation.transcript = conversation.transcript.slice(0, 4);
    for (const result of short.evaluations[index].output.results) {
      result.evidence_message_nos = [4];
      if (result.checked_range) result.checked_range.to = 4;
    }
  }
  const shortDocument = buildSubmission(short);
  assert.equal(validateSubmission(shortDocument, short), shortDocument);
  shortDocument.results[0].criteria[0].evidence_turns = [5];
  assert.throws(() => validateSubmission(shortDocument, short));
  baseline.results[0].criteria[0].rationale = 'Изменение возвращённого документа';
  assert.notEqual(buildSubmission(long).results[0].criteria[0].rationale, baseline.results[0].criteria[0].rationale);
  assert.equal(buildSubmission(long).results[0].score.final_score, 100);
});
