/**
 * Equipment catalogue. Names allude to real models but are fictional — check
 * trademark law before publishing. All values are game-balance numbers of a
 * realistic magnitude, not measurements. Edit freely: ratings are derived.
 */

export type ItemType = 'bike' | 'wheels' | 'jersey';
export type Tier = 'start' | 'entry' | 'mid' | 'top';
export type BikeCategory = 'aero' | 'allround' | 'climber' | 'endurance';
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

export interface BikeItem extends BaseItem {
  type: 'bike';
  category: BikeCategory;
  /** Frame + components without wheels. */
  weightKg: number;
  look: { frame: string; accent: string };
}

export interface WheelsItem extends BaseItem {
  type: 'wheels';
  rimDepthMm: number;
  /** Pair of wheels incl. tyres. */
  weightKg: number;
  look: { rim: string };
}

export interface JerseyItem extends BaseItem {
  type: 'jersey';
  cut: JerseyCut;
  look: { jersey: string; accent: string; helmet: string };
}

export type EquipmentItem = BikeItem | WheelsItem | JerseyItem;

export const TIER_LABEL: Record<Tier, string> = { start: 'Start', entry: 'Einsteiger', mid: 'Mittelklasse', top: 'Oberklasse' };
export const CATEGORY_LABEL: Record<BikeCategory, string> = { aero: 'Aero', allround: 'Allround', climber: 'Kletterrad', endurance: 'Endurance' };
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
  inspiredBy?: string,
): BikeItem => ({ id, type: 'bike', brand, model, tier, category, cdaDelta, weightKg, price, look: { frame, accent }, inspiredBy });

export const BIKES: BikeItem[] = [
  // Oberklasse
  bike('bike-servelo-a5', 'Servelo', 'A5', 'top', 'aero', -0.015, 6.0, 125_000, '#111111', '#e10600', 'Cervélo S5'),
  bike('bike-treck-madena', 'Treck', 'Madena SLR', 'top', 'aero', -0.014, 5.9, 120_000, '#2b1b4f', '#c0c0c0', 'Trek Madone'),
  bike('bike-kanyon-aerodo', 'Kanyon', 'Aerodo CFR', 'top', 'aero', -0.013, 5.8, 105_000, '#1d2b3a', '#00b3ff', 'Canyon Aeroad'),
  bike('bike-pinarolo-dogmo', 'Pinarolo', 'Dogmo X', 'top', 'allround', -0.011, 5.6, 130_000, '#0a0a0a', '#d4af37', 'Pinarello Dogma F'),
  bike('bike-spezion-tarmo-sl8', 'Spezion', 'Z-Works Tarmo SL8', 'top', 'allround', -0.01, 5.4, 115_000, '#7a0019', '#f2f2f2', 'S-Works Tarmac'),
  bike('bike-kanyon-ultimo', 'Kanyon', 'Ultimo CFR', 'top', 'climber', -0.004, 4.9, 100_000, '#f2f2f2', '#222222', 'Canyon Ultimate'),
  // Mittelklasse
  bike('bike-gigant-propulse', 'Gigant', 'Propulse Advanced', 'mid', 'aero', -0.008, 6.9, 26_000, '#0b3d91', '#ffffff', 'Giant Propel'),
  bike('bike-spezion-tarmo-sl7', 'Spezion', 'Tarmo SL7 Comp', 'mid', 'allround', -0.006, 6.6, 32_000, '#2f4f4f', '#ff6a00', 'Tarmac Comp'),
  bike('bike-cannonvale-supersechs', 'Cannonvale', 'SuperSechs Evo', 'mid', 'allround', -0.005, 6.5, 30_000, '#3a5f0b', '#ffffff', 'SuperSix EVO'),
  bike('bike-treck-emondo', 'Treck', 'Emondo SL6', 'mid', 'climber', -0.001, 6.3, 28_000, '#8b0000', '#000000', 'Trek Émonda'),
  // Einsteiger
  bike('bike-kanyon-endurio', 'Kanyon', 'Endurio AL 6', 'entry', 'endurance', 0.009, 7.9, 6_000, '#556b2f', '#f0e68c', 'Canyon Endurace AL'),
  bike('bike-spezion-allora', 'Spezion', 'Allora Sport', 'entry', 'allround', 0.01, 8.0, 5_000, '#c41e3a', '#ffffff', 'Specialized Allez'),
  bike('bike-gigant-kontend', 'Gigant', 'Kontend AR', 'entry', 'endurance', 0.012, 8.2, 4_500, '#4682b4', '#ffffff', 'Giant Contend'),
  bike('bike-treck-domano', 'Treck', 'Domano AL 2', 'entry', 'endurance', 0.012, 8.4, 4_000, '#708090', '#ffcc00', 'Trek Domane AL'),
  bike('bike-basis', 'Velo', 'Basis', 'start', 'allround', 0.014, 8.6, 0, '#20232a', '#ff7a1a'),
];

