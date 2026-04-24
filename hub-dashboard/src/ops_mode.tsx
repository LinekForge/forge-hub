import { Avatar, IconGauge, IconSparkle, IconRoute, IconCheck, IconActivity, IconTerminal, IconSettings, IconMore } from "./icons";
import { CHANNEL_ICON } from "./channel_icons";
import { approveFromDashboard, denyFromDashboard } from "./api";
import type { DesignAI, DesignApproval, DesignChannel } from "./adapter";

interface RouterLogEntry {
  t: string;
  dir: "in" | "out";
  via: string;
  ai: string;
  peer: string;
  size: number;
  ok: boolean;
  note?: string;
}

export interface DashboardSystemInfo {
  pid: number | null;
  memory: string;
  memoryPct: number | null;
  cpu: string;
  cpuPct: number | null;
  uptime: string;
  version: string;
  node: string;
}

interface OpsModeProps {
  ais: DesignAI[];
  channels: DesignChannel[];
  routerLog: RouterLogEntry[];
  approvalQueue: DesignApproval[];
  system: DashboardSystemInfo;
}

const opsCss = `
@keyframes opsPulse {
  0%, 100% { opacity: 0.7; } 50% { opacity: 1; }
}
@keyframes rowIn {
  from { opacity: 0; transform: translateX(-4px); }
  to   { opacity: 1; transform: translateX(0); }
}
`;

const opsStyles = {
  root: { display: 'grid', gridTemplateColumns: '240px 1fr 320px', height: '100%', width: '100%' },

  nav: {
    borderRight: '1px solid var(--border-subtle)',
    padding: '18px 12px',
    display: 'flex', flexDirection: 'column', gap: 2,
    background: 'rgba(11,11,16,0.3)',
  },
  navTitle: {
    fontSize: 10, fontWeight: 600, color: 'var(--text-3)',
    textTransform: 'uppercase', letterSpacing: '0.1em',
    padding: '8px 10px 6px',
  },
  navItem: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '7px 10px', borderRadius: 7,
    fontSize: 13, color: 'var(--text-2)',
    cursor: 'pointer',
  },
  navItemActive: {
    color: 'var(--text-0)',
    background: 'rgba(255,255,255,0.04)',
    boxShadow: 'inset 0 0 0 1px var(--border-soft)',
  },
  navCount: {
    marginLeft: 'auto', fontSize: 10, fontFamily: 'var(--mono)',
    color: 'var(--text-3)', padding: '1px 6px',
    background: 'rgba(255,255,255,0.04)', borderRadius: 4,
  },

  main: { overflowY: 'auto', padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 20 },

  h1: { fontSize: 20, fontWeight: 600, color: 'var(--text-0)', letterSpacing: '-0.02em', margin: 0 },
  sub: { fontSize: 12.5, color: 'var(--text-3)', marginTop: 4 },

  statsGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10,
  },
  statCard: {
    padding: 14, borderRadius: 12,
    background: 'linear-gradient(180deg, rgba(255,255,255,0.025) 0%, rgba(255,255,255,0.008) 100%)',
    border: '1px solid var(--border-soft)',
  },
  statLabel: { fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 500 },
  statValue: { fontSize: 22, fontWeight: 600, color: 'var(--text-0)', marginTop: 6, letterSpacing: '-0.02em', fontFamily: 'var(--mono)' },
  statSub: { fontSize: 11, color: 'var(--text-3)', marginTop: 4, fontFamily: 'var(--mono)' },

  card: {
    borderRadius: 12,
    background: 'linear-gradient(180deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0.005) 100%)',
    border: '1px solid var(--border-soft)',
    overflow: 'hidden',
  },
  cardHeader: {
    padding: '12px 16px',
    borderBottom: '1px solid var(--border-subtle)',
    display: 'flex', alignItems: 'center', gap: 10,
  },
  cardTitle: { fontSize: 12.5, fontWeight: 600, color: 'var(--text-1)' },

  table: { width: '100%', borderCollapse: 'collapse' },
  th: {
    fontSize: 10.5, fontWeight: 500, color: 'var(--text-3)',
    textTransform: 'uppercase', letterSpacing: '0.08em',
    padding: '8px 16px', textAlign: 'left',
    borderBottom: '1px solid var(--border-subtle)',
  },
  td: {
    padding: '10px 16px', fontSize: 12.5,
    color: 'var(--text-1)', borderBottom: '1px solid var(--border-subtle)',
    fontFamily: 'var(--mono)',
  },
  tr: { transition: 'background 120ms' },

  pill: (color: string) => ({
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '2px 8px', borderRadius: 20,
    fontSize: 10.5, fontFamily: 'var(--mono)', fontWeight: 500,
    background: `${color}18`, border: `1px solid ${color}40`, color,
  }),

  rightCol: {
    borderLeft: '1px solid var(--border-subtle)',
    padding: '20px 18px', overflowY: 'auto',
    display: 'flex', flexDirection: 'column', gap: 16,
  },

  kv: { display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 12.5 },
  kvKey: { color: 'var(--text-3)' },
  kvVal: { color: 'var(--text-1)', fontFamily: 'var(--mono)' },

  progBar: {
    height: 4, background: 'rgba(255,255,255,0.04)', borderRadius: 2,
    overflow: 'hidden', marginTop: 6,
  },
  progFill: (pct: number, color: string) => ({
    width: pct + '%', height: '100%',
    background: `linear-gradient(90deg, ${color}99 0%, ${color} 100%)`,
    transition: 'width 400ms',
  }),
} as const;

