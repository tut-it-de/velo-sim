# Realismus-Plan: näher an das Referenzbild

Ziel: Der Look einer modernen Radsimulation (MyWhoosh/RGT-Niveau): tiefe warme Sonne, Schatten von
Bäumen und Mauern auf der Straße, echte Bäume, Oberflächen mit Struktur, nahe Verfolger-Kamera.
Fotorealismus wie im KI-Referenzbild ist im Browser nicht erreichbar – jede Phase soll aber sichtbar
näher heranführen.

Entscheidungen des Nutzers:
- Qualitätsstufen bleiben **manuell umstellbar**. Neue Stufe **„Ultra“** für starke Grafikkarten;
  „Automatisch“ wählt nie Ultra. Das iPad nutzt „Mittel“ und bekommt nur die günstigen Verbesserungen.
- Zusätzliche Ladegröße von 40–80 MB ist in Ordnung.
- Arbeit Punkt für Punkt, mit Screenshots nach jeder Phase.

---

## 1. Arbeitsweise mit mehreren Agenten

### Rollen

- **Orchestrator** (stärkeres Modell): verteilt Aufgaben, prüft das Ergebnis (Screenshots ansehen,
  Diff lesen), committet und pusht, schreibt den Status in diese Datei (Spalte „Status“).
- **Ausführende Agenten** (Haiku): genau **eine Aufgabe** aus diesem Plan pro Agent.

### Regeln für ausführende Agenten (in jeden Agenten-Prompt kopieren)

1. Ändere **nur** die Dateien, die in der Aufgabe unter „Dateien“ stehen. Neue Dateien nur, wenn dort
   aufgeführt.
2. **Nicht committen, nicht pushen.** Der Orchestrator macht das.
3. Halte dich an den Stil der Umgebung: TypeScript strict, englische Code-Kommentare in derselben
   Dichte wie im Rest der Datei, keine neuen npm-Abhängigkeiten ohne ausdrückliche Erlaubnis.
4. Vor der Rückmeldung müssen diese Befehle fehlerfrei laufen (im Repo-Root `velo-sim/`):
   ```
   npm run type-check
   npm test
   cd apps/client && npx vite build
   ```
5. Wenn die Aufgabe einen Screenshot verlangt: mit `tools/shots` erstellen (siehe 1.3) und den
   Dateipfad zurückmelden.
6. Rückmeldung: Liste der geänderten Dateien, Ergebnis der Prüfbefehle, Pfade der Screenshots,
   offene Probleme. Keine Vermutungen als Erfolg melden.
7. Wenn etwas in der Aufgabe nicht zum Code passt (Name, Zeile, API existiert nicht): **anhalten und
   melden**, nicht improvisieren.

### Parallelität

Aufgaben mit derselben **Gruppe** (z. B. `1A`) ändern verschiedene Dateien und dürfen gleichzeitig
laufen. Eine Gruppe startet erst, wenn alle Gruppen davor abgenommen sind (`1A` → `1B` → …).

### 1.3 Screenshots (Vergleichspunkte)

Feste Vergleichsstellen auf „Lago di Como – Bellagio Loop“ (Distanz in Metern):

| Name | Distanz | Was man sieht |
|---|---|---|
| `wall` | 3500 | Stützmauer, Straße, Fahrer von hinten |
| `forest` | 8500 | Anstieg Civenna im Wald |
| `descent` | 18000 | Abfahrt mit Bergen, Leitplanke, Wiese |

Befehl (nach P0.2): `node tools/shots/shot.mjs <ausgabe.png> <qualität> <distanz> [breite] [höhe]`.
Auf dem Laptop mit echter Grafikkarte läuft er mit GPU; in der Cloud-Umgebung mit `SOFTWARE=1`.

---

## 2. Phasen und Aufgaben

Legende Status: `offen` · `läuft` · `fertig` · `verworfen`

### Phase 0 – Grundlagen

| ID | Gruppe | Aufgabe | Status |
|---|---|---|---|
| P0.1 | 0A | Qualitätsstufe „Ultra“ | fertig |
| P0.2 | 0A | Screenshot-Werkzeug ins Repo | fertig |

**P0.1 Qualitätsstufe „Ultra“**
- Dateien: `apps/client/src/game/real/quality.ts`, `apps/client/src/game/real/realWorld.ts`,
  `apps/client/src/game/real/water.ts`, `apps/client/src/game/real/sideRoads.ts`
- In `quality.ts`:
  - `GraphicsQuality` = `'auto' | 'ultra' | 'hoch' | 'mittel' | 'niedrig'`.
  - In `GRAPHICS_QUALITY_OPTIONS` nach `auto` einfügen:
    `{ id: 'ultra', label: 'Ultra', hint: 'Schatten von Bäumen und Häusern, Umgebungsverdeckung – nur starke Grafikkarten' }`.
  - `QualityProfile` um drei Felder erweitern (mit Doc-Kommentar wie die anderen):
    - `cascades: number` – Anzahl Schattenkaskaden, 0 = nur einfacher Fahrerschatten.
    - `shadowDistance: number` – Reichweite der Schatten in m.
    - `ssao: boolean` – Umgebungsverdeckung (Schatten in Ecken und Spalten).
  - `PROFILES.ultra` = Kopie von `hoch` mit `dprCap: 2`, `shadowMap: 2048`, `cascades: 3`,
    `shadowDistance: 160`, `ssao: true`, `treeRadius: 380`, `treeDistance: 3200`.
  - `hoch`: `cascades: 2`, `shadowDistance: 90`, `ssao: false`.
  - `mittel`: `cascades: 0`, `shadowDistance: 0`, `ssao: false`. `niedrig` ebenso.
  - `detectQuality` bleibt unverändert (gibt nie `ultra` zurück).
- `realWorld.ts`: `quality.level === 'hoch'` → `(quality.level === 'hoch' || quality.level === 'ultra')`.
- `water.ts`: gleiche Ersetzung bei `refreshRate`.
- `sideRoads.ts`: `REACH` bekommt `ultra: 1100`.
- Abnahme: Prüfbefehle grün; in den Einstellungen erscheint „Ultra“ (die Liste wird automatisch aus
  `GRAPHICS_QUALITY_OPTIONS` erzeugt). Optisch noch keine Änderung.

**P0.2 Screenshot-Werkzeug ins Repo**
- Dateien (neu): `tools/shots/package.json`, `tools/shots/shot.mjs`, `tools/shots/README.md`
- `package.json`: `{"name":"velo-shots","private":true,"type":"module","dependencies":{"playwright-core":"^1.56.0"}}`
  (eigenes Paket, **nicht** in die Workspaces aufnehmen).
- `shot.mjs` – Aufruf `node shot.mjs <out.png> <quality> <dist> [W=1672] [H=941] [route="Lago di Como"]`:
  1. Browser: `chromium.launch({ executablePath: process.env.CHROME_PATH, channel: process.env.CHROME_PATH ? undefined : 'chrome', args })`.
     Wenn `SOFTWARE=1`: `args = ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']`,
     sonst `['--ignore-gpu-blocklist','--enable-gpu']`.
  2. `localStorage['velo.settings.v1'] = {"rideOnline":false,"graphicsQuality":<quality>,"riderName":"Ali","country":"DE"}` per `addInitScript`.
  3. `page.goto(process.env.URL ?? 'http://localhost:4173/')`, Button „Simulator starten“, kurz warten,
     Button mit dem Routennamen, Button „Los geht“, warten auf `.hud` (Timeout 600 s).
  4. Im Seitenkontext: `window.__velo.session.state.distanceM = dist; speedMps = 5.5;` Bots auf
     `dist + 48`, `dist - 35`, `dist - 160` setzen (inkl. `renderDistance`), Geschwindigkeit 5.2.
  5. 4 s warten, Screenshot, Browser schließen, Konsolenfehler ausgeben.
  - Vorlage: `hud.mjs` des Orchestrators (wird dem Agenten in den Prompt kopiert).
