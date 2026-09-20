"use strict";

// No framework or bundler: the native app supplies only these six Rust commands.
const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((el) => [el.id, el]),
);
const $ = (id) => elements[id];
const article = $("document");
const reader = $("reader");
const welcome = article.innerHTML;
const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
const defaults = {
  theme: "paper",
  size: 18,
  wide: false,
  serif: true,
  sidebar: true,
  recent: [],
  positions: {},
};
let settings = { ...defaults };
try {
  settings = {
    ...defaults,
    ...JSON.parse(localStorage.getItem("folio-settings") || "{}"),
  };
} catch {
  /* A damaged preference file must not prevent reading. */
}
settings.recent = Array.isArray(settings.recent)
  ? settings.recent
      .filter((x) => typeof x?.path === "string" && typeof x.name === "string")
      .slice(0, 20)
  : [];
settings.positions =
  settings.positions && typeof settings.positions === "object"
    ? settings.positions
    : {};
settings.size = Math.min(28, Math.max(14, Number(settings.size) || 18));
settings.theme = ["paper", "light", "dark"].includes(settings.theme)
  ? settings.theme
  : "paper";
let current = null;
let headings = [];
let outlineLinks = [];
let history = [null];
let historyIndex = 0;
let generation = 0;
let loading = false;
let picking = false;
let ranges = [];
let matchIndex = -1;
let toastTimer, saveTimer, searchTimer;
let scrollQueued = false;
let watchBusy = false;
let watchError = "";
let failedStamp = "";

function save() {
  try {
    localStorage.setItem("folio-settings", JSON.stringify(settings));
  } catch {
    toast("Preferences could not be saved. Reading still works.");
  }
}
function rememberPosition() {
  if (!current) return;
  settings.positions[current.path] = reader.scrollTop;
  const entries = Object.entries(settings.positions);
  if (entries.length > 100)
    settings.positions = Object.fromEntries(entries.slice(-100));
}
function toast(message, duration = 5500) {
  clearTimeout(toastTimer);
  $("toast").textContent = String(message);
  $("toast").hidden = false;
  toastTimer = setTimeout(() => {
    $("toast").hidden = true;
  }, duration);
}
function applySettings() {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.style.setProperty("--reading-size", `${settings.size}px`);
  root.style.setProperty("--reading-width", settings.wide ? "1040px" : "740px");
  root.style.setProperty(
    "--reading-font",
    settings.serif
      ? 'Georgia,"Times New Roman",serif'
      : '"Segoe UI",system-ui,sans-serif',
  );
  document.body.classList.toggle("sidebar-hidden", !settings.sidebar);
  $("toggle-sidebar").setAttribute(
    "aria-expanded",
    String(settings.sidebar && !document.body.classList.contains("focus-mode")),
  );
  $("wide").setAttribute("aria-pressed", String(settings.wide));
  $("serif").setAttribute("aria-pressed", String(settings.serif));
  $("text-reset").textContent = `${Math.round((settings.size / 18) * 100)}%`;
  $("text-smaller").disabled = settings.size <= 14;
  $("text-larger").disabled = settings.size >= 28;
  document
    .querySelectorAll("button[data-theme]")
    .forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.theme === settings.theme),
      ),
    );
  requestAnimationFrame(updateScroll);
}
function setSize(size) {
  settings.size = Math.max(14, Math.min(28, size));
  applySettings();
  save();
}
function toggleSidebar() {
  if (document.body.classList.contains("focus-mode")) toggleFocus();
  settings.sidebar = !settings.sidebar;
  applySettings();
  save();
}
function toggleFocus() {
  const focused = document.body.classList.toggle("focus-mode");
  $("focus").setAttribute("aria-pressed", String(focused));
  applySettings();
}
function selectTab(name) {
  for (const tab of ["outline", "recent"]) {
    $(tab).hidden = name !== tab;
    $(`tab-${tab}`).setAttribute("aria-selected", String(name === tab));
    $(`tab-${tab}`).tabIndex = name === tab ? 0 : -1;
  }
}
function renderRecent() {
  const list = $("recent-list");
  list.replaceChildren();
  if (!settings.recent.length) {
    const empty = document.createElement("p");
    empty.className = "empty-nav";
    empty.textContent = "Your recently opened documents will appear here.";
    list.append(empty);
  }
  for (const item of settings.recent) {
    const button = document.createElement("button");
    button.className = "recent-item";
    button.title = item.path;
    button.innerHTML =
      '<svg><use href="#i-file"/></svg><span><strong></strong><small></small></span>';
    button.querySelector("strong").textContent = item.name;
    button.querySelector("small").textContent = item.path
      .replace(/^\\\\\?\\/, "")
      .replace(/[\\/][^\\/]+$/, "");
    button.addEventListener("click", () => openPath(item.path));
    list.append(button);
  }
  $("clear-recent").hidden = !settings.recent.length;
}
function historyButtons() {
  $("back").disabled = historyIndex <= 0;
  $("forward").disabled = historyIndex >= history.length - 1;
}
function pushHistory(path) {
  if (history[historyIndex] === path) return;
  history = history.slice(0, historyIndex + 1);
  history.push(path);
  if (history.length > 100) history.shift();
  historyIndex = history.length - 1;
  historyButtons();
}
async function navigateHistory(offset) {
  const next = historyIndex + offset;
  if (loading || next < 0 || next >= history.length) return;
  const ok =
    history[next] === null
      ? showWelcome(false)
      : await openPath(history[next], { record: false });
  if (ok) {
    historyIndex = next;
    historyButtons();
  }
}

