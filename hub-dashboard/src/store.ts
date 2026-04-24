import { create } from "zustand";
import type { Instance, ChannelHealth, PendingApproval, HubInfo } from "./types";
import type { NativeSession } from "./native-bridge";

interface HubStore {
  instances: Instance[];
  channelHealth: Record<string, ChannelHealth>;
  pendingApprovals: PendingApproval[];
  hubInfo: HubInfo | null;
  isNativeApp: boolean;
  nativeSessions: NativeSession[];
  hubToSessionMap: Record<string, string>;

  setInstances: (instances: Instance[]) => void;
  setChannelHealth: (health: Record<string, ChannelHealth>) => void;
  setPendingApprovals: (approvals: PendingApproval[]) => void;
  setHubInfo: (info: HubInfo) => void;
  removeApproval: (requestId: string) => void;
  setNativeApp: (v: boolean) => void;
  setNativeSessions: (sessions: NativeSession[]) => void;
}

export const useHubStore = create<HubStore>((set) => ({
  instances: [],
  channelHealth: {},
  pendingApprovals: [],
  hubInfo: null,
  isNativeApp: false,
  nativeSessions: [],
  hubToSessionMap: {},

  setInstances: (instances) => set({ instances }),
  setChannelHealth: (health) => set({ channelHealth: health }),
  setPendingApprovals: (approvals) => set({ pendingApprovals: approvals }),
  setHubInfo: (info) => set({ hubInfo: info }),
  setNativeApp: (v) => set({ isNativeApp: v }),
  setNativeSessions: (sessions) => {
    const map: Record<string, string> = {};
    for (const s of sessions) {
      if (s.hubInstanceId) map[s.hubInstanceId] = s.sid;
    }
    set({ nativeSessions: sessions, hubToSessionMap: map });
  },

  removeApproval: (requestId) =>
    set((state) => ({
      pendingApprovals: state.pendingApprovals.filter((a) => a.request_id !== requestId),
    })),
}));
