# CSV Labeler

A local application for manually annotating rows of CSV files — single-label,
multi-label and hierarchical classification with keyboard shortcuts, timing,
autosave, crash recovery, and CSV / statistics export.

**Everything stays on your machine.** The server binds to `127.0.0.1` only,
makes no outbound requests, and stores all data in a local `projects/` folder
next to `run.py`. No CSV content or annotation is ever uploaded anywhere.

---

## Installation

Requirements: Python 3.10+.

```bash
cd csv-labeler
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt    # flask, pandas
```

## Starting the app

```bash
python run.py
```

This starts a local web server on http://127.0.0.1:8765 and opens your
browser. Options:

```bash
python run.py --port 9000        # different port
python run.py --no-browser      # don't auto-open a browser tab
```

Stop it with `Ctrl+C`. Progress is saved automatically after every
annotation, so stopping at any time is safe.

---

## Workflow

### 1. Project setup
Click **New project** and walk through the five steps:

1. **Project** — name and optional annotator ID.
2. **Data** — upload the CSV. Encoding and delimiter are detected
   automatically and a preview (columns + example rows) is shown. The file is
   *copied* into the local project folder; your original is never modified.
3. **Columns** — choose the input column to label, an optional unique ID
   column (annotations attach to this ID, not to row positions), context
   columns to display, and hidden columns (never shown, always preserved in
   exports). **Blind annotation mode** additionally hides the values of all
   output/label columns, so existing annotations from other annotators are
   preserved without being visible.
4. **Labels** — single- or multi-label, optional **hierarchical mode**
   (two levels: child labels appear only after their parent is selected,
   each level exports to its own column, single or multiple children
   configurable). Up to 20 top-level labels, each with a name, short
   definition, optional instructions and examples, a colour and a one-key
   shortcut. Enable the special states you want: Unsure, Skip, Invalid
   input, Needs discussion, free-text comments.
5. **Behavior & start** — output column name(s), whether existing output
   values may be edited, how unlabeled cells are detected (empty / null /
   NaN / whitespace), resume behaviour (last visited, first unlabeled, or a
   specific row), row order (original or reproducibly randomised by seed),
   whether live label-distribution statistics are visible (off by default,
   since seeing the distribution can bias decisions), and the idle timeout.

The CSV is validated before the project starts: encoding, delimiter, missing
columns, duplicate column names, duplicate or empty IDs, and pre-filled
output columns. Blocking problems are shown as errors; everything else as
warnings you can accept.

### 2. Labeling
The workbench shows the input text prominently (long texts can be expanded /
collapsed), the context columns, row number and total, a progress bar with
counts and percentage, the session timer, the label buttons with their
keycaps, a collapsible label guide, and an optional comment field.

| Keys | Action |
|---|---|
| your label keys | select / apply a label |
| `Enter` | confirm selection (multi-label & hierarchical) |
| `←` / `→` | previous / next row |
| `.` | next unlabeled row |
| `,` | next skipped or unsure row |
| `Alt+S / U / I / D` | Skip · Unsure · Invalid · Needs discussion |
| `Ctrl+Z` | undo last annotation |
| `Ctrl+S` | save progress |
| `Ctrl+F` | focus search |
| `Esc` | close panels |

All active shortcuts are shown in the legend at the bottom of the screen.
In single-label mode, pressing a label key saves and advances immediately.

You can also jump to any row number or row ID, search the dataset, filter
rows by annotation status, edit earlier annotations by navigating back, and
pause / resume the session with the timer chip in the top bar.

### 3. Saving & recovery
- Autosave after every annotation, plus a visible **Save progress** button
  and a "saved hh:mm:ss" timestamp in the top bar.
- Saves are atomic (write-temp-then-rename) with three rotating backup files
  (`project.json.bak1..3`). If the main save file is ever corrupted — e.g.
  after a power loss — the newest readable backup is used automatically and
  you're told about it.
- When a project is reopened, the stored CSV is verified (hash, columns,
  row count) before annotations are applied. If it no longer matches, the
  app refuses with a clear message instead of mis-assigning labels.

### 4. Timing
Active time is tracked per row and per session. The timer pauses when you
press Pause, when the window loses focus or is hidden, and after the
configurable idle timeout — idle time never counts as labeling time.
Returning to a row accumulates additional time on it.

