import type { InboundMessage } from "./types.js";

function normalizeImessageHandle(value: string): string {
  return value.toLowerCase();
}

export function getAuthSenderId(msg: InboundMessage): string {
  const authFromId = msg.raw.auth_sender_id;
  if (typeof authFromId === "string" && authFromId.length > 0) {
    return authFromId;
  }
  if (msg.channel === "imessage" && typeof msg.raw.handle_id === "string" && msg.raw.handle_id.length > 0) {
    return msg.raw.handle_id;
  }
  return msg.fromId;
}

export function isAuthorizedSenderMatch(channel: string, actualSenderId: string, allowedSenderId: string): boolean {
  if (channel === "imessage") {
    return normalizeImessageHandle(actualSenderId) === normalizeImessageHandle(allowedSenderId);
  }
  return actualSenderId === allowedSenderId;
}
