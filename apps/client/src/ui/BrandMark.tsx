/** Spokes of the wheel in the mark, as angles in degrees. */
const SPOKES = [0, 60, 120, 180, 240, 300];

/** The WFR mark: a spoked wheel spinning on a trainer roller. */
export function BrandMark({ size = 34 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="17.5" cy="13" r="9.6" fill="none" stroke="var(--accent)" strokeWidth="2.8" />
      {SPOKES.map((a) => (
        <line
          key={a}
          x1="17.5"
          y1="13"
          x2={17.5 + 8.2 * Math.cos(((a + 15) * Math.PI) / 180)}
          y2={13 + 8.2 * Math.sin(((a + 15) * Math.PI) / 180)}
          stroke="var(--accent)"
          strokeWidth="1.3"
          opacity="0.75"
        />
      ))}
      <circle cx="17.5" cy="13" r="2.3" fill="var(--text)" />
      {/* motion lines behind the wheel */}
      <path d="M1.5 9.5h4M0.5 13.5h4.5M1.5 17.5h4" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" />
      <rect x="6.5" y="24.8" width="22" height="4.8" rx="2.4" fill="var(--text)" />
    </svg>
  );
}
