import React from "react";
import { Avatar, IconSearch, IconMore, IconPaperclip, IconSparkle, IconSend } from "./icons";
import { CHANNEL_ICON } from "./channel_icons";
import { approveFromDashboard, denyFromDashboard, sendMessage } from "./api";
import type { DesignAI, DesignChannel } from "./adapter";
import { isNativeApp, bridge } from "./native-bridge";
import { useHubStore } from "./store";

interface LastMessagePreview {
  from: "ai" | "me";
  text: string;
  unread: number;
}

interface ChatMessage {
  id: string | number;
  dir: "in" | "out" | "approval";
  text?: string;
  time?: string;
  tool?: string;
  intent?: string;
  command?: string;
  risk?: "low" | "medium" | "high" | "unknown";
  request_id?: string;
}

interface HistoryItem {
  ts: string;
  direction: "in" | "out";
  from: string;
  text: string;
}

interface ChatModeProps {
  activeId: string;
  hubVersion: string;
  ais: DesignAI[];
  lastMessages: Record<string, LastMessagePreview>;
  conversations: Record<string, ChatMessage[]>;
  channels: DesignChannel[];
  onSelect: (id: string) => void;
}

interface ContactRowProps {
  ai: DesignAI;
  last?: LastMessagePreview;
  active: boolean;
  onClick: () => void;
}

interface MessageProps {
  msg: ChatMessage;
  ai: DesignAI;
  onApprove: () => void;
  onDeny: () => void;
}

interface ContactListProps {
  activeId: string;
  hubVersion: string;
  ais: DesignAI[];
  lastMessages: Record<string, LastMessagePreview>;
  search: string;
  onSelect: (id: string) => void;
  onSearch: (value: string) => void;
}

interface ChatWindowProps {
  ai: DesignAI;
  messages: ChatMessage[];
  onSend: (text: string) => void;
  onApproval: (msgId: string | number, yes: boolean) => void;
  source: string;
  sources: string[];
  onSourceChange: (source: string) => void;
  onRefresh?: () => void;
}

interface ProfileProps {
  ai: DesignAI;
  pending: ChatMessage[];
  channels: DesignChannel[];
  activeSource?: string;
  onSourceChange?: (source: string) => void;
}

const historyLoadedIds = new Set<string>();

function mergeConversations(
  base: Record<string, ChatMessage[]>,
  overlay: Record<string, ChatMessage[]>,
): Record<string, ChatMessage[]> {
  const merged: Record<string, ChatMessage[]> = {};
  const ids = new Set([...Object.keys(base || {}), ...Object.keys(overlay || {})]);

  for (const id of ids) {
    const seen = new Set();
    const rows = [];
    for (const msg of [...(base[id] || []), ...(overlay[id] || [])]) {
      const key = msg?.id == null ? "" : String(msg.id);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      rows.push(msg);
    }
    merged[id] = rows;
  }

  return merged;
}

const chatModeCss = `
@keyframes avatarPulse {
  0%, 100% { opacity: 0.9; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(1.06); }
}
@keyframes msgIn {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes typingDot {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.35; }
  30% { transform: translateY(-3px); opacity: 0.9; }
}
`;

