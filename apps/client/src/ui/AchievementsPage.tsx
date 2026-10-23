import { useEffect, useMemo } from 'react';
import { TIER_NAMES, type Badge, type Challenge } from '@velo/metrics';
import { formatCoins } from '@velo/equipment';
import { achievementClaims, achievementsOf } from '../net/achievements';
import { syncActivitiesQuietly } from '../net/activitySync';
import { accountStore } from '../net/api';
import { activitiesStore } from '../state/activities';
import { useStore } from '../state/store';

const MONTH = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric', timeZone: 'Europe/Berlin' });
const DATE = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

const num = (v: number, unit: string) => (unit === 'h' ? v.toFixed(1).replace('.', ',') : Math.floor(v).toLocaleString('de-DE'));

/** Monthly challenges, badges and the routes ridden – from the rides of the account. */
export function AchievementsPage() {
  const activities = useStore(activitiesStore);
  const user = useStore(accountStore).user?.id;
  const claimed = new Set(useStore(achievementClaims)[user ?? ''] ?? []);
  const a = useMemo(() => achievementsOf(activities), [activities]);
  // fetch rides of other devices and book what is still open
  useEffect(() => syncActivitiesQuietly(), []);

  const badges = a.badges.filter((b) => !b.key.startsWith('route:'));
  const routes = a.badges.filter((b) => b.key.startsWith('route:'));
  const earnedCount = badges.filter((b) => b.earnedAt !== undefined).length;
  const daysLeft = daysLeftInMonth();

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h1>Erfolge</h1>
            <p className="muted">Monatsziele und Abzeichen bringen Watt-Taler. Fahrten mit dem Simulator zählen nicht.</p>
          </div>
        </div>

        <div className="card">
          <div className="ach-head">
            <h2>Monatsziele {MONTH.format(Date.now())}</h2>
            <span className="muted small">noch {daysLeft} {daysLeft === 1 ? 'Tag' : 'Tage'}</span>
          </div>
          <div className="challenges">
            {a.challenges.map((c) => (
              <ChallengeRow key={c.metric} c={c} claimed={claimed} />
            ))}
          </div>
        </div>

        <div className="card">
          <div className="ach-head">
            <h2>Abzeichen</h2>
            <span className="muted small">
              {earnedCount} von {badges.length}
            </span>
          </div>
          <div className="badge-grid">
            {badges.map((b) => (
              <BadgeTile key={b.key} b={b} claimed={claimed.has(`badge:${b.key}`)} />
            ))}
          </div>
        </div>

        <div className="card">
          <div className="ach-head">
            <h2>Strecken komplett gefahren</h2>
            <span className="muted small">
              {routes.filter((r) => r.earnedAt !== undefined).length} von {routes.length}
            </span>
          </div>
          <div className="route-badges">
            {routes.map((r) => (
              <span key={r.key} className={`route-badge${r.earnedAt !== undefined ? ' done' : ''}`} title={r.earnedAt !== undefined ? `Erste Runde am ${DATE.format(r.earnedAt)}` : 'Noch keine ganze Runde'}>
                {r.earnedAt !== undefined ? '🏁' : '○'} {r.title}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ChallengeRow({ c, claimed }: { c: Challenge; claimed: Set<string> }) {
  const top = c.tiers[c.tiers.length - 1]!.target;
  const next = c.tiers.find((t) => !t.done);
  return (
    <div className="challenge">
      <div className="challenge-top">
        <strong>{c.label}</strong>
        <span className="muted small">
          {num(c.value, c.unit)}
          {c.unit && ` ${c.unit}`}
          {next ? ` · noch ${num(Math.max(0, next.target - c.value), c.unit)}${c.unit ? ` ${c.unit}` : ''} bis ${TIER_NAMES[c.tiers.indexOf(next)]}` : ' · alle Stufen geschafft'}
        </span>
      </div>
      <div className="challenge-bar">
        <span className="challenge-fill" style={{ width: `${Math.min(100, (c.value / top) * 100)}%` }} />
        {c.tiers.map((t, i) => (
          <span key={t.key} className={`challenge-mark tier-${i + 1}${t.done ? ' done' : ''}`} style={{ left: `${(t.target / top) * 100}%` }} />
        ))}
      </div>
      <div className="challenge-tiers">
        {c.tiers.map((t, i) => (
          <span key={t.key} className={`tier-chip tier-${i + 1}${t.done ? ' done' : ''}`} title={t.done && !claimed.has(t.key) ? 'Wird beim nächsten Abgleich gebucht' : undefined}>
            {TIER_NAMES[i]} {t.target.toLocaleString('de-DE')}
            {c.unit && ` ${c.unit}`} · {t.done && claimed.has(t.key) ? '✓' : '+'}
            {formatCoins(t.reward)}
          </span>
        ))}
      </div>
    </div>
  );
}

function BadgeTile({ b, claimed }: { b: Badge; claimed: boolean }) {
  const done = b.earnedAt !== undefined;
  return (
    <div className={`badge-tile${done ? ' done' : ''}`}>
      <span className="badge-icon" aria-hidden>
        {b.icon}
      </span>
      <strong>{b.title}</strong>
      <span className="muted small">{b.description}</span>
      {done ? (
        <span className="badge-foot small">
          {DATE.format(b.earnedAt!)} · {claimed ? `✓ ${formatCoins(b.reward)} Taler` : `+${formatCoins(b.reward)} Taler`}
        </span>
      ) : (
        <>
          {b.progress && b.progress.target > 1 && (
            <span className="badge-progress">
              <span style={{ width: `${Math.min(100, (b.progress.value / b.progress.target) * 100)}%` }} />
            </span>
          )}
          <span className="badge-foot small muted">
            {b.progress && b.progress.target > 1 ? `${Math.floor(b.progress.value).toLocaleString('de-DE')} / ${b.progress.target.toLocaleString('de-DE')} · ` : ''}+{formatCoins(b.reward)} Taler
          </span>
        </>
      )}
    </div>
  );
}

function daysLeftInMonth(): number {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 86_400_000));
}
