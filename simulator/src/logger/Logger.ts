import * as fs from "fs";
import * as path from "path";
import type { LogEvent, LogEventType } from "../mls/types";

const LOG_DIR = process.env.LOG_DIR ?? path.resolve(__dirname, "../../../logs");

export class Logger {
  private fd: number;
  private scenario: string;
  private runId: string;
  private groupId: string;
  private currentEpoch = 0;
  private currentMemberCount = 0;

  constructor(opts: {
    scenario: string;
    runId: string;
    groupId: string;
  }) {
    this.scenario = opts.scenario;
    this.runId = opts.runId;
    this.groupId = opts.groupId;

    fs.mkdirSync(LOG_DIR, { recursive: true });
    const logPath = path.join(LOG_DIR, `${opts.scenario}_${opts.runId}.jsonl`);
    this.fd = fs.openSync(logPath, "w");
  }

  /** Update the default epoch/member_count stamped on every subsequent event. */
  setGroupState(epoch: number, memberCount: number): void {
    this.currentEpoch = epoch;
    this.currentMemberCount = memberCount;
  }

  /** Write a log event. Fields not provided default to current group state. */
  log(
    partial: Omit<LogEvent, "scenario" | "run_id" | "group_id" | "epoch" | "member_count"> &
      Partial<Pick<LogEvent, "group_id" | "epoch" | "member_count">> & {
        event: LogEventType;
        timestamp: number;
      }
  ): void {
    const entry: LogEvent = {
      scenario: this.scenario,
      run_id: this.runId,
      group_id: partial.group_id ?? this.groupId,
      epoch: partial.epoch ?? this.currentEpoch,
      member_count: partial.member_count ?? this.currentMemberCount,
      ...partial,
    };
    fs.writeSync(this.fd, JSON.stringify(entry) + "\n");
  }

  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      // already closed
    }
  }
}
