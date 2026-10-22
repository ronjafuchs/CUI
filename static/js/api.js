// Thin fetch wrapper. All requests go to the local server only.
async function req(method, url, body, isForm = false) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    if (isForm) { opts.body = body; }
    else { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  }
  let res;
  try { res = await fetch(url, opts); }
  catch { throw new Error("Could not reach the local server. Is run.py still running?"); }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const e = new Error((data && data.error) || `Request failed (${res.status})`);
    e.status = res.status; e.data = data;
    throw e;
  }
  return data;
}
export const api = {
  listProjects: () => req("GET", "/api/projects"),
  previewCsv: (file) => { const f = new FormData(); f.append("file", file); return req("POST", "/api/csv/preview", f, true); },
  validateCsv: (tempId, config) => req("POST", "/api/csv/validate", { temp_id: tempId, config }),
  createProject: (payload) => req("POST", "/api/projects", payload),
  openProject: (id) => req("GET", `/api/projects/${id}`),
  getRow: (id, pos) => req("GET", `/api/projects/${id}/row/${pos}`),
  next: (id, from, status, dir = 1) => req("GET", `/api/projects/${id}/next?from=${from}&status=${status}&dir=${dir}`),
  byUid: (id, uid) => req("GET", `/api/projects/${id}/uid/${encodeURIComponent(uid)}`),
  search: (id, q) => req("GET", `/api/projects/${id}/search?q=${encodeURIComponent(q)}`),
  filter: (id, status, page = 0) => req("GET", `/api/projects/${id}/filter?status=${encodeURIComponent(status)}&page=${page}`),
  annotate: (id, payload) => req("POST", `/api/projects/${id}/annotate`, payload),
  save: (id, payload = {}) => req("POST", `/api/projects/${id}/save`, payload),
  session: (id, payload) => req("POST", `/api/projects/${id}/session`, payload),
  exportCsv: (id, options) => req("POST", `/api/projects/${id}/export`, options),
  exportStats: (id, options) => req("POST", `/api/projects/${id}/export_stats`, options),
  stats: (id) => req("GET", `/api/projects/${id}/stats`),
  shareProject: (id, options) => req("POST", `/api/projects/${id}/share`, options),
  inspectPackage: (file) => { const f = new FormData(); f.append("file", file); return req("POST", "/api/import/inspect", f, true); },
  importWithAnnotations: (payload) => req("POST", "/api/import", payload),
};

export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    n.append(c.nodeType ? c : document.createTextNode(c));
  }
  return n;
}

let toastTimer;
export function toast(msg, ms = 2600) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

export function modal(title, bodyNodes, actions) {
  const backdrop = el("div", { class: "modal-backdrop" });
  const close = () => backdrop.remove();
  const box = el("div", { class: "modal", role: "dialog", "aria-label": title },
    el("h2", {}, title, el("button", { class: "ghost small", onclick: close, "aria-label": "Close" }, "✕")),
    ...bodyNodes,
    el("div", { class: "modal-actions" }, ...(actions ? actions(close) : [el("button", { onclick: close }, "Close")]))
  );
  backdrop.append(box);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  document.body.append(backdrop);
  return { close, box };
}

export function fmtDuration(totalSeconds) {
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}
export function fmtTime(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
