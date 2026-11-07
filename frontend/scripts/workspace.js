(() => {
  const api = window.CqaService;
  const root = document.querySelector("#cqa-app");
  const content = root.querySelector("#cqa-content");
  const status = root.querySelector("#cqa-status");
  const pages = {
    dialogs: ["Диалоги", "Загружай диалоги, проверяй оценки и переходи к репликам с доказательствами.", dialogs],
    checklists: ["Чек-листы", "Настраивай критерии, веса и шкалы. Сохраняй изменения отдельной версией.", checklists],
    appeals: ["Апелляции", "Проверяй спорные ответы, доказательства и историю пересмотра.", appeals]
  };

  function add(parent, tag, text = "") {
    const element = document.createElement(tag);
    element.textContent = text;
    parent.append(element);
    return element;
  }

  function button(parent, text, action) {
    const control = add(parent, "button", text);
    control.type = "button";
    control.addEventListener("click", () => run(action, control));
    return control;
  }

  async function run(action, control) {
    status.textContent = "Загрузка…";
    if (control) control.disabled = true;
    try {
      await action();
      status.textContent = "";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      if (control) control.disabled = false;
    }
  }

  function field(parent, title, tag = "input", value = "") {
    const label = add(parent, "label", title);
    const input = add(label, tag);
    input.value = value;
    return input;
  }

  function option(select, value, label) {
    add(select, "option", label).value = value;
  }

  function navigate(page) {
    const view = document.createElement("div");
    content.replaceChildren(view);
    const [title, description, render] = pages[page];
    root.querySelector("#cqa-page-title").textContent = title;
    root.querySelector("#cqa-page-description").textContent = description;
    root.querySelectorAll("[data-page]").forEach(control => {
      if (control.dataset.page === page) control.setAttribute("aria-current", "page");
      else control.removeAttribute("aria-current");
    });
    return render(view);
  }

  root.querySelectorAll("[data-page]").forEach(control => {
    control.addEventListener("click", () => run(() => navigate(control.dataset.page), control));
  });

  function transcript(parent, record) {
    add(parent, "h2", "Транскрипт · " + record.conversation_id);
    add(parent, "p", [record.channel, record.language, record.group_id].join(" · "));
    if (record.channel === "voice call") {
      const audio = record.audio_url;
      if (audio && /^https?:\/\//i.test(audio)) {
        const link = add(parent, "a", "Открыть запись звонка");
        link.href = audio;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      } else {
        add(parent, "p", "Запись недоступна.");
      }
    }

    const list = add(parent, "ol");
    const rows = new Map();
    record.transcript.forEach(turn => {
      const row = add(list, "li");
      row.dataset.speaker = turn.speaker;
      row.tabIndex = -1;
      add(row, "strong", turn.timestamp + " · " + turn.speaker);
      add(row, "p", turn.text);
      rows.set(turn.message_no, row);
    });
    return rows;
  }

  function evidence(parent, numbers, rows) {
    if (!numbers.length) return;
    button(parent, "Доказательство · " + numbers.join(", "), () => {
      rows.forEach(row => row.classList.remove("cqa-evidence"));
      const matches = numbers.map(number => rows.get(number)).filter(Boolean);
      matches.forEach(row => row.classList.add("cqa-evidence"));
      matches[0]?.focus({ preventScroll: true });
      matches[0]?.scrollIntoView({ block: "center" });
    });
  }

  const answerText = result => ({ yes: "Да", no: "Нет", na: "N/A", scale: result.raw_score })[result.answer];
  const total = score => score.total == null ? "—" : score.total.toFixed(2);

  function answerFields(parent, criterion) {
    const select = field(parent, "Ответ", "select");
    option(select, "", "Выбери ответ");
    if (criterion.answer_type === "scale") {
      criterion.scale.forEach(step => option(select, "scale:" + step.value, step.value + " · " + step.description));
    } else {
      option(select, "yes", "Да");
      option(select, "no", "Нет");
    }
    if (criterion.allow_na) option(select, "na", "N/A");
    const na = criterion.allow_na ? field(parent, "Причина N/A · " + criterion.na_rule) : null;
    return () => {
      if (!select.value) throw new Error("Выбери ответ для " + criterion.text);
      const [answer, scale] = select.value.split(":");
      return {
        answer,
        raw_score: answer === "na" || criterion.is_gross_error ? null : answer === "scale" ? Number(scale) : Number(answer === "yes"),
        na_reason: answer === "na" ? na.value.trim() : null
      };
    };
  }

  const jobLabels = { queued: 'В очереди', running: 'Оценивается', completed: 'Готово', failed: 'Ошибка', completed_with_errors: 'Готово с ошибками' };
  async function watch(load, render, active) {
    while (active()) {
      const item = await load();
      if (!active()) return null;
      render(item);
      if (['completed', 'completed_with_errors', 'failed'].includes(item.status)) return item;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return null;
  }

  async function dialogs(view) {
    const toolbar = add(view, "section");
    toolbar.className = "cqa-toolbar";
    add(toolbar, "h2", "Загрузка диалогов");
    const controls = add(toolbar, 'div'); controls.className = 'cqa-import-controls';
    const importPanel = add(controls, 'div');
    const evaluatePanel = add(controls, 'div');
    const demoPanel = add(toolbar, 'div'); demoPanel.className = 'cqa-demo-controls';
    const group = field(importPanel, "Идентификатор группы", "input", "DEV");
    const summary = add(view, "div");
    summary.className = "cqa-summary";
    const list = add(view, "div");
    list.className = "cqa-dialog-list";
    const details = add(view, "div");
    async function refresh(groupId) {
      const records = await api.conversations();
      list.replaceChildren();
      details.replaceChildren();
      const visible = records.filter(record => !groupId || record.group_id === groupId);
      summary.replaceChildren();
      [['Все диалоги', visible.length], ['Чаты', visible.filter(c => c.channel === 'agent chat').length], ['Звонки', visible.filter(c => c.channel === 'voice call').length]].forEach(([label, count]) => {
        const card = add(summary, 'div'); add(card, 'span', label); add(card, 'strong', String(count));
      });
      add(list, 'h2', 'Диалоги · ' + visible.length);
      if (!visible.length) add(list, "p", "Загрузите группу, чтобы начать оценку качества.");
      visible.forEach(record => {
        const row = add(list, 'div'); row.className = 'cqa-dialog-row';
        const identity = add(row, 'div'); add(identity, 'strong', record.conversation_id);
        add(identity, 'small', record.group_id + ' · ' + (record.channel === 'voice call' ? 'Звонок' : 'Чат'));
        const language = add(row, 'span', record.language); language.className = 'cqa-badge';
        button(row, "Открыть " + record.conversation_id + " · " + record.language, () => openDialog(details, record.id)).className = 'cqa-secondary';
      });
    }
    button(importPanel, "Загрузить группу", async () => {
      const id = group.value.trim();
      await api.importGroup(id);
      await refresh(id);
    });
    button(demoPanel, "Загрузить вымышленный диалог", async () => {
      await api.importDemo();
      await refresh("DEMO");
    }).classList.add("cqa-secondary");
    const batchVersions = field(evaluatePanel, 'Чек-лист для оценки группы', 'select');
    (await api.checklists()).forEach(c => option(batchVersions, c.latest_version.id, c.latest_version.name + ' · v' + c.latest_version.version));
    const batchStatus = add(toolbar, 'div');
    async function monitorBatch(id) {
      await watch(() => api.batch(id), batch => {
        batchStatus.replaceChildren();
        add(batchStatus, 'p', jobLabels[batch.status] + ' · ' + batch.progress + '% · готово ' + batch.completed + '/' + batch.total + ' · ошибок ' + batch.failed);
        batch.jobs.forEach(job => {
          add(batchStatus, 'p', jobLabels[job.status] + (job.cache_hit ? ' · из кэша' : '') + (job.error ? ' · ' + job.error : ''));
          if (job.evaluation_id) button(batchStatus, 'Открыть результат', () => openDialog(details, job.conversation_id));
        });
      }, () => view.isConnected);
    }
    button(evaluatePanel, 'Оценить группу через ИИ', async () => {
      const batch = await api.startBatch({ group_id: group.value.trim(), checklist_version: batchVersions.value });
      await monitorBatch(batch.id);
    });
    const savedBatches = await api.batches();
    savedBatches.slice(-5).reverse().forEach(batch => button(toolbar, 'Пакет ' + batch.group_id + ' · ' + jobLabels[batch.status], () => monitorBatch(batch.id)));
    await refresh();
  }

  async function openDialog(details, id) {
    const [record, lists, evaluations] = await Promise.all([api.conversation(id), api.checklists(), api.evaluations()]);
    const versions = (await Promise.all(lists.map(list => api.versions(list.id)))).flat();
    details.replaceChildren();
    const grid = add(details, "div");
    grid.className = "cqa-grid";
    const rows = transcript(add(grid, "section"), record);
    const review = add(grid, "section");
    const versionSelect = field(review, "Версия чек-листа", "select");
    versions.forEach(version => option(versionSelect, version.id, version.name + " · v" + version.version));
    versionSelect.value = versions.at(-1)?.id || "";
    const actions = add(review, "div");
    actions.className = "cqa-actions";
    const form = add(review, "div");
    const output = add(review, "div");

    function show(evaluation) {
      output.replaceChildren();
      const version = versions.find(item => item.id === evaluation.checklist_version);
      add(output, "h2", "Итог · " + total(evaluation.final_score));
      add(output, "p", "Исходный итог · " + total(evaluation.original_score));
      add(output, "p", "Грубые ошибки · " + (evaluation.final_score.gross_error ? "Да" : "Нет"));
      evaluation.final_score.sections.forEach(section =>
        add(output, "p", section.section + " · " + (section.points ?? "—") + " / " + (section.maximum ?? "—")));
      evaluation.final_results.forEach(result => {
        const criterion = version.criteria.find(item => item.criterion_id === result.criterion_id);
        const score = evaluation.final_score.criteria.find(item => item.criterion_id === result.criterion_id);
        const original = evaluation.results.find(item => item.criterion_id === result.criterion_id);
        const card = add(output, "section");
        add(card, "h3", criterion.text);
        add(card, "p", "Исходный ответ · " + answerText(original) + " · текущий · " + answerText(result));
        if (!criterion.is_gross_error) add(card, "p", "Вес · " + score.weight + " · баллы · " + (result.answer === "na" ? "—" : score.points ?? "—"));
        add(card, "p", original.explanation);
        if (result.na_reason) add(card, "p", "Причина N/A · " + result.na_reason);
        evidence(card, original.evidence_message_nos, rows);
        const appealForm = add(card, "details");
        add(appealForm, "summary", "Оспорить оценку");
        const comment = field(appealForm, "Комментарий к апелляции", "textarea");
        const message = add(card, "p");
        button(appealForm, "Подать апелляцию", async () => {
          await api.appeal({ evaluation_id: evaluation.id, criterion_id: criterion.criterion_id, comment: comment.value });
          comment.value = "";
          message.textContent = "Апелляция сохранена.";
        });
      });
    }

    function editAnswers() {
      form.replaceChildren();
      const version = versions.find(item => item.id === versionSelect.value);
      if (!version) return;
      add(form, "p", "Демо с ручным вводом ответов. Итог рассчитывает сервер.");
      const readResults = version.criteria.map(criterion => {
        const card = add(form, "fieldset");
        add(card, "legend", criterion.text);
        const read = answerFields(card, criterion);
        const explanation = field(card, "Объяснение", "textarea");
        const numbers = field(card, "Номера реплик через запятую, включая проверенный участок");
        return () => ({
          ...read(),
          criterion_id: criterion.criterion_id,
          explanation: explanation.value.trim(),
          evidence_message_nos: numbers.value.trim() ? numbers.value.split(",").map(value => Number(value.trim())) : []
        });
      });
      button(form, "Рассчитать оценку", async () => {
        show(await api.evaluate({ conversation_id: record.id, checklist_version: version.id, results: readResults.map(read => read()) }));
      });
    }

    const jobStatus = add(actions, 'p');
    button(actions, 'Оценить через ИИ', async () => {
      const job = await api.startJob({ conversation_id: record.id, checklist_version: versionSelect.value });
      const done = await watch(() => api.job(job.id), item => {
        jobStatus.textContent = jobLabels[item.status] + (item.cache_hit ? ' · из кэша' : '') + (item.error ? ' · ' + item.error : '');
      }, () => review.isConnected);
      if (done?.status === 'completed') show(await api.evaluation(done.evaluation_id));
    });
    button(actions, "Заполнить оценку вручную", editAnswers);
    if (record.group_id === "DEMO" && record.conversation_id === "DEMO-001") {
      button(actions, "Запустить оценку на вымышленных ответах", async () => {
        const version = versions.find(item => item.id === versionSelect.value);
        if (version?.version !== 1 || version.name !== "Freedom Broker — качество диалогов") {
          throw new Error("Готовые ответы подготовлены для v1. Для новой версии заполни ответы вручную.");
        }
        show(await api.evaluate({
          conversation_id: record.id,
          checklist_version: version.id,
          results: window.CqaMock.demoResults
        }));
      });
    }
    versionSelect.addEventListener("change", () => form.replaceChildren());
    evaluations.filter(item => item.conversation_id === record.id).forEach((item, index) =>
      button(review, "Открыть оценку " + (index + 1) + " · " + total(item.final_score), () => show(item)));
  }

  async function checklists(view) {
    const lists = await api.checklists();
    lists.forEach(list => {
      const panel = add(view, "section");
      const name = field(panel, "Название чек-листа", "input", list.latest_version.name);
      add(panel, "h2", "Редактирование версии " + list.latest_version.version);
      const readCriteria = list.latest_version.criteria.map(criterion => {
        const card = add(panel, "fieldset");
        card.className = "cqa-criterion-editor";
        add(card, "legend", criterion.criterion_id + " · " + criterion.section);
        const id = field(card, "ID критерия (измени при замене)", "input", criterion.criterion_id);
        const text = field(card, "Название и правило", "textarea", criterion.text);
        const section = field(card, "Секция", "input", criterion.section);
        const weight = field(card, "Вес", "input", criterion.weight);
        weight.type = "number";
        weight.min = 0;
        const type = field(card, "Тип ответа", "select");
        option(type, "boolean", "Да / Нет");
        option(type, "scale", "Шкала");
        type.value = criterion.answer_type;
        const scale = field(card, "Ступени: одна строка на ступень, число | описание", "textarea",
          criterion.scale.map(step => step.value + " | " + step.description).join("\n"));
        const na = field(card, "Условие N/A (пусто, если запрещено)", "textarea", criterion.na_rule || "");
        text.parentElement.className = 'cqa-wide';
        scale.parentElement.className = 'cqa-wide';
        na.parentElement.className = 'cqa-wide';
        const updateScale = () => { scale.parentElement.hidden = type.value !== 'scale'; };
        type.addEventListener('change', updateScale);
        updateScale();
        return () => ({
          criterion_id: id.value.trim(),
          text: text.value,
          section: section.value,
          weight: weight.value.trim() === "" ? null : Number(weight.value),
          answer_type: type.value,
          allow_na: Boolean(na.value.trim()),
          na_rule: na.value,
          is_gross_error: criterion.is_gross_error,
          scale: type.value === "scale" ? scale.value.trim().split("\n").map(line => {
            const [value, ...description] = line.split("|");
            return { value: value.trim() === "" ? null : Number(value.trim()), description: description.join("|").trim() };
          }) : []
        });
      });
      const saved = add(panel, "p");
      button(panel, "Сохранить новую версию", async () => {
        const version = await api.saveVersion(list.id, { name: name.value, criteria: readCriteria.map(read => read()) });
        saved.textContent = "Сохранена версия " + version.version + ". Её можно выбрать в «Диалогах».";
      });
    });
  }

  async function appeals(view) {
    const entries = await api.appeals();
    if (!entries.length) add(view, "p", "Апелляций пока нет.");
    const list = add(view, "div");
    const details = add(view, "div");
    entries.forEach((entry, index) => button(list, "Апелляция " + (index + 1) + " · " +
      (entry.decision ? "закрыта" : "на рассмотрении"), () => openAppeal(details, entry.id)));
  }

  async function openAppeal(view, id) {
    const appeal = await api.appealDetails(id);
    view.replaceChildren();
    const grid = add(view, "div");
    grid.className = "cqa-grid";
    const rows = transcript(add(grid, "section"), appeal.conversation);
    const panel = add(grid, "section");
    add(panel, "h2", appeal.criterion.text);
    add(panel, "p", "Комментарий · " + appeal.comment);
    add(panel, "p", "Исходный ответ · " + answerText(appeal.original));
    add(panel, "p", appeal.original.explanation);
    evidence(panel, appeal.original.evidence_message_nos, rows);
    add(panel, "p", "Текущий ответ · " + answerText(appeal.current));
    add(panel, "p", "Исходный итог · " + total(appeal.evaluation.original_score));
    add(panel, "p", "Текущий итог · " + total(appeal.evaluation.final_score));
    if (appeal.decision) {
      add(panel, "p", (appeal.decision.action === "change" ? "Оценка изменена" : "Оценка подтверждена") + " · " + appeal.decision.reason);
      return;
    }
    const reason = field(panel, "Причина решения", "textarea");
    const read = answerFields(panel, appeal.criterion);
    const decide = async (action, replacement) => {
      await api.decide(id, { action, reason: reason.value, replacement });
      await openAppeal(view, id);
    };
    button(panel, "Подтвердить текущий ответ", () => decide("confirm"));
    button(panel, "Изменить ответ", () => decide("change", read()));
  }

  run(() => navigate("dialogs"));
})();
