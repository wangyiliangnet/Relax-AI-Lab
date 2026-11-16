const storageKey = "relax-lab-workspace-v1";
const sections = new Set([
  "editor",
  "goal",
  "cases",
  "history",
  "feedback",
  "navigation",
  "batchComparison",
]);

// Store only editing state. Sessions, batches, API responses and credentials
// deliberately have no persistent representation.
export function createWorkspaceStorage(storage) {
  let state = {};
  try {
    storage ??= globalThis.sessionStorage;
    const saved = JSON.parse(storage.getItem(storageKey) || "null");
    if (
      saved?.version === 1 &&
      saved.values &&
      typeof saved.values === "object"
    )
      state = Object.fromEntries(
        Object.entries(saved.values).filter(
          ([key, value]) =>
            sections.has(key) &&
            value &&
            typeof value === "object" &&
            !Array.isArray(value),
        ),
      );
  } catch {}
  return {
    get(key, fallback = null) {
      return structuredClone(state[key] ?? fallback);
    },
    set(key, value) {
      if (!sections.has(key)) throw new Error("Unsupported workspace section");
      state[key] = structuredClone(value);
      try {
        storage?.setItem(
          storageKey,
          JSON.stringify({ version: 1, values: state }),
        );
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function profilePatch(current, desired) {
  const changed = (values, previous) =>
    Object.fromEntries(
      Object.entries(values).filter(([key, value]) => value !== previous[key]),
    );
  const { options, ...fields } = desired;
  const patch = changed(fields, current);
  if (options) {
    const selected = changed(options, current.options);
    if (Object.keys(selected).length) patch.options = selected;
  }
  return patch;
}

export function configurationDifferences(current, shared, draft = false) {
  const labels = {
    promptVersion: "Prompt 版本",
    provider: "调用方式",
    model: "模型",
    temperature: "采样温度",
    maxTokens: "输出上限",
  };
  const differences = Object.entries(labels)
    .filter(([key]) => current[key] !== shared[key])
    .map(([key, label]) => ({
      key,
      label,
      before: shared[key],
      after: current[key],
    }));
  if (draft)
    differences.push({
      key: "draft",
      label: "Prompt 正文",
      before: "已保存版本",
      after: "本地草稿（需先保存新版本）",
    });
  return differences;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}

export function comparisonDifferences(a, b) {
  const context = (run) => {
    const request = structuredClone(run.effectiveRequest || run.input);
    if (request.goal) delete request.goal.id;
    return stable(request);
  };
  const differences = [];
  if (JSON.stringify(context(a)) !== JSON.stringify(context(b)))
    differences.push("业务输入不同（目标、日期、语言、生成模式或排重集合）");
  if (a.entitlementBefore?.isPro !== b.entitlementBefore?.isPro)
    differences.push("模拟会员身份不同");
  if (
    ["provider", "model", "temperature", "maxTokens"].some(
      (key) => a.options[key] !== b.options[key],
    )
  )
    differences.push("模型或采样参数不同");
  if (a.promptHash !== b.promptHash || a.promptEdited !== b.promptEdited)
    differences.push("Prompt 正文或固定契约指纹不同");
  return differences;
}
