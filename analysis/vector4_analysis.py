"""
Vector 4 Analysis — Commit-Size Scaling and the O(log N) Side-Channel
Owner: Simon

Reads measurement-phase client_state_snapshot events (not relay message_sent
events) so that only pure self-update commits at each swept group size are
included. Bootstrap add-commits at intermediate sizes are deliberately excluded.

Produces:
  figures/vector4_commit_scaling.pdf   — median commit size vs log2(N) with linear fit
  figures/vector4_size_clusters.pdf    — per-leaf commit sizes grouped by N,
                                         showing tight non-overlapping clusters
"""

import json
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import matplotlib.ticker as ticker
import numpy as np
import pandas as pd
from scipy.stats import linregress

sys.path.insert(0, str(Path(__file__).parent))
from common import load_log, save_figure, MESSAGE_TYPE_COLORS, ROOT

# ── Load and extract measurement-phase snapshots ──────────────────────────────

log_path = (
    Path(sys.argv[1])
    if len(sys.argv) > 1
    else next((ROOT / "logs").glob("vector4_*.jsonl"), None)
)
if log_path is None or not log_path.exists():
    raise FileNotFoundError("No vector4 log found. Run: docker compose run vector4")

df_all = load_log(log_path)

# Only client_state_snapshot rows with a parseable detail field
snaps = df_all[df_all["event"] == "client_state_snapshot"].copy()
snaps["_detail"] = snaps["detail"].apply(
    lambda s: json.loads(s) if isinstance(s, str) else {}
)
snaps = snaps[snaps["_detail"].apply(lambda d: d.get("phase") == "measurement")]
snaps["group_size"]  = snaps["_detail"].apply(lambda d: int(d["group_size"]))
snaps["leaf_index"]  = snaps["_detail"].apply(lambda d: int(d["leaf_index"]))
snaps["commit_size"] = snaps["_detail"].apply(lambda d: int(d["commit_size"]))
snaps["log2_N"]      = snaps["_detail"].apply(lambda d: float(d["log2_N"]))

if snaps.empty:
    raise ValueError("No measurement-phase snapshots found in log.")

group_sizes = sorted(snaps["group_size"].unique())
print(f"Loaded {len(snaps)} measurement observations across N = {group_sizes}")

# Per-group-size summary
summary = (
    snaps.groupby("group_size")["commit_size"]
    .agg(["min", "median", "max", "std", "count"])
    .rename(columns={"median": "med"})
)
summary["log2_N"] = np.log2(summary.index.astype(float))
print("\nPer-group summary (measurement-phase self-update commits):")
print(summary.to_string())

# ── Linear fit on (log2_N, median_commit_size) ────────────────────────────────

x_fit = summary["log2_N"].values
y_fit = summary["med"].values
slope, intercept, r_value, _, _ = linregress(x_fit, y_fit)
r2 = r_value ** 2
print(f"\nLinear fit:  commit_size ≈ {slope:.1f}·log₂(N) + {intercept:.1f}  (R² = {r2:.6f})")

# ── Figure A: Commit size vs log2(N) — the scaling plot ───────────────────────
#
# X-axis = log2(N) so the O(log N) relationship appears as a straight line.
# Individual leaf measurements shown as dots; median per N as larger marker.

fig_a, ax_a = plt.subplots(figsize=(7, 4.2))

commit_color = MESSAGE_TYPE_COLORS["commit"]

# Individual leaf measurements
ax_a.scatter(
    snaps["log2_N"], snaps["commit_size"],
    color=commit_color, alpha=0.35, s=18, zorder=2,
    label="Individual commit (per leaf)",
)
# Median per group size
ax_a.scatter(
    summary["log2_N"], summary["med"],
    color=commit_color, edgecolors="black", linewidths=0.8,
    s=60, zorder=3, label="Median per group size",
)
# Fit line
x_line = np.linspace(x_fit.min() - 0.2, x_fit.max() + 0.2, 200)
ax_a.plot(
    x_line, slope * x_line + intercept,
    color="black", linewidth=1.5, zorder=4,
    label=f"Fit: {slope:.1f}·log₂(N) + {intercept:.1f}  (R² = {r2:.4f})",
)

# Annotate x-ticks with both log2(N) and N values
log2_vals = np.log2(np.array(group_sizes, dtype=float))
ax_a.set_xticks(log2_vals)
ax_a.set_xticklabels([f"{int(n)}\n(log₂={int(l)})" for n, l in zip(group_sizes, log2_vals)])

ax_a.set_xlabel("Group size N  (log₂(N) scale)")
ax_a.set_ylabel("Commit payload size (bytes)")
ax_a.set_title("Vector 4: Commit Size Scales as O(log N) with Group Size")
ax_a.legend(fontsize=8.5)
ax_a.grid(linestyle="--", alpha=0.35)

save_figure(fig_a, "vector4_commit_scaling")

# ── Figure B: Per-N size clusters — the inferability plot ─────────────────────
#
# Each column of points corresponds to one group size.
# The near-zero within-column spread and the clear vertical separation
# demonstrate that an observer can determine N from a single commit size.

fig_b, ax_b = plt.subplots(figsize=(7, 4.2))

# One jittered strip per group size
rng = np.random.default_rng(0)
x_positions = {n: i for i, n in enumerate(group_sizes)}

for n in group_sizes:
    sizes = snaps[snaps["group_size"] == n]["commit_size"].values
    x_jitter = x_positions[n] + rng.uniform(-0.15, 0.15, size=len(sizes))
    ax_b.scatter(x_jitter, sizes, color=commit_color, alpha=0.55, s=16, zorder=2)
    # Median bar
    med = np.median(sizes)
    ax_b.hlines(med, x_positions[n] - 0.3, x_positions[n] + 0.3,
                colors="black", linewidths=1.8, zorder=3)

ax_b.set_xticks(list(x_positions.values()))
ax_b.set_xticklabels([f"N = {n}" for n in group_sizes])
ax_b.set_ylabel("Commit payload size (bytes)")
ax_b.set_title("Vector 4: Distinct Commit-Size Clusters Enable Group-Size Inference")
ax_b.grid(axis="y", linestyle="--", alpha=0.35)

# Annotate each cluster with the per-level overhead
for i, n in enumerate(group_sizes[1:], start=1):
    prev_med = summary.loc[group_sizes[i - 1], "med"]
    curr_med = summary.loc[n, "med"]
    delta = curr_med - prev_med
    ax_b.annotate(
        f"+{delta:.0f} B",
        xy=(i, curr_med),
        xytext=(i + 0.35, (curr_med + prev_med) / 2),
        fontsize=7.5, color="#444444",
        arrowprops=dict(arrowstyle="-", color="#aaaaaa", lw=0.8),
        va="center",
    )

save_figure(fig_b, "vector4_size_clusters")

print("\nVector 4 analysis complete.")