const chatStyles = {
  root: { display: 'flex', height: '100%', width: '100%' },

  /* Left: 联系人列表 */
  list: {
    width: 296, flexShrink: 0,
    borderRight: '1px solid var(--border-subtle)',
    display: 'flex', flexDirection: 'column',
    background: 'linear-gradient(180deg, rgba(17,17,24,0.6) 0%, rgba(11,11,16,0.75) 100%)',
    backdropFilter: 'blur(22px)',
  },
  listHeader: {
    padding: '20px 20px 14px',
    display: 'flex', alignItems: 'center', gap: 12,
  },
  brand: { fontSize: 15, fontWeight: 600, color: 'var(--text-0)', letterSpacing: '-0.01em' },
  brandMeta: { fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' },
  search: {
    margin: '0 14px 8px',
    padding: '8px 12px', borderRadius: 10,
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid var(--border-subtle)',
    display: 'flex', alignItems: 'center', gap: 8,
    fontSize: 12, color: 'var(--text-3)',
  },
  contacts: { flex: 1, overflowY: 'auto', padding: '4px 8px 8px' },
  contact: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '10px 12px', borderRadius: 12,
    cursor: 'pointer', transition: 'background 140ms',
    marginBottom: 2,
  },
  contactActive: {
    background: 'linear-gradient(90deg, rgba(99,102,241,0.14) 0%, rgba(99,102,241,0.04) 100%)',
    boxShadow: 'inset 0 0 0 1px rgba(99,102,241,0.2)',
  },
  contactBody: { flex: 1, minWidth: 0 },
  contactTop: { display: 'flex', alignItems: 'baseline', gap: 8 },
  contactName: { fontSize: 14, fontWeight: 500, color: 'var(--text-0)', letterSpacing: '-0.005em' },
  contactAlias: { fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' },
  contactBadge: {
    padding: '1px 6px',
    borderRadius: 999,
    fontSize: 10.5,
    color: 'var(--text-3)',
    fontFamily: 'var(--mono)',
    border: '1px solid var(--border-subtle)',
    background: 'rgba(255,255,255,0.03)',
    flexShrink: 0,
  },
  contactTime: { marginLeft: 'auto', fontSize: 10.5, color: 'var(--text-4)', fontFamily: 'var(--mono)', flexShrink: 0 },
  contactPreview: {
    fontSize: 12, color: 'var(--text-3)', marginTop: 2,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  unreadBadge: {
    marginLeft: 6, padding: '0 6px', height: 16, lineHeight: '16px',
    borderRadius: 8, background: 'var(--indigo)', color: 'white',
    fontSize: 10, fontWeight: 600, fontFamily: 'var(--mono)',
    display: 'inline-block', minWidth: 16, textAlign: 'center',
  },

  /* Center: 聊天窗 */
  chat: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
  chatHeader: {
    padding: '16px 28px',
    display: 'flex', alignItems: 'center', gap: 14,
    borderBottom: '1px solid var(--border-subtle)',
    background: 'rgba(11,11,16,0.4)',
    backdropFilter: 'blur(14px)',
  },
  chatTitle: { fontSize: 16, fontWeight: 600, color: 'var(--text-0)', letterSpacing: '-0.01em' },
  chatStatus: {
    fontSize: 12, color: 'var(--text-2)', marginTop: 2,
    display: 'flex', alignItems: 'center', gap: 6,
  },
  headerActions: { marginLeft: 'auto', display: 'flex', gap: 4, color: 'var(--text-3)' },
  headerBtn: { padding: 8, borderRadius: 8 },

  messages: {
    flex: 1, overflowY: 'auto',
    padding: '32px 80px 20px',
    display: 'flex', flexDirection: 'column', gap: 14,
  },
  dateSep: {
    alignSelf: 'center',
    fontSize: 11, color: 'var(--text-4)', fontFamily: 'var(--mono)',
    margin: '8px 0 4px',
  },

  msgRow: { display: 'flex', gap: 10, maxWidth: '72%', animation: 'msgIn 240ms ease-out' },
  msgRowOut: { marginLeft: 'auto', flexDirection: 'row-reverse' },
  msgStack: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },

  bubble: {
    padding: '10px 14px',
    borderRadius: 16,
    fontSize: 14, lineHeight: 1.55,
    color: 'var(--text-0)',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  },
  bubbleIn: {
    background: 'linear-gradient(180deg, #1c1c26 0%, #17171f 100%)',
    border: '1px solid var(--border-soft)',
    borderTopLeftRadius: 6,
  },
  bubbleOut: {
    background: 'linear-gradient(180deg, rgba(99,102,241,0.22) 0%, rgba(99,102,241,0.12) 100%)',
    border: '1px solid rgba(99,102,241,0.3)',
    borderTopRightRadius: 6,
    boxShadow: '0 6px 24px -10px rgba(99,102,241,0.5)',
  },
  msgTime: {
    fontSize: 10.5, color: 'var(--text-4)', fontFamily: 'var(--mono)',
    alignSelf: 'flex-end', padding: '0 4px',
  },
  msgTimeOut: { alignSelf: 'flex-start' },

  /* 审批气泡 — 温和卡片形态 */
  approvalBubble: {
    alignSelf: 'flex-start',
    maxWidth: 420,
    padding: 14,
    borderRadius: 16,
    background: 'linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.015) 100%)',
    border: '1px solid var(--border)',
    borderTopLeftRadius: 6,
    display: 'flex', flexDirection: 'column', gap: 8,
    animation: 'msgIn 240ms ease-out',
  },
  approvalHead: {
    display: 'flex', alignItems: 'center', gap: 8,
    fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)',
    textTransform: 'uppercase', letterSpacing: '0.06em',
  },
  approvalIntent: { fontSize: 14, color: 'var(--text-0)', lineHeight: 1.5 },
  approvalCode: {
    fontFamily: 'var(--mono)', fontSize: 11.5,
    padding: '8px 10px', borderRadius: 8,
    background: 'rgba(0,0,0,0.35)', border: '1px solid var(--border-subtle)',
    color: 'var(--text-1)',
    overflowX: 'auto', whiteSpace: 'pre',
  },
  approvalActions: { display: 'flex', gap: 8 },
  approvalYes: {
    padding: '6px 14px', borderRadius: 8,
    background: 'linear-gradient(180deg, #7c7fff 0%, #4f52e8 100%)',
    color: 'white', fontSize: 12, fontWeight: 600,
    boxShadow: '0 4px 14px rgba(99,102,241,0.35)',
  },
  approvalNo: {
    padding: '6px 14px', borderRadius: 8,
    background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)',
    color: 'var(--text-1)', fontSize: 12, fontWeight: 500,
  },

  /* 输入框 */
  composerWrap: {
    padding: '16px 28px 22px',
    borderTop: '1px solid var(--border-subtle)',
    background: 'rgba(11,11,16,0.4)',
    backdropFilter: 'blur(14px)',
  },
  composer: {
    background: 'linear-gradient(180deg, #15151d 0%, #111118 100%)',
    border: '1px solid var(--border)',
    borderRadius: 16,
    padding: '12px 14px',
    display: 'flex', flexDirection: 'column', gap: 10,
    transition: 'border-color 160ms, box-shadow 160ms',
  },
  composerMuted: {
    background: 'linear-gradient(180deg, #13131a 0%, #101016 100%)',
    borderColor: 'var(--border-subtle)',
    boxShadow: 'none',
  },
  composerFocus: {
    borderColor: 'rgba(99,102,241,0.45)',
    boxShadow: '0 0 0 3px rgba(99,102,241,0.1), 0 0 28px -8px rgba(99,102,241,0.4)',
  },
  composerInput: {
    width: '100%', fontSize: 14, color: 'var(--text-0)',
    minHeight: 22, maxHeight: 180, resize: 'none',
    lineHeight: 1.55, padding: '2px 0',
  },
  composerBar: { display: 'flex', alignItems: 'center', gap: 8 },
  composerToolBtn: { padding: 6, borderRadius: 6, color: 'var(--text-3)' },
  sendBtn: {
    padding: '7px 14px', borderRadius: 10,
    background: 'linear-gradient(180deg, #7c7fff 0%, #4f52e8 100%)',
    color: 'white', fontSize: 13, fontWeight: 600,
    display: 'flex', alignItems: 'center', gap: 6,
    boxShadow: '0 4px 14px rgba(99,102,241,0.35)',
    marginLeft: 'auto',
  },
  sendBtnDisabled: {
    background: 'rgba(255,255,255,0.04)', color: 'var(--text-3)', boxShadow: 'none',
  },
  hint: { fontSize: 11, color: 'var(--text-4)', fontFamily: 'var(--mono)' },
  mutedText: { fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5 },

  /* Right: 轻档案 */
  profile: {
    width: 296, flexShrink: 0,
    borderLeft: '1px solid var(--border-subtle)',
    overflowY: 'auto',
    padding: '24px 20px',
    display: 'flex', flexDirection: 'column', gap: 20,
  },
  profileHead: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    textAlign: 'center', gap: 10, padding: '8px 0 4px',
  },
  profileName: { fontSize: 18, fontWeight: 600, color: 'var(--text-0)', letterSpacing: '-0.015em' },
  profileRole: { fontSize: 12, color: 'var(--text-2)', marginTop: 2 },
  profileStatus: {
    fontSize: 12, color: 'var(--text-1)',
    padding: '6px 12px', borderRadius: 20,
    background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)',
    display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 4,
  },
  profileSection: {
    fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.1em',
    fontWeight: 600, marginBottom: 10,
  },
  kv: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '6px 0', fontSize: 13,
  },
  kvKey: { color: 'var(--text-3)' },
  kvVal: { color: 'var(--text-1)', fontFamily: 'var(--mono)', fontSize: 12 },
  channelPill: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '4px 10px', borderRadius: 20,
    background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)',
    fontSize: 11.5, color: 'var(--text-1)',
  },
  approvalCard: {
    padding: 14, borderRadius: 12,
    background: 'linear-gradient(180deg, rgba(99,102,241,0.08) 0%, rgba(99,102,241,0.02) 100%)',
    border: '1px solid rgba(99,102,241,0.22)',
    display: 'flex', flexDirection: 'column', gap: 10,
  },
} as const;

