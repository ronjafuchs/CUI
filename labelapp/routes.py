"""HTTP API. The server binds to 127.0.0.1 only — nothing is sent anywhere else."""
from __future__ import annotations

import os
import tempfile
import threading

from flask import Blueprint, current_app, jsonify, request, send_from_directory

from . import csv_loader, exporter, persistence, projects, stats

api = Blueprint("api", __name__)

_open_projects = {}
_lock = threading.Lock()


def _root():
    return current_app.config["PROJECTS_ROOT"]


def _get_project(pid) -> projects.Project:
    with _lock:
        proj = _open_projects.get(pid)
        if proj is None:
            proj = projects.Project.open(_root(), pid)
            _open_projects[pid] = proj
        return proj


def _err(message, code=400):
    return jsonify({"error": message}), code


@api.errorhandler(projects.ProjectError)
def _project_err(e):
    return _err(str(e))


# ------------------------------------------------------------------ projects
@api.get("/projects")
def list_projects():
    return jsonify(persistence.list_projects(_root()))


@api.post("/csv/preview")
def csv_preview():
    """Accept an uploaded CSV, stash it in a temp file, return preview + info."""
    f = request.files.get("file")
    if not f or not f.filename:
        return _err("No file received. Choose a CSV file first.")
    fd, tmp = tempfile.mkstemp(suffix=".csv", dir=_root())
    os.close(fd)
    f.save(tmp)
    try:
        df, info = csv_loader.load_dataframe(tmp)
    except Exception as e:
        os.unlink(tmp)
        return _err(f"Could not read this file as a CSV: {e}")
    info.filename = f.filename
    return jsonify({
        "temp_id": os.path.basename(tmp),
        "info": info.to_dict(),
        "preview": csv_loader.preview(df),
    })


@api.post("/csv/validate")
def csv_validate():
    d = request.get_json(force=True)
    tmp = os.path.join(_root(), os.path.basename(d["temp_id"]))
    if not os.path.exists(tmp):
        return _err("The uploaded file expired. Upload the CSV again.", 410)
    df, info = csv_loader.load_dataframe(tmp)
    result = csv_loader.validate_csv(df, info, d.get("config", {}))
    return jsonify(result)


@api.post("/projects")
def create_project():
    d = request.get_json(force=True)
    tmp = os.path.join(_root(), os.path.basename(d["temp_id"]))
    if not os.path.exists(tmp):
        return _err("The uploaded file expired. Upload the CSV again.", 410)
    df, info = csv_loader.load_dataframe(tmp)
    info.filename = d.get("csv_filename", "data.csv")
    config = d.get("config", {})
    result = csv_loader.validate_csv(df, info, config)
    if result["errors"]:
        return jsonify({"error": "Validation failed.", "validation": result}), 400
    labels = d.get("labels", [])
    if not labels:
        return _err("Define at least one label before starting.")
    if len([l for l in labels if not l.get("parent")]) > 20 or len(labels) > 40:
        return _err("At most 20 labels per hierarchy level are supported.")
    try:
        proj = projects.Project.create(
            _root(), d.get("name") or "Untitled project",
            d.get("annotator_id", ""), tmp, info.to_dict(), config, labels,
        )
    except persistence.SaveError as e:
        return _err(str(e), 500)
    with _lock:
        _open_projects[proj.state["id"]] = proj
    return jsonify({"id": proj.state["id"]})


@api.get("/projects/<pid>")
def open_project(pid):
    try:
        proj = _get_project(pid)
    except FileNotFoundError:
        return _err("Project not found.", 404)
    except persistence.SaveError as e:
        return _err(str(e), 500)
    s = proj.state
    return jsonify({
        "id": s["id"], "name": s["name"], "annotator_id": s["annotator_id"],
        "config": s["config"], "labels": s["labels"],
        "csv": {k: v for k, v in s["csv"].items() if k != "sha256"},
        "counts": proj.counts(),
        "distribution": proj.label_distribution(),
        "current_pos": proj._resume_position(),
        "last_saved": s.get("last_saved"),
        "recovered_from": getattr(proj, "recovered_from", None),
        "csv_changed_warning": getattr(proj, "csv_changed_warning", None),
    })


