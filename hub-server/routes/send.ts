import fs from "node:fs";
import path from "node:path";

import type { ChannelPlugin } from "../types.js";
import { HUB_DIR, log, deriveHealthStatus, getChannelHealth, redactSensitive } from "../config.js";
import { getInstances } from "../instance-manager.js";
import { channelPlugins } from "../channel-registry.js";
import { addReplyTag } from "../router.js";
import { loadChannelState } from "../state.js";
import { resolveRecipient } from "../resolve.js";
import { appendHistory, getOutboundFrom } from "../history.js";
import { pushToInstances } from "../instance-manager.js";
import { getCurrentConfig } from "../hub-state.js";
import { synthesizeToOgg } from "../tts.js";

function buildSendWarning(channel: string): string | undefined {
  const health = getChannelHealth(channel);
  const status = deriveHealthStatus(health);
  const warnings: string[] = [];
  if (status === "unhealthy" || status === "degraded") {
    warnings.push(`通道 ${channel} 入站连续 ${health.consecutiveFailures} 次失败${health.lastError ? `（最近: ${health.lastError.slice(0, 60)}）` : ""}——发送仍会尝试，但对方回复可能收不到`);
  }
  if (health.lastMessageIn) {
    const mins = Math.floor((Date.now() - new Date(health.lastMessageIn).getTime()) / 60000);
    if (mins > 10) {
      warnings.push(`通道 ${channel} 入站已 ${mins} 分钟无消息，轮询可能挂了。如果对方回了你可能看不到`);
    }
  }
  return warnings.length > 0 ? warnings.join("；") + "。送达状态不确定，建议关注或换通道确认。" : undefined;
}

async function handleSendRequest(
  body: { channel: string; to: string; instance?: string },
  buildSendArgs: (to: string, contextToken: string) => Promise<Parameters<ChannelPlugin["send"]>[0]>,
  onSuccess: (to: string) => string,
  onFinally?: () => void,
): Promise<Response> {
  const plugin = channelPlugins.get(body.channel);
  if (!plugin) return Response.json({ error: `unknown channel: ${body.channel}` }, { status: 404 });

  const resolved = resolveRecipient(body.channel, body.to);
  if (!resolved.ok) return Response.json({ success: false, error: resolved.error });
  const to = resolved.id;

  const contextTokens = (loadChannelState(body.channel, "context-tokens") ?? {}) as Record<string, string>;
  const contextToken = contextTokens[to] ?? "";

  try {
    const sendArgs = await buildSendArgs(to, contextToken);
    const result = await plugin.send(sendArgs);

    if (result.success) {
      appendHistory(body.channel, "out", getOutboundFrom(body.instance), onSuccess(to));
      const warning = buildSendWarning(body.channel);
      if (warning) {
        log(`⚠️ 出站 [${body.channel}] 带 warning: ${warning.slice(0, 80)}`);
        return Response.json({ ...result, warning });
      }
    }
    return Response.json(result);
  } finally {
    onFinally?.();
  }
}

export async function handleSend(req: Request): Promise<Response> {
  const body = await req.json() as {
    channel: string; to: string; text: string; instance?: string;
  };

  if (!body.text) {
    return Response.json({ success: false, error: "缺少 text 参数" }, { status: 400 });
  }

  if (body.channel === "hub") {
    const instances = getInstances();
    const target = body.to.replace(/^@/, "");
    let targetId: string | null = null;
    for (const [id, inst] of instances) {
      if (inst.tag === target) { targetId = id; break; }
    }
    if (!targetId && instances.has(target)) targetId = target;

    const senderInst = body.instance ? instances.get(body.instance) : null;
    const senderLabel = senderInst?.description ?? senderInst?.tag ?? body.instance ?? "unknown";

    const targetIds = target === "all"
      ? [...instances.keys()].filter((id) => id !== body.instance)
      : targetId ? [targetId] : null;
    if (!targetIds) {
      return Response.json({ success: false, error: `找不到实例: ${body.to}` });
    }

    pushToInstances(targetIds, {
      type: "instance_message", channel: "hub", from: senderLabel,
      fromId: body.instance ?? "", content: body.text, targeted: true, raw: {},
    });

    log(`↔ [hub] ${senderLabel} → ${target}: ${body.text.slice(0, 60)}`);
    return Response.json({ success: true });
  }

  return await handleSendRequest(body, async (to, contextToken) => {
    const instances = getInstances();
    const taggedText = addReplyTag(body.text, body.instance ?? "", instances.size, getCurrentConfig(), instances);
    const senderInstance = instances.get(body.instance ?? "");
    return {
      to, content: taggedText, type: "text" as const,
      raw: {
        context_token: contextToken,
        from_instance: body.instance ?? "",
        from_instance_tag: senderInstance?.description ?? senderInstance?.tag ?? "agent",
      },
    };
  }, () => {
    log(`→ [${body.channel}] ${body.to.slice(0, 16)}...: ${body.text.slice(0, 60)}`);
    return body.text;
  }, undefined);
}

export async function handleSendFile(req: Request): Promise<Response> {
  const body = await req.json() as {
    channel: string; to: string; path: string; instance?: string;
  };

  const isRemoteUrl = /^https?:\/\//i.test(body.path);
  if (!isRemoteUrl) {
    const sendableRoot = `${HUB_DIR}/sendable`;
    try {
      fs.mkdirSync(sendableRoot, { recursive: true });
      const realPath = fs.realpathSync(body.path);
      const realRoot = fs.realpathSync(sendableRoot);
      if (!realPath.startsWith(realRoot + "/") && realPath !== realRoot) {
        return Response.json(
          { success: false, error: `path 必须在 ${sendableRoot}/ 下（HTTP/HTTPS URL 除外）` },
          { status: 403 },
        );
      }
    } catch (err) {
      return Response.json(
        { success: false, error: `path 校验失败: ${redactSensitive(String(err))}` },
        { status: 400 },
      );
    }
  }

  return await handleSendRequest(body, async (to, contextToken) => ({
    to, content: "", type: "file" as const, filePath: body.path,
    raw: { context_token: contextToken },
  }), () => {
    const fileName = body.path.split("/").pop() ?? body.path;
    log(`→ [${body.channel}] 文件: ${body.path.slice(0, 60)}`);
    return `[文件] ${fileName}`;
  });
}

export async function handleSendVoice(req: Request): Promise<Response> {
  const body = await req.json() as {
    channel: string; to: string; text: string; instance?: string;
  };

  let oggCleanup: string | null = null;

  return await handleSendRequest(body, async (to, contextToken) => {
    if (body.channel === "wechat") {
      return { to, content: body.text, type: "voice" as const, raw: { context_token: contextToken } };
    }
    const oggPath = await synthesizeToOgg(body.text);
    if (!oggPath) throw new Error("TTS 合成失败");
    oggCleanup = path.dirname(oggPath);
    return { to, content: body.text, type: "voice" as const, filePath: oggPath, raw: { context_token: contextToken } };
  }, () => {
    log(`→ [${body.channel}] 语音: ${body.text.slice(0, 60)}`);
    return `[语音] ${body.text.slice(0, 60)}`;
  }, () => {
    if (oggCleanup) { fs.promises.rm(oggCleanup, { recursive: true, force: true }).catch(() => {}); }
  });
}
