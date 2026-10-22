"""Share a project as one .zip file and import it on another machine.

Package layout (format version 1):

    labeler-project.json   name, CSV metadata, column config, labels,
                           optionally annotations + sessions
    data.csv               byte-exact copy of the project's CSV

The package is treated as untrusted input on import: it is never extracted
with extractall, member sizes are capped, the CSV hash is checked, and every
label / config / annotation field is re-validated and type-coerced.
"""
from __future__ import annotations

import copy
import datetime
import json
import os
import posixpath
import re
import tempfile
import zipfile

from . import csv_loader, projects

FORMAT = "csv-labeler-project"
FORMAT_VERSION = 1
MANIFEST_NAME = "labeler-project.json"
CSV_NAME = "data.csv"

MAX_MANIFEST_BYTES = 64 * 1024 * 1024
MAX_CSV_BYTES = 1024 * 1024 * 1024

PALETTE = ["#14685f", "#8a4f9e", "#b3542f", "#2a6f9e", "#9a7226",
           "#a3352c", "#3f7d3a", "#5b5ea6", "#7a5236", "#456570"]
HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")

# Mirrors defaultWiz().config in static/js/setup.js.
DEFAULT_CONFIG = {
    "text_column": "",
    "id_column": "",
    "context_columns": [],
    "hidden_columns": [],
    "blind_mode": False,
    "task_type": "single",
    "child_multi": False,
    "output_columns": ["label"],
    "allow_edit_existing": False,
    "unlabeled_detection": {"empty": True, "null": True, "nan": True, "whitespace": True},
    "resume_mode": "last_visited",
    "resume_row": 0,
    "order": {"mode": "original", "seed": 0},
    "special_states": {"unsure": True, "skip": True, "invalid": True,
                       "discuss": True, "comment": True},
    "show_distribution": False,
    "idle_timeout_seconds": 90,
    "multi_separator": "|",
}
TASK_TYPES = ("single", "multi", "hier_single", "hier_multi")
RESUME_MODES = ("last_visited", "first_unlabeled", "manual")
ORDER_MODES = ("original", "random")


class PackageError(Exception):
    pass


