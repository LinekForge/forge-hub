import React, { useEffect, useState, useMemo, Component } from "react";
import type { DesignAI } from "./adapter";
import type { DashboardSystemInfo } from "./ops_mode";

class ErrorBoundary extends Component<React.PropsWithChildren, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, color: '#f87171', fontFamily: 'var(--mono)', fontSize: 13, background: 'var(--bg-1)', height: '100%' }}>
          <div style={{ fontSize: 16, marginBottom: 12, color: 'var(--text-0)' }}>Dashboard 渲染错误</div>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#f87171' }}>{String(this.state.error)}</pre>
          <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--text-3)', marginTop: 8 }}>{this.state.error?.stack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}
import { useHubStore } from "./store";
import { usePolling } from "./hooks/usePolling";
import { useSSE } from "./hooks/useSSE";
import { useKeyboard } from "./hooks/useKeyboard";
import { usePresence } from "./hooks/usePresence";
import { HUB_AUTH_EVENT, authenticateDashboard, setDashboardBearerToken } from "./api";
import { requestNotificationPermission } from "./utils/notify";
import { adaptInstance, adaptChannel } from "./adapter";
import { isNativeApp, bridge, onSessionsUpdated, initNativeBridgeHandlers } from "./native-bridge";
import { adaptNativeSession } from "./native-adapter";
import { ChatMode } from "./chat_mode";
import { OpsMode } from "./ops_mode";
import { IconHome, IconGauge, IconSettings } from "./icons";

interface ConversationMessage {
  id: string;
  dir: "approval";
  tool: string;
  intent: string;
  command: string;
  risk: "unknown";
  time: string;
  request_id: string;
}

// ── Mode Switch (from Design handoff app.jsx) ────────────────────────────

function ModeSwitch({ mode, onChange }: { mode: "chat" | "ops"; onChange: (next: "chat" | "ops") => void }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [slider, setSlider] = React.useState({ left: 2, width: 0 });

  React.useEffect(() => {
    if (!ref.current) return;
    const active = ref.current.querySelector('.mode-btn.active');
    if (active) {
      const parent = ref.current.getBoundingClientRect();
      const r = active.getBoundingClientRect();
      setSlider({ left: r.left - parent.left, width: r.width });
    }
  }, [mode]);

  return (
    <div className="mode-switch" ref={ref}>
      <div className="mode-slider" style={{ left: slider.left, width: slider.width }}/>
      <button className={`mode-btn ${mode === 'chat' ? 'active' : ''}`} onClick={() => onChange('chat')}>
        <IconHome size={13}/> 聊天
      </button>
      <button className={`mode-btn ${mode === 'ops' ? 'active' : ''}`} onClick={() => onChange('ops')}>
        <IconGauge size={13}/> 运维
      </button>
    </div>
  );
}

function pickDefaultAI(ais: DesignAI[]) {
  return ais.find((ai) => ai.isChannel)?.id ?? ais[0]?.id ?? null;
}

function availabilityPreview(ai: DesignAI) {
  if (ai.status !== "online") return "离线";
  if (!ai.isChannel) return `在线 · ${ai.uptime}`;
  return `在线 · ${ai.uptime}`;
}

function HubStateCard({ title, description, detail }: { title: string; description: string; detail: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '28px' }}>
      <div style={{
        width: 'min(560px, 100%)',
        padding: '24px 26px',
        borderRadius: 22,
        background: 'linear-gradient(180deg, rgba(24,24,34,0.92) 0%, rgba(15,15,22,0.98) 100%)',
        border: '1px solid var(--border)',
        boxShadow: '0 24px 80px rgba(0,0,0,0.28)',
      }}>
        <div style={{ fontSize: 12, color: 'var(--text-4)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
          Forge Hub
        </div>
        <div style={{ marginTop: 10, fontSize: 22, fontWeight: 600, color: 'var(--text-0)', letterSpacing: '-0.02em' }}>
          {title}
        </div>
        <div style={{ marginTop: 10, fontSize: 14, color: 'var(--text-2)', lineHeight: 1.7 }}>
          {description}
        </div>
        <div style={{
          marginTop: 16,
          paddingTop: 14,
          borderTop: '1px solid var(--border-subtle)',
          fontSize: 12,
          color: 'var(--text-3)',
          fontFamily: 'var(--mono)',
        }}>
          {detail}
        </div>
      </div>
    </div>
  );
}

