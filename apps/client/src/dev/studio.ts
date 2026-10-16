/**
 * Avatar studio (dev page, studio.html): renders the bike and rider from the side, front, top and
 * three-quarter view, or the dimensioned reference drawing they are built from (?mode=blueprint).
 * Query: mode=rider|bike|blueprint, style=aero|allround|climber|endurance, crank=<rad>, rim=<mm>,
 * view=<0…3> (one view only), zoom, ty (target height for zoomed views), tz (shift along the bike).
 */
import {
  Camera,
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  HemisphericLight,
  ImageProcessingConfiguration,
  MeshBuilder,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  UniversalCamera,
  Vector3,
  Viewport,
} from '@babylonjs/core';
import { RiderAvatar, type RiderLook } from '../game/rider';
import { BODY, bikePoints, frameSpec, riderPose, solveJoint, type FrameStyle } from '../game/avatar/geometry';
import { footPitch } from '../game/avatar/cyclist';

const q = new URLSearchParams(location.search);
const mode = q.get('mode') ?? 'rider';
const style = (q.get('style') ?? 'allround') as FrameStyle;
const crank = Number(q.get('crank') ?? 0.9);
const look: RiderLook = {
  frame: q.get('frame') ?? '#b3122e',
  frameAccent: q.get('accent') ?? '#f2f2f2',
  frameStyle: style,
  rim: '#1c1d20',
  rimDepthMm: Number(q.get('rim') ?? 50),
  jersey: q.get('jersey') ?? '#1d4f91',
  jerseyAccent: q.get('jerseyAccent') ?? '#f2c230',
  helmet: '#f4f4f4',
};

type View = { name: string; pos: Vector3; target: Vector3; up?: Vector3; ortho?: number; vp: [number, number, number, number] };
const VIEWS: View[] = [
  { name: 'Seite (Antrieb)', pos: new Vector3(6, 0.8, 0), target: new Vector3(0, 0.8, 0), ortho: 0.88, vp: [0, 0.5, 0.5, 0.5] },
  { name: 'Vorne', pos: new Vector3(0, 0.8, 6), target: new Vector3(0, 0.8, 0), ortho: 0.88, vp: [0.5, 0.5, 0.5, 0.5] },
  { name: 'Oben', pos: new Vector3(0, 6, 0), target: new Vector3(0, 0, 0), up: new Vector3(0, 0, 1), ortho: 0.88, vp: [0, 0, 0.5, 0.5] },
  { name: 'Dreiviertel', pos: new Vector3(2.3, 1.45, 2.4), target: new Vector3(0, 0.7, 0.05), vp: [0.5, 0, 0.5, 0.5] },
];

function studio3d(withRider: boolean): void {
  const canvas = document.createElement('canvas');
  canvas.id = 'c';
  document.body.appendChild(canvas);
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: true });
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.9, 0.91, 0.93, 1);
  scene.imageProcessingConfiguration.toneMappingEnabled = true;
  scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  scene.imageProcessingConfiguration.exposure = 1.25;
  const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.75;
  hemi.groundColor = new Color3(0.35, 0.35, 0.37);
  const sun = new DirectionalLight('sun', new Vector3(-0.45, -1, -0.35), scene);
  sun.position = new Vector3(4, 8, 3);
  sun.intensity = 1.6;
  const ground = MeshBuilder.CreateGround('ground', { width: 8, height: 8 }, scene);
  const gm = new StandardMaterial('g', scene);
  gm.diffuseColor = new Color3(0.82, 0.83, 0.85);
  gm.specularColor = Color3.Black();
  ground.material = gm;
  ground.receiveShadows = true;
  const rider = new RiderAvatar(scene, 'studio', look, withRider);
  rider.setCrankAngle(crank);
  const sg = new ShadowGenerator(2048, sun);
  sg.useBlurExponentialShadowMap = true;
  sg.blurKernel = 16;
  for (const m of rider.bodyMeshes) sg.addShadowCaster(m);
  rider.blob.setEnabled(false);

  const only = q.get('view');
  const zoom = Number(q.get('zoom') ?? 1);
  const views = only === null ? VIEWS : [{ ...VIEWS[Number(only)]!, vp: [0, 0, 1, 1] as View['vp'] }];
  const cams = views.map((view) => {
    let v = view;
    const cam = new UniversalCamera(v.name, v.pos, scene);
    if (v.up) cam.upVector = v.up;
    // tz moves side and front views along the bike (e.g. tz=-0.25 for the hip, 0.3 for the elbow)
    const tz = Number(q.get('tz') ?? 0);
    if (tz && !v.up) {
      cam.position.z += tz;
      v = { ...v, target: v.target.add(new Vector3(0, 0, tz)) };
    }
    const ty = q.get('ty');
    if (ty !== null) {
      const d = Number(ty) - v.target.y;
      if (!v.up) cam.position.y += d;
      cam.setTarget(v.target.add(new Vector3(0, v.up ? 0 : d, 0)));
    } else cam.setTarget(v.target);
    cam.minZ = 0.05;
    cam.fov = 0.55 / zoom;
    cam.viewport = new Viewport(...v.vp);
    if (v.ortho) cam.mode = Camera.ORTHOGRAPHIC_CAMERA;
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = v.name;
    label.style.left = `${v.vp[0] * 100 + 1}%`;
    label.style.top = `${(1 - v.vp[1] - v.vp[3]) * 100 + 1.5}%`;
    document.body.appendChild(label);
    return { cam, v };
  });
  const fit = () => {
    for (const { cam, v } of cams) {
      if (!v.ortho) continue;
      const aspect = (engine.getRenderWidth() * v.vp[2]) / (engine.getRenderHeight() * v.vp[3]);
      const h = (v.ortho * (only === null ? 1 : 0.5)) / zoom;
      cam.orthoTop = h;
      cam.orthoBottom = -h;
      cam.orthoLeft = -h * aspect;
      cam.orthoRight = h * aspect;
    }
  };
  fit();
  scene.activeCameras = cams.map((c) => c.cam);
  engine.runRenderLoop(() => scene.render());
  window.addEventListener('resize', () => {
    engine.resize();
    fit();
  });
  (window as unknown as { __studio: unknown }).__studio = { scene, rider };
}

