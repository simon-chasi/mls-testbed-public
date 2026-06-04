import type { RelayMessage, RelayConfig, MessageType, LogEvent } from "../mls/types";
import type { Logger } from "../logger/Logger";

export type DeliveryCallback = (msg: RelayMessage) => Promise<void>;

/**
 * In-process adversarial relay.
 *
 * All MLS messages flow through the relay. Clients do not communicate directly.
 * The relay applies the configured adversarial controls (delay, drop, reorder,
 * inject/replay) and emits a log event for every message it handles.
 */
export class Relay {
  private config: RelayConfig;
  private logger: Logger;
  private subscribers = new Map<string, DeliveryCallback>();
  private reorderBuffer: RelayMessage[] = [];
  private msgCounter = 0;
  private rng: () => number;

  /**
   * @param config   Adversarial controls for this scenario run
   * @param logger   Shared logger instance
   * @param rng      Seeded PRNG — pass `seedrandom(seed)` for reproducibility
   */
  constructor(config: RelayConfig, logger: Logger, rng: () => number) {
    this.config = config;
    this.logger = logger;
    this.rng = rng;
  }

  /** Register a recipient. The callback is invoked when a message is delivered to them. */
  subscribe(clientId: string, cb: DeliveryCallback): void {
    this.subscribers.set(clientId, cb);
  }

  /**
   * Route a message through the relay.
   * Logs message_sent immediately; logs message_delivered or message_dropped after delivery.
   */
  async send(
    from: string,
    to: string[],
    payload: string,
    messageType: MessageType,
    epoch: number,
    groupId: string
  ): Promise<RelayMessage> {
    const id = `msg_${String(++this.msgCounter).padStart(4, "0")}`;
    const ts = Date.now();
    const size = Buffer.from(payload, "base64").length;

    const msg: RelayMessage = { id, timestamp: ts, from, to, messageType, payload, size, epoch, groupId };

    this.logger.log({
      event: "message_sent",
      timestamp: ts,
      message_id: id,
      from,
      to,
      message_type: messageType,
      payload_size: size,
      epoch,
      group_id: groupId,
      dropped: false,
    });

    // Drop?
    if (this.rng() < this.config.dropRate) {
      this.logger.log({
        event: "message_dropped",
        timestamp: Date.now(),
        message_id: id,
        from,
        to,
        message_type: messageType,
        payload_size: size,
        epoch,
        group_id: groupId,
        dropped: true,
      });
      return msg;
    }

    // Reorder buffer?
    if (this.config.reorderWindowSize > 0) {
      this.reorderBuffer.push(msg);
      if (this.reorderBuffer.length >= this.config.reorderWindowSize) {
        await this.flushReorderBuffer();
      }
      return msg;
    }

    await this.deliver(msg);
    return msg;
  }

  /** Flush the reorder buffer in shuffled order (Fisher-Yates with seeded RNG). */
  async flushReorderBuffer(): Promise<void> {
    const buf = this.reorderBuffer;
    this.reorderBuffer = [];
    for (let i = buf.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [buf[i], buf[j]] = [buf[j], buf[i]];
    }
    for (const msg of buf) {
      await this.deliver(msg);
    }
  }

  /** Inject a fabricated or modified message (active attacker). */
  async injectMessage(msg: RelayMessage): Promise<void> {
    if (!this.config.activeAttacker) throw new Error("activeAttacker not enabled in RelayConfig");
    await this.deliver({ ...msg, id: `inject_${msg.id}` });
  }

  /** Replay a previously routed message to its original recipients. */
  async replayMessage(msg: RelayMessage): Promise<void> {
    if (!this.config.activeAttacker) throw new Error("activeAttacker not enabled in RelayConfig");
    await this.deliver({ ...msg, id: `replay_${msg.id}`, replayed: true } as RelayMessage & { replayed: boolean });
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async deliver(msg: RelayMessage & { replayed?: boolean }): Promise<void> {
    const delay =
      this.config.delayMs +
      (this.config.jitterMs > 0 ? Math.floor(this.rng() * this.config.jitterMs) : 0);

    if (delay > 0) {
      await sleep(delay);
    }

    const deliveredAt = Date.now();

    for (const recipientId of msg.to) {
      const cb = this.subscribers.get(recipientId);
      if (cb) {
        await cb(msg);
      }
    }

    this.logger.log({
      event: "message_delivered",
      timestamp: deliveredAt,
      message_id: msg.id,
      from: msg.from,
      to: msg.to,
      message_type: msg.messageType,
      payload_size: msg.size,
      epoch: msg.epoch,
      group_id: msg.groupId,
      delivered_at: deliveredAt,
      delayed_ms: delay,
      dropped: false,
      replayed: msg.replayed ?? false,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
