
"""
Vector 2 Analysis — PCS Recovery
Owner: Ognjen

Produces:
  figures/vector2_decryption_success.pdf   — decryption_success vs commits_since_compromise
  figures/vector2_epochs_and_commits.pdf   — epoch transition vs commits_since_compromise
  figures/vector2_path_coverage.pdf        — cumulative internal node refresh vs commits_since_compromise
"""

import sys
import math
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import load_log, save_figure, ROOT

import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import pandas as pd
import numpy as np

# ── Load data ────────────────────────────────────────────────────────────────
log_path = (
    Path(sys.argv[1])
    if len(sys.argv) > 1
    else next((ROOT / "logs").glob("vector2_*.jsonl"), None)
)
if log_path is None or not log_path.exists():
    raise FileNotFoundError("No vector2 log found.")

df = load_log(log_path)

df_results = df[df["event"] == "decryption_result"].copy()
snapshot_event = df[df["event"] == "client_state_snapshot"].iloc[0]
snapshot_epoch = int(snapshot_event["epoch"])

# ── Commits during PCS phase (epoch > snapshot_epoch) ────────────────────────
df_pcs_commits = df[
    (df["event"] == "message_sent")
    & (df["message_type"] == "commit")
    & (df["epoch"] > snapshot_epoch)
].copy()

# ── Figure 1: PCS Decryption Success (Step Chart) ────────────────────────────
fig1, ax1 = plt.subplots(figsize=(7, 3.5))
ax1.step(
    df_results["commits_since_compromise"],
    df_results["decryption_success"].astype(int),
    where="post",
    color="#3B7DD8",
    linewidth=2,
)
ax1.axhline(y=0, color="#999999", linestyle=":", linewidth=0.8)
ax1.set_xlabel("Regular commit count since compromise (n)")
ax1.set_ylabel("Decryption success")
ax1.set_title("Vector 2: Decryption success / failure after compromise")
ax1.set_xlim(0.5, 15.5)
ax1.set_ylim(-0.15, 1.3)
ax1.set_xticks(range(1, 16))
ax1.set_yticks([0, 1])
ax1.set_yticklabels(["Failure (0)", "Success (1)"])
ax1.annotate(
    "Decryption fails in all attempts",
    xy=(8, 0.05),
    fontsize=9,
    fontstyle="italic",
    color="#555555",
    ha="center",
)
ax1.annotate(
    "self-update by Alice",
    xy=(5, 0),
    xytext=(5, 0.3),
    fontsize=8.5,
    arrowprops=dict(arrowstyle="->", color="#E87B4C", shrinkB=5),
    color="#E87B4C",
    fontweight="bold",
    ha="right",
    va="center"
)
ax1.grid(linestyle="--", alpha=0.4)
fig1.tight_layout()
save_figure(fig1, "vector2_decryption_success")

# ── Figure 2: Epoch vs. Commits ──────────────────────────────────────────────
commits_n = df_results["commits_since_compromise"].astype(int).values
current_epochs = df_results["epoch"].astype(int).values
epoch_gap = current_epochs - snapshot_epoch

fig2, ax2 = plt.subplots(figsize=(7, 4))
ax2.plot(commits_n, epoch_gap, marker="o", color="#3B7DD8", linewidth=2, markersize=6)
ax2.plot(commits_n, commits_n, linestyle="--", color="#AAAAAA", linewidth=1, label="Alternative course without Alice's self-update")

# ── Annotate the jump at n=5 (alice self-update causes extra epoch advance) ──
jump_idx = list(commits_n).index(5)
ax2.annotate(
    "self-update by Alice",
    xy=(commits_n[jump_idx], epoch_gap[jump_idx]),
    xytext=(commits_n[jump_idx] + 1.5, epoch_gap[jump_idx] - 1.5),
    fontsize=8.5,
    arrowprops=dict(arrowstyle="->", color="#E87B4C", shrinkB=5),
    color="#E87B4C",
    fontweight="bold",
)
ax2.set_xlabel("Regular commit count since compromise (n)")
ax2.set_ylabel("Epoch count since compromise")
ax2.set_title("Vector 2: Course of epoch transition vs. number of commits")
ax2.set_xticks(range(1, 16))
ax2.legend(loc="upper left", fontsize=9)
ax2.grid(linestyle="--", alpha=0.4)
fig2.tight_layout()
save_figure(fig2, "vector2_epochs_and_commits")

# ── Figure 3: Cumulative path coverage ───────────────────────────────────────

# ── Preparation ──────────────────────────────────────────────────────────────
# ── MLS left-balanced tree math ──────────────────────────────────────────────
def level(x: int) -> int:
    """Number of trailing 1-bits (0 for leaves)."""
    if x & 1 == 0:
        return 0
    k = 0
    while ((x >> k) & 1) == 1:
        k += 1
    return k


