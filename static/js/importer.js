// Import a project package (.zip made with "Share project").
import { api, el, toast, modal, fmtTime } from "./api.js";

const TASK_NAMES = {
  single: "Single-label", multi: "Multi-label",
  hier_single: "Hierarchical, single-label", hier_multi: "Hierarchical, multi-label",
};

/** The "Import project" card for the start screen.
 *  onReview(pkg, zipName)  open the setup wizard prefilled from the package
 *  onImported(result)      a project was created with its annotations kept */
export function importCard({ onReview, onImported }) {
  const input = el("input", { type: "file", accept: ".zip,application/zip", style: "display:none" });
  const hint = el("div", { class: "hint" }, "Open a project .zip someone shared with you");
  const card = el("div", {
    class: "card project-card", tabindex: "0", role: "button",
    style: "display:grid;place-items:center;min-height:120px;border-style:dashed"
  }, el("div", { style: "text-align:center" },
    el("div", { style: "font-size:22px;line-height:40px;color:var(--teal)" }, "⇪"),
    el("b", {}, "Import project"),
    hint), input);

  const pick = () => input.click();
  card.addEventListener("click", e => { if (e.target !== input) pick(); });
  card.addEventListener("keydown", e => { if (e.key === "Enter") pick(); });
  input.addEventListener("change", async () => {
    const f = input.files[0];
    input.value = "";
    if (!f) return;
    const before = hint.textContent;
    hint.textContent = `Reading ${f.name}…`;
    let pkg;
    try { pkg = await api.inspectPackage(f); }
    catch (e) { toast(e.message, 7000); return; }
    finally { hint.textContent = before; }
    showImportDialog(pkg, f.name, { onReview, onImported });
  });
  return card;
}

function field(label, input, hintText) {
  return el("label", { class: "field" }, el("span", { class: "lbl" }, label), input,
    hintText ? el("div", { class: "hint" }, hintText) : "");
}

function showImportDialog(pkg, zipName, { onReview, onImported }) {
  const info = pkg.info;
  const top = pkg.labels.filter(l => !l.parent);
  const nKids = pkg.labels.length - top.length;
  const shownNames = top.slice(0, 8).map(l => l.name).join(", ") + (top.length > 8 ? ", …" : "");

  const body = [
    el("h3", { style: "margin-bottom:2px" }, pkg.name),
    el("p", { class: "muted", style: "margin-top:0;font-size:13px" },
      (pkg.exported_by ? `Shared by ${pkg.exported_by}` : "Shared") +
      (pkg.exported_at ? ` · ${fmtTime(pkg.exported_at)}` : "")),
    el("p", { class: "mono", style: "font-size:12.5px;margin-bottom:4px" },
      `${info.filename} · ${info.n_rows} rows · ${info.columns.length} columns`),
    el("p", {},
      `${TASK_NAMES[pkg.config.task_type] || pkg.config.task_type} · ${top.length} label${top.length === 1 ? "" : "s"}` +
      (nKids ? ` + ${nKids} child label${nKids === 1 ? "" : "s"}` : "") + ": ",
      el("span", { class: "muted" }, shownNames)),
    ...pkg.warnings.map(w => el("div", { class: "alert warn" }, w)),
  ];

  let mode = "fresh";
  const go = el("button", { class: "primary" }, "Review setup →");
  const nameIn = el("input", { type: "text", value: pkg.name });
  const annIn = el("input", { type: "text", placeholder: "e.g. anna-k" });
  const keepFields = el("div", { class: "hidden", style: "margin-top:12px" },
    field("Project name", nameIn),
    field("Your annotator ID (optional)", annIn,
      pkg.exported_by
        ? `Existing annotations keep their annotator (${pkg.exported_by}); new ones get this ID.`
        : "Stored with every annotation you add."));

  if (pkg.includes_annotations) {
    const radio = (value, checked, disabled, title, text) => {
      const r = el("input", { type: "radio", name: "import-mode" });
      r.checked = checked;
      r.disabled = disabled;
      r.addEventListener("change", () => {
        mode = value;
        keepFields.classList.toggle("hidden", mode !== "keep");
        go.textContent = mode === "keep" ? "Import project" : "Review setup →";
      });
      return el("label", { class: "check" }, r,
        el("span", {}, el("b", {}, title), el("span", { class: "hint", style: "display:block" }, text)));
    };
    body.push(
      el("div", { class: "lbl", style: "margin-top:14px" }, `This package includes ${pkg.n_annotations} annotations`),
      radio("fresh", true, false, "Start fresh",
        "Import the CSV, labels and settings only. You can review and change everything, including the labels, before you start."),
      radio("keep", false, !pkg.csv_unchanged, `Keep the ${pkg.n_annotations} annotations`,
        pkg.csv_unchanged
          ? "Continue the project as it is. Labels and settings stay unchanged so the annotations still fit."
          : "Not available: the CSV was changed after export, so annotations can't be matched to rows safely."),
      keepFields);
  } else {
    body.push(el("p", { class: "hint", style: "margin-top:12px" },
      "The setup wizard opens with everything filled in. Add your annotator ID, change the labels if you need to, then start."));
  }

  modal("Import project", body, (close) => {
    go.addEventListener("click", async () => {
      if (mode === "fresh") { close(); onReview(pkg, zipName); return; }
      go.disabled = true;
      try {
        const res = await api.importWithAnnotations({
          temp_id: pkg.temp_id, name: nameIn.value.trim(), annotator_id: annIn.value.trim(),
        });
        close();
        onImported(res);
      } catch (e) { go.disabled = false; toast(e.message, 7000); }
    });
    return [el("button", { onclick: close }, "Cancel"), go];
  });
}
