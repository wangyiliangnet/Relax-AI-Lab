import test from "node:test";
import assert from "node:assert/strict";
import {
  dateText,
  numberText,
  recurrenceText,
  taskFacts,
} from "../static/task-presentation.mjs";
import { embeddedJSON, formattedJSON } from "../static/json-viewer.mjs";

const task = (changes = {}) => ({
  datePolicy: "none",
  taskSpec: null,
  ...changes,
});
const facts = (value, goal) =>
  Object.fromEntries(
    taskFacts(value, goal).map(({ label, value }) => [label, value]),
  );

test("recurrence uses the iOS names and calendar order", () => {
  for (const [type, name] of Object.entries({
    none: "无循环",
    daily: "每天",
    workdays: "每周工作日",
    weekends: "每周六、周日",
    ebbinghaus: "艾宾浩斯记忆法",
  }))
    assert.equal(recurrenceText({ type }), name);
  assert.equal(
    recurrenceText({
      type: "selected_weekdays",
      weekdays: ["friday", "monday", "wednesday"],
    }),
    "每周一、三、五",
  );
  assert.equal(
    recurrenceText({
      type: "selected_month_days",
      monthDays: [15, 1],
      includeLastDayOfMonth: true,
    }),
    "每月1日、15日、最后一天",
  );
  assert.equal(
    recurrenceText({ type: "interval", interval: 2, intervalUnit: "day" }),
    "定期循环（每2天）",
  );
  assert.equal(
    recurrenceText({ type: "interval", interval: 1, intervalUnit: "week" }),
    "每周",
  );
  assert.equal(
    recurrenceText({ type: "interval", interval: 1, intervalUnit: "day" }),
    "每天",
  );
});

test("goal date policy resolves only a complete recorded goal range", () => {
  const value = task({ datePolicy: "goal_range_if_available" });
  assert.deepEqual(
    facts(value, { startDate: "2026-11-06", deadline: "2026-12-21" }),
    { 循环: "无循环", 开始日期: "2026/11/06", 结束日期: "2026/12/21" },
  );
  assert.equal(facts(value, { deadline: "2026-12-21" }).日期, "不设置日期");
  assert.equal(
    facts(task(), { startDate: "2026-11-06", deadline: "2026-12-21" }).日期,
    "不设置日期",
  );
});

test("single date and recurring range match App date semantics", () => {
  const value = task({
    datePolicy: "explicit",
    startDate: "2026-11-06",
    endDate: "2026-11-06",
  });
  assert.equal(facts(value).执行日期, "2026/11/06");
  value.taskSpec = { recurrence: { type: "daily" } };
  assert.equal(facts(value).结束日期, "2026/11/06");
  value.endDate = null;
  assert.equal(facts(value).结束日期, "不设结束日期");
});

test("quantity parameters include decrease, reset and zero daily target", () => {
  const value = task({
    taskSpec: {
      kind: "progress",
      progress: {
        startValue: 70,
        targetValue: 65,
        dailyTarget: 0,
        unit: "kg",
        calculationType: "update",
        resetCycle: "none",
      },
    },
  });
  assert.equal(facts(value).量化目标, "70 → 65 kg");
  assert.equal(facts(value).进度计算方式, "更新");
  assert.equal(facts(value).进度重置周期, "不重置");
  assert.equal(facts(value).每日完成条件, "记录即算完成");
  Object.assign(value.taskSpec.progress, {
    startValue: 0,
    targetValue: 1000,
    dailyTarget: 2.5,
    calculationType: "add_up",
    resetCycle: "weekly",
    unit: "页",
  });
  assert.equal(facts(value).量化目标, "0 → 1,000 页");
  assert.equal(facts(value).每日完成条件, "至少 2.5 页");
  assert.equal(facts(value).进度计算方式, "求和");
  assert.equal(facts(value).进度重置周期, "每周");
});

test("date and number display remains timezone independent and readable", () => {
  assert.equal(dateText("2026-11-06"), "2026/11/06");
  assert.equal(dateText("2026-02-30"), "2026-02-30");
  assert.equal(numberText(10000.5), "10,000.5");
});

test("embedded model JSON is decoded without mutating recorded messages", () => {
  const message = { content: '{"plans":[{"title":"<script>"}]}' };
  const snapshot = JSON.stringify(message);
  assert.equal(embeddedJSON(message.content).plans[0].title, "<script>");
  assert.equal(JSON.stringify(message), snapshot);
  assert.equal(
    formattedJSON(embeddedJSON(message.content)),
    '{\n  "plans": [\n    {\n      "title": "<script>"\n    }\n  ]\n}',
  );
});

test("plain strings, invalid JSON and primitive strings remain literal", () => {
  for (const text of [
    "plain text",
    "{invalid",
    "null",
    "123",
    '"string"',
    "<img src=x>",
  ])
    assert.equal(embeddedJSON(text), null);
  assert.deepEqual(embeddedJSON(" [1,2] "), [1, 2]);
});
