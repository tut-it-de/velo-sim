/**
 * Equipment catalogue. Names allude to real models but are fictional — check
 * trademark law before publishing. All values are game-balance numbers of a
 * realistic magnitude, not measurements. Edit freely: ratings are derived.
 */

export type ItemType = 'bike' | 'wheels' | 'jersey' | 'helmet';
export type Tier = 'start' | 'entry' | 'mid' | 'top';
export type BikeCategory = 'aero' | 'allround' | 'climber' | 'endurance' | 'recumbent' | 'trike' | 'unicycle';
export type JerseyCut = 'club' | 'retro' | 'standard' | 'racefit' | 'skinsuit';

interface BaseItem {
  id: string;
  type: ItemType;
  brand: string;
  model: string;
  tier: Tier;
  /** Change of CdA in m² relative to the neutral reference (negative = faster). */
  cdaDelta: number;
  price: number;
  /** Real-world inspiration, shown as a hint in the shop. */
  inspiredBy?: string;
}

/**
 * How a frame is built, so each brand looks like itself (see apps/client/src/game/avatar/bike.ts):
 * - `material`: `carbon` (lacquered, smooth junctions) or `alu` (round tubes, weld beads, satin paint)
 * - `tubes`: cross-section of the main tubes: `round`, `squircle` (rounded square) or `aero` (deep truncated foil)
 * - `slope`: how far the top tube drops towards the seat (m); the seat post shows more of itself
 * - `stays`: seat stays meeting the seat tube `high`, `dropped` well below the top tube, or `wave` (curved)
 * - `fork`: `straight` blades or `wave` (curved, like Pinarello's Onda)
 * - `cockpit`: `classic` stem and round bar, `integrated` one-piece aero bar, `vstem` split stem
 * - `seatpost`: `round`, `aero` or `mast` (integrated seat mast with a cap)
 * - `window`: a rear extension of the top tube around an opening behind the seat tube
 * - `paint`: `solid` frame colour with accent lettering, `fade` frame colour into the accent towards
 *   the rear, `split` front triangle in the frame colour and rear triangle and fork in the accent
 */
export interface FrameBuild {
  material: 'carbon' | 'alu';
  tubes: 'round' | 'squircle' | 'aero';
  slope: number;
  stays: 'high' | 'dropped' | 'wave';
  fork: 'straight' | 'wave';
  cockpit: 'classic' | 'integrated' | 'vstem';
  seatpost: 'round' | 'aero' | 'mast';
  window?: boolean;
  paint: 'solid' | 'fade' | 'split';
}

export interface BikeItem extends BaseItem {
  type: 'bike';
  category: BikeCategory;
  /** Frame + components without wheels. */
  weightKg: number;
  look: { frame: string; accent: string; build: FrameBuild };
}

/** Rim surface: anodised alloy, matte unidirectional carbon or glossy carbon. */
export type RimFinish = 'alu' | 'carbon' | 'gloss';
/**
 * Rim decal, painted onto both sidewalls (see apps/client/src/game/avatar/wheelArt.ts):
 * `block` heavy upright letters, `outline` open outlined letters, `italic` slanted letters with a
 * speed stripe, `tonal` small, barely contrasting letters on matte carbon, `stripe` letters on a band.
 */
export interface RimDecal {
  text: string;
  /** Model line next to the wordmark (smaller). */
  sub: string;
  color: string;
  accent: string;
  style: 'block' | 'outline' | 'italic' | 'tonal' | 'stripe';
  /** Wordmarks per side around the rim. */
  count: number;
}

export interface WheelsItem extends BaseItem {
  type: 'wheels';
  rimDepthMm: number;
  /** Pair of wheels incl. tyres. */
  weightKg: number;
  look: { rim: string; finish: RimFinish; decal: RimDecal; hub: string; spoke: string };
}