async function chooseFile() {
  if (picking) return;
  picking = true;
  try {
    if (!window.__TAURI__) {
      toast("Open Folio.exe to read files in the desktop app.");
      return;
    }
    const path = await invoke("pick_file");
    if (path) await openPath(path);
  } catch (error) {
    toast(error);
  } finally {
    picking = false;
  }
}

async function openPath(
  path,
  { record = true, refresh = false, anchor = "" } = {},
) {
  const request = ++generation;
  rememberPosition();
  const previousPosition = reader.scrollTop;
  loading = true;
  document.body.classList.add("loading");
  $("status-label").textContent = "Opening document…";
  try {
    const doc = await invoke("open_document", { path });
    if (request !== generation) return false;
    current = doc;
    watchError = "";
    failedStamp = "";
    renderDocument(doc.html);
    $("filename").textContent = doc.name;
    $("filename").title = doc.path;
    document.title = `${doc.name} — Folio`;
    $("document-kind").textContent = "MARKDOWN DOCUMENT";
    $("reading-time").textContent =
      `${Math.max(1, Math.ceil(doc.words / 220))} min read`;
    $("word-count").textContent = `${doc.words.toLocaleString()} words`;
    $("reload").disabled = false;
    settings.recent = [
      { path: doc.path, name: doc.name },
      ...settings.recent.filter((x) => x.path !== doc.path),
    ].slice(0, 20);
    renderRecent();
    save();
    if (record) pushHistory(doc.path);
    if (!refresh) selectTab("outline");
    reader.scrollTop = refresh
      ? previousPosition
      : Number(settings.positions[doc.path]) || 0;
    if (anchor) jumpToAnchor(anchor);
    if (!$("searchbar").hidden) runSearch(false);
    $("status-label").textContent = refresh
      ? "Document refreshed"
      : "Saved locally · Auto-refresh on";
    if (!refresh && $("searchbar").hidden)
      reader.focus({ preventScroll: true });
    updateScroll();
    return true;
  } catch (error) {
    if (request !== generation) return false;
    toast(error, 8500);
    $("status-label").textContent = "Could not open document";
    return false;
  } finally {
    if (request === generation) {
      loading = false;
      document.body.classList.remove("loading");
    }
  }
}

