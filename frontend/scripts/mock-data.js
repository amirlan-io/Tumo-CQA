window.CqaMock = {
  groupId: "DEV",
  records: [{
    conversation_id: "DEMO-001",
    channel: "chat",
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
