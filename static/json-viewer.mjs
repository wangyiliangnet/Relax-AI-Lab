export function embeddedJSON(value) {
  if (typeof value !== "string" || !["{", "["].includes(value.trim()[0]))
    return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
export function formattedJSON(value) {
  return JSON.stringify(value, null, 2) ?? "null";
}
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
};
function scalar(value) {
  const type = value === null ? "null" : typeof value;
  if (type === "string" && (value.includes("\n") || value.length > 180)) {
    const details = element("details", null, "json-text-value");
    details.append(
      element("summary", `文本 · ${value.length.toLocaleString()} 字`),
      element("pre", value, "json-string-block"),
    );
    return details;
  }
  return element(
    "span",
    type === "string" ? JSON.stringify(value) : String(value),
    "json-scalar json-" + type,
  );
}
function tree(value, key = null, depth = 0) {
  if (depth > 40) return element("span", "…", "json-muted");
  const encoded = embeddedJSON(value),
    content = encoded || value;
  if (content !== null && typeof content === "object") {
    const array = Array.isArray(content),
      entries = Object.entries(content),
      details = element("details", null, "json-node");
    details.open = depth < 2;
    const summary = element("summary");
    if (key !== null)
      summary.append(
        element("span", key, "json-key"),
        element("span", ": ", "json-muted"),
      );
    summary.append(
      element(
        "span",
        array ? `[ ${entries.length} 项 ]` : `{ ${entries.length} 个字段 }`,
        "json-muted",
      ),
    );
    if (encoded) summary.append(element("span", "JSON 字符串", "json-encoded"));
    const children = element("div", null, "json-children");
    for (const [name, item] of entries)
      children.append(tree(item, array ? `[${name}]` : name, depth + 1));
    details.append(summary, children);
    return details;
  }
  const row = element("div", null, "json-leaf");
  if (key !== null)
    row.append(
      element("span", key, "json-key"),
      element("span", ": ", "json-muted"),
    );
  row.append(scalar(content));
  return row;
}
function highlightedJSON(value) {
  const pre = element("pre", null, "json-code"),
    source = formattedJSON(value);
  const tokens =
    /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let end = 0;
  for (const match of source.matchAll(tokens)) {
    pre.append(document.createTextNode(source.slice(end, match.index)));
    const kind = match[1]
      ? "key"
      : match[2]
        ? "string"
        : match[3]
          ? match[3] === "null"
            ? "null"
            : "boolean"
          : "number";
    pre.append(element("span", match[0], "json-" + kind));
    end = match.index + match[0].length;
  }
  pre.append(document.createTextNode(source.slice(end)));
  return pre;
}
async function copy(value) {
  if (navigator.clipboard?.writeText)
    return navigator.clipboard.writeText(value);
  const field = element("textarea");
  field.value = value;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) throw new Error("copy failed");
}
export function createJsonViewer(value, { empty = "暂无数据" } = {}) {
  const wrapper = element("div", null, "json-viewer");
  if (value == null) {
    wrapper.append(element("p", empty, "hint"));
    return wrapper;
  }
  const content = embeddedJSON(value) || value,
    toolbar = element("div", null, "json-toolbar"),
    modes = element("div", null, "segmented-control");
  const treeButton = element("button", "结构视图"),
    textButton = element("button", "JSON 文本"),
    expand = element("button", "展开全部", "link-button"),
    collapse = element("button", "折叠全部", "link-button"),
    copyButton = element("button", "复制 JSON", "link-button");
  for (const button of [treeButton, textButton, expand, collapse, copyButton])
    button.type = "button";
  const structure = element("div", null, "json-tree");
  structure.append(tree(content));
  const raw = highlightedJSON(content);
  raw.hidden = true;
  const mode = (structured) => {
    structure.hidden = !structured;
    raw.hidden = structured;
    treeButton.setAttribute("aria-pressed", String(structured));
    textButton.setAttribute("aria-pressed", String(!structured));
    expand.hidden = collapse.hidden = !structured;
  };
  treeButton.onclick = () => mode(true);
  textButton.onclick = () => mode(false);
  expand.onclick = () =>
    structure.querySelectorAll("details").forEach((node) => (node.open = true));
  collapse.onclick = () =>
    structure
      .querySelectorAll("details")
      .forEach((node) => (node.open = false));
  copyButton.onclick = async () => {
    try {
      await copy(formattedJSON(content));
      copyButton.textContent = "已复制";
    } catch {
      copyButton.textContent = "请选择 JSON 文本复制";
      mode(false);
    }
  };
  modes.append(treeButton, textButton);
  toolbar.append(modes, expand, collapse, copyButton);
  wrapper.append(toolbar, structure, raw);
  mode(true);
  return wrapper;
}
