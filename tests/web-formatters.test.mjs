import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  dateText,
  numberText,
  recurrenceText,
  taskFacts,
} from "../static/task-presentation.mjs";
import { embeddedJSON, formattedJSON } from "../static/json-viewer.mjs";
import { createCostsController, costText, money, periodText } from "../static/costs.mjs";

test("costs distinguish zero, unknown and tiny nonzero charges", () => {
  assert.equal(costText(null), "未知");
  assert.equal(costText({ status: "unknown", amount: null }), "未知");
  assert.equal(costText({ status: "pending" }), "待完成");
  assert.equal(costText({ status: "free", amount: "0" }), "¥0.00 · 未计费");
  assert.equal(costText({ status: "estimated", amount: "0.001216" }), "¥0.001216 · 估算");
  assert.equal(money("0.0000000001"), "< ¥0.00000001");
});

test("pricing form switches, saves and deletes tariffs, and recovers from deletion errors", async () => {
  const html = readFileSync(new URL("../static/index.html", import.meta.url), "utf8");
  const element = () => ({
    value: "", textContent: "", children: [],
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this[name] = value; },
    focus() {},
  });
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)]
    .map(([, id]) => [id, element()]));
  elements.priceModel.value = "deepseek-flash";
  elements.pricePeriod.value = "deepseek_peak";
  const previous = globalThis.document;
  globalThis.document = { getElementById: (id) => elements[id], createElement: element };
  const prices = [
    { provider: "deepseek", baseURL: "https://api.deepseek.com",
      model: "deepseek-flash", period: "deepseek_peak", label: "Peak", source: "builtin",
      inputCacheHitPerMillion: "0.04", inputCacheMissPerMillion: "2", outputPerMillion: "8" },
    { provider: "deepseek", baseURL: "https://api.deepseek.com",
      model: "deepseek-flash", period: "deepseek_off_peak", label: "Off peak", source: "builtin",
      inputCacheHitPerMillion: "0.02", inputCacheMissPerMillion: "1", outputPerMillion: "4" },
  ];
  const saved = [], deleted = [], notifications = [];
  let failDelete = false;
  const totals = { runCount: 0, knownAmount: "0", unknownCount: 0, pendingCount: 0 };
  try {
    const controller = createCostsController({ notify: (...args) => notifications.push(args),
      api: async (url, method, body) => {
      if (method === "PUT") { saved.push(body); return body; }
      if (method === "DELETE") {
        if (failDelete) throw new Error("正在生成，请稍后删除");
        deleted.push(body);
        prices.splice(prices.findIndex((rule) => Object.keys(body).every((key) => body[key] === rule[key])), 1);
        return { deleted: true };
      }
      if (url === "/lab/pricing") return prices;
      if (url === "/lab/costs") return { totals, groups: [] };
      if (url === "/lab/pricing-periods") return {
        serverTime: "2026-11-07T10:00:00+08:00", timeZone: "Asia/Shanghai",
        currentPeriod: "deepseek_off_peak",
      };
      throw new Error(`Unexpected request: ${url}`);
    } });
    await controller.load();
    assert.equal(elements.priceHit.value, "0.04");
    elements.pricePeriod.value = "deepseek_off_peak";
    elements.pricePeriod.onchange();
    assert.equal(elements.priceHit.value, "0.02");
    await elements.pricingForm.onsubmit({ preventDefault() {} });
    assert.equal(saved[0].period, "deepseek_off_peak");
    assert.equal(saved[0].outputPerMillion, "4");
    elements.pricePeriod.value = "all_day";
    elements.pricePeriod.onchange();
    assert.equal(elements.priceOutput.value, "");
    elements.priceHit.value = "1";
    elements.priceMiss.value = "1";
    elements.priceOutput.value = "4";
    await elements.pricingForm.onsubmit({ preventDefault() {} });
    assert.equal(saved[1].period, "all_day");
    assert.equal(saved[1].label, "全时段");
    assert.match(elements.pricingSchedule.textContent, /DeepSeek 空闲时段/);
    assert.equal(periodText(null), "未匹配时段");
    elements.pricePeriod.value = "deepseek_off_peak";
    elements.pricePeriod.onchange();
    const remove = elements.pricingRules.children[1].children[1].children[1];
    assert.equal(remove.textContent, "删除");
    assert.match(remove["aria-label"], /deepseek-flash DeepSeek 空闲时段/);
    failDelete = true;
    await remove.onclick();
    assert.equal(elements.pricingRules.children.length, 2);
    assert.equal(remove.disabled, false);
    assert.deepEqual(notifications.at(-1), ["正在生成，请稍后删除", true]);
    failDelete = false;
    await remove.onclick();
    assert.deepEqual(deleted, [{ provider: "deepseek", model: "deepseek-flash",
      period: "deepseek_off_peak", baseURL: "https://api.deepseek.com" }]);
    assert.equal(elements.pricingRules.children.length, 1);
    assert.equal(elements.priceHit.value, "");
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

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