const wheels = (
  id: string,
  brand: string,
  model: string,
  tier: Tier,
  rimDepthMm: number,
  cdaDelta: number,
  weightKg: number,
  price: number,
  rim: string,
  inspiredBy?: string,
): WheelsItem => ({ id, type: 'wheels', brand, model, tier, rimDepthMm, cdaDelta, weightKg, price, look: { rim }, inspiredBy });

export const WHEELS: WheelsItem[] = [
  wheels('wheels-basis', 'Velo', 'Basis Alu', 'start', 22, 0.008, 2.0, 0, '#3a3d42'),
  wheels('wheels-fulkrum-r5', 'Fulkrum', 'Racing 5', 'entry', 25, 0.005, 1.65, 3_000, '#202020', 'Fulcrum Racing'),
  wheels('wheels-mavik-kosmik45', 'Mavik', 'Kosmik 45', 'mid', 45, -0.001, 1.5, 18_000, '#e8c400', 'Mavic Cosmic'),
  wheels('wheels-dsswiss-ark35', 'DS Swiss', 'ARK Climb 35', 'top', 35, 0.002, 1.25, 30_000, '#d10000', 'DT Swiss'),
  wheels('wheels-rojal-rapido50', 'Rojal', 'Rapido 50', 'top', 50, -0.003, 1.4, 45_000, '#d9d9d9', 'Roval Rapide'),
  wheels('wheels-zapp-440', 'Zapp', '440', 'top', 58, -0.005, 1.55, 50_000, '#f5f5f5', 'Zipp 404'),
  wheels('wheels-envi-65', 'Envi', '6.5', 'top', 65, -0.006, 1.6, 60_000, '#9aa0a6', 'ENVE SES'),
];

const jersey = (
  id: string,
  model: string,
  cut: JerseyCut,
  cdaDelta: number,
  price: number,
  tier: Tier,
  jerseyColor: string,
  accent: string,
  helmet: string,
): JerseyItem => ({ id, type: 'jersey', brand: 'Velo', model, tier, cut, cdaDelta, price, look: { jersey: jerseyColor, accent, helmet } });

export const JERSEYS: JerseyItem[] = [
  jersey('jersey-club-orange', 'Club Orange', 'club', 0.003, 0, 'start', '#ff7a1a', '#20232a', '#ffffff'),
  jersey('jersey-club-blau', 'Club Blau', 'club', 0.003, 600, 'entry', '#2e7dd7', '#ffffff', '#2e7dd7'),
  jersey('jersey-retro-wolle', 'Retro Wolle', 'retro', 0.005, 1_500, 'entry', '#a4161a', '#f5f3f4', '#f5f3f4'),
  jersey('jersey-retro-bianchi', 'Retro Himmelblau', 'retro', 0.005, 1_500, 'entry', '#7fd1c7', '#111111', '#111111'),
  jersey('jersey-standard-schwarz', 'Standard Schwarz', 'standard', 0, 2_000, 'mid', '#1b1b1f', '#ff7a1a', '#1b1b1f'),
  jersey('jersey-standard-gruen', 'Standard Waldgrün', 'standard', 0, 2_500, 'mid', '#2d6a4f', '#d8f3dc', '#ffffff'),
  jersey('jersey-standard-gelb', 'Standard Leader', 'standard', 0, 4_000, 'mid', '#ffd60a', '#000000', '#ffd60a'),
  jersey('jersey-racefit-weiss', 'Race-Fit Weiß', 'racefit', -0.002, 6_000, 'top', '#f8f9fa', '#e63946', '#f8f9fa'),
  jersey('jersey-racefit-polka', 'Race-Fit Bergkönig', 'racefit', -0.002, 9_000, 'top', '#ffffff', '#d00000', '#d00000'),
  jersey('jersey-skinsuit-carbon', 'Skinsuit Carbon', 'skinsuit', -0.004, 12_000, 'top', '#2b2d42', '#8d99ae', '#2b2d42'),
  jersey('jersey-skinsuit-regenbogen', 'Skinsuit Regenbogen', 'skinsuit', -0.004, 15_000, 'top', '#f1f1f1', '#3a86ff', '#f1f1f1'),
];

export const CATALOG: EquipmentItem[] = [...BIKES, ...WHEELS, ...JERSEYS];

export const STARTER_LOADOUT = { bike: 'bike-basis', wheels: 'wheels-basis', jersey: 'jersey-club-orange' } as const;

export function getItem(id: string): EquipmentItem | undefined {
  return CATALOG.find((i) => i.id === id);
}

export function itemName(item: EquipmentItem): string {
  return item.type === 'jersey' ? item.model : `${item.brand} ${item.model}`;
}
