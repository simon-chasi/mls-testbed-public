/**
 * Vector 4 — Commit-Size Scaling and the O(log N) Side-Channel
 * Owner: Simon
 *
 * Goal: Empirically verify that MLS commit sizes scale as O(log N) with
 * group size N, confirming the theoretical prediction from TreeKEM's
 * direct-path structure and demonstrating that a passive relay observer
 * can infer approximate group cardinality from a single commit message —
 * without access to encrypted content.
 *
 * Method:
 *   For each N in GROUP_SIZES, a fresh group of N members is bootstrapped.
 *   After an initial stabilisation round (one self-update per non-creator
 *   member, ensuring every leaf carries commit-source key material), every
 *   member performs one measured self-update commit. This yields N data
 *   points per group size, capturing both the mean commit size and the
 *   intra-group variance arising from differing direct-path lengths across
 *   leaf positions.
 *
 *   The resulting (group_size, commit_size) pairs are logged and can be
 *   fitted against log2(N) to confirm the linear relationship predicted by
 *   theory. The intra-group variance additionally illustrates that even
 *   the spread of observed sizes is bounded by the tree height.
 *
 * Group sizes: 4, 8, 16, 32, 64, 128
 *   Powers of two produce full binary trees, so the theoretical direct-path
 *   length floor(log2(N)) is exact — giving the cleanest baseline for the
 *   linear fit.
 *
 * Relay: pure observation — no delay, no drops.
 */

import seedrandom from "seedrandom";
import { MlsClient } from "../mls/MlsClient";
import { Relay } from "../relay/Relay";
import { Logger } from "../logger/Logger";
import { DEFAULT_RELAY_CONFIG } from "../mls/types";
import type { RelayMessage } from "../mls/types";

const GROUP_SIZES = [4, 8, 16, 32, 64, 128];

export async function runVector4(seed: number): Promise<void> {
  const rng = seedrandom(String(seed));
  const runId = `v4_seed${seed}`;

  const logger = new Logger({ scenario: "vector4", runId, groupId: "v4_sweep" });
  logger.log({
    event: "scenario_start",
    timestamp: Date.now(),
    detail: `seed=${seed}, group_sizes=${JSON.stringify(GROUP_SIZES)}`,
  });

  for (const N of GROUP_SIZES) {
    await measureGroupSize(N, logger, rng);
  }

  logger.log({ event: "scenario_end", timestamp: Date.now() });
  logger.close();

  console.log(`[vector4] Done. Log: logs/vector4_${runId}.jsonl`);
}

// ── Per-group measurement run ─────────────────────────────────────────────────

async function measureGroupSize(
  N: number,
  logger: Logger,
  rng: () => number
): Promise<void> {
  // ── Bootstrap N-member group ───────────────────────────────────────────
  const clients: MlsClient[] = [];
  for (let i = 0; i < N; i++) {
    clients.push(await MlsClient.create(`n${N}_m${i}`));
  }

  await clients[0].createGroup();
  logger.setGroupState(clients[0].epoch, clients[0].memberCount);

  // A fresh relay per group run — each sweep is fully independent
  const relay = new Relay(DEFAULT_RELAY_CONFIG, logger, rng);

  for (const c of clients) {
    relay.subscribe(c.clientId, async (msg: RelayMessage) => {
      if (msg.messageType === "commit") {
        await c.processCommit(msg.payload);
      }
    });
  }

  // Add members 1..N-1 sequentially
  for (let i = 1; i < N; i++) {
    const kp = await clients[i].generateKeyPackage();
    const { commit, welcome } = await clients[0].addMember(kp.keyPackage);
    logger.setGroupState(clients[0].epoch, clients[0].memberCount);

    const priorIds = clients.slice(0, i)
      .filter((c) => c !== clients[0])
      .map((c) => c.clientId);
    if (priorIds.length > 0) {
      await relay.send(
        clients[0].clientId, priorIds,
        commit, "commit", clients[0].epoch, clients[0].groupId,
      );
    }
    await relay.send(
      clients[0].clientId, [clients[i].clientId],
      welcome, "welcome", clients[0].epoch, clients[0].groupId,
    );
    await clients[i].joinGroup(welcome);
  }

  // ── Stabilisation ─────────────────────────────────────────────────────
  // Each non-creator member commits once so that every leaf carries
  // commit-source key material. Leaves that still hold KeyPackage-source
  // material can corrupt the parent-hash chain on subsequent operations.
  for (let i = 1; i < N; i++) {
    const { commit } = await clients[i].selfUpdate();
    logger.setGroupState(clients[i].epoch, clients[i].memberCount);
    const others = clients
      .filter((c) => c !== clients[i])
      .map((c) => c.clientId);
    await relay.send(
      clients[i].clientId, others,
      commit, "commit", clients[i].epoch, clients[i].groupId,
    );
  }

  // ── Measurement ───────────────────────────────────────────────────────
  // Every member commits once. Leaf index equals join order for sequential-add
  // trees with no removes, so i is an exact proxy for leaf position.
  // Varying the committing leaf across the full tree captures the path-depth
  // variance that an observer would see in a realistic mixed trace.
  for (let i = 0; i < N; i++) {
    const committer = clients[i];
    const { commit, commitSize } = await committer.selfUpdate();
    logger.setGroupState(committer.epoch, committer.memberCount);

    logger.log({
      event: "client_state_snapshot",
      timestamp: Date.now(),
      member_count: N,
      detail: JSON.stringify({
        phase: "measurement",
        group_size: N,
        leaf_index: i,
        commit_size: commitSize,
        log2_N: Math.log2(N),
      }),
    });

    const others = clients
      .filter((c) => c !== committer)
      .map((c) => c.clientId);
    await relay.send(
      committer.clientId, others,
      commit, "commit", committer.epoch, committer.groupId,
    );
  }

  // ── Cleanup ────────────────────────────────────────────────────────────
  for (const c of clients) c.destroy();

  console.log(`[vector4] N=${N}: ${N} commit-size measurements recorded.`);
}
