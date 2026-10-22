import type { CadenceTarget, TextEvent, Workout, WorkoutStep } from './model';
import { resolveWorkout } from './model';

/**
 * Import/export of Zwift's .zwo workout format (XML). Uses a tiny tokenizer
 * instead of DOMParser so it works in the browser, Electron, iPad and Node tests.
 */

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function encodeEntities(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const src = xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE[\s\S]*?>/gi, '');
  const re = /<\s*(\/?)\s*([A-Za-z_][\w.-]*)([^>]*?)(\/?)\s*>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const parent = stack[stack.length - 1]!;
    if (m[5] !== undefined) {
      parent.text += decodeEntities(m[5]);
      continue;
    }
    const [, closing, name, rawAttrs, selfClosing] = m;
    if (closing) {
      // pop until the matching tag (tolerates sloppy files)
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.name.toLowerCase() === name!.toLowerCase()) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const attrs: Record<string, string> = {};
    const are = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    while ((a = are.exec(rawAttrs ?? ''))) attrs[a[1]!.toLowerCase()] = decodeEntities(a[3] ?? a[4] ?? '');
    const node: XmlNode = { name: name!, attrs, children: [], text: '' };
    parent.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

function find(node: XmlNode, name: string): XmlNode | undefined {
  const lower = name.toLowerCase();
  for (const c of node.children) {
    if (c.name.toLowerCase() === lower) return c;
    const deep = find(c, name);
    if (deep) return deep;
  }
  return undefined;
}