function timeStr() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function ContactRow({ ai, last, active, onClick }: ContactRowProps) {
  const statusColor = ai.status === 'online' ? 'var(--green)' : 'var(--text-4)';
  const preview = last ?? { from: 'ai', text: ai.statusText, unread: 0 };
  return (
    <div
      onClick={onClick}
      style={{ ...chatStyles.contact, ...(active ? chatStyles.contactActive : {}) }}
      className="hoverable"
    >
      <div style={{ position: 'relative' }}>
        <Avatar ai={ai} size={40} />
        <span style={{
          position: 'absolute', right: -1, bottom: -1,
          width: 10, height: 10, borderRadius: '50%',
          background: statusColor,
          border: '2px solid var(--bg-0)',
          boxShadow: ai.status === 'online' ? '0 0 8px rgba(74,222,128,0.6)' : 'none',
        }}/>
      </div>
      <div style={chatStyles.contactBody}>
        <div style={chatStyles.contactTop}>
          <span style={chatStyles.contactName}>{ai.name}</span>
          {ai.alias && <span style={chatStyles.contactAlias}>· {ai.alias}</span>}
          {!ai.isChannel && <span style={chatStyles.contactBadge}>仅工具</span>}
          <span style={chatStyles.contactTime}>{ai.lastMessageAt}</span>
        </div>
        <div style={chatStyles.contactPreview}>
          {preview.from === 'me' ? <span style={{ color: 'var(--text-4)' }}>我: </span> : null}
          {preview.text}
          {preview.unread > 0 && <span style={chatStyles.unreadBadge}>{preview.unread}</span>}
        </div>
      </div>
    </div>
  );
}

