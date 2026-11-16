import { comparisonDifferences } from "./workspace.mjs";
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
const sourceLabels = { ios: "iOS", browser: "Web", agent: "Agent" };
const when = (value) =>
  new Date(value).toLocaleString("zh-CN", { hour12: false });
export function createHistoryController({
  api,
  renderResult,
  workspace,
  notify,
  onBatchView,
}) {
  const saved = workspace.get("history", {});
  let view = ["compare", "batches"].includes(saved.view)
    ? saved.view
    : "browse";
  let runs = [],
    total = 0,
    totalPages = 1,
    searchTimer,
    page = Number.isInteger(saved.page) && saved.page >= 0 ? saved.page : 0,
    selectedID = typeof saved.selectedID === "string" ? saved.selectedID : null,
    renderedID = null,
    renderedStatus = null,
    loadID = 0,
    detailID = 0,
    compareID = 0;
  const cache = new Map(),
    selection = {
      a: typeof saved.selection?.a === "string" ? saved.selection.a : "",
      b: typeof saved.selection?.b === "string" ? saved.selection.b : "",
    },
    pageSize = 8;
  for (const [id, value] of Object.entries(saved.filters || {}))
    if (
      [
        "historySearch",
        "historyStatus",
        "historySource",
        "historyProvider",
        "historyCaseID",
        "historyBatchID",
      ].includes(id) &&
      typeof value === "string"
    )
      $(id).value = value;
  const remember = () =>
    workspace.set("history", {
      page,
      selectedID,
      selection,
      view,
      filters: Object.fromEntries(
        [
          "historySearch",
          "historyStatus",
          "historySource",
          "historyProvider",
          "historyCaseID",
          "historyBatchID",
        ].map((id) => [id, $(id).value]),
      ),
    });
  function setView(next, loadBatches = true) {
    view = next;
    remember();
    $("historyBrowse").hidden = next !== "browse";
    $("historyCompare").hidden = next !== "compare";
    $("historyBatchCompare").hidden = next !== "batches";
    $("historyBatchTab").setAttribute(
      "aria-pressed",
      String(next === "batches"),
    );
    if (next === "batches" && loadBatches) onBatchView();
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
    remember();
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
      if (selection[slot] && !runs.some((run) => run.id === selection[slot])) {
        const extra = node("option", "已选调用 · " + selection[slot]);
        extra.value = selection[slot];
        select.append(extra);
      }
    }
    updateSelection();
  }
  function renderList() {
    $("historyCount").textContent = `共 ${total} 条 · 本页 ${runs.length} 条`;
    $("historyList").replaceChildren();
    const visible = runs;
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
      const detail = cache.get(run.id);
      meta.append(
        node(
          "span",
          run.options.promptVersion +
            ((run.promptEdited ?? detail?.promptEdited) ? "（草稿）" : ""),
        ),
        node(
          "span",
          run.options.provider === "mock" ? "Mock" : run.options.model,
        ),
        node("span", sourceLabels[run.source] || run.source),
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
      if (run.caseID) meta.append(node("span", "用例 " + run.caseID));
      if (run.batchID)
        meta.append(node("span", "批次 " + run.batchID.slice(0, 8)));
      main.append(heading, meta);
      main.onclick = () => selectRecord(run.id);
      row.append(main);
      const actions = node("div", null, "history-row-actions");
      actions.append(
        node(
          "span",
          run.feedback
            ? ratings[run.feedback.rating] || run.feedback.rating
            : "未评价",
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
    $("historyPage").textContent = `${page + 1} / ${totalPages}`;
    $("historyPrev").disabled = page === 0;
    $("historyNext").disabled = page + 1 >= totalPages;
  }
  async function record(id) {
    const summary = runs.find((run) => run.id === id),
      cached = cache.get(id);
    if (cached && (!summary || cached.status === summary.status)) {
      if (summary) cached.feedback = summary.feedback;
      return cached;
    }
    const result = await api("/lab/runs/" + encodeURIComponent(id));
    cache.set(id, result);
    if (cache.size > 20) cache.delete(cache.keys().next().value);
    return result;
  }
  function renderDetail(run) {
    renderedID = run.id;
    renderedStatus = run.status;
    const target = $("historyDetail");
    target.replaceChildren(node("h2", run.input.goal.title));
    const content = node("div");
    renderResult(content, run);
    target.append(content);
  }
  async function selectRecord(id, scroll = true) {
    selectedID = id;
    remember();
    const request = ++detailID;
    renderList();
    $("historyDetail").replaceChildren(node("p", "加载记录中…", "hint"));
    try {
      const run = await record(id);
      if (selectedID !== id || request !== detailID) return;
      renderDetail(run);
      if (scroll && matchMedia("(max-width: 800px)").matches)
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
    const params = new URLSearchParams({
      page: String(page + 1),
      pageSize: String(pageSize),
      q: $("historySearch").value.trim(),
      status: $("historyStatus").value || "all",
      source: $("historySource").value || "all",
    });
    for (const [field, key] of [
      ["historyProvider", "provider"],
      ["historyCaseID", "caseID"],
      ["historyBatchID", "batchID"],
    ]) {
      const value = $(field).value.trim();
      if (value && value !== "all") params.set(key, value);
    }
    $("historyLoadState").textContent = "正在检索全部记录…";
    let result;
    try {
      result = await api("/lab/runs?" + params);
    } catch (error) {
      if (request === loadID)
        $("historyLoadState").textContent =
          "读取失败，当前列表未更新，请刷新重试。";
      throw error;
    }
    if (request !== loadID) return;
    runs = result.items;
    total = result.total;
    totalPages = result.totalPages;
    page = result.page - 1;
    $("historyLoadState").textContent = "覆盖全部调用 · 筛选与分页由服务端完成";
    if (view === "batches") onBatchView();
    populateChoices();
    renderList();
    if (refreshDetail && selectedID) cache.delete(selectedID);
    if (
      selectedID &&
      (refreshDetail ||
        renderedID !== selectedID ||
        (runs.some((run) => run.id === selectedID) &&
          runs.find((run) => run.id === selectedID).status !== renderedStatus))
    )
      await selectRecord(selectedID, false);
    remember();
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
      const differences = comparisonDifferences(...records);
      $("comparison").append(
        node(
          "p",
          differences.length
            ? differences.join(" · ")
            : "业务输入、权益、模型、采样参数及 Prompt 指纹相同。",
          "comparison-context",
        ),
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
        const content = node("div");
        renderResult(content, run, { actions: false });
        column.append(content);
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
  $("historyBatchTab").onclick = () => setView("batches");
  for (const id of [
    "historySearch",
    "historyStatus",
    "historySource",
    "historyProvider",
    "historyCaseID",
    "historyBatchID",
  ]) {
    $(id).addEventListener(
      ["historySearch", "historyCaseID", "historyBatchID"].includes(id)
        ? "input"
        : "change",
      () => {
        page = 0;
        remember();
        clearTimeout(searchTimer);
        searchTimer = setTimeout(
          () => load().catch((error) => notify(error.message, true)),
          180,
        );
      },
    );
  }
  $("historyPrev").onclick = () => {
    page = Math.max(0, page - 1);
    load().catch((error) => notify(error.message, true));
  };
  $("historyNext").onclick = () => {
    page++;
    load().catch((error) => notify(error.message, true));
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
    remember();
  };
  populateChoices();
  setView(view, false);
  return {
    load,
    showBatchCompare() {
      setView("batches");
    },
    chooseRun(slot, run) {
      cache.set(run.id, run);
      choose(slot, run.id);
      populateChoices();
      setView("compare");
    },
    focusRecord(id) {
      selectedID = id;
      renderedID = null;
      page = 0;
      $("historySearch").value = "";
      $("historyStatus").value =
        $("historySource").value =
        $("historyProvider").value =
          "all";
      $("historyCaseID").value = $("historyBatchID").value = "";
      $("historyDetail").replaceChildren(node("p", "加载记录中…", "hint"));
      setView("browse");
    },
    noteFeedback(run) {
      const summary = runs.find((item) => item.id === run.id);
      if (summary) summary.feedback = run.feedback;
      cache.set(run.id, run);
      renderList();
      remember();
    },
  };
}