# ------------------------------------------------------------------- export
def build_package(project, include_annotations=False) -> dict:
    """Write <project-id>-project-<stamp>.zip into the exports folder."""
    state = project.state
    csv_path = project.csv_path
    csv_meta = dict(state["csv"])
    # Hash what is actually packed (the stored hash can be stale if the
    # file was edited in place without changing rows/columns).
    csv_meta["sha256"] = csv_loader.file_sha256(csv_path)

    manifest = {
        "format": FORMAT,
        "format_version": FORMAT_VERSION,
        "exported_at": projects.now_iso(),
        "exported_by": state.get("annotator_id", ""),
        "source_project_id": state["id"],
        "name": state["name"],
        "csv": csv_meta,
        "config": state["config"],
        "labels": state["labels"],
        "includes_annotations": bool(include_annotations),
    }
    n_ann = 0
    if include_annotations:
        manifest["annotations"] = state["annotations"]
        manifest["sessions"] = state.get("sessions", [])
        manifest["current_pos"] = state.get("current_pos", 0)
        n_ann = len(state["annotations"])

    exp_dir = os.path.join(project.pdir, "exports")
    os.makedirs(exp_dir, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    filename = f"{state['id']}-project-{stamp}.zip"
    path = os.path.join(exp_dir, filename)

    fd, tmp = tempfile.mkstemp(dir=exp_dir, prefix=".share-", suffix=".tmp")
    os.close(fd)
    try:
        with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(MANIFEST_NAME, json.dumps(manifest, ensure_ascii=False, indent=1))
            zf.write(csv_path, CSV_NAME)
        os.replace(tmp, path)
    except OSError as e:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise PackageError(f"Could not write the project package: {e}") from e

    return {"filename": filename, "n_annotations": n_ann,
            "size_bytes": os.path.getsize(path)}


# ------------------------------------------------------------------- import
def _find_member(zf, name):
    """The single member called `name`, at the top level or one folder down
    (some zip tools re-wrap files in a folder)."""
    hits = []
    for info in zf.infolist():
        n = info.filename
        if info.is_dir() or n.startswith("__MACOSX/"):
            continue
        parts = posixpath.normpath(n).split("/")
        if parts[-1] == name and len(parts) <= 2 and ".." not in parts:
            hits.append(info)
    if not hits:
        raise PackageError(f"This is not a project package: {name} is missing.")
    if len(hits) > 1:
        raise PackageError(f"The package contains more than one {name}.")
    return hits[0]


def _copy_limited(src, dst_path, limit):
    total = 0
    with open(dst_path, "wb") as out:
        while True:
            chunk = src.read(1 << 20)
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                raise PackageError("The CSV inside the package is too large.")
            out.write(chunk)


def read_package(zip_path, work_dir):
    """Validate a package and extract its CSV into work_dir.

    Returns (manifest, csv_tmp_path, warnings). On error nothing is left behind.
    """
    if not zipfile.is_zipfile(zip_path):
        raise PackageError("This file is not a .zip project package.")
    csv_tmp = None
    try:
        with zipfile.ZipFile(zip_path) as zf:
            m_info = _find_member(zf, MANIFEST_NAME)
            c_info = _find_member(zf, CSV_NAME)
            if m_info.file_size > MAX_MANIFEST_BYTES:
                raise PackageError("The project description in the package is too large.")
            if c_info.file_size > MAX_CSV_BYTES:
                raise PackageError("The CSV inside the package is too large.")
            with zf.open(m_info) as f:
                raw = f.read(MAX_MANIFEST_BYTES + 1)
            try:
                manifest = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as e:
                raise PackageError(f"The project description is not valid JSON: {e}") from e
            if not isinstance(manifest, dict) or manifest.get("format") != FORMAT:
                raise PackageError("This zip was not created by CSV Labeler's Share project.")
            version = manifest.get("format_version")
            if not isinstance(version, int) or version > FORMAT_VERSION:
                raise PackageError(
                    "This package was made by a newer version of CSV Labeler. "
                    "Update the app and try again.")

            fd, csv_tmp = tempfile.mkstemp(suffix=".csv", dir=work_dir)
            os.close(fd)
            with zf.open(c_info) as f:
                _copy_limited(f, csv_tmp, MAX_CSV_BYTES)
    except PackageError:
        if csv_tmp and os.path.exists(csv_tmp):
            os.unlink(csv_tmp)
        raise
    except (zipfile.BadZipFile, RuntimeError, OSError, EOFError) as e:
        # RuntimeError: encrypted members; BadZipFile: CRC mismatch / damage
        if csv_tmp and os.path.exists(csv_tmp):
            os.unlink(csv_tmp)
        raise PackageError(f"The package is damaged or encrypted: {e}") from e

    warnings = []
    expected = (manifest.get("csv") or {}).get("sha256")
    actual = csv_loader.file_sha256(csv_tmp)
    manifest["_csv_hash_ok"] = bool(expected) and expected == actual
    if not manifest["_csv_hash_ok"]:
        warnings.append(
            "The CSV inside the package differs from the one that was exported "
            "(it was edited or re-saved). Check the columns before you start.")
    return manifest, csv_tmp, warnings


# --------------------------------------------------------------- sanitizing
def _s(v, maxlen=10000):
    return v[:maxlen] if isinstance(v, str) else ""


def _str_list(v, maxlen=500, maxitems=10000):
    if not isinstance(v, list):
        return []
    return [x[:maxlen] for x in v[:maxitems] if isinstance(x, str)]


def _bool(v, default):
    return v if isinstance(v, bool) else default


def _int(v, default, lo=None, hi=None):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return default
    v = int(v)
    if lo is not None:
        v = max(lo, v)
    if hi is not None:
        v = min(hi, v)
    return v


def sanitize_config(raw) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    d = copy.deepcopy(DEFAULT_CONFIG)
    d["text_column"] = _s(raw.get("text_column"), 1000)
    d["id_column"] = _s(raw.get("id_column"), 1000)
    d["context_columns"] = _str_list(raw.get("context_columns"), 1000)
    d["hidden_columns"] = _str_list(raw.get("hidden_columns"), 1000)
    d["blind_mode"] = _bool(raw.get("blind_mode"), False)
    if raw.get("task_type") in TASK_TYPES:
        d["task_type"] = raw["task_type"]
    d["child_multi"] = _bool(raw.get("child_multi"), False)
    outs = [c.strip() for c in _str_list(raw.get("output_columns"), 1000) if c.strip()]
    if outs:
        d["output_columns"] = outs
    elif d["task_type"].startswith("hier"):
        d["output_columns"] = ["label_level1", "label_level2"]
    d["allow_edit_existing"] = _bool(raw.get("allow_edit_existing"), False)
    for group in ("unlabeled_detection", "special_states"):
        src = raw.get(group) if isinstance(raw.get(group), dict) else {}
        for k, default in d[group].items():
            d[group][k] = _bool(src.get(k), default)
    if raw.get("resume_mode") in RESUME_MODES:
        d["resume_mode"] = raw["resume_mode"]
    d["resume_row"] = _int(raw.get("resume_row"), 0, lo=0)
    order = raw.get("order") if isinstance(raw.get("order"), dict) else {}
    d["order"] = {
        "mode": order.get("mode") if order.get("mode") in ORDER_MODES else "original",
        "seed": _int(order.get("seed"), 0),
    }
    d["show_distribution"] = _bool(raw.get("show_distribution"), False)
    d["idle_timeout_seconds"] = _int(raw.get("idle_timeout_seconds"), 90, lo=10, hi=86400)
    sep = raw.get("multi_separator")
    if isinstance(sep, str) and 0 < len(sep) <= 5:
        d["multi_separator"] = sep
    return d


def sanitize_labels(raw) -> list:
    if not isinstance(raw, list):
        raise PackageError("The package contains no label definitions.")
    out, ids = [], set()
    for i, lab in enumerate(raw[:1000]):
        if not isinstance(lab, dict):
            continue
        name = _s(lab.get("name"), 200).strip()
        if not name:
            continue
        lid = _s(lab.get("id"), 100).strip() or f"imp-{i}"
        if lid in ids:
            continue
        ids.add(lid)
        color = lab.get("color")
        if not (isinstance(color, str) and HEX_COLOR.match(color)):
            color = PALETTE[i % len(PALETTE)]  # also blocks CSS injection via style=""
        parent = lab.get("parent")
        out.append({
            "id": lid,
            "name": name,
            "definition": _s(lab.get("definition"), 2000),
            "instructions": _s(lab.get("instructions"), 20000),
            "examples": _s(lab.get("examples"), 20000),
            "color": color.lower(),
            "shortcut": _s(lab.get("shortcut"), 1).lower(),
            "parent": parent[:100] if isinstance(parent, str) and parent else None,
        })
    top_ids = {l["id"] for l in out if not l["parent"]}
    out = [l for l in out if not l["parent"] or l["parent"] in top_ids]

    if not top_ids:
        raise PackageError("The package contains no usable labels.")
    if len(top_ids) > 20 or len(out) > 40:
        raise PackageError("The package has more labels than the app supports "
                           "(20 per level, 40 in total).")
    names = [l["name"].lower() for l in out]
    if len(set(names)) != len(names):
        raise PackageError("The package contains duplicate label names.")
    seen = set()
    for l in out:  # duplicate shortcuts: keep the first, clear the rest
        if l["shortcut"] in seen:
            l["shortcut"] = ""
        elif l["shortcut"]:
            seen.add(l["shortcut"])
    return out


def sanitize_annotations(raw, valid_uids) -> tuple[dict, int]:
    """Return (annotations, n_dropped)."""
    if not isinstance(raw, dict):
        return {}, 0
    out, dropped = {}, 0
    for uid, a in raw.items():
        if uid not in valid_uids or not isinstance(a, dict):
            dropped += 1
            continue
        status = a.get("status", "labeled")
        if status not in projects.STATUSES:
            dropped += 1
            continue
        levels_raw = a.get("levels") if isinstance(a.get("levels"), dict) else {}
        dur = a.get("duration_s")
        out[uid] = {
            "labels": _str_list(a.get("labels"), 200, 100),
            "levels": {k: _str_list(levels_raw.get(k), 200, 100)
                       for k in ("1", "2") if k in levels_raw},
            "status": status,
            "comment": _s(a.get("comment"), 10000),
            "timestamp": _s(a.get("timestamp"), 64),
            "duration_s": round(float(dur), 2)
            if isinstance(dur, (int, float)) and not isinstance(dur, bool) and dur >= 0 else 0.0,
            "annotator": _s(a.get("annotator"), 200),
        }
    return out, dropped


def sanitize_sessions(raw) -> list:
    if not isinstance(raw, list):
        return []
    out = []
    for s in raw[:100000]:
        if not isinstance(s, dict):
            continue
        act = s.get("active_s")
        out.append({
            "id": _s(s.get("id"), 100),
            "start": _s(s.get("start"), 64) or None,
            "end": _s(s.get("end"), 64) or None,
            "active_s": round(float(act), 1)
            if isinstance(act, (int, float)) and not isinstance(act, bool) and act >= 0 else 0.0,
        })
    return out


def summary(manifest, info, labels, config, warnings) -> dict:
    """What the import dialog shows and the setup wizard is prefilled with."""
    ann = manifest.get("annotations") if manifest.get("includes_annotations") else None
    return {
        "name": _s(manifest.get("name"), 200) or "Imported project",
        "exported_by": _s(manifest.get("exported_by"), 200),
        "exported_at": _s(manifest.get("exported_at"), 64),
        "info": info,
        "config": config,
        "labels": labels,
        "includes_annotations": isinstance(ann, dict) and bool(ann),
        "n_annotations": len(ann) if isinstance(ann, dict) else 0,
        "csv_unchanged": bool(manifest.get("_csv_hash_ok")),
        "warnings": warnings,
    }