- `README.md`: Installation (`cd tools/shots && npm install`), Preview-Server starten
  (`cd apps/client && npx vite build && npx vite preview --port 4173 --strictPort`), Beispielaufrufe für
  die drei Vergleichsstellen, Hinweis auf `SOFTWARE=1` und `CHROME_PATH`.
- Abnahme: Ein Screenshot an `wall` mit `hoch` entsteht ohne Fehler.

---

### Phase 1 – Kamera und Licht

| ID | Gruppe | Aufgabe | Status |
|---|---|---|---|
| P1.1 | 1A | Neue Verfolger-Kamera | fertig |
| P1.2 | 1A | Tiefe, warme Sonne und Himmelsfarben | fertig |
| P1.3 | 1B | Kaskadenschatten (Bäume, Mauern, Häuser) | fertig |
| P1.4 | 1B | Filmische Tonwertkurve und Bildstimmung | fertig |
| P1.5 | 1C | Umgebungsverdeckung (SSAO) für Ultra | fertig |
| P1.6 | 1C | Höhendunst in Tälern | fertig |
| P1.7 | 1D | Abnahme-Screenshots Phase 1 | fertig |

**P1.1 Neue Verfolger-Kamera**
- Datei: `apps/client/src/game/world.ts` (nur `updateCamera`, Zweig `default`, und Konstruktor-FOV)
- Kamera wie im Referenzbild: tief, nah, Blick die Straße hinunter.
  - `behind`: `me.distanceM - 4.6 + 1.6 * bend` (vorher `- 7 + 2.5 * bend`), seitlich `me.lateralM - 0.25`.
  - Höhe: `Math.max(behind.y, p.y) + 1.75` (vorher `+ 2.5`).
  - `ahead`: `me.distanceM + 20 - 9 * bend`, Zielhöhe `ahead.y + 1.15` (vorher `+ 8 - 2 * bend` und `+ 0.9`).
  - Gewichtung beim Blick entlang der Fahrtrichtung bleibt (`w = 0.6 * bend`), aber mit `p + f * 14`
    statt `p + f * 6`.
  - Neues Feld `private fov = 0.95;` – bei `chase` `this.camera.fov` weich (gleiches `k`) auf `0.92`,
    bei anderen Modi auf `1.0` führen. (Vignette nutzt `camera.fov` nur einmal beim Aufbau – ok.)
- Haarnadel-Logik und Glättung nicht entfernen.
- Abnahme: Screenshots an `wall` und `forest`: Fahrer etwa im unteren mittleren Drittel, Kopf knapp
  unter der Bildmitte, Straße läuft zur Bildmitte, Horizont/Hang im oberen Drittel. In Haarnadeln
  (Distanz 16500 ausprobieren) taucht die Kamera nicht in Bäume oder Hang.

**P1.2 Tiefe, warme Sonne und Himmelsfarben**
- Dateien: `apps/client/src/game/real/env.ts`, `apps/client/src/game/real/realWorld.ts`
- `env.ts`:
  - `SUN_DIR = new Vector3(0.655, -0.375, 0.655).normalize()` (Sonne ~22° hoch, aus Südwest).
    Doc-Kommentar anpassen: „late-afternoon sun from the south-west, about 22° above the horizon“.
  - `SKY`: `zenith: '#2c62b0'`, `mid: '#7aa6d8'`, `horizon: '#e6dccb'`, `fog: '#c9c6bd'`, `sun: '#ffe2b0'`.
  - `FOG_DENSITY` bleibt.
- `realWorld.ts` (Licht im `build`):
  - `hemi.intensity = 0.5`, `hemi.diffuse = new Color3(0.64, 0.76, 1)`, `hemi.groundColor = new Color3(0.36, 0.3, 0.22)`.
  - `sun.intensity = 1.55`, `sun.diffuse = new Color3(1, 0.84, 0.64)`, `sun.specular` gleich.
  - Kommentar über dem Licht aktualisieren (warmes Abendlicht, kühler Schatten).
- Hinweis: `terrain.ts`, `sky.ts`, `water.ts`, `roadRibbon.ts` lesen `TO_SUN`/`SKY` aus `env.ts` –
  dort nichts ändern. Die gebackenen Bergschatten werden dadurch automatisch länger.
- Abnahme: Screenshots an allen drei Stellen. Warmes Licht, längere Schatten an Bergen, keine
  komplett schwarzen Flächen (Schattenseiten müssen bläulich-grau mit erkennbaren Details sein).

**P1.3 Kaskadenschatten (Bäume, Mauern, Häuser)**
- Dateien: `apps/client/src/game/real/realWorld.ts`, `apps/client/src/game/real/vegetation.ts`
  (nur Rückgabewert, falls nötig), `apps/client/src/game/real/terrain.ts` (nur `receiveShadows`)
- In `RealWorld.build`: wenn `quality.cascades > 0`, statt `ShadowGenerator` einen
  `CascadedShadowGenerator(quality.shadowMap, sun)` (Import aus `@babylonjs/core`) anlegen:
  - `numCascades = quality.cascades`, `shadowMaxZ = quality.shadowDistance`, `lambda = 0.85`,
    `stabilizeCascades = true`, `cascadeBlendPercentage = 0.1`, `autoCalcDepthBounds = false`,
    `usePercentageCloserFiltering = true`, `filteringQuality = ShadowGenerator.QUALITY_MEDIUM`,
    `darkness = 0.32`, `bias = 0.003`, `normalBias = 0.02`, `depthClamp = true`.
  - `sun.autoUpdateExtends`/`shadowFrustumSize`/`shadowMinZ`/`shadowMaxZ` **nicht** setzen (nur im
    alten Zweig).
  - Werfer: alle Baum-Meshes (`trees`), Gebäude (`buildings`), aus `ribbon.other` alle Meshes, deren
    Name **nicht** mit `verge-` beginnt (Mauern, Geländer, Laternen; `RibbonMeshes` hat nur `road`
    und `other`), `landmarks.solid`. **Nicht** die Straßenfläche. Fahrer kommen wie bisher über `addRider`.
  - Empfänger: `ribbon.road`, alle `ribbon.other`, `terrain.meshes` (nahe LOD), Gebäude.
    Bäume empfangen **keine** Schatten.
  - Feld `shadow` wird zu `ShadowGenerator | CascadedShadowGenerator`
    (`CascadedShadowGenerator` erbt von `ShadowGenerator`, Typ `ShadowGenerator` genügt).
  - In `update()` die Zeile `this.sun.position…` nur ausführen, wenn es der alte Generator ist.
  - Bäume sind alpha-getestete Billboards: prüfen, dass der Schatten die Blattform hat (Babylon
    berücksichtigt `useAlphaFromDiffuseTexture` + `alphaCutOff` im Schatten automatisch). Wenn die
    Schatten Rechtecke sind: anhalten und melden.
