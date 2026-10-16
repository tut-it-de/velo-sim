# texgen – Texturen offline erzeugen

Erzeugt kachelbare Detail-Maps (1024×1024, WebP) für die Oberflächen der Strecke. Die Bilder
liegen danach in `apps/client/public/textures/` und werden im Client als Babylon-Detail-Map
eingebunden. Die Texturen entstehen komplett aus Rauschfunktionen (eigene Erzeugung, frei nutzbar,
keine externen Vorlagen).

## Voraussetzungen

Python 3.10+, numpy, Pillow (`pip install numpy pillow`)

## Aufruf

Aus dem Repository-Root:

```
python3 tools/texgen/texgen.py <name>      # eine Textur erzeugen
python3 tools/texgen/texgen.py all        # alle registrierten Texturen erzeugen
python3 tools/texgen/texgen.py selftest   # Kachelbarkeit der Rauschfunktionen prüfen
```

Die Ausgabe landet unter `apps/client/public/textures/<name>.webp`. Der Ordner wird bei Bedarf
angelegt. Ein neuer Aufruf überschreibt die vorhandene Datei.

## Kanalbelegung

Jede Detail-Map ist eine RGBA-Textur, 8 Bit pro Kanal. Der neutrale Wert ist 0.5 (128).

| Kanal | Bedeutung |
|---|---|
| R | Helligkeit (Detail-Modulation der Grundfarbe) |
| G | Normale Y |
| B | Rauheit |
| A | Normale X |

## Neue Textur hinzufügen

In `texgen.py` unter dem Kommentar `# --- Generators ---` eine Funktion schreiben und mit
`@generator('<name>')` registrieren. Die Funktion bekommt die Größe `n` und liefert ein
`uint8`-Array der Form `(n, n, 4)`, üblicherweise über `noise.pack_detail(lum, height, rough, strength)`.

Bausteine in `noise.py`, alle kachelbar:

- `fbm(n, octaves, base_freq, seed)` – fraktales Rauschen in [0, 1]
- `voronoi(n, cells, seed)` – Zellrauschen, liefert `(f1, f2, cell_id)`
- `height_to_normal(h, strength)` – Normalen aus einer Höhenkarte
- `pack_detail(lum, height, rough, strength)` – RGBA-Array nach obiger Kanalbelegung
- `save_webp(path, rgba, quality=90)` – Schreiben als WebP

## Selbsttest

`python3 tools/texgen/texgen.py selftest` erzeugt eine Test-Textur in einem temporären Ordner,
prüft die Naht (erste gegen letzte Zeile bzw. Spalte, unter 0.02 und in derselben Größenordnung
wie die Nachbarzeilen im Inneren), lädt die WebP-Datei wieder und löscht sie danach. Ausgabe `OK`.
Eine nicht kachelbare Rampe dient als Gegenprobe und muss den Test scheitern lassen.

Speicherformat: Die Detail-Maps werden verlustfrei als WebP gespeichert. Verlustbehaftetes WebP
(auch q100) verdoppelt den Unterschied über die Kachelnaht ungefähr (ca. 0.03 statt ca. 0.015),
das wäre als feine Linie im Raster sichtbar. Der Selbsttest prüft deshalb auch die wieder geladene Datei.
