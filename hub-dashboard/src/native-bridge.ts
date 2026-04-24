export interface NativeSession {
  sid: string;
  display: string;
  timestamp: number;
  time: string;
  isActive: boolean;
  pid?: number;
  isStarred: boolean;
  description?: string;
  tag?: string;
  hubTag?: string;
  hubDesc?: string;
  isChannel?: boolean;
  channels?: string[];
  hubInstanceId?: string;
}

interface BridgeCallbacks {
  _callbacks: Record<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  _nextId: number;
  call: (action: string, params?: Record<string, unknown>) => Promise<unknown>;
  resolve: (callbackId: string, result: unknown) => void;
  reject: (callbackId: string, error: string) => void;
  onSessionsUpdated: (sessions: NativeSession[]) => void;
  onHubStatusChanged: (online: boolean) => void;
}

declare global {
  interface Window {
    __nativeBridge?: BridgeCallbacks;
    webkit?: { messageHandlers?: { bridge?: { postMessage: (msg: unknown) => void } } };
  }
}

export function isNativeApp(): boolean {
  return typeof window !== "undefined"
    && window.webkit?.messageHandlers?.bridge != null
    && window.__nativeBridge != null;
}

async function call<T>(action: string, params?: Record<string, unknown>): Promise<T> {
  if (!window.__nativeBridge) throw new Error("Native bridge not available");
  return window.__nativeBridge.call(action, params) as Promise<T>;
}

export const bridge = {
  getSessions: () => call<NativeSession[]>("getSessions"),
  getStarredSessions: () => call<string[]>("getStarredSessions"),
  getHubStatus: () => call<{ online: boolean; everOnline: boolean }>("getHubStatus"),
  getSessionHistory: (sid: string, limit = 100) =>
    call<Array<{ role: string; text: string }>>("getSessionHistory", { sid, limit }),

  openSession: (sid: string) => call<void>("openSession", { sid }),
  focusTerminal: (sid: string) => call<boolean>("focusTerminal", { sid }),
  starSession: (sid: string) => call<void>("starSession", { sid }),
  renameSession: (sid: string, description: string) => call<boolean>("renameSession", { sid, description }),
  setSessionTag: (sid: string, tag: string) => call<boolean>("setSessionTag", { sid, tag }),

  launchNewSession: () => call<void>("launchNewSession"),
  launchChannelSession: (config: {
    channels: string[]; tag?: string; description?: string; historyCount?: number;
  }) => call<void>("launchChannelSession", config as unknown as Record<string, unknown>),
  resumeChannelSession: (sid: string, config: {
    channels: string[]; tag?: string; description?: string; historyCount?: number;
  }) => call<void>("resumeChannelSession", { sid, ...config } as unknown as Record<string, unknown>),

  fetchHubChannels: () => call<Array<{ id: string; name: string; aliases: string[] }>>("fetchHubChannels"),
  getChannelPresets: () => call<Array<{ name: string; subscribe: string[]; history: Record<string, number> }>>("getChannelPresets"),

  quit: () => call<void>("quit"),
};

let sessionUpdateHandler: ((sessions: NativeSession[]) => void) | null = null;
let hubStatusHandler: ((online: boolean) => void) | null = null;

export function onSessionsUpdated(handler: (sessions: NativeSession[]) => void) {
  sessionUpdateHandler = handler;
  if (window.__nativeBridge) {
    window.__nativeBridge.onSessionsUpdated = handler;
  }
}

export function onHubStatusChanged(handler: (online: boolean) => void) {
  hubStatusHandler = handler;
  if (window.__nativeBridge) {
    window.__nativeBridge.onHubStatusChanged = handler;
  }
}

export function initNativeBridgeHandlers() {
  if (!window.__nativeBridge) return;
  if (sessionUpdateHandler) window.__nativeBridge.onSessionsUpdated = sessionUpdateHandler;
  if (hubStatusHandler) window.__nativeBridge.onHubStatusChanged = hubStatusHandler;
}
