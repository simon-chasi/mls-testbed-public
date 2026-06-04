/** Base64url-encoded byte string (no padding) */
export type B64 = string;

export type MessageType = "commit" | "welcome" | "application" | "key_package";

export type LogEventType =
  | "scenario_start"
  | "scenario_end"
  | "message_sent"
  | "message_delivered"
  | "message_dropped"
  | "epoch_changed"
  | "member_joined"
  | "member_removed"
  | "client_state_snapshot"
  | "decryption_result"
  | "sync_completed";

/** A message travelling through the relay */
export interface RelayMessage {
  id: string;
  timestamp: number;    // Date.now() ms
  from: string;         // sender clientId
  to: string[];         // intended recipients
  messageType: MessageType;
  payload: B64;
  size: number;         // payload byte length
  epoch: number;
  groupId: string;
}

/** Relay configuration for a scenario run */
export interface RelayConfig {
  delayMs: number;             // fixed delay per message (ms)
  jitterMs: number;            // uniform random jitter 0..jitterMs added on top
  dropRate: number;            // fraction dropped [0.0, 1.0]
  reorderWindowSize: number;   // buffer N messages then deliver shuffled; 0 = off
  activeAttacker: boolean;     // allow inject/replay APIs
}

export const DEFAULT_RELAY_CONFIG: RelayConfig = {
  delayMs: 0,
  jitterMs: 0,
  dropRate: 0,
  reorderWindowSize: 0,
  activeAttacker: false,
};

/** Structured log event written to JSONL */
export interface LogEvent {
  event: LogEventType;
  timestamp: number;
  scenario: string;
  run_id: string;
  group_id: string;
  epoch: number;
  member_count: number;
  // message fields
  message_id?: string;
  from?: string;
  to?: string[];
  message_type?: MessageType;
  payload_size?: number;
  delivered_at?: number;
  delayed_ms?: number;
  dropped?: boolean;
  replayed?: boolean;
  // state / membership events
  client_id?: string;
  detail?: string;
  // vector-2 specific
  commits_since_compromise?: number;
  decryption_success?: boolean;
  // vector-3 specific
  backlog_size?: number;
  sync_duration_ms?: number;
}
