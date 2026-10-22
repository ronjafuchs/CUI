// Project setup wizard.
import { api, el, toast } from "./api.js";

const PALETTE = ["#14685f", "#8a4f9e", "#b3542f", "#2a6f9e", "#9a7226",
  "#a3352c", "#3f7d3a", "#5b5ea6", "#7a5236", "#456570",
  "#c04f7c", "#2a8577", "#6d7d2e", "#845ec2", "#3d6b99",
  "#8c5a2b", "#527a52", "#9e4a4a", "#4a6d8c", "#6b6b6b"];
const KEYS = "1234567890qwertyuiopasdfghjklzxcvbnm".split("");

const STEPS = ["Project", "Data", "Columns", "Labels", "Behavior & start"];

function defaultWiz() {
  return {
    step: 0,
    name: "", annotator: "",
    tempId: null, csvFilename: "", csvInfo: null, preview: null,
    config: {
      text_column: "", id_column: "",
      context_columns: [], hidden_columns: [],
      blind_mode: false,
      task_type: "single",           // single | multi | hier_single | hier_multi
      child_multi: false,
      output_columns: ["label"],
      allow_edit_existing: false,
      unlabeled_detection: { empty: true, null: true, nan: true, whitespace: true },
      resume_mode: "last_visited", resume_row: 1,
      order: { mode: "original", seed: Math.floor(Math.random() * 1e6) },
      special_states: { unsure: true, skip: true, invalid: true, discuss: true, comment: true },
      show_distribution: false,
      idle_timeout_seconds: 90,
      multi_separator: "|",
    },
    labels: [],
    hierarchyOn: false,
  };
}

let wiz = defaultWiz();
let mount, onDone;

/** prefill: { pkg, source } from an imported project package (see importer.js) */
export function renderSetup(mountEl, onCreated, prefill = null) {
  mount = mountEl; onDone = onCreated;
  wiz = defaultWiz();
  if (prefill) applyPrefill(prefill);
  else { addLabel(null); addLabel(null); }
  draw();
}

function applyPrefill({ pkg, source }) {
  const base = wiz.config;
  const inc = pkg.config || {};
  wiz.config = {
    ...base, ...inc,
    unlabeled_detection: { ...base.unlabeled_detection, ...(inc.unlabeled_detection || {}) },
    special_states: { ...base.special_states, ...(inc.special_states || {}) },
    order: { ...base.order, ...(inc.order || {}) },
    context_columns: [...(inc.context_columns || [])],
    hidden_columns: [...(inc.hidden_columns || [])],
    output_columns: [...(inc.output_columns || base.output_columns)],
    // stored 0-based; the wizard shows and later converts a 1-based number
    resume_row: (parseInt(inc.resume_row, 10) || 0) + 1,
  };
  wiz.name = pkg.name;
  wiz.annotator = "";
  wiz.tempId = pkg.temp_id;
  wiz.csvFilename = pkg.info.filename;
  wiz.csvInfo = pkg.info;
  wiz.preview = pkg.preview;
  wiz.labels = pkg.labels.map(l => ({ ...l, parent: l.parent || null }));
  wiz.hierarchyOn = wiz.config.task_type.startsWith("hier");
  wiz.imported = { source, by: pkg.exported_by || "" };
}

function goToStep(i) {
  if (i > wiz.step) {
    for (let j = wiz.step; j < i; j++) {
      const err = checkStep(j);
      if (err) { wiz.step = j; draw(); toast(err); return; }
    }
  }
  wiz.step = i; draw();
}

// ---------------------------------------------------------------- labels
function nextShortcut() {
  const used = new Set(wiz.labels.map(l => l.shortcut));
  return KEYS.find(k => !used.has(k)) || "";
}
function addLabel(parentId) {
  const idx = wiz.labels.length;
  wiz.labels.push({
    id: `L${Date.now()}-${idx}`, name: "", definition: "", instructions: "",
    examples: "", color: PALETTE[idx % PALETTE.length],
    shortcut: nextShortcut(), parent: parentId,
  });
}

