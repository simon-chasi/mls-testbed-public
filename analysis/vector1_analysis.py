"""
Vector 1 Analysis — Metadata Inference and Traffic Analysis
Owner: Simon

Produces:
  figures/vector1_size_distribution.pdf  — box plots of payload_size by message_type
  figures/vector1_timeline.pdf           — size vs time, colour-coded by type
"""

import sys
from pathlib import Path

import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np
import pandas as pd
import seaborn as sns

sys.path.insert(0, str(Path(__file__).parent))
from common import (
    load_log, filter_messages, save_figure,
    MESSAGE_TYPE_COLORS, MESSAGE_TYPE_LABELS, FIGURES_DIR, ROOT
)

# ── Load data ─────────────────────────────────────────────────────────────────

log_path = Path(sys.argv[1]) if len(sys.argv) > 1 else next((ROOT / "logs").glob("vector1_*.jsonl"), None)
if log_path is None or not log_path.exists():
    raise FileNotFoundError("No vector1 log found. Run: SEED=42 npm run vector1")

df_all = load_log(log_path)
df_msgs = filter_messages(df_all, event="message_sent")

print(f"Loaded {len(df_msgs)} message events from {log_path.name}")
print(df_msgs.groupby("message_type")["payload_size"].describe().round(1))

# ── Figure A: Size distribution (box plots) ───────────────────────────────────

order = ["application", "commit", "welcome"]
present = [t for t in order if t in df_msgs["message_type"].values]

fig_a, ax_a = plt.subplots(figsize=(7, 4))

data_by_type = [df_msgs[df_msgs["message_type"] == t]["payload_size"].values for t in present]
bp = ax_a.boxplot(
    data_by_type,
    patch_artist=True,
    medianprops={"color": "black", "linewidth": 1.5},
    whiskerprops={"linewidth": 1},
    capprops={"linewidth": 1},
    flierprops={"marker": ".", "markersize": 3, "alpha": 0.4},
)
for patch, t in zip(bp["boxes"], present):
    patch.set_facecolor(MESSAGE_TYPE_COLORS.get(t, "#aaaaaa"))
    patch.set_alpha(0.8)

ax_a.set_xticks(range(1, len(present) + 1))
ax_a.set_xticklabels([MESSAGE_TYPE_LABELS.get(t, t) for t in present])
ax_a.set_ylabel("Payload size (bytes)")
ax_a.set_title("MLS Message Size Distribution by Type")
ax_a.grid(axis="y", linestyle="--", alpha=0.4)

save_figure(fig_a, "vector1_size_distribution")

# ── Figure B: Timeline scatter plot ──────────────────────────────────────────

fig_b, ax_b = plt.subplots(figsize=(10, 4))

t0 = df_msgs["timestamp"].min()
df_msgs = df_msgs.copy()
df_msgs["time_s"] = (df_msgs["timestamp"] - t0) / 1000.0

for mtype in present:
    sub = df_msgs[df_msgs["message_type"] == mtype]
    ax_b.scatter(
        sub["time_s"],
        sub["payload_size"],
        c=MESSAGE_TYPE_COLORS.get(mtype, "#aaaaaa"),
        label=MESSAGE_TYPE_LABELS.get(mtype, mtype),
        s=15,
        alpha=0.7,
        zorder=3,
    )

# Mark epoch changes as vertical dashed lines
epoch_changes = df_all[df_all["event"] == "epoch_changed"].copy()
if not epoch_changes.empty:
    epoch_changes["time_s"] = (epoch_changes["timestamp"] - t0) / 1000.0
    for _, row in epoch_changes.iterrows():
        ax_b.axvline(row["time_s"], color="#cccccc", linestyle=":", linewidth=0.8, zorder=1)

ax_b.set_xlabel("Time (s)")
ax_b.set_ylabel("Payload size (bytes)")
ax_b.set_title("MLS Traffic Timeline — Passive Observer View")
ax_b.legend(loc="upper right", fontsize=9)
ax_b.grid(linestyle="--", alpha=0.3)

save_figure(fig_b, "vector1_timeline")

print("Vector 1 analysis complete.")