function showWelcome(record = true) {
  ++generation;
  loading = false;
  document.body.classList.remove("loading");
  rememberPosition();
  save();
  current = null;
  renderDocument(welcome, true);
  $("filename").textContent = "Welcome to Folio";
  $("filename").title = "";
  document.title = "Folio — Markdown Reader";
  $("document-kind").textContent = "A LITTLE SPACE TO THINK";
  $("reading-time").textContent = "2 min read";
  $("word-count").textContent = "Welcome guide";
  $("status-label").textContent = "Ready when you are";
  $("reload").disabled = true;
  reader.scrollTop = 0;
  if (record) pushHistory(null);
  if (!$("searchbar").hidden) runSearch(false);
  selectTab("outline");
  updateScroll();
  return true;
}

function renderDocument(html, isWelcome = false) {
  clearHighlights();
  // A template is inert: images cannot make requests before their sources are inspected.
  const template = document.createElement("template");
  template.innerHTML = html; // HTML from Rust has already passed through Ammonia.
  const content = template.content;
  content.querySelectorAll("[id]").forEach((el) => {
    el.id = `doc-${el.id}`;
  });
  content.querySelectorAll("input").forEach((el) => {
    if (el.type !== "checkbox") el.remove();
    else {
      el.disabled = true;
      el.setAttribute(
        "aria-label",
        el.checked ? "Completed task" : "Incomplete task",
      );
    }
  });
  content.querySelectorAll("img").forEach((img) => {
    const source = img.getAttribute("src") || "";
    const alt = img.alt || "Image";
    img.removeAttribute("srcset");
    img.loading = "lazy";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => {
      const fallback = document.createElement("span");
      fallback.className = "missing-image";
      fallback.textContent = `${alt} — image could not be loaded`;
      img.replaceWith(fallback);
    });
    if (/^https?:\/\//i.test(source)) {
      img.removeAttribute("src");
      const box = document.createElement("span");
      box.className = "remote-image";
      box.textContent = `${alt} · External image`;
      const button = document.createElement("button");
      button.textContent = "Load image";
      button.title = source;
      button.addEventListener("click", () => {
        img.src = source;
        box.replaceWith(img);
      });
      box.append(button);
      img.replaceWith(box);
    } else if (
      !/^data:image\/(png|jpeg|gif|webp|svg\+xml|bmp);base64,/i.test(source)
    ) {
      const fallback = document.createElement("span");
      fallback.className = "missing-image";
      fallback.textContent = `${alt} — local image unavailable (maximum 8 MB per image, 24 MB total)`;
      img.replaceWith(fallback);
    }
  });
  content.querySelectorAll("pre").forEach((pre) => {
    const code = pre.querySelector("code");
    if (!code) return;
    const label = document.createElement("span");
    label.className = "code-label";
    label.textContent =
      [...code.classList].find((c) => c.startsWith("language-"))?.slice(9) ||
      "plain text";
    const copy = document.createElement("button");
    copy.className = "copy-code";
    copy.textContent = "Copy";
    copy.setAttribute("aria-label", "Copy code block");
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
        copy.textContent = "Copied";
        setTimeout(() => {
          copy.textContent = "Copy";
        }, 1500);
      } catch {
        toast("Could not copy. Select the code and press Ctrl+C.");
      }
    });
    pre.prepend(label, copy);
  });
  content.querySelectorAll("table").forEach((table) => {
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    // Short IDs/statuses stay compact; prose columns get room to be read.
    // Sample a bounded number of rows so very large tables stay cheap to lay out.
    const lengths = [];
    for (const row of [...table.rows].slice(0, 100)) {
      for (const cell of row.cells) {
        lengths[cell.cellIndex] = Math.max(lengths[cell.cellIndex] || 0, cell.textContent.trim().length);
      }
    }
    for (const row of table.rows) {
      for (const cell of row.cells) {
        cell.classList.add(lengths[cell.cellIndex] <= 24 ? "table-compact" : "table-prose");
      }
    }
    if (lengths.length >= 4 || lengths.reduce((sum, length) => sum + Math.min(length, 80), 0) > 110) {
      wrap.classList.add("wide-table");
    }
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", "Table; scroll horizontally if needed");
    table.replaceWith(wrap);
    wrap.append(table);
  });
  if (!content.textContent.trim() && !content.querySelector("img")) {
    const empty = document.createElement("p");
    empty.className = "lead";
    empty.textContent = "This document is empty.";
    content.append(empty);
  }
  article.replaceChildren(content);
  if (isWelcome)
    article
      .querySelector(".primary-button")
      .addEventListener("click", chooseFile);
  buildOutline();
}