// ---------------------------------------------------------------- drawing
function draw() {
  mount.innerHTML = "";
  const pills = el("div", { class: "steps" },
    STEPS.map((s, i) => {
      const pill = el("span", {
        class: `step-pill ${i === wiz.step ? "active" : i < wiz.step ? "done" : ""}`,
        role: "button", tabindex: "0", title: `Go to step ${i + 1}`,
      }, `${i + 1} · ${s}`);
      pill.addEventListener("click", () => goToStep(i));
      pill.addEventListener("keydown", e => { if (e.key === "Enter") goToStep(i); });
      return pill;
    }));
  const importNote = wiz.imported ? el("div", { class: "alert ok", style: "margin-top:0" },
    `Imported from ${wiz.imported.source}` + (wiz.imported.by ? `, shared by ${wiz.imported.by}` : "") + ". ",
    "Everything is filled in: add your annotator ID in step 1, change labels in step 4 if you need to, then start from step 5.") : "";
  const body = el("div", {});
  [stepProject, stepData, stepColumns, stepLabels, stepBehavior][wiz.step](body);

  const nav = el("div", { class: "wizard-nav" },
    el("button", { onclick: back, disabled: wiz.step === 0 ? "" : null }, "← Back"),
    wiz.step < STEPS.length - 1
      ? el("button", { class: "primary", onclick: next }, "Continue →")
      : el("button", { class: "primary", onclick: validateAndCreate }, "Validate & start labeling"));

  mount.append(el("div", { class: "page" },
    el("h1", {}, wiz.imported ? "Imported labeling project" : "New labeling project"),
    pills, importNote, body, nav));
}
function back() { wiz.step = Math.max(0, wiz.step - 1); draw(); }
function next() {
  const err = checkStep(wiz.step);
  if (err) { toast(err); return; }
  wiz.step++; draw();
}

function checkStep(i) {
  const c = wiz.config;
  if (i === 0 && !wiz.name.trim()) return "Give the project a name.";
  if (i === 1 && !wiz.tempId) return "Upload a CSV file first.";
  if (i === 2 && !c.text_column) return "Select the column to label.";
  if (i === 3) {
    const parents = wiz.labels.filter(l => !l.parent && l.name.trim());
    if (!parents.length) return "Define at least one label.";
    if (parents.length > 20) return "At most 20 top-level labels.";
    const names = wiz.labels.filter(l => l.name.trim()).map(l => l.name.trim().toLowerCase());
    if (new Set(names).size !== names.length) return "Label names must be unique.";
    const keys = wiz.labels.filter(l => l.name.trim() && l.shortcut).map(l => l.shortcut);
    if (new Set(keys).size !== keys.length) return "Keyboard shortcuts must be unique.";
    if (wiz.hierarchyOn) {
      const withKids = parents.some(p => wiz.labels.some(l => l.parent === p.id && l.name.trim()));
      if (!withKids) return "Hierarchical mode is on but no child labels are defined.";
    }
  }
  return null;
}

// ------------------------------------------------------------- step screens
function stepProject(body) {
  body.append(el("div", { class: "card" },
    el("label", { class: "field" }, el("span", { class: "lbl" }, "Project name"),
      el("input", { type: "text", value: wiz.name, placeholder: "e.g. Support-ticket sentiment, round 1",
        oninput: e => wiz.name = e.target.value })),
    el("label", { class: "field" }, el("span", { class: "lbl" }, "Annotator ID (optional)"),
      el("input", { type: "text", value: wiz.annotator, placeholder: "e.g. anna-k",
        oninput: e => wiz.annotator = e.target.value }),
      el("div", { class: "hint" }, "Stored with every annotation and available as an export column."))
  ));
}

