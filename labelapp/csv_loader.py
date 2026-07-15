"""CSV loading, sniffing and validation.

All reading happens locally with pandas. Nothing leaves the machine.
"""
from __future__ import annotations

import csv
import hashlib
import io
from dataclasses import dataclass, field

import pandas as pd

PREVIEW_ROWS = 8
ENCODING_CANDIDATES = ["utf-8-sig", "utf-8", "cp1252", "latin-1", "utf-16"]


@dataclass
class CsvInfo:
    encoding: str = "utf-8"
    delimiter: str = ","
    n_rows: int = 0
    columns: list = field(default_factory=list)
    sha256: str = ""
    filename: str = ""

    def to_dict(self):
        return {
            "encoding": self.encoding,
            "delimiter": self.delimiter,
            "n_rows": self.n_rows,
            "columns": self.columns,
            "sha256": self.sha256,
            "filename": self.filename,
        }


def file_sha256(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def detect_encoding(path) -> str:
    with open(path, "rb") as f:
        raw = f.read(1 << 20)
    for enc in ENCODING_CANDIDATES:
        try:
            raw.decode(enc)
            return enc
        except (UnicodeDecodeError, LookupError):
            continue
    raise ValueError(
        "Could not decode the file with common encodings "
        "(UTF-8, Windows-1252, Latin-1, UTF-16). "
        "Re-save the CSV as UTF-8 and try again."
    )


def detect_delimiter(path, encoding) -> str:
    with open(path, "r", encoding=encoding, newline="") as f:
        sample = f.read(64 * 1024)
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
        return dialect.delimiter
    except csv.Error:
        return ","


def load_dataframe(path, encoding=None, delimiter=None) -> tuple[pd.DataFrame, CsvInfo]:
    """Load a CSV as all-string dataframe plus detected metadata."""
    encoding = encoding or detect_encoding(path)
    delimiter = delimiter or detect_delimiter(path, encoding)
    df = pd.read_csv(
        path,
        sep=delimiter,
        encoding=encoding,
        dtype=str,
        keep_default_na=False,
        na_filter=False,
        engine="python",
        on_bad_lines="skip",
    )
    info = CsvInfo(
        encoding=encoding,
        delimiter=delimiter,
        n_rows=len(df),
        columns=list(df.columns),
        sha256=file_sha256(path),
    )
    return df, info


def is_unlabeled_value(value, detection) -> bool:
    """Decide whether a cell counts as unlabeled under the chosen detection rules."""
    if value is None:
        return detection.get("null", True)
    s = str(value)
    if s == "" and detection.get("empty", True):
        return True
    if detection.get("whitespace", True) and s != "" and s.strip() == "":
        return True
    if detection.get("nan", True) and s.strip().lower() in ("nan", "none", "null", "n/a", "na"):
        return True
    if detection.get("null", True) and s.strip().lower() in ("null", "none"):
        return True
    return False


def validate_csv(df: pd.DataFrame, info: CsvInfo, config: dict) -> dict:
    """Validate the CSV against the chosen project configuration.

    Returns {"errors": [...], "warnings": [...]} — errors block project creation.
    """
    errors, warnings = [], []
    cols = list(df.columns)

    # Duplicate column names (pandas mangles them to name.1 — detect via original header too)
    seen, dupes = set(), set()
    for c in cols:
        base = c
        if base in seen:
            dupes.add(base)
        seen.add(base)
    # pandas already renames duplicates; detect renamed pattern
    import re
    renamed = {re.sub(r"\.\d+$", "", c) for c in cols if re.search(r"\.\d+$", c)}
    real_dupes = {r for r in renamed if r in cols}
    if dupes or real_dupes:
        warnings.append(
            "Duplicate column names detected: "
            + ", ".join(sorted(dupes | real_dupes))
            + ". Pandas renamed them with numeric suffixes."
        )

    if info.n_rows == 0:
        errors.append("The CSV contains no data rows.")

    def check_exists(col, role):
        if col and col not in cols:
            errors.append(f"{role} column \u201c{col}\u201d does not exist in the CSV.")

    check_exists(config.get("text_column"), "Input")
    if not config.get("text_column"):
        errors.append("No input column selected.")
    check_exists(config.get("id_column"), "ID")
    for c in config.get("context_columns", []):
        check_exists(c, "Context")
    for c in config.get("hidden_columns", []):
        check_exists(c, "Hidden")

    # Duplicate IDs
    id_col = config.get("id_column")
    if id_col and id_col in cols:
        dup_mask = df[id_col].duplicated()
        n_dup = int(dup_mask.sum())
        if n_dup:
            examples = df.loc[dup_mask, id_col].head(3).tolist()
            errors.append(
                f"ID column \u201c{id_col}\u201d contains {n_dup} duplicate value(s) "
                f"(e.g. {', '.join(map(str, examples))}). "
                "Pick a truly unique column or let the app generate row IDs."
            )
        blank = df[id_col].map(lambda v: str(v).strip() == "").sum()
        if blank:
            errors.append(f"ID column \u201c{id_col}\u201d has {blank} empty value(s).")

    # Output columns: existing values
    detection = config.get("unlabeled_detection", {})
    for col in config.get("output_columns", []):
        if col in cols:
            filled = int((~df[col].map(lambda v: is_unlabeled_value(v, detection))).sum())
            if filled:
                warnings.append(
                    f"Output column \u201c{col}\u201d already contains {filled} value(s). "
                    + ("They can be edited." if config.get("allow_edit_existing")
                       else "They are locked and will be preserved unchanged.")
                )

    # Output overlapping input/context
    overlap = set(config.get("output_columns", [])) & (
        {config.get("text_column")} | set(config.get("context_columns", []))
    )
    if overlap:
        errors.append(
            "Output column(s) overlap with input/context columns: " + ", ".join(sorted(overlap))
        )
    return {"errors": errors, "warnings": warnings}


def preview(df: pd.DataFrame, n=PREVIEW_ROWS) -> dict:
    head = df.head(n)
    return {
        "columns": list(df.columns),
        "rows": head.values.tolist(),
        "n_rows": len(df),
    }
