# API для команды

Все запросы и ответы — JSON. Ошибка: `{ "error": "Описание" }`.
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