function stepData(body) {
  const card = el("div", { class: "card" });
  const fileInput = el("input", { type: "file", accept: ".csv,.tsv,.txt,text/csv" });
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files[0];
    if (!f) return;
    status.textContent = "Reading file…";
    try {
      const res = await api.previewCsv(f);
      wiz.tempId = res.temp_id;
      wiz.csvFilename = f.name;
      wiz.csvInfo = res.info;
      wiz.preview = res.preview;
      // sensible defaults
      if (!wiz.config.text_column) wiz.config.text_column = res.preview.columns[0] || "";
      draw();
    } catch (e) { status.textContent = ""; toast(e.message, 5000); }
  });
  const status = el("div", { class: "hint" });
  card.append(
    el("div", { class: "lbl" }, "CSV file"),
    fileInput, status,
    el("div", { class: "hint" },
      wiz.imported
        ? "This CSV came with the imported project. Choosing another file replaces it, and the shared column and label setup may no longer fit."
        : "The file is copied into the local project folder. It is never uploaded anywhere."));
  body.append(card);

  if (wiz.preview) {
    const info = wiz.csvInfo;
    body.append(el("div", { class: "card" },
      el("h2", {}, wiz.csvFilename),
      el("p", { class: "mono muted" },
        `${info.n_rows} rows · ${info.columns.length} columns · encoding ${info.encoding} · delimiter “${info.delimiter === "\t" ? "\\t" : info.delimiter}”`),
      previewTable(wiz.preview)));
  }
}

function previewTable(p, limitCols = 40) {
  const cols = p.columns.slice(0, limitCols);
  return el("div", { class: "preview-wrap" },
    el("table", { class: "preview" },
      el("thead", {}, el("tr", {}, cols.map(c => el("th", {}, c)))),
      el("tbody", {}, p.rows.map(r =>
        el("tr", {}, cols.map((c, i) => el("td", { title: r[i] }, String(r[i] ?? ""))))))));
}

function colSelect(value, onchange, { allowNone = false, noneLabel = "— none —" } = {}) {
  const s = el("select", { onchange: e => onchange(e.target.value) });
  if (allowNone) s.append(el("option", { value: "" }, noneLabel));
  for (const c of wiz.csvInfo.columns)
    s.append(el("option", { value: c, selected: c === value ? "" : null }, c));
  if (allowNone && !value) s.value = "";
  return s;
}

function colChecklist(selected, ontoggle, disabledCols = new Set()) {
  return el("div", { class: "col-picker" },
    wiz.csvInfo.columns.map(c => {
      const cb = el("input", { type: "checkbox" });
      cb.checked = selected.includes(c);
      if (disabledCols.has(c)) cb.disabled = true;
      cb.addEventListener("change", () => ontoggle(c, cb.checked));
      return el("label", { class: "check" }, cb, el("span", {}, c));
    }));
}

function stepColumns(body) {
  const c = wiz.config;
  body.append(el("div", { class: "card" },
    el("h2", {}, "What gets labeled"),
    el("label", { class: "field" }, el("span", { class: "lbl" }, "Input column (the text or value to annotate)"),
      colSelect(c.text_column, v => { c.text_column = v; draw(); })),
    el("label", { class: "field" }, el("span", { class: "lbl" }, "Unique row ID column (optional)"),
      colSelect(c.id_column, v => c.id_column = v, { allowNone: true, noneLabel: "— generate stable row IDs automatically —" }),
      el("div", { class: "hint" }, "Annotations are attached to this ID, not to the row position."))));

  body.append(el("div", { class: "card" },
    el("h2", {}, "Context columns"),
    el("p", { class: "hint" }, "Shown next to the input during labeling."),
    colChecklist(c.context_columns, (col, on) => {
      c.context_columns = on ? [...c.context_columns, col] : c.context_columns.filter(x => x !== col);
    }, new Set([c.text_column]))));

  body.append(el("div", { class: "card" },
    el("h2", {}, "Hidden columns"),
    el("p", { class: "hint" }, "Never displayed during labeling, but preserved unchanged in every export."),
    colChecklist(c.hidden_columns, (col, on) => {
      c.hidden_columns = on ? [...c.hidden_columns, col] : c.hidden_columns.filter(x => x !== col);
    }, new Set([c.text_column])),
    el("label", { class: "check", style: "margin-top:12px" },
      checkbox(c.blind_mode, v => c.blind_mode = v),
      el("span", {}, el("b", {}, "Blind annotation mode"), " — additionally hide the values of all output/label columns, ",
        "so existing annotations from other annotators are preserved without being visible."))));
}