# ---------------------------------------------------------------------- rows
@api.get("/projects/<pid>/row/<int:pos>")
def get_row(pid, pos):
    proj = _get_project(pid)
    payload = proj.row_payload(pos)
    payload["counts"] = proj.counts()
    return jsonify(payload)


@api.get("/projects/<pid>/next")
def get_next(pid):
    proj = _get_project(pid)
    frm = int(request.args.get("from", -1))
    want = request.args.get("status", "unlabeled")
    direction = int(request.args.get("dir", 1))
    p = proj.next_position(frm, want.split(","), direction)
    if p is None:
        return jsonify({"pos": None})
    return jsonify({"pos": p})


@api.get("/projects/<pid>/uid/<path:uid>")
def get_by_uid(pid, uid):
    proj = _get_project(pid)
    pos = proj.position_of_uid(uid)
    if pos is None:
        return _err(f"No row with ID \u201c{uid}\u201d.", 404)
    return jsonify({"pos": pos})


@api.get("/projects/<pid>/search")
def search(pid):
    proj = _get_project(pid)
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify([])
    return jsonify(proj.search(q))


@api.get("/projects/<pid>/filter")
def filter_rows(pid):
    proj = _get_project(pid)
    return jsonify(proj.filter_rows(
        request.args.get("status", ""),
        int(request.args.get("page", 0)),
        int(request.args.get("page_size", 50)),
    ))


# --------------------------------------------------------------- annotations
@api.post("/projects/<pid>/annotate")
def annotate(pid):
    proj = _get_project(pid)
    d = request.get_json(force=True)
    proj.set_annotation(d["uid"], d.get("annotation"))
    if "current_pos" in d:
        proj.state["current_pos"] = int(d["current_pos"])
    try:
        saved = proj.save()  # autosave after every annotation
    except persistence.SaveError as e:
        return _err(f"The annotation is in memory but saving to disk failed: {e}", 500)
    return jsonify({
        "ok": True, "last_saved": saved,
        "counts": proj.counts(),
        "distribution": proj.label_distribution(),
        "status": proj.row_status(d["uid"]),
    })


@api.post("/projects/<pid>/save")
def save_project(pid):
    proj = _get_project(pid)
    d = request.get_json(silent=True) or {}
    if "current_pos" in d:
        proj.state["current_pos"] = int(d["current_pos"])
    try:
        saved = proj.save()
    except persistence.SaveError as e:
        return _err(str(e), 500)
    return jsonify({"ok": True, "last_saved": saved})


@api.post("/projects/<pid>/session")
def session_event(pid):
    proj = _get_project(pid)
    d = request.get_json(force=True, silent=True) or {}
    proj.session_event(d.get("event", "heartbeat"), d.get("session_id", ""),
                       d.get("active_s", 0))
    proj.save()
    return jsonify({"ok": True})


# ------------------------------------------------------------------- exports
@api.post("/projects/<pid>/export")
def export_csv(pid):
    proj = _get_project(pid)
    d = request.get_json(force=True)
    try:
        result = exporter.export_csv(proj, d)
    except exporter.ExportError as e:
        msg = str(e)
        if msg.startswith("exists:"):
            return jsonify({"exists": True, "filename": msg.split(":", 1)[1]}), 409
        return _err(msg, 500)
    result.pop("path", None)
    return jsonify(result)


@api.post("/projects/<pid>/export_stats")
def export_stats(pid):
    proj = _get_project(pid)
    d = request.get_json(silent=True) or {}
    try:
        files = stats.export_stats(proj, fmt_json=bool(d.get("json")),
                                   filename=d.get("filename"))
    except OSError as e:
        return _err(f"Could not write the statistics report: {e}", 500)
    return jsonify(files)


@api.get("/projects/<pid>/stats")
def get_stats(pid):
    proj = _get_project(pid)
    return jsonify(stats.compute_stats(proj))


@api.get("/projects/<pid>/exports/<path:filename>")
def download_export(pid, filename):
    proj = _get_project(pid)
    return send_from_directory(os.path.join(proj.pdir, "exports"),
                               filename, as_attachment=True)