### 5. Export
**Export** writes a UTF-8 CSV into the project's `exports/` folder (with a
download link):
- all original columns and values preserved, including hidden ones,
- only the selected output column(s) added or updated,
- a stable row ID included, original row order preserved,
- skipped / unsure / invalid / needs-discussion rows exported consistently
  as `__SKIPPED__`, `__UNSURE__`, `__INVALID__`, `__NEEDS_DISCUSSION__`,
- optional metadata columns: `annotator_id`, `annotation_timestamp`,
  `annotation_duration_seconds`, `annotation_status`, `annotation_comment`,
- scope: complete dataset, all annotated rows, or only rows labeled by the
  current annotator,
- a warning before overwriting an existing file.

**Statistics** exports a TXT report (optionally JSON too) with progress
counts and percentages, per-label counts, hierarchical label combinations,
total / average / median labeling time, every session's duration, project
and export timestamps, and the full label configuration.

### 6. Sharing a project with other annotators
The app never sends anything over the network, so sharing works with a file
you pass on yourself (shared drive, email, USB stick).

**Share project** (top bar of the labeling screen) writes one `.zip` into the
project's `exports/` folder, with a download link. It contains:
- `data.csv` — a byte-exact copy of the project's CSV, **including hidden
  columns**, so only share it with people allowed to see the data,
- `labeler-project.json` — project name, column setup, labels (definitions,
  instructions, examples, colours, shortcuts), all settings including the
  random-order seed, and who exported it,
- optionally your annotations, sessions and last position. Leave this off
  when others should label independently; turn it on to hand a project over
  or move it to another computer.

**Import project** (start screen) reads such a `.zip`:
- **Start fresh** opens the setup wizard with everything filled in. Add your
  annotator ID, change labels or settings if needed (click a step to jump
  to it), then start. The CSV is the same file, so exports from everyone
  line up row by row via the row ID.
- **Keep the annotations** (only for packages that include them) creates the
  project as it was, with labels and settings unchanged. Existing
  annotations keep their original annotator ID; yours get your own, so
  "Only rows labeled by me" in Export still separates them.

Imported packages are checked before anything is used: the CSV's hash must
match (otherwise "keep annotations" is refused), sizes are capped, and every
label, setting and annotation is re-validated. Importing never replaces an
existing project; a name clash gets a new project folder.

---

## Project layout

```
csv-labeler/
├── run.py                  entry point (127.0.0.1 only)
├── requirements.txt
├── labelapp/               backend modules
│   ├── __init__.py         app factory
│   ├── csv_loader.py       CSV loading, sniffing & validation
│   ├── projects.py         project configuration & annotation state
│   ├── persistence.py      atomic saves, backups, crash recovery
│   ├── exporter.py         labeled-CSV export
│   ├── stats.py            statistics reports (TXT / JSON)
│   ├── sharing.py          project packages: share (.zip) & import
│   └── routes.py           HTTP API
├── static/                 frontend (no build step, no CDN, fully offline)
│   ├── index.html
│   ├── app.css
│   └── js/
│       ├── main.js         routing + project list
│       ├── setup.js        setup wizard
│       ├── labeling.js     labeling workbench
│       ├── importer.js     project import dialog
│       ├── timer.js        active-time & session tracking
│       └── api.js          fetch wrapper + DOM helpers
└── projects/               created at runtime — one folder per project
    └── <project-id>/
        ├── project.json (+ .bak1..3)
        ├── data.csv        local copy of your CSV
        └── exports/
```

## Performance notes

Datasets with thousands of rows stay responsive because the browser never
renders the table: exactly one row is fetched at a time, and search,
filtering (paginated, 50 rows per page) and navigation run server-side over
an in-memory pandas frame. A 5 000-row file answers row fetches in ~15 ms
and searches in a few milliseconds on ordinary hardware; files with tens of
thousands of rows remain comfortable.

## Troubleshooting

- **"Could not reach the local server"** — `run.py` was stopped; start it
  again. Nothing is lost: every annotation was saved when you made it.
- **"The CSV on disk no longer matches this project"** — the copy in the
  project folder was edited or replaced. Restore the original `data.csv`.
- **Unreadable project file** — the app recovers from `project.json.bak1..3`
  automatically; the project card tells you when that happened.
- **Wrong delimiter/encoding detected** — re-save the file as UTF-8 with a
  standard delimiter (`,`, `;`, tab or `|`) and upload again.
