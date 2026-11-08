window.CqaService = (() => {
  async function request(path, body) {
    const response = await fetch("../api/" + path, body === undefined ? undefined : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    let data;
    try { data = await response.json(); } catch { throw new Error("Сервер вернул неожиданный ответ. Проверьте, что сервер запущен и обновлён."); }
    if (!response.ok) throw new Error(data.error || "Ошибка API");
    return data;
  }

  return {
    exportSubmission: body => request("exports/submission", body),
    conversations: () => request("conversations"),
    importJson: body => request('import', body),
    conversation: id => request("conversations/" + id),
    importGroup: group_id => request("import/organizer", { group_id }),
    importDemo: () => request("import", { group_id: "DEMO", records: window.CqaMock.records }),
    checklists: () => request("checklists"),
    createChecklist: body => request('checklists', body),
    versions: id => request("checklists/" + id + "/versions"),
    previewWeights: (id, body) => request("checklist-versions/" + id + "/preview-weights", body),
    saveVersion: (id, config) => request("checklists/" + id + "/versions", config),
    evaluate: body => request("evaluations", body),
    startJob: body => request("evaluation-jobs", body),
    job: id => request("evaluation-jobs/" + encodeURIComponent(id)),
    evaluation: id => request("evaluations/" + encodeURIComponent(id)),
    startBatch: body => request("evaluation-batches", body),
    batch: id => request("evaluation-batches/" + encodeURIComponent(id)),
    retryBatch: id => request('evaluation-batches/' + encodeURIComponent(id) + '/retry', {}),
    batches: () => request("evaluation-batches"),
    evaluations: () => request("evaluations"),
    appeal: body => request("appeals", body),
    appeals: () => request("appeals"),
    appealDetails: id => request("appeals/" + id),
    decide: (id, body) => request("appeals/" + id + "/decision", body)
  };
})();
