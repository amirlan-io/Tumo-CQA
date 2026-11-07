window.CqaMock = {
  groupId: "DEV",
  records: [{
    conversation_id: "DEMO-001",
    channel: "agent chat",
    language: "RU",
    audio_url: null,
    transcript: [
      { timestamp: "10:04:02", speaker: "system", text: "Чат открыт." },
      { timestamp: "10:04:08", speaker: "client", text: "Здравствуйте! Где посмотреть историю операций?" },
      { timestamp: "10:04:10", speaker: "bot", text: "Подключаю оператора." },
      { timestamp: "10:04:18", speaker: "operator", text: "Здравствуйте! Меня зовут Дана. Сейчас помогу найти историю операций." },
      { timestamp: "10:04:33", speaker: "operator", text: "Откройте раздел «Портфель» и выберите «История»." }
    ]
  }],
  demoResults: [
    ["c1", "yes", 1, "Оператор поздоровалась на русском и представилась в первом ответе.", [4]],
    ["c2", "na", null, "Клиент сразу сформулировал вопрос.", [2], "Данных для ответа хватало с самого начала."],
    ["c3", "na", null, "Оператор объяснила путь в приложении без раскрытия данных.", [2, 5], "Запрос не требовал идентификации."],
    ["c4", "scale", 20, "Оператор указала, где открыть историю операций.", [2, 5]],
    ["c5", "yes", 1, "Оператор общалась вежливо. Клиент не выражал недовольства.", [2, 4, 5]],
    ["c6", "scale", 10, "Ответы последовательные и ясные. Явного ожидания не было.", [2, 3, 4, 5]],
    ["c7", "no", 0, "В конце проверенного участка нет прощания.", [4, 5]],
    ["c8", "no", null, "В проверенном диалоге грубых нарушений нет.", [1, 2, 3, 4, 5]]
  ].map(([criterion_id, answer, raw_score, explanation, evidence_message_nos, na_reason = null]) =>
    ({ criterion_id, answer, raw_score, explanation, evidence_message_nos, na_reason })),
  assessment: {
    conversation_id: "DEMO-001",
    checklist_version: "demo-v1",
    criterion: "Установление контакта",
    answer: "Да",
    weight: 10,
    points: 10,
    explanation: "В первом ответе оператор поздоровалась на русском языке и представилась.",
    evidence: { turn_index: 3 }
  }
};
