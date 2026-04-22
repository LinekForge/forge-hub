/**
 * Forge Hub — 消息路由
 *
 * @前缀定向、无前缀广播/主实例、回复标识。
 */

import type { InboundMessage, ConnectedInstance, HubConfig } from "./types.js";

// ── Route Result ────────────────────────────────────────────────────────────

export interface RouteResult {
  /** 目标实例 ID 列表 */
  targets: string[];
  /** 是否为定向消息 */
  targeted: boolean;
  /** 去掉 @前缀 后的消息内容 */
  content: string;
}

// ── @提及解析 ───────────────────────────────────────────────────────────────

interface MentionCandidate {
  name: string;
  instanceId: string;
  kind: "tag" | "id";
}

function isLeadingMentionBoundary(content: string, atIndex: number): boolean {
  if (atIndex === 0) return true;
  return /[\s([{"'“‘<,，;；:：、]/.test(content[atIndex - 1] ?? "");
}

function isTrailingMentionBoundary(content: string, endIndex: number): boolean {
  if (endIndex >= content.length) return true;
  return /[\s)\]}>"'“”‘’<.,!?;:，。！？；：、]/.test(content[endIndex] ?? "");
}

function buildMentionCandidates(
  instances: Map<string, ConnectedInstance>,
): MentionCandidate[] {
  const candidates: MentionCandidate[] = [];

  for (const [id, inst] of instances) {
    if (inst.tag) {
      candidates.push({ name: inst.tag, instanceId: id, kind: "tag" });
    }
    candidates.push({ name: id, instanceId: id, kind: "id" });
  }

  candidates.sort((a, b) => {
    const lengthDiff = b.name.length - a.name.length;
    if (lengthDiff !== 0) return lengthDiff;
    if (a.kind === b.kind) return 0;
    return a.kind === "tag" ? -1 : 1;
  });

  return candidates;
}

/**
 * 扫描整条消息里的 @mentions，只匹配在线实例的名字或 ID。
 * 只有独立 token 才算 mention，避免把邮箱或正文里的 @xxx 误判成路由。
 */
function parseTargets(
  content: string,
  instances: Map<string, ConnectedInstance>,
): { targets: string[]; rest: string } {
  const candidates = buildMentionCandidates(instances);
  const targets = new Set<string>();
  let rest = "";

  for (let index = 0; index < content.length; ) {
    if (content[index] !== "@" || !isLeadingMentionBoundary(content, index)) {
      rest += content[index] ?? "";
      index++;
      continue;
    }

    const matched = candidates.find((candidate) => {
      const endIndex = index + 1 + candidate.name.length;
      return (
        content.startsWith(candidate.name, index + 1) &&
        isTrailingMentionBoundary(content, endIndex)
      );
    });

    if (!matched) {
      rest += content[index] ?? "";
      index++;
      continue;
    }

    targets.add(matched.instanceId);
    index += 1 + matched.name.length;
  }

  rest = rest
    .replace(/\s*([,，.。!?！？;；:：、])\s*/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[,，.。!?！？;；:：、\s]+/, "")
    .replace(/[,，.。!?！？;；:：、\s]+$/, "");

  return { targets: [...targets], rest };
}

// ── Route ───────────────────────────────────────────────────────────────────

export function route(
  msg: InboundMessage,
  instances: Map<string, ConnectedInstance>,
  config: HubConfig,
): RouteResult {
  const instanceIds = [...instances.keys()];

  // No instances online
  if (instanceIds.length === 0) {
    return { targets: [], targeted: false, content: msg.content };
  }

  // Parse @mentions anywhere in message
  const { targets: requestedTargets, rest } = parseTargets(msg.content, instances);

  // Has @prefix → targeted delivery (match by name first, then by id)
  if (requestedTargets.length > 0) {
    return {
      targets: requestedTargets,
      targeted: true,
      content: rest,
    };
  }

  // No @prefix, single instance → direct
  if (instanceIds.length === 1) {
    return { targets: instanceIds, targeted: false, content: msg.content };
  }

  // No @prefix, multiple instances → primary or broadcast
  if (config.primary_instance && instances.has(config.primary_instance)) {
    return {
      targets: [config.primary_instance],
      targeted: false,
      content: msg.content,
    };
  }

  // No primary configured → broadcast to all
  return { targets: instanceIds, targeted: false, content: msg.content };
}

// ── Reply Tag ───────────────────────────────────────────────────────────────

/**
 * 多实例在线时给回复加上实例标识。
 */
export function addReplyTag(
  text: string,
  instanceId: string,
  instanceCount: number,
  config: HubConfig,
  instances: Map<string, ConnectedInstance>,
): string {
  if (!config.show_instance_tag) return text;
  if (instanceCount <= 1) return text;

  const inst = instances.get(instanceId);
  const desc = inst?.description;
  const tag = inst?.tag;

  let label: string;
  if (desc && tag) label = `${desc}@${tag}`;
  else if (desc) label = desc;
  else if (tag) label = `@${tag}`;
  else label = instanceId;

  return `Forge (${label}): ${text}`;
}
