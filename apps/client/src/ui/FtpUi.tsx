import { useMemo, useState } from 'react';
import { CURVE_DURATIONS, ESTIMATE_WINDOW_DAYS, type FtpEstimate } from '@velo/metrics';
import { LEVELS, SOURCE_LABEL, type FtpAdvice, type WorkoutRating } from '../ftp/advisor';
import { addWorkoutFeedback, currentAdvice, currentEstimate, dismissAdvice, ftpStore, setFtp, skipLevelQuestion } from '../ftp/ftpStore';
import { activitiesStore } from '../state/activities';
import { pageStore } from '../state/ui';
import { settingsStore, updateSettings } from '../state/settings';
import { useStore } from '../state/store';
import type { WorkoutCategory } from '@velo/workouts';
import { fmt } from './components';

const dateDe = (t: number) => new Date(t).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const CONF_LABEL: Record<FtpEstimate['confidence'], string> = { niedrig: 'grobe Schätzung', mittel: 'Schätzung', hoch: 'zuverlässig' };

/** "How fit are you?" – the first FTP until rides or a test give a real one. */
export function FtpSetupDialog({ onDone, onClose, reason }: { onDone: () => void; onClose: () => void; reason?: string }) {
  const { weightKg } = useStore(settingsStore);
  const [weight, setWeight] = useState(String(weightKg));
  const [own, setOwn] = useState('');
  const ownW = Number(own);
  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal ftp-setup" role="dialog" aria-label="FTP festlegen">
        <h2>Wie fit bist du?</h2>
        <p className="muted small">
          {reason ?? 'Workouts richten sich nach deiner FTP – der Leistung, die du etwa eine Stunde halten kannst.'} Wähl eine grobe Stufe. Nach ein
          paar Fahrten schätzt Velo Sim deine FTP selbst und passt sie an.
        </p>
        <div className="row ftp-own">
          <label className="muted small">Dein Gewicht:</label>
          <input
            type="number"
            min={35}
            max={160}
            step={0.5}
            value={weight}
            onChange={(e) => {
              setWeight(e.target.value);
              const v = Number(e.target.value);
              if (v >= 35 && v <= 160) updateSettings({ weightKg: v });
            }}
            style={{ width: 90 }}
          />
          <span className="muted small">kg</span>
        </div>
        <div className="ftp-levels">
          {LEVELS.map((l) => (
            <button
              key={l.id}
              className="ftp-level"
              onClick={() => {
                setFtp(l.wkg * weightKg, 'provisional', `Selbsteinschätzung „${l.label}“ (${l.wkg.toFixed(1)} W/kg)`, l.wkg);
                onDone();
              }}
            >
              <strong>{l.label}</strong>
              <span className="muted small">{l.hint}</span>
              <span className="ftp-level-w">≈ {Math.round(l.wkg * weightKg)} W</span>
            </button>
          ))}
        </div>
        <div className="row ftp-own">
          <label className="muted small">Ich kenne meine FTP:</label>
          <input type="number" min={50} max={600} placeholder="z. B. 230" value={own} onChange={(e) => setOwn(e.target.value)} style={{ width: 110 }} />
          <span className="muted small">W</span>
          <button
            className="primary"
            disabled={!(ownW >= 50 && ownW <= 600)}
            onClick={() => {
              setFtp(ownW, 'manual');
              onDone();
            }}
          >
            Übernehmen
          </button>
        </div>
        <div className="row start-devices-actions">
          <button
            onClick={() => {
              skipLevelQuestion();
              onClose();
            }}
          >
            Weiß ich nicht – erst mal frei fahren
          </button>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          Genauer geht’s mit dem Rampentest unter „Workouts“ (der mit festen Watt braucht keine FTP).
        </p>
      </div>
    </div>
  );
}