def node_width(n: int) -> int:
    """Total number of nodes for n leaves."""
    return 2 * n - 1 if n > 0 else 0


def tree_root(n: int) -> int:
    """Root node index for tree with n leaves."""
    w = node_width(n)
    return (1 << int(math.log2(w))) - 1


def parent_step(x: int) -> int:
    """Parent of x in the ideal full binary tree."""
    k = level(x)
    b = (x >> (k + 1)) & 1
    return x - (1 << k) if b else x + (1 << k)


def parent(x: int, n: int) -> int:
    """Parent of x in the truncated left-balanced tree with n leaves."""
    r = tree_root(n)
    if x == r:
        return x
    p = parent_step(x)
    while p >= node_width(n):
        p = parent_step(p)
    return p


def direct_path(leaf_node: int, n: int) -> list[int]:
    """Internal nodes from leaf to root (excluding leaf, including root)."""
    path = []
    r = tree_root(n)
    current = leaf_node
    while current != r:
        current = parent(current, n)
        path.append(current)
    return path

# ── Derive tree parameters ───────────────────────────────────────────────────
n_members = df[df["event"] == "member_joined"]["client_id"].nunique() + 1
max_n = int(df_results["commits_since_compromise"].max())

N_LEAVES = n_members
ALICE_LEAF = 1
SNAPSHOT_LEAF = N_LEAVES - 1

WIDTH = node_width(N_LEAVES)
ROOT_NODE = tree_root(N_LEAVES)
internal_nodes = [i for i in range(WIDTH) if i & 1 == 1]
n_internal = len(internal_nodes)

update_candidate_leaves = [
    i for i in range(N_LEAVES) if i != ALICE_LEAF and i != SNAPSHOT_LEAF
]

# ── Compute cumulative path coverage ────────────────────────────────────────
refreshed_nodes: set[int] = set()
coverage_values: list[float] = []

for n in range(1, max_n + 1):
    updater_leaf = update_candidate_leaves[(n - 1) % len(update_candidate_leaves)]
    updater_tree_node = 2 * updater_leaf
    dp = direct_path(updater_tree_node, N_LEAVES)
    refreshed_nodes.update(dp)

    if n == 5:
        alice_tree_node = 2 * ALICE_LEAF
        alice_dp = direct_path(alice_tree_node, N_LEAVES)
        refreshed_nodes.update(alice_dp)

    coverage = len(refreshed_nodes) / n_internal * 100
    coverage_values.append(coverage)

commits_n_cov = list(range(1, max_n + 1))
full_coverage_n = next(
    (i + 1 for i, c in enumerate(coverage_values) if c >= 100.0), None
)

# ── Figure 3: Cumulative path coverage ──────────────────────────────────────
fig3, ax3 = plt.subplots(figsize=(7, 4))

ax3.step(commits_n_cov, coverage_values, where="post", color="#3B7DD8", linewidth=2.2)
ax3.scatter(commits_n_cov, coverage_values, color="#3B7DD8", s=30, zorder=5)

ax3.axhline(
    y=100, color="#999999", linestyle=":", linewidth=0.8, label="Full coverage (100 %)"
)

if full_coverage_n is not None:
    ax3.axvline(x=full_coverage_n, color="#2CA02C", linestyle="--", linewidth=1.2, alpha=0.7)
    ax3.annotate(
        f"100 % from n = {full_coverage_n}",
        xy=(full_coverage_n, 100),
        xytext=(full_coverage_n + 1.5, 75),
        fontsize=8.5,
        arrowprops=dict(arrowstyle="->", color="#2CA02C", shrinkB=5),
        color="#2CA02C",
        fontweight="bold",
    )

ax3.annotate(
    "self-update by Alice",
    xy=(5, coverage_values[4]),
    xytext=(4.25, coverage_values[4] - 35),
    fontsize=8.5,
    arrowprops=dict(arrowstyle="->", color="#E87B4C", shrinkB=5),
    color="#E87B4C",
    fontweight="bold",
)

ax3.set_xlabel("Regular commit count since compromise (n)")
ax3.set_ylabel("Cumulative path coverage (in %)")
ax3.set_title("Vector 2: Cumulative internal node refresh since compromise")
ax3.set_xlim(0.5, max_n + 0.5)
ax3.set_ylim(0, 110)
ax3.set_xticks(range(1, max_n + 1))
ax3.set_yticks([0, 25, 50, 75, 100])
ax3.legend(loc="lower right", fontsize=9)
ax3.grid(linestyle="--", alpha=0.4)

fig3.tight_layout()
save_figure(fig3, "vector2_path_coverage")

print("Vector 2 analysis complete. 3 figures generated.")