/** Dimensioned reference drawing (side, front, top) from the same geometry the 3D model uses. */
function blueprint(): void {
  const P = bikePoints(frameSpec(style));
  const spec = P.spec;
  const pose = riderPose(P);
  const W = 1600;
  const H = 1000;
  const s = 330;
  const ink = '#173b6c';
  const dim = '#c0392b';
  const parts: string[] = [];
  const line = (a: [number, number], b: [number, number], w: number, c = ink, extra = '') =>
    parts.push(`<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke="${c}" stroke-width="${w.toFixed(2)}" stroke-linecap="round" ${extra}/>`);
  const circle = (c: [number, number], r: number, w: number, col = ink, fill = 'none') =>
    parts.push(`<circle cx="${c[0].toFixed(1)}" cy="${c[1].toFixed(1)}" r="${r.toFixed(1)}" stroke="${col}" stroke-width="${w}" fill="${fill}"/>`);
  const text = (p: [number, number], t: string, col = ink, size = 13, anchor = 'middle') =>
    parts.push(`<text x="${p[0].toFixed(1)}" y="${p[1].toFixed(1)}" fill="${col}" font-size="${size}" text-anchor="${anchor}" font-family="ui-monospace,monospace">${t}</text>`);
  const dimLine = (a: [number, number], b: [number, number], label: string, off: [number, number]) => {
    const a2: [number, number] = [a[0] + off[0], a[1] + off[1]];
    const b2: [number, number] = [b[0] + off[0], b[1] + off[1]];
    line(a, a2, 0.6, dim, 'stroke-dasharray="3 3"');
    line(b, b2, 0.6, dim, 'stroke-dasharray="3 3"');
    line(a2, b2, 1, dim, 'marker-start="url(#arr)" marker-end="url(#arr)"');
    text([(a2[0] + b2[0]) / 2 + (off[0] !== 0 ? Math.sign(off[0]) * 6 : 0), (a2[1] + b2[1]) / 2 - 5], label, dim, 12, off[0] > 0 ? 'start' : off[0] < 0 ? 'end' : 'middle');
  };
  const mm = (m: number) => `${Math.round(m * 1000)}`;

  // Side view: +z to the right.
  const ox = 430;
  const oy = 660;
  const sv = (p: Vector3): [number, number] => [ox + p.z * s, oy - p.y * s];
  const R = spec.wheelRadius;
  for (const ax of [P.rearAxle, P.frontAxle]) {
    circle(sv(ax), R * s, 2.2);
    circle(sv(ax), (R - spec.tyreWidth) * s, 1);
    circle(sv(ax), (R - spec.tyreWidth - (look.rimDepthMm ?? 50) / 1000) * s, 1);
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const r1 = (R - spec.tyreWidth - (look.rimDepthMm ?? 50) / 1000) * s;
      const c = sv(ax);
      line([c[0] + Math.cos(a) * 9, c[1] + Math.sin(a) * 9], [c[0] + Math.cos(a) * r1, c[1] + Math.sin(a) * r1], 0.4);
    }
    circle(sv(ax), 9, 1.5);
  }
  const tube = (a: Vector3, b: Vector3, d: number) => line(sv(a), sv(b), d * s);
  const k = spec.tubeDepth;
  tube(P.headBottom, P.headTop, 0.046 * Math.sqrt(k));
  tube(P.headTop.subtract(P.steerUp.scale(0.03)), P.seatCluster, 0.034);
  tube(P.bb, P.headBottom.add(P.steerUp.scale(0.03)), 0.048 * k);
  tube(P.bb, P.seatCluster.add(P.seatUp.scale(0.045)), 0.034 * k);
  tube(P.bb, P.rearAxle, 0.03);
  tube(P.seatCluster.subtract(P.seatUp.scale(spec.stayDrop)), P.rearAxle, 0.018);
  tube(P.headBottom, P.frontAxle, 0.03 * Math.sqrt(k));
  tube(P.headTop, P.steererTop, 0.036);
  tube(P.steererTop.subtract(P.steerUp.scale(0.02)), P.barClamp, 0.034);
  tube(P.seatCluster, P.saddleTop.subtract(P.seatUp.scale(0.05)), 0.027);
  line(sv(P.saddleTop.add(new Vector3(0, -0.012, -0.11))), sv(P.saddleTop.add(new Vector3(0, -0.02, 0.16))), 0.035 * s);
  // Drop bar profile.
  const bar = [[0, 0], [0.03, 0.006], [0.065, 0.004], [0.086, -0.006], [0.098, -0.042], [0.086, -0.086], [0.05, -0.114], [0.004, -0.125], [-0.03, -0.121]];
  for (let i = 0; i + 1 < bar.length; i++) line(sv(P.barClamp.add(new Vector3(0, bar[i]![1]!, bar[i]![0]!))), sv(P.barClamp.add(new Vector3(0, bar[i + 1]![1]!, bar[i + 1]![0]!))), 0.025 * s);
  circle(sv(P.bb), 0.105 * s, 1.2);
  circle(sv(P.bb), 0.073 * s, 0.8);
  circle(sv(P.rearAxle), 0.06 * s, 0.8);
  circle(sv(P.rearAxle), 0.022 * s, 0.8);
  // Rider skeleton.
  const bone = '#2d8a4e';
  const r: [number, number][] = [];
  const legAt = (a: number) => {
    const phi = footPitch(a);
    const spindle = new Vector3(0, P.bb.y + Math.cos(a) * spec.crank, P.bb.z + Math.sin(a) * spec.crank);
    const fwd = new Vector3(0, -Math.sin(phi), Math.cos(phi));
    const up = new Vector3(0, Math.cos(phi), Math.sin(phi));
    const ankle = spindle.subtract(fwd.scale(BODY.ankleBack)).add(up.scale(BODY.ankleUp));
    const hip = new Vector3(0, pose.hip.y, pose.hip.z);
    const knee = solveJoint(hip, ankle, BODY.thigh, BODY.shin, new Vector3(0, 0.35, 1));
    return { spindle, ankle, hip, knee, toe: ankle.add(fwd.scale(0.2)).subtract(up.scale(0.05)) };
  };
  const right = legAt(crank);
  line(sv(P.bb), sv(right.spindle), 3, ink);
  const left = legAt(crank + Math.PI);
  for (const [leg, op] of [[left, 0.35], [right, 1]] as const) {
    const st = `opacity="${op}"`;
    line(sv(leg.hip), sv(leg.knee), 3, bone, st);
    line(sv(leg.knee), sv(leg.ankle), 3, bone, st);
    line(sv(leg.ankle), sv(leg.toe), 3, bone, st);
    for (const p of [leg.knee, leg.ankle]) r.push(sv(p));
  }
  const sh = new Vector3(0, pose.shoulder.y, pose.shoulder.z);
  line(sv(right.hip), sv(sh), 3, bone);
  line(sv(sh), sv(new Vector3(0, pose.elbow.y, pose.elbow.z)), 3, bone);
  line(sv(new Vector3(0, pose.elbow.y, pose.elbow.z)), sv(new Vector3(0, pose.wrist.y, pose.wrist.z)), 3, bone);
  line(sv(new Vector3(0, pose.wrist.y, pose.wrist.z)), sv(P.hood), 3, bone);
  line(sv(sh), sv(pose.neck), 3, bone);
  circle(sv(pose.head), 0.1 * s, 2, bone);
  for (const p of [right.hip, sh, pose.elbow, pose.wrist]) r.push(sv(new Vector3(0, p.y, p.z)));
  for (const p of r) circle(p, 3.5, 1, bone, '#fff');
  text([sv(pose.head)[0], sv(pose.head)[1] - 0.12 * s], `Oberkörper ${pose.torsoAngle.toFixed(0)}°`, bone, 12);

  // Dimensions.
  line(sv(P.bb), sv(new Vector3(0, P.headTop.y, P.bb.z)), 0.8, dim, 'stroke-dasharray="4 3"');
  line(sv(new Vector3(0, P.headTop.y, P.bb.z)), sv(P.headTop), 0.8, dim, 'stroke-dasharray="4 3"');
  text(sv(new Vector3(0, P.headTop.y + 0.015, (P.bb.z + P.headTop.z) / 2)), `Reach ${mm(spec.reach)}`, dim, 12);
  text(sv(new Vector3(0, (P.bb.y + P.headTop.y) / 2, P.bb.z - 0.01)), `Stack ${mm(spec.stack)}`, dim, 12, 'end');
  dimLine(sv(new Vector3(0, 0, P.rearAxle.z)), sv(new Vector3(0, 0, P.frontAxle.z)), `Radstand ${mm(P.wheelbase)}`, [0, 40]);
  dimLine(sv(new Vector3(0, P.rearAxle.y, P.rearAxle.z)), sv(new Vector3(0, P.rearAxle.y, P.bb.z)), `Kettenstrebe ${mm(spec.chainstay)}`, [0, 105]);
  text(sv(P.headBottom.add(new Vector3(0, -0.07, 0.07))), `Lenkwinkel ${spec.headAngle}°`, dim, 12, 'start');
  text(sv(P.seatCluster.add(new Vector3(0, -0.2, -0.17))), `Sitzwinkel ${spec.seatAngle}°`, dim, 12, 'end');
  text(sv(P.bb.add(new Vector3(0, -0.06, 0.13))), `Tretlager −${mm(spec.bbDrop)}`, dim, 12, 'start');
  text(sv(P.saddleTop.add(new Vector3(0, 0.035, -0.08))), `Sattelhöhe ${mm(spec.saddleHeight)}`, dim, 12, 'end');
  text(sv(P.frontAxle.add(new Vector3(0, R + 0.04, 0.2))), `700×${mm(spec.tyreWidth)}c · Felge ${look.rimDepthMm} mm`, dim, 12);
  text([ox, 40], `SEITENANSICHT (Antriebsseite) · Rahmen 56 · ${style}`, ink, 15);

  // Front view: rider's right on the left.
  const fx = 1200;
  const fy = 600;
  const fv = (x: number, y: number): [number, number] => [fx - x * s * 0.8, fy - y * s * 0.8];
  const fs = s * 0.8;
  line(fv(0, R * 2), fv(0, 0), spec.tyreWidth * fs, ink);
  line(fv(-spec.barWidth / 2, P.barClamp.y), fv(spec.barWidth / 2, P.barClamp.y), 0.025 * fs);
  for (const sx of [-1, 1]) {
    line(fv((sx * spec.barWidth) / 2, P.barClamp.y), fv((sx * spec.barWidth) / 2, P.barClamp.y - spec.barDrop), 0.025 * fs);
    line(fv(sx * 0.05, P.headBottom.y), fv(sx * 0.053, R), 0.024 * fs);
    line(fv(sx * 0.07, P.bb.y), fv(sx * 0.07, P.bb.y + spec.crank), 0.02 * fs);
    line(fv(sx * 0.075, P.bb.y + spec.crank), fv(sx * 0.14, P.bb.y + spec.crank), 0.016 * fs);
    // Rider outline.
    line(fv(sx * BODY.hipWidth / 2, pose.hip.y), fv(sx * BODY.shoulderWidth / 2, pose.shoulder.y), 3, bone);
    line(fv(sx * BODY.shoulderWidth / 2, pose.shoulder.y), fv(sx * pose.elbow.x, pose.elbow.y), 3, bone);
    line(fv(sx * pose.elbow.x, pose.elbow.y), fv((sx * spec.barWidth) / 2, P.hood.y), 3, bone);
  }
  line(fv(-BODY.shoulderWidth / 2, pose.shoulder.y), fv(BODY.shoulderWidth / 2, pose.shoulder.y), 3, bone);
  circle(fv(0, pose.head.y), 0.08 * fs, 2, bone);
  dimLine(fv(-spec.barWidth / 2, P.barClamp.y), fv(spec.barWidth / 2, P.barClamp.y), `Lenker ${mm(spec.barWidth)}`, [0, -40]);
  dimLine(fv(-0.14, P.bb.y + spec.crank), fv(0.14, P.bb.y + spec.crank), `Q-Faktor 148 · Pedale`, [0, 150]);
  dimLine(fv(-BODY.shoulderWidth / 2, pose.shoulder.y), fv(BODY.shoulderWidth / 2, pose.shoulder.y), `Schultern ${mm(BODY.shoulderWidth)}`, [0, -150]);
  text([fx, 40], 'VORDERANSICHT', ink, 15);

  // Top view: front up, rider's right on the right.
  const tx = 1200;
  const ty = 850;
  const ts = s * 0.55;
  const tv = (x: number, z: number): [number, number] => [tx + x * ts, ty - z * ts];
  line(tv(0, P.rearAxle.z - R), tv(0, P.rearAxle.z + R), spec.tyreWidth * ts);
  line(tv(0, P.frontAxle.z - R), tv(0, P.frontAxle.z + R), spec.tyreWidth * ts);
  line(tv(0, P.bb.z), tv(0, P.headTop.z), 0.04 * ts);
  line(tv(0, P.headTop.z), tv(0, P.barClamp.z), 0.03 * ts);
  line(tv(-spec.barWidth / 2, P.barClamp.z), tv(spec.barWidth / 2, P.barClamp.z), 0.025 * ts);
  for (const sx of [-1, 1]) {
    line(tv((sx * spec.barWidth) / 2, P.barClamp.z), tv((sx * spec.barWidth) / 2, P.barClamp.z + spec.barReach + 0.02), 0.025 * ts);
    line(tv(sx * 0.05, P.bb.z), tv(sx * 0.06, P.rearAxle.z), 0.02 * ts);
    line(tv(sx * 0.075, P.bb.z), tv(sx * 0.14, P.bb.z), 0.03 * ts);
  }
  line(tv(0, P.saddleTop.z - 0.11), tv(0, P.saddleTop.z + 0.16), 0.11 * ts);
  // Rider outline from above.
  const shz = pose.shoulder.z;
  const hpz = pose.hip.z;
  parts.push(`<polygon points="${[tv(-0.17, hpz - 0.06), tv(0.17, hpz - 0.06), tv(BODY.shoulderWidth / 2 + 0.02, shz), tv(-BODY.shoulderWidth / 2 - 0.02, shz)].map((p) => p.join(',')).join(' ')}" fill="none" stroke="${bone}" stroke-width="2.5"/>`);
  for (const sx of [-1, 1]) {
    line(tv((sx * BODY.shoulderWidth) / 2, shz), tv(sx * pose.elbow.x, pose.elbow.z), 3, bone);
    line(tv(sx * pose.elbow.x, pose.elbow.z), tv((sx * spec.barWidth) / 2, P.hood.z), 3, bone);
  }
  circle(tv(0, pose.head.z), 0.085 * ts, 2, bone);
  text([tx, ty - 1.05 * ts], 'DRAUFSICHT', ink, 15);

  // Body proportions table.
  const rows = [
    ['Oberschenkel', BODY.thigh], ['Unterschenkel', BODY.shin], ['Oberkörper', BODY.torso], ['Oberarm', BODY.upperArm], ['Unterarm', BODY.forearm], ['Kurbel', spec.crank], ['Vorbau', spec.stemLength],
  ] as const;
  rows.forEach(([n, val], i) => text([60, 845 + i * 20], `${n.padEnd(14, ' ')} ${mm(val)} mm`, i < 5 ? bone : ink, 13, 'start'));
  text([60, 820], 'FAHRER 1,80 m · Maße', bone, 14, 'start');

  document.body.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="background:#f6f3ea">
    <defs><marker id="arr" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${dim}"/></marker>
    <pattern id="grid" width="${s / 10}" height="${s / 10}" patternUnits="userSpaceOnUse"><path d="M ${s / 10} 0 L 0 0 0 ${s / 10}" fill="none" stroke="#e2dccb" stroke-width="0.6"/></pattern></defs>
    <rect width="100%" height="100%" fill="url(#grid)"/>
    <line x1="40" y1="${oy}" x2="${W - 40}" y2="${oy}" stroke="#b9b09a" stroke-width="1"/>
    ${parts.join('\n')}
  </svg>`;
}

if (mode === 'blueprint') blueprint();
else studio3d(mode !== 'bike');
