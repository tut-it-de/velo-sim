# Velo Sim

Indoor-Cycling-Simulator für Smart-Trainer (Referenz: Wahoo KICKR Core v1) – freie Fahrt, Workouts,
Ausrüstung mit CdA-Werten, Währung und später Multiplayer. Läuft auf **Windows, macOS und iPad**.

Den vollständigen Plan gibt es in [`docs/PLAN.md`](docs/PLAN.md).

## Schnellstart (Entwicklung)

Voraussetzung: Node.js 22+

```bash
npm install
npm run dev          # http://localhost:5173 in Chrome oder Edge öffnen
```

- **Mit KICKR:** Geräte → Smart-Trainer → *Verbinden*. Web Bluetooth funktioniert in Chrome/Edge unter Windows und macOS.
- **Ohne Hardware:** Geräte → *Simulator statt Bluetooth* aktivieren. Steuerung mit ↑/↓ (Watt), ←/→ (Kadenz), Leertaste (Pause).

## Desktop-App (Windows / macOS)

```bash
npm run desktop                          # Client bauen und in Electron starten
npm run dist:win -w @velo/desktop        # Installer bauen (auf Windows)
npm run dist:mac -w @velo/desktop        # DMG bauen (auf einem Mac)
```

Alternativ baut der GitHub-Workflow **Desktop-Installer** (Actions → Run workflow) beide Installer als Download.
Die Installer sind nicht signiert: Windows zeigt eine SmartScreen-Warnung („Weitere Informationen → Trotzdem ausführen“),
macOS beim ersten Start Rechtsklick → Öffnen.

## iPad-App

Benötigt einen Mac mit Xcode 16+ und eine (kostenlose) Apple-ID.

```bash
cd apps/client
npm run ios:sync     # Web-App bauen und ins Xcode-Projekt kopieren
npm run ios:open     # Xcode öffnen
```

In Xcode: Target *App* → *Signing & Capabilities* → Team auswählen → iPad anschließen → ▶︎.
Bluetooth-Berechtigung und Querformat sind in `ios/App/App/Info.plist` bereits eingetragen.

## Projektstruktur

```
apps/
  client/     React + Babylon.js – die eigentliche App (Browser, Electron, iPad)
  desktop/    Electron-Hülle für Windows/macOS inkl. Bluetooth-Geräteauswahl
packages/
  ble/        Bluetooth: FTMS, Wahoo-Protokoll, Cycling Power, Herzfrequenz, CSC, Simulator
```

## Tests

```bash
npm test             # alle Unit-Tests
npm run type-check   # TypeScript
```

## Phase 0 – Test am KICKR Core

Die Checkliste steht in der App unter *Geräte*. Wenn etwas nicht funktioniert: *GATT-Tabelle lesen* →
*Alles kopieren* und den Text als Issue anhängen.
