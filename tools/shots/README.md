# Screenshot-Werkzeug (tools/shots)

Öffnet die Fahrt-Ansicht im Browser, setzt Qualität, Distanz und Pacer-Bots und speichert ein PNG.
Dient dem Vergleich der Vergleichsstellen aus `docs/REALISM_PLAN.md` (Abschnitt 1.3).

Eigenes kleines Paket, nicht Teil der npm-Workspaces.

## Installation

Voraussetzungen: Node.js 22+, Google Chrome (Standardweg: `channel: 'chrome'`).

```bash
cd tools/shots
npm install
```

## Preview-Server starten

Das Werkzeug braucht einen laufenden Build auf Port 4173:

```bash
cd apps/client && npx vite build && npx vite preview --port 4173 --strictPort
```

## Aufruf

```bash
node shot.mjs <out.png> <qualität> <distanz> [breite=1672] [höhe=941] [route="Lago di Como"]
```

- `qualität`: `auto`, `ultra`, `hoch`, `mittel` oder `niedrig`.
- `distanz`: Position auf der Strecke in Metern.
- `route`: Teil des Routennamens, der Button wird per Textsuche gefunden.

Vergleichsstellen (Ausgabe außerhalb des Repos ablegen):

```bash
node shot.mjs "$TMPDIR/wall-hoch.png" hoch 3500      # wall: Stützmauer, Straße, Fahrer von hinten
node shot.mjs "$TMPDIR/forest-hoch.png" hoch 8500    # forest: Anstieg Civenna im Wald
node shot.mjs "$TMPDIR/descent-hoch.png" hoch 18000  # descent: Abfahrt mit Bergen, Leitplanke, Wiese
```

Umgebungsvariablen:

- `URL`: Adresse des Servers, Standard `http://localhost:4173/`.
- `CHROME_PATH`: Pfad zu einer eigenen Chrome-Binärdatei statt der installierten Google Chrome.
- `SOFTWARE=1`: Rendern ohne GPU (SwiftShader). Nur für Rechner ohne brauchbare Grafikkarte, sehr langsam.

Konsolenfehler der Seite werden nach dem Screenshot auf stderr ausgegeben. Schlägt ein Schritt
fehl (z. B. unbekannter Routenname), endet das Skript mit Exit-Code 1.