function Message({ msg, ai, onApprove, onDeny }: MessageProps) {
  if (msg.dir === 'approval') {
    const riskColor = msg.risk === 'low'
      ? 'var(--green)'
      : msg.risk === 'medium'
        ? 'var(--amber)'
        : msg.risk === 'high'
          ? 'var(--red)'
          : 'var(--text-3)';
    const riskLabel = msg.risk === 'low'
      ? '低风险'
      : msg.risk === 'medium'
        ? '中风险'
        : msg.risk === 'high'
          ? '高风险'
          : '未分级';
    return (
      <div style={chatStyles.approvalBubble}>
        <div style={chatStyles.approvalHead}>
          <IconSparkle size={12} style={{ color: 'var(--indigo-soft)' }}/>
          <span>{ai.name} 想请你决定</span>
          <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: riskColor }}/>
            {riskLabel}
          </span>
        </div>
        <div style={chatStyles.approvalIntent}>{msg.intent}</div>
        <div style={chatStyles.approvalCode}>{msg.command}</div>
        <div style={chatStyles.approvalActions}>
          <button className="hoverable" style={chatStyles.approvalYes} onClick={onApprove}>好，去做</button>
          <button className="hoverable" style={chatStyles.approvalNo} onClick={onDeny}>再想想</button>
          <span style={{ ...chatStyles.hint, marginLeft: 'auto', alignSelf: 'center' }}>{msg.time}</span>
        </div>
      </div>
    );
  }
  const isOut = msg.dir === 'out';
  return (
    <div style={{ ...chatStyles.msgRow, ...(isOut ? chatStyles.msgRowOut : {}) }}>
      {!isOut && <Avatar ai={ai} size={30}/>}
      <div style={chatStyles.msgStack}>
        <div style={{ ...chatStyles.bubble, ...(isOut ? chatStyles.bubbleOut : chatStyles.bubbleIn) }}>
          {msg.text}
        </div>
        <span style={{ ...chatStyles.msgTime, ...(isOut ? chatStyles.msgTimeOut : {}) }}>{msg.time}</span>
      </div>
    </div>
  );
}

function TypingIndicator({ ai }: { ai: DesignAI }) {
  return (
    <div style={{ ...chatStyles.msgRow }}>
      <Avatar ai={ai} size={30}/>
      <div style={{ ...chatStyles.bubble, ...chatStyles.bubbleIn, padding: '12px 14px', display: 'flex', gap: 4 }}>
        {[0, 1, 2].map(i => (
          <span key={i} style={{
            width: 5, height: 5, borderRadius: '50%', background: 'var(--text-2)',
            animation: `typingDot 1.2s ease-in-out ${i * 0.15}s infinite`,
          }}/>
        ))}
      </div>
    </div>
  );
}

function pinyinMatch(text: string, query: string): boolean {
  if (text.toLowerCase().includes(query)) return true;
  return false;
}

function ContactContextMenu({ ai, x, y, onClose, onAction }: {
  ai: DesignAI; x: number; y: number; onClose: () => void;
  onAction: (action: string, sid: string) => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const handler = () => onClose();
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [onClose]);

  const items = [
    { label: '📝 描述...', action: 'rename' },
    ...(ai.status === 'online' ? [{ label: '📡 标签...', action: 'tag' }] : []),
    { label: ai.isChannel ? '★ 置顶' : '★ 置顶', action: 'star' },
    ...(ai.status !== 'online' ? [{ label: '📡 通道恢复', action: 'resumeChannel' }] : []),
    { label: '聚焦终端', action: 'focus', disabled: ai.status !== 'online' },
    null,
    { label: '复制 Session ID', action: 'copyId' },
  ];

  return (
    <div ref={ref} style={{
      position: 'fixed', left: x, top: y, zIndex: 9999,
      background: 'rgba(28,28,36,0.96)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '4px 0', minWidth: 180,
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)', backdropFilter: 'blur(20px)',
    }}>
      {items.map((item, i) => item === null
        ? <div key={i} style={{ height: 1, background: 'var(--border)', margin: '4px 8px' }}/>
        : <div key={i} className="hoverable" onClick={(e) => {
            e.stopPropagation();
            if ('disabled' in item && item.disabled) return;
            onAction(item.action, ai.id);
            onClose();
          }} style={{
            padding: '6px 14px', fontSize: 12, color: 'disabled' in item && item.disabled ? 'var(--text-4)' : 'var(--text-1)',
            cursor: 'disabled' in item && item.disabled ? 'default' : 'pointer',
          }}>{item.label}</div>
      )}
    </div>
  );
}

