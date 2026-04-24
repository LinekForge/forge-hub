// Icons + Avatar — from Claude Design handoff, adapted to TSX

const Icon = ({ size = 16, stroke = 1.5, fill, children, ...rest }: { size?: number; stroke?: number; fill?: string; children: React.ReactNode; [k: string]: unknown }) => (
  <svg width={size} height={size} viewBox="0 0 24 24"
    fill={fill || "none"} stroke="currentColor" strokeWidth={stroke}
    strokeLinecap="round" strokeLinejoin="round" {...rest}>
    {children}
  </svg>
);
export const IconSend = (p: Record<string, unknown>) => <Icon {...p}><path d="M3.4 20.4 21 12 3.4 3.6l.1 6.9L15 12 3.5 13.5z" fill="currentColor" stroke="none"/></Icon>;
export const IconSettings = (p: Record<string, unknown>) => <Icon {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></Icon>;
export const IconSearch = (p: Record<string, unknown>) => <Icon {...p}><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></Icon>;
export const IconMore = (p: Record<string, unknown>) => <Icon {...p}><circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/></Icon>;
export const IconCheck = (p: Record<string, unknown>) => <Icon {...p}><path d="M20 6 9 17l-5-5"/></Icon>;
export const IconPaperclip = (p: Record<string, unknown>) => <Icon {...p}><path d="m21 12-9.5 9.5a5 5 0 0 1-7-7L14 5a3.5 3.5 0 0 1 5 5L9.5 19.5a2 2 0 0 1-2.8-2.8L15 8.5"/></Icon>;
export const IconSparkle = (p: Record<string, unknown>) => <Icon {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/></Icon>;
export const IconHome = (p: Record<string, unknown>) => <Icon {...p}><path d="m3 10 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></Icon>;
export const IconGauge = (p: Record<string, unknown>) => <Icon {...p}><path d="M12 14 19 5"/><circle cx="12" cy="14" r="8"/><path d="M4 14h2M18 14h2M12 4v2"/></Icon>;
export const IconActivity = (p: Record<string, unknown>) => <Icon {...p}><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></Icon>;
export const IconTerminal = (p: Record<string, unknown>) => <Icon {...p}><path d="m5 8 4 4-4 4M12 16h7"/><rect x="2" y="3" width="20" height="18" rx="2"/></Icon>;
export const IconRoute = (p: Record<string, unknown>) => <Icon {...p}><circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M6 16V8a5 5 0 0 1 5-5h4M18 8v4a5 5 0 0 1-5 5H9"/></Icon>;

export const IconWechat = ({ size = 16, ...p }: { size?: number; [k: string]: unknown }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...p}>
    <path d="M8.5 4C4.9 4 2 6.5 2 9.6c0 1.7.9 3.2 2.4 4.2l-.6 2 2.3-1.2c.8.2 1.6.3 2.4.3h.5a5.2 5.2 0 0 1-.2-1.3c0-3.1 2.9-5.6 6.5-5.6h.7C15.5 5.5 12.3 4 8.5 4zM6.5 8.5a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8zm4 0a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8z" fill="currentColor"/>
    <path d="M22 13.8c0-2.7-2.6-4.9-5.9-4.9-3.4 0-6 2.2-6 4.9s2.6 4.9 6 4.9c.7 0 1.4-.1 2-.3l1.9 1-.5-1.7c1.5-.9 2.5-2.3 2.5-3.9zm-8 .8a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6zm4 0a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6z" fill="currentColor"/>
  </svg>
);
export const IconTelegram = ({ size = 16, ...p }: { size?: number; [k: string]: unknown }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...p}>
    <path d="M21.5 3.5 2.8 10.8c-1 .4-1 1 0 1.3l4.5 1.4 1.7 5.5c.2.6.4.8.9.8s.7-.2 1-.4l2.5-2.4 4.7 3.4c.9.5 1.5.2 1.7-.8l3-14.3c.3-1.3-.4-1.9-1.3-1.5zM8.7 13.9l10-6.3-8.3 7.7-.3 3.3-1.4-4.7z" fill="currentColor"/>
  </svg>
);
export const IconFeishu = ({ size = 16, ...p }: { size?: number; [k: string]: unknown }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...p}>
    <path d="M3 6.5C3 5.1 4.1 4 5.5 4h7c1.4 0 2.5 1.1 2.5 2.5V10H3V6.5z" fill="currentColor" opacity=".5"/>
    <path d="M3 11h14.5c1.9 0 3.5 1.6 3.5 3.5 0 2.5-2 4.5-4.5 4.5H8c-2.8 0-5-2.2-5-5V11z" fill="currentColor"/>
  </svg>
);
export const IconIMessage = ({ size = 16, ...p }: { size?: number; [k: string]: unknown }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...p}>
    <path d="M12 3C6.5 3 2 6.9 2 11.8c0 2.4 1.2 4.7 3.1 6.3-.2 1.2-.8 2.4-1.6 3.4-.3.4 0 .9.5.8 2-.2 3.7-.9 5.1-1.9.9.2 1.9.4 2.9.4 5.5 0 10-3.9 10-8.9S17.5 3 12 3z" fill="currentColor"/>
  </svg>
);
export const IconHomeland = ({ size = 16, ...p }: { size?: number; [k: string]: unknown }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...p}>
    <path d="M4 2 L16 2 L10 10 L16 10 L6 18 L10 10 L4 10 Z" fill="currentColor"/>
  </svg>
);

