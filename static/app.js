import { taskFacts } from "./task-presentation.mjs";
import { createJsonViewer, embeddedJSON } from "./json-viewer.mjs";
import { createHistoryController } from "./history.mjs";
import { createCostsController, costText } from "./costs.mjs";
const $ = (id) => document.getElementById(id);
const json = (value) => JSON.stringify(value, null, 2);
const clone = (value) => JSON.parse(JSON.stringify(value));
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
};
// randomUUID requires a secure context; getRandomValues also works on LAN HTTP.
function createID() {
  if (typeof globalThis.crypto?.randomUUID === "function")
    return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const dateString = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
let profile,
  versions = [],
  samples = [],
  currentRun = null,
  session = null,
  simulatedTasks = [],
  simulatedTaskGoal = null,
  initialized = false;
let statusTimer;
const pages = {
  deployment: "项目部署",
  prompts: "Prompt 与模型参数",
  simulate: "目标与任务模拟",
  history: "历史与对比",
  costs: "AI 开支",
};
function renderPage(name) {
  const selected = name in pages ? name : "simulate";
  document
    .querySelectorAll("[data-page]")
    .forEach((page) => (page.hidden = page.dataset.page !== selected));
  document.querySelectorAll(".site-nav [data-page-link]").forEach((link) => {
    if (link.dataset.pageLink === selected)
      link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  document.title = `${pages[selected]} · Relax AI Lab`;
  syncConfigurationSummary();
  if (selected === "history" && initialized) historyUI.load().catch(report);
  if (selected === "costs" && initialized) costsUI.load().catch(report);
}
function navigate(name) {
  if (!(name in pages)) return;
  if (location.pathname !== `/${name}`) history.pushState({}, "", `/${name}`);
  renderPage(name);
  status("");
  window.scrollTo(0, 0);
}
function syncConfigurationSummary() {
  if (!initialized) return;
  const selected = session?.options || options();
  const original = versions.find(
    (version) => version.name === selected.promptVersion,
  )?.content;
  const edited = session
    ? session.promptText !== null
    : $("prompt").value !== original;
  $("simulationConfig").textContent =
    `${selected.promptVersion}${edited ? "（草稿）" : ""} · ${selected.model} · ${selected.provider}`;
  $("previewGoal").textContent =
    `预览目标：${$("title").value || "未命名目标"}`;
  $("promptLockNotice").hidden = !session;
}
function status(text, error = false) {
  clearTimeout(statusTimer);
  $("status").textContent = text;
  $("status").dataset.error = String(error);
  if (text && !error)
    statusTimer = setTimeout(() => ($("status").textContent = ""), 5000);
}
function report(error) {
  status(error.message, true);
}
async function api(path, method = "GET", body) {
  const response = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? json(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error?.message || json(data.detail || data));
    error.data = data;
    throw error;
  }
  return data;
}
function options() {
  return {
    provider: $("provider").value,
    model: $("model").value,
    temperature: Number($("temperature").value),
    maxTokens: Number($("maxTokens").value),
    promptVersion: $("promptVersion").value,
  };
}
function snapshot() {
  for (const id of ["title", "model", "temperature", "maxTokens"])
    if (!$(id).reportValidity()) throw new Error("请修正输入字段。");
  if (!$("title").value.trim()) throw new Error("goal.title 不能为空。");
  if (
    $("start").value &&
    $("deadline").value &&
    $("start").value > $("deadline").value
  )
    throw new Error("goal.deadline 不能早于 goal.startDate。");
  const original = versions.find(
    (version) => version.name === $("promptVersion").value,
  )?.content;
  return {
    context: {
      locale: $("locale").value,
      goal: {
        id: $("goalID").value,
        title: $("title").value,
        note: $("note").value || null,
        startDate: $("start").value || null,
        deadline: $("deadline").value || null,
        remainingDays: null,
      },
    },
    options: clone(options()),
    promptText: $("prompt").value === original ? null : $("prompt").value,
  };
}
function generationRequest(state) {
  const today = dateString(),
    goal = clone(state.context.goal);
  goal.remainingDays = goal.deadline
    ? Math.round(
        (Date.parse(goal.deadline + "T00:00:00Z") -
          Date.parse(today + "T00:00:00Z")) /
          86400000,
      )
    : null;
  return {
    generationMode: state.mode,
    locale: state.context.locale,
    today,
    goal,
    existingTaskTitles: simulatedTasks.map((task) => task.title),
    excludedSuggestionTitles: [...state.excluded],
  };
}
function lockInputs() {
  const locked = Boolean(session);
  ["goalFields", "promptFields", "profileFields"].forEach(
    (id) => ($(id).disabled = locked || !initialized),
  );
  $("examples").disabled = locked || !initialized;
  $("promptVersion").disabled = locked || !initialized;
  $("resetTasks").disabled = locked || simulatedTasks.length === 0;
}
const phaseLabels = {
  closed: "未打开会话",
  checking: "检查权益",
  generating: "生成中",
  ready: "待选择任务",
  failed: "生成失败",
  insufficient: "积分不足",
};
function empty(container, title, text) {
  const box = node("div", null, "empty");
  box.append(node("h3", title), node("p", text));
  container.append(box);
}
function renderSession() {
  lockInputs();
  const phase = session?.phase || "closed",
    isBusy = ["checking", "generating"].includes(phase);
  $("sessionPhase").textContent = phaseLabels[phase];
  if (!session && simulatedTasks.length)
    $("sessionPhase").textContent = "已添加任务";
  $("sessionPhase").dataset.phase = phase;
  $("navSessionState").hidden = !session;
  $("navSessionState").textContent = `AI 会话 · ${phaseLabels[phase]}`;
  const step = simulatedTasks.length
    ? 3
    : phase === "ready"
      ? 2
      : session
        ? 1
        : 0;
  document.querySelectorAll("[data-step]").forEach((item) => {
    item.classList.toggle("is-current", Number(item.dataset.step) === step);
    item.classList.toggle("is-complete", Number(item.dataset.step) < step);
  });
  syncConfigurationSummary();
  $("goalSummary").textContent =
    session?.context.goal.title || $("title").value;
  $("goalTaskCount").textContent = `${simulatedTasks.length} 条任务`;
  $("openSession").hidden = Boolean(session) || simulatedTasks.length > 0;
  $("openSession").disabled = !initialized;
  $("closeSession").hidden = !session;
  $("refreshSession").hidden = phase !== "ready";
  $("retrySession").hidden = !["failed", "insufficient"].includes(phase);
  $("refreshSession").disabled = isBusy;
  $("retrySession").disabled = isBusy;
  $("mode").value = session?.mode || "initial";
  $("today").value = session?.lastRequest?.today || dateString();
  $("existing").value = simulatedTasks.map((task) => task.title).join("\n");
  $("excluded").value = session?.excluded.join("\n") || "";
  $("sessionInfo").textContent = session
    ? `${session.mode} · 本次会话已展示 ${session.excluded.length} 个标题`
    : "";
  const container = $("sessionCards");
  container.replaceChildren();
  $("selectionBar").hidden = phase !== "ready";
  if (!session) {
    if (simulatedTasks.length) {
      renderPlans(
        container,
        {
          effectiveRequest: { goal: simulatedTaskGoal },
          result: {
            plans: [{ planType: "created", suggestions: simulatedTasks }],
          },
        },
        false,
      );
    } else empty(container, "等待生成任务建议", "");
  } else if (isBusy) {
    const loading = node("div", null, "loading");
    loading.append(
      node("span", null, "spinner"),
      node(
        "span",
        phase === "checking"
          ? "GET /v1/ai/entitlement"
          : "POST /lab/runs · 等待生成响应",
      ),
    );
    container.append(loading);
  } else if (session.error)
    container.append(
      node(
        "div",
        `${session.error.code} · ${session.error.message}`,
        "error-box",
      ),
    );
  else if (session.run) renderPlans(container, session.run, true);
  syncSelection();
}
function syncSelection() {
  const state = session,
    count = state?.selected.size || 0;
  $("selectedCount").textContent = `已选择 ${count} 条`;
  $("addSelected").textContent = `模拟添加 ${count} 条任务`;
  $("addSelected").disabled = !state || state.phase !== "ready" || count === 0;
  document
    .querySelectorAll("#sessionCards [data-task-index]")
    .forEach((card) => {
      const checked = Boolean(
        state?.selected.has(Number(card.dataset.taskIndex)),
      );
      card.classList.toggle("selected", checked);
      const checkbox = card.querySelector("input");
      if (checkbox) checkbox.checked = checked;
    });
}
function renderPlans(
  container,
  run,
  selectable = false,
  { compact = false } = {},
) {
  if (run.error) {
    container.append(
      node("div", `${run.error.code} · ${run.error.message}`, "error-box"),
    );
    return;
  }
  if (run.options?.provider === "mock")
    container.append(node("p", "Mock 样例", "hint"));
  const goal = run.effectiveRequest?.goal || run.input?.goal || {};
  let index = 0;
  for (const plan of run.result?.plans || []) {
    const names = {
      quick_start: "起步任务",
      advanced: "持续推进任务",
      created: "模拟目标下的任务",
    };
    const heading = node(
      "h3",
      names[plan.planType] || plan.planType,
      "group-label",
    );
    heading.append(node("span", `${plan.suggestions.length} 条`));
    const group = node(
      "section",
      null,
      `plan-group plan-group-${plan.planType}`,
    );
    group.append(heading);
    container.append(group);
    for (const task of plan.suggestions) {
      const taskIndex = index++,
        card = node(
          selectable ? "label" : "article",
          null,
          "task-card" + (selectable ? " selectable" : ""),
        );
      const top = node("div", null, "task-heading"),
        content = node("div");
      if (selectable) {
        card.dataset.taskIndex = taskIndex;
        const checkbox = node("input");
        checkbox.type = "checkbox";
        checkbox.setAttribute("aria-label", task.title);
        checkbox.checked = session.selected.has(taskIndex);
        const owner = session;
        checkbox.onchange = () => {
          if (session !== owner || owner.phase !== "ready") return;
          checkbox.checked
            ? owner.selected.add(taskIndex)
            : owner.selected.delete(taskIndex);
          syncSelection();
        };
        top.append(checkbox);
      }
      const titleRow = node("div", null, "task-title-row");
      titleRow.append(node("h4", task.title));
      if (task.taskSpec?.kind === "progress")
        titleRow.append(node("span", "量化任务", "task-kind"));
      content.append(titleRow);
      if (task.note) content.append(node("p", task.note));
      const facts = node("dl", null, "task-facts");
      let settings, settingFacts;
      for (const fact of taskFacts(task, goal)) {
        const secondary =
          compact &&
          ["进度计算方式", "进度重置周期", "每日完成条件"].includes(fact.label);
        if (secondary && !settings) {
          settings = node("details", null, "task-settings");
          settingFacts = node("dl", null, "task-facts");
          settings.append(node("summary", "量化设置"), settingFacts);
        }
        const row = node("div", null, "task-fact");
        row.append(node("dt", fact.label), node("dd", fact.value));
        (secondary ? settingFacts : facts).append(row);
      }
      content.append(facts);
      if (settings) content.append(settings);
      top.append(content);
      card.append(top);
      group.append(card);
    }
  }
}
function current(state, requestID) {
  return session === state && state.requestID === requestID;
}
async function generate(state, replacing = false) {
  if (
    !state ||
    session !== state ||
    ["checking", "generating"].includes(state.phase)
  )
    return;
  if (replacing) state.mode = "refresh";
  const requestID = ++state.requestID;
  state.phase = "checking";
  state.run = null;
  state.selected.clear();
  state.error = null;
  clearCurrentReport();
  renderSession();
  try {
    const entitlement = await api("/v1/ai/entitlement");
    if (!current(state, requestID)) return;
    if (!entitlement.canGenerate) {
      const error = new Error("模拟积分不足；关闭会话后可修改共享权益。");
      error.data = {
        error: { code: "insufficient_credits", message: error.message },
      };
      throw error;
    }
    state.phase = "generating";
    state.lastRequest = generationRequest(state);
    renderSession();
    const run = await api("/lab/runs", "POST", {
      request: state.lastRequest,
      options: state.options,
      promptText: state.promptText,
    });
    if (!current(state, requestID)) return;
    if (run.result.goalID !== state.context.goal.id)
      throw new Error("响应 goalID 与当前目标不一致。");
    state.run = run;
    state.phase = "ready";
    const tasks = run.result.plans.flatMap((plan) => plan.suggestions);
    state.selected = new Set(tasks.map((_, index) => index));
    for (const task of tasks)
      if (!state.excluded.includes(task.title)) state.excluded.push(task.title);
    showRun(run);
    if (location.pathname === "/history") historyUI.load().catch(report);
    renderSession();
    status(`已生成 ${tasks.length} 条建议，过滤 ${run.issues.length} 条。`);
    if (run.entitlementAfter) {
      profile.usedCredits = run.entitlementAfter.usedCredits;
      profile.isPro = run.entitlementAfter.isPro;
      $("usedCredits").value = profile.usedCredits;
      $("membership").value = profile.isPro ? "pro" : "free";
      activeInfo();
    }
  } catch (error) {
    if (!current(state, requestID)) return;
    const detail = error.data?.error || {
      code: "request_failed",
      message: error.message,
    };
    if (detail.runID) {
      try {
        const run = await api("/lab/runs/" + detail.runID);
        if (!current(state, requestID)) return;
        showRun(run);
      } catch {}
    }
    if (!current(state, requestID)) return;
    state.error = detail;
    state.phase =
      detail.code === "insufficient_credits" ? "insufficient" : "failed";
    renderSession();
    report(error);
  }
}
function closeSession(message) {
  const inFlight =
    session && ["checking", "generating"].includes(session.phase);
  session = null;
  renderSession();
  status(
    message ||
      (inFlight ? "会话已关闭，生成请求仍可能在服务端完成。" : "会话已关闭。"),
  );
}
function renderMetrics(container, run) {
  container.replaceChildren();
  const count = (run.result?.plans || []).reduce(
    (sum, plan) => sum + plan.suggestions.length,
    0,
  );
  const duration =
    run.durationMs == null
      ? "—"
      : run.durationMs >= 1000
        ? `${(run.durationMs / 1000).toFixed(2)} s`
        : `${run.durationMs} ms`;
  for (const [label, value] of [
    ["模型", run.options.provider === "mock" ? "Mock" : run.options.model],
    ["耗时", duration],
    ["Tokens", run.usage?.total_tokens?.toLocaleString() ?? "—"],
    ["有效建议", `${count} 条`],
    ["费用", costText(run.cost)],
  ]) {
    const box = node("div");
    box.append(node("small", label), node("b", value));
    container.append(box);
  }
}
function renderIssues(container, run) {
  container.replaceChildren();
  if (run.error) container.append(node("p", run.error.message, "error-box"));
  if (!run.issues.length)
    container.append(
      node(
        "p",
        run.error ? "未取得可校验的建议" : "全部建议通过参数校验",
        run.error ? "hint" : "validation-success",
      ),
    );
  else {
    container.append(
      node("p", `已过滤 ${run.issues.length} 项`, "validation-filtered"),
    );
    for (const issue of run.issues) {
      const details = node("details", null, "issue"),
        summary = node("summary", issue.path);
      const parsed = embeddedJSON(issue.message);
      details.append(summary);
      if (Array.isArray(parsed)) {
        const list = node("ul");
        for (const error of parsed)
          list.append(
            node(
              "li",
              `${(error.loc || []).join(".") || issue.code}: ${error.msg}`,
            ),
          );
        details.append(list);
      } else details.append(node("p", issue.message));
      container.append(details);
    }
  }
}
function traceData(run) {
  return [
    ["请求上下文", run.input],
    [
      "发送给模型的请求",
      run.providerRequest || { messages: run.messages, options: run.options },
    ],
    ["模型生成内容", run.rawResponse?.choices?.[0]?.message?.content ?? null],
    ["返回 App 的响应", run.result],
    ["完整上游响应", run.rawResponse],
    ["费用与单价快照", { cost: run.cost, pricing: run.pricing, costRevisions: run.costRevisions }],
  ];
}
function renderTrace(container, run) {
  container.replaceChildren();
  for (const [title, value] of traceData(run)) {
    const details = node("details", null, "json-section");
    details.append(node("summary", title), createJsonViewer(value));
    container.append(details);
  }
}
function clearCurrentReport() {
  currentRun = null;
  $("currentReport").hidden = true;
  $("export").disabled = true;
}
function showRun(run) {
  currentRun = run;
  $("currentReport").hidden = false;
  $("diagnosticMeta").textContent =
    `${run.status === "success" ? "成功" : "失败"} · ${run.id.slice(0, 8)}`;
  $("runInfo").textContent = new Date(run.createdAt).toLocaleString("zh-CN", {
    hour12: false,
  });
  renderMetrics($("metrics"), run);
  renderIssues($("issues"), run);
  const ids = [
    "requestContextJson",
    "requestJson",
    "rawContentJson",
    "resultJson",
    "rawJson",
    "costJson",
  ];
  traceData(run).forEach(([, value], index) =>
    $(ids[index]).replaceChildren(createJsonViewer(value)),
  );
  $("rating").value = run.feedback?.rating || "needs_work";
  $("reviewNote").value = run.feedback?.note || "";
  $("export").disabled = false;
  $("saveFeedback").disabled = false;
}
function populateVersions(name) {
  $("promptVersion").replaceChildren();
  for (const version of versions) {
    const option = node("option", version.name);
    option.value = version.name;
    $("promptVersion").append(option);
  }
  $("promptVersion").value = name;
  $("prompt").value =
    versions.find((version) => version.name === name)?.content || "";
  syncConfigurationSummary();
}
function activeInfo() {
  $("activeInfo").textContent =
    `已保存：${profile.options.promptVersion} · ${profile.options.model} · ${profile.options.provider}`;
  $("creditInfo").textContent =
    `积分额度：免费 ${profile.freeCredits} / Pro ${profile.proCredits}，每批 ${profile.creditsPerGeneration}。`;
  syncConfigurationSummary();
}
function loadProfileInputs() {
  populateVersions(profile.options.promptVersion);
  for (const id of ["provider", "model", "temperature", "maxTokens"])
    $(id).value = profile.options[id];
  $("membership").value = profile.isPro ? "pro" : "free";
  $("usedCredits").value = profile.usedCredits;
  activeInfo();
}
function resetGoal() {
  session = null;
  clearCurrentReport();
  simulatedTasks = [];
  simulatedTaskGoal = null;
  $("goalID").value = createID();
  renderSession();
}
async function loadConnection() {
  const info = await api("/lab/connection");
  $("listenStatus").textContent = info.lanEnabled
    ? "已启用局域网监听"
    : "仅本机监听";
  $("listenInfo").textContent =
    `当前监听：${info.listenHost}:${info.listenPort}`;
  $("lanAddress").dataset.port = info.listenPort;
  const addresses = [...info.addresses];
  const currentURL = new URL(info.requestBaseURL);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(currentURL.hostname) &&
    !addresses.some((item) => item.baseURL === info.requestBaseURL)
  )
    addresses.unshift({
      interface: "当前访问地址",
      baseURL: info.requestBaseURL,
    });
  $("lanAddress").replaceChildren();
  for (const item of addresses) {
    const option = node("option", `${item.interface} · ${item.baseURL}`);
    option.value = item.baseURL;
    $("lanAddress").append(option);
  }
  if (addresses.some((item) => item.baseURL === info.requestBaseURL))
    $("lanAddress").value = info.requestBaseURL;
  else {
    const preferred = addresses.find((item) =>
      /^(en|eth|wl)/.test(item.interface),
    );
    if (preferred) $("lanAddress").value = preferred.baseURL;
  }
  $("lanAddress").onchange = updateConnectionURL;
  updateConnectionURL();
}
function updateConnectionURL() {
  const url = $("lanAddress").value;
  $("iosConfig").value =
    `RELAX_AI_BASE_URL=${url || `http://<部署电脑的局域网IPv4>:${$("lanAddress").dataset.port || 8765}`}`;
  $("healthURL").textContent = url
    ? url + "/health"
    : "未检测到私有 IPv4，请检查电脑的 Wi-Fi / 以太网连接。";
  if (url) $("healthURL").href = url + "/health";
  else $("healthURL").removeAttribute("href");
}
$("copyIOSConfig").onclick = async () => {
  try {
    if (navigator.clipboard?.writeText)
      await navigator.clipboard.writeText($("iosConfig").value);
    else {
      $("iosConfig").focus();
      $("iosConfig").select();
      if (!document.execCommand("copy"))
        throw new Error("请复制已选中的配置。");
    }
    $("copyIOSConfig").textContent = "已复制配置";
  } catch (error) {
    $("iosConfig").focus();
    $("iosConfig").select();
    $("copyIOSConfig").textContent = "配置已选中，请复制";
  }
};
document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-page-link]");
  if (
    !link ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  navigate(link.dataset.pageLink);
});
window.addEventListener("popstate", () =>
  renderPage(location.pathname.split("/")[1]),
);
$("theme").onchange = () => {
  document.documentElement.dataset.theme = $("theme").value;
  try {
    localStorage.setItem("relax-lab-theme", $("theme").value);
  } catch {}
};
try {
  const theme = localStorage.getItem("relax-lab-theme");
  if (["light", "dark", "system"].includes(theme)) {
    $("theme").value = theme;
    document.documentElement.dataset.theme = theme;
  }
} catch {}

