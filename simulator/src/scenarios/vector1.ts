/**
 * Vector 1 — Metadata Inference and Traffic Analysis
 * Owner: Simon
 *
 * Goal: Show that a passive observer at the relay can distinguish MLS operation types
 * (add, remove, self-update, application message) purely from observable metadata
 * (message size and timing), without any access to encrypted content.
 *
 * Scenario sequence:
 *   Setup: 5-client group
 *   Phase 1: 50 application messages
 *   Phase 2: Add 5 new members (one by one)
 *   Phase 3: 50 application messages
 *   Phase 4: 10 self-update commits (one per current member)
 *   Phase 5: 50 application messages
 *   Phase 6: Remove 3 members
 *   Phase 7: 30 application messages
 *
 * Relay: pure observation — no delay, no drops.
 */

import seedrandom from "seedrandom";
import { MlsClient } from "../mls/MlsClient";
import { Relay } from "../relay/Relay";
import { Logger } from "../logger/Logger";
import { DEFAULT_RELAY_CONFIG } from "../mls/types";
import type { RelayMessage } from "../mls/types";

export async function runVector1(seed: number): Promise<void> {
  const rng = seedrandom(String(seed));
  const runId = `v1_seed${seed}`;

  // ── Bootstrap group with 5 initial members ──────────────────────────────
  const initialCount = 5;
  const clients: MlsClient[] = [];
  for (let i = 0; i < initialCount; i++) {
    clients.push(await MlsClient.create(`member_${i}`));
  }

  // member_0 creates the group
  await clients[0].createGroup();

  const logger = new Logger({ scenario: "vector1", runId, groupId: clients[0].groupId });
  logger.log({ event: "scenario_start", timestamp: Date.now(), detail: `seed=${seed}` });

  const relay = new Relay(DEFAULT_RELAY_CONFIG, logger, rng);

  // Wire up relay subscribers — all clients receive every group-wide message
  for (const client of clients) {
    relay.subscribe(client.clientId, async (msg: RelayMessage) => {
      if (msg.messageType === "commit") {
        await client.processCommit(msg.payload);
        logger.setGroupState(client.epoch, client.memberCount);
      }
    });
  }

  // Helper: send one application message from a random member
  async function sendAppMessage(): Promise<void> {
    const sender = clients[Math.floor(rng() * clients.length)];
    const payload = randomPayload(rng, 10, 100);
    const { ciphertext } = await sender.encrypt(payload);
    const recipients = clients
      .filter((c) => c.clientId !== sender.clientId)
      .map((c) => c.clientId);
    await relay.send(sender.clientId, recipients, ciphertext, "application", sender.epoch, sender.groupId);
  }

  // Add members 1..4 to the group (member_0 already created it)
  for (let i = 1; i < initialCount; i++) {
    const kp = await clients[i].generateKeyPackage();
    const { commit, welcome } = await clients[0].addMember(kp.keyPackage);
    logger.setGroupState(clients[0].epoch, clients[0].memberCount);

    // Deliver commit to existing members (except creator)
    const existingRecipients = clients.slice(0, i).filter((c) => c !== clients[0]).map((c) => c.clientId);
    if (existingRecipients.length > 0) {
      await relay.send(clients[0].clientId, existingRecipients, commit, "commit", clients[0].epoch, clients[0].groupId);
    }
    // Deliver welcome to new member
    await relay.send(clients[0].clientId, [clients[i].clientId], welcome, "welcome", clients[0].epoch, clients[0].groupId);
    await clients[i].joinGroup(welcome);
    logger.log({ event: "member_joined", timestamp: Date.now(), client_id: clients[i].clientId });
  }

  // ── Phase 1: 50 application messages ────────────────────────────────────
  for (let i = 0; i < 50; i++) {
    await sendAppMessage();
  }

  // ── Phase 2: Add 5 more members ─────────────────────────────────────────
  const newMembers: MlsClient[] = [];
  for (let i = 0; i < 5; i++) {
    const newClient = await MlsClient.create(`new_member_${i}`);
    newMembers.push(newClient);
    relay.subscribe(newClient.clientId, async (msg: RelayMessage) => {
      if (msg.messageType === "commit") {
        await newClient.processCommit(msg.payload);
      }
    });

    const kp = await newClient.generateKeyPackage();
    const adder = clients[0];
    const { commit, welcome } = await adder.addMember(kp.keyPackage);
    logger.setGroupState(adder.epoch, adder.memberCount);

    const existingIds = clients.map((c) => c.clientId);
    await relay.send(adder.clientId, existingIds.filter((id) => id !== adder.clientId), commit, "commit", adder.epoch, adder.groupId);
    await relay.send(adder.clientId, [newClient.clientId], welcome, "welcome", adder.epoch, adder.groupId);
    await newClient.joinGroup(welcome);
    clients.push(newClient);
    logger.log({ event: "member_joined", timestamp: Date.now(), client_id: newClient.clientId });
  }

  // ── Phase 3: 50 application messages ────────────────────────────────────
  for (let i = 0; i < 50; i++) {
    await sendAppMessage();
  }

  // ── Phase 4: 10 self-updates ─────────────────────────────────────────────
  for (let i = 0; i < Math.min(10, clients.length); i++) {
    const updater = clients[i];
    const { commit } = await updater.selfUpdate();
    logger.setGroupState(updater.epoch, updater.memberCount);
    const recipients = clients.filter((c) => c !== updater).map((c) => c.clientId);
    await relay.send(updater.clientId, recipients, commit, "commit", updater.epoch, updater.groupId);
  }

  // ── Phase 5: 50 application messages ────────────────────────────────────
  for (let i = 0; i < 50; i++) {
    await sendAppMessage();
  }

  // ── Phase 6: Remove 3 members ────────────────────────────────────────────
  for (let i = 0; i < 3; i++) {
    const remover = clients[0];
    // Remove the last member (leaf at index clients.length - 1)
    const leafIndex = clients.length - 1;
    const removed = clients[leafIndex];
    const { commit } = await remover.removeMember(leafIndex);
    logger.setGroupState(remover.epoch, remover.memberCount);
    const recipients = clients.filter((c) => c !== remover && c !== removed).map((c) => c.clientId);
    await relay.send(remover.clientId, recipients, commit, "commit", remover.epoch, remover.groupId);
    logger.log({ event: "member_removed", timestamp: Date.now(), client_id: removed.clientId });
    removed.destroy();
    clients.splice(leafIndex, 1);
  }

  // ── Phase 7: 30 application messages ────────────────────────────────────
  for (let i = 0; i < 30; i++) {
    await sendAppMessage();
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────
  logger.log({ event: "scenario_end", timestamp: Date.now() });
  logger.close();
  for (const c of clients) {
    c.destroy();
  }

  console.log(`[vector1] Done. Log: logs/vector1_${runId}.jsonl`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Random ASCII payload between minLen and maxLen bytes. */
function randomPayload(rng: () => number, minLen: number, maxLen: number): string {
  const len = minLen + Math.floor(rng() * (maxLen - minLen + 1));
  let s = "";
  for (let i = 0; i < len; i++) {
    s += String.fromCharCode(32 + Math.floor(rng() * 94));
  }
  return s;
}