function checkbox(value, onchange) {
  const cb = el("input", { type: "checkbox" });
  cb.checked = !!value;
  cb.addEventListener("change", () => onchange(cb.checked));
  return cb;
}

function stepLabels(body) {
  const c = wiz.config;

  // task type
  const taskCard = el("div", { class: "card" }, el("h2", {}, "Task type"));
  const radios = [
    ["single", "Single-label — exactly one label per row"],
    ["multi", "Multi-label — any number of labels per row"],
  ];
  for (const [val, text] of radios) {
    const r = el("input", { type: "radio", name: "tasktype" });
    r.checked = c.task_type.replace("hier_", "") === val;
    r.addEventListener("change", () => {
      c.task_type = wiz.hierarchyOn ? `hier_${val}` : val;
      draw();
    });
    taskCard.append(el("label", { class: "check" }, r, el("span", {}, text)));
  }
  taskCard.append(
    el("label", { class: "check", style: "margin-top:10px;border-top:1px dashed var(--line);padding-top:10px" },
      checkbox(wiz.hierarchyOn, v => {
        wiz.hierarchyOn = v;
        const base = c.task_type.replace("hier_", "");
        c.task_type = v ? `hier_${base}` : base;
        draw();
      }),
      el("span", {}, el("b", {}, "Hierarchical labels"), " — child labels appear after their parent is selected. Each level is exported to its own column.")));
  if (wiz.hierarchyOn) {
    taskCard.append(el("label", { class: "check" },
      checkbox(c.child_multi, v => c.child_multi = v),
      el("span", {}, "Allow selecting several child labels under the chosen parent")));
  }
  body.append(taskCard);

  // label editor
  const edCard = el("div", { class: "card" },
    el("h2", {}, "Labels"),
    el("p", { class: "hint" }, "Up to 20 top-level labels. Give each a one-key shortcut."));
  const parents = wiz.labels.filter(l => !l.parent);
  for (const p of parents) {
    edCard.append(labelRow(p));
    if (wiz.hierarchyOn) {
      const kids = wiz.labels.filter(l => l.parent === p.id);
      const block = el("div", { class: "child-block" });
      for (const k of kids) block.append(labelRow(k));
      block.append(el("button", { class: "small ghost", onclick: () => { addLabel(p.id); draw(); } },
        `+ child label under “${p.name || "…"}”`));
      edCard.append(block);
    }
  }
  edCard.append(el("div", { style: "margin-top:10px" },
    el("button", {
      class: "small",
      onclick: () => {
        if (parents.length >= 20) { toast("At most 20 top-level labels."); return; }
        addLabel(null); draw();
      }
    }, "+ Add label")));
  body.append(edCard);

  // special states
  const st = c.special_states;
  body.append(el("div", { class: "card" },
    el("h2", {}, "Special annotation states"),
    el("label", { class: "check" }, checkbox(st.unsure, v => st.unsure = v), el("span", {}, "Unsure — label applied with low confidence, row flagged for review")),
    el("label", { class: "check" }, checkbox(st.skip, v => st.skip = v), el("span", {}, "Skip — move on without labeling")),
    el("label", { class: "check" }, checkbox(st.invalid, v => st.invalid = v), el("span", {}, "Invalid input — the row cannot be labeled (garbage, wrong language, …)")),
    el("label", { class: "check" }, checkbox(st.discuss, v => st.discuss = v), el("span", {}, "Needs discussion — flag for the team")),
    el("label", { class: "check" }, checkbox(st.comment, v => st.comment = v), el("span", {}, "Free-text comment field on every row"))));
}