$("openSession").onclick = () => {
  try {
    if (session || simulatedTasks.length) return;
    session = {
      ...snapshot(),
      phase: "idle",
      mode: "initial",
      excluded: [],
      selected: new Set(),
      requestID: 0,
      run: null,
      error: null,
      lastRequest: null,
    };
    generate(session);
    if (matchMedia("(max-width: 800px)").matches)
      document
        .querySelector(".workspace")
        .scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    report(error);
  }
};
$("refreshSession").onclick = () => generate(session, true);
$("retrySession").onclick = () => generate(session);
$("closeSession").onclick = () => closeSession();
$("selectAll").onclick = () => {
  if (session?.phase !== "ready") return;
  const count = session.run.result.plans.flatMap(
    (plan) => plan.suggestions,
  ).length;
  session.selected =
    session.selected.size === count
      ? new Set()
      : new Set(Array.from({ length: count }, (_, index) => index));
  syncSelection();
};
$("addSelected").onclick = () => {
  if (session?.phase !== "ready" || !session.selected.size) return;
  const tasks = session.run.result.plans.flatMap((plan) => plan.suggestions);
  const added = tasks.filter((_, index) => session.selected.has(index));
  simulatedTasks.push(...clone(added));
  simulatedTaskGoal = clone(session.context.goal);
  closeSession(`已添加 ${added.length} 条模拟任务。`);
};
$("newGoal").onclick = () => {
  if (session) return;
  resetGoal();
  $("title").value = "";
  $("note").value = "";
  $("start").value = "";
  $("deadline").value = "";
  $("title").focus();
  renderSession();
};
$("resetTasks").onclick = () => {
  simulatedTasks = [];
  simulatedTaskGoal = null;
  renderSession();
  status("已清空目标任务。");
};
$("title").oninput = () => {
  if (!session) $("goalSummary").textContent = $("title").value;
  syncConfigurationSummary();
};
$("examples").onchange = () => {
  if (session || $("examples").value === "") return;
  const example = samples[Number($("examples").value)];
  resetGoal();
  $("title").value = example.title;
  $("note").value = example.note;
  $("locale").value = example.locale;
  const start = new Date();
  if (example.days < 0) start.setDate(start.getDate() - 30);
  const deadline = new Date();
  deadline.setDate(deadline.getDate() + (example.days || 0));
  $("start").value = example.days == null ? "" : dateString(start);
  $("deadline").value = example.days == null ? "" : dateString(deadline);
  renderSession();
};
$("promptVersion").onchange = () => {
  $("prompt").value = versions.find(
    (version) => version.name === $("promptVersion").value,
  ).content;
  syncConfigurationSummary();
};
["prompt", "provider", "model", "temperature", "maxTokens"].forEach((id) => {
  $(id).addEventListener("input", syncConfigurationSummary);
});
$("preview").onclick = async () => {
  try {
    const context = snapshot(),
      state = { ...context, mode: "initial", excluded: [] };
    const result = await api("/lab/preview", "POST", {
      request: generationRequest(state),
      options: context.options,
      promptText: context.promptText,
    });
    $("promptRequestJson").replaceChildren(
      createJsonViewer(result.providerRequest),
    );
    $("promptPreview").open = true;
    status("请求预览已更新。");
  } catch (error) {
    report(error);
  }
};
$("savePrompt").onclick = async () => {
  try {
    const version = await api("/lab/prompts", "POST", {
      name: $("versionName").value,
      content: $("prompt").value,
    });
    versions = await api("/lab/prompts");
    populateVersions(version.name);
    status(`已保存版本 ${version.name}。`);
  } catch (error) {
    report(error);
  }
};
$("applyProfile").onclick = async () => {
  try {
    const original = versions.find(
      (version) => version.name === $("promptVersion").value,
    )?.content;
    if (original !== $("prompt").value)
      throw new Error("请先保存修改后的 prompt 版本，再应用共享配置。");
    profile = await api("/lab/profile", "PUT", {
      ...profile,
      options: options(),
      isPro: $("membership").value === "pro",
      usedCredits: Number($("usedCredits").value),
    });
    activeInfo();
    status("共享配置已保存。");
  } catch (error) {
    report(error);
  }
};
$("reloadProfile").onclick = async () => {
  try {
    profile = await api("/lab/profile");
    versions = await api("/lab/prompts");
    loadProfileInputs();
    status("已读取共享配置。");
  } catch (error) {
    report(error);
  }
};
$("saveFeedback").onclick = async () => {
  const record = currentRun;
  if (!record) return;
  $("saveFeedback").disabled = true;
  try {
    record.feedback = await api(
      "/lab/runs/" + record.id + "/feedback",
      "PATCH",
      { rating: $("rating").value, note: $("reviewNote").value },
    );
    historyUI.noteFeedback(record);
    status("评价已保存。");
  } catch (error) {
    report(error);
  } finally {
    $("saveFeedback").disabled = false;
  }
};
$("export").onclick = () => {
  if (!currentRun) return;
  const url = URL.createObjectURL(
    new Blob([json(currentRun)], { type: "application/json" }),
  );
  const link = node("a");
  link.href = url;
  link.download = `relax-ai-${currentRun.id}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const historyUI = createHistoryController({
  api,
  renderPlans,
  renderIssues,
  renderMetrics,
  renderTrace,
  notify: status,
  onFeedback(run) {
    if (currentRun?.id === run.id) {
      currentRun.feedback = run.feedback;
      $("rating").value = run.feedback.rating;
      $("reviewNote").value = run.feedback.note;
    }
  },
});
const costsUI = createCostsController({ api, notify: status });
$("viewCurrentInHistory").onclick = () => {
  if (!currentRun) return;
  historyUI.focusRecord(currentRun.id);
  navigate("history");
};
async function init() {
  const [health, currentProfile, prompts, examples] = await Promise.all(
    ["/health", "/lab/profile", "/lab/prompts", "/lab/examples"].map((path) =>
      api(path),
    ),
  );
  profile = currentProfile;
  versions = prompts;
  samples = examples;
  loadProfileInputs();
  $("connection").textContent = health.apiKeyConfigured
    ? "DEEPSEEK_API_KEY 已配置"
    : "DEEPSEEK_API_KEY 未配置";
  for (let index = 0; index < samples.length; index++) {
    const option = node("option", samples[index].label);
    option.value = index;
    $("examples").append(option);
  }
  $("goalID").value = createID();
  $("start").value = dateString();
  const deadline = new Date();
  deadline.setDate(deadline.getDate() + 90);
  $("deadline").value = dateString(deadline);
  initialized = true;
  renderSession();
  if (location.pathname === "/history") historyUI.load().catch(report);
  if (location.pathname === "/costs") costsUI.load().catch(report);
  loadConnection().catch((error) => {
    $("listenStatus").textContent = "读取连接配置失败";
    report(error);
  });
}
renderPage(location.pathname.split("/")[1]);
init().catch(report);
