import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getHubDir, log, logError } from "./config.js";

// ── Interface ──────────────────────────────────────────────────────────────

export interface SecurityEvent {
  event_id: string;
  event_type: "unauthorized_contact" | "transport_reject" | "evidence_write_failure";
  channel: string;
  group_key: string;
  first_seen_at: string;
  last_seen_at: string;
  message_count: number;
  sender_count: number;
  text_count: number;
  nontext_count: number;
  source_user_ids: string[];
  evidence_ids: string[];
  blocked_reason: string;
  llm_called: boolean;
  tool_called: boolean;
  memory_written: boolean;
  main_context_alert_emitted: boolean;
  main_context_alert_count: number;
}

// ── Timers ─────────────────────────────────────────────────────────────────

const GROUP_WAIT_MS = 5000;
const GLOBAL_REPEAT_MS = 3_600_000;
const AUTO_FLUSH_MS = 5 * 60_000;

// ── Aggregator ─────────────────────────────────────────────────────────────

export class SecurityEventAggregator {
  private events = new Map<string, SecurityEvent>();
  private sourceLastSeen = new Map<string, number>();
  private lastGlobalAlertAt = 0;
  private pendingAlertTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAlertChannel: string | null = null;
  private autoFlushTimer: ReturnType<typeof setInterval> | null = null;
  private onMainContextAlert: (message: string) => void;

  constructor(onMainContextAlert: (message: string) => void) {
    this.onMainContextAlert = onMainContextAlert;
    this.autoFlushTimer = setInterval(() => this.flush(), AUTO_FLUSH_MS);
  }

  recordUnauthorized(params: {
    channel: string;
    sourceUserId: string;
    contentType: string;
    evidenceId: string;
  }): void {
    const { channel, sourceUserId, contentType, evidenceId } = params;
    const now = Date.now();
    const nowISO = new Date(now).toISOString();

    const sourceKey = `${channel}:${sourceUserId}`;
    this.sourceLastSeen.set(sourceKey, now);

    const groupKey = `${channel}:unauthorized:global`;
    let event = this.events.get(groupKey);

    if (!event) {
      event = {
        event_id: crypto.randomUUID(),
        event_type: "unauthorized_contact",
        channel,
        group_key: groupKey,
        first_seen_at: nowISO,
        last_seen_at: nowISO,
        message_count: 0,
        sender_count: 0,
        text_count: 0,
        nontext_count: 0,
        source_user_ids: [],
        evidence_ids: [],
        blocked_reason: "not_in_allowlist",
        llm_called: false,
        tool_called: false,
        memory_written: false,
        main_context_alert_emitted: false,
        main_context_alert_count: 0,
      };
      this.events.set(groupKey, event);
    }

    event.last_seen_at = nowISO;
    event.message_count++;

    if (contentType === "text") {
      event.text_count++;
    } else {
      event.nontext_count++;
    }

    if (!event.source_user_ids.includes(sourceUserId)) {
      event.source_user_ids.push(sourceUserId);
      event.sender_count = event.source_user_ids.length;
    }

    if (evidenceId && !event.evidence_ids.includes(evidenceId)) {
      event.evidence_ids.push(evidenceId);
    }

    const canAlert = now - this.lastGlobalAlertAt > GLOBAL_REPEAT_MS;
    if (canAlert && !this.pendingAlertTimer) {
      this.pendingAlertChannel = channel;
      this.pendingAlertTimer = setTimeout(() => {
        this.emitAlert();
      }, GROUP_WAIT_MS);
    }
  }

  getActiveEvents(): SecurityEvent[] {
    return Array.from(this.events.values());
  }

  flush(): void {
    if (this.events.size === 0) return;
    const filePath = path.join(getHubDir(), "security-events.jsonl");
    try {
      const lines = Array.from(this.events.values())
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n";
      fs.appendFileSync(filePath, lines, { encoding: "utf-8", mode: 0o600 });
      log(`security-event: flushed ${this.events.size} event(s) to ${filePath}`);
      this.events.clear();
      this.sourceLastSeen.clear();
    } catch (err) {
      logError(`security-event: flush failed: ${String(err)}`);
    }
  }

  flushAndStop(): void {
    if (this.pendingAlertTimer) {
      clearTimeout(this.pendingAlertTimer);
      this.pendingAlertTimer = null;
    }
    if (this.autoFlushTimer) {
      clearInterval(this.autoFlushTimer);
      this.autoFlushTimer = null;
    }
    this.flush();
  }

  private emitAlert(): void {
    this.pendingAlertTimer = null;
    const channel = this.pendingAlertChannel ?? "unknown";
    this.pendingAlertChannel = null;

    const event = this.events.get(`${channel}:unauthorized:global`);
    if (event) {
      event.main_context_alert_emitted = true;
      event.main_context_alert_count++;
    }

    this.lastGlobalAlertAt = Date.now();
    this.flush();
    this.onMainContextAlert(
      `⚠️ 检测到未授权访问尝试（${channel} 通道）。详情见 fh hub security。`,
    );
  }
}
