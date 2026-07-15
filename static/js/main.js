import { api, el, toast, fmtTime } from "./api.js";
import { renderSetup } from "./setup.js";
import { renderLabeling, destroy as destroyLabeling } from "./labeling.js";

const screen = document.getElementById("screen");
document.getElementById("brand").addEventListener("click", goHome);

function clear() {
  destroyLabeling();
  document.getElementById("topbar-slot").innerHTML = "";
  screen.innerHTML = "";
}

async function goHome() {
  clear();
  const page = el("div", { class: "page" });
  screen.append(page);
  page.append(el("h1", {}, "Labeling projects"));

  let projects = [];
  try { projects = await api.listProjects(); }
  catch (e) { page.append(el("div", { class: "alert error" }, e.message)); return; }

  const grid = el("div", { class: "project-grid" });
  const newCard = el("div", {
    class: "card project-card", tabindex: "0", role: "button",
    style: "display:grid;place-items:center;min-height:120px;border-style:dashed"
  }, el("div", { style: "text-align:center" },
    el("div", { style: "font-size:26px;color:var(--teal)" }, "+"),
    el("b", {}, "New project"),
    el("div", { class: "hint" }, "Upload a CSV and configure labels")));
  const openSetup = () => { clear(); renderSetup(screen, (id) => openProject(id)); };
  newCard.addEventListener("click", openSetup);
  newCard.addEventListener("keydown", e => { if (e.key === "Enter") openSetup(); });
  grid.append(newCard);

  for (const p of projects) {
    if (p.corrupt) {
      grid.append(el("div", { class: "card project-card" },
        el("h3", {}, p.name),
        el("div", { class: "alert error", style: "margin:6px 0 0" },
          "Project file and backups are unreadable.")));
      continue;
    }
    const pct = p.n_rows ? Math.round(100 * p.n_annotated / p.n_rows) : 0;
    const card = el("div", { class: "card project-card", tabindex: "0", role: "button" },
      el("h3", {}, p.name),
      el("div", { class: "project-meta" },
        `${p.n_annotated} / ${p.n_rows} annotated`,
        p.annotator_id ? ` · ${p.annotator_id}` : ""),
      el("div", { class: "project-meta" }, `last saved ${fmtTime(p.last_saved)}`),
      p.recovered_from ? el("div", { class: "alert warn", style: "margin:8px 0 0;padding:6px 9px;font-size:12px" },
        `Main save file was unreadable — recovered from ${p.recovered_from}.`) : "",
      el("div", { class: "minibar" }, el("div", { style: `width:${pct}%` })));
    const open = () => openProject(p.id);
    card.addEventListener("click", open);
    card.addEventListener("keydown", e => { if (e.key === "Enter") open(); });
    grid.append(card);
  }
  page.append(grid,
    el("p", { class: "hint", style: "margin-top:18px" },
      "Everything is stored in the local “projects” folder next to run.py. No CSV content or annotation ever leaves this machine."));
}

async function openProject(id) {
  clear();
  screen.append(el("div", { class: "page" }, el("p", { class: "muted" }, "Loading project…")));
  try {
    await renderLabeling(screen, id, goHome);
  } catch (e) {
    clear();
    screen.append(el("div", { class: "page" },
      el("div", { class: "alert error" }, e.message),
      el("button", { onclick: goHome }, "← Back to projects")));
  }
}

goHome();
