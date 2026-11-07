(async function () {
  const root = document.querySelector("#cqa-app");
  const status = root.querySelector("#cqa-status");
  const list = root.querySelector("#cqa-list");
  const transcript = root.querySelector("#cqa-transcript");
  const result = root.querySelector("#cqa-result");
  const checklistVersion = "demo-v1";

  function append(parent, tag, value) {
    const element = document.createElement(tag);
    element.textContent = value;
    parent.append(element);
    return element;
  }

  function openConversation(record) {
    transcript.replaceChildren();
    result.replaceChildren();
    transcript.hidden = false;
    result.hidden = true;

    append(transcript, "h2", "Транскрипт");
    append(transcript, "p", record.conversation_id + " · " + record.channel + " · " + record.language);
    const turns = append(transcript, "ol", "");
    record.transcript.forEach((turn, index) => {
      const row = append(turns, "li", "");
      row.id = "cqa-turn-" + index;
      row.tabIndex = -1;
      append(row, "strong", turn.timestamp + " · " + turn.speaker);
      append(row, "p", turn.text);
    });

    const run = append(transcript, "button", "Запустить демо-оценку · " + checklistVersion);
    run.type = "button";
    run.addEventListener("click", async () => {
      run.disabled = true;
      status.textContent = "Получаем оценку…";
      try {
        const assessment = await window.CqaApi.evaluate({
          conversation_id: record.conversation_id,
          checklist_version: checklistVersion
        });
        result.replaceChildren();
        result.hidden = false;
        append(result, "h2", "Результат · " + assessment.criterion);
        append(result, "p", assessment.answer + " · вес " + assessment.weight + " · баллы " + assessment.points);
        append(result, "p", assessment.explanation);
        const row = turns.children[assessment.evidence.turn_index];
        if (row) {
          const link = append(result, "a", "К реплике · " + record.transcript[assessment.evidence.turn_index].timestamp);
          link.href = "#" + row.id;
          link.addEventListener("click", (event) => {
            event.preventDefault();
            row.classList.add("cqa-evidence");
            row.focus({ preventScroll: true });
            row.scrollIntoView({ block: "center" });
          });
        }
        status.textContent = "Демо-оценка готова.";
      } catch (error) {
        status.textContent = error.message;
      } finally {
        run.disabled = false;
      }
    });
  }

  try {
    const response = await window.CqaApi.loadGroup("DEV");
    if (!response.isSuccess) throw new Error("Не удалось загрузить группу DEV.");
    status.textContent = "Группа DEV · вымышленные данные";
    response.data.records.forEach((record) => {
      const open = append(list, "button", "Открыть " + record.conversation_id);
      open.type = "button";
      open.addEventListener("click", () => openConversation(record));
    });
  } catch (error) {
    status.textContent = error.message;
  }
})();
