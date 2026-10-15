export class ParseError extends Error {
  override name = 'ParseError';
}

/** Sequential little-endian reader over a DataView, as used by all GATT payloads. */
export class ByteReader {
  private offset = 0;

  constructor(private readonly view: DataView) {}

  get remaining(): number {
    return this.view.byteLength - this.offset;
  }

  private need(n: number): void {
    if (this.remaining < n) {
      throw new ParseError(`payload too short: need ${n} more byte(s) at offset ${this.offset}, have ${this.remaining}`);
    }
  }

  uint8(): number {
    this.need(1);
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  int8(): number {
    this.need(1);
    const v = this.view.getInt8(this.offset);
    this.offset += 1;
    return v;
  }

  uint16(): number {
    this.need(2);
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  int16(): number {
    this.need(2);
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }

  uint24(): number {
    this.need(3);
    const v = this.view.getUint16(this.offset, true) + (this.view.getUint8(this.offset + 2) << 16);
    this.offset += 3;
    return v;
  }

  uint32(): number {
    this.need(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  skip(n: number): void {
    this.need(n);
    this.offset += n;
  }
}

/** Builds a little-endian payload byte by byte. */
export class ByteWriter {
  private bytes: number[] = [];

  uint8(v: number): this {
    this.bytes.push(v & 0xff);
    return this;
  }

  uint16(v: number): this {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff);
    return this;
  }

  int16(v: number): this {
    return this.uint16(v < 0 ? v + 0x10000 : v);
  }

  uint24(v: number): this {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff);
    return this;
  }

  uint32(v: number): this {
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }

  toDataView(): DataView {
    return new DataView(this.toUint8Array().buffer);
  }
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function toHex(data: DataView | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

export function dataViewToString(view: DataView): string {
  return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)).replace(/\0+$/, '');
}
