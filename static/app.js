import { taskFacts } from "./task-presentation.mjs";
import { createJsonViewer, embeddedJSON } from "./json-viewer.mjs";
import { createHistoryController } from "./history.mjs";
import { createCostsController, costText } from "./costs.mjs";
import { createCasesController } from "./cases.mjs";
import { createBatchComparison } from "./batch-comparison.mjs";
import {
  createWorkspaceStorage,
  profilePatch,
  configurationDifferences,
} from "./workspace.mjs";
import { createResultController } from "./result-detail.mjs";
import { formatCaseVerdict } from "./case-batch.mjs";
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
  runningCase = false,
  currentRun = null,
  session = null,
  simulatedTasks = [],
  simulatedTaskGoal = null,
  initialized = false;
let statusTimer;
const workspace = createWorkspaceStorage();
const restoredWorkspace = Boolean(
  workspace.get("editor") || workspace.get("goal") || workspace.get("cases"),
);
const editorState = workspace.get("editor", {});
const promptDrafts = Object.assign(
  Object.create(null),
  editorState.drafts && typeof editorState.drafts === "object"
    ? editorState.drafts
    : {},
);
const navigation = workspace.get("navigation", {});
const scrollPositions = navigation.scrollPositions || {};
let loadedPromptVersion = "",
  currentPage = "simulate",
  returnPage = ["simulate", "cases"].includes(navigation.returnPage)
    ? navigation.returnPage
    : "simulate",
  goalReturn = false,
  pendingGenerations = 0,
  healthState = { busy: false, apiKeyConfigured: false },
  healthRequest = null,
  savingConfiguration = false,
  rightsDirty = false;
const optionFields = ["provider", "model", "temperature", "maxTokens"];
const goalFields = ["goalID", "title", "note", "start", "deadline", "locale"];
function rememberNavigation() {
  workspace.set("navigation", { returnPage, scrollPositions });
}
function rememberEditor() {
  if (!initialized) return;
  const original = versions.find(
    (version) => version.name === loadedPromptVersion,
  )?.content;
  if ($("prompt").value !== original)
    promptDrafts[loadedPromptVersion] = $("prompt").value;
  workspace.set("editor", {
    options: options(),
    text: $("prompt").value,
    drafts: promptDrafts,
    versionName: $("versionName").value,
  });
}
function rememberGoal() {
  if (initialized)
    workspace.set(
      "goal",
      Object.fromEntries(goalFields.map((id) => [id, $(id).value])),
    );
}
function generationBlocked() {
  return pendingGenerations > 0 || healthState.busy;
}
function renderActivity() {
  if (!initialized) return;
  const label = pendingGenerations
    ? session || runningCase
      ? "本浏览器正在等待生成响应"
      : "会话已关闭，已发送的请求仍在处理中"
    : runningCase
      ? "本浏览器正在执行用例批次"
      : session
        ? `当前会话 · ${phaseLabels[session.phase] || "准备中"}`
        : healthState.busy
          ? "服务正在处理请求（可能来自其他客户端）"
          : "服务空闲";
  $("activityText").textContent = label;
  $("navSessionState").textContent = generationBlocked()
    ? "服务忙碌"
    : session
      ? "会话已打开"
      : runningCase
        ? "评测中"
        : "服务空闲";
  $("navSessionState").hidden = false;
  const target = runningCase ? "cases" : session ? "simulate" : "history";
  $("activityLink").hidden = !session && !runningCase && !pendingGenerations;
  $("activityLink").href = "/" + target;
  $("activityLink").dataset.pageLink = target;
  $("activityLink").textContent =
    session || runningCase ? "返回活动 →" : "查看调用记录 →";
  $("connection").textContent = healthState.apiKeyConfigured
    ? "key 已配置 · 环境"
    : "未配置 key · Mock 可用";
  $("openSession").disabled =
    !initialized || runningCase || generationBlocked();
  $("refreshSession").disabled = generationBlocked();
  $("retrySession").disabled = generationBlocked();
  casesUI.sync({
    initialized,
    sessionOpen: Boolean(session),
    blocked: generationBlocked(),
  });
  syncConfigurationSummary();
}
async function refreshHealth() {
  if (healthRequest) return healthRequest;
  healthRequest = api("/health")
    .then((value) => {
      healthState = value;
      renderActivity();
    })
    .catch(() => {
      if (initialized)
        $("activityText").textContent =
          "无法确认服务状态，请手动刷新；不会自动重试生成。";
    })
    .finally(() => {
      healthRequest = null;
    });
  return healthRequest;
}
function validateConfiguration() {
  for (const id of ["model", "temperature", "maxTokens"])
    if (!$(id).reportValidity())
      throw new Error("请在 Prompt 版本页修正模型参数。");
}
function validateGoal(show = true) {
  $("title").setCustomValidity(
    $("title").value.trim() ? "" : "请输入目标标题。",
  );
  $("deadline").setCustomValidity(
    $("start").value &&
      $("deadline").value &&
      $("start").value > $("deadline").value
      ? "截止日期不能早于开始日期。"
      : "",
  );
  const invalid = ["title", "deadline"].filter((id) => !$(id).checkValidity());
  for (const id of ["title", "deadline"])
    $(id).classList.toggle("field-invalid", invalid.includes(id));
  $("goalError").hidden = !invalid.length;
  $("goalError").textContent = invalid
    .map((id) => $(id).validationMessage)
    .join(" ");
  if (show && invalid.length) $(invalid[0]).reportValidity();
  return !invalid.length;
}

