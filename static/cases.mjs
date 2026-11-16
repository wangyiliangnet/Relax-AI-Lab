import { createJsonViewer } from "./json-viewer.mjs";
import {
  executeCaseBatch,
  filterCases,
  matchesCaseResult,
  summarizeBatch,
  verdictLabels,
} from "./case-batch.mjs";

const $ = (id) => document.getElementById(id);
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const configurationText = ({ options, promptText }) =>
  `${options.promptVersion}${promptText !== null ? "（草稿）" : ""} · ${options.model} · ${options.provider}`;

export function createCasesController({
  api,
  getConfiguration,
  onRunningChange,
  renderResult,
  workspace,
  getProvider,
  notify,
  onViewHistory,
  onCompareBatch,
}) {
  let catalog = [],
    selected = new Set(),
    activeID = null,
    batch = null,
    initialized = false,
    sessionOpen = false,
    blocked = false,
    detailKey = "",
    detailRequest = 0,
    executing = false,
    stopByUser = false,
    viewingArchive = false,
    ownedCurrent = false,
    archivePage = 1,
    archivePages = 1,
    archiveRequest = 0,
    pollTimer = null,
    lastRunning = false;
  const cache = new Map();
  const reviewed = new Set();
  const saved = workspace.get("cases", {});
  archivePage =
    Number.isInteger(saved.archivePage) && saved.archivePage > 0
      ? saved.archivePage
      : 1;
  if (typeof saved.name === "string") $("batchName").value = saved.name;
  if (typeof saved.query === "string") $("caseSearch").value = saved.query;
  if (["all", "main", "holdout"].includes(saved.suite))
    $("caseSuite").value = saved.suite;
  const remember = () =>
    workspace.set("cases", {
      query: $("caseSearch").value,
      suite: $("caseSuite").value,
      selected: [...selected],
      activeID,
      batchID: batch?.id || null,
      owned: ownedCurrent,
      archivePage,
      name: $("batchName").value,
    });
  const running = () =>
    executing || Boolean(batch?.items.some((item) => item.state === "running"));
  const displayCases = () =>
    viewingArchive && batch ? batch.items.map((item) => item.case) : catalog;
  const visibleCases = () =>
    filterCases(
      displayCases(),
      $("caseSearch").value,
      $("caseSuite").value,
    ).filter((item) =>
      matchesCaseResult(
        batchItem(item.id),
        $("caseResultFilter").value,
        reviewed.has(batchItem(item.id)?.report?.runID),
      ),
    );
  const batchItem = (id) => batch?.items.find((item) => item.caseID === id);

  function activityChanged() {
    if (lastRunning !== running()) {
      lastRunning = running();
      onRunningChange(lastRunning);
    }
  }
  async function refreshArchives() {
    const request = ++archiveRequest;
    const data = await api(`/lab/batches?page=${archivePage}&pageSize=8`);
    if (request !== archiveRequest) return;
    archivePage = data.page;
    archivePages = data.totalPages;
    $("batchArchiveStatus").textContent =
      `共 ${data.total} 个批次；选择归档不会自动发出模型请求。`;
    $("batchArchivePage").textContent = `${archivePage} / ${archivePages}`;
    $("batchArchivePrev").disabled = archivePage <= 1;
    $("batchArchiveNext").disabled = archivePage >= archivePages;
    $("batchArchiveList").replaceChildren();
    for (const entry of data.items) {
      const row = node("div", null, "batch-archive-row");
      const info = node("div");
      info.append(
        node("strong", entry.name || entry.options.promptVersion),
        node(
          "p",
          `${new Date(entry.startedAt).toLocaleString("zh-CN", { hour12: false })} · ${entry.options.provider} · ${entry.options.model} · ${entry.caseCount} 条 · ${{ completed: "已完成", stopped: "已停止", interrupted: "已中断", running: "待执行或处理中" }[entry.phase]} · ${entry.id.slice(0, 8)}`,
          "hint",
        ),
      );
      const actions = node("div", null, "button-row");
      const open = node("button", "打开归档", "secondary");
      open.type = "button";
      open.onclick = () =>
        openArchive(entry.id).catch((error) => notify(error.message, true));
      for (const slot of ["a", "b"]) {
        const compare = node(
          "button",
          "批次 " + slot.toUpperCase(),
          "secondary",
        );
        compare.type = "button";
        compare.onclick = () => onCompareBatch(slot, entry);
        actions.append(compare);
      }
      actions.prepend(open);
      row.append(info, actions);
      $("batchArchiveList").append(row);
    }
    remember();
  }
  function showBatch(value, archived = viewingArchive) {
    batch = value;
    viewingArchive = archived;
    for (const item of batch.items) if (item.feedback) reviewed.add(item.runID);
    detailKey = "";
    renderList();
    renderProgress();
    renderDetail();
    activityChanged();
    remember();
  }
  function poll() {
    clearTimeout(pollTimer);
    if (executing || !batch || batch.phase !== "running") return;
    const id = batch.id;
    pollTimer = setTimeout(async () => {
      try {
        const value = await api("/lab/batches/" + id);
        if (batch?.id !== id || executing) return;
        showBatch(value);
        poll();
      } catch (error) {
        notify("读取批次失败，请刷新归档：" + error.message, true);
        pollTimer = setTimeout(poll, 4000);
      }
    }, 1000);
  }
  async function openArchive(id, restoreOwned = false) {
    if (executing) throw new Error("请等待或停止当前批次，再打开其他归档。");
    let value = await api("/lab/batches/" + encodeURIComponent(id));
    if (restoreOwned && value.phase === "running")
      value = await api(
        "/lab/batches/" + encodeURIComponent(id) + "/stop",
        "POST",
        { reason: "browser_refresh" },
      );
    ownedCurrent = false;
    cache.clear();
    reviewed.clear();
    activeID = value.items.some((item) => item.caseID === activeID)
      ? activeID
      : value.items[0]?.caseID;
    $("caseSearch").value = "";
    $("caseResultFilter").value = "all";
    showBatch(value, true);
    poll();
  }
  function updateControls() {
    const visible = visibleCases(),
      count = visible.filter((item) => selected.has(item.id)).length;
    $("caseCatalogCount").textContent =
      `${visible.length} / ${displayCases().length}`;
    $("caseSelectionCount").textContent = selected.size
      ? `已选择 ${selected.size} 条用例（其中 ${selected.size - count} 条不在当前筛选中）`
      : "选择要评测的用例";
    const configProvider = getProvider();
    const maximumCalls = catalog.filter(
      (item) => selected.has(item.id) && !item.expect.inputError,
    ).length;
    $("evaluationHint").textContent = running()
      ? "本批配置已固定；站内导航继续，刷新读取归档并停止后续，不自动续跑。"
      : blocked
        ? "服务正在处理请求，请完成后手动运行。"
        : `每条采用自身权益；${configProvider === "mock" ? "Mock 不调用模型，不作质量结论。" : `预计最多 ${maximumCalls} 次上游调用，实际以执行结果为准。`}`;
    $("runCases").textContent = running()
      ? "评测运行中…"
      : `${configProvider === "mock" ? "运行 Mock 联调" : "运行所选用例"}${selected.size ? `（${selected.size}）` : ""}`;
    $("runCases").disabled =
      !initialized ||
      sessionOpen ||
      blocked ||
      running() ||
      viewingArchive ||
      !selected.size;
    $("caseResultFilter").disabled = !batch;
    $("stopCases").hidden = !batch || batch.phase !== "running";
    $("stopCases").disabled = Boolean(batch?.stopRequested);
    $("stopCases").textContent = batch?.stopRequested
      ? "等待当前用例完成…"
      : "停止后续用例";
    $("exportCases").disabled = !batch;
    $("batchName").disabled = running();
    $("currentCaseLibrary").disabled = running();
    $("leaveArchive").hidden = !viewingArchive;
    $("leaveArchive").disabled = running();
    $("archiveViewNotice").hidden = !viewingArchive;
    $("archiveViewNotice").textContent = batch
      ? `正在查看归档 ${batch.name || batch.id}。输入、断言与配置采用本批快照；不会自动续跑。返回当前用例库可准备新批次。`
      : "";
    $("clearCases").disabled = running() || viewingArchive || !selected.size;
    $("selectVisibleCases").disabled =
      !initialized || running() || viewingArchive || !visible.length;
    $("selectVisibleCases").checked =
      visible.length > 0 && count === visible.length;
    $("selectVisibleCases").indeterminate = count > 0 && count < visible.length;
    $("evaluationSessionNotice").hidden = !sessionOpen;
  }

  function renderList() {
    const list = $("caseList");
    list.replaceChildren();
    const visible = visibleCases();
    if (!visible.length) {
      const empty = node("div", null, "empty");
      empty.append(
        node("h3", "没有匹配的用例"),
        node("p", "试试其他关键词，或切换分组。"),
      );
      list.append(empty);
    }
    for (const item of visible) {
      const row = node("div", null, "case-row"),
        checkbox = node("input"),
        preview = node("button", null, "case-preview");
      row.classList.toggle("is-selected", activeID === item.id);
      row.classList.toggle("is-checked", selected.has(item.id));
      checkbox.type = "checkbox";
      checkbox.checked = selected.has(item.id);
      checkbox.disabled = running() || viewingArchive;
      checkbox.setAttribute("aria-label", `选择用例：${item.label}`);
      checkbox.onchange = () => {
        if (checkbox.checked) selected.add(item.id);
        else selected.delete(item.id);
        row.classList.toggle("is-checked", checkbox.checked);
        updateControls();
        remember();
      };
      preview.type = "button";
      preview.setAttribute("aria-pressed", String(activeID === item.id));
      preview.append(
        node("strong", item.label),
        node("span", item.context.goal.title, "case-goal"),
      );
      const meta = node("span", null, "case-row-meta");
      const result = batchItem(item.id);
      meta.append(
        node(
          "span",
          `${item.suite === "main" ? "主集" : "历史留出"} · ${item.isPro ? "Pro" : "免费"} · ${item.context.generationMode === "refresh" ? "换批" : "首次"}`,
        ),
      );
      if (result) {
        const text =
          result.state === "done"
            ? verdictLabels[result.report.verdict]
            : {
                running: "运行中…",
                pending: "待运行",
                error: "执行错误",
                skipped: "未执行",
              }[result.state];
        const tone =
          result.report?.verdict === "passed"
            ? "success"
            : result.state === "error" ||
                [
                  "failed",
                  "execution_error",
                  "unexpected_input_rejection",
                  "unexpected_input_acceptance",
                ].includes(result.report?.verdict)
              ? "failed"
              : result.state;
        meta.append(node("span", text, `case-result status-${tone}`));
      }
      preview.append(meta);
      preview.onclick = () => {
        activeID = item.id;
        renderList();
        renderDetail();
        if (matchMedia("(max-width: 800px)").matches)
          $("caseDetail").scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
      };
      row.append(checkbox, preview);
      list.append(row);
    }
    updateControls();
    remember();
  }

  function renderProgress() {
    $("evaluationProgress").hidden = !batch;
    if (!batch) return;
    const counts = summarizeBatch(batch),
      current = batch.items.find((item) => item.state === "running");
    $("batchHeading").textContent = running()
      ? "正在评测"
      : batch.phase === "interrupted"
        ? "批次已中断（未续跑）"
        : batch.phase === "stopped"
          ? "评测已停止"
          : batch.phase === "running"
            ? "等待浏览器执行或停止"
            : "本批评测完成";
    $("batchProgressText").textContent =
      `${counts.completed} / ${batch.items.length} 已完成${current ? ` · ${catalog.find((item) => item.id === current.caseID)?.label || current.caseID}` : ""}`;
    $("batchConfiguration").textContent =
      `归档 ${batch.id} · 本批配置：${configurationText(batch.configuration)} · 温度 ${batch.configuration.options.temperature} · 输出上限 ${batch.configuration.options.maxTokens}`;
    $("batchProgress").max = batch.items.length;
    $("batchProgress").value = counts.completed;
    $("batchCounts").replaceChildren();
    for (const [key, text] of [
      ["passed", "断言通过"],
      ["failed", "断言失败"],
      ["mock", "Mock 联调"],
      ["rejected", "预期拒绝"],
      ["errors", "执行错误"],
      ["skipped", "未执行"],
    ]) {
      const metric = node("span", null, `evaluation-count count-${key}`);
      metric.append(node("b", counts[key]), node("span", text));
      $("batchCounts").append(metric);
    }
    $("batchMessage").textContent =
      batch.message ||
      (batch.stopRequested
        ? "已停止后续用例，当前已发出的请求会完成并保留结果。"
        : running()
          ? "断言失败会继续下一条；调用或连接错误会停止后续用例，不自动重试。"
          : "点击用例查看建议与人工检查项；调用记录已保存，可在历史中评价和对比。");
  }

  async function renderDetail(force = false) {
    const item =
      batchItem(activeID)?.case || catalog.find((item) => item.id === activeID);
    if (!item) return;
    const result = batchItem(item.id),
      key = `${item.id}|${result?.state}|${result?.report?.runID}|${result?.error}`;
    if (!force && detailKey === key) return;
    detailKey = key;
    const request = ++detailRequest,
      target = $("caseDetail");
    target.replaceChildren();
    const heading = node("div", null, "box-heading"),
      title = node("div");
    title.append(
      node("span", item.id, "section-label"),
      node("h2", item.label),
    );
    heading.append(
      title,
      node(
        "span",
        `${item.suite === "main" ? "主集" : "历史留出组"} · ${item.isPro ? "Pro" : "免费"}`,
        "badge",
      ),
    );
    target.append(heading, node("h3", item.context.goal.title));
    if (item.context.goal.note)
      target.append(node("p", item.context.goal.note, "case-note"));
    target.append(
      node(
        "p",
        `请求日期 ${item.context.today} · ${item.context.locale} · ${item.context.generationMode}`,
        "hint",
      ),
      node(
        "p",
        `目标日期：${item.context.goal.startDate || "未设置开始日期"} → ${item.context.goal.deadline || "未设置截止日期"} · 已有任务 ${item.context.existingTaskTitles.length} 条 · 已展示建议 ${item.context.excludedSuggestionTitles.length} 条`,
        "hint",
      ),
    );
    const review = node("div", null, "case-review");
    review.append(node("strong", "人工检查项"), node("p", item.review));
    const input = node("details", null, "record-section");
    input.append(
      node("summary", "固定输入、权益与自动断言"),
      createJsonViewer(item),
    );
    target.append(review, input);
    const output = node("section", null, "record-section");
    output.append(node("h3", "评测结果"));
    target.append(output);
    if (!result || ["pending", "skipped"].includes(result.state)) {
      output.append(
        node(
          "p",
          !result
            ? "勾选用例并运行后，在这里查看结果。"
            : result.state === "pending"
              ? "已加入本批，等待运行。"
              : "本批未执行此用例，可重新选择后运行。",
          "hint",
        ),
      );
      return;
    }
    if (result.state === "running") {
      const loading = node("div", null, "loading");
      loading.append(
        node("span", null, "spinner"),
        node("span", "正在运行此用例…"),
      );
      output.append(loading);
      return;
    }
    if (result.error) {
      output.append(node("p", result.error, "error-box"));
      return;
    }
    const report = result.report;
    output.append(
      node(
        "p",
        verdictLabels[report.verdict] || report.verdict,
        report.verdict === "passed"
          ? "validation-success"
          : report.verdict === "failed"
            ? "validation-filtered"
            : "hint",
      ),
    );
    if (report.verdict === "mock")
      output.append(
        node(
          "p",
          "固定 Mock 输出仅验证联调流程，不代表当前 Prompt 通过质量评测。",
          "hint",
        ),
      );
    if (report.issues?.length) {
      const list = node("ul", null, "case-issues");
      for (const issue of report.issues) list.append(node("li", issue));
      output.append(list);
    }
    if (report.inputErrors) output.append(createJsonViewer(report.inputErrors));
    if (report.verdict === "expected_input_rejection")
      output.append(node("p", "输入已按预期被拦截，未调用模型。", "hint"));
    if (!report.runID) return;
    const history = node("button", "在历史中查看与对比 ↗", "link-button");
    history.onclick = () => onViewHistory(report.runID);
    output.append(history);
    const body = node("div");
    body.append(node("p", "读取调用记录…", "hint"));
    output.append(body);
    try {
      const run =
        cache.get(report.runID) || (await api(`/lab/runs/${report.runID}`));
      cache.set(run.id, run);
      if (request !== detailRequest) return;
      body.replaceChildren();
      renderResult(body, run);
    } catch (error) {
      if (request !== detailRequest) return;
      body.replaceChildren(
        node("p", `读取记录失败：${error.message}`, "error-box"),
      );
      const retry = node("button", "重新读取记录", "secondary");
      retry.onclick = () => renderDetail(true);
      body.append(retry);
    }
  }

  $("caseSearch").oninput = renderList;
  $("caseSuite").onchange = renderList;
  $("caseResultFilter").onchange = renderList;
  $("selectVisibleCases").onchange = () => {
    for (const item of visibleCases()) {
      if ($("selectVisibleCases").checked) selected.add(item.id);
      else selected.delete(item.id);
    }
    renderList();
  };
  $("clearCases").onclick = () => {
    selected.clear();
    renderList();
  };
  $("stopCases").onclick = async () => {
    if (!batch) return;
    stopByUser = true;
    batch.stopRequested = true;
    updateControls();
    renderProgress();
    try {
      const value = await api("/lab/batches/" + batch.id + "/stop", "POST", {
        reason: "user",
      });
      if (!executing) {
        showBatch(value);
        poll();
      }
    } catch (error) {
      notify(error.message, true);
    }
  };
  async function startBatch() {
    if (
      !initialized ||
      sessionOpen ||
      blocked ||
      running() ||
      viewingArchive ||
      !selected.size
    )
      return;
    $("replaceBatchNotice").hidden = true;
    $("caseResultFilter").value = "all";
    let configuration;
    try {
      configuration = getConfiguration();
    } catch (error) {
      notify(error.message, true);
      return;
    }
    executing = true;
    stopByUser = false;
    activityChanged();
    updateControls();
    try {
      batch = await api("/lab/batches", "POST", {
        ...configuration,
        caseIDs: catalog
          .filter((item) => selected.has(item.id))
          .map((item) => item.id),
        source: "browser",
        name: $("batchName").value,
      });
      archivePage = 1;
      ownedCurrent = true;
      viewingArchive = false;
      remember();
      cache.clear();
      if (!selected.has(activeID)) activeID = batch.items[0].caseID;
      detailKey = "";
      await executeCaseBatch(
        batch,
        (id) =>
          api(
            `/lab/batches/${batch.id}/items/${encodeURIComponent(id)}/run`,
            "POST",
          ),
        () => {
          renderList();
          renderProgress();
          renderDetail();
        },
      );
      if (batch.phase !== "completed")
        await api("/lab/batches/" + batch.id + "/stop", "POST", {
          reason: stopByUser ? "user" : "browser_closed",
        });
      batch = await api("/lab/batches/" + batch.id);
      ownedCurrent = false;
    } catch (error) {
      notify("批次请求未完成，可从归档核对：" + error.message, true);
      if (batch?.id && ownedCurrent) {
        try {
          batch = await api("/lab/batches/" + batch.id + "/stop", "POST", {
            reason: "browser_closed",
          });
        } catch {}
      }
    } finally {
      executing = false;
      activityChanged();
      if (batch) {
        const problem = batch.items.find(
          (item) =>
            item.state === "error" ||
            [
              "failed",
              "execution_error",
              "unexpected_input_rejection",
              "unexpected_input_acceptance",
            ].includes(item.report?.verdict),
        );
        if (problem) activeID = problem.caseID;
        showBatch(batch, false);
        poll();
      } else updateControls();
      refreshArchives().catch((error) => notify(error.message, true));
    }
  }
  $("runCases").onclick = () => {
    if (batch && !running()) {
      $("replaceBatchNotice").hidden = false;
      $("replaceBatchNotice").scrollIntoView({ block: "nearest" });
    } else startBatch();
  };
  $("replaceBatch").onclick = startBatch;
  $("cancelReplaceBatch").onclick = () => {
    $("replaceBatchNotice").hidden = true;
  };
  $("exportCases").onclick = () => {
    if (!batch) return;
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            { ...batch, cases: batch.items.map((item) => item.case) },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const link = node("a");
    link.href = url;
    link.download = `relax-evaluation-${batch.startedAt.replace(/[:.]/g, "-")}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $("reloadBatches").onclick = () =>
    refreshArchives().catch((error) => notify(error.message, true));
  $("batchArchivePrev").onclick = () => {
    archivePage--;
    refreshArchives().catch((error) => notify(error.message, true));
  };
  $("batchArchiveNext").onclick = () => {
    archivePage++;
    refreshArchives().catch((error) => notify(error.message, true));
  };
  $("batchName").oninput = remember;
  $("currentCaseLibrary").onclick = () => {
    if (running()) return;
    batch = null;
    viewingArchive = false;
    ownedCurrent = false;
    clearTimeout(pollTimer);
    $("caseResultFilter").value = "all";
    detailKey = "";
    renderList();
    renderProgress();
    remember();
    $("caseDetail").replaceChildren(
      node("p", "已返回当前用例库，选择用例准备新批次。", "hint"),
    );
  };
  $("leaveArchive").onclick = () => $("currentCaseLibrary").click();
  window.addEventListener("pagehide", () => {
    if (executing && batch?.id) {
      const data = new Blob([JSON.stringify({ reason: "browser_closed" })], {
        type: "application/json",
      });
      navigator.sendBeacon("/lab/batches/" + batch.id + "/stop", data);
    }
  });
  return {
    noteFeedback(run) {
      if (cache.has(run.id)) cache.get(run.id).feedback = run.feedback;
      if (run.feedback) reviewed.add(run.id);
      renderList();
    },
    async setCatalog(items) {
      catalog = items;
      const ids = new Set(items.map((item) => item.id));
      selected = new Set(
        (Array.isArray(saved.selected) ? saved.selected : []).filter((id) =>
          ids.has(id),
        ),
      );
      activeID = ids.has(saved.activeID) ? saved.activeID : null;
      renderList();
      if (activeID) renderDetail();
      if (typeof saved.batchID === "string") {
        try {
          await openArchive(saved.batchID, Boolean(saved.owned));
        } catch (error) {
          notify("无法恢复所选归档：" + error.message, true);
        }
      }
      refreshArchives().catch((error) => notify(error.message, true));
    },
    sync(state) {
      initialized = state.initialized;
      sessionOpen = state.sessionOpen;
      blocked = Boolean(state.blocked);
      updateControls();
    },
    configuration() {
      return running() ? batch?.configuration || null : null;
    },
  };
}