/**
 * Print of a jersey (see apps/client/src/game/avatar/jerseyArt.ts). `colors` are base, second and
 * trim colour; what each one paints depends on the pattern:
 * - `block`: base with darker side panels, collar and sleeve cuffs in the trim colour
 * - `band`: base with a chest band in the second colour, pinstripes in trim
 * - `retro`: wool look, two chest stripes and collar in the second colour, cuffs in trim
 * - `halftone`: dots of the second colour, large at the hem, fading out towards the chest
 * - `topo`: contour lines of an imaginary map in the second colour
 * - `gradient`: base at the shoulders blending into the second colour at the hem
 * - `polka`: dots of the second colour on the base (mountain jersey)
 * - `fragment`: angular shards in the second and trim colour over the base
 * - `rainbow`: five world-champion bands across the chest
 * - `split`: diagonal split, upper part base, lower part second colour, trim line between
 * - `n69n`: the Null 69 Normalized team kit – black, globe emblems and lettering in the second
 *   colour (pink) and trim (white), sponsor on the sleeves
 */
export type JerseyPattern =
  | 'block'
  | 'band'
  | 'retro'
  | 'halftone'
  | 'topo'
  | 'gradient'
  | 'polka'
  | 'fragment'
  | 'rainbow'
  | 'split'
  | 'athletic'
  | 'tonal'
  | 'stamps'
  | 'base'
  | 'athletic3'
  | 'n69n';

export interface JerseyDesign {
  pattern: JerseyPattern;
  colors: [string, string, string];
  /** Colour of the chest and back wordmark. */
  logo: string;
  /** Brand lettering on the jersey; VELO when absent. */
  mark?: string;
  /** Long sleeves down to the wrist (the print's sleeve strip then covers the whole arm). */
  longSleeve?: boolean;
}

export interface JerseyItem extends BaseItem {
  type: 'jersey';
  cut: JerseyCut;
  look: { jersey: string; accent: string; helmet: string; design: JerseyDesign };
}

/**
 * Helmet shell (see apps/client/src/game/avatar/helmets.ts):
 * - `road`: classic vented road helmet, many long vents front to back
 * - `aero`: aero road helmet, closed rounded shell with a few small vents and a short tail
 * - `tt`: time-trial helmet, long teardrop tail down onto the back, wrap-around visor
 * - `retro`: 80s leather hairnet, padded strips over a bare head
 * - `mtb`: trail helmet with a peak (visor) over the eyes, deep at the back
 * - `bubble`: smooth, round commuter shell without vents (skate style)
 * - `space`: futuristic time-trial helmet: oversized sculpted shell with fins, a full-face mirrored visor
 *   down to the chin like a motorbike helmet (the much-talked-about 2024 pro team prototypes)
 */
export type HelmetShape = 'road' | 'aero' | 'tt' | 'retro' | 'mtb' | 'bubble' | 'space';

export interface HelmetItem extends BaseItem {
  type: 'helmet';
  weightKg: number;
  /** shell = main colour, accent = stripes/details, vents = colour seen through the vents (usually dark). */
  look: { shape: HelmetShape; shell: string; accent: string; vents: string };
}

export type EquipmentItem = BikeItem | WheelsItem | JerseyItem | HelmetItem;

export const HELMET_LABEL: Record<HelmetShape, string> = { road: 'Straßenhelm', aero: 'Aero-Helm', tt: 'Zeitfahrhelm', retro: 'Retro-Haarnetz', mtb: 'Trail-Helm', bubble: 'Stadthelm', space: 'Zeitfahr-Prototyp' };
export const TIER_LABEL: Record<Tier, string> = { start: 'Start', entry: 'Einsteiger', mid: 'Mittelklasse', top: 'Oberklasse' };
export const CATEGORY_LABEL: Record<BikeCategory, string> = { aero: 'Aero', allround: 'Allround', climber: 'Kletterrad', endurance: 'Endurance', recumbent: 'Liegerad', trike: 'Dreirad', unicycle: 'Einrad' };
export const CUT_LABEL: Record<JerseyCut, string> = {
  club: 'Club-Fit (locker)',
  retro: 'Retro-Wolltrikot',
  standard: 'Standard',
  racefit: 'Race-Fit Aero',
  skinsuit: 'Skinsuit',
};

const bike = (
  id: string,
  brand: string,
  model: string,
  tier: Tier,
  category: BikeCategory,
  cdaDelta: number,
  weightKg: number,
  price: number,
  frame: string,
  accent: string,
  build: FrameBuild,
  inspiredBy?: string,
): BikeItem => ({ id, type: 'bike', brand, model, tier, category, cdaDelta, weightKg, price, look: { frame, accent, build }, inspiredBy });

