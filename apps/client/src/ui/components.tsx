import type { ReactNode } from 'react';
import type { ConnectionState } from '@velo/ble';

export function Tile({ label, value, unit, sub }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode }) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="value">
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

/** On/off switch with a label and an optional hint underneath. */
export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={`toggle ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden>
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-text">
        <span>{label}</span>
        {hint && <span className="toggle-hint">{hint}</span>}
      </span>
    </label>
  );
}

const STATE_LABEL: Record<ConnectionState, string> = {
  connecting: 'verbinde …',
  connected: 'verbunden',
  reconnecting: 'verbinde neu …',
  disconnected: 'getrennt',
};

export function StatusDot({ state, label }: { state: ConnectionState; label?: string }) {
  return (
    <span className={`status-pill ${state}`} title={STATE_LABEL[state]}>
      <span className={`dot ${state}`} />
      <span>{label ?? STATE_LABEL[state]}</span>
    </span>
  );
}

export function fmt(v: number | undefined, digits = 0): string {
  if (v === undefined || Number.isNaN(v)) return '–';
  return v.toFixed(digits);
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return h ? `${h}:${mm}:${String(sec).padStart(2, '0')}` : `${mm}:${String(sec).padStart(2, '0')}`;
}
