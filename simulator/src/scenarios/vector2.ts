/**
 * Vector 2 — Client Compromise and Post-Compromise Security Recovery
 * Owner: Ogi
 *
 * Goal: Demonstrate that PCS works. After a client's state is snapshotted
 * ("compromised") at epoch E, subsequent commits make the snapshot unable
 * to decrypt new messages.
 *
 * Implementation note on snapshot approach:
 *   mls-rs generates a fresh signing key on every `init`, so a second process
 *   cannot re-process the original alice's welcome. Instead, alice_snapshot is
 *   added to the group as a distinct member during bootstrap and tracks every
 *   commit in lockstep with alice until the snapshot moment. After epoch E,
 *   alice_snapshot is excluded from all commit broadcasts (simulating an
 *   adversary holding the captured state offline). The live alice continues
 *   receiving and applying commits. This faithfully represents the threat model:
 *   the adversary has a complete, valid MLS state at epoch E but cannot derive
 *   the epoch E+n application keys.
 */

import seedrandom from "seedrandom";
import { MlsClient } from "../mls/MlsClient";
import { Relay } from "../relay/Relay";
import { Logger } from "../logger/Logger";
import { DEFAULT_RELAY_CONFIG } from "../mls/types";
import type { RelayMessage } from "../mls/types";

const MEMBER_COUNT = 10;
const ALICE_IDX = 1;
const SNAPSHOT_IDX = MEMBER_COUNT - 1; // index 9

export async function runVector2(seed: number): Promise<void> {
  const rng = seedrandom(String(seed));
  const runId = `v2_seed${seed}`;

  // clients[0]      — group creator
  // clients[1]      — alice (live; keeps processing commits)
  // clients[2..8]   — other members
  // clients[9]      — alice_snapshot (frozen after epoch E)
  const clients: MlsClient[] = [];
  for (let i = 0; i < MEMBER_COUNT; i++) {
    const name =
      i === ALICE_IDX     ? "alice"          :
      i === SNAPSHOT_IDX  ? "alice_snapshot" :
      `member_${i}`;
    clients.push(await MlsClient.create(name));
  }

  await clients[0].createGroup();
  const logger = new Logger({ scenario: "vector2", runId, groupId: clients[0].groupId });
  logger.log({ event: "scenario_start", timestamp: Date.now(), detail: `seed=${seed}` });

  const relay = new Relay(DEFAULT_RELAY_CONFIG, logger, rng);

  for (const client of clients) {
    relay.subscribe(client.clientId, async (msg: RelayMessage) => {
      if (msg.messageType === "commit") {
        await client.processCommit(msg.payload);
        logger.setGroupState(client.epoch, client.memberCount);
      }
    });
  }

  // ── Bootstrap: add members 1..9 sequentially ─────────────────────────────
  for (let i = 1; i < MEMBER_COUNT; i++) {
    const kp = await clients[i].generateKeyPackage();
    const { commit, welcome } = await clients[0].addMember(kp.keyPackage);
    logger.setGroupState(clients[0].epoch, clients[0].memberCount);

    const priorRecipients = clients.slice(0, i)
      .filter(c => c !== clients[0])
      .map(c => c.clientId);
    if (priorRecipients.length > 0) {
      await relay.send(clients[0].clientId, priorRecipients, commit, "commit", clients[0].epoch, clients[0].groupId);
    }
    await relay.send(clients[0].clientId, [clients[i].clientId], welcome, "welcome", clients[0].epoch, clients[0].groupId);
    await clients[i].joinGroup(welcome);
    logger.log({ event: "member_joined", timestamp: Date.now(), client_id: clients[i].clientId });
  }

  // ── Warm-up: 20 application messages ─────────────────────────────────────
  for (let i = 0; i < 20; i++) {
    const sender = clients[Math.floor(rng() * clients.length)];
    const { ciphertext } = await sender.encrypt(randomPayload(rng, 10, 100));
    const recipients = clients.filter(c => c !== sender).map(c => c.clientId);
    await relay.send(sender.clientId, recipients, ciphertext, "application", sender.epoch, sender.groupId);
  }

  // ── Snapshot moment ───────────────────────────────────────────────────────
  // From this point forward, alice_snapshot is excluded from all commit
  // recipients — its MLS subprocess stays frozen at snapshotEpoch.
  const snapshotEpoch = clients[ALICE_IDX].epoch;
  logger.log({
    event: "client_state_snapshot",
    timestamp: Date.now(),
    client_id: "alice_snapshot",
    detail: `epoch=${snapshotEpoch}`,
    epoch: snapshotEpoch,
  });

  const alice         = clients[ALICE_IDX];
  const aliceSnapshot = clients[SNAPSHOT_IDX];
  // Cycle through members that are neither alice nor alice_snapshot for self-updates
  const updateCandidates = clients.filter((_, i) => i !== ALICE_IDX && i !== SNAPSHOT_IDX);

  // ── PCS recovery loop: n = 1..15 ─────────────────────────────────────────
  for (let n = 1; n <= 15; n++) {
    // Step a: another member self-updates
    const updater = updateCandidates[(n - 1) % updateCandidates.length];
    const { commit: updateCommit } = await updater.selfUpdate();
    logger.setGroupState(updater.epoch, updater.memberCount);

    const commitRecipients = clients
      .filter(c => c !== updater && c !== aliceSnapshot)
      .map(c => c.clientId);
    await relay.send(updater.clientId, commitRecipients, updateCommit, "commit", updater.epoch, updater.groupId);

    // Step 5 (spec): at n=5 alice also self-updates, permanently refreshing her path
    if (n === 5) {
      const { commit: aliceCommit } = await alice.selfUpdate();
      logger.setGroupState(alice.epoch, alice.memberCount);
      const aliceRecipients = clients
        .filter(c => c !== alice && c !== aliceSnapshot)
        .map(c => c.clientId);
      await relay.send(alice.clientId, aliceRecipients, aliceCommit, "commit", alice.epoch, alice.groupId);
    }

    // Step c: a synced sender encrypts a test message at the current epoch
    const { ciphertext } = await clients[0].encrypt(`test_n${n}`);

    // Step d: attempt decryption with the frozen snapshot (still at snapshotEpoch)
    const result = await aliceSnapshot.decrypt(ciphertext);

    // Step e: log result
    logger.log({
      event: "decryption_result",
      timestamp: Date.now(),
      commits_since_compromise: n,
      decryption_success: result.success,
      epoch: clients[0].epoch,
      client_id: "alice_snapshot",
    });
  }

  logger.log({ event: "scenario_end", timestamp: Date.now() });
  logger.close();
  for (const c of clients) c.destroy();

  console.log(`[vector2] Done. Log: logs/vector2_${runId}.jsonl`);
}

function randomPayload(rng: () => number, minLen: number, maxLen: number): string {
  const len = minLen + Math.floor(rng() * (maxLen - minLen + 1));
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(32 + Math.floor(rng() * 94));
  return s;
}