/** Frame builds; a brand's bikes share a family look. */
const B = (b: Partial<FrameBuild>): FrameBuild => ({
  material: 'carbon',
  tubes: 'squircle',
  slope: 0.03,
  stays: 'dropped',
  fork: 'straight',
  cockpit: 'classic',
  seatpost: 'round',
  paint: 'solid',
  ...b,
});
const ALU = (b: Partial<FrameBuild>) => B({ material: 'alu', tubes: 'round', stays: 'high', ...b });

export const BIKES: BikeItem[] = [
  // Oberklasse
  bike('bike-servelo-a5', 'Servelo', 'A5', 'top', 'aero', -0.015, 6.0, 125_000, '#111111', '#e10600',
    B({ tubes: 'aero', slope: 0.05, cockpit: 'vstem', seatpost: 'aero' }), 'Cervélo S5'),
  bike('bike-treck-madena', 'Treck', 'Madena SLR', 'top', 'aero', -0.014, 5.9, 120_000, '#2b1b4f', '#c0c0c0',
    B({ tubes: 'aero', slope: 0.04, cockpit: 'integrated', seatpost: 'aero', window: true, paint: 'fade' }), 'Trek Madone'),
  bike('bike-kanyon-aerodo', 'Kanyon', 'Aerodo CFR', 'top', 'aero', -0.013, 5.8, 105_000, '#1d2b3a', '#00b3ff',
    B({ tubes: 'aero', slope: 0.06, cockpit: 'integrated', seatpost: 'aero', paint: 'fade' }), 'Canyon Aeroad'),
  bike('bike-pinarolo-dogmo', 'Pinarolo', 'Dogmo X', 'top', 'allround', -0.011, 5.6, 130_000, '#0a0a0a', '#d4af37',
    B({ stays: 'wave', fork: 'wave', cockpit: 'integrated', seatpost: 'aero', slope: 0.05 }), 'Pinarello Dogma F'),
  bike('bike-spezion-tarmo-sl8', 'Spezion', 'Z-Works Tarmo SL8', 'top', 'allround', -0.01, 5.4, 115_000, '#7a0019', '#f2f2f2',
    B({ cockpit: 'integrated', slope: 0.07, paint: 'split' }), 'S-Works Tarmac'),
  bike('bike-kanyon-ultimo', 'Kanyon', 'Ultimo CFR', 'top', 'climber', -0.004, 4.9, 100_000, '#f2f2f2', '#222222',
    B({ tubes: 'round', stays: 'high', slope: 0.04, cockpit: 'integrated', paint: 'fade' }), 'Canyon Ultimate'),
  // Liegerad: Hochlieger mit Untenlenker, liegend kaum Stirnfläche
  bike('bike-m6-hochracer', 'M6', 'Carbon Hochracer', 'top', 'recumbent', -0.05, 8.4, 95_000, '#15171b', '#ff5a1f',
    B({ tubes: 'round', stays: 'high', paint: 'solid' }), 'M5 Carbon High Racer'),
  // Mittelklasse
  bike('bike-gigant-propulse', 'Gigant', 'Propulse Advanced', 'mid', 'aero', -0.008, 6.9, 26_000, '#0b3d91', '#ffffff',
    B({ tubes: 'aero', slope: 0.11, cockpit: 'integrated', seatpost: 'aero', paint: 'fade' }), 'Giant Propel'),
  bike('bike-spezion-tarmo-sl7', 'Spezion', 'Tarmo SL7 Comp', 'mid', 'allround', -0.006, 6.6, 32_000, '#2f4f4f', '#ff6a00',
    B({ slope: 0.07, paint: 'split' }), 'Tarmac Comp'),
  bike('bike-cannonvale-supersechs', 'Cannonvale', 'SuperSechs Evo', 'mid', 'allround', -0.005, 6.5, 30_000, '#3a5f0b', '#ffffff',
    B({ tubes: 'round', slope: 0.05 }), 'SuperSix EVO'),
  bike('bike-treck-emondo', 'Treck', 'Emondo SL6', 'mid', 'climber', -0.001, 6.3, 28_000, '#8b0000', '#000000',
    B({ tubes: 'round', stays: 'high', slope: 0.03, seatpost: 'mast' }), 'Trek Émonda'),
  // Dreirad: Rennrad-Front, zwei Hinterräder auf angetriebener Achse; etwas schwerer, das dritte Rad bremst kaum
  bike('bike-trivelo-sprint', 'Trivelo', 'Sprint Tri', 'mid', 'trike', 0.004, 9.4, 24_000, '#0e4d45', '#f2c230',
    B({ tubes: 'round', stays: 'high', slope: 0.03 }), 'Rennsport-Dreiräder (Higgins, Ken Rogers)'),
  // Einrad: 36" mit 1,5:1-Getriebenabe und T-Lenker – im Spiel so schnell wie ein Mittelklasse-Rennrad
  bike('bike-nimbo-orakel', 'Nimbo', 'Orakel 36 Geared', 'mid', 'unicycle', 0.006, 7.6, 22_000, '#c8102e', '#f4f4f4',
    B({ tubes: 'round', stays: 'high' }), 'Nimbus Oracle 36" mit Schlumpf-Nabe'),
  // Einsteiger
  bike('bike-kanyon-endurio', 'Kanyon', 'Endurio AL 6', 'entry', 'endurance', 0.009, 7.9, 6_000, '#556b2f', '#f0e68c', ALU({ slope: 0.06 }), 'Canyon Endurace AL'),
  bike('bike-spezion-allora', 'Spezion', 'Allora Sport', 'entry', 'allround', 0.01, 8.0, 5_000, '#c41e3a', '#ffffff', ALU({ slope: 0.04, paint: 'split' }), 'Specialized Allez'),
  bike('bike-gigant-kontend', 'Gigant', 'Kontend AR', 'entry', 'endurance', 0.012, 8.2, 4_500, '#4682b4', '#ffffff', ALU({ slope: 0.12 }), 'Giant Contend'),
  bike('bike-treck-domano', 'Treck', 'Domano AL 2', 'entry', 'endurance', 0.012, 8.4, 4_000, '#708090', '#ffcc00', ALU({ slope: 0.05, stays: 'dropped' }), 'Trek Domane AL'),
  bike('bike-basis', 'Velo', 'Basis', 'start', 'allround', 0.014, 8.6, 0, '#20232a', '#ff7a1a', ALU({ slope: 0.02 })),
];