function healthColor(h: string) {
  return h === 'green' ? 'var(--green)' : h === 'amber' ? 'var(--amber)' : 'var(--red)';
}

function instancePillColor(ai: DesignAI) {
  if (!ai.isChannel) return 'var(--text-3)';
  return ai.status === 'online' ? 'var(--green)' : 'var(--amber)';
}

function instanceStatusLabel(ai: DesignAI) {
  if (!ai.isChannel) return '仅工具';
  return ai.status === 'online' ? '在线' : '离线';
}

function OpsMode({ ais, channels, routerLog, approvalQueue, system }: OpsModeProps) {
  const totalIn = channels.reduce((a, c) => a + c.inbound24h, 0);
  const totalOut = channels.reduce((a, c) => a + c.outbound24h, 0);
  const onlineAIs = ais.filter((a) => a.isChannel && a.status === 'online').length;
  const toolOnlyAIs = ais.filter((a) => !a.isChannel).length;
  const totalErrors = channels.reduce((a, c) => a + c.errors1h, 0);
  const affectedChannels = channels.filter((c) => c.health !== "green").length;

  return (
    <>
      <style>{opsCss}</style>
      <div style={opsStyles.root}>
        {/* Left nav */}
        <nav style={opsStyles.nav}>
          <div style={opsStyles.navTitle}>驾驶舱</div>
          <div style={{ ...opsStyles.navItem, ...opsStyles.navItemActive }}>
            <IconGauge size={15}/><span>总览</span>
          </div>
          <div style={opsStyles.navItem} className="hoverable">
            <IconSparkle size={15}/><span>AI 实例</span>
            <span style={opsStyles.navCount}>{ais.length}</span>
          </div>
          <div style={opsStyles.navItem} className="hoverable">
            <IconRoute size={15}/><span>通道</span>
            <span style={opsStyles.navCount}>{channels.length}</span>
          </div>
          <div style={opsStyles.navItem} className="hoverable">
            <IconCheck size={15}/><span>审批队列</span>
            <span style={opsStyles.navCount}>{approvalQueue.length}</span>
          </div>
          <div style={opsStyles.navItem} className="hoverable">
            <IconActivity size={15}/><span>消息路由</span>
          </div>
          <div style={opsStyles.navItem} className="hoverable">
            <IconTerminal size={15}/><span>日志</span>
          </div>
          <div style={opsStyles.navItem} className="hoverable">
            <IconSettings size={15}/><span>设置</span>
          </div>
          <div style={{ flex: 1 }}/>
          <div style={{ ...opsStyles.navTitle, marginTop: 0 }}>系统</div>
          <div style={{ padding: '4px 10px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-2)', lineHeight: 1.7 }}>
            <div><span style={{ color: 'var(--text-4)' }}>host</span> {system.node}</div>
            <div><span style={{ color: 'var(--text-4)' }}>ver</span>&nbsp;&nbsp;{system.version}</div>
            <div><span style={{ color: 'var(--text-4)' }}>up</span>&nbsp;&nbsp;&nbsp;{system.uptime}</div>
          </div>
        </nav>

        {/* Main */}
        <main style={opsStyles.main}>
          <div>
            <h1 style={opsStyles.h1}>总览</h1>
            <p style={opsStyles.sub}>{ais.length} 个 AI · {channels.length} 个通道 · 过去 24 小时</p>
          </div>

          {/* KPI row */}
          <div style={opsStyles.statsGrid}>
            <div style={opsStyles.statCard}>
              <div style={opsStyles.statLabel}>在线 AI</div>
              <div style={opsStyles.statValue}>{onlineAIs}<span style={{ color: 'var(--text-4)', fontSize: 14 }}> / {ais.length}</span></div>
              <div style={opsStyles.statSub}>{toolOnlyAIs > 0 ? `${toolOnlyAIs} 个仅工具实例` : '通道实例在线'}</div>
            </div>
            <div style={opsStyles.statCard}>
              <div style={opsStyles.statLabel}>入站 (24h)</div>
              <div style={opsStyles.statValue}>{totalIn.toLocaleString()}</div>
              <div style={opsStyles.statSub}>↓ 消息</div>
            </div>
            <div style={opsStyles.statCard}>
              <div style={opsStyles.statLabel}>出站 (24h)</div>
              <div style={opsStyles.statValue}>{totalOut.toLocaleString()}</div>
              <div style={opsStyles.statSub}>↑ 消息</div>
            </div>
            <div style={opsStyles.statCard}>
              <div style={opsStyles.statLabel}>错误 (1h)</div>
              <div style={{ ...opsStyles.statValue, color: totalErrors > 0 ? 'var(--amber)' : 'var(--text-0)' }}>
                {totalErrors}
              </div>
              <div style={opsStyles.statSub}>{affectedChannels} 个通道受影响</div>
            </div>
          </div>

          {/* AI 实例表 */}
          <div style={opsStyles.card}>
            <div style={opsStyles.cardHeader}>
              <IconSparkle size={13} style={{ color: 'var(--text-2)' }}/>
              <span style={opsStyles.cardTitle}>AI 实例</span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-3)' }}>{ais.length} 个</span>
            </div>
            <table style={opsStyles.table}>
              <thead>
                <tr>
                  <th style={opsStyles.th}>名称</th>
                  <th style={opsStyles.th}>状态</th>
                  <th style={opsStyles.th}>订阅通道</th>
                  <th style={opsStyles.th}>运行时长</th>
                  <th style={opsStyles.th}>最近活动</th>
                  <th style={opsStyles.th}></th>
                </tr>
              </thead>
              <tbody>
                {ais.map((ai, i) => (
                  <tr key={ai.id} style={{ ...opsStyles.tr, animation: `rowIn 300ms ease-out ${i * 40}ms both` }} className="hoverable">
                    <td style={opsStyles.td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Avatar ai={ai} size={24}/>
                        <span style={{ fontFamily: 'var(--font)', color: 'var(--text-0)' }}>
                          {ai.name}{ai.alias ? <span style={{ color: 'var(--text-3)' }}> · {ai.alias}</span> : ''}
                        </span>
                      </div>
                    </td>
                    <td style={opsStyles.td}>
                      <span style={opsStyles.pill(instancePillColor(ai))}>
                        <span style={{ width: 5, height: 5, borderRadius: '50%', background: instancePillColor(ai) }}/>
                        {instanceStatusLabel(ai)}
                      </span>
                    </td>
                    <td style={opsStyles.td}>
                      <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        {ai.channels.map(cid => {
                          const chan = channels.find(c => c.id === cid);
                          if (!chan) return null;
                          const ChanIcon = CHANNEL_ICON[chan.icon];
                          return <ChanIcon key={cid} size={13} style={{ color: 'var(--text-2)' }}/>;
                        })}
                        {ai.channels.length === 0 && <span style={{ color: 'var(--text-4)' }}>—</span>}
                      </div>
                    </td>
                    <td style={opsStyles.td}>{ai.uptime}</td>
                    <td style={opsStyles.td}>{ai.lastMessageAt}</td>
                    <td style={{ ...opsStyles.td, textAlign: 'right' }}>
                      <button style={{ color: 'var(--text-3)', padding: 4 }} className="hoverable"><IconMore size={14}/></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 通道表 */}
          <div style={opsStyles.card}>
            <div style={opsStyles.cardHeader}>
              <IconRoute size={13} style={{ color: 'var(--text-2)' }}/>
              <span style={opsStyles.cardTitle}>消息通道</span>
            </div>
            <table style={opsStyles.table}>
              <thead>
                <tr>
                  <th style={opsStyles.th}>通道</th>
                  <th style={opsStyles.th}>状态</th>
                  <th style={opsStyles.th}>延迟 p50</th>
                  <th style={opsStyles.th}>入站</th>
                  <th style={opsStyles.th}>出站</th>
                  <th style={opsStyles.th}>错误 (1h)</th>
                  <th style={opsStyles.th}>流量</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((c, i) => {
                  const ChanIcon = CHANNEL_ICON[c.icon];
                  const hc = healthColor(c.health);
                  return (
                    <tr key={c.id} style={{ ...opsStyles.tr, animation: `rowIn 300ms ease-out ${i * 40}ms both` }} className="hoverable">
                      <td style={opsStyles.td}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <ChanIcon size={16} style={{ color: 'var(--text-1)' }}/>
                          <span style={{ fontFamily: 'var(--font)', color: 'var(--text-0)' }}>{c.name}</span>
                        </div>
                      </td>
                      <td style={opsStyles.td}>
                        <span style={opsStyles.pill(hc)}>
                          <span style={{ width: 5, height: 5, borderRadius: '50%', background: hc }}/>
                          {c.health === 'green' ? '健康' : c.health === 'amber' ? '降级' : '离线'}
                        </span>
                      </td>
                      <td style={opsStyles.td}>{c.latencyLabel}</td>
                      <td style={opsStyles.td}>↓ {c.inbound24h.toLocaleString()}</td>
                      <td style={opsStyles.td}>↑ {c.outbound24h.toLocaleString()}</td>
                      <td style={{ ...opsStyles.td, color: c.errors1h > 0 ? 'var(--amber)' : 'var(--text-1)' }}>{c.errors1h}</td>
                      <td style={opsStyles.td}>{c.flowSummary}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* 路由流水 */}
          <div style={opsStyles.card}>
            <div style={opsStyles.cardHeader}>
              <IconActivity size={13} style={{ color: 'var(--text-2)' }}/>
              <span style={opsStyles.cardTitle}>消息路由流水</span>
              <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-3)' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', animation: 'opsPulse 1.6s infinite' }}/>
                实时
              </span>
            </div>
            <table style={opsStyles.table}>
              <thead>
                <tr>
                  <th style={opsStyles.th}>时间</th>
                  <th style={opsStyles.th}>方向</th>
                  <th style={opsStyles.th}>通道</th>
                  <th style={opsStyles.th}>AI</th>
                  <th style={opsStyles.th}>对端</th>
                  <th style={opsStyles.th}>大小</th>
                  <th style={opsStyles.th}>状态</th>
                </tr>
              </thead>
              <tbody>
                {routerLog.map((r, i) => {
                  const chan = channels.find(c => c.id === r.via);
                  const ChanIcon = chan ? CHANNEL_ICON[chan.icon] : null;
                  const ai = ais.find(a => a.id === r.ai);
                  if (!chan || !ChanIcon || !ai) return null;
                  return (
                    <tr key={i} style={opsStyles.tr} className="hoverable">
                      <td style={opsStyles.td}>{r.t}</td>
                      <td style={{ ...opsStyles.td, color: r.dir === 'in' ? 'var(--text-1)' : 'var(--indigo-soft)' }}>
                        {r.dir === 'in' ? '↓ in' : '↑ out'}
                      </td>
                      <td style={opsStyles.td}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <ChanIcon size={11} style={{ color: 'var(--text-2)' }}/>
                          {chan.name}
                        </span>
                      </td>
                      <td style={opsStyles.td}>{ai.name}{ai.alias ? ` · ${ai.alias}` : ''}</td>
                      <td style={opsStyles.td}>{r.peer}</td>
                      <td style={opsStyles.td}>{r.size}B</td>
                      <td style={opsStyles.td}>
                        {r.ok
                          ? <span style={opsStyles.pill('var(--green)')}>ok</span>
                          : <span style={opsStyles.pill('var(--amber)')}>{r.note || 'retry'}</span>}
                      </td>
                    </tr>
                  );
                })}
                {routerLog.length === 0 && (
                  <tr>
                    <td style={opsStyles.td} colSpan={7}>
                      当前版本还没有暴露路由流水接口，Dashboard 不再伪造实时记录。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </main>

        {/* Right: 审批队列 + 系统 */}
        <aside style={opsStyles.rightCol}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>审批队列</span>
              <span style={{ ...opsStyles.pill('var(--amber)'), marginLeft: 'auto' }}>{approvalQueue.length} 待处理</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {approvalQueue.map(ap => {
                const ai = ais.find(a => a.id === ap.ai);
                if (!ai) return null;
                const riskC = ap.risk === 'low'
                  ? 'var(--green)'
                  : ap.risk === 'medium'
                    ? 'var(--amber)'
                    : ap.risk === 'high'
                      ? 'var(--red)'
                      : 'var(--text-3)';
                const riskLabel = ap.risk === 'low'
                  ? '低风险'
                  : ap.risk === 'medium'
                    ? '中风险'
                    : ap.risk === 'high'
                      ? '高风险'
                      : '未分级';
                return (
                  <div key={ap.id} style={{
                    padding: 12, borderRadius: 10,
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid var(--border-soft)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <Avatar ai={ai} size={20}/>
                      <span style={{ fontSize: 12, color: 'var(--text-1)', fontWeight: 500 }}>{ai.name}{ai.alias ? ` · ${ai.alias}` : ''}</span>
                      <span style={{ ...opsStyles.pill(riskC), marginLeft: 'auto', fontSize: 9.5 }}>
                        {riskLabel}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-1)', lineHeight: 1.5 }}>{ap.intent}</div>
                    <div style={{
                      marginTop: 8, padding: '6px 8px', borderRadius: 6,
                      background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-subtle)',
                      fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-2)',
                      overflowX: 'auto', whiteSpace: 'nowrap',
                    }}>{ap.command}</div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                      <button className="hoverable" onClick={async () => {
                        const ok = await approveFromDashboard(ap.id);
                        if (!ok) {
                          console.warn(`[hub] 审批失败: ${ap.id}`);
                          return;
                        }
                        window.dispatchEvent(new CustomEvent('hub-approval-resolved', { detail: { id: ap.id } }));
                      }} style={{
                        flex: 1, padding: '6px 10px', borderRadius: 6,
                        background: 'linear-gradient(180deg, #7c7fff 0%, #4f52e8 100%)',
                        color: 'white', fontSize: 11, fontWeight: 600,
                      }}>批准</button>
                      <button className="hoverable" onClick={async () => {
                        const ok = await denyFromDashboard(ap.id);
                        if (!ok) {
                          console.warn(`[hub] 审批失败: ${ap.id}`);
                          return;
                        }
                        window.dispatchEvent(new CustomEvent('hub-approval-resolved', { detail: { id: ap.id } }));
                      }} style={{
                        flex: 1, padding: '6px 10px', borderRadius: 6,
                        background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)',
                        color: 'var(--text-1)', fontSize: 11, fontWeight: 500,
                      }}>拒绝</button>
                    </div>
                    <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-4)', fontFamily: 'var(--mono)' }}>
                      {ap.tool} · {ap.requestedAt}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
              系统资源
            </div>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: 'var(--text-3)' }}>内存</span>
                <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-1)' }}>
                  {system.memoryPct == null ? system.memory : `${system.memory} · ${system.memoryPct}%`}
                </span>
              </div>
              <div style={opsStyles.progBar}>
                <div style={opsStyles.progFill(system.memoryPct ?? 0, '#6366f1')}/>
              </div>
            </div>
            <div style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: 'var(--text-3)' }}>CPU</span>
                <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-1)' }}>
                  {system.cpuPct == null ? system.cpu : `${system.cpu} · ${system.cpuPct}%`}
                </span>
              </div>
              <div style={opsStyles.progBar}>
                <div style={opsStyles.progFill(system.cpuPct ?? 0, '#4ade80')}/>
              </div>
            </div>
            <div style={{ marginTop: 14 }}>
              <div style={opsStyles.kv}><span style={opsStyles.kvKey}>PID</span><span style={opsStyles.kvVal}>{system.pid ?? '—'}</span></div>
              <div style={opsStyles.kv}><span style={opsStyles.kvKey}>版本</span><span style={opsStyles.kvVal}>{system.version}</span></div>
              <div style={opsStyles.kv}><span style={opsStyles.kvKey}>节点</span><span style={opsStyles.kvVal}>{system.node}</span></div>
              <div style={opsStyles.kv}><span style={opsStyles.kvKey}>已运行</span><span style={opsStyles.kvVal}>{system.uptime}</span></div>
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}

export { OpsMode };
