# Velo Sim – Projektplan

Indoor-Cycling-Simulator nach dem Vorbild von Zwift. Referenz-Hardware: **Wahoo KICKR Core v1**.
Zielplattformen der ersten Version: **Windows, macOS, iPad**.

## Umfang Version 1

| Enthalten | Später |
|---|---|
| Freie Fahrt im SIM-Modus (Steigung → Trainer) | Rennen, Startblöcke, Kategorien |
| Workouts im ERG-Modus auf jeder der 3 Strecken | Gruppenfahrten, Event-Kalender |
| 3 Rundkurse (10–20 km) mit Segmenten & persönlichen Bestzeiten | Ranglisten gegen andere |
| Räder, Laufräder, Trikots mit CdA/Gewicht und Wertung | Helme, Schuhe, Reifen (Crr) |
| Währung („Watt-Taler“), Garage & Shop | Level/Freischaltungen |
| Multiplayer: andere sehen, Windschatten, Chat, Kudos | Android, Trainingspläne |

## Plattformen & Technik

| Plattform | Hülle | Bluetooth |
|---|---|---|
| Windows | Electron (`apps/desktop`) | Web Bluetooth, Geräteauswahl im Main-Prozess |
| macOS | Electron (`apps/desktop`) | Web Bluetooth |
| iPad | Capacitor (`apps/client/ios`) | `@capacitor-community/bluetooth-le` (CoreBluetooth) |
| Entwicklung | Chrome/Edge auf `localhost` | Web Bluetooth oder eingebauter Simulator |

Gemeinsamer Code: TypeScript, React (UI/HUD), Babylon.js (3D), Vite. Backend später: Node/Colyseus + PostgreSQL.

## KICKR Core v1

- Firmware zuerst über die Wahoo-App aktualisieren (geschätzte Kadenz seit 2019, bis zu 3 BLE-Verbindungen).
- Steuerung: FTMS (`0x1826`) bevorzugt; Fallback Wahoo-Control-Characteristic `a026e005-0a7d-4ab3-97fa-f1500f9feb8b` im Cycling-Power-Service.
- Kadenz wird geschätzt; optionaler Kadenzsensor (CSC) wird bevorzugt, wenn verbunden.
- Grenzen: max. 1.800 W, Steigung bis 16 % / Gefälle bis −10 %, ±2 %. Strecken gehen bis max. 12 %.
- Windows: Bluetooth früh testen (Wahoo unterstützt BLE unter Windows nicht offiziell) – Fallback ANT+.

## Die drei Rundkurse

| | Küstenrunde (flach) | Hügelrunde (wellig) | Bergrunde (bergig) |
|---|---|---|---|
| Länge | 16 km | 13 km | 18 km |
| Höhenmeter | 41 hm | 202 hm | 472 hm |
| Charakter | lange Geraden, max. 1,6 % | 4 Anstiege bis 7,5 % | Passo Alto 5 km Ø 7 % (Rampe 12 %), Abfahrt bis −9 % |
| Ausrüstung | Aero zählt | gemischt | Gewicht zählt |

## Ausrüstung

```
Masse = Fahrer + Rad + Laufräder
CdA   = (CdA_Basis + ΔCdA_Rad + ΔCdA_Laufräder + ΔCdA_Trikot) · (1 − Windschatten)
```

- `CdA_Basis` ≈ 0,300 m² (Oberlenker), skaliert nach Größe/Gewicht.
- Wertungen Aero ★1–5 und Gewicht ★1–5 werden automatisch aus den Daten berechnet.
- Zeitvergleich in der Garage: simulierte Runde bei 75 % FTP je Strecke.
- Katalog als JSON (`packages/equipment`), Namen/Werte jederzeit änderbar. Namen sind an echte Modelle angelehnt –
  vor einer Veröffentlichung prüfen (Markenrecht), echte Logos nie verwenden.
- 3D-Aufwand: 3 Rahmenformen × Lackierungen, 4 Felgenhöhen, 3 Trikot-Passformen.

## Währung „Watt-Taler“ (Arbeitsname)

- 1 Taler pro kJ Arbeit, Boni: Runde 50, Workout +20 %, erste Runde je Strecke 500, PB 100, Wochenziel 500.
- Live im HUD, verbindlich vom Server gebucht (Ledger-Tabelle), Plausibilitätsprüfung, Simulator verdient nichts.
- Preise: Einsteigerrad ~2 Wochen, Mittelklasse ~3 Monate, Top ~10 Monate bei 3 h/Woche.

## Roadmap

| Phase | Inhalt | Status |
|---|---|---|
| 0 – KICKR-Spike | BLE-Paket (FTMS, Wahoo, CPS, HRM, CSC), Simulator, Geräte-Seite, Electron, iPad-Projekt | ✅ Code fertig – Test am echten KICKR offen |
| 1 – Single-Player-MVP | Physik, alle 3 Strecken, 3D-Szene, HUD, freie Fahrt (SIM), Pacer-Bots, Aktivitäten, FIT-Export | ✅ |
| 2 – Workouts | ERG-Engine, `.zwo` Import/Export, Bibliothek (9), Editor, Rampentest → FTP, Zonen/NP/IF/TSS | ✅ |
| 3 – Segmente & Bestzeiten | Zeitmessung für Bergwertungen, Sprints, Abfahrten und Runden, Live-Vergleich, Bestzeiten-Übersicht | ✅ |
| 4 – Ausrüstung & Währung | Katalog (15 Räder, 7 Laufräder, 11 Trikots), Wertungen, Zeitvergleich, Garage/Shop, Watt-Taler mit Ledger, Avatar zeigt Ausrüstung | ✅ lokal – Server-Buchung folgt mit Phase 5 |
| 5 – Multiplayer | Eigener WebSocket-Server (statt Colyseus), Konten (scrypt/JWT), Ledger in PostgreSQL, Taler-Buchung aus Server-Telemetrie mit Plausibilitätsprüfung, Räume pro Strecke (300er-Shards), Interpolation, Windschatten hinter echten Fahrern, Chat, Kudos, Last-Bots, Docker | ✅ |
| + | Windschatten-Leiste im HUD, automatischer Strava-Upload (OAuth über den Server, Tokens verschlüsselt, Auto-Refresh, Duplikat-Erkennung) | ✅ |
| + | Lago di Como – Bellagio Loop aus echten Geodaten (Gelände, OSM-Gebäude, Bäume, Dorfstraßen), Geländemodell ohne Dächer, Mauern/Brüstungen/Leitplanken, See mit Spiegelung, Wolkenhimmel, Schatten, Qualitätsstufen | ✅ |
| + | HUD nach Vorlage: Streckenkarte, „In der Nähe“ mit Flaggen und Zeitabständen, Minimap mit Nordpfeil, Anstiegs-Panel mit Steigungsprofil, Werte unten links (Speed, Leistung, Kadenz, Puls) und rechts (Distanz, Zeit, Steigung) | ✅ |
| 6 – Später | Helme, Level, Trainingspläne, Gruppenfahrten, Rennen | offen |
