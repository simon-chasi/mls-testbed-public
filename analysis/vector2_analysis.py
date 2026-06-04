"""
Vector 2 Analysis — PCS Recovery
Owner: Ognjen

Produces:
  figures/vector2_pcs_recovery.pdf — decryption_success vs commits_since_compromise
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import load_log, save_figure, ROOT

import matplotlib.pyplot as plt
import pandas as pd

log_path = Path(sys.argv[1]) if len(sys.argv) > 1 else next((ROOT / "logs").glob("vector2_*.jsonl"), None)
if log_path is None or not log_path.exists():
    raise FileNotFoundError("No vector2 log found.")

df = load_log(log_path)
df_results = df[df["event"] == "decryption_result"].copy()

fig, ax = plt.subplots(figsize=(7, 3.5))
ax.step(
    df_results["commits_since_compromise"],
    df_results["decryption_success"].astype(int),
    where="post",
    color="#E87B4C",
    linewidth=2,
)
ax.set_xlabel("Commits since compromise")
ax.set_ylabel("Decryption success (1 = yes, 0 = no)")
ax.set_title("Post-Compromise Security Recovery")
ax.set_ylim(-0.1, 1.3)
ax.grid(linestyle="--", alpha=0.4)

save_figure(fig, "vector2_pcs_recovery")
print("Vector 2 analysis complete.")
