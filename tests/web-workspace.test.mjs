import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorkspaceStorage,
  profilePatch,
  configurationDifferences,
  comparisonDifferences,
} from "../static/workspace.mjs";
import { matchesCaseResult } from "../static/case-batch.mjs";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test("workspace restores drafts and selections without allowing runtime sections", () => {
  const storage = memoryStorage();
  const first = createWorkspaceStorage(storage);
  const editor = {
    options: { promptVersion: "v1" },
    text: "草稿",
    drafts: { v1: "草稿" },
  };
  first.set("editor", editor);
  first.set("cases", { selected: ["weekends"], query: "week" });
  first.set("feedback", { run: { rating: "needs_work", note: "未保存" } });
  editor.text = "outside mutation";
  const restored = createWorkspaceStorage(storage);
  assert.equal(restored.get("editor").text, "草稿");
  const copy = restored.get("cases");
  copy.selected.push("other");
  assert.deepEqual(restored.get("cases").selected, ["weekends"]);
  assert.equal(restored.get("feedback").run.note, "未保存");
  assert.throws(
    () => first.set("session", { phase: "running" }),
    /Unsupported/,
  );
  assert.throws(() => first.set("apiKey", "credential"), /Unsupported/);
  assert.equal(restored.get("batch"), null);
});

test("unavailable, malformed and incompatible browser storage keep the app usable", () => {
  for (const content of ["{bad", '{"version":2,"values":{}}', "null"]) {
    const state = createWorkspaceStorage({
      getItem: () => content,
      setItem: () => {
        throw Error("quota");
      },
    });
    assert.deepEqual(state.get("editor", {}), {});
    assert.equal(state.set("editor", { text: "still in memory" }), false);
    assert.equal(state.get("editor").text, "still in memory");
  }
  const malformedSection = createWorkspaceStorage({
    getItem: () =>
      '{"version":1,"values":{"editor":"broken","feedback":[],"session":{"phase":"running"}}}',
    setItem() {},
  });
  assert.deepEqual(malformedSection.get("editor", {}), {});
  assert.deepEqual(malformedSection.get("feedback", {}), {});
  assert.equal(malformedSection.get("session"), null);
});

test("profile patch includes only changed options without copying the ledger", () => {
  const current = {
    options: { promptVersion: "old", provider: "mock", temperature: 0.7 },
    isPro: true,
    usedCredits: 17,
  };
  const options = { ...current.options, promptVersion: "candidate" };
  const patch = profilePatch(current, { options });
  assert.deepEqual(patch, { options: { promptVersion: "candidate" } });
  options.promptVersion = "changed later";
  assert.equal(patch.options.promptVersion, "candidate");
  assert.equal(current.options.promptVersion, "old");
  assert.deepEqual(profilePatch(current, { options: current.options }), {});
});

test("profile patch preserves explicit false and zero without submitting model settings", () => {
  const current = {
    options: { promptVersion: "saved" },
    isPro: true,
    usedCredits: 3,
  };
  assert.deepEqual(profilePatch(current, { isPro: false, usedCredits: 0 }), {
    isPro: false,
    usedCredits: 0,
  });
  assert.deepEqual(profilePatch(current, { isPro: true, usedCredits: 0 }), {
    usedCredits: 0,
  });
  assert.deepEqual(profilePatch(current, { isPro: true, usedCredits: 3 }), {});
  assert.deepEqual(
    configurationDifferences(current.options, current.options, true).map(
      (item) => item.key,
    ),
    ["draft"],
  );
});

test("A/B comparison ignores goal identity and object order but checks business context", () => {
  const a = {
    input: {
      locale: "zh-Hans",
      goal: { id: "a", title: "目标", deadline: "2026-12-01" },
      generationMode: "initial",
      excludedSuggestionTitles: [],
    },
    options: {
      model: "same",
      provider: "mock",
      temperature: 0.7,
      maxTokens: 8192,
    },
    entitlementBefore: { isPro: false },
    promptHash: "hash",
    promptEdited: false,
  };
  const b = structuredClone(a);
  b.input = {
    ...b.input,
    goal: { deadline: "2026-12-01", title: "目标", id: "b" },
  };
  assert.deepEqual(comparisonDifferences(a, b), []);
  b.input.generationMode = "refresh";
  b.input.excludedSuggestionTitles.push("已经展示");
  b.entitlementBefore.isPro = true;
  b.options.model = "different";
  b.promptHash = "changed";
  assert.equal(comparisonDifferences(a, b).length, 4);
});

test("case filters separate execution errors, assertion failures, skipped and reviewable runs", () => {
  assert.equal(
    matchesCaseResult(
      { state: "done", report: { verdict: "failed", runID: "a" } },
      "failed",
    ),
    true,
  );
  assert.equal(
    matchesCaseResult(
      { state: "done", report: { verdict: "failed" } },
      "errors",
    ),
    false,
  );
  assert.equal(
    matchesCaseResult(
      { state: "done", report: { verdict: "unexpected_input_rejection" } },
      "errors",
    ),
    true,
  );
  assert.equal(matchesCaseResult({ state: "skipped" }, "skipped"), true);
  assert.equal(
    matchesCaseResult(
      { state: "done", report: { verdict: "mock", runID: "a" } },
      "unreviewed",
    ),
    true,
  );
  assert.equal(
    matchesCaseResult(
      { state: "done", report: { verdict: "mock", runID: "a" } },
      "unreviewed",
      true,
    ),
    false,
  );
  assert.equal(
    matchesCaseResult(
      {
        state: "done",
        report: { verdict: "expected_input_rejection", runID: null },
      },
      "unreviewed",
    ),
    false,
  );
  assert.equal(matchesCaseResult(null, "failed"), false);
});