function ChannelConfigDialog({ title, channels, preselected, onConfirm, onCancel }: {
  title: string;
  channels: Array<{ id: string; name: string }>;
  preselected: string[];
  onConfirm: (config: { channels: string[]; history: Record<string, number> }) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = React.useState<Set<string>>(() => {
    if (preselected.length > 0) return new Set(preselected);
    return new Set(channels.map(c => c.id));
  });
  const [historyCounts, setHistoryCounts] = React.useState<Record<string, string>>(() => {
    const h: Record<string, string> = {};
    channels.forEach(c => { h[c.id] = '10'; });
    return h;
  });

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 10000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
    }} onClick={onCancel}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 380, padding: '20px 24px', borderRadius: 16,
        background: 'linear-gradient(180deg, rgba(24,24,34,0.98) 0%, rgba(15,15,22,1) 100%)',
        border: '1px solid var(--border)', boxShadow: '0 24px 80px rgba(0,0,0,0.5)',
      }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-0)', marginBottom: 4 }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 16 }}>
          订阅：接收该通道的实时消息 · 历史：启动时回放的条数
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {channels.map(ch => (
            <div key={ch.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, cursor: 'pointer', fontSize: 13, color: 'var(--text-1)' }}>
                <input type="checkbox" checked={selected.has(ch.id)}
                  onChange={() => setSelected(prev => {
                    const next = new Set(prev);
                    next.has(ch.id) ? next.delete(ch.id) : next.add(ch.id);
                    return next;
                  })}
                  style={{ accentColor: 'var(--indigo)' }}
                />
                {ch.name}
              </label>
              <input
                value={historyCounts[ch.id] ?? '10'}
                onChange={e => setHistoryCounts(prev => ({ ...prev, [ch.id]: e.target.value }))}
                style={{
                  width: 50, padding: '3px 6px', borderRadius: 6,
                  border: '1px solid var(--border)', background: 'rgba(255,255,255,0.04)',
                  color: 'var(--text-1)', fontSize: 12, fontFamily: 'var(--mono)', textAlign: 'center',
                }}
              />
              <span style={{ fontSize: 11, color: 'var(--text-4)' }}>条</span>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{
            padding: '7px 14px', borderRadius: 8, border: '1px solid var(--border)',
            background: 'transparent', color: 'var(--text-2)', fontSize: 12, cursor: 'pointer',
          }}>取消</button>
          <button onClick={() => {
            const ch = [...selected];
            const h: Record<string, number> = {};
            for (const id of ch) h[id] = parseInt(historyCounts[id] ?? '10', 10) || 10;
            onConfirm({ channels: ch, history: h });
          }} style={{
            padding: '7px 14px', borderRadius: 8, border: '1px solid rgba(99,102,241,0.3)',
            background: 'rgba(99,102,241,0.15)', color: 'var(--indigo)', fontSize: 12, cursor: 'pointer',
          }}>以此启动</button>
        </div>
      </div>
    </div>
  );
}

function ContactList({ activeId, hubVersion, ais, lastMessages, onSelect, search, onSearch }: ContactListProps & {
  onContextAction?: (action: string, sid: string) => void;
}) {
  const [ctxMenu, setCtxMenu] = React.useState<{ ai: DesignAI; x: number; y: number } | null>(null);
  const [channelDialog, setChannelDialog] = React.useState<{ sid: string; channels: Array<{ id: string; name: string }>; preselected: string[] } | null>(null);
  const filtered = ais.filter((ai) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return ai.name.toLowerCase().includes(q)
      || (ai.alias && ai.alias.toLowerCase().includes(q))
      || pinyinMatch(ai.name, q);
  });

  return (
    <aside style={chatStyles.list}>
      <div style={chatStyles.listHeader}>
        <div style={{
          width: 34, height: 34, borderRadius: 10,
          background: 'linear-gradient(135deg, #7c7fff 0%, #4338ca 100%)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 0 0 1px rgba(255,255,255,0.08), 0 4px 14px rgba(99,102,241,0.35)',
        }}>
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
            <path d="M4 2 L16 2 L10 10 L16 10 L6 18 L10 10 L4 10 Z" fill="white" fillOpacity="0.95"/>
          </svg>
        </div>
        <div style={{ flex: 1 }}>
          <div style={chatStyles.brand}>Forge Hub</div>
          <div style={chatStyles.brandMeta}>v{hubVersion} · 运行中</div>
        </div>
      </div>
      <div style={chatStyles.search}>
        <IconSearch size={13}/>
        <input
          value={search}
          onChange={e => onSearch(e.target.value)}
          placeholder="搜索你的 AI 们…"
          style={{ flex: 1, fontSize: 12, color: 'var(--text-0)' }}
        />
      </div>
      <div style={chatStyles.contacts}>
        {filtered.map(ai => (
          <div key={ai.id} onContextMenu={(e) => {
            e.preventDefault();
            setCtxMenu({ ai, x: e.clientX, y: e.clientY });
          }}>
            <ContactRow
              ai={ai}
              last={lastMessages[ai.id]}
              active={ai.id === activeId}
              onClick={() => onSelect(ai.id)}
            />
          </div>
        ))}
      </div>
      {channelDialog && <ChannelConfigDialog
        title="通道恢复"
        channels={channelDialog.channels}
        preselected={channelDialog.preselected}
        onCancel={() => setChannelDialog(null)}
        onConfirm={(config) => {
          const sessions = useHubStore.getState().nativeSessions;
          const session = sessions.find((s: { sid: string }) => s.sid === channelDialog.sid);
          const desc = session?.description || session?.hubDesc || '';
          const tag = session?.tag || session?.hubTag || '';
          bridge.resumeChannelSession(channelDialog.sid, {
            channels: config.channels,
            description: desc,
            tag,
            historyCount: Math.max(...Object.values(config.history), 10),
          });
          setChannelDialog(null);
        }}
      />}
      {ctxMenu && <ContactContextMenu
        ai={ctxMenu.ai} x={ctxMenu.x} y={ctxMenu.y}
        onClose={() => setCtxMenu(null)}
        onAction={(action, sid) => {
          // dispatch via bridge
          if (isNativeApp()) {
            switch (action) {
              case 'rename': {
                const name = prompt('新描述：');
                if (name) bridge.renameSession(sid, name);
                break;
              }
              case 'tag': {
                const tag = prompt('新标签：');
                if (tag) bridge.setSessionTag(sid, tag);
                break;
              }
              case 'star': bridge.starSession(sid); break;
              case 'focus': bridge.focusTerminal(sid); break;
              case 'resumeChannel': {
                bridge.fetchHubChannels().then(hubCh => {
                  const sessions = useHubStore.getState().nativeSessions;
                  const session = sessions.find((s: { sid: string }) => s.sid === sid);
                  const pre = session?.channels?.length ? session.channels : [];
                  const channelList = hubCh.length > 0
                    ? hubCh.map((c: { id: string; name: string }) => ({ id: c.id, name: c.name }))
                    : [{ id: 'wechat', name: '微信' }, { id: 'telegram', name: 'Telegram' }, { id: 'feishu', name: '飞书' }, { id: 'imessage', name: 'iMessage' }, { id: 'homeland', name: 'Homeland' }];
                  setChannelDialog({ sid, channels: channelList, preselected: pre });
                }).catch(() => {
                  setChannelDialog({
                    sid,
                    channels: [{ id: 'wechat', name: '微信' }, { id: 'telegram', name: 'Telegram' }, { id: 'feishu', name: '飞书' }, { id: 'imessage', name: 'iMessage' }, { id: 'homeland', name: 'Homeland' }],
                    preselected: [],
                  });
                });
                break;
              }
              case 'copyId': navigator.clipboard.writeText(sid); break;
            }
          }
        }}
      />}
    </aside>
  );
}

