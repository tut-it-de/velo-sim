import type { ReactNode } from 'react';

/** Countries offered in the profile, with their German names (ISO 3166-1 alpha-2). */
export const COUNTRIES: Array<{ code: string; name: string }> = [
  { code: 'DE', name: 'Deutschland' },
  { code: 'AT', name: 'Österreich' },
  { code: 'CH', name: 'Schweiz' },
  { code: 'IT', name: 'Italien' },
  { code: 'FR', name: 'Frankreich' },
  { code: 'NL', name: 'Niederlande' },
  { code: 'BE', name: 'Belgien' },
  { code: 'LU', name: 'Luxemburg' },
  { code: 'ES', name: 'Spanien' },
  { code: 'PT', name: 'Portugal' },
  { code: 'GB', name: 'Vereinigtes Königreich' },
  { code: 'IE', name: 'Irland' },
  { code: 'DK', name: 'Dänemark' },
  { code: 'SE', name: 'Schweden' },
  { code: 'NO', name: 'Norwegen' },
  { code: 'FI', name: 'Finnland' },
  { code: 'PL', name: 'Polen' },
  { code: 'CZ', name: 'Tschechien' },
  { code: 'SI', name: 'Slowenien' },
  { code: 'HU', name: 'Ungarn' },
  { code: 'US', name: 'Vereinigte Staaten' },
  { code: 'CA', name: 'Kanada' },
  { code: 'JP', name: 'Japan' },
];

const NAMES = new Map(COUNTRIES.map((c) => [c.code, c.name]));

// All flags are drawn on a 30 × 20 canvas (3:2); coats of arms are left out at this size.
const rows = (...c: string[]) =>
  c.map((fill, i) => <rect key={i} x={0} y={(20 / c.length) * i} width={30} height={20 / c.length + 0.01} fill={fill} />);
const cols = (...c: string[]) =>
  c.map((fill, i) => <rect key={i} x={(30 / c.length) * i} y={0} width={30 / c.length + 0.01} height={20} fill={fill} />);
const nordic = (bg: string, cross: string, inner?: string) => (
  <>
    <rect width={30} height={20} fill={bg} />
    <rect x={8} width={4.5} height={20} fill={cross} />
    <rect y={7.75} width={30} height={4.5} fill={cross} />
    {inner && <rect x={9.25} width={2} height={20} fill={inner} />}
    {inner && <rect y={9} width={30} height={2} fill={inner} />}
  </>
);

const FLAGS: Record<string, ReactNode> = {
  DE: rows('#000', '#dd0000', '#ffce00'),
  AT: rows('#c8102e', '#fff', '#c8102e'),
  NL: rows('#ae1c28', '#fff', '#21468b'),
  LU: rows('#ef3340', '#fff', '#00a3e0'),
  HU: rows('#ce2939', '#fff', '#477050'),
  SI: rows('#fff', '#005ce6', '#ed1c24'),
  PL: rows('#fff', '#dc143c'),
  IT: cols('#009246', '#fff', '#ce2b37'),
  FR: cols('#0055a4', '#fff', '#ef4135'),
  BE: cols('#000', '#fdda24', '#ef3340'),
  IE: cols('#169b62', '#fff', '#ff883e'),
  ES: (
    <>
      <rect width={30} height={20} fill="#aa151b" />
      <rect y={5} width={30} height={10} fill="#f1bf00" />
    </>
  ),
  PT: (
    <>
      <rect width={30} height={20} fill="#ff0000" />
      <rect width={12} height={20} fill="#006600" />
      <circle cx={12} cy={10} r={3.6} fill="#ffcc00" />
    </>
  ),
  CH: (
    <>
      <rect width={30} height={20} fill="#da291c" />
      <rect x={13} y={4} width={4} height={12} fill="#fff" />
      <rect x={9} y={8} width={12} height={4} fill="#fff" />
    </>
  ),
  DK: nordic('#c8102e', '#fff'),
  SE: nordic('#006aa7', '#fecc00'),
  NO: nordic('#ba0c2f', '#fff', '#00205b'),
  FI: nordic('#fff', '#002f6c'),
  CZ: (
    <>
      <rect width={30} height={10} fill="#fff" />
      <rect y={10} width={30} height={10} fill="#d7141a" />
      <polygon points="0,0 15,10 0,20" fill="#11457e" />
    </>
  ),
  GB: (
    <>
      <rect width={30} height={20} fill="#012169" />
      <path d="M0,0 L30,20 M30,0 L0,20" stroke="#fff" strokeWidth={4} />
      <path d="M0,0 L30,20 M30,0 L0,20" stroke="#c8102e" strokeWidth={1.4} />
      <path d="M15,0 V20 M0,10 H30" stroke="#fff" strokeWidth={6} />
      <path d="M15,0 V20 M0,10 H30" stroke="#c8102e" strokeWidth={3.4} />
    </>
  ),
  US: (
    <>
      {Array.from({ length: 13 }, (_, i) => (
        <rect key={i} y={(20 / 13) * i} width={30} height={20 / 13 + 0.01} fill={i % 2 ? '#fff' : '#b22234'} />
      ))}
      <rect width={12} height={(20 / 13) * 7} fill="#3c3b6e" />
    </>
  ),
  CA: (
    <>
      <rect width={30} height={20} fill="#fff" />
      <rect width={7.5} height={20} fill="#d52b1e" />
      <rect x={22.5} width={7.5} height={20} fill="#d52b1e" />
      <polygon points="15,3.5 16.4,6.6 18.6,5.8 17.8,9.8 20.4,8.4 19.8,10.9 21.4,11.6 17.6,13.8 18,15.6 15.5,15.2 15.5,17.5 14.5,17.5 14.5,15.2 12,15.6 12.4,13.8 8.6,11.6 10.2,10.9 9.6,8.4 12.2,9.8 11.4,5.8 13.6,6.6" fill="#d52b1e" />
    </>
  ),
  JP: (
    <>
      <rect width={30} height={20} fill="#fff" />
      <circle cx={15} cy={10} r={6} fill="#bc002d" />
    </>
  ),
};

/**
 * A country flag as inline SVG — emoji flags are not drawn on Windows, so they can't be used.
 * Unknown codes get a neutral badge with the two letters.
 */
export function Flag({ code, size = 18 }: { code?: string; size?: number }) {
  if (!code) return null;
  const c = code.toUpperCase();
  const art = FLAGS[c];
  return (
    <svg className="flag" viewBox="0 0 30 20" width={size} height={(size * 2) / 3} role="img" aria-label={NAMES.get(c) ?? c}>
      <title>{NAMES.get(c) ?? c}</title>
      {art ?? (
        <>
          <rect width={30} height={20} fill="#30363d" />
          <text x={15} y={14.5} textAnchor="middle" fontSize={11} fontWeight={700} fill="#c9d1d9">
            {c}
          </text>
        </>
      )}
    </svg>
  );
}
