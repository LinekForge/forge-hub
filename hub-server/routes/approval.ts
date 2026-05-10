import { log, logError, appendAudit, isLocked, redactSensitive } from "../config.js";
import { loadChannelState } from "../state.js";
import { channelPlugins } from "../channel-registry.js";
import { getCurrentConfig } from "../hub-state.js";
import { checkPermissionRate, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from "../rate-limit.js";
import {
  pendingPermissions, idLookup,
  genDisplayIdPair, savePendingToDisk,
  resolveApprovalRecipient, resolveApprovalFromDashboard, dismissApprovalFromDashboard,
} from "../approval.js";
import { broadcastHomelandApproval } from "../channels/homeland.js";

export async function handlePermissionRequest(req: Request): Promise<Response> {
  const body = await req.json() as {
    request_id: string; tool_name: string; description: string;
    input_preview: string; instance: string;
  };

  if (!/^[a-km-z]{5}$/.test(body.request_id)) {
    return Response.json(
      { success: false, error: "invalid request_id format (must be 5 lowercase letters, no 'l')" },
      { status: 400 },
    );
  }

  if (!checkPermissionRate(body.instance)) {
    logError(`⚠️ /permission-request rate limit 触发 (instance=${body.instance}, request_id=${body.request_id})`);
    return Response.json(
      { success: false, error: `rate limited: max ${RATE_LIMIT_MAX} requests per ${RATE_LIMIT_WINDOW_MS / 1000}s per instance` },
      { status: 429 },
    );
  }

  if (isLocked()) {
    return Response.json({ success: false, error: "hub locked, remote approval disabled" }, { status: 503 });
  }

  const currentConfig = getCurrentConfig();
  const channels = currentConfig.approval_channels ?? [];
  if (channels.length === 0) {
    return Response.json(
      {
        success: false,
        error:
          "no approval_channels configured — edit ~/.forge-hub/hub-config.json and set approval_channels (e.g. [\"wechat\"]); " +
          "server:hub mode requires at least one channel to route approval prompts to. See 配置.md §审批推送配置.",
      },
      { status: 503 },
    );
  }

  if (pendingPermissions.has(body.request_id)) {
    return Response.json(
      { success: false, error: `request_id ${body.request_id} conflict with an active pending` },
      { status: 409 },
    );
  }

  const { yes_id, no_id } = genDisplayIdPair();

  pendingPermissions.set(body.request_id, {
    request_id: body.request_id, yes_id, no_id,
    tool_name: body.tool_name, description: body.description,
    input_preview: body.input_preview, from_instance: body.instance,
    created_at: Date.now(), pushed_channels: [],
  });
  idLookup.set(yes_id, { request_id: body.request_id, behavior: "allow" });
  idLookup.set(no_id, { request_id: body.request_id, behavior: "deny" });
  savePendingToDisk();

  const promptLines = [
    `Claude wants to run ${body.tool_name}: ${body.description}`,
  ];
  if (body.input_preview) promptLines.push("", body.input_preview.slice(0, 200));
  promptLines.push("", "Allow?", `Reply "yes ${yes_id}" to approve`, `Reply "no ${no_id}" to deny`);
  promptLines.push("", "⏳ 终端和微信均可审批，先操作的生效。终端处理后微信侧无法感知，仍会有提醒。如已在终端确认，请忽略本消息及后续提醒。");
  const prompt = promptLines.join("\n");

  const pushAllChannel = async (chName: string) => {
    const plugin = channelPlugins.get(chName);
    if (!plugin) throw new Error(`channel ${chName} not registered`);
    const to = await resolveApprovalRecipient(chName);
    if (!to) throw new Error(`no approval recipient for ${chName}`);
    const ctxTokens = (loadChannelState(chName, "context-tokens") ?? {}) as Record<string, string>;
    const contextToken = ctxTokens[to] ?? "";
    const r = await plugin.send({
      to, content: prompt, type: "text",
      raw: { context_token: contextToken },
    });
    if (!r.success) throw new Error(r.error || "send failed");
    return chName;
  };

  const successful: string[] = [];
  const failures: string[] = [];
  if (currentConfig.approval_push_mode === "sequential") {
    for (const chName of channels) {
      try {
        await pushAllChannel(chName);
        successful.push(chName);
        break;
      } catch (err) {
        failures.push(`${chName}: ${redactSensitive(String(err))}`);
      }
    }
  } else {
    const pushResults = await Promise.allSettled(channels.map(pushAllChannel));
    for (const r of pushResults) {
      if (r.status === "fulfilled") successful.push(r.value);
      else failures.push(redactSensitive(String(r.reason)));
    }
  }

  if (successful.length === 0) {
    pendingPermissions.delete(body.request_id);
    idLookup.delete(yes_id);
    idLookup.delete(no_id);
    savePendingToDisk();
    log(`❌ 审批 ${body.request_id} 全通道推送失败: ${failures.join("; ")}`);
    appendAudit({
      action: "approval_push_failed", request_id: body.request_id,
      tool_name: body.tool_name, from_instance: body.instance, failures,
    });
    return Response.json(
      { success: false, error: `all channels failed: ${failures.join("; ")}` },
      { status: 502 },
    );
  }

  const pending = pendingPermissions.get(body.request_id)!;
  pending.pushed_channels = successful;

  broadcastHomelandApproval({
    request_id: body.request_id, yes_id, no_id,
    tool_name: body.tool_name, description: body.description,
    from_instance: body.instance,
  });
  log(`🔐 审批 ${body.request_id} 已推送到 [${successful.join(",")}] (tool=${body.tool_name})`);
  if (failures.length > 0) log(`   部分失败: ${failures.join("; ")}`);
  appendAudit({
    action: "approval_pushed", request_id: body.request_id, yes_id, no_id,
    tool_name: body.tool_name, description: body.description,
    from_instance: body.instance, pushed_channels: successful, failed_channels: failures,
  });
  return Response.json({ success: true, pushed: successful, failed: failures });
}

export function handleDeletePending(routePath: string): Response {
  const id = decodeURIComponent(routePath.slice("/pending/".length));
  const pending = pendingPermissions.get(id);
  if (!pending) {
    return Response.json({ success: false, error: `pending ${id} 不存在` }, { status: 404 });
  }
  for (const [lookupId, entry] of idLookup.entries()) {
    if (entry.request_id === id) idLookup.delete(lookupId);
  }
  pendingPermissions.delete(id);
  savePendingToDisk();
  log(`🧹 审批 ${id} 被手动清除 (tool=${pending.tool_name})`);
  appendAudit({ action: "approval_manual_resolve", request_id: id, tool_name: pending.tool_name });
  return Response.json({ success: true, cleaned: id, tool_name: pending.tool_name });
}

export function handleDashboardApprove(routePath: string): Response {
  const id = decodeURIComponent(routePath.slice("/pending/".length, -"/approve".length));
  const result = resolveApprovalFromDashboard(id, "allow");
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ success: true, action: result.action });
}

export function handleDashboardDeny(routePath: string): Response {
  const id = decodeURIComponent(routePath.slice("/pending/".length, -"/deny".length));
  const result = resolveApprovalFromDashboard(id, "deny");
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ success: true, action: result.action });
}

export function handleDashboardDismiss(routePath: string): Response {
  const id = decodeURIComponent(routePath.slice("/pending/".length, -"/dismiss".length));
  const result = dismissApprovalFromDashboard(id);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ success: true, action: result.action });
}
