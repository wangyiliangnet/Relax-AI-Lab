import { verdictLabels } from "./case-batch.mjs";
import { money } from "./costs.mjs";

export const pairLabels = {
  new_failure: "新增失败",
  fixed: "已修复",
  still_failed: "仍失败",
  both_passed: "共同通过",
  scope_changed: "口径变化",
  unexecuted: "未执行",
  execution_error: "执行错误",
  mock: "Mock 联调",
  input_rejection: "预期输入拒绝",
  only_a: "仅 A",
  only_b: "仅 B",
};
const $ = (id) => document.getElementById(id);
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const label = (batch) =>
  `${batch.name || batch.options.promptVersion} · ${batch.options.provider} · ${new Date(batch.startedAt).toLocaleString("zh-CN", { hour12: false })} · ${batch.id.slice(0, 8)}`;

export function createBatchComparison({
  api,
  workspace,
  renderResult,
  notify,
}) {
  const saved = workspace.get("batchComparison", {});
  const selection = { a: saved.a || "", b: saved.b || "" };
  let page = Number.isInteger(saved.page) && saved.page > 0 ? saved.page : 1;
  let totalPages = 1,
    choices = [],
    result = null,
    loadID = 0,
    compareID = 0;
  const names = new Map();
  function remember() {
    workspace.set("batchComparison", { ...selection, page });
  }
  function updateChoices() {
    for (const slot of ["a", "b"]) {
      const select = $("batchCompare" + slot.toUpperCase());
      select.replaceChildren();
      const placeholder = node("option", "选择批次");
      placeholder.value = "";
      select.append(placeholder);
      for (const batch of choices) {
        names.set(batch.id, label(batch));
        const option = node("option", label(batch));
        option.value = batch.id;
        select.append(option);
      }
      if (
        selection[slot] &&
        !choices.some((batch) => batch.id === selection[slot])
      ) {
        const option = node(
          "option",
          names.get(selection[slot]) || "已选批次 · " + selection[slot],
        );
        option.value = selection[slot];
        select.append(option);
      }
      select.value = selection[slot];
    }
    $("compareBatches").disabled =
      !selection.a || !selection.b || selection.a === selection.b;
    $("batchChoicePage").textContent = `${page} / ${totalPages}`;
    $("batchChoicePrev").disabled = page <= 1;
    $("batchChoiceNext").disabled = page >= totalPages;
  }
  async function load() {
    const request = ++loadID;
    const data = await api(`/lab/batches?page=${page}&pageSize=8`);
    if (request !== loadID) return;
    choices = data.items;
    page = data.page;
    totalPages = data.totalPages;
    updateChoices();
    remember();
  }
  function choose(slot, batch) {
    selection[slot] = batch.id;
    names.set(
      batch.id,
      label({
        ...batch,
        options: batch.options || batch.configuration.options,
      }),
    );
    compareID++;
    result = null;
    $("batchCompareRows").replaceChildren();
    $("batchCompareSummary").replaceChildren();
    $("exportBatchComparison").disabled = true;
    $("batchCompareStatus").textContent =
      "已选择批次 " + slot.toUpperCase() + "，点击对比读取归档。";
    updateChoices();
    remember();
  }
  function renderSummary() {
    const host = $("batchCompareSummary");
    host.replaceChildren();
    const quality = result.quality;
    host.append(
      node(
        "p",
        quality.pairs
          ? `可比真实断言共同样本 ${quality.pairs} 条 · A 通过 ${quality.passedA} 条 · B 通过 ${quality.passedB} 条`
          : "无可比较的真实断言共同样本；Mock、输入拒绝、错误和未执行不计入质量通过率。",
        "notice",
      ),
    );
    const table = node("table", null, "batch-summary-table");
    const head = node("tr");
    for (const title of ["运行快照", "批次 A", "批次 B"])
      head.append(node("th", title));
    const header = node("thead");
    header.append(head);
    table.append(header);
    const body = node("tbody");
    for (const [title, getter] of [
      [
        "版本",
        (batch) =>
          batch.options.promptVersion + (batch.promptEdited ? "（草稿）" : ""),
      ],
      [
        "调用方式 / 模型",
        (batch) => batch.options.provider + " · " + batch.options.model,
      ],
      [
        "采样",
        (batch) =>
          `温度 ${batch.options.temperature} · 上限 ${batch.options.maxTokens}`,
      ],
      ["用例数", (batch) => String(batch.caseCount)],
      ["实际调用记录", (_, slot) => String(result["costs" + slot].runCount)],
      [
        "已知耗时 / 未知耗时",
        (_, slot) =>
          `${(result["costs" + slot].durationMs / 1000).toFixed(2)} s / ${result["costs" + slot].durationUnknownCount} 次未知`,
      ],
      [
        "已知输入 / 输出 tokens",
        (_, slot) =>
          `${result["costs" + slot].promptTokens} / ${result["costs" + slot].completionTokens} · ${result["costs" + slot].usageUnknownCount} 次用量未知`,
      ],
      ["完整 Prompt 指纹", (batch) => batch.promptHash],
      [
        "已知估算 / 未知费用",
        (_, slot) =>
          `${money(result["costs" + slot].knownAmount)} / ${result["costs" + slot].unknownCount} 次未知`,
      ],
    ]) {
      const row = node("tr");
      row.append(node("th", title));
      for (const slot of ["a", "b"])
        row.append(node("td", getter(result[slot], slot.toUpperCase())));
      body.append(row);
    }
    table.append(body);
    host.append(table);
    host.append(
      node(
        "p",
        "配置差异：" +
          (result.configurationDifferences.join("、") || "无") +
          "。每批每例一次采样；单次变化不代表稳定胜率。",
        "hint",
      ),
    );
    const counts = node("div", null, "batch-pair-counts");
    for (const [key, value] of Object.entries(result.counts))
      counts.append(node("span", `${pairLabels[key]} ${value}`, "badge"));
    host.append(counts);
  }
  async function populatePair(row, host) {
    const columns = node("div", null, "comparison batch-pair-columns");
    for (const slot of ["a", "b"]) {
      const side = row[slot],
        column = node("section", null, "box comparison-column");
      column.append(
        node(
          "h3",
          "批次 " +
            slot.toUpperCase() +
            " · " +
            result[slot].options.promptVersion,
        ),
      );
      if (!side) column.append(node("p", "此批次未选择该用例。", "hint"));
      else {
        column.append(
          node(
            "p",
            `第 ${side.attempt} 次 · ${verdictLabels[side.report?.verdict] || { pending: "待运行", running: "运行中", skipped: "未执行", error: "执行错误" }[side.state]}`,
            "hint",
          ),
        );
        if (side.runID) {
          const body = node("div");
          column.append(body);
          // A pair opens only its own two records, never all prompt bodies.
          api("/lab/runs/" + encodeURIComponent(side.runID))
            .then((run) => renderResult(body, run, { actions: false }))
            .catch((error) =>
              body.replaceChildren(node("p", error.message, "error-box")),
            );
        } else if (side.report?.inputErrors) {
          column.append(
            node("pre", JSON.stringify(side.report.inputErrors, null, 2)),
          );
        } else if (side.report?.serviceError)
          column.append(
            node("p", side.report.serviceError.message, "error-box"),
          );
      }
      columns.append(column);
    }
    host.append(node("p", row.review, "case-review"), columns);
  }
  function renderRows() {
    const host = $("batchCompareRows");
    host.replaceChildren();
    if (!result) return;
    const rows = result.rows.filter(
      (row) =>
        $("batchPairFilter").value === "all" ||
        row.category === $("batchPairFilter").value,
    );
    if (!rows.length) host.append(node("p", "此分类没有配对结果。", "empty"));
    for (const row of rows) {
      const details = node("details", null, "box batch-pair");
      const title = node(
        "summary",
        `${pairLabels[row.category]} · ${row.label} · ${row.caseID}`,
      );
      const body = node("div");
      let loaded = false;
      details.append(title, body);
      details.ontoggle = () => {
        if (details.open && !loaded) {
          loaded = true;
          populatePair(row, body);
        }
      };
      host.append(details);
    }
    $("batchCompareStatus").textContent =
      `按用例 ID 配对，共 ${result.rows.length} 条，本分类 ${rows.length} 条。口径变化、单边缺失和未执行已单列。`;
  }
  async function compare() {
    if (!selection.a || !selection.b || selection.a === selection.b) return;
    const request = ++compareID;
    $("compareBatches").disabled = true;
    $("batchCompareStatus").textContent = "读取两个批次的归档…";
    try {
      const data = await api(
        "/lab/batches/compare?" + new URLSearchParams(selection),
      );
      if (request !== compareID) return;
      result = data;
      names.set(data.a.id, label(data.a));
      names.set(data.b.id, label(data.b));
      $("batchPairFilter").value = "all";
      renderSummary();
      renderRows();
      $("exportBatchComparison").disabled = false;
    } catch (error) {
      if (request === compareID) notify(error.message, true);
    } finally {
      if (request === compareID) updateChoices();
    }
  }
  for (const slot of ["a", "b"])
    $("batchCompare" + slot.toUpperCase()).onchange = () => {
      choose(slot, {
        id: $("batchCompare" + slot.toUpperCase()).value,
        name: "",
        options: { promptVersion: "批次", provider: "" },
        startedAt: Date.now(),
      });
    };
  $("compareBatches").onclick = compare;
  $("reloadBatchChoices").onclick = () =>
    load().catch((error) => notify(error.message, true));
  $("batchChoicePrev").onclick = () => {
    page--;
    load().catch((error) => notify(error.message, true));
  };
  $("batchChoiceNext").onclick = () => {
    page++;
    load().catch((error) => notify(error.message, true));
  };
  $("batchPairFilter").onchange = renderRows;
  $("exportBatchComparison").onclick = () => {
    if (!result) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }),
    );
    const link = node("a");
    link.href = url;
    link.download = `batch-comparison-${result.a.id}-${result.b.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  updateChoices();
  return { load, choose };
}