const decal = (text: string, sub: string, color: string, accent: string, style: RimDecal['style'], count = 2): RimDecal => ({ text, sub, color, accent, style, count });

const wheels = (
  id: string,
  brand: string,
  model: string,
  tier: Tier,
  rimDepthMm: number,
  cdaDelta: number,
  weightKg: number,
  price: number,
  look: WheelsItem['look'],
  inspiredBy?: string,
): WheelsItem => ({ id, type: 'wheels', brand, model, tier, rimDepthMm, cdaDelta, weightKg, price, look, inspiredBy });

export const WHEELS: WheelsItem[] = [
  wheels('wheels-basis', 'Velo', 'Basis Alu', 'start', 22, 0.008, 2.0, 0, {
    rim: '#2b2e33', finish: 'alu', hub: '#2b2e33', spoke: '#1a1a1a', decal: decal('VELO', 'BASIS', '#c9ccd1', '#ff7a1a', 'block', 2),
  }),
  wheels('wheels-fulkrum-r5', 'Fulkrum', 'Racing 5', 'entry', 25, 0.005, 1.65, 3_000, {
    rim: '#1c1c1e', finish: 'alu', hub: '#1c1c1e', spoke: '#141414', decal: decal('FULKRUM', 'RACING 5', '#f2f2f2', '#d62828', 'italic', 2),
  }, 'Fulcrum Racing'),
  wheels('wheels-mavik-kosmik45', 'Mavik', 'Kosmik 45', 'mid', 45, -0.001, 1.5, 18_000, {
    rim: '#151517', finish: 'carbon', hub: '#151517', spoke: '#111111', decal: decal('MAVIK', 'KOSMIK SLR 45', '#ffffff', '#ffd400', 'stripe', 2),
  }, 'Mavic Cosmic'),
  wheels('wheels-dsswiss-ark35', 'DS Swiss', 'ARK Climb 35', 'top', 35, 0.002, 1.25, 30_000, {
    rim: '#141416', finish: 'carbon', hub: '#141416', spoke: '#101010', decal: decal('DS SWISS', 'ARK 1100 DICUT 35', '#ffffff', '#e30613', 'block', 2),
  }, 'DT Swiss'),
  wheels('wheels-rojal-rapido50', 'Rojal', 'Rapido 50', 'top', 50, -0.003, 1.4, 45_000, {
    rim: '#101012', finish: 'gloss', hub: '#101012', spoke: '#0e0e0e', decal: decal('ROJAL', 'RAPIDO CLX', '#ffffff', '#9a9a9a', 'block', 2),
  }, 'Roval Rapide'),
  wheels('wheels-zapp-440', 'Zapp', '440', 'top', 58, -0.005, 1.55, 50_000, {
    rim: '#121214', finish: 'carbon', hub: '#121214', spoke: '#0f0f0f', decal: decal('ZAPP', '440 FIRECREST', '#ffffff', '#c8c8c8', 'outline', 2),
  }, 'Zipp 404'),
  wheels('wheels-envi-65', 'Envi', '6.5', 'top', 65, -0.006, 1.6, 60_000, {
    rim: '#18181a', finish: 'carbon', hub: '#18181a', spoke: '#121212', decal: decal('ENVI', 'SES 6.5', '#6f7378', '#9da2a8', 'tonal', 3),
  }, 'ENVE SES'),
];

