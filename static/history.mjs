const $ = (id) => document.getElementById(id);
const node = (tag, text, className) => {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (className) e.className = className;
  return e;
};
const statuses = {
  success: "成功",
  failed: "失败",
  interrupted: "已中断",
  running: "生成中",
};
const ratings = { good: "可用", needs_work: "需调整", bad: "不可用" };
const when = (value) =>
  new Date(value).toLocaleString("zh-CN", { hour12: false });
export function createHistoryController({
  api,
  renderPlans,
  renderIssues,
  renderMetrics,
  renderTrace,
  notify,
  onFeedback,
}) {
  let runs = [],
    filtered = [],
    page = 0,
    selectedID = null,
    renderedID = null,
    renderedStatus = null,
    loadID = 0,
    detailID = 0,
    compareID = 0;
  const cache = new Map(),
    selection = { a: "", b: "" },
    pageSize = 8;
  const matches = (run) => {
    const query = $("historySearch").value.trim().toLowerCase(),
      state = $("historyStatus").value,
      source = $("historySource").value;
    return (
      (!query ||
        [run.goalTitle, run.id, run.options.promptVersion, run.options.model]
          .join(" ")
          .toLowerCase()
          .includes(query)) &&
      (state === "all" ||
        run.status === state ||
        (state === "failed" && run.status === "interrupted")) &&
      (source === "all" || run.source === source)
    );
  };
  function setView(next) {
    $("historyBrowse").hidden = next !== "browse";
    $("historyCompare").hidden = next !== "compare";
    $("historyBrowseTab").setAttribute(
      "aria-pressed",
      String(next === "browse"),
    );
    $("historyCompareTab").setAttribute(
      "aria-pressed",
      String(next === "compare"),
    );
  }
  function updateSelection() {
    const count = new Set(Object.values(selection).filter(Boolean)).size;
    $("compareSelectionInfo").textContent = `${count} / 2`;
    $("compare").disabled = count !== 2;
    $("compareA").value = selection.a;
    $("compareB").value = selection.b;
  }
  function choose(slot, id) {
    selection[slot] = id;
    compareID++;
    $("comparison").replaceChildren();
    updateSelection();
    renderList();
  }
  function populateChoices() {
    for (const [slot, id] of [
      ["a", "compareA"],
      ["b", "compareB"],
    ]) {
      const select = $(id);
      select.replaceChildren();
      const empty = node("option", "选择记录");
      empty.value = "";
      select.append(empty);
      for (const run of runs) {
        const option = node(
          "option",
          `${run.goalTitle.slice(0, 20)} · ${run.options.promptVersion} · ${when(run.createdAt)} · ${run.id.slice(0, 6)}`,
        );
        option.value = run.id;
        option.disabled = run.status === "running";
        select.append(option);
      }
      if (!runs.some((run) => run.id === selection[slot])) selection[slot] = "";
    }
    updateSelection();
  }
  function renderList() {
    filtered = runs.filter(matches);
    page = Math.min(
      page,
      Math.max(0, Math.ceil(filtered.length / pageSize) - 1),
    );
    $("historyCount").textContent = `${filtered.length} 条`;
    $("historyList").replaceChildren();
    const visible = filtered.slice(page * pageSize, (page + 1) * pageSize);
    if (!visible.length) {
      const empty = node("div", null, "empty");
      empty.append(node("h3", "没有匹配的记录"));
      $("historyList").append(empty);
    }
    for (const run of visible) {
      const row = node("div", null, "history-row");
      row.classList.toggle("is-selected", run.id === selectedID);
      const main = node("button", null, "history-row-main");
      main.type = "button";
      main.setAttribute("aria-pressed", String(run.id === selectedID));
      const heading = node("div", null, "history-row-heading");
      heading.append(
        node("strong", run.goalTitle),
        node(
          "span",
          statuses[run.status] || run.status,
          `record-status status-${run.status}`,
        ),
      );
      const meta = node("div", null, "history-row-meta");
      meta.append(
        node("span", run.options.promptVersion),
        node("span", `${run.validTaskCount ?? "—"} 条建议`),
        node(
          "span",
          new Date(run.createdAt).toLocaleString("zh-CN", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }),
        ),
      );
      main.append(heading, meta);
      main.onclick = () => selectRecord(run.id);
      row.append(main);
      const actions = node("div", null, "history-row-actions");
      actions.append(
        node(
          "span",
          run.feedback
            ? ratings[run.feedback.rating] || run.feedback.rating
            : run.source === "ios"
              ? "iOS"
              : "Web",
          "hint",
        ),
      );
      for (const slot of ["a", "b"]) {
        const chosen = selection[slot] === run.id,
          button = node(
            "button",
            chosen
              ? `已选 ${slot.toUpperCase()}`
              : `设为 ${slot.toUpperCase()}`,
            "compare-pick " + (chosen ? "picked-" + slot : ""),
          );
        button.type = "button";
        button.disabled = run.status === "running";
        button.setAttribute("aria-pressed", String(chosen));
        button.onclick = () => choose(slot, chosen ? "" : run.id);
        actions.append(button);
      }
      row.append(actions);
      $("historyList").append(row);
    }
    $("historyPage").textContent =
      `${page + 1} / ${Math.max(1, Math.ceil(filtered.length / pageSize))}`;
    $("historyPrev").disabled = page === 0;
    $("historyNext").disabled = (page + 1) * pageSize >= filtered.length;
  }
  async function record(id) {
    const summary = runs.find((run) => run.id === id),
      cached = cache.get(id);
    if (cached && (!summary || cached.status === summary.status)) {
      if (summary) cached.feedback = summary.feedback;
      return cached;
    }
    const result = await api("/lab/runs/" + id);
    cache.set(id, result);
    if (cache.size > 20) cache.delete(cache.keys().next().value);
    return result;
  }
  function feedbackEditor(run) {
    const wrapper = node("div", null, "review"),
      select = node("select"),
      note = node("textarea"),
      save = node("button", "保存评价", "secondary");
    const prefix = "history-feedback-" + run.id;
    select.id = prefix;
    note.id = prefix + "-note";
    note.rows = 3;
    const label = node("label", "评价");
    label.htmlFor = select.id;
    const noteLabel = node("label", "备注");
    noteLabel.htmlFor = note.id;
    for (const [value, text] of Object.entries(ratings)) {
      const option = node("option", text);
      option.value = value;
      select.append(option);
    }
    select.value = run.feedback?.rating || "needs_work";
    note.value = run.feedback?.note || "";
    save.disabled = run.status === "running";
    save.type = "button";
    save.onclick = async () => {
      save.disabled = true;
      try {
        const feedback = await api(
          "/lab/runs/" + run.id + "/feedback",
          "PATCH",
          { rating: select.value, note: note.value },
        );
        run.feedback = feedback;
        const summary = runs.find((item) => item.id === run.id);
        if (summary) summary.feedback = feedback;
        onFeedback(run);
        renderList();
        notify("评价已保存。");
      } catch (error) {
        notify(error.message, true);
      } finally {
        save.disabled = false;
      }
    };
    wrapper.append(label, select, noteLabel, note, save);
    return wrapper;
  }
  function detailSection(title, content, open = false) {
    const details = node("details", null, "record-section");
    details.open = open;
    details.append(node("summary", title), content);
    return details;
  }
  function renderDetail(run) {
    renderedID = run.id;
    renderedStatus = run.status;
    const target = $("historyDetail");
    target.replaceChildren();
    const heading = node("div", null, "box-heading");
    heading.append(
      node("h2", run.input.goal.title),
      node(
        "span",
        statuses[run.status] || run.status,
        `record-status status-${run.status}`,
      ),
    );
    target.append(heading);
    target.append(
      node(
        "p",
        `${when(run.createdAt)} · ${run.source === "ios" ? "iOS" : "Web"} · ${run.options.promptVersion}`,
        "hint",
      ),
    );
    const meta = node("dl", null, "record-facts");
    for (const [label, value] of [
      ["模型", run.options.model],
      ["Provider", run.options.provider],
      ["Run ID", run.id],
    ]) {
      const item = node("div");
      item.append(node("dt", label), node("dd", value));
      meta.append(item);
    }
    target.append(meta);
    const metrics = node("div", null, "metrics");
    renderMetrics(metrics, run);
    target.append(metrics);
    const tasks = node("div");
    renderPlans(tasks, run, false, { compact: true });
    target.append(
      detailSection(
        `任务建议 · ${(run.result?.plans || []).reduce((n, p) => n + p.suggestions.length, 0)} 条`,
        tasks,
        true,
      ),
    );
    const assessment = node("div");
    const issues = node("div");
    renderIssues(issues, run);
    assessment.append(issues, feedbackEditor(run));
    target.append(detailSection("校验与评价", assessment));
    const trace = node("div");
    renderTrace(trace, run);
    target.append(detailSection("请求与响应", trace));
  }
  async function selectRecord(id) {
    selectedID = id;
    const request = ++detailID;
    renderList();
    $("historyDetail").replaceChildren(node("p", "加载记录中…", "hint"));
    try {
      const run = await record(id);
      if (selectedID !== id || request !== detailID) return;
      renderDetail(run);
      if (matchMedia("(max-width: 800px)").matches)
        $("historyDetail").scrollIntoView({ block: "start" });
    } catch (error) {
      if (request === detailID)
        $("historyDetail").replaceChildren(
          node("div", error.message, "error-box"),
        );
    }
  }
  async function load(refreshDetail = false) {
    const request = ++loadID;
    const result = await api("/lab/runs");
    if (request !== loadID) return;
    runs = result;
    populateChoices();
    renderList();
    if (refreshDetail && selectedID) cache.delete(selectedID);
    if (
      selectedID &&
      (refreshDetail ||
        renderedID !== selectedID ||
        runs.find((run) => run.id === selectedID)?.status !== renderedStatus)
    )
      await selectRecord(selectedID);
  }
  async function compare() {
    if (!selection.a || !selection.b || selection.a === selection.b) return;
    const request = ++compareID,
      ids = [selection.a, selection.b];
    $("compare").disabled = true;
    $("comparison").replaceChildren(node("p", "加载实验结果中…", "hint"));
    try {
      const records = await Promise.all(ids.map(record));
      if (request !== compareID) return;
      $("comparison").replaceChildren();
      const differences = [];
      if (records[0].input.goal.id !== records[1].input.goal.id)
        differences.push("不同目标");
      else if (
        JSON.stringify(records[0].effectiveRequest) !==
        JSON.stringify(records[1].effectiveRequest)
      )
        differences.push("请求上下文不同");
      if (differences.length)
        $("comparison").append(
          node("p", differences.join(" · "), "comparison-context"),
        );
      records.forEach((run, index) => {
        const column = node("article", null, "box comparison-column");
        column.append(
          node(
            "span",
            index === 0 ? "实验 A" : "实验 B",
            "comparison-label label-" + (index === 0 ? "a" : "b"),
          ),
          node("h2", run.input.goal.title),
          node(
            "p",
            `${run.options.promptVersion} · ${run.options.model}`,
            "hint",
          ),
        );
        const metrics = node("div", null, "metrics");
        renderMetrics(metrics, run);
        column.append(metrics);
        if (run.feedback)
          column.append(
            node(
              "p",
              `${ratings[run.feedback.rating] || run.feedback.rating}${run.feedback.note ? " · " + run.feedback.note : ""}`,
              "comparison-feedback",
            ),
          );
        const tasks = node("div");
        renderPlans(tasks, run, false, { compact: true });
        column.append(tasks);
        const trace = node("div");
        renderTrace(trace, run);
        column.append(detailSection("请求与响应", trace));
        $("comparison").append(column);
      });
    } catch (error) {
      if (request === compareID)
        $("comparison").replaceChildren(
          node("div", error.message, "error-box"),
        );
    } finally {
      if (request === compareID) updateSelection();
    }
  }
  $("historyBrowseTab").onclick = () => setView("browse");
  $("historyCompareTab").onclick = () => setView("compare");
  for (const id of ["historySearch", "historyStatus", "historySource"])
    $(id).addEventListener(id === "historySearch" ? "input" : "change", () => {
      page = 0;
      renderList();
    });
  $("historyPrev").onclick = () => {
    page--;
    renderList();
  };
  $("historyNext").onclick = () => {
    page++;
    renderList();
  };
  $("reloadHistory").onclick = () =>
    load(true).catch((error) => notify(error.message, true));
  $("compareA").onchange = () => choose("a", $("compareA").value);
  $("compareB").onchange = () => choose("b", $("compareB").value);
  $("compare").onclick = compare;
  $("clearCompare").onclick = () => {
    selection.a = selection.b = "";
    compareID++;
    $("comparison").replaceChildren();
    updateSelection();
    renderList();
  };
  populateChoices();
  return {
    load,
    focusRecord(id) {
      selectedID = id;
      renderedID = null;
      page = 0;
      $("historySearch").value = "";
      $("historyStatus").value = $("historySource").value = "all";
      $("historyDetail").replaceChildren(node("p", "加载记录中…", "hint"));
      setView("browse");
    },
    noteFeedback(run) {
      const summary = runs.find((item) => item.id === run.id);
      if (summary) summary.feedback = run.feedback;
      cache.set(run.id, run);
      renderList();
    },
  };
}
