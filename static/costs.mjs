const $ = (id) => document.getElementById(id);
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
};

export function money(amount) {
  const value = Number(amount);
  if (value > 0 && value < 0.00000001) return "< ¥0.00000001";
  return "¥" + value.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  });
}

export function costText(cost) {
  if (!cost || cost.status === "unknown") return "未知";
  if (cost.status === "pending") return "待完成";
  if (cost.status === "free") return "¥0.00 · 未计费";
  return money(cost.amount) + " · 估算";
}

export function periodText(period) {
  return {
    deepseek_peak: "DeepSeek 高峰期",
    deepseek_off_peak: "DeepSeek 空闲时段",
    all_day: "全时段",
  }[period] || "未匹配时段";
}

export function createCostsController({ api, notify }) {
  let rules = [], loadID = 0;
  const inputs = [
    ["priceHit", "inputCacheHitPerMillion"],
    ["priceMiss", "inputCacheMissPerMillion"],
    ["priceOutput", "outputPerMillion"],
  ];
  function editRule(rule) {
    $("priceModel").value = rule.model;
    $("pricePeriod").value = rule.period || "all_day";
    $("priceLabel").value = rule.label;
    for (const [id, key] of inputs) $(id).value = rule[key];
  }
  function renderPricing() {
    $("pricingRules").replaceChildren();
    if (!rules.length) {
      $("pricingRules").append(node("p", "尚未配置单价。真实调用的费用将标为未知；Mock 为零。", "hint"));
      return;
    }
    for (const rule of rules) {
      const row = node("div", null, "pricing-rule");
      const info = node("div");
      info.append(node("strong", `${rule.model} · ${periodText(rule.period)}`), node("p",
        `${rule.label} · 缓存命中 ${rule.inputCacheHitPerMillion} / 未命中 ${rule.inputCacheMissPerMillion} / 输出 ${rule.outputPerMillion} 元 / 百万 tokens`, "hint"),
        node("p", `${rule.baseURL} · ${rule.source === "builtin"
          ? `内置 · 核对于 ${rule.verifiedAt}`
          : `自定义 · 保存于 ${new Date(rule.savedAt).toLocaleString("zh-CN")}`}`, "hint"));
      const edit = node("button", "编辑", "secondary");
      edit.type = "button";
      edit.onclick = () => { editRule(rule); $("priceModel").focus(); };
      const remove = node("button", "删除", "secondary pricing-delete");
      remove.type = "button";
      remove.setAttribute("aria-label", `删除 ${rule.model} ${periodText(rule.period)} 单价`);
      remove.onclick = async () => {
        remove.disabled = true;
        edit.disabled = true;
        try {
          await api("/lab/pricing", "DELETE", {
            provider: rule.provider, model: rule.model, period: rule.period || "all_day",
            baseURL: rule.baseURL,
          });
          await load();
          if ($("priceModel").value.trim() === rule.model
              && $("pricePeriod").value === (rule.period || "all_day")) selectRule();
          notify("单价已删除，历史费用快照保留。可在下方重新配置。");
        } catch (error) {
          notify(error.message, true);
        } finally {
          remove.disabled = false;
          edit.disabled = false;
        }
      };
      const actions = node("div", null, "pricing-actions");
      actions.append(edit, remove);
      row.append(info, actions);
      $("pricingRules").append(row);
    }
  }
  function renderSummary(summary) {
    const { totals, groups } = summary;
    $("costMetrics").replaceChildren();
    for (const [label, value] of [
      ["已知估算费用 · CNY", money(totals.knownAmount)],
      ["全部记录", totals.runCount.toLocaleString()],
      ["费用未知", `${totals.unknownCount} 次`],
      ["已估算 / 未计费 / 进行中", `${totals.estimatedCount} / ${totals.freeCount} / ${totals.pendingCount}`],
    ]) {
      const item = node("div");
      item.append(node("small", label), node("b", value));
      $("costMetrics").append(item);
    }
    $("costCoverage").textContent = totals.unknownCount || totals.pendingCount
      ? `已知金额不含 ${totals.unknownCount} 次未知费用及 ${totals.pendingCount} 次进行中的调用。`
      : "所有记录均有费用结果。";
    $("costRows").replaceChildren();
    $("costEmpty").hidden = groups.length > 0;
    for (const group of groups) {
      const row = node("tr");
      const prompt = node("td");
      prompt.append(node("strong", group.promptVersion + (group.promptEdited ? "（草稿）" : "")));
      const hash = node("div", group.promptHash ? group.promptHash.slice(0, 12) : "旧记录 · 无指纹", "hint");
      hash.title = group.promptHash || "";
      prompt.append(hash);
      row.append(node("td", group.provider), prompt, node("td", group.model),
        node("td", periodText(group.pricingPeriod)),
        node("td", group.runCount.toLocaleString()),
        node("td", `${group.promptTokens.toLocaleString()} / ${group.completionTokens.toLocaleString()}`),
        node("td", money(group.knownAmount)),
        node("td", `${group.estimatedCount} / ${group.freeCount} / ${group.unknownCount} / ${group.pendingCount}`));
      $("costRows").append(row);
    }
  }
  async function load() {
    const request = ++loadID;
    $("costLoadState").textContent = "读取中…";
    try {
      const [summary, prices, schedule] = await Promise.all([
        api("/lab/costs"), api("/lab/pricing"), api("/lab/pricing-periods"),
      ]);
      if (request !== loadID) return;
      rules = prices;
      renderSummary(summary);
      renderPricing();
      $("pricingSchedule").textContent = `服务器时间：${new Date(schedule.serverTime).toLocaleString("zh-CN", {
        timeZone: schedule.timeZone,
      })}（北京时间） · 当前${periodText(schedule.currentPeriod)}；实际计价以调用开始时间为准。`;
      if (!$("priceLabel").value) selectRule();
      $("costLoadState").textContent = `全部历史 · 更新于 ${new Date().toLocaleTimeString("zh-CN")}`;
    } catch (error) {
      if (request === loadID) $("costLoadState").textContent = "读取失败，请刷新重试";
      throw error;
    }
  }
  $("reloadCosts").onclick = () => load().catch((error) => notify(error.message, true));
  function selectRule() {
    const rule = rules.find((item) => item.model === $("priceModel").value.trim()
      && (item.period || "all_day") === $("pricePeriod").value);
    if (rule) editRule(rule);
    else {
      $("priceLabel").value = periodText($("pricePeriod").value);
      for (const [id] of inputs) $(id).value = "";
    }
  }
  $("priceModel").onchange = selectRule;
  $("pricePeriod").onchange = selectRule;
  $("pricingForm").onsubmit = async (event) => {
    event.preventDefault();
    $("savePricing").disabled = true;
    try {
      await api("/lab/pricing", "PUT", {
        provider: "deepseek", model: $("priceModel").value.trim(), period: $("pricePeriod").value,
        label: $("priceLabel").value.trim(),
        ...Object.fromEntries(inputs.map(([id, key]) => [key, $(id).value])),
      });
      await load();
      notify("单价已保存，后续调用将使用此价格快照。");
    } catch (error) {
      notify(error.message, true);
    } finally {
      $("savePricing").disabled = false;
    }
  };
  return { load };
}