const jersey = (
  id: string,
  model: string,
  cut: JerseyCut,
  cdaDelta: number,
  price: number,
  tier: Tier,
  pattern: JerseyPattern,
  colors: [string, string, string],
  logo: string,
  helmet: string,
  inspiredBy?: string,
  brand = 'Velo',
): JerseyItem => ({
  id,
  type: 'jersey',
  brand,
  model,
  tier,
  cut,
  cdaDelta,
  price,
  // jersey/accent stay as the two main colours (swatches, bots, older clients)
  look: { jersey: colors[0], accent: colors[1], helmet, design: brand === 'Velo' ? { pattern, colors, logo } : { pattern, colors, logo, mark: brand.toUpperCase() } },
  inspiredBy,
});

/** NAAP: the house's take on MAAP's kits, from the Training basics to the Pro Air race jersey. */
const naap = (...args: Parameters<typeof jersey>): JerseyItem => {
  const [id, model, cut, cda, price, tier, pattern, colors, logo, helmet, inspiredBy] = args;
  return jersey(id, model, cut, cda, price, tier, pattern, colors, logo, helmet, inspiredBy, 'NAAP');
};

const longSleeve = (item: JerseyItem): JerseyItem => ({ ...item, look: { ...item.look, design: { ...item.look.design, longSleeve: true } } });

