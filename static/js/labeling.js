// Labeling workbench.
import { api, el, toast, modal, fmtDuration, fmtTime } from "./api.js";
import { ActivityTimer, SessionReporter } from "./timer.js";

let L = null; // live labeling state

export async function renderLabeling(mount, projectId, goHome) {
  destroy();
  const meta = await api.openProject(projectId);
  L = {
    id: projectId, meta, mount, goHome,
    pos: meta.current_pos || 0,
    row: null,
    counts: meta.counts,
    distribution: meta.distribution,
    sel: { 1: new Set(), 2: new Set() },
    comment: "",
    undo: [],
    expanded: false,
    saveState: { at: meta.last_saved, err: false },
    keydown: onKey,
  };
  L.timer = new ActivityTimer({
    idleTimeoutS: meta.config.idle_timeout_seconds || 90,
    onStateChange: updateTimerChip,
  });
  L.reporter = new SessionReporter(projectId, L.timer, api);
  L.clock = setInterval(() => updateTimerChip(L.timer.state), 1000);
  window.addEventListener("keydown", onKey);

  if (meta.recovered_from)
    toast(`Recovered project state from backup ${meta.recovered_from}.`, 6000);
  if (meta.csv_changed_warning) toast(meta.csv_changed_warning, 9000);

  buildShell();
  await goTo(L.pos, { record: false });
}

export function destroy() {
  if (!L) return;
  window.removeEventListener("keydown", L.keydown);
  clearInterval(L.clock);
  L.timer?.destroy();
  L.reporter?.destroy();
  document.getElementById("topbar-slot").innerHTML = "";
  L = null;
}

/* ------------------------------------------------------------------ shell */
function buildShell() {
  const m = L.meta;
  const slot = document.getElementById("topbar-slot");
  slot.innerHTML = "";
  L.saveBadge = el("span", { class: "savebadge" });
  L.timerChip = el("button", { class: "timerchip", title: "Pause / resume the session timer", onclick: togglePause }, "0:00");
  const home = el("button", { class: "small ghost" }, "All projects");
  home.addEventListener("click", () => { const g = L.goHome; destroy(); g(); });
  slot.append(
    el("span", { class: "mono muted", style: "font-size:12.5px" }, m.name),
    L.saveBadge,
    el("button", { class: "small", onclick: saveNow }, "Save progress"),
    L.timerChip,
    el("button", { class: "small", onclick: showStats }, "Statistics"),
    el("button", { class: "small", onclick: showExport }, "Export"),
    home,
  );
  updateSaveBadge();

  L.mount.innerHTML = "";
  const wb = el("div", { class: "workbench" });

  // progress strip
  L.progressBar = el("div", {});
  L.progressNums = el("span", { class: "nums" });
  wb.append(el("div", { class: "progress-strip" },
    el("div", { class: "bar" }, L.progressBar), L.progressNums));

  // nav row
  const jumpInput = el("input", { type: "text", placeholder: "row # or ID", "aria-label": "Jump to row" });
  jumpInput.addEventListener("keydown", e => { if (e.key === "Enter") jumpTo(jumpInput.value); });
  const searchInput = el("input", { type: "search", placeholder: "Search text or ID…", "aria-label": "Search dataset", id: "search-box" });
  searchInput.addEventListener("keydown", e => { if (e.key === "Enter") doSearch(searchInput.value); });
  const filterSel = el("select", { "aria-label": "Filter rows by status", onchange: e => { if (e.target.value) doFilter(e.target.value); e.target.value = ""; } },
    el("option", { value: "" }, "Filter by status…"),
    el("option", { value: "unlabeled" }, "Unlabeled"),
    el("option", { value: "labeled" }, "Labeled"),
    el("option", { value: "skipped" }, "Skipped"),
    el("option", { value: "unsure" }, "Unsure"),
    el("option", { value: "invalid" }, "Invalid input"),
    el("option", { value: "discuss" }, "Needs discussion"),
    el("option", { value: "preexisting" }, "Pre-existing value"));
  wb.append(el("div", { class: "nav-row" },
    el("button", { onclick: () => goTo(L.pos - 1), title: "Previous row (←)" }, "← Prev"),
    el("button", { onclick: () => goTo(L.pos + 1), title: "Next row (→)" }, "Next →"),
    el("button", { class: "primary", onclick: nextUnlabeled, title: "Next unlabeled row ( . )" }, "Next unlabeled ⇥"),
    el("button", { onclick: nextFlagged, title: "Next skipped or unsure row ( , )" }, "Next skipped/unsure"),
    el("button", { onclick: undo, title: "Undo last annotation (Ctrl+Z)" }, "↩ Undo"),
    el("span", { class: "grow" }),
    el("span", { class: "jump-box" }, el("span", { class: "muted", style: "font-size:12.5px" }, "Go to"), jumpInput),
    el("span", { style: "min-width:190px" }, searchInput),
    filterSel));

  // bench: item card + side panel
  L.itemCard = el("div", { class: "card item-card" });
  L.sidePanel = el("div", {});
  wb.append(el("div", { class: "bench" }, L.itemCard, L.sidePanel));

  // shortcuts legend
  wb.append(buildLegend());
  L.mount.append(wb);
  buildSidePanel();
  updateProgress();
}

