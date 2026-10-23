import { useMemo } from 'react';
import { fitnessSeries, formState, rampRate, weeklyLoad, type FitnessDay, type FormState, type LoadRide } from '@velo/metrics';
import { activitiesStore, type StoredActivity } from '../state/activities';
import { useStore } from '../state/store';
import { fmt } from './components';

const DAY = 86_400_000;
const WINDOW_DAYS = 90;
const WEEKS = 12;

const FORM_TEXT: Record<FormState, string> = {
  erholt: 'Sehr ausgeruht – deine Fitness beginnt zu sinken. Zeit für ein paar härtere Einheiten.',
  frisch: 'Frisch und erholt – ein guter Tag für einen FTP-Test oder ein hartes Workout.',
  neutral: 'Ausgeglichen – Training und Erholung halten sich die Waage.',
  'im Training': 'Im Training – du baust Fitness auf. So soll es sein.',
  ermüdet: 'Ermüdet – gönn dir einen ruhigen Tag, bevor es weitergeht.',
};

/** Real rides only: simulator rides would distort the load. */
export const loadRides = (all: StoredActivity[]): LoadRide[] =>
  all.filter((a) => !a.simulated && a.summary.tss > 0).map((a) => ({ startTime: a.startTime, tss: a.summary.tss }));

/** Fitness and form before and after a ride, for the ride summary. */
export function fitnessChange(all: StoredActivity[], rideId: string): { ctl: number; dCtl: number; tsb: number } | undefined {
  const ride = all.find((a) => a.id === rideId);
  if (!ride || ride.simulated) return undefined;
  const now = Date.now();
  const withRide = fitnessSeries(loadRides(all), now).at(-1);
  const without = fitnessSeries(loadRides(all.filter((a) => a.id !== rideId)), now).at(-1);
  if (!withRide) return undefined;
  // form of tomorrow morning: today's fitness minus today's fatigue
  return { ctl: withRide.ctl, dCtl: withRide.ctl - (without?.ctl ?? 0), tsb: withRide.ctl - withRide.atl };
}

/** Activities page: fitness, fatigue and form over 90 days plus the weekly load. */
export function FitnessCard() {
  const activities = useStore(activitiesStore);
  const { series, weeks, today, ramp } = useMemo(() => {
    const rides = loadRides(activities);
    const now = Date.now();
    const series = fitnessSeries(rides, now, now - (WINDOW_DAYS - 1) * DAY);
    return { series, weeks: weeklyLoad(rides, WEEKS, now), today: series.at(-1), ramp: rampRate(fitnessSeries(rides, now)) };
  }, [activities]);

  if (!today) {
    return (
      <div className="card fitness-card">
        <h2>Fitness &amp; Form</h2>
        <p className="muted small">Nach deinen ersten Fahrten mit Leistung siehst du hier, wie deine Fitness wächst und wie erholt du bist.</p>
      </div>
    );
  }
  // form for the coming day: what is left after today's training
  const form = today.ctl - today.atl;
  const state = formState(form);
  return (
    <div className="card fitness-card">
      <h2>Fitness &amp; Form</h2>
      <div className="stat-row stat-row-3">
        <div className="stat">
          <span className="stat-label">Fitness</span>
          <span className="stat-value">{fmt(today.ctl)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Ermüdung</span>
          <span className="stat-value">{fmt(today.atl)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Form</span>
          <span className={`stat-value form-${state.replace(' ', '-')}`}>
            {form > 0 ? '+' : ''}
            {fmt(form)}
          </span>
        </div>
      </div>
      <p className="fitness-state">
        <strong>{state[0]!.toUpperCase() + state.slice(1)}.</strong> {FORM_TEXT[state]}
      </p>
      {ramp > 8 && (
        <div className="notice">
          Deine Fitness ist in der letzten Woche um {fmt(ramp)} gestiegen – mehr als 8 pro Woche ist ein sehr steiler Aufbau. Plane Erholung ein.
        </div>
      )}
      <FitnessChart series={series} />
      <div className="fitness-legend muted small">
        <span className="lg lg-ctl">Fitness (42 Tage)</span>
        <span className="lg lg-atl">Ermüdung (7 Tage)</span>
        <span className="lg lg-tsb">Form</span>
      </div>
      <h3 className="fitness-sub">Belastung pro Woche (TSS)</h3>
      <WeekBars weeks={weeks} />
    </div>
  );
}

function FitnessChart({ series }: { series: FitnessDay[] }) {
  const W = 360;
  const H = 120;
  const max = Math.max(10, ...series.map((d) => Math.max(d.ctl, d.atl)));
  const minTsb = Math.min(0, ...series.map((d) => d.tsb));
  const maxTsb = Math.max(0, ...series.map((d) => d.tsb));
  const x = (i: number) => (i / Math.max(1, series.length - 1)) * W;
  const y = (v: number) => H - 4 - (v / max) * (H - 8);
  // form bars around their own zero line in the lower part of the chart
  const band = 30;
  const scaleTsb = band / Math.max(1, maxTsb - minTsb);
  const zero = H - 4 - (0 - minTsb) * scaleTsb;
  const line = (k: 'ctl' | 'atl') => series.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[k]).toFixed(1)}`).join('');
  const bw = W / series.length;
  const first = new Date(series[0]!.day).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  return (
    <div className="ftp-chart-wrap">
      <div style={{ flex: 1, minWidth: 0 }}>
        <svg className="fitness-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Fitness, Ermüdung und Form der letzten 90 Tage">
          {series.map((d, i) => (
            <rect
              key={i}
              x={x(i) - bw / 2}
              width={Math.max(0.6, bw * 0.7)}
              y={Math.min(zero, zero - d.tsb * scaleTsb)}
              height={Math.max(0.3, Math.abs(d.tsb * scaleTsb))}
              fill={d.tsb >= 0 ? 'var(--ok)' : 'var(--warn)'}
              opacity={0.45}
            />
          ))}
          <path d={line('atl')} fill="none" stroke="var(--info)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" opacity={0.8} />
          <path d={line('ctl')} fill="none" stroke="var(--accent)" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="fitness-axis muted small">
          <span>{first}</span>
          <span>heute</span>
        </div>
      </div>
      <div className="ftp-chart-labels">
        <span>{Math.round(max)}</span>
        <span>0</span>
      </div>
    </div>
  );
}

function WeekBars({ weeks }: { weeks: Array<{ week: number; tss: number }> }) {
  const max = Math.max(1, ...weeks.map((w) => w.tss));
  return (
    <div className="week-bars">
      {weeks.map((w, i) => (
        <div key={w.week} className="week-bar" title={`Woche ab ${new Date(w.week).toLocaleDateString('de-DE')}: ${Math.round(w.tss)} TSS`}>
          <span className="week-bar-value">{w.tss > 0 ? Math.round(w.tss) : ''}</span>
          <span className={`week-bar-fill${i === weeks.length - 1 ? ' current' : ''}`} style={{ height: `${(w.tss / max) * 100}%` }} />
          <span className="week-bar-label">{new Date(w.week).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}</span>
        </div>
      ))}
    </div>
  );
}
