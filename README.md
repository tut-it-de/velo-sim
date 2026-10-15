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

## Spielserver (Multiplayer, Konten, Watt-Taler)

```bash
npm run server       # Entwicklung: http://localhost:8080, Daten nur im Speicher
```

In der App unter **Profil → Online & Konto** die Server-Adresse eintragen (z. B. `http://localhost:8080`), Konto anlegen – fertig.
Ohne Server läuft alles offline (Garage und Taler dann nur lokal).

**Produktion** (z. B. auf deinem VPS, neben Caddy):

```bash
echo "JWT_SECRET=$(openssl rand -hex 32)" >  .env
echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)" >> .env
docker compose -f docker-compose.server.yml up -d --build
```

Caddy als HTTPS-Proxy (WebSockets gehen automatisch durch):

```
velo.deine-domain.de {
  reverse_proxy localhost:8080
}
```

Die iPad-App braucht HTTPS (App Transport Security); im lokalen Netz ist `http://` erlaubt.

### Automatischer Strava-Upload

Der Upload läuft über den Server, damit das Strava-Geheimnis nicht in der App steckt.

1. Auf https://www.strava.com/settings/api eine API-App anlegen.
   *Authorization Callback Domain* = Domain deines Servers (z. B. `velo.deine-domain.de`, lokal `localhost`).
2. In die `.env` neben `docker-compose.server.yml` eintragen und Server neu starten:
   ```
   STRAVA_CLIENT_ID=12345
   STRAVA_CLIENT_SECRET=…
   PUBLIC_URL=https://velo.deine-domain.de
   ```
3. In der App: **Profil → Strava → Mit Strava verbinden**, im Browser „Autorisieren“.
   Danach wird jede echte Fahrt ab 1 Minute nach dem Beenden als *Virtual Ride* hochgeladen
   (abschaltbar; ältere Fahrten unter *Aktivitäten → Zu Strava*). Simulator-Fahrten werden nie hochgeladen.

Neue Strava-API-Apps erlauben zunächst nur **einen** verbundenen Athleten (im API-Dashboard selbst auf 10 erhöhbar,
darüber prüft Strava die App). Für dich allein reicht das.
Last-Test: `npm run bots -w @velo/server -- --count 100 --route bergrunde --url http://localhost:8080`

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
  server/     Spielserver: Konten, Garage/Ledger (PostgreSQL), Räume pro Strecke, Chat, Kudos
packages/
  ble/        Bluetooth: FTMS, Wahoo-Protokoll, Cycling Power, Herzfrequenz, CSC, Simulator
  physics/    Fahrphysik (Leistung → Geschwindigkeit), Windschatten, CdA
  routes/     Die drei Rundkurse (Spline + Höhenprofil + Segmente)
  metrics/    NP, IF, TSS, Zonen, Aufzeichnung, FIT-Export
  workouts/   Workout-Modell, .zwo Import/Export, ERG-Player, Bibliothek
  equipment/  Ausrüstungskatalog, Wertungen, Zeitvergleich, Watt-Taler-Regeln
  protocol/   Nachrichten zwischen App und Spielserver
```

## Bedienung

- **Fahren → Freie Fahrt:** Strecke wählen, optional Pacer-Bots, los. Die Steigung geht (gedämpft durch die Trainer-Schwierigkeit) an den KICKR.
- **Fahren → Workout:** Workout aus der Bibliothek wählen, `.zwo` importieren oder im Editor bauen, dann eine Strecke wählen.
  Im Workout hält der Trainer die Watt (ERG), freie Abschnitte laufen im SIM-Modus.
- Tasten während der Fahrt: **C** Kamera wechseln, **P** Pause; im Simulator ↑/↓ Watt, ←/→ Kadenz.
- **Aktivitäten:** gespeicherte Fahrten, FIT-Export für Strava, Garmin Connect, intervals.icu.

## Tests

```bash
npm test             # alle Unit-Tests
npm run type-check   # TypeScript
```

## Phase 0 – Test am KICKR Core

Die Checkliste steht in der App unter *Geräte*. Wenn etwas nicht funktioniert: *GATT-Tabelle lesen* →
*Alles kopieren* und den Text als Issue anhängen.