// Avatar with unique per-agent shapes
interface AvatarAI {
  seed: number;
  shape: string;
  name?: string;
}
export function Avatar({ ai, size = 40, ring = false, pulse = false }: { ai: AvatarAI; size?: number; ring?: boolean; pulse?: boolean }) {
  const h = ai.seed;
  const h2 = (h + 40) % 360;
  const bg = `linear-gradient(135deg, hsl(${h} 70% 58%) 0%, hsl(${h2} 65% 42%) 100%)`;

  const shapes: Record<string, React.ReactNode> = {
    bloom: (
      <g>
        {[0, 60, 120, 180, 240, 300].map(a => (
          <ellipse key={a} cx="20" cy="11" rx="4" ry="6" fill="white" fillOpacity="0.75" transform={`rotate(${a} 20 20)`}/>
        ))}
        <circle cx="20" cy="20" r="3.5" fill="white" fillOpacity="0.95"/>
      </g>
    ),
    ripple: (
      <g stroke="white" fill="none" strokeLinecap="round">
        <circle cx="20" cy="20" r="3" strokeOpacity="0.95" strokeWidth="2"/>
        <circle cx="20" cy="20" r="7" strokeOpacity="0.55" strokeWidth="1.5"/>
        <circle cx="20" cy="20" r="11" strokeOpacity="0.3" strokeWidth="1"/>
      </g>
    ),
    prism: (
      <g>
        <path d="M20 8 L30 20 L20 32 L10 20 Z" fill="white" fillOpacity="0.2" stroke="white" strokeOpacity="0.9" strokeWidth="1.5" strokeLinejoin="round"/>
        <path d="M20 8 L20 32 M10 20 L30 20" stroke="white" strokeOpacity="0.5" strokeWidth="1"/>
        <circle cx="20" cy="20" r="2.5" fill="white" fillOpacity="0.95"/>
      </g>
    ),
    moss: (
      <g>
        <circle cx="14" cy="22" r="5" fill="white" fillOpacity="0.55"/>
        <circle cx="24" cy="18" r="6" fill="white" fillOpacity="0.7"/>
        <circle cx="18" cy="14" r="3" fill="white" fillOpacity="0.85"/>
        <circle cx="27" cy="26" r="2.5" fill="white" fillOpacity="0.6"/>
        <circle cx="12" cy="15" r="1.5" fill="white" fillOpacity="0.9"/>
      </g>
    ),
    default: (
      <g>
        <circle cx="20" cy="20" r="8" fill="white" fillOpacity="0.3"/>
        <circle cx="20" cy="20" r="4" fill="white" fillOpacity="0.8"/>
      </g>
    ),
  };

  return (
    <div style={{
      width: size, height: size, borderRadius: Math.round(size * 0.3),
      background: bg,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      position: 'relative', flexShrink: 0,
      boxShadow: ring
        ? `0 0 0 2px var(--bg-0), 0 0 0 3.5px hsl(${h} 70% 60%), 0 6px 20px -4px hsla(${h},70%,50%,0.5)`
        : `0 0 0 1px rgba(255,255,255,0.08) inset, 0 3px 10px -2px hsla(${h},70%,40%,0.35)`,
      overflow: 'hidden',
    }}>
      <svg width={size * 0.95} height={size * 0.95} viewBox="0 0 40 40">
        {shapes[ai.shape] || shapes.default}
      </svg>
      {pulse && (
        <span style={{
          position: 'absolute', inset: -2, borderRadius: Math.round(size * 0.3) + 2,
          boxShadow: `0 0 0 2px hsla(${h},70%,60%,0.5)`,
          animation: 'avatarPulse 2.4s ease-in-out infinite',
          pointerEvents: 'none',
        }}/>
      )}
    </div>
  );
}