function buildLegend() {
  const m = L.meta;
  const items = [];
  const lg = (k, t) => el("span", { class: "lg" }, el("kbd", { class: "key" }, k), t);
  for (const lab of m.labels.filter(l => !l.parent && l.shortcut).slice(0, 8))
    items.push(lg(lab.shortcut, lab.name));
  items.push(lg("← →", "navigate"), lg(".", "next unlabeled"), lg(",", "next flagged"));
  if (isMulti(1) || isHier()) items.push(lg("Enter", "confirm"));
  const st = m.config.special_states;
  if (st.skip) items.push(lg("Alt+S", "skip"));
  if (st.unsure) items.push(lg("Alt+U", "unsure"));
  if (st.invalid) items.push(lg("Alt+I", "invalid"));
  if (st.discuss) items.push(lg("Alt+D", "discuss"));
  items.push(lg("Ctrl+Z", "undo"), lg("Ctrl+S", "save"), lg("Ctrl+F", "search"));
  return el("div", { class: "legend", "aria-label": "Active keyboard shortcuts" }, items);
}

/* ------------------------------------------------------------- side panel */
function isHier() { return L.meta.config.task_type.startsWith("hier"); }
function isMulti(level) {
  const t = L.meta.config.task_type;
  if (!isHier()) return t === "multi";
  return level === 1 ? t === "hier_multi" : !!L.meta.config.child_multi;
}
function parentLabels() { return L.meta.labels.filter(l => !l.parent); }
function childrenOf(pid) { return L.meta.labels.filter(l => l.parent === pid); }

