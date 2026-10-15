export type RouteStyle = 'coast' | 'hills' | 'alpine';

export type SegmentType = 'sprint' | 'climb' | 'descent';

export interface RouteSegment {
  id: string;
  name: string;
  type: SegmentType;
  startM: number;
  endM: number;
}

export interface RouteDefinition {
  id: string;
  name: string;
  description: string;
  style: RouteStyle;
  /** Exact lap length; the shape is rescaled to it. */
  lengthM: number;
  /** Closed horizontal loop (any scale), interpolated with a periodic Catmull-Rom spline. */
  shape: Array<[number, number]>;
  /** [distance m, elevation m] — linear between keys, loop closes back to the first key. */
  elevation: Array<[number, number]>;
  /** Moving-average window that rounds off the profile (default 120 m). */
  smoothingM?: number;
  segments: RouteSegment[];
}
