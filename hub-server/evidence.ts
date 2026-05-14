import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getHubDir, log, logError } from "./config.js";
import { sanitizeDisplayName } from "./sanitize.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface EvidenceRecord {
  evidence_id: string;
  received_at: string;
  channel: string;
  ingest_mode: string;
  update_id: string;
  chat_id: string | null;
  message_id: string | null;
  source_user_id: string | null;
  content_type: string;
  content_meta: Record<string, unknown>;
  transport_verified: boolean;
  auth_result: "authorized" | "unauthorized" | "transport_rejected";
  blocked_reason: string;
  raw_update_base64: string;
  raw_update_sha256: string;
  entered_llm_context: boolean;
  entered_memory: boolean;
  tool_called: boolean;
  prev_hash: string | null;
  entry_hash: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function getEvidenceDir(): string {
  return path.join(getHubDir(), "evidence");
}

export function computeRawHash(rawJson: string): string {
  return crypto.createHash("sha256").update(rawJson).digest("hex");
}

export function encodeRawUpdate(rawJson: string): string {
  return Buffer.from(rawJson).toString("base64");
}

// ── Chain State ────────────────────────────────────────────────────────────

function chainStatePath(): string {
  return path.join(getEvidenceDir(), "evidence_chain.json");
}

interface ChainState {
  last_entry_hash: string | null;
}

let cachedChainState: ChainState | null = null;

function readChainState(): ChainState {
  if (cachedChainState) return cachedChainState;
  try {
    const raw = fs.readFileSync(chainStatePath(), "utf-8");
    cachedChainState = JSON.parse(raw) as ChainState;
    return cachedChainState;
  } catch {
    cachedChainState = { last_entry_hash: null };
    return cachedChainState;
  }
}

function writeChainState(state: ChainState): void {
  cachedChainState = state;
  fs.writeFileSync(chainStatePath(), JSON.stringify(state, null, 2), { encoding: "utf-8", mode: 0o600 });
}

// ── Dedup ──────────────────────────────────────────────────────────────────

const DEDUP_CAP = 10_000;
const seenKeys = new Set<string>();

function dedupKey(channel: string, updateId: string): string {
  return `${channel}:${updateId}`;
}

function evictIfNeeded(): void {
  if (seenKeys.size <= DEDUP_CAP) return;
  // drop oldest half — Set iterates in insertion order
  const dropCount = Math.floor(DEDUP_CAP / 2);
  let i = 0;
  for (const key of seenKeys) {
    if (i++ >= dropCount) break;
    seenKeys.delete(key);
  }
}

// ── Core ───────────────────────────────────────────────────────────────────

function currentMonthFile(): string {
  const now = new Date();
  const ym = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return path.join(getEvidenceDir(), `evidence_${ym}.jsonl`);
}

function computeEntryHash(prevHash: string | null, record: Record<string, unknown>): string {
  const sortedKeys = Object.keys(record).sort();
  const canonical = JSON.stringify(record, sortedKeys);
  const payload = (prevHash ?? "") + canonical;
  return crypto.createHash("sha256").update(payload).digest("hex");
}

let dirEnsured = false;

function ensureEvidenceDir(): void {
  if (dirEnsured) return;
  const dir = getEvidenceDir();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    dirEnsured = true;
  } catch (err) {
    logError(`evidence 目录创建失败: ${String(err)}`);
    throw err;
  }
}

type AppendInput = Omit<EvidenceRecord, "evidence_id" | "prev_hash" | "entry_hash">;

export function appendEvidence(input: AppendInput): EvidenceRecord {
  const key = dedupKey(input.channel, input.update_id);
  if (seenKeys.has(key)) {
    // 已存在——从文件找到已有记录返回
    return findExistingRecord(input.channel, input.update_id) ?? buildAndWrite(input, key);
  }

  return buildAndWrite(input, key);
}

function findExistingRecord(channel: string, updateId: string): EvidenceRecord | null {
  try {
    const filePath = currentMonthFile();
    if (!fs.existsSync(filePath)) return null;
    const lines = fs.readFileSync(filePath, "utf-8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const record = JSON.parse(line) as EvidenceRecord;
        if (record.channel === channel && record.update_id === updateId) return record;
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file not readable — fall through */ }
  return null;
}

function buildAndWrite(input: AppendInput, key: string): EvidenceRecord {
  ensureEvidenceDir();

  const chainState = readChainState();
  const prevHash = chainState.last_entry_hash;

  const record: Record<string, unknown> = {
    evidence_id: crypto.randomUUID(),
    ...input,
    prev_hash: prevHash,
  };

  const entryHash = computeEntryHash(prevHash, record);
  (record as Record<string, unknown>).entry_hash = entryHash;

  const complete = record as unknown as EvidenceRecord;

  const filePath = currentMonthFile();
  try {
    fs.appendFileSync(filePath, JSON.stringify(complete) + "\n", { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    logError(`evidence 写入失败 (${filePath}): ${String(err)}`);
    throw err;
  }

  try {
    writeChainState({ last_entry_hash: entryHash });
  } catch (err) {
    logError(`evidence chain state 更新失败: ${String(err)}`);
    throw err;
  }

  seenKeys.add(key);
  evictIfNeeded();

  log(`📋 evidence 已记录: ${complete.evidence_id} [${complete.channel}/${complete.update_id}] ${complete.auth_result}`);

  return complete;
}

// ── Fallback ───────────────────────────────────────────────────────────────

function writeFallback(rawJson: string, channel: string, updateId: string): void {
  try {
    const fallbackPath = path.join(getEvidenceDir(), "evidence_fallback.jsonl");
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      channel,
      update_id: updateId,
      raw_base64: encodeRawUpdate(rawJson),
    });
    fs.mkdirSync(getEvidenceDir(), { recursive: true, mode: 0o700 });
    fs.appendFileSync(fallbackPath, line + "\n", { encoding: "utf-8", mode: 0o600 });
  } catch {
    // fallback 的 fallback 只能放弃
  }
}

// ── Shared Helper ──────────────────────────────────────────────────────────

export interface RecordUnauthorizedOpts {
  channel: string;
  ingestMode: string;
  updateId: string;
  chatId: string;
  messageId: string | null;
  sourceUserId: string | null;
  contentType: string;
  contentMeta: Record<string, unknown>;
  rawJson: string;
  displayName: string;
  logError: (msg: string) => void;
}

export function recordUnauthorizedEvidence(opts: RecordUnauthorizedOpts): void {
  try {
    appendEvidence({
      received_at: new Date().toISOString(),
      channel: opts.channel,
      ingest_mode: opts.ingestMode,
      update_id: opts.updateId,
      chat_id: opts.chatId,
      message_id: opts.messageId,
      source_user_id: opts.sourceUserId,
      content_type: opts.contentType,
      content_meta: opts.contentMeta,
      transport_verified: true,
      auth_result: "unauthorized",
      blocked_reason: "unauthorized_sender",
      raw_update_base64: encodeRawUpdate(opts.rawJson),
      raw_update_sha256: computeRawHash(opts.rawJson),
      entered_llm_context: false,
      entered_memory: false,
      tool_called: false,
    });
  } catch (err) {
    opts.logError(`evidence 写入失败: ${String(err)}`);
    writeFallback(opts.rawJson, opts.channel, opts.updateId);
  }

  const safe = sanitizeDisplayName(opts.displayName);
  opts.logError(`⛔ 拒绝未授权: ${safe.displayValue} (${opts.chatId}), 类型: ${opts.contentType}`);
}
