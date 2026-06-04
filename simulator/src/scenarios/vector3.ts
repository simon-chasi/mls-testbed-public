/**
 * Vector 3 — Delayed Delivery and Asynchronous State Synchronisation
 * Owner: Ogi
 *
 * Goal: Show that MLS correctly converges after a client misses multiple
 * epochs, and measure the cost of processing a commit backlog.
 *
 * For each backlog_size in [1, 3, 5, 10, 20]:
 *  1. Bootstrap a fresh 10-member group (including bob)
 *  2. Take bob offline — commits to bob are buffered
 *  3. Other members perform backlog_size self-updates; bob receives none
 *  4. Bring bob back online — deliver all buffered commits in order
 *  5. Verify bob's epoch matches the group epoch
 *  6. Bob encrypts a test message; a peer decrypts it (verifies convergence)
 *  7. Log a sync_completed event with backlog_size and sync_duration_ms
 */

import seedrandom from "seedrandom";
import { MlsClient } from "../mls/MlsClient";
import { Relay } from "../relay/Relay";
import { Logger } from "../logger/Logger";
import { DEFAULT_RELAY_CONFIG } from "../mls/types";
import type { RelayMessage } from "../mls/types";

const MEMBER_COUNT = 10;
const BOB_IDX = 1;
const BACKLOG_SIZES = [1, 3, 5, 10, 20];

export async function runVector3(seed: number): Promise<void> {
  const rng = seedrandom(String(seed));
  const runId = `v3_seed${seed}`;

  // A single logger covers all runs; groupId is overwritten per run
  const logger = new Logger({ scenario: "vector3", runId, groupId: "v3_sweep" });
  logger.log({ event: "scenario_start", timestamp: Date.now(), detail: `seed=${seed}` });

  for (const backlogSize of BACKLOG_SIZES) {
    await runBacklogTrial(backlogSize, logger, rng);
  }

  logger.log({ event: "scenario_end", timestamp: Date.now() });
  logger.close();

  console.log(`[vector3] Done. Log: logs/vector3_${runId}.jsonl`);
}

async function runBacklogTrial(
  backlogSize: number,
  logger: Logger,
  rng: () => number,
): Promise<void> {
  const clients: MlsClient[] = [];
  for (let i = 0; i < MEMBER_COUNT; i++) {
    const name = i === BOB_IDX ? "bob" : `member_${i}`;
    clients.push(await MlsClient.create(name));
  }

  const bob = clients[BOB_IDX];

  await clients[0].createGroup();
  logger.setGroupState(clients[0].epoch, clients[0].memberCount);

  const relay = new Relay(DEFAULT_RELAY_CONFIG, logger, rng);

  // bob starts online — he must process bootstrap commits to become a member
  let bobOnline = true;
  const bobBacklog: string[] = [];

  for (const client of clients) {
    if (client === bob) {
      relay.subscribe(bob.clientId, async (msg: RelayMessage) => {
        if (msg.messageType === "commit") {
          if (bobOnline) {
            await bob.processCommit(msg.payload);
            logger.setGroupState(bob.epoch, bob.memberCount);
          } else {
            bobBacklog.push(msg.payload);
          }
        }
      });
    } else {
      relay.subscribe(client.clientId, async (msg: RelayMessage) => {
        if (msg.messageType === "commit") {
          await client.processCommit(msg.payload);
          logger.setGroupState(client.epoch, client.memberCount);
        }
      });
    }
  }

  // ── Bootstrap: add members 1..9 sequentially ──────────────────────────────
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

  // ── Take bob offline ───────────────────────────────────────────────────────
  bobOnline = false;
  bobBacklog.length = 0;

  // ── backlogSize self-updates from non-bob members ──────────────────────────
  const updateCandidates = clients.filter(c => c !== bob);
  for (let n = 0; n < backlogSize; n++) {
    const updater = updateCandidates[n % updateCandidates.length];
    const { commit } = await updater.selfUpdate();
    logger.setGroupState(updater.epoch, updater.memberCount);

    const recipients = clients.filter(c => c !== updater).map(c => c.clientId);
    await relay.send(updater.clientId, recipients, commit, "commit", updater.epoch, updater.groupId);
  }

  // ── Bring bob back online — deliver buffered commits in order ──────────────
  const syncStart = Date.now();
  bobOnline = true;
  for (const commit of bobBacklog) {
    await bob.processCommit(commit);
  }
  const syncDurationMs = Date.now() - syncStart;
  logger.setGroupState(bob.epoch, bob.memberCount);

  // ── Verify epoch convergence ───────────────────────────────────────────────
  const expectedEpoch = updateCandidates[0].epoch;
  if (bob.epoch !== expectedEpoch) {
    throw new Error(
      `[vector3] Epoch mismatch after sync: bob=${bob.epoch}, expected=${expectedEpoch} (backlogSize=${backlogSize})`
    );
  }

  // ── Verify bob can participate: encrypt and have a peer decrypt ────────────
  const { ciphertext } = await bob.encrypt(`sync_test_backlog${backlogSize}`);
  const decryptResult = await clients[0].decrypt(ciphertext);
  if (!decryptResult.success) {
    throw new Error(`[vector3] Peer could not decrypt bob's message after sync (backlogSize=${backlogSize})`);
  }

  logger.log({
    event: "sync_completed",
    timestamp: Date.now(),
    backlog_size: backlogSize,
    sync_duration_ms: syncDurationMs,
    epoch: bob.epoch,
    client_id: bob.clientId,
  });

  for (const c of clients) c.destroy();

  console.log(`[vector3] backlogSize=${backlogSize}: sync in ${syncDurationMs}ms, epoch=${bob.epoch}`);
}