function SourceSelector({ sources, active, onChange, onRefresh }: { sources: string[]; active: string; onChange: (s: string) => void; onRefresh?: () => void }) {
  const labels: Record<string, string> = {
    jsonl: '对话', wechat: '微信', telegram: 'TG', feishu: '飞书',
    imessage: 'iMsg', homeland: 'Home', all: '全部',
  };
  return (
    <div style={{ display: 'flex', gap: 4, marginLeft: 12, flexShrink: 0 }}>
      {sources.map(s => (
        <button key={s} onClick={() => onChange(s)} style={{
          padding: '3px 10px', borderRadius: 8, border: 'none', cursor: 'pointer',
          fontSize: 11, fontFamily: 'var(--mono)', letterSpacing: '0.02em',
          background: s === active ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.04)',
          color: s === active ? 'var(--indigo)' : 'var(--text-3)',
          transition: 'all 120ms ease',
        }}>{labels[s] || s}</button>
      ))}
      {onRefresh && <button onClick={onRefresh} style={{
        padding: '3px 8px', borderRadius: 8, border: 'none', cursor: 'pointer',
        fontSize: 11, fontFamily: 'var(--mono)',
        background: 'rgba(255,255,255,0.04)', color: 'var(--text-3)',
        transition: 'all 120ms ease',
      }}>↻</button>}
    </div>
  );
}

