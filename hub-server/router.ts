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

/**
 * 扫描整条消息里的 @mentions，只匹配在线实例的名字或 ID。
 * 匹配到的从消息里去掉。不管 @ 在开头、中间还是结尾。
 */
function parseTargets(
  content: string,
  instances: Map<string, ConnectedInstance>,
): { targets: string[]; rest: string } {
  // Collect known tags and IDs (longer first to avoid partial matches)
  const knownNames: string[] = [];
  for (const [id, inst] of instances) {
    knownNames.push(id);
    if (inst.tag) knownNames.push(inst.tag);
  }
  knownNames.sort((a, b) => b.length - a.length); // longest first

  const targets: string[] = [];
  let rest = content;

  // Search for @knownName in the message (no space required after name)
  for (const name of knownNames) {
    const pattern = `@${name}`;
    if (rest.includes(pattern)) {
      targets.push(name);
      rest = rest.replace(pattern, "").trim();
    }
  }

  // Clean up extra whitespace
  rest = rest.replace(/\s+/g, " ").trim();

  return { targets, rest };
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
    const validTargets: string[] = [];
    for (const target of requestedTargets) {
      // Try tag match
      let found = false;
      for (const [id, inst] of instances) {
        if (inst.tag === target) {
          validTargets.push(id);
          found = true;
          break;
        }
      }
      // Fallback to id match
      if (!found && instances.has(target)) {
        validTargets.push(target);
      }
    }
    return {
      targets: validTargets,
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
