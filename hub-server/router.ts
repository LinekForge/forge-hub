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
  /** broadcast 模式下，@mention 的接手者（所有人收到消息，handler 负责回复） */
  handlers?: string[];
  /** fail-closed 时返回明确失败原因，调用方决定如何反馈给用户 */
  failure?: {
    kind: "unresolved_mention" | "ambiguous_mention" | "ambiguous_route";
    detail: string;
  };
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
): { candidates: MentionCandidate[]; ambiguousTags: string[] } {
  const candidates: MentionCandidate[] = [];
  const tagCounts = new Map<string, number>();

  for (const instance of instances.values()) {
    if (!instance.tag) continue;
    tagCounts.set(instance.tag, (tagCounts.get(instance.tag) ?? 0) + 1);
  }

  const descCounts = new Map<string, number>();
  for (const instance of instances.values()) {
    if (!instance.description) continue;
    descCounts.set(instance.description, (descCounts.get(instance.description) ?? 0) + 1);
  }

  for (const [id, inst] of instances) {
    if (inst.tag && tagCounts.get(inst.tag) === 1) {
      candidates.push({ name: inst.tag, instanceId: id, kind: "tag" });
    }
    if (inst.description && descCounts.get(inst.description) === 1) {
      candidates.push({ name: inst.description, instanceId: id, kind: "tag" });
    }
    candidates.push({ name: id, instanceId: id, kind: "id" });
  }

  candidates.sort((a, b) => {
    const lengthDiff = b.name.length - a.name.length;
    if (lengthDiff !== 0) return lengthDiff;
    if (a.kind === b.kind) return 0;
    return a.kind === "tag" ? -1 : 1;
  });

  const ambiguousTags = [...tagCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([tag]) => tag)
    .sort((a, b) => b.length - a.length);

  return { candidates, ambiguousTags };
}

function readMentionToken(
  content: string,
  atIndex: number,
): { token: string; endIndex: number } | null {
  const startIndex = atIndex + 1;
  if (startIndex >= content.length) return null;

  let endIndex = startIndex;
  while (endIndex < content.length && !isTrailingMentionBoundary(content, endIndex)) {
    endIndex++;
  }

  if (endIndex === startIndex) return null;
  return {
    token: content.slice(startIndex, endIndex),
    endIndex,
  };
}

/**
 * 扫描整条消息里的 @mentions，只匹配在线实例的名字或 ID。
 * 只有独立 token 才算 mention，避免把邮箱或正文里的 @xxx 误判成路由。
 */
function parseTargets(
  content: string,
  instances: Map<string, ConnectedInstance>,
): { targets: string[]; rest: string; unresolvedMentions: string[]; ambiguousMentions: string[] } {
  const { candidates, ambiguousTags } = buildMentionCandidates(instances);
  const targets = new Set<string>();
  const unresolvedMentions: string[] = [];
  const ambiguousMentions: string[] = [];
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

    if (matched) {
      targets.add(matched.instanceId);
      index += 1 + matched.name.length;
      continue;
    }

    const ambiguous = ambiguousTags.find((tag) => {
      const endIndex = index + 1 + tag.length;
      return (
        content.startsWith(tag, index + 1) &&
        isTrailingMentionBoundary(content, endIndex)
      );
    });
    if (ambiguous) {
      ambiguousMentions.push(ambiguous);
      index += 1 + ambiguous.length;
      continue;
    }

    const token = readMentionToken(content, index);
    if (token) {
      unresolvedMentions.push(token.token);
      index = token.endIndex;
      continue;
    }

    rest += content[index] ?? "";
    index++;
  }

  rest = rest
    .replace(/\s*([,，.。!?！？;；:：、])\s*/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[,，.。!?！？;；:：、\s]+/, "")
    .replace(/[,，.。!?！？;；:：、\s]+$/, "");

  return {
    targets: [...targets],
    rest,
    unresolvedMentions,
    ambiguousMentions,
  };
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

  // Dashboard 显式指定了接手实例时，优先交给它。
  // 这里的语义不是 @mention，而是"当前公共流由谁接手"。
  if (msg.targetInstanceId) {
    if (instances.has(msg.targetInstanceId)) {
      return {
        targets: [msg.targetInstanceId],
        targeted: true,
        content: msg.content,
      };
    }
    return { targets: [], targeted: true, content: msg.content };
  }

  // Parse @mentions anywhere in message
  const {
    targets: requestedTargets,
    rest,
    unresolvedMentions,
    ambiguousMentions,
  } = parseTargets(msg.content, instances);

  if (ambiguousMentions.length > 0) {
    return {
      targets: [],
      targeted: true,
      content: rest,
      failure: {
        kind: "ambiguous_mention",
        detail: `@${ambiguousMentions.join(", @")} 匹配到多个实例，请先修正重复 tag`,
      },
    };
  }

  if (unresolvedMentions.length > 0) {
    return {
      targets: [],
      targeted: true,
      content: rest,
      failure: {
        kind: "unresolved_mention",
        detail: `未找到实例 @${unresolvedMentions.join(", @")}`,
      },
    };
  }

  // Has @mention → route based on mention_mode
  if (requestedTargets.length > 0) {
    const mentionMode = config.mention_mode ?? "direct";
    if (mentionMode === "direct") {
      return { targets: requestedTargets, targeted: true, content: rest };
    }
    // broadcast: all subscribers receive, handlers marked
    return {
      targets: instanceIds,
      targeted: true,
      content: rest,
      handlers: requestedTargets,
    };
  }

  // No @mention → broadcast to all subscribers
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
