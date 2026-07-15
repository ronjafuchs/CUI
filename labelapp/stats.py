"""Statistics report generation (TXT, optional JSON)."""
from __future__ import annotations

import datetime
import json
import os
import statistics as pystats


def _fmt_duration(seconds):
    seconds = int(round(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h {m:02d}m {s:02d}s"
    if m:
        return f"{m}m {s:02d}s"
    return f"{s}s"


def compute_stats(project):
    project._ensure_loaded()
    state = project.state
    cfg = state["config"]
    counts = project.counts()
    annotations = state["annotations"]
    total = counts["total"]

    durations = [a["duration_s"] for a in annotations.values()
                 if a.get("status") == "labeled" and a.get("duration_s")]
    dist = project.label_distribution()
    n_label_uses = sum(dist.values()) or 1

    hier_combos = {}
    if cfg.get("task_type", "").startswith("hier"):
        for a in annotations.values():
            if a.get("status") != "labeled":
                continue
            levels = a.get("levels", {})
            keys = sorted(levels.keys(), key=int)
            combo = " > ".join("+".join(sorted(levels[k])) for k in keys if levels[k])
            if combo:
                hier_combos[combo] = hier_combos.get(combo, 0) + 1

    sessions = state.get("sessions", [])
    total_active = sum(float(s.get("active_s") or 0) for s in sessions)

    def pct(n):
        return round(100 * n / total, 1) if total else 0.0

    n_labeled = counts["labeled"]
    n_unlabeled = counts["unlabeled"]

    return {
        "project_name": state["name"],
        "dataset_filename": state["csv"].get("filename", "data.csv"),
        "annotator_id": state.get("annotator_id", ""),
        "total_rows": total,
        "labeled": {"count": n_labeled, "pct": pct(n_labeled)},
        "unlabeled": {"count": n_unlabeled, "pct": pct(n_unlabeled)},
        "preexisting": {"count": counts.get("preexisting", 0),
                        "pct": pct(counts.get("preexisting", 0))},
        "skipped": counts["skipped"],
        "unsure": counts["unsure"],
        "invalid": counts["invalid"],
        "needs_discussion": counts["discuss"],
        "label_counts": {
            name: {"count": n, "pct": round(100 * n / n_label_uses, 1)}
            for name, n in sorted(dist.items(), key=lambda kv: -kv[1])
        },
        "hierarchical_combinations": dict(
            sorted(hier_combos.items(), key=lambda kv: -kv[1])
        ),
        "total_active_time_s": round(total_active, 1),
        "avg_time_per_row_s": round(pystats.mean(durations), 2) if durations else None,
        "median_time_per_row_s": round(pystats.median(durations), 2) if durations else None,
        "n_sessions": len(sessions),
        "sessions": [
            {"start": s.get("start"), "end": s.get("end"),
             "active_s": round(float(s.get("active_s") or 0), 1)}
            for s in sessions
        ],
        "project_created": state.get("created_at"),
        "exported_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "configuration": {
            "task_type": cfg.get("task_type"),
            "input_column": cfg.get("text_column"),
            "id_column": cfg.get("id_column"),
            "context_columns": cfg.get("context_columns"),
            "hidden_columns": cfg.get("hidden_columns"),
            "output_columns": cfg.get("output_columns"),
            "blind_mode": cfg.get("blind_mode"),
            "order": cfg.get("order"),
            "special_states": cfg.get("special_states"),
        },
        "labels": state.get("labels", []),
    }


def render_txt(s):
    L = []
    add = L.append
    bar = "=" * 62
    add(bar)
    add("LABELING PROJECT STATISTICS")
    add(bar)
    add(f"Project name:        {s['project_name']}")
    add(f"Dataset file:        {s['dataset_filename']}")
    add(f"Annotator ID:        {s['annotator_id'] or '(none)'}")
    add(f"Project created:     {s['project_created']}")
    add(f"Report exported:     {s['exported_at']}")
    add("")
    add("PROGRESS")
    add("-" * 62)
    add(f"Total rows:          {s['total_rows']}")
    add(f"Labeled:             {s['labeled']['count']} ({s['labeled']['pct']}%)")
    add(f"Unlabeled:           {s['unlabeled']['count']} ({s['unlabeled']['pct']}%)")
    if s["preexisting"]["count"]:
        add(f"Pre-existing values: {s['preexisting']['count']} ({s['preexisting']['pct']}%)")
    add(f"Skipped:             {s['skipped']}")
    add(f"Unsure:              {s['unsure']}")
    add(f"Invalid input:       {s['invalid']}")
    add(f"Needs discussion:    {s['needs_discussion']}")
    add("")
    add("LABEL DISTRIBUTION")
    add("-" * 62)
    if s["label_counts"]:
        w = max(len(n) for n in s["label_counts"]) + 2
        for name, d in s["label_counts"].items():
            add(f"{name.ljust(w)} {d['count']:>6}  ({d['pct']}%)")
    else:
        add("(no labels applied yet)")
    if s["hierarchical_combinations"]:
        add("")
        add("HIERARCHICAL LABEL COMBINATIONS")
        add("-" * 62)
        for combo, n in s["hierarchical_combinations"].items():
            add(f"{n:>6}  {combo}")
    add("")
    add("TIMING")
    add("-" * 62)
    add(f"Total active labeling time:  {_fmt_duration(s['total_active_time_s'])}")
    avg = s["avg_time_per_row_s"]
    med = s["median_time_per_row_s"]
    add(f"Average time per row:        {str(avg) + ' s' if avg is not None else 'n/a'}")
    add(f"Median time per row:         {str(med) + ' s' if med is not None else 'n/a'}")
    add(f"Number of sessions:          {s['n_sessions']}")
    for i, sess in enumerate(s["sessions"], 1):
        add(f"  Session {i}: {sess['start']} \u2192 {sess['end'] or 'open'} "
            f"({_fmt_duration(sess['active_s'])} active)")
    add("")
    add("CONFIGURATION")
    add("-" * 62)
    for k, v in s["configuration"].items():
        add(f"{k}: {v}")
    add("")
    add("LABEL DEFINITIONS")
    add("-" * 62)
    for lab in s["labels"]:
        parent = f" (child of {lab['parent']})" if lab.get("parent") else ""
        add(f"[{lab.get('shortcut', '')}] {lab['name']}{parent}")
        if lab.get("definition"):
            add(f"    definition: {lab['definition']}")
        if lab.get("instructions"):
            add(f"    instructions: {lab['instructions']}")
        if lab.get("examples"):
            add(f"    examples: {lab['examples']}")
    add(bar)
    return "\n".join(L) + "\n"


def export_stats(project, fmt_json=False, filename=None):
    s = compute_stats(project)
    exp_dir = os.path.join(project.pdir, "exports")
    os.makedirs(exp_dir, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    base = os.path.basename(filename or f"statistics-{stamp}")
    base = base.rsplit(".", 1)[0]
    txt_path = os.path.join(exp_dir, base + ".txt")
    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(render_txt(s))
    out = {"txt": os.path.basename(txt_path)}
    if fmt_json:
        json_path = os.path.join(exp_dir, base + ".json")
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(s, f, ensure_ascii=False, indent=2)
        out["json"] = os.path.basename(json_path)
    return out