function labelRow(lab) {
  const row = el("div", { class: "label-row" });
  row.append(
    el("span", { class: "grip", title: lab.parent ? "child label" : "label" }, lab.parent ? "└" : "●"),
    el("input", { type: "text", placeholder: "Name", value: lab.name, oninput: e => lab.name = e.target.value }),
    el("input", { type: "text", placeholder: "Short definition", value: lab.definition, oninput: e => lab.definition = e.target.value }),
    el("input", {
      type: "text", placeholder: "Key", value: lab.shortcut, maxlength: "1", title: "Keyboard shortcut",
      oninput: e => lab.shortcut = e.target.value.toLowerCase()
    }),
    el("input", { type: "color", value: lab.color, title: "Colour", oninput: e => lab.color = e.target.value }),
    el("button", {
      class: "ghost small", title: "Remove label", onclick: () => {
        wiz.labels = wiz.labels.filter(l => l !== lab && l.parent !== lab.id);
        draw();
      }
    }, "✕"),
    el("details", { class: "label-more" },
      el("summary", {}, "Instructions & examples (optional)"),
      el("textarea", { placeholder: "Detailed instructions", oninput: e => lab.instructions = e.target.value }, lab.instructions || ""),
      el("textarea", { placeholder: "Examples, one per line", oninput: e => lab.examples = e.target.value }, lab.examples || "")));
  return row;
}

function stepBehavior(body) {
  const c = wiz.config;
  const hier = wiz.hierarchyOn;

  // output columns
  const outCard = el("div", { class: "card" }, el("h2", {}, "Output column" + (hier ? "s" : "")));
  if (hier) {
    outCard.append(el("p", { class: "hint" }, "One column per hierarchy level."));
    if (c.output_columns.length < 2) c.output_columns = ["label_level1", "label_level2"];
    c.output_columns.forEach((col, i) => {
      outCard.append(el("label", { class: "field" },
        el("span", { class: "lbl" }, `Level ${i + 1} column`),
        el("input", { type: "text", value: col, oninput: e => c.output_columns[i] = e.target.value.trim() })));
    });
  } else {
    if (c.output_columns.length !== 1) c.output_columns = [c.output_columns[0] || "label"];
    outCard.append(el("label", { class: "field" },
      el("span", { class: "lbl" }, "Column where annotations are stored"),
      el("input", { type: "text", value: c.output_columns[0], oninput: e => c.output_columns[0] = e.target.value.trim() }),
      el("div", { class: "hint" }, "Type a new column name, or the name of an existing column to update it.")));
  }
  outCard.append(el("label", { class: "check" },
    checkbox(c.allow_edit_existing, v => c.allow_edit_existing = v),
    el("span", {}, "Existing values in output columns may be edited (otherwise those rows are locked and preserved unchanged)")));
  body.append(outCard);

  // unlabeled detection
  const d = c.unlabeled_detection;
  body.append(el("div", { class: "card" },
    el("h2", {}, "How to detect unlabeled rows"),
    el("p", { class: "hint" }, "A row counts as unlabeled when its output cell matches any checked rule."),
    el("label", { class: "check" }, checkbox(d.empty, v => d.empty = v), el("span", {}, "Empty string")),
    el("label", { class: "check" }, checkbox(d.null, v => d.null = v), el("span", {}, "Null / None values")),
    el("label", { class: "check" }, checkbox(d.nan, v => d.nan = v), el("span", {}, "NaN / N/A text values")),
    el("label", { class: "check" }, checkbox(d.whitespace, v => d.whitespace = v), el("span", {}, "Whitespace-only strings"))));

  // resume + order
  const resumeCard = el("div", { class: "card" }, el("h2", {}, "Starting position & row order"));
  const resumeSel = el("select", {
    onchange: e => { c.resume_mode = e.target.value; draw(); }
  },
    el("option", { value: "last_visited" }, "Resume at the last visited row"),
    el("option", { value: "first_unlabeled" }, "Start at the first unlabeled row"),
    el("option", { value: "manual" }, "Start at a specific row number"));
  resumeSel.value = c.resume_mode;
  resumeCard.append(el("label", { class: "field" }, el("span", { class: "lbl" }, "When the project opens"), resumeSel));
  if (c.resume_mode === "manual") {
    resumeCard.append(el("label", { class: "field" }, el("span", { class: "lbl" }, "Row number (1-based, in display order)"),
      el("input", { type: "number", min: "1", value: c.resume_row, oninput: e => c.resume_row = e.target.value })));
  }
  const orderSel = el("select", { onchange: e => { c.order.mode = e.target.value; draw(); } },
    el("option", { value: "original" }, "Original CSV order"),
    el("option", { value: "random" }, "Randomised order (reproducible)"));
  orderSel.value = c.order.mode;
  resumeCard.append(el("label", { class: "field" }, el("span", { class: "lbl" }, "Row display order"), orderSel));
  if (c.order.mode === "random") {
    resumeCard.append(el("label", { class: "field" }, el("span", { class: "lbl" }, "Random seed"),
      el("input", { type: "number", value: c.order.seed, oninput: e => c.order.seed = parseInt(e.target.value || "0", 10) }),
      el("div", { class: "hint" }, "The same seed always produces the same order. Exports keep the original order.")));
  }
  body.append(resumeCard);

  // misc
  body.append(el("div", { class: "card" },
    el("h2", {}, "During annotation"),
    el("label", { class: "check" },
      checkbox(c.show_distribution, v => c.show_distribution = v),
      el("span", {}, "Show live label-distribution statistics ", el("span", { class: "muted" }, "(off by default — seeing the distribution can bias labeling decisions)"))),
    el("label", { class: "field", style: "max-width:280px;margin-top:10px" },
      el("span", { class: "lbl" }, "Idle timeout (seconds)"),
      el("input", { type: "number", min: "10", value: c.idle_timeout_seconds, oninput: e => c.idle_timeout_seconds = parseInt(e.target.value || "90", 10) }),
      el("div", { class: "hint" }, "After this much inactivity the timer pauses; idle time never counts as labeling time."))));

  body.append(el("div", { id: "validation-out" }));
}