function buildOutline() {
  headings = [...article.querySelectorAll("h1,h2,h3,h4,h5,h6")];
  const fragment = document.createDocumentFragment();
  headings.forEach((heading, index) => {
    if (!heading.id) heading.id = `doc-section-${index}`;
    const link = document.createElement("a");
    link.href = `#${heading.id}`;
    link.className = "outline-link";
    link.dataset.level = heading.tagName.slice(1);
    link.textContent = heading.innerText.replace(/\s+/g, " ").trim() || "Untitled section";
    link.title = link.textContent;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      heading.scrollIntoView({ block: "start" });
      reader.focus({ preventScroll: true });
      if (innerWidth <= 720) {
        settings.sidebar = false;
        applySettings();
      }
      updateScroll();
    });
    fragment.append(link);
  });
  if (!headings.length) {
    const empty = document.createElement("p");
    empty.className = "empty-nav";
    empty.textContent =
      "No headings in this document. Settle in and start reading.";
    fragment.append(empty);
  }
  $("outline").replaceChildren(fragment);
  outlineLinks = [...$("outline").querySelectorAll("a")];
}
function jumpToAnchor(anchor) {
  let id;
  try {
    id = decodeURIComponent(anchor.replace(/^#/, ""));
  } catch {
    id = anchor.replace(/^#/, "");
  }
  const target = article.querySelector(`#${CSS.escape(`doc-${id}`)}`);
  if (target) {
    target.scrollIntoView({ block: "start" });
    updateScroll();
  } else toast("That section was not found in this document.");
}
article.addEventListener("click", async (event) => {
  const link = event.target.closest("a");
  if (!link) return;
  event.preventDefault();
  const target = link.getAttribute("href");
  if (!target) return;
  if (target.startsWith("#")) {
    jumpToAnchor(target);
    return;
  }
  try {
    if (/^(https?:|mailto:)/i.test(target))
      await invoke("open_external", { target });
    else if (current) {
      const path = await invoke("resolve_link", { base: current.path, target });
      const anchor = target.includes("#")
        ? target.slice(target.indexOf("#"))
        : "";
      if (path === current.path && anchor) jumpToAnchor(anchor);
      else await openPath(path, { anchor });
    }
  } catch (error) {
    toast(error);
  }
});

function updateScroll() {
  const max = reader.scrollHeight - reader.clientHeight;
  const progress =
    max > 0 ? Math.min(100, Math.round((reader.scrollTop / max) * 100)) : 100;
  $("progress").textContent = `${progress}%`;
  $("progress-line").style.width = `${progress}%`;
  const top = reader.getBoundingClientRect().top + 75;
  let active = 0;
  for (let i = 0; i < headings.length; i++) {
    if (headings[i].getBoundingClientRect().top <= top) active = i;
    else break;
  }
  outlineLinks.forEach((link, i) => {
    link.classList.toggle("active", i === active);
    if (i === active) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });
}
reader.addEventListener(
  "scroll",
  () => {
    if (!scrollQueued)
      requestAnimationFrame(() => {
        scrollQueued = false;
        updateScroll();
      });
    scrollQueued = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      rememberPosition();
      save();
    }, 500);
  },
  { passive: true },
);
window.addEventListener("resize", updateScroll);
window.addEventListener("pagehide", () => {
  rememberPosition();
  save();
});

function clearHighlights() {
  CSS.highlights?.delete("search");
  CSS.highlights?.delete("current");
  ranges = [];
  matchIndex = -1;
}
function openSearch() {
  $("searchbar").hidden = false;
  $("search-input").focus();
  $("search-input").select();
  runSearch(false);
}
function closeSearch() {
  $("searchbar").hidden = true;
  clearHighlights();
  reader.focus();
}
function runSearch(jump = true) {
  clearHighlights();
  const query = $("search-input").value;
  if (!query) {
    $("search-count").textContent = "";
    return;
  }
  // Build an index only when searching. Ranges can span inline emphasis and links.
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement.closest(
        "button,.code-label,.remote-image,.missing-image",
      )
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const nodes = [];
  let text = "",
    node,
    previousBlock;
  while ((node = walker.nextNode())) {
    const block = node.parentElement.closest(
      "p,h1,h2,h3,h4,h5,h6,li,pre,td,th,blockquote",
    );
    if (previousBlock && block !== previousBlock) text += "\n";
    previousBlock = block;
    nodes.push({ node, start: text.length, end: text.length + node.length });
    text += node.textContent;
  }
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(escaped, "giu");
  let match,
    cursor = 0;
  while ((match = pattern.exec(text)) && ranges.length < 5000) {
    while (cursor < nodes.length && nodes[cursor].end <= match.index) cursor++;
    let endCursor = cursor;
    const end = match.index + match[0].length;
    while (endCursor < nodes.length && nodes[endCursor].end < end) endCursor++;
    if (!nodes[cursor] || !nodes[endCursor]) break;
    const range = new Range();
    range.setStart(
      nodes[cursor].node,
      Math.max(0, match.index - nodes[cursor].start),
    );
    range.setEnd(nodes[endCursor].node, end - nodes[endCursor].start);
    ranges.push(range);
  }
  if (CSS.highlights && ranges.length)
    CSS.highlights.set("search", new Highlight(...ranges));
  matchIndex = ranges.length ? 0 : -1;
  showMatch(jump);
}
function showMatch(jump = true) {
  $("search-count").textContent = ranges.length
    ? `${matchIndex + 1} of ${ranges.length}${ranges.length === 5000 ? "+" : ""}`
    : "No matches";
  $("search-prev").disabled = $("search-next").disabled = !ranges.length;
  if (matchIndex < 0) return;
  const range = ranges[matchIndex];
  if (CSS.highlights) CSS.highlights.set("current", new Highlight(range));
  if (jump) {
    const rect = range.getBoundingClientRect();
    reader.scrollTop +=
      rect.top - reader.getBoundingClientRect().top - reader.clientHeight / 3;
  }
}
function nextMatch(direction) {
  if (ranges.length) {
    matchIndex = (matchIndex + direction + ranges.length) % ranges.length;
    showMatch();
  }
}
$("search-input").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 100);
});
$("searchbar").addEventListener("submit", (e) => {
  e.preventDefault();
  nextMatch(1);
});
$("search-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.shiftKey) {
    e.preventDefault();
    nextMatch(-1);
  }
});

