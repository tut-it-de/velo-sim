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
| P1.1 | 1A | Neue Verfolger-Kamera | offen |
| P1.2 | 1A | Tiefe, warme Sonne und Himmelsfarben | offen |
| P1.3 | 1B | Kaskadenschatten (Bäume, Mauern, Häuser) | offen |
| P1.4 | 1B | Filmische Tonwertkurve und Bildstimmung | offen |
| P1.5 | 1C | Umgebungsverdeckung (SSAO) für Ultra | offen |
| P1.6 | 1C | Höhendunst in Tälern | offen |
| P1.7 | 1D | Abnahme-Screenshots Phase 1 | offen |

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
| P2.1 | 2A | Texturgenerator-Grundgerüst | offen |
| P2.2 | 2B | Asphalt-Detailmap | offen |
| P2.3 | 2B | Bruchstein-/Mauer-Detailmap | offen |
| P2.4 | 2B | Putz- und Ziegel-Detailmaps | offen |
| P2.5 | 2B | Fels- und Waldboden-Detailmaps | offen |
| P2.6 | 2C | Detailmaps an Straße, Mauern, Häusern | offen |
| P2.7 | 2C | Detailmaps im Gelände (Weltkoordinaten) | offen |
| P2.8 | 2D | Abnahme-Screenshots Phase 2 | offen |

**P2.1 Texturgenerator-Grundgerüst**
- Dateien (neu): `tools/texgen/texgen.py`, `tools/texgen/noise.py`, `tools/texgen/README.md`
- `noise.py`: kachelbare Bausteine, alle `numpy`, Größe `n` (Standard 1024), Ergebnis `float32` in [0,1]:
  - `fbm(n, octaves, base_freq, seed)` – kachelbares Rauschen über gefiltertes weißes Rauschen im
    Frequenzraum (`np.fft`), damit es nahtlos kachelt.
  - `voronoi(n, cells, seed)` – kachelbar (Abstände mit Wrap-around), liefert `(f1, f2, cell_id)`.
  - `height_to_normal(h, strength)` – Sobel mit `np.roll` (kachelbar), liefert nx, ny in [0,1].
  - `pack_detail(lum, height, rough, strength)` → RGBA-uint8 nach obiger Belegung.
  - `save_webp(path, rgba, quality=90)`.
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
| P3.1 | 3A | Blatt- und Rindentexturen (Python, wie Phase 2) | offen |
| P3.2 | 3A | Prozeduraler Baumgenerator `treeGen.ts` + Studio-Ansicht | offen |
| P3.3 | 3B | Artenparameter (8 Arten) im Studio abstimmen | offen |
| P3.4 | 3C | Impostor-Bake-Seite → Atlas (Farbe + Normale) | offen |
| P3.5 | 3C | Wind-Shader-Plugin | offen |
| P3.6 | 3D | Nahbereich: 3D-Bäume als Thin Instances | offen |
| P3.7 | 3D | Fernbereich: Impostor-Atlas statt Canvas-Atlas | offen |
| P3.8 | 3E | Gras, Blumen und Büsche am Straßenrand | offen |
| P3.9 | 3F | Abnahme-Screenshots + Bildrate | offen |

Detailspezifikation der Phase-3-Aufgaben schreibt der Orchestrator nach Abnahme von Phase 2 in
diese Datei (sie hängt von den Bildraten aus Phase 1 ab: wie viele Schattenwerfer und Dreiecke
das Budget erlaubt). Eckwerte: ≤ 6 000 Dreiecke pro Nah-Baum, ≤ 250 Nah-Bäume sichtbar (Ultra),
≤ 120 (Hoch), Mittel nur Impostors.

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
