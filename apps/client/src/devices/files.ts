import { Capacitor } from '@capacitor/core';

/**
 * Hands a binary file to the user: a normal download in browsers and Electron,
 * the iOS share sheet (Files, AirDrop, Strava app …) on the iPad.
 */
export async function exportFile(name: string, data: Uint8Array, mime = 'application/octet-stream'): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
    let binary = '';
    for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
    const written = await Filesystem.writeFile({ path: name, data: btoa(binary), directory: Directory.Cache });
    await Share.share({ title: name, files: [written.uri] });
    return;
  }
  const blob = new Blob([data.slice().buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Keeps the screen on during a ride (Wake Lock API, native plugin on iPad). */
export async function keepAwake(on: boolean): Promise<void> {
  try {
    if (Capacitor.isNativePlatform()) {
      const { KeepAwake } = await import('@capacitor-community/keep-awake');
      await (on ? KeepAwake.keepAwake() : KeepAwake.allowSleep());
      return;
    }
    if (on) {
      wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
    } else {
      await wakeLock?.release();
      wakeLock = null;
    }
  } catch {
    // not supported or denied — not critical
  }
}

let wakeLock: WakeLockSentinel | null = null;