export const JERSEYS: JerseyItem[] = [
  jersey('jersey-club-orange', 'Club Orange', 'club', 0.003, 0, 'start', 'block', ['#ff6b1a', '#24262c', '#24262c'], '#ffffff', '#ffffff'),
  jersey('jersey-club-blau', 'Club Blau', 'club', 0.003, 600, 'entry', 'band', ['#1f5fa8', '#f4f4f2', '#1f5fa8'], '#f4f4f2', '#1f5fa8'),
  jersey('jersey-retro-wolle', 'Retro Wolle', 'retro', 0.005, 1_500, 'entry', 'retro', ['#9e1b22', '#efe7d6', '#1d1d1d'], '#efe7d6', '#efe7d6'),
  jersey('jersey-retro-bianchi', 'Retro Himmelblau', 'retro', 0.005, 1_500, 'entry', 'retro', ['#7fd1c7', '#111111', '#111111'], '#111111', '#111111'),
  naap('jersey-club-flieder', 'Training Flieder', 'club', 0.003, 1_800, 'entry', 'band', ['#b9a7d6', '#2c2a3a', '#efeaf6'], '#2c2a3a', '#efeaf6', 'MAAP Training'),
  naap('jersey-naap-base', 'Pro Base Antarktis', 'club', 0.003, 2_200, 'entry', 'base', ['#ecebe6', '#1e2a44', '#d9d7d0'], '#1e2a44', '#ecebe6', 'MAAP Evade Pro Base'),
  naap('jersey-standard-schwarz', 'Halftone Nacht', 'standard', 0, 2_000, 'mid', 'halftone', ['#17181c', '#ff6b1a', '#2a2c33'], '#ff6b1a', '#17181c', 'MAAP Halftone'),
  naap('jersey-standard-gruen', 'Topo Salbei', 'standard', 0, 2_500, 'mid', 'topo', ['#7f8f74', '#c9d3bd', '#3e4a3a'], '#eef1ea', '#eef1ea', 'MAAP Adapt'),
  naap('jersey-standard-sand', 'Alt-Road Sand', 'standard', 0, 3_000, 'mid', 'split', ['#d8c8a8', '#4f5a3c', '#1d1d1d'], '#1d1d1d', '#4f5a3c', 'MAAP Alt_Road'),
  naap('jersey-naap-aeon-lavendel', 'Aeon Lavendelgrau', 'standard', 0, 3_500, 'mid', 'tonal', ['#a8a3b9', '#9893aa', '#8c87a0'], '#4a4560', '#a8a3b9', 'MAAP Apex Aeon'),
  naap('jersey-naap-aeon-kobalt', 'Aeon Deep Cobalt', 'standard', 0, 3_500, 'mid', 'tonal', ['#4c4f98', '#43468a', '#3a3d7c'], '#eef0ff', '#4c4f98', 'MAAP Apex Aeon Thermal'),
  jersey('jersey-standard-gelb', 'Standard Leader', 'standard', 0, 4_000, 'mid', 'block', ['#ffd60a', '#141414', '#141414'], '#141414', '#ffd60a'),
  naap('jersey-racefit-weiss', 'Evolve Koralle', 'racefit', -0.002, 6_000, 'top', 'gradient', ['#f6f4f1', '#ff5a4e', '#2b2b2b'], '#2b2b2b', '#f6f4f1', 'MAAP Evolve'),
  naap('jersey-racefit-dusk', 'Evolve Dämmerung', 'racefit', -0.002, 7_500, 'top', 'gradient', ['#c8b6e2', '#1d2a4d', '#f2efe9'], '#f2efe9', '#1d2a4d', 'MAAP Evolve'),
  naap('jersey-naap-beta', 'Pro Aero Beta', 'racefit', -0.002, 8_000, 'top', 'stamps', ['#efeef1', '#5a3ea6', '#c9c6d0'], '#5a3ea6', '#efeef1', 'MAAP Pro Aero'),
  jersey('jersey-racefit-polka', 'Race-Fit Bergkönig', 'racefit', -0.002, 9_000, 'top', 'polka', ['#ffffff', '#d00000', '#d00000'], '#d00000', '#d00000'),
  naap('jersey-naap-athletic-acid', 'Pro Air Acid', 'racefit', -0.003, 10_500, 'top', 'athletic', ['#14171b', '#c8f46c', '#2d7f89'], '#c8f46c', '#14171b', 'MAAP Pro Air Mental Athletic'),
  naap('jersey-naap-athletic-violett', 'Pro Air Violett', 'racefit', -0.003, 10_500, 'top', 'athletic', ['#17161c', '#d6b9ff', '#4a4f5c'], '#d6b9ff', '#17161c', 'MAAP Pro Air Mental Athletic'),
  // Pro Air 3.0: base, accent, third colour (yoke, chest band behind the lettering); the mesh tone is derived from the base
  naap('jersey-naap-proair3-acid', 'Pro Air 3.0 Acid', 'racefit', -0.003, 11_500, 'top', 'athletic3', ['#14181b', '#c4f59c', '#5b2d86'], '#c4f59c', '#14181b', 'MAAP Pro Air Jersey 3.0 Black Acid'),
  longSleeve(naap('jersey-naap-proair3-violett-ls', 'Pro Air 3.0 LS Violett', 'racefit', -0.003, 12_500, 'top', 'athletic3', ['#141416', '#d9b6f4', '#4b1d4a'], '#d9b6f4', '#141416', 'MAAP Pro Air LS Jersey 3.0 Black Violet')),
  naap('jersey-skinsuit-carbon', 'Fragment Navy', 'skinsuit', -0.004, 12_000, 'top', 'fragment', ['#1b2233', '#3c4a66', '#8fa3c2'], '#e9edf3', '#1b2233', 'MAAP Fragment'),
  jersey('jersey-n69n', 'Null 69 Normalized', 'racefit', -0.002, 6_900, 'top', 'n69n', ['#0c0c0e', '#f3c6d8', '#f4f4f4'], '#f4f4f4', '#0c0c0e', undefined, 'N69N'),
  jersey('jersey-skinsuit-regenbogen', 'Skinsuit Regenbogen', 'skinsuit', -0.004, 15_000, 'top', 'rainbow', ['#f7f7f7', '#1d1d1d', '#1d1d1d'], '#1d1d1d', '#f7f7f7'),
];