/** Text and buttons for one piece of FTP advice (after a ride and on the settings page). */
export function FtpAdviceCard({ advice, onDone }: { advice: FtpAdvice; onDone?: () => void }) {
  const settings = useStore(settingsStore);
  const [state, setState] = useState<'open' | 'applied' | 'dismissed'>('open');
  const old = settings.ftp;
  const diff = 'ftp' in advice ? advice.ftp - old : 0;
  const delta = old > 0 && diff ? ` (${diff > 0 ? '+' : ''}${diff} W)` : '';

  if (state === 'dismissed') return null;
  const apply = (ftp: number, note: string, source: 'estimate' | 'manual' = 'estimate') => {
    setFtp(ftp, source, note);
    setState('applied');
    onDone?.();
  };
  const dismiss = () => {
    dismissAdvice(advice);
    setState('dismissed');
    onDone?.();
  };

  let title: string;
  let text: string;
  let action: { label: string; run: () => void } | undefined;
  switch (advice.kind) {
    case 'auto':
      title = `Deine FTP: ${advice.ftp} W`;
      text = `Aus ${advice.estimate.rides} Fahrt${advice.estimate.rides === 1 ? '' : 'en'} geschätzt – ${advice.estimate.basis}. Workouts richten sich ab jetzt danach. Fahr mal 20 Minuten richtig hart, dann wird sie genauer.`;
      break;
    case 'increase':
      title = `🎉 Neue FTP erkannt: ${advice.ftp} W${delta}`;
      text = `${advice.estimate.basis}, gefahren am ${dateDe(advice.estimate.at)}.`;
      action = { label: `FTP ${advice.ftp} W übernehmen`, run: () => apply(advice.ftp, advice.estimate.basis) };
      break;
    case 'decrease':
      title = `Deine FTP ist vielleicht zu hoch`;
      text = `Seit über 6 Wochen kein Wert mehr in der Nähe von ${old} W – aus ${advice.estimate.rides} Fahrten geschätzt: ${advice.ftp} W (${advice.estimate.basis}). Passe sie an oder fahr einen Rampentest.`;
      action = { label: `Auf ${advice.ftp} W senken`, run: () => apply(advice.ftp, advice.estimate.basis) };
      break;
    case 'feedback-up':
      title = `Die letzten harten Workouts waren leicht`;
      text = `Zweimal hintereinander „leicht“ – deine FTP ist wahrscheinlich höher. Vorschlag: ${advice.ftp} W${delta}.`;
      action = { label: `FTP ${advice.ftp} W übernehmen`, run: () => apply(advice.ftp, 'Workouts waren zu leicht (+3 %)', 'manual') };
      break;
    case 'feedback-down':
      title = `Die letzten harten Workouts waren zu hart`;
      text = `Zweimal hintereinander zu hart oder abgebrochen – deine FTP ist wahrscheinlich zu hoch. Vorschlag: ${advice.ftp} W${delta}, oder fahr einen Rampentest.`;
      action = { label: `Auf ${advice.ftp} W senken`, run: () => apply(advice.ftp, 'Workouts waren zu hart (−3 %)', 'manual') };
      break;
    case 'reminder':
      title = `Zeit, deine FTP zu prüfen`;
      text = `Deine FTP (${old} W) ist über 6 Wochen alt.${advice.estimate ? ` Aus deinen Fahrten geschätzt: ${advice.estimate.ftp} W (${CONF_LABEL[advice.estimate.confidence]}).` : ''} Ein Rampentest dauert etwa 20 Minuten.`;
      action = { label: 'Zum Rampentest', run: () => (dismiss(), pageStore.set('workouts')) };
      break;
  }

  return (
    <div className="ftp-advice">
      <strong>{state === 'applied' ? `✓ FTP auf ${'ftp' in advice ? advice.ftp : old} W gesetzt` : title}</strong>
      {state === 'open' && <span className="muted small">{text}</span>}
      {state === 'open' && advice.kind !== 'auto' && (
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button onClick={dismiss}>{advice.kind === 'reminder' ? 'Später' : 'Nein, danke'}</button>
          {action && (
            <button className="primary" onClick={action.run}>
              {action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const HARD: WorkoutCategory[] = ['sweetspot', 'threshold', 'vo2max'];
const RATINGS: WorkoutRating[] = ['leicht', 'passend', 'hart', 'zu hart'];

/** "How was it?" after a workout; two easy (or too hard) hard workouts in a row lead to an FTP suggestion. */
export function WorkoutFeedbackCard({ workout, at }: { workout: { id: string; name: string; category?: WorkoutCategory; completed: boolean }; at: number }) {
  const [rating, setRating] = useState<WorkoutRating | null>(null);
  const [advice, setAdvice] = useState<FtpAdvice | undefined>();
  return (
    <div className="ftp-advice">
      <strong>Wie war „{workout.name}“?</strong>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {RATINGS.map((r) => (
          <button
            key={r}
            className={rating === r ? 'primary' : ''}
            disabled={rating !== null}
            onClick={() => {
              setRating(r);
              addWorkoutFeedback({ at, workoutId: workout.id, name: workout.name, hard: HARD.includes(workout.category ?? 'custom'), completed: workout.completed, rating: r });
              const a = currentAdvice();
              if (a?.kind === 'feedback-up' || a?.kind === 'feedback-down') setAdvice(a);
            }}
          >
            {r}
          </button>
        ))}
      </div>
      {advice && <FtpAdviceCard advice={advice} />}
    </div>
  );
}

/** Banner for the workout list while no FTP is set. */
export function FtpMissingNotice({ onSetup }: { onSetup: () => void }) {
  const settings = useStore(settingsStore);
  if (settings.ftp > 0) return null;
  return (
    <div className="notice row" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
      <span>
        <strong>FTP noch nicht bestimmt.</strong> Fahr den Rampentest (feste Watt) oder einfach ein paar Fahrten – Velo Sim schätzt sie dann selbst.
      </span>
      <button className="primary" onClick={onSetup}>
        Grob einschätzen
      </button>
    </div>
  );
}

/** Small line chart (SVG) – FTP history or the power curve. */
function LineChart({ points, logX, height = 90, unit }: { points: Array<[number, number]>; logX?: boolean; height?: number; unit: string }) {
  if (points.length < 2) return <div className="muted small">Noch zu wenig Daten.</div>;
  const W = 320;
  const H = height;
  const xs = points.map(([x]) => (logX ? Math.log(x) : x));
  const ys = points.map(([, y]) => y);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys) * 0.95, Math.max(...ys) * 1.03];
  const px = (x: number) => 4 + ((x - x0) / (x1 - x0 || 1)) * (W - 8);
  const py = (y: number) => H - 4 - ((y - y0) / (y1 - y0 || 1)) * (H - 8);
  const d = xs.map((x, i) => `${i ? 'L' : 'M'}${px(x).toFixed(1)},${py(ys[i]!).toFixed(1)}`).join('');
  // The SVG stretches to the card width, so labels are HTML (no distorted text or dots).
  return (
    <div className="ftp-chart-wrap">
      <svg className="ftp-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Verlauf in ${unit}`}>
        <path d={d} fill="none" stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="ftp-chart-labels">
        <span>
          {Math.round(Math.max(...ys))} {unit}
        </span>
        <span>
          {Math.round(Math.min(...ys))} {unit}
        </span>
      </div>
    </div>
  );
}

const durLabel = (s: number) => (s < 60 ? `${s} s` : `${s / 60} min`);

/** Settings: current FTP, where it comes from, the estimate, history and power curve. */
export function FtpCard() {
  const settings = useStore(settingsStore);
  const state = useStore(ftpStore);
  const activities = useStore(activitiesStore);
  const [setup, setSetup] = useState(false);
  const [manual, setManual] = useState('');
  const estimate = useMemo(() => currentEstimate(), [activities]);
  const advice = useMemo(() => currentAdvice(), [activities, state, settings.ftp]);
  const ftp = settings.ftp;
  const curve = estimate ? CURVE_DURATIONS.map((d, i) => [d, estimate.curve[i]!] as [number, number]).filter(([, p]) => p > 0) : [];
  const manualW = Number(manual);

  return (
    <div className="card ftp-card">
      <h2>FTP</h2>
      <div className="ftp-now">
        <div>
          <span className="big">{ftp > 0 ? ftp : '–'}</span> W{ftp > 0 && <span className="muted"> · {fmt(ftp / settings.weightKg, 2)} W/kg</span>}
        </div>
        <span className={`badge ${state.source === 'test' || state.source === 'estimate' ? 'ok' : ''}`}>{SOURCE_LABEL[state.source]}</span>
      </div>
      <div className="muted small">
        {ftp > 0 && state.since ? `seit ${dateDe(state.since)}${state.note ? ` · ${state.note}` : ''}` : 'Grundlage für alle Workouts. Wird nach ein paar Fahrten automatisch geschätzt.'}
        {state.source === 'provisional' && ' · passt sich deinem Gewicht an'}
      </div>

      {advice && advice.kind !== 'auto' && <FtpAdviceCard advice={advice} />}

      <div className="ftp-estimate">
        <div className="muted small">Schätzung aus den letzten {ESTIMATE_WINDOW_DAYS} Tagen</div>
        {estimate ? (
          <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <span>
              <strong>{estimate.ftp} W</strong> <span className="muted small">· {CONF_LABEL[estimate.confidence]} · {estimate.basis} · {estimate.rides} Fahrten</span>
            </span>
            {estimate.ftp !== ftp && (
              <button onClick={() => setFtp(estimate.ftp, 'estimate', estimate.basis)}>Übernehmen</button>
            )}
          </div>
        ) : (
          <span className="muted small">Noch keine Fahrt mit mindestens 5 Minuten Leistung.</span>
        )}
      </div>

      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input type="number" min={50} max={600} placeholder="FTP in W" value={manual} onChange={(e) => setManual(e.target.value)} style={{ width: 110 }} />
        <button
          disabled={!(manualW >= 50 && manualW <= 600)}
          onClick={() => {
            setFtp(manualW, 'manual');
            setManual('');
          }}
        >
          Eintragen
        </button>
        <button onClick={() => setSetup(true)}>Grob einschätzen</button>
        <button className="primary" onClick={() => pageStore.set('workouts')}>
          Rampentest fahren
        </button>
      </div>

      <div className="grid cols-2 ftp-charts">
        <div>
          <div className="muted small">FTP-Verlauf</div>
          <LineChart points={state.history.filter((h) => h.ftp > 0).map((h) => [h.at, h.ftp] as [number, number])} unit="W" />
        </div>
        <div>
          <div className="muted small">
            Leistungskurve ({durLabel(curve[0]?.[0] ?? 5)} – {durLabel(curve.at(-1)?.[0] ?? 3600)})
          </div>
          <LineChart points={curve} logX unit="W" />
        </div>
      </div>
      {setup && <FtpSetupDialog onDone={() => setSetup(false)} onClose={() => setSetup(false)} />}
    </div>
  );
}