- Wenn `quality.cascades === 0` und `quality.shadowMap > 0`: alter Code unverändert (Mittel).
- Abnahme: Screenshot `forest` und `wall` mit `ultra` und `hoch`: Baumschatten fallen sichtbar
  über die Straße, Mauer wirft Schatten, keine Streifen („shadow acne“) auf der Straße, keine
  sichtbaren Kaskadengrenzen. Bildrate auf dem Laptop notieren (Nutzer).

**P1.4 Filmische Tonwertkurve und Bildstimmung**
- Datei: `apps/client/src/game/real/grading.ts`
- `toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES`, `exposure = 1.35`,
  `contrast = 1.06`. Kommentar über der Funktion entsprechend ändern (ACES jetzt, weil das Licht
  nicht mehr flach ist).
- `ColorCurves`: `globalSaturation = 6`, `highlightsHue = 40`, `highlightsDensity = 22`,
  `shadowsHue = 210`, `shadowsDensity = 18`, `shadowsSaturation = 10`.
- Bloom: `bloomThreshold = 0.85`, `bloomWeight = 0.22`.
- Wenn `quality.level === 'ultra'`: `pipeline.chromaticAberrationEnabled = false`,
  `pipeline.sharpenEnabled = true`, `pipeline.sharpen.edgeAmount = 0.25`.
- Abnahme: Screenshots aller drei Stellen mit `hoch` und `mittel`. Der Orchestrator vergleicht mit
  dem Stand nach P1.2: Himmel nicht ausgebrannt, Schatten nicht schwarz, Grün nicht neongrün. Wenn zu
  dunkel: `exposure` in Schritten von 0.1 anheben (max. 1.7) und erneut prüfen.
- Ergebnis (Orchestrator): Mit ACES lagen Waldboden und Schattenseiten fast schwarz, auch auf „Mittel“
  (also nicht durch die Kaskadenschatten). Übernommen: `exposure = 1.7`; zusätzlich in `realWorld.ts`
  `hemi.intensity` 0.5 → 0.7 (Himmelsfüllung für die Schattenseiten). Kontrast bleibt 1.06.

**P1.5 Umgebungsverdeckung (SSAO) für Ultra**
- Dateien: `apps/client/src/game/real/grading.ts`, `apps/client/src/game/world.ts` (nur Aufruf)
- Neue Funktion `setupAmbientOcclusion(scene, camera, quality)` in `grading.ts`: wenn `quality.ssao`
  und `scene.getEngine().webGLVersion >= 2`, dann
  `new SSAO2RenderingPipeline('ao', scene, { ssaoRatio: 0.5, blurRatio: 1 }, [camera], true)` mit
  `radius = 1.6`, `totalStrength = 1.1`, `base = 0.1`, `samples = 16`, `maxZ = 250`,
  `minZAspect = 0.5`, `expensiveBlur = true`, `epsilon = 0.02`.
- In `world.ts/buildReal` **vor** `setupImagePipeline` aufrufen (Reihenfolge der Post-Processes).
- Abnahme: Screenshot `wall` mit `ultra`: dunkle Kontaktschatten am Fuß der Mauer und unter dem Rad,
  kein Halo um den Fahrer gegen den Himmel, kein Rauschen. Wenn Halo oder Artefakte: `radius` auf 1.0
  senken; bleibt es schlecht, Aufgabe als `verworfen` melden.

**P1.6 Höhendunst in Tälern**
- Datei: `apps/client/src/game/real/terrainMaterial.ts` (Fragment-Code in `UPDATE_DIFFUSE` ist die
  falsche Stelle – neuen Block über `CUSTOM_FRAGMENT_BEFORE_FOG` im `TerrainPlugin` hinzufügen)
- Zusätzlich zum Szenen-Nebel: Dunst, der mit sinkender Höhe und wachsender Entfernung zunimmt:
  ```glsl
  float veloD = distance(vPositionW, vEyePosition.xyz);
  float veloLow = 1.0 - smoothstep(veloMap.w + 50.0, veloMap.w + 900.0, vPositionW.y);
  float veloHaze = (1.0 - exp(-veloD * 0.00012)) * veloLow * 0.55;
  color.rgb = mix(color.rgb, <SKY.fog als vec3 im linearen Raum>, veloHaze);
  ```
  (`veloMap.w` ist der Wasserspiegel; Farbe über `Color3.FromHexString(SKY.fog).toLinearSpace()`
  als Konstante einsetzen, Import aus `./env`.)
- Abnahme: Screenshot `descent`: entfernte Talhänge blasser und wärmer als nahe, Gipfel klarer als
  Talgrund. Nahe Wiese unverändert.
- Ergebnis (Orchestrator): Dunstfarbe bewusst im Gamma-Raum (StandardMaterial mischt den Szenen-Nebel
  dort ebenfalls); Wirkung mit den Planwerten dezent. SSAO (P1.5): WebGL-2-Prüfung über
  `engine instanceof ThinEngine`, Kontaktschatten am Rad sichtbar, am Mauerfuß kaum.

**P1.7 Abnahme Phase 1** (Orchestrator)
- Screenshots `wall`, `forest`, `descent` jeweils mit `ultra`, `hoch`, `mittel`; Vorher/Nachher-Bild
  zusammensetzen, dem Nutzer schicken. Nutzer prüft Bildrate auf dem Laptop (Ultra/Hoch) und iPad (Mittel).

---

### Phase 2 – Oberflächen mit Struktur

Freie Texturbibliotheken (Poly Haven, ambientCG) sind aus der Cloud-Umgebung nicht erreichbar.
Darum: **Texturen werden offline per Python-Skript erzeugt** (numpy + Pillow, beide vorhanden),
kachelbar, 1024², als WebP in `apps/client/public/textures/`. Eingebunden als Babylon
**Detail-Map** (eine RGBA-Textur: R = Helligkeit, G = Normale Y, B = Rauheit, A = Normale X; 0.5 = neutral),
die über die bestehende Grundfarbe gelegt wird – so bleiben Fahrbahnmarkierungen und
Fassadenfarben erhalten.

| ID | Gruppe | Aufgabe | Status |
|---|---|---|---|
| P2.1 | 2A | Texturgenerator-Grundgerüst | fertig |
| P2.2 | 2B | Asphalt-Detailmap | fertig |
| P2.3 | 2B | Bruchstein-/Mauer-Detailmap | fertig |
| P2.4 | 2B | Putz- und Ziegel-Detailmaps | fertig |
| P2.5 | 2B | Fels- und Waldboden-Detailmaps | fertig |
| P2.6 | 2C | Detailmaps an Straße, Mauern, Häusern | fertig |
| P2.7 | 2C | Detailmaps im Gelände (Weltkoordinaten) | fertig |
| P2.8 | 2D | Abnahme-Screenshots Phase 2 | fertig |

**P2.1 Texturgenerator-Grundgerüst**
- Dateien (neu): `tools/texgen/texgen.py`, `tools/texgen/noise.py`, `tools/texgen/README.md`
- `noise.py`: kachelbare Bausteine, alle `numpy`, Größe `n` (Standard 1024), Ergebnis `float32` in [0,1]:
  - `fbm(n, octaves, base_freq, seed)` – kachelbares Rauschen über gefiltertes weißes Rauschen im
    Frequenzraum (`np.fft`), damit es nahtlos kachelt.
  - `voronoi(n, cells, seed)` – kachelbar (Abstände mit Wrap-around), liefert `(f1, f2, cell_id)`.
  - `height_to_normal(h, strength)` – Sobel mit `np.roll` (kachelbar), liefert nx, ny in [0,1].
  - `pack_detail(lum, height, rough, strength)` → RGBA-uint8 nach obiger Belegung.
  - `save_webp(path, rgba, quality=90, lossless=False)`; die Detail-Maps werden **verlustfrei** gespeichert
    (verlustbehaftetes WebP verdoppelt den Sprung an der Kachelnaht).
