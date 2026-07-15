"""Labeled CSV export.

Guarantees:
  * every original column and value is preserved (including hidden ones),
  * only the user-selected output columns are added or updated,
  * a stable row ID column is included,
  * UTF-8 output, original row order by default,
  * special states (skipped / unsure / invalid / discuss) exported consistently.
"""
from __future__ import annotations

import os

STATUS_PLACEHOLDER = {
    "skipped": "__SKIPPED__",
    "unsure": "__UNSURE__",
    "invalid": "__INVALID__",
    "discuss": "__NEEDS_DISCUSSION__",
}


class ExportError(Exception):
    pass


def _join(labels, sep):
    return sep.join(labels) if labels else ""


def build_export_df(project, options):
    """Return (DataFrame, n_rows_exported)."""
    project._ensure_loaded()
    df = project._df.copy()
    state = project.state
    cfg = state["config"]
    sep = cfg.get("multi_separator", "|")
    out_cols = cfg.get("output_columns", [])
    hier = cfg.get("task_type", "").startswith("hier")
    annotations = state["annotations"]
    uids = project._uids

    id_col_name = options.get("row_id_column", "row_uid")
    if id_col_name in df.columns and id_col_name != cfg.get("id_column"):
        id_col_name = "row_uid_export"
    if cfg.get("id_column"):
        pass  # stable ID already present as a data column
    else:
        df[id_col_name] = uids

    for col in out_cols:
        if col not in df.columns:
            df[col] = ""

    meta = options.get("metadata_columns", [])
    meta_defs = {
        "annotator_id": lambda a: a.get("annotator", ""),
        "annotation_timestamp": lambda a: a.get("timestamp", ""),
        "annotation_duration_seconds": lambda a: a.get("duration_s", ""),
        "annotation_status": lambda a: a.get("status", ""),
        "annotation_comment": lambda a: a.get("comment", ""),
    }
    for m in meta:
        if m in meta_defs and m not in df.columns:
            df[m] = ""

    only_mine = options.get("scope") == "mine"
    annotator = state.get("annotator_id", "")

    n_exported = 0
    for i, uid in enumerate(uids):
        ann = annotations.get(uid)
        if ann is None:
            continue
        if only_mine and ann.get("annotator", "") != annotator:
            continue
        n_exported += 1
        status = ann.get("status", "labeled")
        if status == "labeled":
            if hier:
                levels = ann.get("levels", {})
                for li, col in enumerate(out_cols, start=1):
                    df.iat[i, df.columns.get_loc(col)] = _join(levels.get(str(li), []), sep)
            else:
                df.iat[i, df.columns.get_loc(out_cols[0])] = _join(ann.get("labels", []), sep)
        else:
            placeholder = STATUS_PLACEHOLDER[status]
            for col in out_cols:
                df.iat[i, df.columns.get_loc(col)] = placeholder

        for m in meta:
            if m in meta_defs:
                df.iat[i, df.columns.get_loc(m)] = str(meta_defs[m](ann))

    if only_mine and options.get("rows") == "labeled_only":
        keep = [i for i, uid in enumerate(uids)
                if uid in annotations and annotations[uid].get("annotator", "") == annotator]
        df = df.iloc[keep]
    elif options.get("rows") == "labeled_only":
        keep = [i for i, uid in enumerate(uids) if uid in annotations]
        df = df.iloc[keep]

    return df, n_exported


def export_csv(project, options):
    """Write the export file. Returns dict with path info.

    Refuses to overwrite unless options["overwrite"] is true.
    """
    filename = (options.get("filename") or "").strip() or "labeled.csv"
    if not filename.lower().endswith(".csv"):
        filename += ".csv"
    filename = os.path.basename(filename)  # keep exports inside the project folder
    exp_dir = os.path.join(project.pdir, "exports")
    os.makedirs(exp_dir, exist_ok=True)
    path = os.path.join(exp_dir, filename)

    if os.path.exists(path) and not options.get("overwrite"):
        raise ExportError(f"exists:{filename}")

    df, n = build_export_df(project, options)
    try:
        df.to_csv(path, index=False, encoding="utf-8")
    except OSError as e:
        raise ExportError(f"Could not write the export file: {e}") from e
    return {"path": path, "filename": filename, "n_rows": len(df), "n_annotated": n}
