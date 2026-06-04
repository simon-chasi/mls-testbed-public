"""Shared utilities for all vector analysis scripts."""

import json
import os
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")  # non-interactive backend for Docker/CI
import matplotlib.pyplot as plt
import pandas as pd

# ── Paths ─────────────────────────────────────────────────────────────────────

ROOT = Path(__file__).parent.parent
LOGS_DIR = Path(sys.argv[1]).parent if len(sys.argv) > 1 else ROOT / "logs"
FIGURES_DIR = Path(os.environ.get("FIGURES_DIR", str(ROOT / "figures")))
FIGURES_DIR.mkdir(parents=True, exist_ok=True)

# ── Styling ───────────────────────────────────────────────────────────────────

MESSAGE_TYPE_COLORS = {
    "application": "#4C9BE8",
    "commit":      "#E87B4C",
    "welcome":     "#4CE87B",
    "key_package": "#B04CE8",
}

MESSAGE_TYPE_LABELS = {
    "application": "Application message",
    "commit":      "Commit",
    "welcome":     "Welcome",
    "key_package": "Key package",
}

plt.rcParams.update({
    "font.family": "serif",
    "font.size": 11,
    "axes.titlesize": 12,
    "axes.labelsize": 11,
    "figure.dpi": 150,
})

# ── Data loading ──────────────────────────────────────────────────────────────

def load_log(log_path: Path) -> pd.DataFrame:
    """Load a JSONL log file into a DataFrame."""
    records = []
    with open(log_path) as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    if not records:
        raise ValueError(f"Log file is empty: {log_path}")
    return pd.DataFrame(records)


def filter_messages(df: pd.DataFrame, event: str = "message_sent") -> pd.DataFrame:
    """Return only message_sent rows with a valid message_type."""
    return df[df["event"] == event].dropna(subset=["message_type", "payload_size"]).copy()


# ── Figure saving ─────────────────────────────────────────────────────────────

def save_figure(fig: plt.Figure, name: str) -> None:
    """Save figure as PDF (for LaTeX) and PNG (for preview)."""
    pdf_path = FIGURES_DIR / f"{name}.pdf"
    png_path = FIGURES_DIR / f"{name}.png"
    fig.savefig(pdf_path, bbox_inches="tight")
    fig.savefig(png_path, bbox_inches="tight", dpi=150)
    print(f"Saved: {pdf_path}")
    plt.close(fig)