- `texgen.py`: CLI `python3 tools/texgen/texgen.py <name|all>`; Registry `GENERATORS = {}`, jeder
  Generator ist eine Funktion `(n) -> rgba`. Ausgabe nach `apps/client/public/textures/<name>.webp`.
- README: wie man neu generiert, Belegung der Kanäle, Lizenz (eigene Erzeugung, frei).
- Test: `python3 tools/texgen/texgen.py selftest` schreibt `selftest.webp` (fbm) und prüft die
  Kachelbarkeit: mittlerer Absolutunterschied zwischen erster und letzter Zeile/Spalte < 0.02. Ausgabe
  `OK`. Die Datei danach löschen.

**P2.2–P2.5 Generatoren** (je ein Agent, nur `tools/texgen/texgen.py` um eine Funktion erweitern –
parallel möglich, weil jeder nur seine Funktion anhängt; Orchestrator führt zusammen)
- `asphalt`: feiner Splitt (Voronoi mit ~900 Zellen, Steinchen leicht erhaben, unterschiedlich hell),
  Bindemittel dunkler und glatter, wenige feine Risse (dünne Linien aus Voronoi-Kanten f2−f1 < Schwelle,
  sehr dünn, nur 15 % der Kanten), Rauheit hoch (0.8–0.95). → `asphalt.webp`, Normalstärke mittel.
- `drystone`: Bruchsteinmauer – Voronoi ~60 Zellen, horizontal 1.6× gestreckt, Fugen 3–5 % tief und
  dunkel, jeder Stein mit eigener Helligkeit ±15 % und eigener fbm-Oberfläche, Kanten leicht gerundet.
  → `drystone.webp`, Normalstärke hoch.
- `plaster`: grober Putz – fbm fein + mittel, sehr schwach, mit vereinzelten Flecken/Abplatzern (10 %
  dunkler). → `plaster.webp`. `rooftile`: Mönch-Nonne-Ziegel – Reihen aus Halbzylindern (Höhe =
  `abs(sin)`), versetzte Reihen, pro Ziegel Helligkeitsvariation. → `rooftile.webp`.
- `rock`: geschichteter Fels – gestreckte fbm-Bänder plus Risse. → `rock.webp`. `forestfloor`:
  Laub und Erde – viele kleine Ellipsen (Blätter) über dunklem Grund. → `forestfloor.webp`.
- Abnahme je Generator: Datei existiert, 1024×1024, `python3 tools/texgen/texgen.py <name>` läuft
  < 60 s, Agent liefert eine 2×2-Kachelvorschau (`<name>-preview.png` im Scratchpad, nicht im Repo),
  auf der keine Naht zu sehen ist.

**P2.6 Detailmaps an Straße, Mauern, Häusern**
- Dateien: `apps/client/src/game/real/roadRibbon.ts`, `apps/client/src/game/real/buildings.ts`,
  neu `apps/client/src/game/real/detailMaps.ts`
- `detailMaps.ts`: `loadDetail(scene, name): Texture` (URL `${import.meta.env.BASE_URL}textures/${name}.webp`,
  Wrap, trilinear, Anisotropie 8, Cache pro Szene in einer `Map`).
- An `StandardMaterial`: `mat.detailMap.texture = tex; mat.detailMap.isEnabled = true;`
  `diffuseBlendLevel`, `bumpLevel`, `roughnessBlendLevel` setzen; `tex.uScale/vScale` so, dass eine
  Kachel ≈ 1.5 m (Asphalt), 2 m (Mauer), 3 m (Putz), 2 m (Dach) entspricht. Dazu UV-Wiederholung der
  bestehenden Textur nachrechnen (z. B. `roadTextureRepeat`, `STONE_REPEAT`) und ins Verhältnis setzen.
- Wo die Mauer heute `stoneTexture` (Canvas) nutzt: `drystone` als Detailmap darüber.
- Abnahme: Screenshot `wall` (ultra): Mauersteine plastisch mit Licht/Schatten, Asphalt körnig aus
  der Nähe, aber in 30 m Entfernung ruhig (kein Flimmern/Moiré).

**P2.7 Detailmaps im Gelände**
- Datei: `apps/client/src/game/real/terrainMaterial.ts`
- Im `TerrainPlugin` zwei zusätzliche Sampler `veloRock` und `veloFloor` (Detailmaps aus P2.5).
  Im `VELO_DETAIL`-Zweig: in < 120 m Entfernung Helligkeit aus der Detailmap mit Weltkoordinaten
  `vPositionW.xz / 3.0` (Fels zusätzlich `vPositionW.xy`/`zy` je nach Normalenrichtung – triplanar
  einfach) mischen: Fels nach `veloRock`-Gewicht, Waldboden nach `veloLitter`-Gewicht.
  Normale leicht stören (Detail-Normale × 0.6). Ohne `VELO_DETAIL` unverändert.
- Abnahme: Screenshot `forest` und `descent`: Felsböschung am Hang zeigt Schichtung, Waldboden zeigt
  Laub, kein sichtbares Kachelmuster aus der Fahrerperspektive.

---

### Phase 3 – Vegetation (größter Aufwand)

Ziel: Nah an der Straße (≤ 70 m) echte 3D-Bäume mit Blattbüscheln, die sich im Wind bewegen;
weiter weg Billboards, deren Bilder aus denselben 3D-Bäumen gerendert sind (Impostor), mit
Normalen für richtige Beleuchtung. Arten: Edelkastanie, Zypresse, Olivenbaum, Platane, Palme
(Comer See); Fichte, Buche, Lärche (Feldberg/Alpen); Büsche (Oleander, Lorbeer); Gras- und
Blumenbüschel am Straßenrand.

| ID | Gruppe | Aufgabe | Status |
|---|---|---|---|
| P3.1 | 3A | Blatt- und Rindentexturen (Python, wie Phase 2) | fertig |
| P3.2 | 3A | Prozeduraler Baumgenerator `treeGen.ts` + Studio-Ansicht | fertig |
| P3.3 | 3B | Artenparameter (8 Bäume, 2 Büsche) im Studio abstimmen | fertig |
| P3.5 | 3B | Wind-Shader-Plugin | fertig |
| P3.4 | 3C | Billboards aus den 3D-Bäumen backen (zur Laufzeit, Farbe + Normale) | fertig |
| P3.7 | 3D | Fernbereich: gebackene Billboards statt Canvas-Atlas, Artwahl, Instanzliste | fertig |
| P3.6 | 3E | Nahbereich: 3D-Bäume als Thin Instances | fertig |
| P3.8 | 3F | Gras, Blumen und Farn am Straßenrand | fertig |
| P3.9 | 3G | Abnahme-Screenshots + Bildrate | fertig |

Eckwerte (Bildrate nach Phase 2 auf Ultra, Hoch und iPad/Mittel flüssig):

