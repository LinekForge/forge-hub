import type { InboundHandleResult } from "../types.js";
import { redactSensitive } from "../config.js";
import { getInstances } from "../instance-manager.js";
import { channelPlugins } from "../channel-registry.js";
import { addSSEClient, removeSSEClient } from "../channels/homeland.js";

function mapIngressFailure(result: InboundHandleResult): { status: number; error: string } {
  switch (result.reason) {
    case "allowlist_error":
    case "unauthorized_sender":
      return {
        status: 403,
        error: result.detail
          ? `Homeland Operator 未授权：${result.detail}`
          : "Homeland Operator 未授权。先运行 `fh hub allow homeland local://operator Operator`。",
      };
    case "locked":
      return { status: 423, error: "Hub 已锁定，Homeland 消息未转发" };
    case "no_online_instance":
    case "no_subscribed_instance":
    case "unresolved_mention":
    case "ambiguous_mention":
    case "ambiguous_route":
      return { status: 409, error: result.detail ?? `消息未送达（${result.reason}）` };
    case "handler_missing":
      return { status: 503, error: "Hub Homeland 入站处理器未注册" };
    case "internal_error":
      return { status: 500, error: result.detail ?? "Homeland 入站处理失败" };
    default:
      return { status: 409, error: result.detail ?? `Homeland 消息未送达（${result.reason})` };
  }
}

export async function handleHomelandSend(req: Request): Promise<Response> {
  const body = await req.json() as { content: string; instance?: string };
  if (!body.content?.trim()) {
    return Response.json({ error: "content is required" }, { status: 400 });
  }
  if (body.instance && !getInstances().has(body.instance)) {
    return Response.json({ error: `selected instance ${body.instance} is offline` }, { status: 409 });
  }
  const plugin = channelPlugins.get("homeland");
  if (!plugin) {
    return Response.json({ error: "homeland channel not loaded" }, { status: 503 });
  }
  const { onMessage } = await import("../hub-state.js");
  const result = await onMessage({
    channel: "homeland", from: "Operator", fromId: "local://operator",
    content: body.content.trim(), targetInstanceId: body.instance, raw: {},
  });
  if (!result.accepted) {
    const failure = mapIngressFailure(result);
    return Response.json({ success: false, error: failure.error }, { status: failure.status });
  }
  return Response.json({ success: true, targets: result.targets ?? [] });
}

export function handleHomelandStream(req: Request, url: URL, corsHeaders: Record<string, string>): Response {
  const instanceFilter = url.searchParams.get("instance") ?? undefined;
  const stream = new ReadableStream({
    start(controller) {
      const client = addSSEClient(controller, instanceFilter);
      controller.enqueue(new TextEncoder().encode("event: connected\ndata: {}\n\n"));
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
        } catch {
          clearInterval(heartbeat);
          removeSSEClient(client);
        }
      }, 30_000);
      req.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        removeSSEClient(client);
      });
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...corsHeaders,
    },
  });
}

export async function handleHomelandPresence(req: Request): Promise<Response> {
  const body = await req.json() as { active: boolean };
  const { setDashboardPresence } = await import("../hub-state.js");
  if (setDashboardPresence) {
    setDashboardPresence(body.active ?? true);
  }
  return Response.json({ success: true });
}