const pages = {
  deployment: "连接与环境",
  prompts: "Prompt 版本",
  cases: "固定用例",
  simulate: "快速模拟",
  history: "记录与对比",
  costs: "开支",
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
  currentPage = selected;
  const context = $("trialConfiguration");
  context.hidden = !["simulate", "cases", "prompts"].includes(selected);
  if (!context.hidden)
    $("page-" + selected)
      .querySelector(".page-heading")
      .after(context);
  $("returnToExperiment").href = "/" + returnPage;
  $("returnToExperiment").dataset.pageLink = returnPage;
  $("returnToExperiment").textContent = "返回" + pages[returnPage] + " →";
  $("returnToPrompt").hidden = !goalReturn;
  document.title = `${pages[selected]} · Relax AI Lab`;
  syncConfigurationSummary();
  if (selected === "history" && initialized) historyUI.load().catch(report);
  if (selected === "costs" && initialized) costsUI.load().catch(report);
}
function navigate(name) {
  if (!(name in pages)) return;
  scrollPositions[currentPage] = window.scrollY;
  rememberNavigation();
  if (location.pathname !== `/${name}`) history.pushState({}, "", `/${name}`);
  renderPage(name);
  status("");
  requestAnimationFrame(() => window.scrollTo(0, scrollPositions[name] || 0));
}
function syncConfigurationSummary() {
  if (!initialized) return;
  const batchConfiguration = casesUI.configuration();
  const selected = session?.options || batchConfiguration?.options || options();
  const edited = session
    ? session.promptText !== null
    : batchConfiguration
      ? batchConfiguration.promptText !== null
      : selectedPromptText() !== null;
  const text = `${selected.promptVersion}${edited ? "（草稿）" : ""} · ${selected.model} · ${selected.provider}`;
  $("simulationConfig").textContent = text;
  $("evaluationConfig").textContent = text;
  $("trialVersion").textContent = selected.promptVersion;
  $("trialDraft").hidden = !edited;
  $("trialProvider").textContent =
    selected.provider === "mock" ? "Mock 固定样例" : "DeepSeek 真实调用";
  $("trialModel").textContent =
    `${selected.model} · 温度 ${selected.temperature} · 输出上限 ${selected.maxTokens}`;
  $("trialScope").textContent = session
    ? "当前会话已固定配置；关闭后可编辑"
    : runningCase
      ? "当前批次已固定配置；结束后可编辑"
      : "仅用于本浏览器的后续实验";
  $("providerNotice").textContent =
    selected.provider === "mock"
      ? "Mock 只验证联调流程，不代表 Prompt 通过质量评测。"
      : healthState.apiKeyConfigured
        ? "key 已配置；此状态不代表已验证模型连接。真实调用可能产生 token 费用。"
        : "未配置 DeepSeek key，真实调用将明确失败。可显式选择 Mock，或到连接与环境查看配置步骤。";
  const diffs = configurationDifferences(
    options(),
    profile.options,
    selectedPromptText() !== null,
  );
  $("sharedDifferenceLink").textContent = diffs.length
    ? "与服务共享配置有差异 →"
    : "与服务共享配置一致 →";
  $("configurationDifferences").replaceChildren();
  $("configurationDifferences").className = diffs.length
    ? "configuration-diff"
    : "";
  for (const diff of diffs)
    $("configurationDifferences").append(
      node("p", `${diff.label}：${diff.before} → ${diff.after}`),
    );
  const draft = selectedPromptText() !== null;
  $("draftState").textContent = draft
    ? "未保存的 Prompt 草稿"
    : "与已保存版本一致";
  $("discardDraft").hidden = !draft;
  $("restoreDraft").hidden =
    !promptDrafts[$("promptVersion").value] ||
    promptDrafts[$("promptVersion").value] === $("prompt").value;
  $("applyHint").textContent = draft
    ? "请先保存新版本，再应用到共享服务。"
    : diffs.length
      ? "将以上生成配置应用于后续请求；模拟权益保持不变。"
      : "当前试验配置与服务共享生成配置一致。";
  $("applyProfile").disabled =
    Boolean(session) ||
    runningCase ||
    savingConfiguration ||
    generationBlocked() ||
    draft ||
    !diffs.length;
  $("applyEntitlement").disabled =
    Boolean(session) ||
    runningCase ||
    savingConfiguration ||
    generationBlocked();
  $("replaceWithShared").disabled =
    Boolean(session) || runningCase || savingConfiguration;
  $("reloadProfile").disabled = savingConfiguration;
  $("previewGoal").textContent =
    `预览目标：${$("title").value || "未命名目标"} · ${$("start").value || "无开始日期"} → ${$("deadline").value || "无截止日期"} · ${$("locale").value} · initial`;
  const lockNotice = $("promptLockNotice");
  lockNotice.hidden = !session && !runningCase;
  lockNotice.replaceChildren();
  if (session || runningCase) {
    lockNotice.append(
      node("span", session ? "当前会话已固定配置。" : "评测批次已固定配置。"),
    );
    const link = node("a", session ? "返回会话" : "查看评测进度");
    link.href = session ? "/simulate" : "/cases";
    link.dataset.pageLink = session ? "simulate" : "cases";
    lockNotice.append(link, node("span", "，结束后可继续编辑。"));
  }
  casesUI.sync({
    initialized,
    sessionOpen: Boolean(session),
    blocked: generationBlocked(),
  });
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
  const generation =
    method === "POST" &&
    (path === "/lab/runs" ||
      /^\/lab\/cases\/[^/]+\/run$/.test(path) ||
      /^\/lab\/batches\/[^/]+\/items\/[^/]+\/run$/.test(path));
  if (generation) {
    pendingGenerations++;
    renderActivity();
  }
  try {
    const response = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? json(body) : undefined,
    });
    const data = await response.json();
    if (!response.ok) {
      if (data.error?.code === "busy") healthState.busy = true;
      const error = new Error(data.error?.message || json(data.detail || data));
      error.data = data;
      throw error;
    }
    return data;
  } finally {
    if (generation) {
      pendingGenerations--;
      renderActivity();
      refreshHealth();
    }
  }
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
function selectedPromptText() {
  const original = versions.find(
    (version) => version.name === $("promptVersion").value,
  )?.content;
  return $("prompt").value === original ? null : $("prompt").value;
}
function snapshot() {
  validateConfiguration();
  if (!validateGoal()) throw new Error("请修正目标输入。");
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
    promptText: selectedPromptText(),
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
  const locked = Boolean(session) || runningCase || savingConfiguration;
  ["goalFields", "promptFields", "profileFields"].forEach(
    (id) => ($(id).disabled = locked || !initialized),
  );
  $("examples").disabled = locked || !initialized;
  casesUI.sync({
    initialized,
    sessionOpen: Boolean(session),
    blocked: generationBlocked(),
  });
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
  $("navSessionState").hidden = !session && !runningCase;
  $("navSessionState").textContent = runningCase
    ? "用例评测 · 运行中"
    : `AI 会话 · ${phaseLabels[phase]}`;
  $("simulationEvaluationNotice").hidden = !runningCase;
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
  $("openSession").disabled = !initialized || runningCase;
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
          ? "正在检查模拟权益…"
          : "正在生成任务建议，等待响应…",
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
  renderActivity();
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
    ["checking", "generating"].includes(state.phase) ||
    generationBlocked()
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
    status(`已生成 ${tasks.length} 条建议，过滤 ${run.issues.length} 项。`);
    if (run.entitlementAfter) {
      profile.usedCredits = run.entitlementAfter.usedCredits;
      profile.isPro = run.entitlementAfter.isPro;
      if (!rightsDirty) {
        $("usedCredits").value = profile.usedCredits;
        $("membership").value = profile.isPro ? "pro" : "free";
      }
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
  if (run.caseEvaluation) {
    container.append(node("p", formatCaseVerdict(run.caseEvaluation)));
    container.append(
      node("p", `人工核对：${run.caseEvaluation.review}`, "hint"),
    );
  }
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
    [
      "运行配置、权益与 Prompt 指纹",
      {
        source: run.source,
        options: run.options,
        promptEdited: run.promptEdited,
        promptHash: run.promptHash,
        entitlementBefore: run.entitlementBefore,
        entitlementAfter: run.entitlementAfter,
      },
    ],
    ["请求上下文", run.input],
    [
      "发送给模型的请求",
      run.providerRequest || { messages: run.messages, options: run.options },
    ],
    ["模型生成内容", run.rawResponse?.choices?.[0]?.message?.content ?? null],
    ["返回 App 的响应", run.result],
    ["完整上游响应", run.rawResponse],
    [
      "费用与单价快照",
      {
        cost: run.cost,
        pricing: run.pricing,
        costRevisions: run.costRevisions,
      },
    ],
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
}
function showRun(run) {
  currentRun = run;
  $("currentReport").hidden = false;
  resultUI.render($("currentResult"), run, { tasks: false });
}
function populateVersions(name, text) {
  $("promptVersion").replaceChildren();
  for (const version of versions) {
    const option = node("option", version.name);
    option.value = version.name;
    $("promptVersion").append(option);
  }
  $("promptVersion").value = name;
  loadedPromptVersion = name;
  $("prompt").value =
    text ?? versions.find((version) => version.name === name)?.content ?? "";
  syncConfigurationSummary();
}
function activeInfo() {
  $("activeInfo").textContent =
    `当前生效：${profile.options.promptVersion} · ${profile.options.model} · ${profile.options.provider} · 温度 ${profile.options.temperature} · 输出上限 ${profile.options.maxTokens}`;
  $("creditInfo").textContent =
    `服务账本：${profile.isPro ? "Pro" : "免费"}，已用 ${profile.usedCredits}；额度免费 ${profile.freeCredits} / Pro ${profile.proCredits}，每批 ${profile.creditsPerGeneration}。`;
  $("entitlementChanges").textContent =
    `待应用：${$("membership").value === "pro" ? "Pro" : "免费"}，已用 ${$("usedCredits").value}；仅修改模拟权益。`;
  syncConfigurationSummary();
}
function loadProfileInputs() {
  populateVersions(profile.options.promptVersion);
  for (const id of optionFields) $(id).value = profile.options[id];
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
  if (link.id === "editPreviewGoal") goalReturn = true;
  if (
    link.dataset.pageLink === "prompts" &&
    !link.closest(".site-nav") &&
    currentPage !== "prompts"
  ) {
    if (["simulate", "cases"].includes(currentPage)) returnPage = currentPage;
    if (link.id === "returnToPrompt") goalReturn = false;
    rememberNavigation();
  }
  navigate(link.dataset.pageLink);
  const destination =
    link.id === "sharedDifferenceLink"
      ? ".shared-configuration"
      : link.id === "editPreviewGoal"
        ? ".goal-card"
        : link.id === "returnToPrompt"
          ? "#promptPreview"
          : null;
  if (destination)
    requestAnimationFrame(() =>
      document.querySelector(destination).scrollIntoView({ block: "start" }),
    );
});
window.addEventListener("popstate", () =>
  renderPage(location.pathname.split("/")[1]),
);
$("refreshHealth").onclick = refreshHealth;
$("dismissRestored").onclick = () => {
  $("restoredNotice").hidden = true;
};
window.addEventListener("pagehide", () => {
  rememberEditor();
  rememberGoal();
  scrollPositions[currentPage] = window.scrollY;
  rememberNavigation();
});
$("openSession").onclick = () => {
  try {
    if (session || runningCase || generationBlocked() || simulatedTasks.length)
      return;
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
  $("title").setCustomValidity("");
  $("deadline").setCustomValidity("");
  $("title").focus();
  renderSession();
  rememberGoal();
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
  rememberGoal();
};
$("promptVersion").onchange = () => {
  rememberEditor();
  const name = $("promptVersion").value;
  loadedPromptVersion = name;
  $("prompt").value =
    promptDrafts[name] ??
    versions.find((version) => version.name === name).content;
  rememberEditor();
  syncConfigurationSummary();
};
["prompt", ...optionFields, "versionName"].forEach((id) => {
  $(id).addEventListener("input", () => {
    rememberEditor();
    syncConfigurationSummary();
  });
});
goalFields.forEach((id) => {
  $(id).addEventListener("input", () => {
    rememberGoal();
    validateGoal(false);
    syncConfigurationSummary();
  });
});
$("discardDraft").onclick = () => {
  delete promptDrafts[loadedPromptVersion];
  $("prompt").value = versions.find(
    (version) => version.name === loadedPromptVersion,
  ).content;
  rememberEditor();
  syncConfigurationSummary();
};
$("restoreDraft").onclick = () => {
  $("prompt").value = promptDrafts[loadedPromptVersion];
  rememberEditor();
  syncConfigurationSummary();
};
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
  if (savingConfiguration || session || runningCase) return;
  $("versionName").setCustomValidity(
    versions.some((version) => version.name === $("versionName").value)
      ? "版本名已存在，请使用新名称。"
      : "",
  );
  if (!$("versionName").reportValidity()) return;
  $("prompt").setCustomValidity(
    $("prompt").value.trim() ? "" : "Prompt 不能为空。",
  );
  if (!$("prompt").reportValidity()) return;
  savingConfiguration = true;
  lockInputs();
  try {
    rememberEditor();
    const version = await api("/lab/prompts", "POST", {
      name: $("versionName").value,
      content: $("prompt").value,
    });
    versions = await api("/lab/prompts");
    populateVersions(version.name);
    $("versionName").value = "";
    rememberEditor();
    status(`已保存版本 ${version.name}；服务共享配置未改变。`);
  } catch (error) {
    report(error);
  } finally {
    savingConfiguration = false;
    lockInputs();
    syncConfigurationSummary();
  }
};
$("versionName").addEventListener("input", () =>
  $("versionName").setCustomValidity(""),
);
$("prompt").addEventListener("input", () => $("prompt").setCustomValidity(""));
$("applyProfile").onclick = async () => {
  if (session || runningCase || generationBlocked() || savingConfiguration)
    return;
  try {
    validateConfiguration();
    if (selectedPromptText() !== null)
      throw new Error("请先保存修改后的 Prompt 版本，再应用共享配置。");
    savingConfiguration = true;
    lockInputs();
    syncConfigurationSummary();
    const patch = profilePatch(profile, { options: options() });
    if (!Object.keys(patch).length) {
      status("生成配置与服务共享配置一致。");
      return;
    }
    profile = await api("/lab/profile", "PATCH", patch);
    activeInfo();
    status("生成配置已应用到共享服务，后续请求生效；模拟权益未修改。");
  } catch (error) {
    report(error);
  } finally {
    savingConfiguration = false;
    lockInputs();
    syncConfigurationSummary();
  }
};
$("applyEntitlement").onclick = async () => {
  if (session || runningCase || generationBlocked() || savingConfiguration)
    return;
  if (!$("usedCredits").reportValidity()) return;
  const desired = {
    isPro: $("membership").value === "pro",
    usedCredits: Number($("usedCredits").value),
  };
  const patch = profilePatch(profile, desired);
  if (!Object.keys(patch).length) {
    rightsDirty = false;
    status("模拟权益与服务配置一致。");
    return;
  }
  savingConfiguration = true;
  lockInputs();
  syncConfigurationSummary();
  try {
    profile = await api("/lab/profile", "PATCH", patch);
    rightsDirty = false;
    activeInfo();
    status("模拟权益已应用；服务生成配置未改变。");
  } catch (error) {
    report(error);
  } finally {
    savingConfiguration = false;
    lockInputs();
    syncConfigurationSummary();
  }
};
["membership", "usedCredits"].forEach((id) =>
  $(id).addEventListener("input", () => {
    rightsDirty = true;
    activeInfo();
  }),
);
$("reloadProfile").onclick = async () => {
  try {
    const [latest, prompts] = await Promise.all([
      api("/lab/profile"),
      api("/lab/prompts"),
    ]);
    profile = latest;
    versions = prompts;
    const name = $("promptVersion").value,
      text = $("prompt").value;
    populateVersions(name, text);
    activeInfo();
    status("共享配置已刷新；当前试验草稿未替换。");
  } catch (error) {
    report(error);
  }
};
$("replaceWithShared").onclick = () => {
  if (session || runningCase || savingConfiguration) return;
  rememberEditor();
  for (const id of optionFields) $(id).value = profile.options[id];
  populateVersions(profile.options.promptVersion);
  rememberEditor();
  activeInfo();
  status("已用当前显示的共享配置替换试验配置；原版本草稿可恢复。");
};
$("reloadEntitlement").onclick = async () => {
  try {
    profile = await api("/lab/profile");
    rightsDirty = false;
    $("membership").value = profile.isPro ? "pro" : "free";
    $("usedCredits").value = profile.usedCredits;
    activeInfo();
    status("已读取服务模拟权益。");
  } catch (error) {
    report(error);
  }
};
async function copyRun(run) {
  if (session || runningCase || generationBlocked()) {
    status("请先结束当前会话或评测，再复制为新的试验。", true);
    return;
  }
  try {
    const prompts = await api("/lab/prompts");
    const base = prompts.find(
      (version) => version.name === run.options.promptVersion,
    );
    if (!base)
      throw new Error("该运行的基础 Prompt 版本已不存在，请查看原始记录。");
    let text = base.content;
    if (run.promptEdited) {
      const preview = await api("/lab/preview", "POST", {
        request: run.input,
        options: run.options,
        promptText: base.content,
      });
      const suffix = preview.messages[0].content.slice(base.content.length);
      const historical =
        run.messages?.[0]?.content ||
        run.providerRequest?.messages?.[0]?.content;
      if (!suffix || !historical?.endsWith(suffix))
        throw new Error(
          "历史固定契约或 Schema 已变化，无法自动还原该草稿，请从原始记录核对。",
        );
      text = historical.slice(0, -suffix.length);
    }
    if (session || runningCase || generationBlocked())
      throw new Error("当前已打开会话或正在执行请求，请结束后再复制试验。");
    rememberEditor();
    versions = prompts;
    resetGoal();
    const goal = run.input.goal;
    for (const [id, value] of Object.entries({
      goalID: goal.id,
      title: goal.title,
      note: goal.note || "",
      start: goal.startDate || "",
      deadline: goal.deadline || "",
      locale: run.input.locale,
    }))
      $(id).value = value;
    for (const id of optionFields) $(id).value = run.options[id];
    populateVersions(run.options.promptVersion, text);
    rememberEditor();
    rememberGoal();
    renderSession();
    navigate("simulate");
    status(
      "已复制目标、语言与生成配置。新会话从 initial 开始，不带入旧会话排重历史。",
    );
  } catch (error) {
    report(error);
  }
}
const resultUI = createResultController({
  api,
  workspace,
  renderPlans,
  renderMetrics,
  renderIssues,
  renderTrace,
  notify: status,
  onFeedback(run) {
    historyUI.noteFeedback(run);
    casesUI.noteFeedback(run);
    if (currentRun?.id === run.id) currentRun.feedback = run.feedback;
  },
  onCompare(slot, run) {
    historyUI.chooseRun(slot, run);
    navigate("history");
  },
  onCopy: copyRun,
});
const historyUI = createHistoryController({
  api,
  workspace,
  renderResult: (...args) => resultUI.render(...args),
  notify: status,
  onBatchView: () => batchComparisonUI.load().catch(report),
});
const batchComparisonUI = createBatchComparison({
  api,
  workspace,
  renderResult: (...args) => resultUI.render(...args),
  notify: status,
});
const casesUI = createCasesController({
  api,
  workspace,
  getProvider: () => $("provider").value,
  getConfiguration() {
    validateConfiguration();
    return { options: options(), promptText: selectedPromptText() };
  },
  onRunningChange(value) {
    runningCase = value;
    renderSession();
  },
  renderResult: (...args) => resultUI.render(...args),
  notify: status,
  onViewHistory(id) {
    historyUI.focusRecord(id);
    navigate("history");
  },
  onCompareBatch(slot, batch) {
    batchComparisonUI.choose(slot, batch);
    historyUI.showBatchCompare();
    navigate("history");
  },
});
const costsUI = createCostsController({ api, notify: status });
$("viewCurrentInHistory").onclick = () => {
  if (!currentRun) return;
  historyUI.focusRecord(currentRun.id);
  navigate("history");
};
async function init() {
  const [health, currentProfile, prompts, examples, catalog] =
    await Promise.all(
      [
        "/health",
        "/lab/profile",
        "/lab/prompts",
        "/lab/examples",
        "/lab/cases",
      ].map((path) => api(path)),
    );
  profile = currentProfile;
  versions = prompts;
  samples = examples;
  await casesUI.setCatalog(catalog);
  loadProfileInputs();
  healthState = health;
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
  const savedGoal = workspace.get("goal");
  if (savedGoal && typeof savedGoal === "object") {
    for (const id of goalFields)
      if (typeof savedGoal[id] === "string") $(id).value = savedGoal[id];
    if (!/^[0-9a-f-]{36}$/i.test($("goalID").value))
      $("goalID").value = createID();
  }
  if (
    editorState.options &&
    versions.some(
      (version) => version.name === editorState.options.promptVersion,
    )
  ) {
    for (const id of optionFields)
      if (editorState.options[id] != null)
        $(id).value = editorState.options[id];
    populateVersions(
      editorState.options.promptVersion,
      typeof editorState.text === "string" ? editorState.text : undefined,
    );
    if (typeof editorState.versionName === "string")
      $("versionName").value = editorState.versionName;
  }
  $("restoredNotice").hidden = !restoredWorkspace;
  initialized = true;
  rememberGoal();
  rememberEditor();
  renderSession();
  setInterval(() => {
    if (!document.hidden) refreshHealth();
  }, 5000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshHealth();
  });
  if (location.pathname === "/history") historyUI.load().catch(report);
  if (location.pathname === "/costs") costsUI.load().catch(report);
  loadConnection().catch((error) => {
    $("listenStatus").textContent = "读取连接配置失败";
    report(error);
  });
}
renderPage(location.pathname.split("/")[1]);
init().catch(report);
