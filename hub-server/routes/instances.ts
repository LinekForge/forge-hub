import {
  listKnownInstances, setInstanceTag, setInstanceDescription,
  setInstanceChannels, setSummary,
} from "../instance-manager.js";
import { channelPluginsMeta } from "../channel-registry.js";

export function handleInstances(): Response {
  const list = listKnownInstances().map((i) => ({
    id: i.id, tag: i.tag, description: i.description, isChannel: i.isChannel,
    channels: i.channels, presence: i.presence, connectedAt: i.connectedAt,
    lastSeenAt: i.lastSeenAt, summary: i.summary,
  }));
  return Response.json({ instances: list });
}

export function handleChannels(): Response {
  const meta = [...channelPluginsMeta.values()].map(p => ({
    id: p.name, name: p.displayName, aliases: p.aliases,
  }));
  return Response.json({ channels: meta });
}

export async function handleSetTag(req: Request): Promise<Response> {
  const body = await req.json() as { instance: string; tag?: string; name?: string };
  const ok = setInstanceTag(body.instance, body.tag ?? body.name ?? "");
  return Response.json({ success: ok });
}

export async function handleSetDescription(req: Request): Promise<Response> {
  const body = await req.json() as { instance: string; description: string };
  const ok = setInstanceDescription(body.instance, body.description);
  return Response.json({ success: ok });
}

export async function handleSetChannels(req: Request): Promise<Response> {
  const body = await req.json() as { instance: string; channels?: string[] };
  const channels = body.channels?.includes("all") ? undefined : body.channels;
  const ok = setInstanceChannels(body.instance, channels);
  return Response.json({ success: ok });
}

export async function handleSetSummary(req: Request): Promise<Response> {
  const body = await req.json() as { instance: string; summary: string };
  const ok = setSummary(body.instance, body.summary);
  return Response.json({ success: ok });
}