const actions = {
  "open-sidebar": chooseFile,
  "open-menu": chooseFile,
  "toggle-sidebar": toggleSidebar,
  focus: toggleFocus,
  find: openSearch,
  "text-smaller": () => setSize(settings.size - 1),
  "text-larger": () => setSize(settings.size + 1),
  "text-reset": () => setSize(18),
  back: () => navigateHistory(-1),
  forward: () => navigateHistory(1),
  "search-prev": () => nextMatch(-1),
  "search-close": closeSearch,
  home: () => showWelcome(),
  reload: () =>
    current && openPath(current.path, { record: false, refresh: true }),
  wide: () => {
    settings.wide = !settings.wide;
    applySettings();
    save();
  },
  serif: () => {
    settings.serif = !settings.serif;
    applySettings();
    save();
  },
  print: () => window.print(),
  help: () => $("shortcuts").showModal(),
  "close-help": () => $("shortcuts").close(),
  progress: () => {
    reader.scrollTop = 0;
  },
  "tab-outline": () => selectTab("outline"),
  "tab-recent": () => selectTab("recent"),
  "clear-recent": () => {
    settings.recent = [];
    settings.positions = {};
    save();
    renderRecent();
  },
};
for (const [id, action] of Object.entries(actions))
  $(id).addEventListener("click", () => {
    if ($("options").matches(":popover-open")) $("options").hidePopover();
    action();
  });
