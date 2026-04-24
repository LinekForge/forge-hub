import type { FC } from "react";

import {
  IconFeishu,
  IconHomeland,
  IconIMessage,
  IconTelegram,
  IconWechat,
} from "./icons";

export const CHANNEL_ICON: Record<string, FC<{ size?: number; [k: string]: unknown }>> = {
  wechat: IconWechat,
  telegram: IconTelegram,
  feishu: IconFeishu,
  imessage: IconIMessage,
  homeland: IconHomeland,
};