function ChatWindow({ ai, messages, onSend, onApproval, source, sources, onSourceChange, onRefresh }: ChatWindowProps) {
  const [value, setValue] = React.useState('');
  const [focus, setFocus] = React.useState(false);
  const typing = false;
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const taRef = React.useRef<HTMLTextAreaElement | null>(null);
  const canReceive = ai.isChannel;

  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, ai.id, typing]);

  const handleSend = () => {
    if (!canReceive || !value.trim()) return;
    onSend(value.trim());
    setValue('');
    if (taRef.current) taRef.current.style.height = 'auto';
    // 打字指示器由真实的 SSE 消息到达时清除（未来实现）
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
  };

  return (
    <section style={chatStyles.chat}>
      <div style={chatStyles.chatHeader}>
        <Avatar ai={ai} size={40} pulse={ai.status === 'online' && canReceive}/>
        <div>
          <div style={{ ...chatStyles.chatTitle, display: 'flex', alignItems: 'center' }}>
            <span>{ai.name}</span>
            {ai.alias && <span style={{ color: 'var(--text-3)', fontWeight: 400, fontSize: 13, marginLeft: 6 }}>· {ai.alias}</span>}
            <SourceSelector sources={sources} active={source} onChange={onSourceChange} onRefresh={onRefresh}/>
          </div>
          <div style={chatStyles.chatStatus}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: ai.status === 'online' ? 'var(--green)' : 'var(--text-4)',
              boxShadow: ai.status === 'online' && canReceive ? '0 0 6px var(--green-glow)' : 'none',
            }}/>
            <span>{ai.statusText}</span>
          </div>
        </div>
        <div style={chatStyles.headerActions}>
          <button className="hoverable" style={chatStyles.headerBtn}><IconSearch size={14}/></button>
          <button className="hoverable" style={chatStyles.headerBtn}><IconMore size={14}/></button>
        </div>
      </div>

      <div ref={scrollRef} style={chatStyles.messages}>
        <div style={chatStyles.dateSep}>今天</div>
        {messages.map(msg => (
          <Message
            key={msg.id}
            msg={msg}
            ai={ai}
            onApprove={() => onApproval(msg.id, true)}
            onDeny={() => onApproval(msg.id, false)}
          />
        ))}
        {typing && <TypingIndicator ai={ai}/>}
      </div>

      <div style={chatStyles.composerWrap}>
        <div style={{ ...chatStyles.composer, ...(canReceive ? {} : chatStyles.composerMuted), ...(focus && canReceive ? chatStyles.composerFocus : {}) }}>
          <textarea
            ref={taRef}
            style={chatStyles.composerInput}
            placeholder={canReceive ? `和${ai.name}说点什么…` : `${ai.name} 现在是仅工具实例，不能接收消息`}
            value={value}
            onChange={handleInput}
            onKeyDown={handleKey}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            disabled={!canReceive}
            rows={1}
          />
          <div style={chatStyles.composerBar}>
            <button className="hoverable" style={chatStyles.composerToolBtn} disabled={!canReceive}><IconPaperclip size={15}/></button>
            <button className="hoverable" style={chatStyles.composerToolBtn} disabled={!canReceive}><IconSparkle size={15}/></button>
            <span style={chatStyles.hint}>{canReceive ? '↵ 发送 · ⇧↵ 换行' : '这是一个仅工具实例，不在通道接手链上'}</span>
            <button
              onClick={handleSend}
              style={{ ...chatStyles.sendBtn, ...((canReceive && value.trim()) ? {} : chatStyles.sendBtnDisabled) }}
              disabled={!canReceive || !value.trim()}
            >
              <IconSend size={12}/> 发送
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Profile({ ai, pending, channels, activeSource, onSourceChange }: ProfileProps) {
  return (
    <aside style={chatStyles.profile}>
      <div style={chatStyles.profileHead}>
        <Avatar ai={ai} size={76} pulse={ai.status === 'online' && ai.isChannel} ring/>
        <div>
          <div style={chatStyles.profileName}>
            {ai.name}
            {ai.alias && <span style={{ color: 'var(--text-3)', fontWeight: 400, fontSize: 14, marginLeft: 6 }}>· {ai.alias}</span>}
          </div>
          <div style={chatStyles.profileRole}>{ai.role}</div>
        </div>
        <div style={chatStyles.profileStatus}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: ai.status === 'online' ? 'var(--green)' : 'var(--text-4)',
            boxShadow: ai.status === 'online' && ai.isChannel ? '0 0 6px var(--green-glow)' : 'none',
          }}/>
          {ai.statusText}
        </div>
      </div>

      <div>
        <div style={chatStyles.profileSection}>状态</div>
        <div style={chatStyles.kv}><span style={chatStyles.kvKey}>模式</span><span style={chatStyles.kvVal}>{ai.isChannel ? '通道接手' : '仅工具'}</span></div>
        <div style={chatStyles.kv}><span style={chatStyles.kvKey}>连接</span><span style={chatStyles.kvVal}>{ai.isChannel ? (ai.status === 'online' ? '在线' : '离线') : '不接收 Hub 消息'}</span></div>
        <div style={chatStyles.kv}><span style={chatStyles.kvKey}>运行时长</span><span style={chatStyles.kvVal}>{ai.uptime}</span></div>
      </div>

      <div>
        <div style={chatStyles.profileSection}>{ai.isChannel ? '可以从这些地方找到 TA' : '当前监听'}</div>
        {ai.channels.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {ai.channels.map(cid => {
              const chan = channels.find(c => c.id === cid);
              const ChanIcon = chan ? CHANNEL_ICON[chan.icon] : null;
              if (!chan || !ChanIcon) return null;
              const isActive = activeSource === cid;
              return (
                <span key={cid} onClick={() => onSourceChange?.(cid)} style={{
                  ...chatStyles.channelPill,
                  cursor: 'pointer',
                  background: isActive ? 'rgba(99,102,241,0.18)' : chatStyles.channelPill.background,
                  borderColor: isActive ? 'rgba(99,102,241,0.3)' : undefined,
                }}>
                  <ChanIcon size={12}/>{chan.name}
                </span>
              );
            })}
          </div>
        ) : (
          <div style={chatStyles.mutedText}>
            {ai.isChannel ? '当前没有限定通道，接手时会按 Hub 配置决定。' : '这个实例只保留工具能力，不监听任何外部通道。'}
          </div>
        )}
      </div>

      {pending.length > 0 && (
        <div>
          <div style={chatStyles.profileSection}>等你决定 · {pending.length}</div>
          {pending.map(p => (
            <div key={p.id} style={chatStyles.approvalCard}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>
                <IconSparkle size={11} style={{ color: 'var(--indigo-soft)' }}/>
                <span>{p.tool}</span>
                <span style={{ marginLeft: 'auto' }}>{p.time}</span>
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-0)', lineHeight: 1.5 }}>{p.intent}</div>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

function ChatMode({ activeId, hubVersion, ais, lastMessages, conversations, channels, onSelect }: ChatModeProps) {
  const nativeSessions = useHubStore((s) => s.nativeSessions);
  const [search, setSearch] = React.useState('');
  const [localConvos, setLocalConvos] = React.useState<Record<string, ChatMessage[]>>({});
  const [source, setSource] = React.useState('jsonl');
  const [refreshTick, setRefreshTick] = React.useState(0);
  const refreshSource = () => {
    const key = `${activeId}::${source}`;
    historyLoadedIds.delete(key);
    setRefreshTick(t => t + 1);
  };
  const convos = mergeConversations(conversations, localConvos);
  const ai = ais.find((entry) => entry.id === activeId);

  const native = isNativeApp();
  const sources = React.useMemo(() => {
    const s: string[] = [];
    if (native) s.push('jsonl');
    if (ai?.channels) {
      for (const ch of ai.channels) s.push(ch);
    }
    if (s.length === 0) s.push('jsonl');
    return s;
  }, [ai?.channels, native]);

  React.useEffect(() => {
    if (!sources.includes(source)) setSource(sources[0]);
  }, [sources, source]);

  const convoKey = `${activeId}::${source}`;
  const messages = convos[convoKey] || [];

  // 接收外部消息（SSE/polling 推送）
  React.useEffect(() => {
    const handler = (e: Event) => {
      const { contactId, message } = (e as CustomEvent<{ contactId: string; message: ChatMessage }>).detail;
      const key = `${contactId}::homeland`;
      setLocalConvos(prev => ({
        ...prev,
        [key]: [...(prev[key] || []), message]
      }));
    };
    window.addEventListener('hub-new-message', handler);
    return () => window.removeEventListener('hub-new-message', handler);
  }, []);

  // 加载数据（切换联系人或通道时）
  React.useEffect(() => {
    if (!activeId || !source) return;
    const loadKey = `${activeId}::${source}`;
    if (historyLoadedIds.has(loadKey)) return;
    historyLoadedIds.add(loadKey);

    if (source === 'jsonl' && native) {
      bridge.getSessionHistory(activeId, 100).then(history => {
        const msgs: ChatMessage[] = history.map((h, i) => ({
          id: `jsonl-${i}`,
          dir: (h.role === 'user' ? 'out' : 'in') as ChatMessage['dir'],
          text: h.text,
          time: '',
        }));
        setLocalConvos(prev => ({ ...prev, [loadKey]: msgs }));
      }).catch(err => console.warn('[hub] jsonl 加载失败:', err));
    } else if (source !== 'jsonl') {
      (async () => {
        try {
          const res = await fetch(`/api/history?channel=${source}&limit=50`);
          if (!res.ok) return;
          const data = await res.json() as { history?: HistoryItem[] };
          const historyRows = data.history ?? [];
          if (historyRows.length > 0) {
            const msgs: ChatMessage[] = historyRows.map((h, i) => ({
              id: `hist-${source}-${i}`,
              dir: (h.direction === 'in' ? 'out' : 'in') as ChatMessage['dir'],
              text: h.text,
              time: new Date(h.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            }));
            setLocalConvos(prev => ({ ...prev, [loadKey]: msgs }));
          }
        } catch (err) { console.warn(`[hub] 历史加载失败 (${source}):`, err); }
      })();
    }
  }, [activeId, source, native, ais, refreshTick]);

  const handleSend = (text: string) => {
    if (!ai?.isChannel) return;
    const currentKey = convoKey;
    setLocalConvos(prev => ({
      ...prev,
      [currentKey]: [...(prev[currentKey] || []), {
        id: Date.now(), dir: 'out', text, time: timeStr()
      }]
    }));
    // 真实 API 调用
    const hubId = nativeSessions.find(s => s.sid === activeId)?.hubInstanceId ?? activeId;
    void sendMessage(text, undefined, hubId).then((ok) => {
      if (!ok) {
        console.warn('[hub] 消息发送失败：当前接手实例可能已离线');
        const failKey = `${activeId}::homeland`;
        setLocalConvos(prev => ({
          ...prev,
          [failKey]: [
            ...(prev[failKey] || []),
            {
              id: `send-failed-${Date.now()}`,
              dir: 'in',
              text: '⚠️ 未送达：当前接手实例可能已离线，请重试或切换接手实例。',
              time: timeStr(),
            },
          ],
        }));
      }
    });
  };

  const handleApproval = async (msgId: string | number, yes: boolean) => {
    const msg = (convos[activeId] || []).find((m) => m.id === msgId);
    if (msg && msg.request_id) {
      const ok = yes
        ? await approveFromDashboard(msg.request_id)
        : await denyFromDashboard(msg.request_id);
      if (!ok) {
        console.warn(`[hub] 审批失败: ${msg.request_id}`);
        setLocalConvos(prev => ({
          ...prev,
          [activeId]: [
            ...(prev[activeId] || []),
            {
              id: `approval-failed-${Date.now()}`,
              dir: 'in',
              text: '⚠️ 审批未送达：实例可能已离线。卡片已保留，请重试。',
              time: timeStr(),
            },
          ],
        }));
        return;
      }

      setLocalConvos(prev => ({
        ...prev,
        [activeId]: [
          ...(prev[activeId] || []).filter(m => m.id !== msgId),
          { id: Date.now(), dir: 'in', text: yes ? '✅ 已批准' : '❌ 已拒绝', time: timeStr() }
        ]
      }));
      window.dispatchEvent(new CustomEvent('hub-approval-resolved', { detail: { id: msg.request_id } }));
    }
  };

  if (!ai) return null;
  const pending = (convos[activeId] || []).filter(m => m.dir === 'approval');

  return (
    <>
      <style>{chatModeCss}</style>
      <div style={chatStyles.root}>
        <ContactList
          activeId={activeId}
          hubVersion={hubVersion}
          ais={ais}
          lastMessages={lastMessages}
          onSelect={onSelect}
          search={search}
          onSearch={setSearch}
        />
        <ChatWindow ai={ai} messages={messages} onSend={handleSend} onApproval={handleApproval}
          source={source} sources={sources} onSourceChange={setSource} onRefresh={refreshSource}/>
        <Profile ai={ai} pending={pending} channels={channels}
          activeSource={source} onSourceChange={setSource}/>
      </div>
    </>
  );
}
export { ChatMode };