function buildSidePanel() {
  const sp = L.sidePanel;
  sp.innerHTML = "";
  const m = L.meta;

  // label buttons
  const box = el("div", { class: "card tight side-section" });
  box.append(el("div", { class: "side-title" }, isHier() ? "Labels — level 1" : "Labels"));
  L.labelBox1 = el("div", {});
  box.append(L.labelBox1);
  if (isHier()) {
    box.append(el("div", { class: "side-title", style: "margin-top:12px" }, "Level 2"));
    L.labelBox2 = el("div", {}, el("div", { class: "hint" }, "Select a level-1 label first."));
    box.append(L.labelBox2);
  }
  if (isMulti(1) || isHier()) {
    L.confirmBtn = el("button", { class: "primary", style: "width:100%;margin-top:6px", onclick: confirmSelection }, "Confirm selection  ⏎");
    box.append(L.confirmBtn);
  }

  // special states
  const st = m.config.special_states;
  const specials = el("div", { class: "special-row" });
  const sb = (name, text, key) => el("button", { onclick: () => saveSpecial(name), title: `Alt+${key}` },
    el("span", { class: "key" }, `⌥${key}`), text);
  if (st.skip) specials.append(sb("skipped", "Skip", "S"));
  if (st.unsure) specials.append(sb("unsure", "Unsure", "U"));
  if (st.invalid) specials.append(sb("invalid", "Invalid", "I"));
  if (st.discuss) specials.append(sb("discuss", "Discuss", "D"));
  if (specials.children.length) box.append(specials);

  // comment
  if (st.comment) {
    L.commentBox = el("textarea", { placeholder: "Comment for this row (optional)", rows: "2", "aria-label": "Annotation comment" });
    L.commentBox.addEventListener("input", () => L.comment = L.commentBox.value);
    box.append(el("div", { style: "margin-top:10px" }, L.commentBox));
  }
  sp.append(box);

  // instructions panel
  const instr = el("details", { class: "panel" },
    el("summary", {}, "Label guide & instructions"),
    el("div", { class: "panel-body" }, m.labels.map(lab => el("div", { style: "margin-bottom:10px" },
      el("div", {}, el("span", { class: "dot", style: `display:inline-block;width:10px;height:10px;border-radius:3px;background:${lab.color};margin-right:6px` }),
        el("b", {}, (lab.parent ? "↳ " : "") + lab.name),
        lab.shortcut ? el("span", { class: "key", style: "margin-left:8px" }, lab.shortcut) : ""),
      lab.definition ? el("div", { class: "muted", style: "font-size:12.5px" }, lab.definition) : "",
      lab.instructions ? el("div", { style: "font-size:12.5px;margin-top:2px" }, lab.instructions) : "",
      lab.examples ? el("div", { class: "mono", style: "font-size:11.5px;color:var(--ink-soft);white-space:pre-wrap;margin-top:2px" }, "e.g.\n" + lab.examples) : ""))));
  sp.append(instr);

  // distribution
  if (m.config.show_distribution) {
    L.distPanel = el("details", { class: "panel", open: "" },
      el("summary", {}, "Label distribution (live)"),
      el("div", { class: "panel-body", id: "dist-body" }));
    sp.append(L.distPanel);
  }
  renderLabelButtons();
  renderDistribution();
}

function renderLabelButtons() {
  const lb = (lab, level) => {
    const selSet = L.sel[level];
    const btn = el("button", { class: "label-btn" + (selSet.has(lab.name) ? " selected" : "") },
      el("span", { class: "dot", style: `background:${lab.color}` }),
      el("span", { class: "name" }, lab.name, lab.definition ? el("span", { class: "def" }, lab.definition) : ""),
      lab.shortcut ? el("span", { class: "key" }, lab.shortcut) : "");
    if (L.row?.locked) btn.disabled = true;
    btn.addEventListener("click", () => pickLabel(lab, level));
    return btn;
  };
  L.labelBox1.innerHTML = "";
  for (const lab of parentLabels()) L.labelBox1.append(lb(lab, 1));

  if (isHier()) {
    L.labelBox2.innerHTML = "";
    const selectedParents = parentLabels().filter(p => L.sel[1].has(p.name));
    let any = false;
    for (const p of selectedParents) {
      const kids = childrenOf(p.id);
      if (!kids.length) continue;
      any = true;
      if (selectedParents.length > 1)
        L.labelBox2.append(el("div", { class: "hint" }, `under “${p.name}”`));
      for (const k of kids) L.labelBox2.append(lb(k, 2));
    }
    if (!any) L.labelBox2.append(el("div", { class: "hint" },
      L.sel[1].size ? "The selected label has no child labels — press Enter to confirm." : "Select a level-1 label first."));
  }
}

