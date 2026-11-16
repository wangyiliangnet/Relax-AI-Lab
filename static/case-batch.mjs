export const verdictLabels = {
  mock: "Mock 联调",
  passed: "自动断言通过",
  failed: "自动断言失败",
  expected_input_rejection: "预期输入拒绝",
  unexpected_input_rejection: "输入被意外拒绝",
  unexpected_input_acceptance: "应拦截的输入通过了校验",
  execution_error: "执行错误",
};

export function formatCaseVerdict(report) {
  return [
    report.caseID,
    verdictLabels[report.verdict] || report.verdict,
    ...(report.issues || []),
  ].join(" · ");
}

export function filterCases(cases, query = "", suite = "all") {
  const search = query.trim().toLocaleLowerCase();
  return cases.filter(
    (item) =>
      (suite === "all" || item.suite === suite) &&
      (!search ||
        [
          item.id,
          item.label,
          item.context.goal.title,
          item.context.goal.note,
          item.review,
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(search)),
  );
}

export function matchesCaseResult(item, filter, reviewed = false) {
  if (filter === "all") return true;
  if (!item) return false;
  if (filter === "skipped") return item.state === "skipped";
  if (filter === "failed") return item.report?.verdict === "failed";
  if (filter === "errors")
    return (
      item.state === "error" ||
      (item.state === "done" &&
        !["passed", "failed", "mock", "expected_input_rejection"].includes(
          item.report?.verdict,
        ))
    );
  if (filter === "unreviewed") return Boolean(item.report?.runID) && !reviewed;
  return false;
}

export function createCaseBatch(ids, configuration) {
  return {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    configuration: structuredClone(configuration),
    phase: "running",
    stopRequested: false,
    message: "",
    items: [...new Set(ids)].map((caseID) => ({
      caseID,
      state: "pending",
      report: null,
      error: null,
    })),
  };
}

// The Lab accepts one generation at a time. Each request uses the batch's fixed
// configuration; a stop takes effect after the current request has completed.
export async function executeCaseBatch(batch, execute, onChange = () => {}) {
  onChange();
  try {
    for (const item of batch.items) {
      if (batch.stopRequested) break;
      item.state = "running";
      onChange();
      try {
        item.report = await execute(
          item.caseID,
          structuredClone(batch.configuration),
        );
        item.state = "done";
        if (item.report.verdict === "execution_error") {
          batch.stopRequested = true;
          batch.message =
            item.report.serviceError?.message || "调用失败，已停止后续用例。";
        }
      } catch (error) {
        item.state = "error";
        item.error = error.message;
        batch.stopRequested = true;
        batch.message = error.message;
      }
      onChange();
    }
  } finally {
    for (const item of batch.items) {
      if (item.state === "pending") item.state = "skipped";
    }
    batch.phase = batch.stopRequested ? "stopped" : "completed";
    batch.finishedAt = new Date().toISOString();
    onChange();
  }
  return batch;
}

export function summarizeBatch(batch) {
  const counts = {
    passed: 0,
    failed: 0,
    mock: 0,
    rejected: 0,
    errors: 0,
    skipped: 0,
    completed: 0,
  };
  for (const item of batch.items) {
    if (item.state === "skipped") counts.skipped++;
    if (item.state === "error") {
      counts.errors++;
      counts.completed++;
    }
    if (item.state !== "done") continue;
    counts.completed++;
    const verdict = item.report.verdict;
    if (["passed", "failed", "mock"].includes(verdict)) counts[verdict]++;
    else if (verdict === "expected_input_rejection") counts.rejected++;
    else counts.errors++;
  }
  return counts;
}
