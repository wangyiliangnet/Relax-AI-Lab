const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const ratings = { good: "可用", needs_work: "需调整", bad: "不可用" };
let editorID = 0;

export function createResultController({
  api,
  workspace,
  renderPlans,
  renderMetrics,
  renderIssues,
  renderTrace,
  notify,
  onFeedback,
  onCompare,
  onCopy,
}) {
  const drafts = workspace.get("feedback", {});
  const savedFeedback = new Map();
  const saving = new Set();
  const listeners = new Set();
  const persist = () => workspace.set("feedback", drafts);
  const broadcast = (id) => {
    for (const entry of listeners) {
      if (!entry.root.isConnected) listeners.delete(entry);
      else if (entry.id === id) entry.update();
    }
  };
  function noteFeedback(run) {
    savedFeedback.set(run.id, run.feedback);
    broadcast(run.id);
  }
  function feedbackEditor(run) {
    const root = node("div", null, "review feedback-editor");
    root.dataset.runId = run.id;
    const select = node("select"),
      note = node("textarea");
    const ratingLabel = node("label", "人工评价"),
      noteLabel = node("label", "备注");
    const prefix = "feedback-" + ++editorID;
    select.id = prefix;
    note.id = prefix + "-note";
    ratingLabel.htmlFor = select.id;
    noteLabel.htmlFor = note.id;
    note.rows = 3;
    const empty = node("option", "未评价，请选择");
    empty.value = "";
    select.append(empty);
    for (const [value, label] of Object.entries(ratings)) {
      const option = node("option", label);
      option.value = value;
      select.append(option);
    }
    const save = node("button", "保存评价", "secondary");
    save.type = "button";
    const state = node("p", "", "hint feedback-state");
    state.setAttribute("role", "status");
    function update() {
      const feedback = savedFeedback.has(run.id)
        ? savedFeedback.get(run.id)
        : run.feedback;
      const value = drafts[run.id] || feedback;
      select.value = value?.rating || "";
      note.value = value?.note || "";
      save.disabled =
        run.status === "running" || saving.has(run.id) || !select.value;
      state.textContent = saving.has(run.id)
        ? "正在保存…"
        : drafts[run.id]
          ? "未保存的评价草稿"
          : feedback
            ? "评价已保存"
            : "尚未进行人工评价";
    }
    const remember = () => {
      drafts[run.id] = { rating: select.value, note: note.value };
      persist();
      broadcast(run.id);
    };
    select.onchange = remember;
    note.oninput = remember;
    save.onclick = async () => {
      if (!select.value || saving.has(run.id)) return;
      const submitted = { rating: select.value, note: note.value };
      saving.add(run.id);
      broadcast(run.id);
      try {
        run.feedback = await api(
          "/lab/runs/" + encodeURIComponent(run.id) + "/feedback",
          "PATCH",
          submitted,
        );
        // Preserve edits made while the save was in flight.
        if (JSON.stringify(drafts[run.id]) === JSON.stringify(submitted))
          delete drafts[run.id];
        savedFeedback.set(run.id, run.feedback);
        persist();
        onFeedback(run);
        notify("评价已保存。");
      } catch (error) {
        notify(error.message, true);
      } finally {
        saving.delete(run.id);
        broadcast(run.id);
      }
    };
    listeners.add({ id: run.id, root, update });
    update();
    root.append(ratingLabel, select, noteLabel, note, state, save);
    return root;
  }
  function section(title, content, open = false) {
    const details = node("details", null, "record-section");
    details.open = open;
    details.append(node("summary", title), content);
    return details;
  }
  function render(target, run, { tasks = true, actions = true } = {}) {
    noteFeedback(run);
    target.replaceChildren();
    const source =
      { browser: "Web", ios: "iOS", agent: "Agent" }[run.source] || run.source;
    const status =
      {
        success: "成功",
        failed: "失败",
        interrupted: "已中断",
        running: "运行中",
      }[run.status] || run.status;
    const meta = node(
      "p",
      `${status} · ${source} · ${run.options.promptVersion}${run.promptEdited ? "（草稿）" : ""} · ${run.options.provider === "mock" ? "Mock 联调，不作质量结论" : "真实模型调用"}`,
      "result-summary",
    );
    target.append(
      meta,
      node(
        "p",
        `${new Date(run.createdAt).toLocaleString("zh-CN", { hour12: false })} · 运行快照 ${run.id}`,
        "hint run-identity",
      ),
    );
    if (actions) {
      const row = node("div", null, "button-row result-actions");
      for (const slot of ["a", "b"]) {
        const button = node(
          "button",
          "设为 " + slot.toUpperCase(),
          "secondary",
        );
        button.type = "button";
        button.disabled = run.status === "running";
        button.onclick = () => onCompare(slot, run);
        row.append(button);
      }
      const copy = node("button", "复制为当前试验", "secondary");
      copy.type = "button";
      copy.onclick = () => onCopy(run);
      const download = node("button", "导出 JSON", "secondary");
      download.type = "button";
      download.onclick = () => {
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(run, null, 2)], {
            type: "application/json",
          }),
        );
        const link = node("a");
        link.href = url;
        link.download = "relax-ai-" + run.id + ".json";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
      row.append(copy, download);
      target.append(row);
    }
    const metrics = node("div", null, "metrics");
    renderMetrics(metrics, run);
    target.append(metrics);
    if (tasks) {
      const suggestions = node("div");
      renderPlans(suggestions, run, false, { compact: true });
      target.append(section("任务建议", suggestions, true));
    }
    const checks = node("div");
    renderIssues(checks, run);
    target.append(
      section(
        "自动检查",
        checks,
        Boolean(
          run.error || run.issues?.length || run.caseEvaluation?.issues?.length,
        ),
      ),
      section("人工评价", feedbackEditor(run)),
    );
    const trace = node("div");
    renderTrace(trace, run);
    target.append(section("请求、原始响应与价格快照", trace));
  }
  return { render, noteFeedback };
}