// -------------------------------------------------------------- validation
function cleanLabels() {
  const named = wiz.labels.filter(l => l.name.trim());
  const parentIds = new Set(named.filter(l => !l.parent).map(l => l.id));
  return named
    .filter(l => !l.parent || parentIds.has(l.parent))
    .map(l => ({ ...l, name: l.name.trim() }));
}

async function validateAndCreate() {
  for (let i = 0; i <= 3; i++) { const e = checkStep(i); if (e) { toast(e); return; } }
  const c = wiz.config;
  c.output_columns = c.output_columns.map(x => x.trim()).filter(Boolean);
  if (!c.output_columns.length) { toast("Name the output column."); return; }
  if (wiz.hierarchyOn && c.output_columns.length < 2) { toast("Hierarchical projects need one output column per level."); return; }
  if (new Set(c.output_columns).size !== c.output_columns.length) { toast("Output column names must be unique."); return; }
  c.context_columns = c.context_columns.filter(x => x !== c.text_column);
  if (c.resume_mode === "manual") c.resume_row = Math.max(0, parseInt(c.resume_row, 10) - 1 || 0);

  const out = document.getElementById("validation-out");
  out.innerHTML = "";
  let result;
  try { result = await api.validateCsv(wiz.tempId, c); }
  catch (e) { toast(e.message, 5000); return; }

  for (const err of result.errors) out.append(el("div", { class: "alert error" }, err));
  for (const w of result.warnings) out.append(el("div", { class: "alert warn" }, w));
  if (result.errors.length) { out.scrollIntoView({ behavior: "smooth" }); return; }

  const proceed = async () => {
    try {
      const res = await api.createProject({
        temp_id: wiz.tempId, name: wiz.name.trim(), annotator_id: wiz.annotator.trim(),
        csv_filename: wiz.csvFilename, config: c, labels: cleanLabels(),
      });
      onDone(res.id);
    } catch (e) { toast(e.message, 6000); }
  };
  if (result.warnings.length) {
    out.append(el("div", { class: "alert ok" }, "No blocking problems. Review the warnings above, then start."),
      el("button", { class: "primary", onclick: proceed }, "Start labeling anyway"));
    out.scrollIntoView({ behavior: "smooth" });
  } else {
    await proceed();
  }
}