document.querySelectorAll("button[data-theme]").forEach((button) =>
  button.addEventListener("click", () => {
    settings.theme = button.dataset.theme;
    applySettings();
    save();
  }),
);
document.querySelector(".nav-tabs").addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const tab =
    event.key === "Home"
      ? "outline"
      : event.key === "End"
        ? "recent"
        : $("outline").hidden
          ? "outline"
          : "recent";
  selectTab(tab);
  $(`tab-${tab}`).focus();
});
document.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  const ctrl = event.ctrlKey || event.metaKey;
  let action;
  if (ctrl && key === "o") action = chooseFile;
  else if (ctrl && key === "f")
    action = event.shiftKey ? toggleFocus : openSearch;
  else if (ctrl && key === "b") action = toggleSidebar;
  else if (ctrl && ["+", "="].includes(key))
    action = () => setSize(settings.size + 1);
  else if (ctrl && key === "-") action = () => setSize(settings.size - 1);
  else if (ctrl && key === "0") action = () => setSize(18);
  else if (ctrl && key === "p") action = () => window.print();
  else if (key === "f5" || (ctrl && key === "r")) action = actions.reload;
  else if (event.altKey && key === "arrowleft")
    action = () => navigateHistory(-1);
  else if (event.altKey && key === "arrowright")
    action = () => navigateHistory(1);
  else if (key === "escape" && !$("shortcuts").open) {
    if (!$("searchbar").hidden) action = closeSearch;
    else if (document.body.classList.contains("focus-mode"))
      action = toggleFocus;
  } else if (key === "?" && !event.target.matches("input,textarea"))
    action = actions.help;
  if (action) {
    event.preventDefault();
    action();
  }
});
document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => event.preventDefault());

async function watchFile() {
  if (!current || loading || watchBusy || document.hidden || !window.__TAURI__)
    return;
  watchBusy = true;
  const watched = current;
  const version = generation;
  try {
    const stamp = await invoke("modified", { path: watched.path });
    if (current !== watched || version !== generation) return;
    if (stamp !== watched.modified && stamp !== failedStamp) {
      if (!(await openPath(watched.path, { record: false, refresh: true })))
        failedStamp = stamp;
    } else if (watchError) {
      watchError = "";
      $("status-label").textContent = "Saved locally · Auto-refresh on";
    }
  } catch (error) {
    if (
      current === watched &&
      version === generation &&
      watchError !== String(error)
    ) {
      watchError = String(error);
      $("status-label").textContent =
        "File unavailable · Showing last loaded version";
      toast(
        "The file was moved or is unavailable. The last loaded document remains readable.",
      );
    }
  } finally {
    watchBusy = false;
  }
}

applySettings();
renderRecent();
showWelcome(false);
if (window.__TAURI__) {
  window.__TAURI__.event.listen("tauri://drag-enter", () => {
    $("drop-overlay").hidden = false;
  });
  window.__TAURI__.event.listen("tauri://drag-leave", () => {
    $("drop-overlay").hidden = true;
  });
  window.__TAURI__.event.listen("tauri://drag-drop", (event) => {
    $("drop-overlay").hidden = true;
    const paths = event.payload.paths;
    if (paths?.length) {
      if (paths.length > 1)
        toast("Opening the first file. Drop one document at a time.");
      openPath(paths[0]);
    }
  });
  invoke("initial_path")
    .then((path) => {
      if (path) openPath(path);
    })
    .catch((error) => toast(error));
  setInterval(watchFile, 2000);
  window.addEventListener("focus", watchFile);
}
