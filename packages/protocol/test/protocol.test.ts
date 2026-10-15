import { describe, expect, it } from 'vitest';
import { encodeTuple, parseClientMessage } from '../src';

const loadout = { bike: 'bike-basis', wheels: 'wheels-basis', jersey: 'jersey-club-orange' };

describe('parseClientMessage', () => {
  it('accepts a valid hello and normalises values', () => {
    const m = parseClientMessage(JSON.stringify({ type: 'hello', v: 1, name: '  Ali  ', routeId: 'kuestenrunde', loadout, weightKg: 500 }));
    expect(m).toEqual({ type: 'hello', v: 1, token: undefined, name: 'Ali', routeId: 'kuestenrunde', loadout, weightKg: 200, bot: false, simulated: false });
  });

  it('accepts state updates', () => {
    expect(parseClientMessage('{"type":"state","d":12.5,"v":9,"p":220,"c":90,"lat":1.4}')).toEqual({
      type: 'state',
      d: 12.5,
      v: 9,
      p: 220,
      c: 90,
      lat: 1.4,
      hr: undefined,
    });
  });

  it('rejects malformed input', () => {
    expect(parseClientMessage('not json')).toBeNull();
    expect(parseClientMessage('{"type":"state","d":"x"}')).toBeNull();
    expect(parseClientMessage('{"type":"hello","v":1}')).toBeNull();
    expect(parseClientMessage('{"type":"chat","text":"   "}')).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: 'chat', text: 'x'.repeat(300) }))).toBeNull();
    expect(parseClientMessage('{"type":"nope"}')).toBeNull();
    expect(parseClientMessage('{"type":"state","d":1,"v":1,"p":1,"c":1,"lat":1e999}')).toBeNull();
  });

  it('encodes compact tuples', () => {
    expect(encodeTuple('a', 123.456, 9.876, 1.234, 249.6, 89.4)).toEqual(['a', 123.5, 9.88, 1.23, 250, 89]);
  });
});
