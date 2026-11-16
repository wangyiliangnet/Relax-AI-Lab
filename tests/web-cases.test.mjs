import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createCaseBatch,
  executeCaseBatch,
  filterCases,
  summarizeBatch,
} from "../static/case-batch.mjs";

const configuration = () => ({
  options: {
    provider: "mock",
    model: "deepseek-flash",
    promptVersion: "coach-v1",
    temperature: 0.7,
    maxTokens: 8192,
  },
  promptText: "评测草稿",
});
const report = (caseID, verdict) => ({
  caseID,
  verdict,
  runID: null,
  issues: [],
});

test("batch runs each selected case once, sequentially, with a fixed configuration", async () => {
  const input = configuration(),
    batch = createCaseBatch(["first", "second", "first"], input);
  input.options.promptVersion = "changed";
  input.promptText = "changed";
  let active = 0,
    maximumActive = 0;
  const requests = [];
  await executeCaseBatch(batch, async (id, body) => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    requests.push([id, structuredClone(body)]);
    body.options.model = "mutation by executor";
    await Promise.resolve();
    active--;
    return report(id, "mock");
  });
  assert.equal(maximumActive, 1);
  assert.deepEqual(
    requests.map(([id]) => id),
    ["first", "second"],
  );
  for (const [, body] of requests) assert.deepEqual(body, configuration());
  assert.equal(batch.phase, "completed");
  assert.ok(batch.finishedAt);
  assert.equal(summarizeBatch(batch).mock, 2);
});

test("stopping preserves the in-flight result and leaves later cases unexecuted", async () => {
  const batch = createCaseBatch(["first", "second", "third"], configuration());
  let finish;
  const calls = [];
  const execution = executeCaseBatch(batch, (id) => {
    calls.push(id);
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  assert.equal(batch.items[0].state, "running");
  batch.stopRequested = true;
  finish(report("first", "passed"));
  await execution;
  assert.deepEqual(calls, ["first"]);
  assert.equal(batch.items[0].report.verdict, "passed");
  assert.deepEqual(
    batch.items.map((item) => item.state),
    ["done", "skipped", "skipped"],
  );
  assert.equal(batch.phase, "stopped");
  assert.equal(summarizeBatch(batch).skipped, 2);
});

test("assertion failures continue; Mock and expected input rejections stay separate", async () => {
  const verdicts = [
    "failed",
    "passed",
    "mock",
    "expected_input_rejection",
    "unexpected_input_acceptance",
  ];
  const batch = createCaseBatch(verdicts, configuration());
  await executeCaseBatch(batch, async (id) => report(id, id));
  assert.equal(batch.phase, "completed");
  assert.deepEqual(summarizeBatch(batch), {
    passed: 1,
    failed: 1,
    mock: 1,
    rejected: 1,
    errors: 1,
    skipped: 0,
    completed: 5,
  });
});

test("upstream execution errors stop without retry and retain the failed run", async () => {
  const batch = createCaseBatch(["first", "second"], configuration());
  let calls = 0;
  await executeCaseBatch(batch, async (id) => {
    calls++;
    return {
      ...report(id, "execution_error"),
      runID: "failed-run",
      serviceError: { message: "未配置 API key" },
    };
  });
  assert.equal(calls, 1);
  assert.equal(batch.items[0].report.runID, "failed-run");
  assert.equal(batch.items[1].state, "skipped");
  assert.match(batch.message, /API key/);
  assert.equal(summarizeBatch(batch).errors, 1);
});

test("connection errors preserve completed results and release batch state", async () => {
  const batch = createCaseBatch(["first", "second", "third"], configuration());
  const phases = [];
  await executeCaseBatch(
    batch,
    async (id) => {
      if (id === "second") throw new Error("连接中断");
      return report(id, "mock");
    },
    () => phases.push(batch.phase),
  );
  assert.equal(batch.items[0].report.verdict, "mock");
  assert.equal(batch.items[1].error, "连接中断");
  assert.equal(batch.items[2].state, "skipped");
  assert.equal(phases.at(-1), "stopped");
  assert.ok(batch.finishedAt);
  assert.equal(summarizeBatch(batch).completed, 2);
});

test("catalog filtering covers the real suites, IDs, goals and human checks", () => {
  const catalog = ["main", "holdout"].flatMap((suite) =>
    JSON.parse(
      readFileSync(
        new URL(`../examples/task-inspirations/${suite}.json`, import.meta.url),
      ),
    ).map((item) => ({ ...item, suite })),
  );
  assert.equal(filterCases(catalog).length, 64);
  assert.equal(filterCases(catalog, "", "main").length, 54);
  assert.equal(filterCases(catalog, "", "holdout").length, 10);
  assert.equal(filterCases(catalog, " FREE-MONTHEND ")[0].id, "free-monthend");
  assert.ok(
    filterCases(catalog, "十分钟是两组全选").some(
      (item) => item.id === "vocab",
    ),
  );
  assert.equal(filterCases(catalog, "不存在的场景").length, 0);
});
