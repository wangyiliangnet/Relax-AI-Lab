import { createJsonViewer } from "./json-viewer.mjs";
import {
  createCaseBatch,
  executeCaseBatch,
  filterCases,
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
  renderPlans,
  renderMetrics,
  renderTrace,
  notify,
  onViewHistory,
  onFeedback,
}) {
  let catalog = [],
    selected = new Set(),
    activeID = null,
    batch = null,
    initialized = false,
    sessionOpen = false,
    detailKey = "",
    detailRequest = 0;
  const cache = new Map();
  const feedbackDrafts = new Map();
  const running = () => batch?.phase === "running";
  const visibleCases = () =>
    filterCases(catalog, $("caseSearch").value, $("caseSuite").value);
  const batchItem = (id) => batch?.items.find((item) => item.caseID === id);

  function updateControls() {
    const visible = visibleCases(),
      count = visible.filter((item) => selected.has(item.id)).length;
    $("caseCatalogCount").textContent = `${visible.length} / ${catalog.length}`;
    $("caseSelectionCount").textContent = selected.size
      ? `已选择 ${selected.size} 条用例`
      : "选择要评测的用例";
    $("evaluationHint").textContent = running()
      ? "本批配置已固定，按顺序执行；切换页面后会继续运行。"
      : "每条使用固定日期与模拟权益；Mock 结果单独统计，建议质量需人工核对。";
    $("runCases").textContent = running()
      ? "评测运行中…"
      : `运行所选用例${selected.size ? `（${selected.size}）` : ""}`;
    $("runCases").disabled =
      !initialized || sessionOpen || running() || !selected.size;
    $("stopCases").hidden = !running();
    $("stopCases").disabled = Boolean(batch?.stopRequested);
    $("stopCases").textContent = batch?.stopRequested
      ? "等待当前用例完成…"
      : "停止后续用例";
    $("exportCases").disabled = !batch || running();
    $("clearCases").disabled = running() || !selected.size;
    $("selectVisibleCases").disabled =
      !initialized || running() || !visible.length;
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
      checkbox.disabled = running();
      checkbox.setAttribute("aria-label", `选择用例：${item.label}`);
      checkbox.onchange = () => {
        if (checkbox.checked) selected.add(item.id);
        else selected.delete(item.id);
        row.classList.toggle("is-checked", checkbox.checked);
        updateControls();
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
  }

  function renderProgress() {
    $("evaluationProgress").hidden = !batch;
    if (!batch) return;
    const counts = summarizeBatch(batch),
      current = batch.items.find((item) => item.state === "running");
    $("batchHeading").textContent = running()
      ? "正在评测"
      : batch.phase === "stopped"
        ? "评测已停止"
        : "本批评测完成";
    $("batchProgressText").textContent =
      `${counts.completed} / ${batch.items.length} 已完成${current ? ` · ${catalog.find((item) => item.id === current.caseID)?.label || current.caseID}` : ""}`;
    $("batchConfiguration").textContent =
      `本批配置：${configurationText(batch.configuration)} · 温度 ${batch.configuration.options.temperature} · 输出上限 ${batch.configuration.options.maxTokens}`;
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

  function feedbackEditor(run) {
    const section = node("section", null, "review record-section"),
      select = node("select"),
      note = node("textarea"),
      save = node("button", "保存评价", "secondary");
    const label = node("label", "评价"),
      noteLabel = node("label", "备注");
    select.id = "caseRating";
    note.id = "caseReviewNote";
    label.htmlFor = select.id;
    noteLabel.htmlFor = note.id;
    note.rows = 3;
    for (const [value, text] of [
      ["good", "可用"],
      ["needs_work", "需调整"],
      ["bad", "不可用"],
    ]) {
      const option = node("option", text);
      option.value = value;
      select.append(option);
    }
    const draft = feedbackDrafts.get(run.id) || run.feedback;
    select.value = draft?.rating || "needs_work";
    note.value = draft?.note || "";
    const rememberDraft = () =>
      feedbackDrafts.set(run.id, {
        rating: select.value,
        note: note.value,
      });
    select.onchange = rememberDraft;
    note.oninput = rememberDraft;
    save.onclick = async () => {
      save.disabled = true;
      try {
        run.feedback = await api(`/lab/runs/${run.id}/feedback`, "PATCH", {
          rating: select.value,
          note: note.value,
        });
        feedbackDrafts.delete(run.id);
        onFeedback(run);
        notify("评价已保存。");
      } catch (error) {
        notify(error.message, true);
      } finally {
        save.disabled = false;
      }
    };
    section.append(
      node("h3", "人工评价"),
      label,
      select,
      noteLabel,
      note,
      save,
    );
    return section;
  }

  async function renderDetail(force = false) {
    const item = catalog.find((item) => item.id === activeID);
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
      const metrics = node("div", null, "metrics");
      renderMetrics(metrics, run);
      body.append(metrics);
      renderPlans(body, run, false, { compact: true });
      body.append(feedbackEditor(run));
      const trace = node("details", null, "record-trace"),
        content = node("div");
      trace.append(node("summary", "请求、原始响应与费用"), content);
      renderTrace(content, run);
      body.append(trace);
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
  $("stopCases").onclick = () => {
    batch.stopRequested = true;
    updateControls();
    renderProgress();
  };
  $("runCases").onclick = async () => {
    if (!initialized || sessionOpen || running() || !selected.size) return;
    let configuration;
    try {
      configuration = getConfiguration();
    } catch (error) {
      notify(error.message, true);
      return;
    }
    batch = createCaseBatch(
      catalog.filter((item) => selected.has(item.id)).map((item) => item.id),
      configuration,
    );
    cache.clear();
    feedbackDrafts.clear();
    if (!selected.has(activeID)) activeID = batch.items[0].caseID;
    detailKey = "";
    onRunningChange(true);
    try {
      await executeCaseBatch(
        batch,
        (id, body) =>
          api(`/lab/cases/${encodeURIComponent(id)}/run`, "POST", {
            ...body,
            source: "browser",
          }),
        () => {
          renderList();
          renderProgress();
          renderDetail();
        },
      );
    } finally {
      onRunningChange(false);
      updateControls();
    }
  };
  $("exportCases").onclick = () => {
    if (!batch || running()) return;
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            { ...batch, cases: catalog.filter((item) => batchItem(item.id)) },
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
  return {
    noteFeedback(run) {
      if (cache.has(run.id)) cache.get(run.id).feedback = run.feedback;
      if (
        batchItem(activeID)?.report?.runID === run.id &&
        !feedbackDrafts.has(run.id)
      )
        renderDetail(true);
    },
    setCatalog(items) {
      catalog = items;
      renderList();
    },
    sync(state) {
      initialized = state.initialized;
      sessionOpen = state.sessionOpen;
      updateControls();
    },
  };
}