| | Ultra | Hoch | Mittel | Niedrig |
|---|---|---|---|---|
| Nah-Bäume (3D) | ≤ 250, Radius 70 m | ≤ 120, Radius 50 m | – | – |
| Dreiecke pro Nah-Baum | ≤ 6 000 | ≤ 6 000 | – | – |
| Nah-Bäume werfen Schatten | ja | ja | – | – |
| Billboards aus 3D-Bäumen gebacken | 256×512 je Zelle | 256×512 | 128×256 | 128×256 |
| Wind | Bäume, Billboards, Gras | wie Ultra | nur Billboards, Gras | aus |
| Gras/Blumen am Rand | dicht, 80 m | dicht, 60 m | halb, 40 m | aus |

P3.7 läuft vor P3.6, weil es die Instanzliste liefert; P3.6, P3.7 und P3.8 ändern alle
`realWorld.ts` und laufen deshalb nacheinander.

**Gemeinsame Begriffe** (gelten für alle Phase-3-Aufgaben):
- Neuer Ordner `apps/client/src/game/real/trees/`. Die Arten heißen (Typ `SpeciesId`):
  `chestnut`, `beech`, `plane`, `olive`, `palm`, `spruce`, `larch`, `cypress`, `oleander`, `laurel`
  (8 Bäume, 2 Büsche).
- `TreeInstance` (in `trees/types.ts`, angelegt von P3.2):
  `{ x: number; y: number; z: number; species: SpeciesId; variant: number; height: number; yaw: number; tint: [number, number, number] }`.
  `y` = Fußpunkt, `height` in Metern, `variant` 0–2.
- Vertex-Daten der 3D-Bäume: `uv` = Texturkoordinate (Rinde bzw. Blattatlas), `uv2.x` = Windgewicht
  (0 am Stammfuß … 1 an den Zweigspitzen), `uv2.y` = Phase je Ast (0…2π). Farbe (vertex color) = Tönung.
- Texturen liegen in `apps/client/public/textures/` und werden über
  `${import.meta.env.BASE_URL}textures/<name>.webp` geladen (wie `detailMaps.ts`).
  Atlas-Texturen (`leaves`, `bark`, `grass`) mit `invertY = false` laden: die UVs aus `treeGen.ts`
  sind im Bildraum (v = 0 ist die oberste Zeile des Atlas). `leafColor`/`barkColor` sind Tönungen
  nahe 1 – die Farbe steckt schon in der Textur. Für Alpha-Test (`leaves`, `grass`, Impostor-Atlas)
  muss `texture.hasAlpha = true` gesetzt sein, sonst ignoriert Babylon den Alphakanal und die
  Karten erscheinen als volle Quadrate (Ursache der „eckigen Fichtenkarten“ aus 3A).
- Blending-Hash für Überblendungen (in allen Shadern identisch, „interleaved gradient noise“):
  `float veloIgn(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }`
  angewendet auf `gl_FragCoord.xy`.

**P3.1 Blatt-, Rinden- und Grastexturen**
- Dateien: `tools/texgen/texgen.py`, `tools/texgen/noise.py`, `tools/texgen/README.md`,
  neu `apps/client/public/textures/leaves.webp`, `bark.webp`, `grass.webp`
- `texgen.py`: `@generator(name, size=(w, h))` – optionale Größe, Standard `(SIZE, SIZE)`. `build`
  prüft die Form `(h, w, 4)`. Bestehende Generatoren bleiben unverändert und erzeugen dieselben Dateien.
- `noise.py`: `pack_albedo(rgb, alpha)` → uint8 RGBA (Farbe in sRGB, gerade Alpha – nicht
  vormultipliziert). Vor dem Packen die Farbe in die durchsichtigen Bereiche ausbluten lassen
  (wiederholtes 3×3-Mittel nur aus deckenden Nachbarn, bis alles gefüllt ist), damit Mipmaps keine
  dunklen Ränder bekommen. Funktion `dilate(rgb, alpha, steps=32)`.
- `leaves` (2048×2048, Raster 4×4, Zelle 512²): Blattbüschel von oben gesehen, Alpha = Silhouette,
  Deckung 45–65 % pro Zelle, Blätter nicht über den Zellrand (8 px Rand frei). Zellen:
  0 Edelkastanie (lange gesägte Blätter, 12–18 Stück), 1 Buche (ovale Blätter, dicht), 2 Platane
  (gelappt, groß), 3 Olive (schmal, silbrig-graugrün), 4 Palmwedel (ein Wedel diagonal über die
  ganze Zelle, Fiedern), 5 Fichtenzweig (Nadeln dicht, dunkel), 6 Lärchenzweig (Nadelbüschel, hell),
  7 Zypresse (schuppige Zweigspitzen, dunkel, sehr dicht), 8 Oleander (schmale Blätter + 3–5 rosa
  Blütendolden), 9 Lorbeer (glänzend dunkelgrün, oval), 10–15 frei (transparent).
  Farben als Grundton mit ±10 % Helligkeit pro Blatt; die Tönung (Herbst) kommt später per Vertexfarbe.
- `bark` (1024×1024, Raster 2×2, Zelle 512², deckend, kachelbar je Zelle in v): 0 gefurcht
  (Kastanie, Olive), 1 glatt grau mit Flecken (Buche, Platane), 2 schuppig rotbraun (Fichte, Lärche,
  Zypresse), 3 Palmstamm mit Ringen.
- `grass` (2048×512, Raster 4×1, Zelle 512²): 0 Grasbüschel grün, 1 trockenes Gras (Oktober),
  2 Gras mit weißen und gelben Blüten, 3 Farnwedel. Halme unten gebündelt, oben aufgefächert, unten
  im Bild = Boden.
- Abnahme: `python3 tools/texgen/texgen.py all` erzeugt alle neun Dateien, `selftest` OK, bestehende
  sechs Detailmaps byte-gleich zu vorher (`git diff --stat` zeigt sie nicht). Vorschau-PNGs jeder
  neuen Textur auf grauem und auf weißem Grund im Scratchpad; Gesamtgröße der drei neuen Dateien
  ≤ 12 MB.

**P3.2 Baumgenerator und Baum-Studio**
- Dateien: neu `apps/client/src/game/real/trees/types.ts`, `trees/treeGen.ts`,
  `trees/treeGen.test.ts`, `trees/species.ts` (nur Gerüst mit zwei Arten: `chestnut`, `spruce`),
  `apps/client/src/dev/treeStudio.ts`, `apps/client/treestudio.html`, `apps/client/vite.config.ts`
  (Eintrag `treestudio` in `rollupOptions.input`).
- `types.ts`: `SpeciesId`, `TreeInstance` (siehe oben), `SpeciesParams`:
  - `height: [min, max]` m, `trunkRadius` (am Fuß, relativ zur Höhe), `trunkLean` (rad),
    `crownStart` (Anteil der Höhe, ab dem Äste wachsen), `crownShape: 'round' | 'cone' | 'column' | 'umbrella' | 'palm' | 'bush'`,
    `crownWidth` (relativ zur Höhe), `levels` (1–3 Astebenen), `branches: [lvl1, lvl2, lvl3]`
    (Anzahl je Ebene), `branchAngle` (rad), `branchDroop` (rad), `gnarl` (0–1, Krümmung),
    `leafCell` (Zelle im Blattatlas), `leafSize` m, `leavesPerTip`, `barkCell`,
    `leafColor`/`barkColor` (`[r, g, b]` 0–1, multipliziert mit der Textur), `sides: [stamm, ast]`
    (Ecken der Zylinder, z. B. `[7, 4]`).