const helmet = (
  id: string,
  brand: string,
  model: string,
  tier: Tier,
  shape: HelmetShape,
  cdaDelta: number,
  weightKg: number,
  price: number,
  shell: string,
  accent: string,
  vents = '#1a1b1e',
  inspiredBy?: string,
): HelmetItem => ({ id, type: 'helmet', brand, model, tier, cdaDelta, weightKg, price, look: { shape, shell, accent, vents }, inspiredBy });

export const HELMETS: HelmetItem[] = [
  helmet('helmet-basis', 'Velo', 'Basis', 'start', 'road', 0, 0.32, 0, '#f2f2f2', '#ff7a1a'),
  helmet('helmet-bubble-mint', 'Velo', 'Stadt Mint', 'entry', 'bubble', 0.004, 0.42, 600, '#9be3c8', '#ffffff', '#2a2d31'),
  helmet('helmet-retro-leder', 'Velo', 'Leder-Haarnetz 1984', 'entry', 'retro', 0.006, 0.25, 900, '#4a2c1a', '#c79a5b', '#2b1a10'),
  helmet('helmet-mtb-trail', 'Gyro', 'Trail MIPS', 'entry', 'mtb', 0.003, 0.38, 1_400, '#2d3a2f', '#e8b931', '#141414', 'Giro Manifest'),
  helmet('helmet-road-weiss', 'Kask', 'Volare Weiß', 'mid', 'road', -0.001, 0.24, 2_800, '#f5f5f3', '#d6001c', '#1a1b1e', 'Kask Valegro'),
  helmet('helmet-road-rot', 'Specialised', 'Prevailing 3 Rot', 'mid', 'road', -0.001, 0.25, 3_200, '#c4161c', '#111111', '#151515', 'Specialized Prevail'),
  helmet('helmet-aero-schwarz', 'POC', 'Ventral Aero Schwarz', 'top', 'aero', -0.004, 0.27, 6_500, '#141518', '#ff6a13', '#0d0d0f', 'POC Ventral Air'),
  helmet('helmet-aero-orange', 'POC', 'Ventral Aero Fluo', 'top', 'aero', -0.004, 0.27, 6_800, '#ff6a13', '#141518', '#141518', 'POC Ventral Air'),
  helmet('helmet-aero-weiss', 'Specialised', 'Evadi 3 Weiß', 'top', 'aero', -0.005, 0.29, 7_500, '#f4f4f2', '#1d1d1f', '#1d1d1f', 'S-Works Evade 3'),
  helmet('helmet-tt-gold', 'Kask', 'Bambino Gold', 'top', 'tt', -0.012, 0.42, 11_000, '#c9a54a', '#141414', '#141414', 'Kask Bambino Pro'),
  helmet('helmet-space-chrom', 'Lazar', 'Prototyp X-1 Chrom', 'top', 'space', -0.014, 0.5, 15_000, '#d8dde4', '#ff2d6f', '#0b0c10', 'Visma | Lease a Bike TT-Prototyp 2024'),
  helmet('helmet-tt-schwarz', 'Giro', 'Aerohead Schwarz', 'top', 'tt', -0.011, 0.4, 9_500, '#16171a', '#e2e4e8', '#0f0f10', 'Giro Aerohead'),
];

export const CATALOG: EquipmentItem[] = [...BIKES, ...WHEELS, ...JERSEYS, ...HELMETS];

export const STARTER_LOADOUT = { bike: 'bike-basis', wheels: 'wheels-basis', jersey: 'jersey-club-orange', helmet: 'helmet-basis' } as const;

export function getItem(id: string): EquipmentItem | undefined {
  return CATALOG.find((i) => i.id === id);
}

export function itemName(item: EquipmentItem): string {
  return item.type === 'jersey' && item.brand === 'Velo' ? item.model : `${item.brand} ${item.model}`;
}
