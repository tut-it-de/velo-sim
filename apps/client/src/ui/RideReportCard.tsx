import { useEffect, useRef, useState } from 'react';
import type { RideResult } from '../ride/rideSession';
import { settingsStore } from '../state/settings';
import { exportFile } from '../devices/files';
import { drawRideReport, reportPng, type ReportData, type ReportSeries } from './rideReport';

/** Assumed maximum heart rate while the rider has not set one. */
const DEFAULT_MAX_HR = 190;

export function reportData(result: RideResult, title: string, startTime: number): ReportData {
  const s = result.summary;
  const settings = settingsStore.get();
  const seenMax = s.maxHeartRate ?? 0;
  const maxHr = settings.maxHeartRate > 0 ? settings.maxHeartRate : Math.max(DEFAULT_MAX_HR, seenMax);
  const date = new Date(startTime).toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
  return {
    title: result.workout?.name ?? title,
    subtitle: result.workout ? `${result.routeName} · ${date}` : date,
    durationS: s.durationS,
    distanceM: s.distanceM,
    avgPower: s.avgPower,
    normalizedPower: s.normalizedPower,
    calories: s.calories,
    ascentM: s.ascentM,
    samples: result.samples,
    ftp: s.ftp || settings.ftp,
    maxHr,
    maxHrAssumed: settings.maxHeartRate <= 0,
  };
}

/** The ride report at the end of the ride: power, cadence and heart rate can be switched on and off. */
export function RideReportCard({ data, fileName }: { data: ReportData; fileName: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const hasHr = data.samples.some((x) => (x.heartRate ?? 0) > 0);
  const hasCadence = data.samples.some((x) => (x.cadence ?? 0) > 0);
  const [series, setSeries] = useState<ReportSeries>({ power: true, cadence: false, heartRate: hasHr });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const draw = () => live && canvas.current && drawRideReport(canvas.current, data, series, Math.min(2, window.devicePixelRatio || 1));
    draw();
    // drawn again once the condensed font is there
    void document.fonts.ready.then(draw);
    return () => {
      live = false;
    };
  }, [data, series]);

  const toggle = (k: keyof ReportSeries) => setSeries((s) => ({ ...s, [k]: !s[k] }));
  const share = async () => {
    setBusy(true);
    try {
      await exportFile(fileName, await reportPng(data, series), 'image/png');
    } catch (err) {
      // closing the share sheet without choosing anything is not an error
      if (!/cancel/i.test(String(err))) alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ride-report">
      <canvas ref={canvas} style={{ width: '100%', aspectRatio: '3 / 2', display: 'block', borderRadius: 10 }} />
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 8, flexWrap: 'wrap', gap: 8 }}>
        <div className="row" style={{ gap: 6 }}>
          <button className={series.power ? 'primary' : ''} onClick={() => toggle('power')}>
            Leistung
          </button>
          <button className={series.cadence ? 'primary' : ''} onClick={() => toggle('cadence')} disabled={!hasCadence}>
            Trittfrequenz
          </button>
          <button className={series.heartRate ? 'primary' : ''} onClick={() => toggle('heartRate')} disabled={!hasHr}>
            Herzfrequenz
          </button>
        </div>
        <button onClick={() => void share()} disabled={busy}>
          {busy ? 'Bild wird erstellt …' : 'Bild teilen'}
        </button>
      </div>
    </div>
  );
}
