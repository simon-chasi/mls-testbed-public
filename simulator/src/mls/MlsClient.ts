import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import * as readline from "readline";
import * as path from "path";
import type { B64 } from "./types";

const MLS_CLI_PATH =
  process.env.MLS_CLI_PATH ??
  path.resolve(__dirname, "../../../mls-cli/target/release/mls-cli");

let _reqCounter = 0;

/**
 * MlsClient wraps a long-running mls-cli subprocess.
 * One instance = one simulated MLS client.
 *
 * Each call spawns NO new process — the process is created once at construction
 * and kept alive until destroy() is called or stdin closes.
 */
export class MlsClient {
  readonly clientId: string;
  groupId: string = "";
  epoch: number = 0;
  memberCount: number = 0;

  private proc: ChildProcessWithoutNullStreams;
  private rl: readline.Interface;
  private pending = new Map<
    string,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();

  private constructor(clientId: string, proc: ChildProcessWithoutNullStreams) {
    this.clientId = clientId;
    this.proc = proc;

    this.rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });

    this.rl.on("line", (line) => {
      const msg = JSON.parse(line) as Record<string, unknown>;
      const id = msg["id"] as string | null;
      if (!id) return;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (msg["ok"] === false) {
        entry.reject(new Error(String(msg["error"] ?? "mls-cli error")));
      } else {
        entry.resolve(msg);
      }
    });

    proc.stderr.on("data", (d: Buffer) =>
      process.stderr.write(`[mls-cli/${clientId}] ${d.toString()}`)
    );
  }

  /** Spawn a new mls-cli process and send the init command. */
  static async create(clientId: string): Promise<MlsClient> {
    const proc = spawn(MLS_CLI_PATH, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const client = new MlsClient(clientId, proc);
    await client.call({ cmd: "init", client_id: clientId });
    return client;
  }

  /** Generate a key package for this client (to be added to a group by someone else). */
  async generateKeyPackage(): Promise<{ keyPackage: B64; keyPackageSize: number }> {
    const res = await this.call({ cmd: "generate_key_package" });
    return {
      keyPackage: res["key_package"] as B64,
      keyPackageSize: res["key_package_size"] as number,
    };
  }

  /** Create a new MLS group. Sets this.groupId, this.epoch, this.memberCount. */
  async createGroup(): Promise<void> {
    const res = await this.call({ cmd: "create_group" });
    this.groupId = res["group_id"] as string;
    this.epoch = res["epoch"] as number;
    this.memberCount = res["member_count"] as number;
  }

  /**
   * Add a member using their key package.
   * Returns the commit + welcome bytes and their sizes.
   * Updates this.epoch and this.memberCount.
   */
  async addMember(keyPackage: B64): Promise<{
    commit: B64;
    commitSize: number;
    welcome: B64;
    welcomeSize: number;
  }> {
    const res = await this.call({ cmd: "add_member", key_package: keyPackage });
    this.epoch = res["epoch"] as number;
    this.memberCount = res["member_count"] as number;
    return {
      commit: res["commit"] as B64,
      commitSize: res["commit_size"] as number,
      welcome: res["welcome"] as B64,
      welcomeSize: res["welcome_size"] as number,
    };
  }

  /**
   * Join a group from a welcome message.
   * Sets this.groupId, this.epoch, this.memberCount.
   */
  async joinGroup(welcome: B64): Promise<void> {
    const res = await this.call({ cmd: "join_group", welcome });
    this.groupId = res["group_id"] as string;
    this.epoch = res["epoch"] as number;
    this.memberCount = res["member_count"] as number;
  }

  /**
   * Apply a commit from another member.
   * Returns false if the commit cannot be applied (wrong epoch, etc.).
   */
  async processCommit(commit: B64): Promise<boolean> {
    try {
      const res = await this.call({ cmd: "process_commit", commit });
      this.epoch = res["epoch"] as number;
      this.memberCount = res["member_count"] as number;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Remove a member by leaf index (inline commit).
   * Returns the commit bytes and size.
   */
  async removeMember(leafIndex: number): Promise<{ commit: B64; commitSize: number }> {
    const res = await this.call({ cmd: "remove_member", leaf_index: leafIndex });
    this.epoch = res["epoch"] as number;
    this.memberCount = res["member_count"] as number;
    return {
      commit: res["commit"] as B64,
      commitSize: res["commit_size"] as number,
    };
  }

  /**
   * Self-update: generate Update proposal and commit inline.
   * Returns commit bytes and size.
   */
  async selfUpdate(): Promise<{ commit: B64; commitSize: number }> {
    const res = await this.call({ cmd: "self_update" });
    this.epoch = res["epoch"] as number;
    this.memberCount = res["member_count"] as number;
    return {
      commit: res["commit"] as B64,
      commitSize: res["commit_size"] as number,
    };
  }

  /** Encrypt a plaintext string. Returns ciphertext bytes and size. */
  async encrypt(plaintext: string): Promise<{ ciphertext: B64; size: number }> {
    const res = await this.call({ cmd: "encrypt", plaintext });
    return {
      ciphertext: res["ciphertext"] as B64,
      size: res["size"] as number,
    };
  }

  /**
   * Try to decrypt a ciphertext with this client's current state.
   * Returns { success: true, plaintext } or { success: false }.
   */
  async decrypt(ciphertext: B64): Promise<{ success: boolean; plaintext?: string }> {
    try {
      const res = await this.call({ cmd: "decrypt", ciphertext });
      if (res["success"] === true) {
        return { success: true, plaintext: res["plaintext"] as string };
      }
      return { success: false };
    } catch {
      return { success: false };
    }
  }

  /** Get current epoch, member count, and member list. */
  async getInfo(): Promise<{
    epoch: number;
    memberCount: number;
    members: Array<{ leafIndex: number }>;
  }> {
    const res = await this.call({ cmd: "get_info" });
    return {
      epoch: res["epoch"] as number,
      memberCount: res["member_count"] as number,
      members: res["members"] as Array<{ leafIndex: number }>,
    };
  }

  /** Terminate the mls-cli process. Call when the client is no longer needed. */
  destroy(): void {
    try {
      this.proc.stdin.end();
      this.proc.kill();
    } catch {
      // already dead
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private call(cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = `r${++_reqCounter}`;
    const payload = JSON.stringify({ ...cmd, id }) + "\n";

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }
}
