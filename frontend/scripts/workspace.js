(() => {
  const api = window.CqaService;
  const root = document.querySelector("#cqa-app");
  const content = root.querySelector("#cqa-content");
  const status = root.querySelector("#cqa-status");
  const menuToggle = root.querySelector('#cqa-menu-toggle');
  function setMenuHidden(hidden, animate = false) {
    const panel = root.querySelector('#cqa-sidebar');
    const beforeColumns = getComputedStyle(root).gridTemplateColumns;
    const beforeHeight = panel.getBoundingClientRect().height;
    const beforeTransform = getComputedStyle(panel).transform;
    root.getAnimations().forEach(animation => animation.cancel());
    panel.getAnimations().forEach(animation => animation.cancel());
    root.classList.toggle('cqa-menu-hidden', hidden);
    const sidebar = root.querySelector('#cqa-sidebar');
    sidebar.inert = hidden;
    sidebar.setAttribute('aria-hidden', String(hidden));
    if (animate && typeof panel.animate === 'function') {
      const timing = {duration:420,easing:'cubic-bezier(.22,.61,.36,1)'};
      if (window.matchMedia('(min-width:48rem)').matches) {
        root.animate([{gridTemplateColumns:beforeColumns},{gridTemplateColumns:getComputedStyle(root).gridTemplateColumns}],timing);
        panel.animate([{transform:beforeTransform},{transform:hidden?'translateX(-100%)':'translateX(0)'}],timing);
      } else {
        panel.animate([{height:beforeHeight+'px'},{height:panel.getBoundingClientRect().height+'px'}],timing);
      }
    }

    menuToggle.setAttribute('aria-expanded', String(!hidden));
    const label = hidden ? 'Показать меню' : 'Скрыть меню';
    menuToggle.setAttribute('aria-label', label);
    menuToggle.title = label;
    menuToggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/><path d="' + (hidden ? 'm13 9 3 3-3 3' : 'm16 9-3 3 3 3') + '"/></svg>';
    try { localStorage.setItem('cqa-menu-hidden', String(hidden)); } catch {}
  }
  menuToggle.addEventListener('click', () => setMenuHidden(!root.classList.contains('cqa-menu-hidden'), true));
  try { setMenuHidden(localStorage.getItem('cqa-menu-hidden') === 'true'); } catch {}

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

  let actionSequence = 0;
  async function run(action, control) {
    const sequence = ++actionSequence;
    status.textContent = "Загрузка…";
    if (control) control.disabled = true;
    try {
      await action();
      if (sequence === actionSequence) status.textContent = "";
    } catch (error) {
      if (sequence === actionSequence) { status.textContent = error.message; status.scrollIntoView?.({ block: "nearest" }); }
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

  let currentPage = 'dialogs';
  let readDraft = null;
  let savedDraft = '';
  const isDirty = () => readDraft && readDraft() !== savedDraft;
  function leaveEditor() {
    return !isDirty() || window.confirm('Есть несохранённые изменения. Уйти без сохранения?');
  }
  window.addEventListener('beforeunload', event => {
    if (isDirty()) { event.preventDefault(); event.returnValue = ''; }
  });
  function navigate(page) {
    if (!leaveEditor()) { history.replaceState(null, '', '#' + currentPage); return; }
    readDraft = null;
    if (!pages[page]) page = "dialogs";
    if (location.hash !== "#" + page) history.pushState(null, "", "#" + page);
    currentPage = page;
    const view = document.createElement("div");
    stopAudio(content);
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

  const audioTargets = new WeakMap();
  const excerpts = new WeakMap();

  function stopAudio(container, except) {
    container.querySelectorAll('audio').forEach(player => {
      excerpts.get(player)?.();
      if (player !== except) player.pause();
    });
  }

  window.addEventListener('pagehide', () => stopAudio(root));
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopAudio(root); });

  function timestampMillis(value) {
    const relative = /^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)$/.exec(value);
    if (relative) return ((Number(relative[1] || 0) * 60 + Number(relative[2])) * 60 + Number(relative[3])) * 1000;
    return Date.parse(value);
  }

  function playEvidence(parts) {
    const { player } = parts[0];
    stopAudio(root, player);
    let index = 0;
    const clear = () => {
      player.removeEventListener('timeupdate', advance);
      player.removeEventListener('pause', clear);
      player.removeEventListener('ended', clear);
      excerpts.delete(player);
    };
    const advance = () => {
      if (index >= parts.length) return;
      if (player.seeking || player.currentTime < parts[index].end) return;
      index++;
      if (index < parts.length) player.currentTime = parts[index].offset;
      else { clear(); player.pause(); }
    };
    excerpts.set(player, clear);
    player.addEventListener('timeupdate', advance);
    player.addEventListener('pause', clear);
    player.addEventListener('ended', clear);
    player.currentTime = parts[0].offset;
    player.play().catch(clear);
  }

  function transcript(parent, record) {
    let player;
    const start = timestampMillis(record.transcript[0]?.timestamp);
    add(parent, "h2", "Транскрипт · " + record.conversation_id);
    add(parent, "p", [record.channel, record.language, record.group_id].join(" · "));
    if (record.channel === "voice call") {
      const audio = record.audio_url;
      if (audio && /^https?:\/\//i.test(audio)) {
        const link = add(parent, "a", "Открыть запись звонка");
        link.href = audio;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        player = add(parent, 'audio');
        player.controls = true;
        player.preload = 'none';
        const host = new URL(audio).hostname;
        player.src = host === 'ec88f21f1accecf38e20095a9fe175.a5.environment.api.powerplatform.com'
          ? '../api/conversations/' + encodeURIComponent(record.id) + '/audio' : audio;
        const playbackError = add(parent, 'p');
        playbackError.setAttribute('role', 'status');
        player.addEventListener('error', () => {
          playbackError.textContent = 'Встроенный плеер не загрузил запись. Воспользуйтесь ссылкой выше.';
        });
        player.setAttribute('aria-label', 'Запись звонка');
        add(parent, 'p', 'Доказательство воспроизводится до следующей метки времени и останавливается. Позиция приблизительная: паузы записи могут смещать звук относительно транскрипта.');
      } else {
        add(parent, "p", "Запись недоступна.");
      }
    }

    const list = add(parent, "ol");
    const rows = new Map();
    record.transcript.forEach((turn, index) => {
      const row = add(list, "li");
      row.dataset.speaker = turn.speaker;
      row.tabIndex = -1;
      add(row, "strong", turn.timestamp + " · " + turn.speaker);
      add(row, "p", turn.text);
      rows.set(turn.message_no, row);
      const offset = (timestampMillis(turn.timestamp) - start) / 1000;
      if (player && Number.isFinite(offset) && offset >= 0) {
        const next = (timestampMillis(record.transcript[index + 1]?.timestamp) - start) / 1000;
        audioTargets.set(row, { player, offset, end: next > offset ? next : offset + 5 });
      }
    });
    return rows;
  }

  function evidence(parent, numbers, rows, label = "Доказательство · " + numbers.join(", ")) {
    if (!numbers.length) return;
    button(parent, label, () => {
      rows.forEach(row => row.classList.remove("cqa-evidence"));
      const matches = numbers.map(number => rows.get(number)).filter(Boolean);
      matches.forEach(row => row.classList.add("cqa-evidence"));
      matches[0]?.focus({ preventScroll: true });
      matches[0]?.scrollIntoView({ block: "center" });
      const parts = [...new Set(matches)].map(row => audioTargets.get(row))
        .filter(Boolean).sort((a, b) => a.offset - b.offset);
      if (parts.length) playEvidence(parts);
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
    const uploadPanel = add(demoPanel, 'details');
    add(uploadPanel, 'summary', 'Импортировать файл JSON');
    const upload = field(uploadPanel, 'Загрузить транскрипт из JSON', 'input');
    upload.type = 'file'; upload.accept = '.json,application/json';
    button(uploadPanel, 'Импортировать JSON', async () => {
      const file = upload.files[0];
      if (!file) throw new Error('Выберите JSON-файл');
      if (file.size > 5 * 1024 * 1024) throw new Error('Файл должен быть не больше 5 МБ');
      let data;
      try { data = JSON.parse(await file.text()); } catch { throw new Error('Файл не содержит корректный JSON'); }
      if (!data || typeof data !== 'object') throw new Error('JSON должен содержать массив диалогов или объект records');
      const records = Array.isArray(data) ? data : data.records ?? data.data?.records ?? [data];
      const groupId = group.value.trim() || 'UPLOAD';
      await api.importJson({ group_id: groupId, records });
      await refresh(groupId);
    });
    const exportsPanel = add(view, 'details');
    add(exportsPanel, 'summary', 'Скачать результаты');
    const csv = add(exportsPanel, 'a', 'Скачать все оценки CSV');
    csv.href = '../api/exports/evaluations.csv'; csv.download = 'evaluations.csv';
    const dataset = field(exportsPanel, 'Набор для сдачи', 'select');
    option(dataset, 'dev', 'DEV · 65 диалогов'); option(dataset, 'prod', 'Контрольный · 10 чатов');
    const exportVersion = field(exportsPanel, 'Версия для JSON-экспорта', 'select');
    const exportLists = await api.checklists();
    for (const item of exportLists.filter(c => !['Тест','QA · проверка защиты'].includes(c.latest_version.name))) for (const v of await api.versions(item.id))
      option(exportVersion, v.id, v.name + ' · v' + v.version);
    const modelName = field(exportsPanel, 'Модель для экспорта', 'input', 'stealth/crouton-alpha');
    add(exportsPanel, 'p', 'Используется группа из поля выше. Официальный формат требует исходную рубрику. CSV содержит все сохранённые оценки.');
    const exportStatus = add(exportsPanel, 'p'); exportStatus.setAttribute('role', 'status');
    button(exportsPanel, 'Скачать results.json', async () => {
      exportStatus.textContent = '';
      const data = await api.exportSubmission({dataset:dataset.value,group_id:group.value.trim(),checklist_version:exportVersion.value,model:modelName.value.trim(),mode:'external_api',team_name:'Tumo'});
      const errors = data.results.filter(r => r.status !== 'ok').length;
      exportStatus.textContent = 'Записей: ' + data.results.length + '. Ошибок: ' + errors + (errors ? '. Файл неполный: завершите оценки перед сдачей.' : '. Все оценки готовы.');
      const url = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
      const link = add(exportsPanel,'a'); link.href=url; link.download='results.json'; link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url),1000);
    });
    const summary = add(view, "div");
    summary.className = "cqa-summary";
    const list = add(view, "div");
    list.className = "cqa-dialog-list";
    const details = add(view, "dialog");
    details.className = 'cqa-dialog-modal';
    details.setAttribute('aria-label', 'Диалог и оценка');
    const closeDetails = () => { stopAudio(details); details.close(); };
    details.addEventListener("close", () => stopAudio(details));
    details.addEventListener('click', event => { if (event.target === details) {
      const bounds = details.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDetails();
    } });
    async function refresh(groupId) {
      const records = await api.conversations();
      list.replaceChildren();
      stopAudio(details);
      details.replaceChildren();
      const visible = records.filter(record => groupId ? record.group_id === groupId : record.group_id !== 'DEMO' && !record.group_id.startsWith('QA-'));
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
    const demoTools = add(demoPanel, 'details');
    add(demoTools, 'summary', 'Учебный режим');
    add(demoTools, 'p', 'Вымышленные данные для тренировки. Они не входят в официальную выгрузку.');
    button(demoTools, "Загрузить вымышленный диалог", async () => {
      await api.importDemo();
      await refresh("DEMO");
    }).classList.add("cqa-secondary");
    const batchVersions = field(evaluatePanel, 'Чек-лист для оценки группы', 'select');
    (await api.checklists()).filter(c => !['Тест','QA · проверка защиты'].includes(c.latest_version.name)).forEach(c => option(batchVersions, c.latest_version.id, c.latest_version.name + ' · v' + c.latest_version.version));
    const batchStatus = add(toolbar, 'div');
    const conversationNames = new Map((await api.conversations()).map(c => [c.id, c.conversation_id]));
    async function monitorBatch(id) {
      await watch(() => api.batch(id), batch => {
        batchStatus.replaceChildren();
        add(batchStatus, 'p', jobLabels[batch.status] + ' · ' + batch.progress + '% · готово ' + batch.completed + '/' + batch.total + ' · ошибок ' + batch.failed);
        batch.jobs.forEach(job => {
          add(batchStatus, 'p', (conversationNames.get(job.conversation_id) || job.conversation_id) + ' · ' + jobLabels[job.status] + (job.cache_hit ? ' · из кэша' : '') + (job.error ? ' · ' + job.error : ''));
          if (job.evaluation_id) button(batchStatus, 'Открыть результат', () => openDialog(details, job.conversation_id, job.evaluation_id));
        });
        if (batch.failed && batch.processed === batch.total) button(batchStatus, 'Повторить только ошибки', async () => {
          const retry = await api.retryBatch(batch.id);
          await monitorBatch(retry.id);
        });
      }, () => view.isConnected);
    }
    button(evaluatePanel, 'Оценить группу через ИИ', async () => {
      const batch = await api.startBatch({ group_id: group.value.trim(), checklist_version: batchVersions.value });
      await monitorBatch(batch.id);
    });
    const savedBatches = await api.batches();
    savedBatches.filter(batch => batch.group_id !== 'DEMO' && !batch.group_id.startsWith('QA-')).slice(-5).reverse().forEach(batch => button(toolbar, 'Пакет ' + batch.group_id + ' · ' + jobLabels[batch.status], () => monitorBatch(batch.id)));
    await refresh();
  }

  async function openDialog(details, id, evaluationId) {
    details.dataset.dialogId = id;
    const [record, lists, evaluations] = await Promise.all([api.conversation(id), api.checklists(), api.evaluations()]);
    const versions = (await Promise.all(lists.map(list => api.versions(list.id)))).flat();
    if (!details.isConnected || details.dataset.dialogId !== id) return;
    stopAudio(details);
    details.replaceChildren();
    details.tabIndex = -1;
    const close = button(details, 'Закрыть ×', () => { stopAudio(details); details.close(); });
    close.className = 'cqa-modal-close';
    const heading = add(details, 'h2', 'Диалог · ' + record.conversation_id);

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
      versionSelect.value = evaluation.checklist_version;
      add(output, 'p', 'Оценка по чек-листу · ' + version.name + ' · v' + version.version).className = 'cqa-evaluation-version';
      add(output, "h2", "Итог · " + total(evaluation.final_score));
      if (evaluation.model) {
        add(output, "p", "✓ Сервер проверил формат ответа ИИ и ссылки на реплики. Баллы рассчитаны по весам чек-листа.").className = "cqa-verification";
      }
      add(output, "p", "Исходный итог · " + total(evaluation.original_score));
      evaluation.decisions.forEach(d => add(output, 'p', 'Решение проверяющего · ' + (version.criteria.find(c => c.criterion_id === d.criterion_id)?.text || 'Критерий') + ' · ' + (d.action === 'change' ? 'Изменено' : 'Подтверждено') + ' · ' + d.reason));
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
        if (!criterion.is_gross_error) {
          add(card, "p", "Вес · " + score.weight + " · баллы до N/A · " + (result.answer === "na" ? "—" : score.weighted_points));
          add(card, 'p', 'Вклад в итог после перераспределения N/A · ' + (result.answer === 'na' ? '—' : score.points ?? '—'));
        }
        add(card, "p", 'Обоснование исходной оценки · ' + original.explanation);
        if (result.na_reason) add(card, "p", "Причина N/A · " + result.na_reason);
        evidence(card, original.evidence_message_nos, rows);
        if (original.checked_range) {
          const range = original.checked_range;
          evidence(card, Array.from({ length: range.to - range.from + 1 }, (_, i) => range.from + i), rows,
            'Проверенный участок · ' + range.from + '–' + range.to);
        }
        const needsCoaching = result.answer !== 'na' && (criterion.is_gross_error ? result.answer === 'yes' :
          result.answer === 'no' || (result.answer === 'scale' && result.raw_score < Math.max(...criterion.scale.map(s => s.value))));
        if (needsCoaching) {
          const coach = add(card, "details");
          add(coach, "summary", "Как улучшить разговор? · Тренер оператора");
          add(coach, "p", "Правило · " + criterion.text);
          add(coach, "p", "Исходное объяснение ИИ · " + original.explanation);
          if (evaluation.decisions.some(d => d.criterion_id === criterion.criterion_id))
            add(coach, 'p', 'После пересмотра ориентируйтесь на решение проверяющего выше.');
          const range = original.checked_range;
          if (range) evidence(coach, Array.from({ length: range.to - range.from + 1 }, (_, i) => range.from + i),
            rows, "Проверенный участок · " + range.from + "–" + range.to);
          else evidence(coach, original.evidence_message_nos, rows);
          const templates = [
            [/^Установление контакта\s*:/i, ['Здравствуйте! Меня зовут [имя оператора]. Чем могу помочь?', 'Сәлеметсіз бе! Менің атым [оператордың аты]. Қалай көмектесе аламын?', 'Hello! My name is [operator name]. How can I help?']],
            [/^Выявление потребности\s*:/i, ['Правильно ли я понял, что вам нужно [запрос клиента]? Уточните, пожалуйста, [недостающая деталь].', 'Сізге [клиенттің сұрауы] қажет екенін дұрыс түсіндім бе? [Жетіспейтін мәліметті] нақтылаңызшы.', 'Have I understood correctly that you need [customer request]? Could you clarify [missing detail]?']],
            [/^Идентификация\s*:/i, ['Перед обсуждением персональных данных необходимо пройти проверку личности по утверждённой процедуре компании. Не отправляйте пароль или код подтверждения в чат.', 'Жеке деректерді талқыламас бұрын компания бекіткен сәйкестендіру рәсімінен өту қажет. Құпиясөзді немесе растау кодын чатқа жібермеңіз.', 'Before discussing personal information, please follow the company-approved identity verification process. Do not send passwords or verification codes in chat.']],
            [/^Корректная и полная консультация/i, ['По вашему вопросу: [проверенный ответ]. Следующий шаг: [подтверждённое действие]. Если информации недостаточно, я уточню её перед ответом.', 'Сұрағыңыз бойынша: [тексерілген жауап]. Келесі қадам: [расталған әрекет]. Ақпарат жеткіліксіз болса, жауап бермес бұрын нақтылаймын.', 'Regarding your question: [verified answer]. The next step is [confirmed action]. If information is missing, I will clarify it before answering.']],
            [/^Эмпатия\s*:/i, ['Понимаю, что [конкретная ситуация] вызывает неудобство. Давайте разберёмся, чем я могу помочь.', '[Нақты жағдай] қолайсыздық тудыратынын түсінемін. Қалай көмектесе алатынымды бірге қарастырайық.', 'I understand that [specific situation] is inconvenient. Let us look at how I can help.']],
            [/^Управление диалогом/i, ['Сначала [первый проверенный шаг], затем [следующий шаг]. Если понадобится время на уточнение, сообщу об этом. Уже допущенную задержку нельзя исправить новой репликой.', 'Алдымен [бірінші тексерілген қадам], содан кейін [келесі қадам]. Нақтылауға уақыт қажет болса, хабарлаймын. Өткен кідірісті жаңа хабарламамен түзету мүмкін емес.', 'First, [verified first step], then [next step]. I will let you know if clarification takes time. A new reply cannot undo an earlier delay.']],
            [/^Завершение\s*:/i, ['Удалось ли решить ваш вопрос? Если нужна дополнительная помощь, я готов помочь. Всего доброго!', 'Мәселеңіз шешілді ме? Қосымша көмек қажет болса, көмектесуге дайынмын. Сау болыңыз!', 'Has your issue been resolved? Please let me know if you need any further help. Goodbye!']],
            [/^Срок ответа\./i, ['Ответ поступит до [подтверждённые дата и время].', 'Жауап [расталған күн мен уақыт] дейін беріледі.', 'You will receive an answer by [confirmed date and time].']]
          ];
          const languageIndex = {RU:0,KZ:1,EN:2}[record.language] ?? 0;
          const template = templates.find(([pattern]) => pattern.test(criterion.text));
          const guidance = criterion.is_gross_error
            ? 'Требуется проверка руководителем: прекратите нарушение и действуйте по регламенту. Вежливая реплика не отменяет уже совершённое нарушение.'
            : template ? template[1][languageIndex] : 'Для изменённого правила готового шаблона нет. Составьте ответ по формулировке критерия и проверьте его с руководителем.';
          add(coach, "p", "Учебный пример · " + guidance);
          add(coach, 'p', 'Это учебный шаблон, не новый ответ модели. Заполните скобки только проверенными сведениями; не обещайте неподтверждённые сроки и условия.');
        }
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
        const missed = field(card, 'Действие пропущено', 'input'); missed.type = 'checkbox';
        const from = field(card, 'Начало проверенного участка (номер реплики)'); from.type = 'number'; from.min = 1;
        const to = field(card, 'Конец проверенного участка (номер реплики)'); to.type = 'number'; to.min = 1;
        return () => ({
          ...read(),
          missed_action: missed.checked,
          checked_range: from.value || to.value ? { from: Number(from.value), to: Number(to.value) } : null,
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
      if (done?.status === 'completed' && review.isConnected) {
        const evaluation = await api.evaluation(done.evaluation_id);
        if (evaluation.checklist_version === versionSelect.value) show(evaluation);
      }
    });
    const manualTools = add(actions, 'details');
    add(manualTools, 'summary', 'Ручная оценка');
    button(manualTools, "Заполнить оценку вручную", editAnswers);
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
    versionSelect.addEventListener("change", () => { form.replaceChildren(); output.replaceChildren(); jobStatus.textContent = ""; });
    const savedEvaluations = evaluations.filter(item => item.conversation_id === record.id);
    savedEvaluations.forEach((item, index) =>
      button(review, "Открыть оценку " + (index + 1) + " · " + total(item.final_score), () => show(item)));
    if (savedEvaluations.length) show(savedEvaluations.find(e => e.id === evaluationId) || savedEvaluations.at(-1));
    if (typeof details.showModal === 'function' && !details.open) details.showModal();
    close.focus({ preventScroll: true });
    details.scrollTop = 0;
  }

  let selectedChecklistId = null;
  async function checklists(view) {
    const lists = (await api.checklists()).filter(c => !['Тест','QA · проверка защиты'].includes(c.latest_version.name));
    const chooser = field(view, 'Выберите чек-лист', 'select');
    lists.forEach(list => option(chooser, list.id, list.latest_version.name));
    chooser.value = lists.some(list => list.id === selectedChecklistId) ? selectedChecklistId : lists[0]?.id || '';
    selectedChecklistId = chooser.value;
    const editor = add(view, 'div');
    const intro = add(view, 'p', 'Готовые правила уже заполнены. Меняйте их только при необходимости. Для оценки разговора перейдите в «Диалоги».');
    intro.className = 'cqa-help';
    view.insertBefore(intro, chooser.parentElement);
    const createPanel = add(view, 'details');
    add(createPanel, 'summary', 'Создать отдельный чек-лист');
    const newName = field(createPanel, 'Название нового чек-листа');
    button(createPanel, 'Создать на основе текущего', async () => {
      if (!lists.length) throw new Error('Нет начального чек-листа');
      const source = lists.find(list => list.id === chooser.value);
      if (!leaveEditor()) return;
      const created = await api.createChecklist({ ...source.latest_version, name: newName.value });
      readDraft = null;
      selectedChecklistId = created.checklist_id;
      await navigate('checklists');
    });
    function renderSelected() {
      readDraft = null;
      editor.replaceChildren();
      const list = lists.find(list => list.id === chooser.value);
      if (!list) return;
      const panel = add(editor, "section");
      const name = field(panel, "Название чек-листа", "input", list.latest_version.name);
      add(panel, "h2", "Редактирование версии " + list.latest_version.version);
      const readCriteria = [];
      const sandbox = add(panel, "details");
      add(sandbox, "summary", "Песочница весов");
      add(sandbox, "p", "Измените только веса ниже. Предпросмотр использует исходные ответы ИИ по этой версии.");
      const group = field(sandbox, "Группа диалогов", "input", "DEV");
      const preview = add(sandbox, "p");
      preview.setAttribute("role", "status");
      button(sandbox, "Проверить влияние весов", async () => {
        preview.textContent = "";
        const result = await api.previewWeights(list.latest_version.id, {
          group_id: group.value,
          criteria: readCriteria.map(read => read())
        });
        preview.textContent = "Средний балл · " + result.before.toFixed(2) + " → " + result.after.toFixed(2) +
          " · Сравнено " + result.compared + " из " + result.group_total +
          " · Выросли " + result.increased + " · Снизились " + result.decreased;
      });
      panel.addEventListener("input", () => { preview.textContent = ""; });
      const meter = add(panel, 'p'); meter.className = 'cqa-weight-meter'; meter.setAttribute('role', 'status');
      const criteriaPanel = add(panel, "div");
      function updateMeter() {
        const sum = readCriteria.reduce((n, read) => n + (read().weight ?? 0), 0);
        meter.textContent = 'Критериев: ' + readCriteria.length + ' · Сумма весов: ' + sum + ' / 100' + (Math.abs(sum - 100) < .000001 ? ' · Веса сбалансированы' : ' · Скорректируйте веса');
        meter.dataset.valid = String(Math.abs(sum - 100) < .000001);
      }
      function appendCriterion(criterion) {
        const disclosure = add(criteriaPanel, 'details'); disclosure.className = 'cqa-criterion-disclosure';
        disclosure.open = !criterion.text;
        const summary = add(disclosure, 'summary');
        const title = add(summary, 'strong', criterion.text.split(':')[0].split('.')[0] || 'Новый критерий');
        const meta = add(summary, 'span');
        const card = add(disclosure, "fieldset");
        card.className = "cqa-criterion-editor";
        add(card, "legend", "Настройки критерия");
        const criterionId = criterion.criterion_id;
        const text = field(card, "Что должен сделать оператор?", "textarea", criterion.text);
        const section = field(card, "Раздел проверки", "input", criterion.section);
        const weight = field(card, "Максимум баллов", "input", criterion.weight);
        weight.type = "number";
        weight.min = 0;
        const type = field(card, "Как оценивать?", "select");
        option(type, "boolean", "Да / Нет");
        option(type, "scale", "Шкала");
        type.value = criterion.answer_type;
        const scalePanel = add(card, 'div'); scalePanel.className = 'cqa-wide cqa-scale-panel';
        add(scalePanel, 'p', 'Баллы и условия их получения');
        const scaleRows = [];
        function addStep(step = {value:0,description:''}) {
          const row = add(scalePanel, 'div'); row.className = 'cqa-scale-row';
          const value = field(row, 'Баллы', 'input', step.value); value.type = 'number'; value.min = 0;
          const description = field(row, 'За что поставить', 'textarea', step.description);
          const read = () => ({value:value.value.trim() === '' ? null : Number(value.value),description:description.value.trim()});
          scaleRows.push(read);
          button(row, 'Убрать ступень', () => { scaleRows.splice(scaleRows.indexOf(read),1);row.remove(); }).className = 'cqa-secondary';
        }
        criterion.scale.forEach(addStep);
        button(scalePanel, 'Добавить ступень', () => addStep()).className = 'cqa-secondary';
        const naAllowed = field(card, 'Можно не оценивать, если правило неприменимо?', 'input'); naAllowed.type='checkbox';naAllowed.checked=criterion.allow_na;
        const na = field(card, 'Когда это правило не применяется?', 'textarea', criterion.na_rule || '');
        text.parentElement.className = 'cqa-wide'; na.parentElement.className = 'cqa-wide';
        const updateOptions = () => { scalePanel.hidden = type.value !== 'scale';na.parentElement.hidden=!naAllowed.checked; };
        type.addEventListener('change',updateOptions);naAllowed.addEventListener('change',updateOptions);updateOptions();
        const read = () => ({
          criterion_id: criterionId,
          text: text.value,
          section: section.value,
          weight: weight.value.trim() === "" ? null : Number(weight.value),
          answer_type: type.value,
          allow_na: naAllowed.checked,
          na_rule: naAllowed.checked ? na.value : null,
          is_gross_error: criterion.is_gross_error,
          scale: type.value === "scale" ? scaleRows.map(read => read()) : []
        });
        readCriteria.push(read);
        function updateSummary() {
          title.textContent = text.value.trim().split(':')[0].split('.')[0] || 'Новый критерий';
          meta.textContent = (criterion.is_gross_error ? 'Без баллов' : 'Вес ' + (weight.value || 0)) + ' · ' + (type.value === 'scale' ? 'Шкала' : 'Да / Нет') + (naAllowed.checked ? ' · Можно пропустить' : '');
          updateMeter();
        }
        card.addEventListener('input', updateSummary);
        card.addEventListener('change', updateSummary);
        updateSummary();
        button(card, 'Удалить критерий', () => {
          readCriteria.splice(readCriteria.indexOf(read), 1);
          disclosure.remove();
          updateMeter();
        }).className = 'cqa-secondary';
      }
      list.latest_version.criteria.forEach(appendCriterion);
      const shortcuts = add(panel, 'div'); shortcuts.className = 'cqa-actions';
      button(shortcuts, 'Раскрыть все', () => criteriaPanel.querySelectorAll('details').forEach(d => { d.open = true; })).className = 'cqa-secondary';
      button(shortcuts, 'Свернуть все', () => criteriaPanel.querySelectorAll('details').forEach(d => { d.open = false; })).className = 'cqa-secondary';
      button(panel, 'Добавить критерий', () => appendCriterion({
        criterion_id: 'new-' + Date.now(), text: '', section: 'Новая секция', weight: 0,
        answer_type: 'boolean', scale: [], na_rule: null, is_gross_error: false
      }));
      add(panel, 'p', 'Сумма весов должна быть 100. Удаление действует только в новой версии.');
      const saved = add(panel, "p");
      button(panel, "Сохранить новую версию", async () => {
        const criteria = readCriteria.map(read => read());
        const invalid = criteria.findIndex(c => !c.text.trim() || !c.section.trim() || !c.criterion_id || c.weight === null || c.weight < 0);
        if (invalid >= 0) {
          const disclosure = criteriaPanel.children[invalid]; disclosure.open = true;
          disclosure.querySelector('input,textarea')?.focus();
          throw new Error('Заполните название, секцию и вес критерия №' + (invalid + 1));
        }
        if (Math.abs(criteria.reduce((sum, c) => sum + c.weight, 0) - 100) > .000001) throw new Error('Сумма весов должна быть 100');
        const version = await api.saveVersion(list.id, { name: name.value, criteria });
        savedDraft = readDraft();
        list.latest_version = version;
        chooser.selectedOptions[0].textContent = version.name;
        panel.querySelector('h2').textContent = 'Редактирование версии ' + version.version;
        saved.textContent = "Сохранена версия " + version.version + ". Её можно выбрать в «Диалогах».";
      });
      readDraft = () => JSON.stringify({name:name.value, criteria:readCriteria.map(read => read())});
      savedDraft = readDraft();
    }
    chooser.addEventListener('change', () => { if (!leaveEditor()) { chooser.value = selectedChecklistId; return; } selectedChecklistId = chooser.value; renderSelected(); });
    renderSelected();
  }

  async function appeals(view) {
    const entries = await api.appeals();
    if (!entries.length) add(view, "p", "Апелляций пока нет.");
    const list = add(view, "div");
    const details = add(view, "div");
    entries.forEach((entry, index) => {
      const control = button(list, "Апелляция " + (index + 1) + " · " +
        (entry.decision ? "закрыта" : "на рассмотрении"), () => openAppeal(details, entry.id, () => {
          control.textContent = 'Апелляция ' + (index + 1) + ' · закрыта';
        }));
    });
  }

  async function openAppeal(view, id, onDecision) {
    const appeal = await api.appealDetails(id);
    stopAudio(view);
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
    if (appeal.original.checked_range) {
      const range = appeal.original.checked_range;
      add(panel, 'p', 'Проверенный участок: ' + range.from + '–' + range.to);
      evidence(panel, Array.from({ length: range.to - range.from + 1 }, (_, i) => range.from + i), rows);
    }
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
      onDecision?.();
      await openAppeal(view, id, onDecision);
    };
    button(panel, "Подтвердить текущий ответ", () => decide("confirm"));
    button(panel, "Изменить ответ", () => decide("change", read()));
  }

  const embed = root.querySelector("#cqa-embed");
  const setEmbed = enabled => {
    root.classList.toggle("cqa-crm-embed", enabled);
    embed.setAttribute("aria-pressed", String(enabled));
    embed.textContent = enabled ? "Выйти из предпросмотра" : "Предпросмотр виджета Dynamics 365";
  };
  setEmbed(new URLSearchParams(location.search).get("embed") === "crm");
  embed.addEventListener("click", () => setEmbed(!root.classList.contains("cqa-crm-embed")));

  window.addEventListener("popstate", () => run(() => navigate(location.hash.slice(1))));
  run(() => navigate(location.hash.slice(1) || "dialogs"));
})();
