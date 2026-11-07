window.CqaService = (() => {
  async function request(path, body) {
    const response = await fetch("../api/" + path, body === undefined ? undefined : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Ошибка API");
    return data;
  }

  return {
    conversations: () => request("conversations"),
    conversation: id => request("conversations/" + id),
    importGroup: group_id => request("import/organizer", { group_id }),
    importDemo: () => request("import", { group_id: "DEMO", records: window.CqaMock.records }),
    checklists: () => request("checklists"),
    versions: id => request("checklists/" + id + "/versions"),
    saveVersion: (id, config) => request("checklists/" + id + "/versions", config),
    evaluate: body => request("evaluations", body),
    evaluation: id => request("evaluations/" + id),
    startJob: body => request("evaluation-jobs", body),
    job: id => request("evaluation-jobs/" + id),
    startBatch: body => request("evaluation-batches", body),
    batch: id => request("evaluation-batches/" + id),
    evaluations: () => request("evaluations"),
    appeal: body => request("appeals", body),
    appeals: () => request("appeals"),
    appealDetails: id => request("appeals/" + id),
    decide: (id, body) => request("appeals/" + id + "/decision", body)
  };
})();
