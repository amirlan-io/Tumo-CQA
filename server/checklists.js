const text = x => typeof x === 'string' && x.trim().length > 0 && x.length <= 10000;
const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };

export function validateConfig(input) {
  if (!input || !text(input.name) || !Array.isArray(input.criteria) || input.criteria.length !== 8)
    invalid('Нужны название и ровно 8 критериев');
  const ids = new Set();
  const criteria = input.criteria.map(c => {
    if (!c || !text(c.criterion_id) || ids.has(c.criterion_id) || !text(c.text) || !text(c.section)
      || !['boolean', 'scale'].includes(c.answer_type) || !Number.isFinite(c.weight) || c.weight < 0
      || typeof c.allow_na !== 'boolean' || typeof c.is_gross_error !== 'boolean'
      || (c.allow_na && !text(c.na_rule))) invalid('Неверные настройки критерия');
    ids.add(c.criterion_id);
    if (c.is_gross_error && (c.weight !== 0 || c.answer_type !== 'boolean' || c.allow_na))
      invalid('Грубая ошибка: тип boolean, вес 0, N/A запрещён');
    let scale = [];
    if (c.answer_type === 'scale') {
      if (!Array.isArray(c.scale) || c.scale.length < 2 || c.scale.some(s => !s || !Number.isFinite(s.value) || s.value < 0 || !text(s.description))
        || new Set(c.scale.map(s => s.value)).size !== c.scale.length || !c.scale.some(s => s.value === 0)
        || Math.max(...c.scale.map(s => s.value)) <= 0) invalid('Нужна шкала с уникальными ступенями, нулём и описаниями');
      scale = c.scale.map(s => ({ value: s.value, description: s.description.trim() }));
    }
    return { criterion_id: c.criterion_id, text: c.text.trim(), section: c.section.trim(),
      answer_type: c.answer_type, weight: c.weight, allow_na: c.allow_na,
      na_rule: c.allow_na ? c.na_rule.trim() : null, is_gross_error: c.is_gross_error, scale };
  });
  if (Math.abs(criteria.reduce((n, c) => n + c.weight, 0) - 100) > 0.000001)
    invalid('Сумма весов должна равняться 100');
  return { name: input.name.trim(), rounding_digits: 2, criteria };
}

export function validateAnswers(version, results) {
  if (results.length !== version.criteria.length) invalid('Нужен ответ на каждый критерий версии');
  for (const r of results) {
    const c = version.criteria.find(c => c.criterion_id === r.criterion_id);
    if (!c) invalid('Критерий отсутствует в выбранной версии');
    if (r.answer === 'na') {
      if (!c.allow_na || r.raw_score !== null || !text(r.na_reason)) invalid('N/A запрещён или не объяснён');
    } else if (c.answer_type === 'boolean') {
      if (!['yes', 'no'].includes(r.answer) || r.raw_score !== (c.is_gross_error ? null : r.answer === 'yes' ? 1 : 0))
        invalid('Ответ boolean: yes=1, no=0; для грубой ошибки балл null');
    } else if (r.answer !== 'scale' || !c.scale.some(s => s.value === r.raw_score)) invalid('Балл отсутствует в шкале');
  }
}

export const defaultConfig = {
  name: 'Freedom Broker — качество диалогов',
  criteria: [
    ['c1', 'Установление контакта: оператор поздоровался на языке клиента и представился в первом ответе.', 10, 'Начало и понимание запроса'],
    ['c2', 'Выявление потребности: учёл известные детали и уточнил недостающее до ответа.', 15, 'Начало и понимание запроса', 'Данных для ответа хватало с самого начала.'],
    ['c3', 'Идентификация: проверка личности подтверждена до раскрытия данных или защищённого действия.', 20, 'Безопасность и решение', 'Запрос не требовал идентификации.'],
    ['c4', 'Корректная и полная консультация.', 20, 'Безопасность и решение', 'Чат закончился до того, как клиент сформулировал запрос.', [[0,'Ответа по существу нет или ключевая рекомендация ошибочна.'],[5,'Есть общая подсказка, но клиенту всё ещё непонятно, как действовать.'],[10,'Часть запроса закрыта, существенный вопрос остался открытым.'],[15,'Основной вопрос решён, пропущена второстепенная деталь.'],[20,'Все существенные вопросы закрыты или дан корректный следующий шаг.']]],
    ['c5', 'Эмпатия: оператор вежлив и реагирует на конкретную проблему при недовольстве или неудобстве клиента.', 15, 'Ведение и завершение диалога'],
    ['c6', 'Управление диалогом, скорость и грамотность. Порог первой реакции 3 минуты, теги и вложения не оцениваются.', 15, 'Ведение и завершение диалога', null, [[0,'Из-за бессвязных или противоречивых реплик ход диалога непонятен.'],[4,'Клиенту приходится переспрашивать из-за формулировок или порядка ответов.'],[7,'Один заметный сбой, но клиент может понять ответ и продолжить.'],[10,'Ответы ясные и связные. Если было явное ожидание, оператор предупредил.']]],
    ['c7', 'Завершение: оператор подвёл итог или предложил дальнейшую помощь и попрощался.', 5, 'Ведение и завершение диалога', 'Чат оборвался до возможности его завершить.'],
    ['c8', 'Грубые ошибки: оскорбление клиента, предложение платной услуги в обход компании или раскрытие конфиденциальной информации.', 0, 'Грубые нарушения']
  ].map(([criterion_id, text, weight, section, na_rule, steps]) => ({ criterion_id, text, weight, section,
    answer_type: steps ? 'scale' : 'boolean', allow_na: Boolean(na_rule), na_rule: na_rule ?? null,
    scale: steps?.map(([value, description]) => ({ value, description })) ?? [], is_gross_error: criterion_id === 'c8' }))
};

export function installChecklists(app, store, get) {
  if (!store.list('checklist').length) store.transaction(() => {
    const config = validateConfig(defaultConfig);
    const checklist = store.add('checklist', { name: config.name });
    store.add('checklist_version', { ...config, checklist_id: checklist.id, version: 1 }, checklist.id);
  });
  const versions = id => store.list('checklist_version').filter(v => v.checklist_id === id);
  app.get('/api/checklists', (req, res) => res.json(store.list('checklist').map(c => ({ ...c, latest_version: versions(c.id).at(-1) }))));
  app.post('/api/checklists', (req, res) => {
    const config = validateConfig(req.body);
    res.status(201).json(store.transaction(() => {
      const checklist = store.add('checklist', { name: config.name });
      return store.add('checklist_version', { ...config, checklist_id: checklist.id, version: 1 }, checklist.id);
    }));
  });
  app.get('/api/checklists/:id', (req, res) => res.json({ ...get('checklist', req.params.id), versions: versions(req.params.id) }));
  app.get('/api/checklists/:id/versions', (req, res) => { get('checklist', req.params.id); res.json(versions(req.params.id)); });
  app.get('/api/checklist-versions/:id', (req, res) => res.json(get('checklist_version', req.params.id)));
  app.post('/api/checklists/:id/versions', (req, res) => {
    get('checklist', req.params.id);
    const config = validateConfig(req.body);
    res.status(201).json(store.transaction(() => store.add('checklist_version', {
      ...config, checklist_id: req.params.id, version: versions(req.params.id).length + 1
    }, req.params.id)));
  });
}
