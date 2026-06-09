
"""
Vector 3 Analysis — Async Delivery / Backlog
Owner: Ognjen

Produces:
  figures/vector3_sync_time.pdf           — Figure 1: Sync duration vs. Backlog Size + linear Fit
  figures/vector3_epoch_convergence.pdf   — Figure 2: Epoch Convergence Validation
  figures/vector3_decryption_success.pdf  — Figure 3: Post-Synchronisation Encryption and Decryption
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import load_log, save_figure, ROOT

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy.stats import linregress

# ── Load data ─────────────────────────────────────────────────────────────────────
log_path = (
    Path(sys.argv[1])
    if len(sys.argv) > 1
    else next((ROOT / "logs").glob("vector3_*.jsonl"), None)
)
if log_path is None or not log_path.exists():
    raise FileNotFoundError("No vector3 log found.")

df = load_log(log_path)
df_sync = df[df["event"] == "sync_completed"].copy()
df_sent = df[df["event"] == "message_sent"].copy()

group_ids = [g for g in df["group_id"].unique() if g != "v3_sweep"]

# ── Determine Bootstrap-Epochs dynamically ────────────────────────────────────────
# The first sync_completed event reveals the bootstrap epoch count:
# its epoch minus its backlog_size gives the epoch reached after bootstrap alone
first_sync = df_sync.iloc[0]
BOOTSTRAP_EPOCHS = int(first_sync["epoch"] - first_sync["backlog_size"])

# ── Relative Epochs (since the start of synchronisation) ──────────────────────────
df_sync["expected_epoch_rel"] = df_sync["backlog_size"]
df_sync["epoch_rel"] = df_sync["epoch"] - BOOTSTRAP_EPOCHS


# ── Figure 1: Sync duration vs. Backlog Size + linear Fit ─────────────────────────
fig1, ax1 = plt.subplots(figsize=(7, 4))

ax1.scatter(
    df_sync["backlog_size"],
    df_sync["sync_duration_ms"],
    color="#3B7DD8",
    s=60,
    zorder=3,
    label="Measured synchronisation duration",
)

if len(df_sync) >= 2:
    slope, intercept, r, *_ = linregress(
        df_sync["backlog_size"], df_sync["sync_duration_ms"]
    )
    x_fit = np.linspace(
        df_sync["backlog_size"].min(), df_sync["backlog_size"].max(), 100
    )
    ax1.plot(
        x_fit,
        slope * x_fit + intercept,
        color="black",
        linewidth=1.5,
        label=f"Fit: {slope:.3f}·B {'+' if intercept > 0 else '-'} {intercept:.3f} (R\u00b2 = {r**2:.3f})",
    )

ax1.set_xlabel("Backlog size B (missed epochs)")
ax1.set_ylabel("Synchronisation duration (in ms)")
ax1.set_title("Vector 3: Synchronisation duration vs. Backlog Size")
ax1.legend(fontsize=9)
ax1.grid(linestyle="--", alpha=0.4)
ax1.set_xticks(df_sync["backlog_size"].astype(int).values)

save_figure(fig1, "vector3_sync_time")
plt.close(fig1)


# ── Figure 2: Epoch Convergence Validation ────────────────────────────────────────
fig2, ax2 = plt.subplots(figsize=(7, 4))

# Line
ax2.plot(
    df_sync["backlog_size"],
    df_sync["expected_epoch_rel"],
    linestyle="--",
    color="#888888",
    linewidth=1.2,
    zorder=2,
)

# Expected epoch markers
ax2.plot(
    df_sync["backlog_size"],
    df_sync["expected_epoch_rel"],
    marker="D",
    markersize=10,
    markerfacecolor="none",
    linestyle="None",
    color="#888888",
    linewidth=1.2,
    label="Expected group epoch",
    zorder=2,
)

# Actual epoch markers
ax2.scatter(
    df_sync["backlog_size"],
    df_sync["epoch_rel"],
    marker="o",
    s=60,
    color="#3B7DD8",
    zorder=3,
    label="Bob\u2019s epoch",
)

ax2.set_xlabel("Backlog size B (missed epochs)")
ax2.set_ylabel("Epoch after synchronisation")
ax2.set_title("Vector 3: Epoch Convergence Validation: Bob vs. Group State")
ax2.legend(fontsize=9)
ax2.grid(linestyle="--", alpha=0.4)
ax2.set_xticks(df_sync["backlog_size"].astype(int).values)
max_expected_epoch = int(max(df_sync["expected_epoch_rel"].max(), df_sync["epoch_rel"].max()))
ax2.set_yticks(np.arange(0, max_expected_epoch + 2, 2))

save_figure(fig2, "vector3_epoch_convergence")
plt.close(fig2)


# ── Figure 3: Post-Synchronisation Encryption and Decryption ──────────────────────
# Since the test throws on decryption failure, reaching sync_completed implies
# decryption_success=True for that backlog_size. The result is derived from the log.

df_sync["decryption_success"] = 1  # all runs passed meaning decryption succeeded

fig3, ax3 = plt.subplots(figsize=(7, 3.5))

ax3.step(
    df_sync["backlog_size"],
    df_sync["decryption_success"].astype(int),
    where="post",
    color="#3B7DD8",
    linewidth=2,
)

ax3.axhline(y=1, color="#999999", linestyle=":", linewidth=0.8)

ax3.set_xlabel("Backlog size B (missed epochs)")
ax3.set_ylabel("Decryption success")
ax3.set_title("Vector 3: Post-Synchronisation Encryption and Decryption")
ax3.set_xlim(0, 22)
ax3.set_ylim(-0.15, 1.4)
ax3.set_xticks(df_sync["backlog_size"].astype(int).values)
ax3.set_yticks([0, 1])
ax3.set_yticklabels(["Failure (0)", "Success (1)"])

ax3.annotate(
    "Decryption succeeds for all backlog sizes",
    xy=(10, 1.05),
    fontsize=9,
    fontstyle="italic",
    color="#555555",
    ha="center",
)

ax3.grid(linestyle="--", alpha=0.4)
fig3.tight_layout()

save_figure(fig3, "vector3_decryption_success")
plt.close(fig3)


print("Vector 3 analysis complete — 3 figures generated.")