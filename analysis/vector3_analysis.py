"""
Vector 3 Analysis — Async Delivery / Backlog
Owner: Ognjen

Produces:
  figures/vector3_sync_time.pdf — sync_duration_ms vs backlog_size + linear fit
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import load_log, save_figure, ROOT

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy.stats import linregress

log_path = Path(sys.argv[1]) if len(sys.argv) > 1 else next((ROOT / "logs").glob("vector3_*.jsonl"), None)
if log_path is None or not log_path.exists():
    raise FileNotFoundError("No vector3 log found.")

df = load_log(log_path)
df_sync = df[df["event"] == "sync_completed"].copy()

fig, ax = plt.subplots(figsize=(7, 4))
ax.scatter(df_sync["backlog_size"], df_sync["sync_duration_ms"], color="#4C9BE8", s=60, zorder=3)

# Linear fit
if len(df_sync) >= 2:
    slope, intercept, r, *_ = linregress(df_sync["backlog_size"], df_sync["sync_duration_ms"])
    x_fit = np.linspace(df_sync["backlog_size"].min(), df_sync["backlog_size"].max(), 100)
    ax.plot(x_fit, slope * x_fit + intercept, color="black", linewidth=1.5,
            label=f"Linear fit (r²={r**2:.2f})")
    ax.legend(fontsize=9)

ax.set_xlabel("Backlog size (missed epochs)")
ax.set_ylabel("Sync duration (ms)")
ax.set_title("State Catch-up Time vs Backlog Size")
ax.grid(linestyle="--", alpha=0.4)

save_figure(fig, "vector3_sync_time")
print("Vector 3 analysis complete.")
