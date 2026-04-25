/**
 * WeChat ilink API 类型定义
 */

export interface AccountData {
  token: string;
  baseUrl: string;
  accountId: string;
  userId?: string;
  savedAt: string;
}

export interface AllowEntry {
  id: string;
  nickname: string;
}

export interface Allowlist {
  allowed: AllowEntry[];
}

export interface WeixinMessage {
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  session_id?: string;
  message_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  create_time_ms?: number;
}

export interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  image_item?: { media?: MediaInfo; aeskey?: string };
  voice_item?: { media?: MediaInfo; text?: string };
  file_item?: { media?: MediaInfo; file_name?: string };
  video_item?: { media?: MediaInfo };
  ref_msg?: { message_item?: MessageItem; title?: string };
}

export interface MediaInfo {
  encrypt_query_param?: string;
  aes_key?: string;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface GetConfigResp {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

export const MSG_TYPE_USER = 1;
export const MSG_TYPE_BOT = 2;
export const MSG_ITEM_TEXT = 1;
export const MSG_STATE_FINISH = 2;