/* --------------------------------------------------------------- row view */
async function goTo(pos, { record = true } = {}) {
  if (pos == null) return;
  pos = Math.max(0, Math.min(pos, L.counts.total - 1));
  let payload;
  try { payload = await api.getRow(L.id, pos); }
  catch (e) { toast(e.message, 5000); return; }
  L.pos = pos;
  L.row = payload;
  L.counts = payload.counts;
  L.expanded = false;
  L.timer.startRow();

  // preload existing annotation into selection + comment
  L.sel = { 1: new Set(), 2: new Set() };
  const ann = payload.annotation;
  if (ann && ann.status === "labeled") {
    if (isHier()) {
      for (const n of (ann.levels?.["1"] || [])) L.sel[1].add(n);
      for (const n of (ann.levels?.["2"] || [])) L.sel[2].add(n);
    } else {
      for (const n of (ann.labels || [])) L.sel[1].add(n);
    }
  }
  L.comment = ann?.comment || "";
  if (L.commentBox) L.commentBox.value = L.comment;

  renderItem();
  renderLabelButtons();
  updateProgress();
  if (record) api.save(L.id, { current_pos: pos }).then(r => {
    L.saveState = { at: r.last_saved, err: false }; updateSaveBadge();
  }).catch(() => { L.saveState.err = true; updateSaveBadge(); });
}

function renderItem() {
  const r = L.row;
  const card = L.itemCard;
  card.innerHTML = "";
  const status = el("span", { class: `status-chip ${r.status}` },
    { labeled: "labeled", skipped: "skipped", unsure: "unsure", invalid: "invalid",
      discuss: "discuss", preexisting: "pre-existing", unlabeled: "unlabeled" }[r.status] || r.status);
  card.append(el("div", { class: "item-head" },
    el("span", { class: "rownum" }, `Row ${r.pos + 1} / ${L.counts.total}`),
    el("span", { class: "uid" }, `ID ${r.uid}`),
    status));

  const txt = el("div", { class: "item-text" }, r.text === "" ? "(empty)" : r.text);
  card.append(txt);
  requestAnimationFrame(() => {
    if (txt.scrollHeight > txt.clientHeight + 4) {
      txt.classList.add("clamped");
      const b = el("button", { class: "small ghost expand-btn" }, "Show full text ▾");
      b.addEventListener("click", () => {
        L.expanded = !L.expanded;
        txt.classList.toggle("expanded", L.expanded);
        txt.classList.toggle("clamped", !L.expanded);
        b.textContent = L.expanded ? "Collapse ▴" : "Show full text ▾";
      });
      card.insertBefore(b, txt.nextSibling);
    }
  });

  const ctxEntries = Object.entries(r.context || {});
  if (ctxEntries.length) {
    card.append(el("div", { class: "context-table" },
      ctxEntries.map(([k, v]) => el("div", { class: "ctx-row" },
        el("span", { class: "ctx-key" }, k), el("span", {}, v)))));
  }

  const ex = Object.entries(r.existing_output || {});
  if (ex.length) {
    card.append(el("div", { class: "alert " + (r.locked ? "warn" : "ok"), style: "margin-bottom:0" },
      r.locked
        ? "This row already has a value in an output column and editing existing values is disabled — it will be preserved unchanged."
        : "This row has an existing output value" + (L.meta.config.blind_mode ? " (hidden in blind mode)." : ": " +
          ex.map(([k, v]) => `${k} = “${v}”`).join(", "))));
  }
  if (r.annotation?.comment) {
    card.append(el("div", { class: "hint", style: "margin-top:8px" }, `Comment: ${r.annotation.comment}`));
  }
}

function updateProgress() {
  const c = L.counts;
  L.progressBar.style.width = `${c.pct_done}%`;
  L.progressNums.textContent =
    `${c.done} / ${c.total} done (${c.pct_done}%) · ${c.labeled} labeled · ${c.skipped} skipped · ${c.unsure} unsure`;
}

