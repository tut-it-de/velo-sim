import { useRef, useState } from 'react';
import { CATEGORY_LABEL, parseZwo, serializeZwo, workoutStats, type Workout, type WorkoutCategory } from '@velo/workouts';
import { exportFile } from '../devices/files';
import { settingsStore } from '../state/settings';
import { useStore } from '../state/store';
import { allWorkouts, customWorkoutsStore, deleteCustomWorkout, isCustom, newWorkoutId, saveCustomWorkout } from '../state/workouts';
import { formatDuration } from './components';
import { WorkoutChart } from './WorkoutChart';
import { WorkoutEditor } from './WorkoutEditor';

export function WorkoutSelect({ selectedId, onSelect }: { selectedId?: string; onSelect: (w: Workout) => void }) {
  useStore(customWorkoutsStore);
  const settings = useStore(settingsStore);
  const [filter, setFilter] = useState<WorkoutCategory | 'all'>('all');
  const [editing, setEditing] = useState<Workout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const workouts = allWorkouts();
  const categories = [...new Set(workouts.map((w) => w.category ?? 'custom'))];
  const shown = workouts.filter((w) => filter === 'all' || (w.category ?? 'custom') === filter);

  const importFiles = async (files: FileList | null) => {
    setError(null);
    for (const file of Array.from(files ?? [])) {
      try {
        const w = parseZwo(await file.text(), newWorkoutId());
        saveCustomWorkout(w);
        onSelect(w);
      } catch (err) {
        setError(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <div className="row chips">
          <button className={filter === 'all' ? 'chip active' : 'chip'} onClick={() => setFilter('all')}>
            Alle
          </button>
          {categories.map((c) => (
            <button key={c} className={filter === c ? 'chip active' : 'chip'} onClick={() => setFilter(c)}>
              {CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>
        <div className="row">
          <input ref={fileRef} type="file" accept=".zwo,.xml" multiple hidden onChange={(e) => importFiles(e.target.files)} />
          <button onClick={() => fileRef.current?.click()}>.zwo importieren</button>
          <button
            onClick={() =>
              setEditing({
                id: newWorkoutId(),
                name: 'Mein Workout',
                description: '',
                category: 'custom',
                steps: [
                  { type: 'warmup', durationS: 600, powerStart: 0.5, powerEnd: 0.75 },
                  { type: 'intervals', repeat: 4, on: { durationS: 300, power: 1.0 }, off: { durationS: 180, power: 0.55 } },
                  { type: 'cooldown', durationS: 300, powerStart: 0.6, powerEnd: 0.4 },
                ],
              })
            }
          >
            + Neues Workout
          </button>
        </div>
      </div>
      {error && <div className="error-text" style={{ marginBottom: 8 }}>{error}</div>}
      <div className="workout-list">
        {shown.map((w) => {
          const st = workoutStats(w);
          const custom = isCustom(w.id);
          return (
            <div key={w.id} className={`workout-card ${selectedId === w.id ? 'selected' : ''}`} onClick={() => onSelect(w)} role="button" aria-pressed={selectedId === w.id}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>{w.name}</strong>
                <span className="badge">{CATEGORY_LABEL[w.category ?? 'custom']}</span>
              </div>
              <WorkoutChart workout={w} height={46} ftp={settings.ftp} />
              <div className="muted small">
                {formatDuration(st.durationS)} · TSS {Math.round(st.tss)} · IF {st.intensityFactor.toFixed(2)}
              </div>
              <div className="muted small workout-desc">{w.description}</div>
              <div className="row workout-actions" onClick={(e) => e.stopPropagation()}>
                <button className="link" onClick={() => setEditing(custom ? w : { ...w, id: newWorkoutId(), name: `${w.name} (Kopie)`, category: 'custom' })}>
                  {custom ? 'Bearbeiten' : 'Kopie bearbeiten'}
                </button>
                <button className="link" onClick={() => exportFile(`${w.name.replace(/[^\w\- äöüÄÖÜß]/g, '_')}.zwo`, new TextEncoder().encode(serializeZwo(w)), 'application/xml')}>
                  Export .zwo
                </button>
                {custom && (
                  <button
                    className="link danger"
                    onClick={() => {
                      if (confirm(`„${w.name}“ löschen?`)) deleteCustomWorkout(w.id);
                    }}
                  >
                    Löschen
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {editing && (
        <WorkoutEditor
          initial={editing}
          onCancel={() => setEditing(null)}
          onSave={(w) => {
            saveCustomWorkout(w);
            setEditing(null);
            onSelect(w);
          }}
        />
      )}
    </div>
  );
}
