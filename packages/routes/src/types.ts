export type RouteStyle = 'coast' | 'hills' | 'alpine' | 'lake';

export type SegmentType = 'sprint' | 'climb' | 'descent';

export interface RouteSegment {
  id: string;
  name: string;
  type: SegmentType;
  startM: number;
  endM: number;
}

/** A real-world lap: closed polyline in local metres (x = east, z = north), evenly spaced. */
export interface RoutePath {
  step: number;
  x: ArrayLike<number>;
  z: ArrayLike<number>;
  /** Elevation above sea level per point. */
  y: ArrayLike<number>;
}

export interface RouteDefinition {
  id: string;
  name: string;
  description: string;
  style: RouteStyle;
  /** Exact lap length; a parametric shape is rescaled to it. */
  lengthM: number;
  /** Closed horizontal loop (any scale), interpolated with a periodic Catmull-Rom spline. */
  shape?: Array<[number, number]>;
  /** [distance m, elevation m] — linear between keys, loop closes back to the first key. */
  elevation?: Array<[number, number]>;
  /** Real-world geometry; replaces `shape` and `elevation`. */
  path?: RoutePath;
  /** Folder under /worlds with terrain, buildings and vegetation for real-world routes. */
  world?: string;
  /** Short facts for the route card, e.g. the region. */
  region?: string;
  /** Moving-average window that rounds off the profile (default 120 m, real-world paths 8 m). */
  smoothingM?: number;
  segments: RouteSegment[];
}