- `treeGen.ts`: `generateTree(p: SpeciesParams, seed: number): TreeGeometry` – reine Funktion ohne
  Babylon-Abhängigkeit (testbar). Rückgabe getrennt für Holz und Laub:
  `{ wood: GeomPart; leaves: GeomPart; height: number; radius: number }`,
  `GeomPart = { positions: Float32Array; normals; uvs; uvs2; colors; indices: Uint32Array }`.
  - Holz: Stamm und Äste als verjüngte Röhren entlang leicht gekrümmter Kurven (Segmentlänge
    ≈ 0.6 m Stamm, 0.35 m Ast), Kappen nur am Stamm unten weggelassen. Astanzahl nach `branches`,
    Abzweig an zufälliger Höhe ab `crownStart`, Richtung nach Kronenform (Kegel: Äste kürzer nach
    oben; Säule: steil; Schirm: flach nach außen oben; Palme: keine Äste, Wedel am Kopf).
  - Laub: an jeder Astspitze und entlang der letzten Ebene `leavesPerTip` Karten (Quads, Größe
    `leafSize` ±30 %, zufällig gedreht, zur Seite geneigt). **Normale jeder Kartenecke** =
    normalize(0.3 × Kartennormale + 0.7 × Richtung vom Kronenmittelpunkt zur Ecke) – damit
    leuchtet die Krone wie ein weicher Körper und hat eine Licht- und eine Schattenseite.
  - `uv2` siehe gemeinsame Begriffe. Dreiecksbudget: wenn > 6 000, Laubkarten zufällig
    ausdünnen (Holz bleibt), bis ≤ 6 000.
  - Deterministisch: gleicher `seed` → identische Arrays (eigener RNG aus `../noise` `createRng`).
- `treeGen.test.ts` (vitest): für beide Gerüst-Arten und Seeds 1–3: Dreiecke ≤ 6 000; Höhe der
  Bounding-Box innerhalb `height`; alle Normalen Länge 1 ± 1e-3; `uvs2.x` in [0, 1]; zwei Läufe
  mit gleichem Seed liefern gleiche Arrays.
- Studio (`treestudio.html?species=chestnut&seed=1&wind=0`): Szene mit grauem Boden, Sonne aus
  `env.ts` (`SUN_DIR`), Hemisphärenlicht wie `realWorld.ts`, Schatten (ShadowGenerator 2048).
  Ohne `species`: alle Arten aus `species.ts` nebeneinander mit je drei Seeds. Kamera ArcRotate.
  Materialien: Holz `StandardMaterial` mit `bark.webp`, Laub `StandardMaterial` mit `leaves.webp`,
  `MATERIAL_ALPHATEST`, `alphaCutOff = 0.4`, `backFaceCulling = false`, `twoSidedLighting = false`
  (die Kartennormalen zeigen schon aus der Krone heraus; Umdrehen macht die Hälfte der Karten dunkel),
  `useAlphaFromDiffuseTexture = true`. Fehlen die Texturen noch (P3.1 läuft parallel): einfarbig
  rendern statt abzubrechen.
- Abnahme: Test grün; Screenshot `treestudio.html` (beide Arten, je drei Seeds) im Scratchpad;
  Kastanie liest sich als runde Laubkrone mit sichtbaren Ästen unten, Fichte als Kegel.

**P3.3 Artenparameter abstimmen**
- Dateien: `apps/client/src/game/real/trees/species.ts`, bei Bedarf `trees/treeGen.ts`
  (nur neue Kronenformen, keine Änderung der Schnittstelle)
- Alle zehn Arten eintragen. Zielbilder (Höhe in m, Merkmale):
  - `chestnut` 12–20, runde breite Krone ab 30 %, knorriger Stamm, Blatt gelbgrün-dunkelgrün.
  - `beech` 18–28, hohe ovale Krone ab 40 %, glatter grauer Stamm.
  - `plane` 14–24, breite lockere Krone, gefleckter Stamm, große Blätter (auch für Linde/Garten).
  - `olive` 4–7, Schirm, verdrehter Stamm (gnarl 0.8), silbrig-graues Laub, lückig.
  - `palm` 6–11, schlanker leicht gebogener Stamm ohne Äste, 12–16 Wedel am Kopf, hängend.
  - `spruce` 18–32, schmaler Kegel bis fast zum Boden, Äste hängend (droop), dunkel.
  - `larch` 16–26, lockerer Kegel, heller; Herbstfarbe kommt über `tint` aus `vegetation.ts`.
  - `cypress` 8–16, schmale Säule (Breite ≤ 18 % der Höhe), sehr dicht, fast kein Holz sichtbar.
  - `oleander` 2–4, Busch mit vielen Trieben aus dem Boden, rosa Blüten.
  - `laurel` 2.5–5, dichter runder Busch.
- Bekannte Punkte aus 3A: Fichtenkarten zeigen eckige Kartenränder mit gelbem Saum; Kronen innen
  sehr dunkel (Studio ohne Tonwertkurve – Helligkeit im Spiel prüfen, nicht im Studio erzwingen);
  Blattzellen Lärche (6) und Zypresse (7) in `texgen.py` nachbessern (Lärche: Nadelbüschel statt
  Sterne, Zypresse: schuppige Zweigfächer statt Ovale) – dafür darf P3.3 `tools/texgen/texgen.py`
  und `leaves.webp` ändern.
- Abnahme: Studio-Screenshot aller Arten (je 3 Seeds), Dreiecke je Art im Bericht (Tabelle),
  Test grün. Der Orchestrator zeigt das Bild dem Nutzer, bevor 3C startet.

**P3.4 Billboards aus den 3D-Bäumen backen (zur Laufzeit)**
- Dateien: neu `apps/client/src/game/real/trees/impostorBake.ts`, `apps/client/src/dev/treeStudio.ts`
  (Ansicht `?mode=atlas`)
- Statt einer eigenen Bake-Seite mit Datei-Export wird beim Laden gebacken: kein zusätzlicher
  Download, und Atlas und Arten bleiben automatisch gleich. Zeitbudget ≤ 400 ms.
- `bakeImpostors(scene, species: SpeciesId[], cell: [w, h]): ImpostorAtlas` mit
  `{ color: RenderTargetTexture; normal: RenderTargetTexture; cells: Map<string, { u0, v0, u1, v1 }>; aspect: Map<string, number> }`,
  Schlüssel `${species}:${variant}`. Je Art 3 Varianten (Seeds 1–3) → Zellen im Atlas, Atlasbreite
  `16 × cell[0]`, Höhe nach Bedarf (Zweierpotenz).
  - Pro Zelle: orthografische Kamera von der Seite, Ausschnitt = Bounding-Box des Baums, Viewport
    auf die Zelle. Farbe: Holz und Laub mit ihren Texturen, **unbeleuchtet** (nur Albedo × Tönung;
    `disableLighting = true`, `emissiveColor = 1`), Alpha aus dem Laub. Normale: `ShaderMaterial`,
    das die Normale im Kameraraum als `n * 0.5 + 0.5` schreibt (Alpha-Test identisch).
  - Danach `generateMipMaps`, Sampling trilinear. RTTs nicht jedes Frame neu rendern
    (`refreshRate = 0` nach dem ersten Rendern).
- Studio `?mode=atlas`: zeigt Farb- und Normalatlas nebeneinander.
- Abnahme: Atlas-Screenshot, Zeit des Backens im Bericht (Konsole), keine Lücken/Ränder zwischen
  Zellen.

