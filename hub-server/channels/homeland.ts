import type { ChannelPlugin, HubAPI, SendParams, SendResult, ChannelCapability } from "../types.js";

const HOMELAND_OWNER_ID = "local://operator";
const HOMELAND_OWNER_NAME = "Operator";

interface SSEClient {
  controller: ReadableStreamDefaultController;
  instanceFilter?: string;
}

const sseClients = new Set<SSEClient>();

function broadcastSSE(event: string, data: unknown, instanceFilter?: string): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    if (instanceFilter && client.instanceFilter && client.instanceFilter !== instanceFilter) continue;
    try {
      client.controller.enqueue(new TextEncoder().encode(payload));
    } catch {
      sseClients.delete(client);
    }
  }
}

export function addSSEClient(controller: ReadableStreamDefaultController, instanceFilter?: string): SSEClient {
  const client: SSEClient = { controller, instanceFilter };
  sseClients.add(client);
  return client;
}

export function removeSSEClient(client: SSEClient): void {
  sseClients.delete(client);
}

export function getSSEClientCount(): number {
  return sseClients.size;
}

export function broadcastHomelandMessage(data: { from: string; fromInstance: string; content: string; ts: string }): void {
  broadcastSSE("message", data);
}

export function broadcastHomelandApproval(data: unknown): void {
  broadcastSSE("approval", data);
}

export function broadcastHomelandStatus(data: unknown): void {
  broadcastSSE("status", data);
}

let hub: HubAPI | null = null;

const homeland: ChannelPlugin = {
  name: "homeland",
  displayName: "Homeland",
  aliases: ["home", "local"],
  capabilities: ["text", "file", "voice"] as ChannelCapability[],

  async start(hubAPI: HubAPI): Promise<void> {
    hub = hubAPI;
    hub.log("Homeland 通道就绪（本地直连，无外部依赖）");
  },

  async send(params: SendParams): Promise<SendResult> {
    const ts = new Date().toISOString();
    broadcastSSE("message", {
      from: params.raw?.from_instance_tag ?? "agent",
      fromInstance: params.raw?.from_instance ?? "",
      content: params.content,
      type: params.type,
      filePath: params.filePath,
      ts,
    });
    return { success: true };
  },

  async stop(): Promise<void> {
    for (const client of sseClients) {
      try { client.controller.close(); } catch {}
    }
    sseClients.clear();
    hub = null;
  },

  isNativeId(to: string): boolean {
    return to === HOMELAND_OWNER_ID || to === HOMELAND_OWNER_NAME || to.startsWith("local://");
  },
};

export default homeland;