function renderDistribution() {
  if (!L.distPanel) return;
  const body = L.distPanel.querySelector("#dist-body");
  body.innerHTML = "";
  const entries = Object.entries(L.distribution || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { body.append(el("div", { class: "hint" }, "No labels applied yet.")); return; }
  const max = entries[0][1];
  for (const [name, n] of entries) {
    body.append(el("div", { class: "dist-row" },
      el("span", { style: "min-width:110px;overflow:hidden;text-overflow:ellipsis" }, name),
      el("span", { class: "dbar" }, el("div", { style: `width:${(100 * n / max).toFixed(1)}%` })),
      el("span", { class: "dnum" }, String(n))));
  }
}

function updateSaveBadge() {
  if (!L?.saveBadge) return;
  if (L.saveState.err) {
    L.saveBadge.className = "savebadge err";
    L.saveBadge.textContent = "⚠ save failed — use Save progress";
  } else {
    L.saveBadge.className = "savebadge";
    L.saveBadge.textContent = "saved " + (L.saveState.at ? new Date(L.saveState.at).toLocaleTimeString() : "—");
  }
}
function updateTimerChip(state) {
  if (!L?.timerChip) return;
  L.timerChip.textContent = (state === "active" ? "⏱ " : "⏸ ") + fmtDuration(L.timer.sessionSeconds());
  L.timerChip.classList.toggle("paused", state !== "active");
  L.timerChip.title = { active: "Session timer running — click to pause",
    paused: "Paused — click to resume", idle: "Idle — move the mouse or press a key",
    background: "Window inactive — timer paused" }[state];
  if (state === "paused" && !document.getElementById("pause-overlay")) showPauseOverlay();
  if (state !== "paused") document.getElementById("pause-overlay")?.remove();
}
function togglePause() { L.timer.togglePause(); }
function showPauseOverlay() {
  const ov = el("div", { class: "pause-overlay", id: "pause-overlay" },
    el("div", { class: "inner" },
      el("h2", {}, "Paused"),
      el("p", { class: "muted" }, "Labeling time is not being counted."),
      el("button", { class: "primary", onclick: () => L.timer.resume() }, "Resume session")));
  document.body.append(ov);
}

/* ------------------------------------------------------------- annotating */
function pickLabel(lab, level) {
  if (L.row.locked) return;
  const multi = isMulti(level);
  const set = L.sel[level];
  if (multi) {
    set.has(lab.name) ? set.delete(lab.name) : set.add(lab.name);
  } else {
    const had = set.has(lab.name);
    set.clear();
    if (!had) set.add(lab.name);
    if (level === 1 && isHier()) {
      // reset child selection when the parent changes
      const validKids = new Set(childrenOf(lab.id).map(k => k.name));
      L.sel[2] = new Set([...L.sel[2]].filter(n => validKids.has(n)));
    }
  }
  renderLabelButtons();

  // fast path: flat single-label → save & advance immediately
  if (!isHier() && !isMulti(1) && set.size === 1) { confirmSelection(); return; }
  // hierarchical single/single: auto-confirm when a child is chosen
  if (isHier() && level === 2 && !isMulti(2) && set.size === 1 && !isMulti(1)) { confirmSelection(); }
}

async function confirmSelection() {
  if (L.row.locked) { toast("This row is locked."); return; }
  const ann = { status: "labeled", comment: L.comment || "" };
  if (isHier()) {
    if (!L.sel[1].size) { toast("Select a level-1 label first."); return; }
    const selectedParents = parentLabels().filter(p => L.sel[1].has(p.name));
    const anyKids = selectedParents.some(p => childrenOf(p.id).length);
    if (anyKids && !L.sel[2].size) {
      const strict = selectedParents.every(p => childrenOf(p.id).length);
      if (strict) { toast("Select a child label (level 2), then confirm."); return; }
    }
    ann.levels = { "1": [...L.sel[1]], "2": [...L.sel[2]] };
    ann.labels = [...L.sel[1], ...L.sel[2]];
  } else {
    if (!L.sel[1].size) { toast("Select at least one label."); return; }
    ann.labels = [...L.sel[1]];
  }
  await submit(ann);
}

async function saveSpecial(status) {
  if (L.row.locked) { toast("This row is locked."); return; }
  await submit({ status, labels: [], levels: {}, comment: L.comment || "" });
}

async function submit(ann) {
  ann.duration_s = L.timer.takeRowSeconds();
  const uid = L.row.uid;
  L.undo.push({ uid, pos: L.pos, prev: L.row.annotation ? { ...L.row.annotation } : null });
  if (L.undo.length > 200) L.undo.shift();
  try {
    const res = await api.annotate(L.id, { uid, annotation: ann, current_pos: L.pos });
    L.counts = res.counts;
    L.distribution = res.distribution;
    L.saveState = { at: res.last_saved, err: false };
    updateSaveBadge(); updateProgress(); renderDistribution();
    if (L.commentBox) { L.commentBox.value = ""; L.comment = ""; }
    await nextUnlabeled();
  } catch (e) {
    L.undo.pop();
    L.saveState.err = true; updateSaveBadge();
    toast(e.message, 6000);
  }
}

async function undo() {
  const entry = L.undo.pop();
  if (!entry) { toast("Nothing to undo."); return; }
  try {
    const prev = entry.prev;
    if (prev) { delete prev.timestamp; }
    const res = await api.annotate(L.id, {
      uid: entry.uid,
      annotation: prev ? { labels: prev.labels, levels: prev.levels, status: prev.status,
        comment: prev.comment, duration_s: 0 } : null,
      current_pos: entry.pos,
    });
    L.counts = res.counts; L.distribution = res.distribution;
    L.saveState = { at: res.last_saved, err: false };
    toast("Annotation undone.");
    await goTo(entry.pos, { record: false });
  } catch (e) { toast(e.message, 5000); }
}

/* ------------------------------------------------------------- navigation */
async function nextUnlabeled() {
  let r = await api.next(L.id, L.pos, "unlabeled");
  if (r.pos === null) r = await api.next(L.id, -1, "unlabeled");
  if (r.pos === null) { toast("🎉 No unlabeled rows left."); updateProgress(); return; }
  await goTo(r.pos, { record: true });
}
async function nextFlagged() {
  let r = await api.next(L.id, L.pos, "skipped,unsure");
  if (r.pos === null) r = await api.next(L.id, -1, "skipped,unsure");
  if (r.pos === null) { toast("No skipped or unsure rows."); return; }
  await goTo(r.pos);
}
async function jumpTo(value) {
  const v = value.trim();
  if (!v) return;
  if (/^\d+$/.test(v)) {
    const n = parseInt(v, 10);
    if (n >= 1 && n <= L.counts.total) { await goTo(n - 1); return; }
  }
  try { const r = await api.byUid(L.id, v); await goTo(r.pos); }
  catch { toast(`No row number or ID “${v}”.`); }
}

/* --------------------------------------------------------- search / filter */
function openDrawer(title, loadPage) {
  document.querySelector(".drawer")?.remove();
  const body = el("div", { class: "body" });
  const drawer = el("div", { class: "drawer", role: "dialog" },
    el("header", {}, el("b", { style: "flex:1" }, title),
      el("button", { class: "ghost small", onclick: () => drawer.remove() }, "✕ Esc")),
    body);
  document.body.append(drawer);
  const renderItems = (items) => {
    for (const it of items) {
      const node = el("div", { class: "result-item", tabindex: "0" },
        el("div", { class: "r-meta" }, `row ${it.pos + 1}`, `ID ${it.uid}`, it.status),
        el("div", { class: "r-text" }, it.snippet || "(empty)"));
      const go = () => { drawer.remove(); goTo(it.pos); };
      node.addEventListener("click", go);
      node.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
      body.append(node);
    }
  };
  return { body, renderItems, drawer };
}

async function doSearch(q) {
  q = q.trim();
  if (!q) return;
  let results;
  try { results = await api.search(L.id, q); } catch (e) { toast(e.message); return; }
  const d = openDrawer(`Search “${q}” — ${results.length} match${results.length === 1 ? "" : "es"}${results.length >= 50 ? " (first 50)" : ""}`);
  if (!results.length) d.body.append(el("p", { class: "muted", style: "padding:10px" }, "No matching rows."));
  d.renderItems(results);
}

async function doFilter(status) {
  let page = 0;
  let res;
  try { res = await api.filter(L.id, status, page); } catch (e) { toast(e.message); return; }
  const nice = { unlabeled: "Unlabeled", labeled: "Labeled", skipped: "Skipped", unsure: "Unsure",
    invalid: "Invalid input", discuss: "Needs discussion", preexisting: "Pre-existing" }[status] || status;
  const d = openDrawer(`${nice} rows — ${res.total}`);
  const addPage = (r) => {
    d.renderItems(r.items);
    if ((r.page + 1) * r.page_size < r.total) {
      const more = el("button", { class: "small", style: "margin:8px" }, "Load more");
      more.addEventListener("click", async () => {
        more.remove();
        page++;
        const nr = await api.filter(L.id, status, page);
        addPage(nr);
      });
      d.body.append(more);
    }
  };
  if (!res.total) d.body.append(el("p", { class: "muted", style: "padding:10px" }, "No rows with this status."));
  addPage(res);
}

/* ----------------------------------------------------------------- saving */
async function saveNow() {
  try {
    const r = await api.save(L.id, { current_pos: L.pos });
    L.saveState = { at: r.last_saved, err: false };
    updateSaveBadge();
    toast("Progress saved.");
  } catch (e) {
    L.saveState.err = true; updateSaveBadge();
    toast("Saving failed: " + e.message, 6000);
  }
}

/* ------------------------------------------------------------------ modals */
async function showStats() {
  let s;
  try { s = await api.stats(L.id); } catch (e) { toast(e.message); return; }
  const line = (k, v) => el("p", { style: "margin:2px 0" }, el("b", {}, k + ": "), String(v));
  const distEntries = Object.entries(s.label_counts);
  modal("Statistics", [
    line("Total rows", s.total_rows),
    line("Labeled", `${s.labeled.count} (${s.labeled.pct}%)`),
    line("Unlabeled", `${s.unlabeled.count} (${s.unlabeled.pct}%)`),
    line("Skipped / Unsure / Invalid / Discuss", `${s.skipped} / ${s.unsure} / ${s.invalid} / ${s.needs_discussion}`),
    line("Active labeling time", fmtDuration(s.total_active_time_s)),
    line("Avg / median time per row", `${s.avg_time_per_row_s ?? "n/a"} s / ${s.median_time_per_row_s ?? "n/a"} s`),
    line("Sessions", s.n_sessions),
    el("h3", { style: "margin-top:14px" }, "Label counts"),
    distEntries.length
      ? el("div", {}, distEntries.map(([n, d]) => el("div", { class: "dist-row" },
          el("span", { style: "min-width:140px" }, n),
          el("span", { class: "dnum" }, `${d.count} (${d.pct}%)`))))
      : el("p", { class: "muted" }, "No labels applied yet."),
    el("h3", { style: "margin-top:14px" }, "Export report"),
    el("p", { class: "hint" }, "Writes a TXT report (and optionally JSON) into the project's exports folder."),
  ], (close) => [
    el("button", { onclick: () => exportStatsFiles(false, close) }, "Export TXT"),
    el("button", { class: "primary", onclick: () => exportStatsFiles(true, close) }, "Export TXT + JSON"),
  ]);
}

async function exportStatsFiles(withJson, close) {
  try {
    const files = await api.exportStats(L.id, { json: withJson });
    close();
    const links = [el("p", {}, "Saved in the project's exports folder:")];
    for (const [kind, fn] of Object.entries(files))
      links.push(el("p", {}, el("a", { href: `/api/projects/${L.id}/exports/${encodeURIComponent(fn)}` }, `⬇ ${fn}`)));
    modal("Statistics exported", links);
  } catch (e) { toast(e.message, 6000); }
}

function showExport() {
  const filename = el("input", { type: "text", value: "labeled.csv" });
  const scopeSel = el("select", {},
    el("option", { value: "all" }, "All rows (complete dataset)"),
    el("option", { value: "all_labeled" }, "Only rows with an annotation (any annotator)"),
    el("option", { value: "mine" }, "Only rows labeled by me (current annotator ID)"));
  const metaOpts = ["annotator_id", "annotation_timestamp", "annotation_duration_seconds",
    "annotation_status", "annotation_comment"];
  const metaChecks = metaOpts.map(mo => {
    const cb = el("input", { type: "checkbox" });
    return { name: mo, cb, node: el("label", { class: "check" }, cb, el("span", { class: "mono", style: "font-size:13px" }, mo)) };
  });

  const doExport = async (close, overwrite = false) => {
    const scope = scopeSel.value;
    const options = {
      filename: filename.value,
      overwrite,
      scope: scope === "mine" ? "mine" : "all",
      rows: scope === "all" ? "all" : "labeled_only",
      metadata_columns: metaChecks.filter(m => m.cb.checked).map(m => m.name),
    };
    try {
      const res = await api.exportCsv(L.id, options);
      close();
      modal("Export complete", [
        el("p", {}, `Wrote ${res.n_rows} rows (${res.n_annotated} annotated) as UTF-8 CSV, original row order preserved.`),
        el("p", {}, el("a", { href: `/api/projects/${L.id}/exports/${encodeURIComponent(res.filename)}` }, `⬇ Download ${res.filename}`)),
        el("p", { class: "hint" }, "The file is also in the project's exports folder on disk."),
      ]);
    } catch (e) {
      if (e.status === 409 && e.data?.exists) {
        if (window.confirm(`“${e.data.filename}” already exists in the exports folder. Overwrite it?`))
          await doExport(close, true);
      } else toast(e.message, 6000);
    }
  };

  modal("Export labeled CSV", [
    el("label", { class: "field" }, el("span", { class: "lbl" }, "File name"), filename),
    el("label", { class: "field" }, el("span", { class: "lbl" }, "Rows to export"), scopeSel),
    el("div", { class: "lbl" }, "Optional metadata columns"),
    ...metaChecks.map(m => m.node),
    el("p", { class: "hint", style: "margin-top:10px" },
      "All original columns and values are preserved (including hidden ones); only the selected output columns are added or updated. A stable row ID column is included."),
  ], (close) => [
    el("button", { onclick: close }, "Cancel"),
    el("button", { class: "primary", onclick: () => doExport(close) }, "Export CSV"),
  ]);
}

/* --------------------------------------------------------------- keyboard */
function onKey(e) {
  if (!L) return;
  const tag = document.activeElement?.tagName;
  const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  const mod = e.ctrlKey || e.metaKey;

  if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saveNow(); return; }
  if (mod && e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); undo(); return; }
  if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); document.getElementById("search-box")?.focus(); return; }
  if (e.key === "Escape") {
    document.querySelector(".drawer")?.remove();
    if (typing) document.activeElement.blur();
    return;
  }
  if (typing || mod) return;

  if (e.altKey) {
    const st = L.meta.config.special_states;
    const k = e.key.toLowerCase();
    if (k === "s" && st.skip) { e.preventDefault(); saveSpecial("skipped"); }
    if (k === "u" && st.unsure) { e.preventDefault(); saveSpecial("unsure"); }
    if (k === "i" && st.invalid) { e.preventDefault(); saveSpecial("invalid"); }
    if (k === "d" && st.discuss) { e.preventDefault(); saveSpecial("discuss"); }
    return;
  }

  switch (e.key) {
    case "ArrowLeft": e.preventDefault(); goTo(L.pos - 1); return;
    case "ArrowRight": e.preventDefault(); goTo(L.pos + 1); return;
    case ".": e.preventDefault(); nextUnlabeled(); return;
    case ",": e.preventDefault(); nextFlagged(); return;
    case "Enter":
      if (isMulti(1) || isHier()) { e.preventDefault(); confirmSelection(); }
      return;
  }

  // label shortcuts — level-2 keys win while a parent is selected
  const key = e.key.toLowerCase();
  if (isHier() && L.sel[1].size) {
    const selectedParents = parentLabels().filter(p => L.sel[1].has(p.name));
    for (const p of selectedParents) {
      const kid = childrenOf(p.id).find(k => k.shortcut === key);
      if (kid) { e.preventDefault(); pickLabel(kid, 2); return; }
    }
  }
  const lab = parentLabels().find(l => l.shortcut === key);
  if (lab) { e.preventDefault(); pickLabel(lab, 1); }
}
