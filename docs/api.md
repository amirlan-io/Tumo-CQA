# API для команды

## Карточка проверяющего и экспорт

GET /api/appeals/:id возвращает criterion, original, current, conversation, evidence, evaluation и decision. Это позволяет открыть спорную оценку и подтверждающие реплики одним запросом.

GET /api/exports/evaluations.csv скачивает исходный и финальный итог каждой оценки с языком, версией чек-листа и флагом грубой ошибки. UTF-8 BOM для Excel; строки экранированы, потенциальные формулы обезврежены.

## Загрузка от организаторов

POST /api/import/organizer с JSON `{ "group_id": "DEV" }` получает набор по GET через сервер. Ответ: `{group_id, count, records}`. Для контрольного набора замените DEV на значение организаторов. Исходная подписанная ссылка задаётся только в ORGANIZER_API_URL в .env; все её параметры сохраняются, group_id заменяется. Ссылку не коммитить.

Ошибки: 400 — неверный group_id, 503 — нет настройки, 502 — сеть/ошибка/неверный или неполный ответ организаторов, 504 — ожидание больше 30 секунд. При ошибке набора ничего не сохраняется. Повторная загрузка не создаёт копий и не изменяет ранее загруженные диалоги. Для ручного JSON остаётся POST /api/import.

## Итоги и пересмотр

POST /api/evaluations, GET /api/evaluations и GET /api/evaluations/:id возвращают original_score и final_score. Исходные results не меняются, текущие ответы находятся в final_results. POST решения возвращает decision-поля и evaluation с пересчитанными итогами.

Объект score: total (0–100 или null), applicable_weight, gross_error, criteria и sections. Для каждого критерия: weight — исходный вес, effective_weight — вес после N/A, weighted_points — баллы до перераспределения, points — вклад в итог. Для секции points — вклад в общий итог, maximum — её доступный максимум после N/A. Значения для отображения округлены до двух знаков, итог считается из неокруглённых вкладов, поэтому сумма отображаемых строк может отличаться на 0.01.

Формула: 100 × сумма(вес × доля выполнения) / сумма применимых весов. Для шкалы доля = балл / максимум шкалы; yes=1, no=0. N/A исключается из обеих сумм. Грубая ошибка отмечается отдельно и не обнуляет итог. Если применимых весов нет, total=null. При повторной апелляции confirm сохраняет текущую оценку; change заменяет только выбранный критерий. Все расчёты используют неизменяемую версию исходной оценки.

Все запросы и ответы — JSON. Ошибка: `{ "error": "Описание" }`.

## Чек-листы и версии

При первом запуске автоматически создаётся чек-лист Freedom Broker из восьми критериев.

- GET /api/checklists — список с latest_version.
- GET /api/checklists/:id — чек-лист и все версии.
- GET /api/checklists/:id/versions — версии чек-листа.
- GET /api/checklist-versions/:id — конкретная сохранённая версия.
- POST /api/checklists — создать чек-лист и первую версию.
- POST /api/checklists/:id/versions — сохранить новую версию.

Для создания отправьте name и criteria. Проще получить latest_version, изменить нужные поля и отправить её целиком. Поля id, version, created_at сервер назначает сам. Критериев ровно восемь, criterion_id уникальны, сумма весов 100. Поля критерия: criterion_id, text, section, weight, answer_type (boolean/scale), allow_na, na_rule, is_gross_error, scale (массив {value, description}). Для грубой ошибки вес 0 и N/A запрещён. Округление — два знака.

Версии неизменяемы. В POST /api/evaluations поле checklist_version теперь обязательно содержит UUID существующей версии, полученный из API, а не строку v1. Передавайте все восемь ответов. Сервер проверяет тип ответа, ступень шкалы и разрешение N/A. Эти же проверки действуют при решении по апелляции.
400 — неверные данные, 404 — запись не найдена, 409 — повторная апелляция или решение.

| Метод | Адрес | Назначение |
|---|---|---|
| GET | /api/health | Проверка сервера |
| POST | /api/import | Загрузить `{group_id, records}`; records — массив диалогов организаторов |
| GET | /api/conversations | Список диалогов |
| GET | /api/conversations/:id | Диалог с transcript |
| POST | /api/evaluations | Сохранить готовый ответ ИИ |
| GET | /api/evaluations | Список исходных оценок |
| GET | /api/evaluations/:id | Исходные results, решения decisions и final_results |
| POST | /api/appeals | `{evaluation_id, criterion_id, comment}` |
| GET | /api/appeals | Апелляции и решения |
| POST | /api/appeals/:id/decision | `{action, reason, replacement}` |

`id` диалога — внутренний UUID сервера. Исходный ID организаторов — `conversation_id`.

POST /api/evaluations:

```json
{
  "conversation_id": "UUID диалога из API",
  "checklist_version": "v1",
  "results": [{
    "criterion_id": "c1",
    "answer": "no",
    "raw_score": 0,
    "explanation": "Оператор не представился",
    "evidence_message_nos": [1],
    "na_reason": null
  }]
}
```

Ответы: yes/no/scale/na. Для na обязательны raw_score=null и непустая na_reason.
Номера доказательств начинаются с 1. Бот и system остаются в transcript.

Для решения action=confirm поле replacement не требуется. Для action=change:

```json
{
  "action": "change",
  "reason": "Проверяющий нашёл представление в первой реплике",
  "replacement": { "answer": "yes", "raw_score": 1 }
}
```

Одна апелляция допускает одно решение. После закрытия можно создать новую апелляцию.
При новой апелляции исходная оценка доступна в results, текущая — в final_results.