**P3.5 Wind**
- Dateien: neu `apps/client/src/game/real/trees/windPlugin.ts`, `apps/client/src/dev/treeStudio.ts`
  (nur Parameter `?wind=1`). Läuft parallel zu P3.3, das nur `species.ts`/`treeGen.ts` ändert.
- `WindPlugin extends MaterialPluginBase` (Priorität 210), Defines `VELO_WIND` und
  `VELO_WIND_CARD` (Billboard/Gras: Gewicht aus der Texturkoordinate statt `uv2`).
  Uniform `veloWind` (vec4: Richtung x, Richtung z, Stärke, Zeit). Statische Funktion
  Die Windzeit ist ein gemeinsamer Wert je Szene und läuft von selbst (`onBeforeRenderObservable`).
- Vertex (`CUSTOM_VERTEX_UPDATE_POSITION`): `w = uv2.x` (bzw. bei `VELO_WIND_CARD`:
  `w = 1.0 - uv.y`), `ph = uv2.y` (bzw. aus `positionUpdated.xz` gehasht);
  Versatz = `dir * strength * w*w * (0.6 * sin(t*1.3 + ph) + 0.25 * sin(t*3.1 + ph*2.3))`;
  zusätzlich bei `w > 0.6` ein Blattflattern `0.02 * sin(t*7.0 + dot(positionUpdated, vec3(3.1)))` in y.
  Stärke: Bäume 0.15 m an den Spitzen, Billboards 0.08, Gras 0.06. Die Instanz-Matrix (Thin
  Instances) muss vorher angewendet sein – Versatz in Weltkoordinaten addieren
  (`CUSTOM_VERTEX_UPDATE_WORLDPOS`), nicht im Objektraum.
- Schatten: Der Schatten bewegt sich nicht mit (Versatz zu klein, um aufzufallen) – bewusst so.
- Studio: `?wind=1` aktiviert das Plugin an Holz und Laub.
- Abnahme: Studio mit Wind zeigt ruhiges Schwingen, kein Abreißen zwischen Stamm und Ästen
  (Stammfuß bleibt fest); Bericht mit kurzer Beschreibung, zwei Screenshots im Abstand 1 s.

**P3.6 Nahbereich: 3D-Bäume als Thin Instances**
- Dateien: neu `apps/client/src/game/real/trees/nearTrees.ts`, `apps/client/src/game/real/realWorld.ts`
- `class NearTrees` – `constructor(scene, instances: TreeInstance[], quality, shadow: ShadowGenerator | null)`,
  `update(camera: Vector3)`, `get fade(): { inner: number; outer: number }`, `dispose()`.
  - Für jede Art, die in `instances` vorkommt, und jede Variante 0–2: `generateTree` einmal,
    daraus zwei Meshes (Holz, Laub) mit Thin Instances. Materialien wie im Studio + `WindPlugin`.
  - Räumliches Raster (32 m Zellen) über alle Instanzen. `update`: nur wenn sich die Kamera ≥ 8 m
    bewegt hat; Instanzen im Radius `outer + 15` sammeln, nach Abstand sortieren, die nächsten
    `max` nehmen (Ultra 250, Hoch 120). Ist die Grenze erreicht, wird `outer` auf den Abstand
    des letzten genommenen Baums gesenkt. `inner = outer − 12`. Standard `outer`: Ultra 70, Hoch 50.
  - Matrix je Instanz: Skalierung `height / generierteHöhe`, Drehung `yaw`, Position. Tönung über
    Thin-Instance-Attribut `color` (`thinInstanceRegisterAttribute('color', 4)`).
  - Überblendung: Laub- und Holzmaterial bekommen ein kleines Plugin, das im Fragment-Shader
    `fade = smoothstep(inner, outer, Abstand Kamera–Instanzursprung)` berechnet und verwirft, wenn
    `veloIgn(gl_FragCoord.xy) < fade`. (Billboards verwerfen komplementär, siehe P3.7.)
  - Schatten: wenn `shadow`, beide Meshes in die `renderList` (Laub mit Alpha-Test).
- `realWorld.ts`: nur bei `ultra`/`hoch` anlegen (Instanzen aus `buildVegetation`, siehe P3.7);
  in `update` `nearTrees.update(camera)` und danach `vegetation.setNearFade(camera, nearTrees.fade)`.
  (Die Windzeit läuft im `WindPlugin` von selbst.)
- Abnahme: Screenshots `forest` und `wall` (ultra, hoch): Bäume an der Straße sind 3D mit Ästen,
  Schatten mit Blattstruktur auf der Straße, kein Aufploppen beim Fahren (kurzes Video oder drei
  Screenshots im Abstand von 20 m Fahrt), Konsole ohne Fehler. Dreiecke gesamt im Bericht
  (`scene.getActiveIndices() / 3`).

**P3.7 Fernbereich: gebackene Billboards statt Canvas-Atlas**
- Dateien: `apps/client/src/game/real/vegetation.ts`, `apps/client/src/game/real/textures.ts`
  (nur `treeAtlas` entfernen, wenn nicht mehr benutzt)
- Artwahl ersetzt die vier `TREE`-Typen:
  - Wald, Laub: `mediterranean` → `chestnut`; `central`/`alpine` → `beech`. Nadel: `spruce`,
    über 1500 m mit `flora.larch` `larch` (wie heute).
  - Siedlung/Garten/Park: unter 320 m `cypress` mit `flora.cypress`; `mediterranean` unter 260 m
    zu 8 % `palm`, zu 15 % `oleander`; sonst `plane`.
  - Obstgarten: `mediterranean` → `olive`, sonst `plane` (4–7 m).
  - Gebüsch: `laurel` (bei `central`/`alpine` mit grünerer Tönung).
  - Höhen aus `species.ts` (`height`), weiter gekappt durch die bestehende Regel an der Straße.
- `buildVegetation` gibt `{ meshes: Mesh[]; instances: TreeInstance[]; setNearFade(camera, fade): void }`
  zurück. `realWorld.ts` wird an die neue Rückgabe angepasst (nur die Zeilen mit `trees`).
- Billboards wie bisher zwei gekreuzte Quads, aber Textur/UV aus `bakeImpostors` (Zelle
  `${species}:${variant}`, Breite aus `aspect`), Zellgröße nach Tabelle oben. Material:
  `diffuseTexture = atlas.color`, `bumpTexture = atlas.normal` (Normalen im Kameraraum der
  Bake-Kamera = Tangentenraum des Quads; ggf. `invertNormalMapX/Y` setzen, im Studio prüfen),
  Alpha-Test wie bisher. Die alten künstlichen Vertex-Normalen und die Hell-Dunkel-Verläufe
  (`bottom`/`top`) entfallen, Tönung bleibt als Vertexfarbe.
- `uv2` jedes Billboard-Vertex = Fußpunkt (x, z) des Baums. Plugin im Fragment-Shader: Abstand
  Fußpunkt–Kamera → `fade` wie in P3.6; verwerfen, wenn `veloIgn(gl_FragCoord.xy) >= fade`.
  Ohne Nah-Bäume (Mittel/Niedrig) `inner = outer = 0` → nichts wird verworfen.