const num = (attrs: Record<string, string>, ...keys: string[]): number | undefined => {
  for (const k of keys) {
    const v = attrs[k.toLowerCase()];
    if (v !== undefined && v !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
};

function cadenceOf(attrs: Record<string, string>, prefix = ''): CadenceTarget | undefined {
  const single = num(attrs, `${prefix}Cadence`);
  const low = num(attrs, `${prefix}CadenceLow`);
  const high = num(attrs, `${prefix}CadenceHigh`);
  if (low !== undefined && high !== undefined) return [low, high];
  return single;
}

export class ZwoError extends Error {
  override name = 'ZwoError';
}

let importCounter = 0;

export function parseZwo(xml: string, id?: string): Workout {
  const root = parseXml(xml);
  const file = find(root, 'workout_file');
  if (!file) throw new ZwoError('Keine gültige .zwo-Datei (workout_file fehlt).');
  const body = find(file, 'workout');
  if (!body) throw new ZwoError('Die Datei enthält keinen <workout>-Block.');
  const text = (n: string) => find(file, n)?.text.trim() ?? '';

  const steps: WorkoutStep[] = [];
  const textEvents: TextEvent[] = [];
  let t = 0;
  for (const el of body.children) {
    const a = el.attrs;
    const tag = el.name.toLowerCase();
    const duration = num(a, 'Duration') ?? 0;
    let length = duration;
    switch (tag) {
      case 'warmup':
      case 'cooldown':
      case 'ramp': {
        const low = num(a, 'PowerLow') ?? 0.5;
        const high = num(a, 'PowerHigh') ?? low;
        // Zwift files are inconsistent about the order for cooldowns; warmups always rise and cooldowns always fall.
        const [start, end] = tag === 'warmup' ? [Math.min(low, high), Math.max(low, high)] : tag === 'cooldown' ? [Math.max(low, high), Math.min(low, high)] : [low, high];
        steps.push({ type: tag, durationS: duration, powerStart: start, powerEnd: end, cadence: cadenceOf(a) });
        break;
      }
      case 'steadystate': {
        const power = num(a, 'Power') ?? ((num(a, 'PowerLow') ?? 0.6) + (num(a, 'PowerHigh') ?? num(a, 'PowerLow') ?? 0.6)) / 2;
        steps.push({ type: 'steady', durationS: duration, power, cadence: cadenceOf(a) });
        break;
      }
      case 'intervalst': {
        const repeat = Math.max(1, Math.round(num(a, 'Repeat') ?? 1));
        const on = { durationS: num(a, 'OnDuration') ?? 60, power: num(a, 'OnPower', 'PowerOnHigh', 'PowerOnLow') ?? 1, cadence: cadenceOf(a) };
        const off = {
          durationS: num(a, 'OffDuration') ?? 60,
          power: num(a, 'OffPower', 'PowerOffLow', 'PowerOffHigh') ?? 0.5,
          cadence: num(a, 'CadenceResting'),
        };
        steps.push({ type: 'intervals', repeat, on, off });
        length = repeat * (on.durationS + off.durationS);
        break;
      }
      case 'freeride':
        steps.push({ type: 'freeride', durationS: duration, cadence: cadenceOf(a) });
        break;
      case 'maxeffort':
        steps.push({ type: 'maxeffort', durationS: duration });
        break;
      case 'textevent':
        // top-level text events use an absolute offset
        if (a.message) textEvents.push({ atS: num(a, 'timeoffset') ?? 0, message: a.message, durationS: num(a, 'duration') });
        continue;
      default:
        continue; // unknown element (e.g. SolidState from very old files) – skip
    }
    for (const c of el.children) {
      if (c.name.toLowerCase() === 'textevent' && c.attrs.message) {
        textEvents.push({ atS: t + (num(c.attrs, 'timeoffset') ?? 0), message: c.attrs.message, durationS: num(c.attrs, 'duration') });
      }
    }
    t += length;
  }
  if (steps.length === 0) throw new ZwoError('Das Workout enthält keine Blöcke.');
  return {
    id: id ?? `import-${Date.now()}-${importCounter++}`,
    name: text('name') || 'Importiertes Workout',
    description: text('description'),
    author: text('author') || undefined,
    category: 'custom',
    steps,
    textEvents: textEvents.sort((x, y) => x.atS - y.atS),
  };
}

const f = (v: number) => String(Math.round(v * 1000) / 1000);

function cadenceAttrs(c: CadenceTarget | undefined, prefix = ''): string {
  if (c === undefined) return '';
  if (typeof c === 'number') return ` ${prefix}Cadence="${Math.round(c)}"`;
  return ` ${prefix}CadenceLow="${Math.round(c[0])}" ${prefix}CadenceHigh="${Math.round(c[1])}"`;
}

/** `ftp` converts workouts in absolute watts (Zwift files only know FTP fractions). */
export function serializeZwo(workout: Workout, ftp?: number): string {
  const w = resolveWorkout(workout, ftp);
  const lines: string[] = [];
  lines.push('<workout_file>');
  if (w.author) lines.push(`  <author>${encodeEntities(w.author)}</author>`);
  lines.push(`  <name>${encodeEntities(w.name)}</name>`);
  lines.push(`  <description>${encodeEntities(w.description)}</description>`);
  lines.push('  <sportType>bike</sportType>');
  lines.push('  <tags/>');
  lines.push('  <workout>');
  const events = [...(w.textEvents ?? [])];
  let t = 0;
  for (const s of w.steps) {
    const len = s.type === 'intervals' ? s.repeat * (s.on.durationS + s.off.durationS) : s.durationS;
    const own = events.filter((e) => e.atS >= t && e.atS < t + len);
    const inner = own.map((e) => `      <textevent timeoffset="${Math.round(e.atS - t)}" message="${encodeEntities(e.message)}"/>`);
    let open: string;
    switch (s.type) {
      case 'warmup':
        open = `<Warmup Duration="${s.durationS}" PowerLow="${f(s.powerStart)}" PowerHigh="${f(s.powerEnd)}"${cadenceAttrs(s.cadence)}`;
        break;
      case 'cooldown':
        open = `<Cooldown Duration="${s.durationS}" PowerLow="${f(s.powerStart)}" PowerHigh="${f(s.powerEnd)}"${cadenceAttrs(s.cadence)}`;
        break;
      case 'ramp':
        open = `<Ramp Duration="${s.durationS}" PowerLow="${f(s.powerStart)}" PowerHigh="${f(s.powerEnd)}"${cadenceAttrs(s.cadence)}`;
        break;
      case 'steady':
        open = `<SteadyState Duration="${s.durationS}" Power="${f(s.power)}"${cadenceAttrs(s.cadence)}`;
        break;
      case 'intervals': {
        const rest = typeof s.off.cadence === 'number' ? ` CadenceResting="${Math.round(s.off.cadence)}"` : '';
        open = `<IntervalsT Repeat="${s.repeat}" OnDuration="${s.on.durationS}" OffDuration="${s.off.durationS}" OnPower="${f(s.on.power)}" OffPower="${f(s.off.power)}"${cadenceAttrs(s.on.cadence)}${rest}`;
        break;
      }
      case 'freeride':
        open = `<FreeRide Duration="${s.durationS}" FlatRoad="0"${cadenceAttrs(s.cadence)}`;
        break;
      case 'maxeffort':
        open = `<MaxEffort Duration="${s.durationS}"`;
        break;
    }
    const tag = open.slice(1, open.indexOf(' '));
    if (inner.length) lines.push(`    ${open}>`, ...inner, `    </${tag}>`);
    else lines.push(`    ${open}/>`);
    t += len;
  }
  lines.push('  </workout>');
  lines.push('</workout_file>');
  return lines.join('\n') + '\n';
}
