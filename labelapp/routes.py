"""HTTP API. The server binds to 127.0.0.1 only — nothing is sent anywhere else."""
from __future__ import annotations

import json
import os
import tempfile
import threading

from flask import Blueprint, current_app, jsonify, request, send_from_directory

from . import csv_loader, exporter, persistence, projects, sharing, stats

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


@api.errorhandler(sharing.PackageError)
def _package_err(e):
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
    _drop_import_sidecar(tmp)  # imported package, started fresh
    with _lock:
        _open_projects[proj.state["id"]] = proj
    return jsonify({"id": proj.state["id"]})


# ------------------------------------------------------------- share/import
def _sidecar(tmp):
    return tmp + ".import.json"


def _drop_import_sidecar(tmp):
    try:
        os.unlink(_sidecar(tmp))
    except FileNotFoundError:
        pass


@api.post("/projects/<pid>/share")
def share_project(pid):
    """Write one .zip with CSV, config, labels (and optionally annotations)."""
    proj = _get_project(pid)
    d = request.get_json(silent=True) or {}
    try:
        result = sharing.build_package(proj, bool(d.get("include_annotations")))
    except sharing.PackageError as e:
        return _err(str(e), 500)
    return jsonify(result)


@api.post("/import/inspect")
def import_inspect():
    """Check an uploaded project package and stage its CSV like /csv/preview.

    The response prefills the setup wizard; temp_id works with the normal
    /csv/validate and POST /projects endpoints.
    """
    f = request.files.get("file")
    if not f or not f.filename:
        return _err("No file received. Choose a project .zip file first.")
    root = _root()
    fd, zpath = tempfile.mkstemp(suffix=".zip", dir=root)
    os.close(fd)
    try:
        f.save(zpath)
        manifest, csv_tmp, warnings = sharing.read_package(zpath, root)
    finally:
        os.unlink(zpath)

    try:
        df, info = csv_loader.load_dataframe(csv_tmp)
        labels = sharing.sanitize_labels(manifest.get("labels"))
    except Exception as e:
        os.unlink(csv_tmp)
        if isinstance(e, sharing.PackageError):
            raise
        return _err(f"Could not read the CSV inside the package: {e}")
    config = sharing.sanitize_config(manifest.get("config"))

    csv_meta = manifest.get("csv") if isinstance(manifest.get("csv"), dict) else {}
    info.filename = os.path.basename(sharing._s(csv_meta.get("filename"), 255)) or "data.csv"
    if csv_meta.get("columns") not in (None, info.columns):
        warnings.append("The CSV columns differ from the exported project. "
                        "Check the column choices before you start.")

    result = sharing.summary(manifest, info.to_dict(), labels, config, warnings)
    if result["includes_annotations"]:
        with open(_sidecar(csv_tmp), "w", encoding="utf-8") as fh:
            json.dump({
                "name": result["name"],
                "csv_filename": info.filename,
                "hash_ok": manifest.get("_csv_hash_ok", False),
                "config": config,
                "labels": labels,
                "annotations": manifest.get("annotations"),
                "sessions": manifest.get("sessions"),
                "current_pos": manifest.get("current_pos"),
            }, fh, ensure_ascii=False)
    result["temp_id"] = os.path.basename(csv_tmp)
    result["preview"] = csv_loader.preview(df)
    return jsonify(result)


@api.post("/import")
def import_with_annotations():
    """Create a project straight from a package, keeping its annotations."""
    d = request.get_json(force=True)
    root = _root()
    temp_id = os.path.basename(d.get("temp_id") or "")
    tmp = os.path.join(root, temp_id)
    if not temp_id or not os.path.exists(tmp) or not os.path.exists(_sidecar(tmp)):
        return _err("The imported package expired. Import the .zip file again.", 410)
    with open(_sidecar(tmp), encoding="utf-8") as fh:
        pkg = json.load(fh)
    if not pkg.get("hash_ok"):
        return _err("The CSV inside the package was changed after it was exported, so "
                    "its annotations can't be matched to rows safely. Choose "
                    "“Start fresh” instead.")

    df, info = csv_loader.load_dataframe(tmp)
    info.filename = pkg["csv_filename"]
    config, labels = pkg["config"], pkg["labels"]
    check = csv_loader.validate_csv(df, info, config)
    if check["errors"]:
        return jsonify({"error": "The imported setup does not fit its CSV: "
                        + " ".join(check["errors"]), "validation": check}), 400
    try:
        proj = projects.Project.create(
            root, (d.get("name") or "").strip() or pkg["name"],
            (d.get("annotator_id") or "").strip(), tmp, info.to_dict(), config, labels,
        )
        annotations, dropped = sharing.sanitize_annotations(
            pkg.get("annotations"), set(proj._uids))
        proj.state["annotations"] = annotations
        proj.state["sessions"] = sharing.sanitize_sessions(pkg.get("sessions"))
        pos = pkg.get("current_pos")
        if isinstance(pos, int) and 0 <= pos < len(proj._order):
            proj.state["current_pos"] = pos
        proj.save()
    except persistence.SaveError as e:
        return _err(str(e), 500)
    _drop_import_sidecar(tmp)
    with _lock:
        _open_projects[proj.state["id"]] = proj
    return jsonify({"id": proj.state["id"], "n_annotations": len(annotations),
                    "n_dropped": dropped})


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
