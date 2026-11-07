// Асинхронный адаптер. Формат оценки предварительный.
window.CqaApi = {
  async loadGroup(groupId) {
    const isSuccess = groupId === window.CqaMock.groupId;
    return { isSuccess, data: { records: isSuccess ? window.CqaMock.records : [] } };
  },

  async evaluate({ conversation_id, checklist_version }) {
    const result = window.CqaMock.assessment;
    if (conversation_id !== result.conversation_id || checklist_version !== result.checklist_version) {
      throw new Error("Для этой пары диалога и версии нет демо-оценки.");
    }
    return result;
  }
};
