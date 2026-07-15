"""Local persistence with atomic writes, rotating backups and crash recovery.

Layout on disk (everything stays inside the app folder):

projects/
  <project-id>/
    project.json        current state
    project.json.bak1   most recent backup
    project.json.bak2
    project.json.bak3
    data.csv            local copy of the uploaded CSV
    exports/            labeled CSVs and statistics reports
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile

N_BACKUPS = 3


class SaveError(Exception):
    pass


def project_dir(root, project_id):
    return os.path.join(root, project_id)


def state_path(root, project_id):
    return os.path.join(project_dir(root, project_id), "project.json")


def save_state(root, project_id, state) -> str:
    """Atomically write project.json, rotating backups first."""
    pdir = project_dir(root, project_id)
    os.makedirs(pdir, exist_ok=True)
    path = state_path(root, project_id)

    # Rotate backups: bak2 -> bak3, bak1 -> bak2, current -> bak1
    if os.path.exists(path):
        for i in range(N_BACKUPS - 1, 0, -1):
            src, dst = f"{path}.bak{i}", f"{path}.bak{i + 1}"
            if os.path.exists(src):
                shutil.copy2(src, dst)
        shutil.copy2(path, f"{path}.bak1")

    data = json.dumps(state, ensure_ascii=False, indent=1)
    fd, tmp = tempfile.mkstemp(dir=pdir, prefix=".project-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)  # atomic on the same filesystem
    except OSError as e:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise SaveError(f"Could not save project state: {e}") from e
    return state["last_saved"]


def load_state(root, project_id) -> tuple[dict, str | None]:
    """Load project.json; fall back to backups if the main file is corrupt.

    Returns (state, recovered_from) where recovered_from is None or the
    backup filename used.
    """
    path = state_path(root, project_id)
    candidates = [(path, None)] + [
        (f"{path}.bak{i}", f"project.json.bak{i}") for i in range(1, N_BACKUPS + 1)
    ]
    last_err = None
    for p, label in candidates:
        if not os.path.exists(p):
            continue
        try:
            with open(p, "r", encoding="utf-8") as f:
                return json.load(f), label
        except (json.JSONDecodeError, OSError) as e:
            last_err = e
            continue
    if last_err:
        raise SaveError(
            "The project file and all backups are unreadable. "
            f"Last error: {last_err}"
        )
    raise FileNotFoundError(f"No project named {project_id!r}.")


def list_projects(root) -> list:
    if not os.path.isdir(root):
        return []
    out = []
    for name in sorted(os.listdir(root)):
        p = state_path(root, name)
        if os.path.exists(p):
            try:
                state, recovered = load_state(root, name)
                ann = state.get("annotations", {})
                out.append({
                    "id": state.get("id", name),
                    "name": state.get("name", name),
                    "annotator_id": state.get("annotator_id", ""),
                    "created_at": state.get("created_at"),
                    "last_saved": state.get("last_saved"),
                    "n_rows": state.get("csv", {}).get("n_rows", 0),
                    "n_annotated": len(ann),
                    "recovered_from": recovered,
                })
            except SaveError:
                out.append({"id": name, "name": name, "corrupt": True})
    return out
