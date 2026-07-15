"""Project state and annotation logic.

A Project ties together:
  * the local CSV copy (loaded lazily as a pandas DataFrame),
  * the configuration chosen at setup,
  * label definitions,
  * annotations keyed by a *stable row UID* (never the visible position),
  * timing and session records.
"""
from __future__ import annotations

import datetime
import os
import random
import re
import unicodedata

from . import csv_loader, persistence

STATUSES = ("labeled", "skipped", "unsure", "invalid", "discuss")


def now_iso():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def slugify(name):
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
    return s or "project"


class ProjectError(Exception):
    pass


class Project:
    def __init__(self, root, state):
        self.root = root
        self.state = state
        self._df = None
        self._uids = None          # list of uid per original row index
        self._uid_to_index = None  # uid -> original row index
        self._order = None         # display order: list of uids

    # ------------------------------------------------------------------ setup
    @classmethod
    def create(cls, root, name, annotator_id, csv_path, csv_info, config, labels):
        base = slugify(name)
        pid, i = base, 2
        while os.path.exists(persistence.project_dir(root, pid)):
            pid, i = f"{base}-{i}", i + 1
        pdir = persistence.project_dir(root, pid)
        os.makedirs(os.path.join(pdir, "exports"), exist_ok=True)
        stored = os.path.join(pdir, "data.csv")
        os.replace(csv_path, stored)
        csv_info["sha256"] = csv_loader.file_sha256(stored)

        state = {
            "id": pid,
            "name": name,
            "annotator_id": annotator_id or "",
            "created_at": now_iso(),
            "csv": csv_info,
            "config": config,
            "labels": labels,
            "annotations": {},
            "sessions": [],
            "current_pos": 0,
            "last_saved": now_iso(),
        }
        proj = cls(root, state)
        proj._ensure_loaded()
        # resolve starting position
        proj.state["current_pos"] = proj._resume_position()
        proj.save()
        return proj

    @classmethod
    def open(cls, root, project_id):
        state, recovered = persistence.load_state(root, project_id)
        proj = cls(root, state)
        proj.recovered_from = recovered
        proj.verify_csv()
        proj._ensure_loaded()
        return proj

    # ------------------------------------------------------------- data access
    @property
    def pdir(self):
        return persistence.project_dir(self.root, self.state["id"])

    @property
    def csv_path(self):
        return os.path.join(self.pdir, "data.csv")

    def verify_csv(self):
        """Confirm the stored CSV still matches the saved project."""
        info = self.state["csv"]
        if not os.path.exists(self.csv_path):
            raise ProjectError(
                "The project's data.csv file is missing. Restore it before continuing."
            )
        sha = csv_loader.file_sha256(self.csv_path)
        if sha != info.get("sha256"):
            # Deep check: columns and row count must match to proceed at all
            df, new_info = csv_loader.load_dataframe(
                self.csv_path, info.get("encoding"), info.get("delimiter")
            )
            if new_info.columns != info.get("columns") or new_info.n_rows != info.get("n_rows"):
                raise ProjectError(
                    "The CSV on disk no longer matches this project "
                    "(columns or row count changed). Annotations were not applied. "
                    "Restore the original file or start a new project."
                )
            self.csv_changed_warning = (
                "The CSV file content changed since the last save, but columns and "
                "row count still match. Annotations are applied by row ID — "
                "double-check a few rows before continuing."
            )
            self._df = df
        else:
            self.csv_changed_warning = None

    def _ensure_loaded(self):
        if self._df is None:
            info = self.state["csv"]
            self._df, _ = csv_loader.load_dataframe(
                self.csv_path, info.get("encoding"), info.get("delimiter")
            )
        if self._uids is None:
            self._build_uids()
        if self._order is None:
            self._build_order()

    def _build_uids(self):
        id_col = self.state["config"].get("id_column")
        if id_col and id_col in self._df.columns:
            self._uids = [str(v) for v in self._df[id_col].tolist()]
        else:
            self._uids = [f"r{i}" for i in range(len(self._df))]
        self._uid_to_index = {u: i for i, u in enumerate(self._uids)}

    def _build_order(self):
        order_cfg = self.state["config"].get("order", {"mode": "original"})
        uids = list(self._uids)
        if order_cfg.get("mode") == "random":
            rng = random.Random(order_cfg.get("seed", 0))
            rng.shuffle(uids)  # reproducible for a fixed seed
        self._order = uids
        self._pos_of = {u: p for p, u in enumerate(uids)}

    # ----------------------------------------------------------- labeled state
    def existing_output_value(self, uid):
        """Non-empty pre-existing values in output columns for this row."""
        cfg = self.state["config"]
        det = cfg.get("unlabeled_detection", {})
        idx = self._uid_to_index[uid]
        vals = {}
        for col in cfg.get("output_columns", []):
            if col in self._df.columns:
                v = self._df.iat[idx, self._df.columns.get_loc(col)]
                if not csv_loader.is_unlabeled_value(v, det):
                    vals[col] = str(v)
        return vals

    def row_status(self, uid):
        ann = self.state["annotations"].get(uid)
        if ann:
            return ann.get("status", "labeled")
        if self.existing_output_value(uid):
            return "preexisting"
        return "unlabeled"

    def counts(self):
        n = len(self._order)
        c = {"total": n, "labeled": 0, "skipped": 0, "unsure": 0,
             "invalid": 0, "discuss": 0, "preexisting": 0, "unlabeled": 0}
        annotated = set()
        for uid, ann in self.state["annotations"].items():
            st = ann.get("status", "labeled")
            c[st] = c.get(st, 0) + 1
            annotated.add(uid)
        for uid in self._order:
            if uid in annotated:
                continue
            if self.existing_output_value(uid):
                c["preexisting"] += 1
            else:
                c["unlabeled"] += 1
        done = n - c["unlabeled"]
        c["done"] = done
        c["pct_done"] = round(100 * done / n, 1) if n else 0.0
        return c

    def label_distribution(self):
        dist = {}
        for ann in self.state["annotations"].values():
            levels = ann.get("levels") or {}
            names = ([n for lv in levels.values() for n in lv]
                     if any(levels.values()) else ann.get("labels", []))
            for name in names:
                dist[name] = dist.get(name, 0) + 1
        return dist

    # ------------------------------------------------------------- navigation
    def _resume_position(self):
        mode = self.state["config"].get("resume_mode", "last_visited")
        if mode == "first_unlabeled":
            p = self.next_position(-1, "unlabeled")
            return p if p is not None else 0
        if mode == "manual":
            return int(self.state["config"].get("resume_row", 0))
        return int(self.state.get("current_pos", 0))

    def next_position(self, from_pos, want, direction=1):
        """Next display position (exclusive of from_pos) whose status matches."""
        n = len(self._order)
        rng = range(from_pos + 1, n) if direction > 0 else range(from_pos - 1, -1, -1)
        wanted = {want} if isinstance(want, str) else set(want)
        for p in rng:
            if self.row_status(self._order[p]) in wanted:
                return p
        return None

    def position_of_uid(self, uid):
        return self._pos_of.get(uid)

    def row_payload(self, pos):
        """Everything the UI needs to render one row."""
        if pos < 0 or pos >= len(self._order):
            raise ProjectError(f"Row position {pos} is out of range.")
        cfg = self.state["config"]
        uid = self._order[pos]
        idx = self._uid_to_index[uid]
        row = self._df.iloc[idx]
        blind = cfg.get("blind_mode", False)
        hidden = set(cfg.get("hidden_columns", []))
        outputs = set(cfg.get("output_columns", []))

        context = {}
        for col in cfg.get("context_columns", []):
            if col in hidden:
                continue
            if blind and col in outputs:
                continue
            context[col] = str(row[col]) if col in self._df.columns else ""

        existing = self.existing_output_value(uid)
        if blind:
            existing_shown = {k: "(hidden \u2014 blind mode)" for k in existing}
        else:
            existing_shown = existing

        return {
            "pos": pos,
            "uid": uid,
            "original_index": idx,
            "text": str(row[cfg["text_column"]]),
            "context": context,
            "status": self.row_status(uid),
            "annotation": self.state["annotations"].get(uid),
            "existing_output": existing_shown,
            "locked": bool(existing) and not cfg.get("allow_edit_existing", False)
                      and uid not in self.state["annotations"],
        }

    # -------------------------------------------------------------- annotating
    def set_annotation(self, uid, payload):
        """Create, replace or delete (payload None) an annotation."""
        if uid not in self._uid_to_index:
            raise ProjectError(f"Unknown row ID {uid!r}.")
        cfg = self.state["config"]
        if payload is None:
            self.state["annotations"].pop(uid, None)
            return
        existing = self.existing_output_value(uid)
        if existing and not cfg.get("allow_edit_existing", False):
            raise ProjectError(
                "This row already has a value in an output column and editing "
                "existing values is disabled for this project."
            )
        status = payload.get("status", "labeled")
        if status not in STATUSES:
            raise ProjectError(f"Unknown status {status!r}.")
        prev = self.state["annotations"].get(uid, {})
        ann = {
            "labels": payload.get("labels", []),
            "levels": payload.get("levels", {}),
            "status": status,
            "comment": payload.get("comment", ""),
            "timestamp": now_iso(),
            "duration_s": round(
                float(prev.get("duration_s", 0)) + float(payload.get("duration_s", 0) or 0), 2
            ),
            "annotator": self.state.get("annotator_id", ""),
        }
        self.state["annotations"][uid] = ann

    # ----------------------------------------------------------- search/filter
    def search(self, query, limit=50):
        q = query.lower()
        cfg = self.state["config"]
        col = cfg["text_column"]
        id_col = cfg.get("id_column")
        results = []
        for pos, uid in enumerate(self._order):
            idx = self._uid_to_index[uid]
            text = str(self._df.iat[idx, self._df.columns.get_loc(col)])
            if q in text.lower() or (id_col and q in uid.lower()):
                results.append({
                    "pos": pos, "uid": uid,
                    "snippet": text[:160],
                    "status": self.row_status(uid),
                })
                if len(results) >= limit:
                    break
        return results

    def filter_rows(self, status, page=0, page_size=50):
        wanted = set(status.split(",")) if status else None
        matches = []
        for pos, uid in enumerate(self._order):
            st = self.row_status(uid)
            if wanted is None or st in wanted:
                matches.append((pos, uid, st))
        total = len(matches)
        page_items = matches[page * page_size:(page + 1) * page_size]
        cfg = self.state["config"]
        col_loc = self._df.columns.get_loc(cfg["text_column"])
        out = []
        for pos, uid, st in page_items:
            idx = self._uid_to_index[uid]
            out.append({
                "pos": pos, "uid": uid, "status": st,
                "snippet": str(self._df.iat[idx, col_loc])[:160],
            })
        return {"total": total, "page": page, "page_size": page_size, "items": out}

    # ---------------------------------------------------------------- sessions
    def session_event(self, event, session_id, active_s=0):
        sessions = self.state["sessions"]
        if event == "start":
            sessions.append({
                "id": session_id, "start": now_iso(), "end": None, "active_s": 0.0
            })
        else:
            for s in reversed(sessions):
                if s["id"] == session_id:
                    s["active_s"] = round(float(active_s), 1)
                    s["end"] = now_iso()
                    break

    # -------------------------------------------------------------------- save
    def save(self):
        self.state["last_saved"] = now_iso()
        return persistence.save_state(self.root, self.state["id"], self.state)
