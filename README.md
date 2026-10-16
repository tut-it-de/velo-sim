# Velo Sim

Indoor-Cycling-Simulator für Smart-Trainer (Referenz: Wahoo KICKR Core v1) – freie Fahrt, Workouts,
Ausrüstung mit CdA-Werten, Währung und später Multiplayer. Läuft auf **Windows, macOS, iPad und im Browser**.

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
In der Browser-Version (siehe unten) ist die Adresse schon vorbelegt.
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

## Im Browser spielen

Der Spielserver liefert die Web-App gleich mit aus: App (`/`), API (`/api`) und WebSocket (`/ws`) laufen unter
einer Adresse. Wird die App so geöffnet, ist der Server automatisch eingetragen (`wss://` bei HTTPS).

**Lokal:**

```bash
npm run build -w @velo/client      # Web-App nach apps/client/dist bauen
npm run build -w @velo/server      # Server bündeln
node apps/server/dist/server.mjs   # → http://localhost:8080 (ohne DATABASE_URL: Daten nur im Speicher)
```

Anderes Verzeichnis für die App: `CLIENT_DIST=/pfad/zu/dist`, abschalten mit `CLIENT_DIST=off`.

**Online mit HTTPS (Docker + Caddy):** Web Bluetooth funktioniert nur über HTTPS (oder `localhost`).
Domain per DNS auf den Server zeigen lassen, Ports 80 und 443 freigeben, dann im Repository:

```bash
echo "JWT_SECRET=$(openssl rand -hex 32)" >  .env
echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)" >> .env
echo "DOMAIN=velo.deine-domain.de" >> .env
docker compose -f docker-compose.server.yml -f deploy/docker-compose.web.yml up -d --build
```

Caddy holt das Zertifikat automatisch, das Spiel läuft unter `https://velo.deine-domain.de`
(`PUBLIC_URL` für Strava wird aus `DOMAIN` abgeleitet). Nur mit `docker-compose.server.yml` ist die App unter
`http://<server>:8080/` erreichbar – ohne HTTPS aber ohne Bluetooth.

**Browser und Geräte:**

- **Web Bluetooth** (Smart-Trainer, Pulsgurt): Chrome und Edge unter Windows, macOS und Android.
- **Safari kann kein Web Bluetooth** – auch nicht auf dem iPad (dort gilt das ebenso für Chrome und Edge, die
  unter iPadOS Safaris Engine nutzen). Auf dem iPad die [iPad-App](#ipad-app) verwenden oder den Browser
  **Bluefy** (App Store). Firefox unterstützt Web Bluetooth ebenfalls nicht.
- **ANT+** ist im Browser nicht verfügbar, nur Bluetooth LE.
- Ohne Hardware geht überall der Simulator (Geräte → *Simulator statt Bluetooth*).
- Als App installieren: Chrome/Edge → *App installieren*, Safari → *Teilen → Zum Home-Bildschirm* (Vollbild, Querformat).

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
  routes/     Strecken: drei Fantasie-Rundkurse (Spline) und echte Strecken aus Geodaten (Polyline)
tools/
  geo/        Erzeugt die echten Strecken und ihre 3D-Welten aus offenen Geodaten (siehe unten)
  metrics/    NP, IF, TSS, Zonen, Aufzeichnung, FIT-Export
  workouts/   Workout-Modell, .zwo Import/Export, ERG-Player, Bibliothek
  equipment/  Ausrüstungskatalog, Wertungen, Zeitvergleich, Watt-Taler-Regeln
  protocol/   Nachrichten zwischen App und Spielserver
```

## Echte Strecken (Geodaten)

| Strecke | Region | Länge | Höhenmeter | Charakter |
|---|---|---|---|---|
| Lago di Como – Bellagio Loop | Comer See · Italien | 22,8 km | 683 hm | Uferstraße und Anstieg nach Civenna |
| Großer Feldberg – ab Hohemark | Taunus · Deutschland | 23,4 km | 596 hm | Vom Waldtraut über die Kanonenstraße und den Sandplacken zum Gipfel (879 m), 11,6 km mit Ø 4,9 % |
| Taunus – Mammolshainer Stich | Taunus · Deutschland | 15,7 km | 320 hm | Runde ab Kronberg: Mammolshainer Stich (2,4 km, Ø 7,8 %, bis 16 %), Königstein, Falkenstein, B 455 |
| Alpe d'Huez – 21 Kehren | Oisans · Frankreich | 29,0 km | 1135 hm | Bourg-d'Oisans – D211 mit 21 Kehren – Ankunft Avenue du Rif Nel, 14 km mit Ø 8 % |

Jede echte Strecke hat ein eigenes Skript in `tools/geo/` (z. B. `feldberg_taunus.py`) auf Basis der
gemeinsamen Bibliothek `tools/geo/worldgen.py`. Das Skript beschreibt die Welt (Ausschnitt, See, Flora,
Architektur), legt die Runde über echte Straßen fest und markiert die Segmente. Die Bibliothek lädt Straßen,
Gebäude, Landnutzung und Ortsnamen von Overture Maps (OpenStreetMap) sowie das Höhenmodell (AWS Terrain
Tiles), glättet das Höhenprofil auf die Trainer-Grenzen und schreibt:

- `packages/routes/src/data/<name>.ts`: die Runde (4-m-Polyline mit Höhen) und die Segmente,
- `apps/client/public/worlds/<id>/world.json` und `terrain.bin`: Gebäude, Bäume, Nebenstraßen, Orte, See
  und das Gelände in drei Detailstufen.

Der Client wählt nach `look.flora` (mediterran / mitteleuropäisch / alpin) die Baumarten und nach
`look.architecture` (italienisch / deutsch / alpin) Fassaden, Dachformen, Kirchtürme und Fahrbahnmarkierung.

```bash
pip install pyarrow shapely networkx numpy pillow
python3 tools/geo/feldberg_taunus.py   # Downloads landen in tools/geo/.cache/
```

Danach die Strecke in `packages/routes/src/routes.ts` eintragen.

## Bedienung

- **Fahren → Freie Fahrt:** Strecke wählen, optional Pacer-Bots, los. Die Steigung geht (gedämpft durch die Trainer-Schwierigkeit) an den KICKR.
- **Fahren → Workout:** Workout aus der Bibliothek wählen, `.zwo` importieren oder im Editor bauen, dann eine Strecke wählen.
  Im Workout hält der Trainer die Watt (ERG), freie Abschnitte laufen im SIM-Modus.
- **HUD:** oben links die Strecke mit Rundenfortschritt, oben rechts die Fahrer in der Nähe (Flagge, W/kg,
  Zeitabstand) und die Karte mit Nordpfeil, links das Anstiegs-Panel (ab 1,5 km vor einer Bergwertung:
  Länge, Ø-Steigung, Profil, Restdistanz, Zeit gegen die Bestzeit), unten Speed/Leistung/Kadenz/Puls und
  Distanz/Zeit/Steigung. Das Land für die Flagge stellst du unter **Profil** ein.
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