function HubAuthCard({
  token,
  error,
  busy,
  onTokenChange,
  onSubmit,
}: {
  token: string;
  error: string;
  busy: boolean;
  onTokenChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '28px' }}>
      <form
        onSubmit={onSubmit}
        style={{
          width: 'min(560px, 100%)',
          padding: '24px 26px',
          borderRadius: 22,
          background: 'linear-gradient(180deg, rgba(24,24,34,0.92) 0%, rgba(15,15,22,0.98) 100%)',
          border: '1px solid var(--border)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.28)',
        }}
      >
        <div style={{ fontSize: 12, color: 'var(--text-4)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
          Forge Hub
        </div>
        <div style={{ marginTop: 10, fontSize: 22, fontWeight: 600, color: 'var(--text-0)', letterSpacing: '-0.02em' }}>
          输入 Hub API token
        </div>
        <div style={{ marginTop: 10, fontSize: 14, color: 'var(--text-2)', lineHeight: 1.7 }}>
          当前 Hub 已开启 token 保护。静态页面可以打开，但要继续读取实例、审批和 Homeland 流，需要先完成一次本机浏览器认证。
        </div>
        <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input
            type="password"
            autoFocus
            value={token}
            onChange={(e) => onTokenChange(e.target.value)}
            placeholder="粘贴 ~/.forge-hub/api-token 里的值"
            style={{
              width: '100%',
              padding: '12px 14px',
              borderRadius: 12,
              border: '1px solid var(--border)',
              background: 'rgba(255,255,255,0.04)',
              color: 'var(--text-0)',
              fontSize: 14,
              fontFamily: 'var(--mono)',
              outline: 'none',
            }}
          />
          <button
            type="submit"
            disabled={busy}
            style={{
              alignSelf: 'flex-start',
              padding: '9px 16px',
              borderRadius: 10,
              border: '1px solid rgba(99,102,241,0.3)',
              background: busy
                ? 'rgba(255,255,255,0.06)'
                : 'linear-gradient(180deg, #7c7fff 0%, #4f52e8 100%)',
              color: busy ? 'var(--text-3)' : 'white',
              fontSize: 13,
              fontWeight: 600,
              boxShadow: busy ? 'none' : '0 6px 18px rgba(99,102,241,0.32)',
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            {busy ? '认证中…' : '继续进入 Dashboard'}
          </button>
        </div>
        <div style={{
          marginTop: 16,
          paddingTop: 14,
          borderTop: '1px solid var(--border-subtle)',
          fontSize: 12,
          color: error ? '#fca5a5' : 'var(--text-3)',
          fontFamily: 'var(--mono)',
          lineHeight: 1.7,
        }}>
          {error || 'token 只会发给当前 Hub，并由服务端写成 HttpOnly cookie；后续 API 与 SSE 会自动复用。'}
        </div>
      </form>
    </div>
  );
}

// ── App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [mode, setMode] = useState<"chat" | "ops">('chat');
  const [activeAI, setActiveAI] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [nativeAuthReady, setNativeAuthReady] = useState(() => !isNativeApp());

  const instances = useHubStore((s) => s.instances);
  const channelHealth = useHubStore((s) => s.channelHealth);
  const pendingApprovals = useHubStore((s) => s.pendingApprovals);
  const hubInfo = useHubStore((s) => s.hubInfo);
  const nativeMode = useHubStore((s) => s.isNativeApp);
  const nativeSessions = useHubStore((s) => s.nativeSessions);
  const hubToSessionMap = useHubStore((s) => s.hubToSessionMap);
  const setNativeApp = useHubStore((s) => s.setNativeApp);
  const setNativeSessions = useHubStore((s) => s.setNativeSessions);

  useEffect(() => {
    if (isNativeApp()) {
      setNativeApp(true);
      bridge.getHubApiToken()
        .then((token) => {
          setDashboardBearerToken(token);
          if (token) {
            setAuthRequired(false);
            setAuthError("");
          }
        })
        .catch(() => {})
        .finally(() => setNativeAuthReady(true));
      bridge.getSessions().then(setNativeSessions).catch(() => {});
      onSessionsUpdated((sessions) => setNativeSessions(sessions));
      initNativeBridgeHandlers();
    } else {
      setNativeApp(false);
    }
  }, [setNativeApp, setNativeSessions]);

  usePolling(nativeAuthReady && !authRequired);
  useSSE(nativeAuthReady && !authRequired);
  usePresence(nativeAuthReady && !authRequired);

  useEffect(() => { requestNotificationPermission(); }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ required?: boolean; message?: string }>).detail ?? {};
      setAuthRequired(Boolean(detail.required));
      setAuthError(detail.required ? (detail.message ?? "") : "");
      if (!detail.required) setAuthBusy(false);
    };
    window.addEventListener(HUB_AUTH_EVENT, handler);
    return () => window.removeEventListener(HUB_AUTH_EVENT, handler);
  }, []);

  // 监听 OpsMode/ChatMode 的审批操作，同步到 store
  const removeApproval = useHubStore((s) => s.removeApproval);
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string }>).detail;
      if (detail?.id) removeApproval(detail.id);
    };
    window.addEventListener('hub-approval-resolved', handler);
    return () => window.removeEventListener('hub-approval-resolved', handler);
  }, [removeApproval]);

  // ── Adapt Hub data → Design data format ────────────────────────────────

  const ais = useMemo(() => {
    if (nativeMode && nativeSessions.length > 0) {
      return nativeSessions.map((s, i) => adaptNativeSession(s, i));
    }
    return instances.map((inst, i) => adaptInstance(inst, i));
  }, [nativeMode, nativeSessions, instances]);

  const channels = useMemo(() =>
    Object.entries(channelHealth).map(([id, h]) => adaptChannel(id, h)),
    [channelHealth]
  );

  const lastMessages = useMemo(() => {
    const m: Record<string, { from: "ai"; text: string; unread: number }> = {};
    ais.forEach(ai => {
      m[ai.id] = { from: 'ai', text: availabilityPreview(ai), unread: 0 };
    });
    return m;
  }, [ais]);

  const conversations = useMemo(() => {
    const c: Record<string, ConversationMessage[]> = {};
    ais.forEach(ai => { c[ai.id] = []; });
    // 把 pending approvals 注入为审批消息（带 request_id 供 handleApproval 使用）
    pendingApprovals.forEach(a => {
      const targetId = nativeMode ? (hubToSessionMap[a.from_instance] ?? a.from_instance) : a.from_instance;
      const targetConvo = c[targetId];
      if (targetConvo) {
        targetConvo.push({
          id: a.request_id,
          dir: 'approval',
          tool: a.tool_name,
          intent: a.description,
          command: a.tool_name,
          risk: 'unknown',
          time: `${Math.floor(a.waited_seconds / 60)}m`,
          request_id: a.request_id,
        });
      }
    });
    return c;
  }, [ais, pendingApprovals, nativeMode, hubToSessionMap]);

  const approvalQueue = useMemo(() =>
    pendingApprovals.map(a => ({
      id: a.request_id,
      ai: a.from_instance,
      tool: a.tool_name,
      intent: a.description,
      command: a.tool_name,
      risk: 'unknown' as const,
      requestedAt: `${Math.floor(a.waited_seconds / 60)} 分钟前`,
      time: `${Math.floor(a.waited_seconds / 60)}m`,
    })),
  [pendingApprovals]);

  const systemInfo = useMemo<DashboardSystemInfo>(() => {
    if (!hubInfo) return SYSTEM_DEFAULT;
    const host = typeof window === "undefined" ? "—" : window.location.host;
    return {
      pid: hubInfo.pid ?? null,
      memory: `${hubInfo.memory_mb} MB`,
      memoryPct: null,
      cpu: "未提供",
      cpuPct: null,
      uptime: `${Math.floor(hubInfo.uptime / 86400)}d ${Math.floor((hubInfo.uptime % 86400) / 3600)}h`,
      version: `v${hubInfo.version}`,
      node: host || "—",
    };
  }, [hubInfo]);

  // Auto-select first AI — computed, not in useEffect, to avoid null on first render
  const effectiveActiveAI = activeAI && ais.some(a => a.id === activeAI)
    ? activeAI
    : pickDefaultAI(ais);

  useKeyboard({
    instances,
    onToggleMode: () => setMode((prev) => prev === 'chat' ? 'ops' : 'chat'),
    onSelectInstance: setActiveAI,
  });

  async function handleDashboardAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = authToken.trim();
    if (!token) {
      setAuthError("请输入 Hub API token");
      return;
    }
    setAuthBusy(true);
    const result = await authenticateDashboard(token);
    if (!result.success) {
      setAuthBusy(false);
      setAuthError(result.error ?? "认证失败");
      return;
    }
    setAuthToken("");
    setAuthBusy(false);
    setAuthError("");
    setAuthRequired(false);
  }

  if (authRequired) {
    return (
      <HubAuthCard
        token={authToken}
        error={authError}
        busy={authBusy}
        onTokenChange={setAuthToken}
        onSubmit={handleDashboardAuth}
      />
    );
  }

  // ── Loading state ──────────────────────────────────────────────────────

  if (!hubInfo) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, background: 'var(--bg-1)' }}>
        <div style={{
          width: 64, height: 64, borderRadius: 20,
          background: 'linear-gradient(135deg, #7c7fff 0%, #4338ca 100%)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 0 0 1px rgba(255,255,255,0.08), 0 8px 32px rgba(99,102,241,0.4)',
        }}>
          <span style={{ color: 'white', fontSize: 28, fontWeight: 700 }}>F</span>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-0)' }}>Forge Hub</div>
          <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 4 }}>正在连接 localhost:9900…</div>
        </div>
      </div>
    );
  }

  const hasChannels = channels.length > 0;
  const hasActiveAI = Boolean(effectiveActiveAI);
  const onlineCount = ais.filter(a => a.status === 'online').length;

  return (
    <>
      <div className="mode-bar" data-screen-label="Forge Hub">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-2)', fontFamily: 'var(--mono)' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', boxShadow: '0 0 8px var(--green-glow, rgba(74,222,128,0.5))' }}/>
            <span style={{ color: 'var(--text-1)', fontWeight: 500 }}>Forge Hub</span>
            <span style={{ color: 'var(--text-4)' }}>·</span>
            <span>v{hubInfo.version}</span>
            <span style={{ color: 'var(--text-4)' }}>·</span>
            <span>{onlineCount} 位 AI 在线</span>
          </div>
        </div>
        <ModeSwitch mode={mode} onChange={setMode}/>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>
          <span>{hubInfo.locked ? '🔒 已锁定' : ''}</span>
          <button className="hoverable" style={{ padding: 6, borderRadius: 6, color: 'var(--text-3)' }}>
            <IconSettings size={13}/>
          </button>
        </div>
      </div>

      <div className="mode-content">
        <ErrorBoundary>
          {!hasChannels && (
            <div style={{
              margin: '18px 22px 0',
              padding: '12px 16px',
              borderRadius: 14,
              border: '1px solid rgba(248, 113, 113, 0.28)',
              background: 'linear-gradient(90deg, rgba(127, 29, 29, 0.26) 0%, rgba(69, 10, 10, 0.12) 100%)',
              color: 'var(--text-1)',
            }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>当前没有任何已加载通道</div>
              <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-3)' }}>
                Hub 本身已经连上，不是 loading。切到运维视图还能继续看实例、审批和系统状态。
              </div>
            </div>
          )}
          <div className={`mode-pane ${mode === 'chat' ? 'enter' : 'exit'}`}>
            {!hasChannels ? (
              <HubStateCard
                title="Hub 已连接，但当前没有可用通道"
                description="这通常表示通道插件全都被跳过、启动失败，或者这台机器当前没有任何可加载通道。面板不会再伪装成“等待实例连接”。"
                detail={`${ais.length} 个已知实例 · ${pendingApprovals.length} 个待处理审批 · Forge Hub v${hubInfo.version}`}
              />
            ) : hasActiveAI ? (
              <ChatMode
                activeId={effectiveActiveAI}
                hubVersion={hubInfo.version}
                ais={ais}
                lastMessages={lastMessages}
                conversations={conversations}
                channels={channels}
                onSelect={setActiveAI}
              />
            ) : (
              <HubStateCard
                title="Hub 已连接，但还没有实例接入"
                description="通道已经就绪，只是当前还没有 Claude Code 实例出现在 roster 里。启动一个带 Hub 通道的实例后，这里会自动刷新。"
                detail={`当前已加载 ${channels.length} 个通道 · ${pendingApprovals.length} 个待处理审批`}
              />
            )}
          </div>
          <div className={`mode-pane ${mode === 'ops' ? 'enter' : 'exit'}`}>
            <OpsMode
              ais={ais}
              channels={channels}
              routerLog={[]}
              approvalQueue={approvalQueue}
              system={systemInfo}
            />
          </div>
        </ErrorBoundary>
      </div>
    </>
  );
}

const SYSTEM_DEFAULT: DashboardSystemInfo = {
  pid: null,
  memory: '—',
  memoryPct: null,
  cpu: '未提供',
  cpuPct: null,
  uptime: '—',
  version: '—',
  node: '—',
};