- `WindPlugin` mit `VELO_WIND_CARD` an das Billboard-Material (nicht bei Niedrig).
- Stand nach P3.4: `bakeImpostors(scene, species, cell, { bark, leaves })` ist **async**
  (`Promise<ImpostorAtlas>`, wartet auf die Shader) und braucht die geladenen Texturen
  (`bark`/`leaves` mit `invertY = false`, `leaves.hasAlpha = true`). `cells` sind in RTT-UVs
  (v = 0 unten). Der Farbatlas ist vormultipliziert (Hintergrund 0,0,0,0, Laub Alpha 1): im
  Billboard-Plugin bei `CUSTOM_FRAGMENT_UPDATE_DIFFUSE` `baseColor.rgb /= max(baseColor.a, 0.001)`,
  sonst bekommen ferne Bäume dunkle Ränder. `atlas.color.hasAlpha = true` setzen.
- Stand nach P3.7: kein `bumpTexture`. Das `BillboardPlugin` baut die Normale bei
  `CUSTOM_FRAGMENT_BEFORE_LIGHTS` aus `atlas.normal` und dem Kartenrahmen, wobei die Tiefenkomponente
  zur Betrachterseite zeigt (gekreuzte Karten von hinten wären sonst dunkel). Wind der Billboards:
  `WindPlugin` mit `weight: 'colorAlpha'` (Gewicht = Vertex-Alpha, Phase aus uv2 = Fußpunkt).
  `buildVegetation` ist async, das Material bleibt nach `freezeMaterials` aufgetaut (`afterFreeze`).
- Abnahme: Screenshots aller drei Stellen mit `mittel` und `hoch`: Fernwald zeigt Kronen mit Licht-
  und Schattenseite passend zur Sonne, keine dunklen Ränder, Arten unterscheidbar (Zypressen, Palmen
  am Seeufer, Kastanienwald). Ladezeit der Strecke im Bericht (vorher/nachher).

**P3.8 Gras, Blumen und Büsche am Straßenrand**
- Dateien: neu `apps/client/src/game/real/roadsideFlora.ts`, `apps/client/src/game/real/realWorld.ts`
- Platzierung einmal beim Laden entlang `corridor` (Zeilenabstand `ROW_STRIDE`), beide Seiten, nur
  wo `edge[side][row] === EDGE.verge` und nicht `urban[row]`: Abstand zur Fahrbahnkante
  `hw + SHOULDER + 0.2 … 2.8 m`, Dichte Ultra/Hoch 1.4 Büschel pro Meter und Seite, Mittel 0.7.
  Höhe aus `corridor.surface`. Nicht in Wasser, nicht in Gebäuden.
- Büschel = drei gekreuzte Quads (Höhe 0.35–0.7 m, Breite 0.6–1.0 m), Zelle aus `grass.webp`:
  60 % grün, 25 % trocken, 10 % Blumen, 5 % Farn (im Wald: 30 % Farn). Tönung ±10 %.
  Normalen nach oben (0, 1, 0) – Gras wird wie der Boden beleuchtet, keine Seitenschattierung.
- Meshes in 100-m-Stücken, `addLODLevel(80 / 60 / 40, null)` nach Profil. Material Alpha-Test,
  `backFaceCulling = false`, `WindPlugin` mit `VELO_WIND_CARD`. Schatten empfangen ja, werfen nein.
- Büsche (`oleander`, `laurel`) kommen über `vegetation.ts`/P3.7 – hier nichts tun.
- `realWorld.ts`: anlegen außer bei Niedrig, Meshes in die Empfängerliste der Schatten.
- Abnahme: Screenshots `forest`, `descent` (ultra, mittel): Straßenrand zeigt Grasbüschel, im
  Wald Farne, keine schwebenden Büschel an Mauern oder über dem See.

**P3.9 Abnahme Phase 3**
- Vorher/Nachher-Bilder aller drei Stellen mit Ultra, Hoch und Mittel; Nutzer prüft die Bildrate auf
  Laptop und iPad. Wenn es auf Hoch ruckelt: `max`/Radius der Nah-Bäume senken (Werte in
  `nearTrees.ts`), dann Gras-Dichte.
- Ergebnis (gemessen im Wald, 8500 m, ohne V-Sync): Ultra ruckelte (34 ms je Bild statt 10,6 ms vor
  Phase 3). Ursache waren die Schatten der Laubkarten in drei Kaskaden mit 2048² (ohne Nah-Baum-Schatten
  11 ms). Korrektur: Ultra-Schattenkarte 1024², Nah-Bäume Ultra 150 bis 55 m → 14–16 ms an allen
  drei Stellen. Hoch unverändert (8,6 ms).
- Nachtrag (Großer Feldberg, Ultra): dunkle Rechtecke im Himmel und schwarze Bäume. Ursache war SSAO: der
  G-Puffer zeichnete die Billboard-Karten als volle Vierecke (ohne Nah-Ausblendung und Wind). Korrektur:
  Meshes mit `metadata.noAmbientOcclusion` bleiben aus dem G-Puffer (`grading.ts`), die Billboards setzen
  das Flag. Außerdem bekommen die Impostor-RTTs echte Mip-Stufen (`generateMipMaps`). 14,6 ms im Wald.

### Phase 4 – Straßenrand

| ID | Gruppe | Aufgabe | Status |
|---|---|---|---|
| P4.1 | 4A | Leitpfosten alle 50 m außerorts, Begrenzungssteine in Kurven | offen |
| P4.2 | 4A | Felsböschung an steilen Einschnitten (Material + Geometrie-Rauheit) | offen |
| P4.3 | 4B | Blumenkästen/Oleander an Mauern in Orten | offen |
| P4.4 | 4B | Mauerkrone mit Abdecksteinen, bewachsene Mauerfüße | offen |

### Phase 5 – Ferne, Himmel, See

| ID | Gruppe | Aufgabe | Status |
|---|---|---|---|
| P5.1 | 5A | Zweischichtige Wolken mit Lichtrand, Schleierwolken | offen |
| P5.2 | 5A | Schnee und Fels an Gipfeln nach Höhe/Neigung | offen |
| P5.3 | 5B | Seewellen (Normalmap) und Sonnenglitzern | offen |
| P5.4 | 5B | Segelboote und Fähre auf dem See | offen |
| P5.5 | 5C | Dichtere Dörfer: Balkone, Fensterlaibungen, Kamine | offen |

### Phase 6 – Fahrer, Rad, Effekte

| ID | Gruppe | Aufgabe | Status |
|---|---|---|---|
| P6.1 | 6A | Stoff-Detailmap für Trikot/Hose, Glanz der Hose | offen |
| P6.2 | 6A | Haut: weiche Beleuchtung, Muskel-Normalen an Waden/Oberschenkeln | offen |
| P6.3 | 6B | Bewegungsunschärfe bei Tempo (nur Ultra, schwach) | offen |
| P6.4 | 6B | Abschluss-Vergleich mit dem Referenzbild | offen |

Phasen 4–6 werden wie Phase 3 vor dem Start detailliert.

---

## 3. Startprompt für einen Haiku-Agenten (Vorlage)

```
Du arbeitest im Repo /home/user/velo-sim (TypeScript-Monorepo, Babylon.js 9, Vite).
Lies docs/REALISM_PLAN.md, Abschnitt 1 (Regeln) und genau die Aufgabe <ID>.
Führe nur diese Aufgabe aus. Halte dich strikt an die Regeln aus Abschnitt 1.
Melde am Ende: geänderte Dateien, Ergebnis von type-check/test/build, Screenshot-Pfade, offene Punkte.
```
