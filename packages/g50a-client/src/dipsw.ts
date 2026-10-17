/**
 * Decode an indoor unit's `197F00` reply — the frame MainteToolNet's
 * *DipSW Monitor* uses — into its dip-switch banks plus the two flags in
 * byte 8 that are now identified. Layout and evidence: protocol-doc §8l.
 *
 * Reply = `19FF00` + payload. Payload bytes, zero-indexed:
 *
 * | idx | Field |
 * |---|---|
 * | 0 | DA |
 * | 2–3 | SW1, u16 little-endian, bit n−1 = switch n |
 * | 4 | SW2 = capacity code (equals `2108`'s QJ) |
 * | 5 | SW3, bit n−1 = switch n (switches 1–8 only) |
 * | 8 | bit 3 = SWC (air-outlet selector, "SWIC-6" in the monitor); bit 1 = CN32 lockout |
 * | 9–11 | live handshake bits — never configuration |
 *
 * Bytes 0 and 2–5 hold on every model seen. Byte 8 is decoded only for the
 * 13-byte `F/P` (PFFY floor-standing) layout; other models (e.g. the 10-byte
 * GUF fresh-air payload) put different data there, so the flags come back
 * `undefined` rather than guessed.
 */

export interface IndoorDipSwitches {
  /** Address echoed in payload byte 0. */
  address: number;
  /** SW1 positions 1–10, index 0 = SW1-1. SW1-1 ON = room temperature from the remote. */
  sw1: boolean[];
  /** SW2 raw byte — the capacity code (4 = P20, 5 = P25, 13 = P63). */
  capacityCode: number;
  /** SW3 positions 1–8, index 0 = SW3-1. */
  sw3: boolean[];
  /**
   * SWC air-outlet selector (byte 8 bit 3). `true` = the monitor's "ON".
   * `undefined` when the payload is not the 13-byte F/P layout.
   */
  swc: boolean | undefined;
  /**
   * Byte 8 bit 1: a CN32 remote ON/OFF adapter is holding the unit in its
   * external-control lockout. Not a switch — it is live input state. While
   * set, the unit accepts `Drive=ON` from the controller, then reverts to OFF
   * within ~20 s, and a local remote shows a blinking prohibit icon.
   * `undefined` when the payload is not the 13-byte F/P layout.
   */
  cn32Lockout: boolean | undefined;
  /** Payload length in bytes (13 on F/P units, 10 on GUF). */
  payloadLength: number;
}

const HEADER = '19FF00';

function bits(value: number, count: number): boolean[] {
  return Array.from({ length: count }, (_, i) => ((value >> i) & 1) === 1);
}

/**
 * Decode a `197F00` reply hex string. Returns `undefined` for anything that is
 * not a `19FF00` reply with at least the six fixed bytes (error strings such as
 * `#No Ack Error`, empty replies, other opcodes).
 */
export function decodeIndoorDipSwitches(reply: string): IndoorDipSwitches | undefined {
  const hex = reply.trim().toUpperCase();
  if (!hex.startsWith(HEADER) || !/^[0-9A-F]*$/.test(hex) || hex.length % 2 !== 0) {
    return undefined;
  }
  const payload = hex.slice(HEADER.length);
  const bytes: number[] = [];
  for (let i = 0; i < payload.length; i += 2) {
    bytes.push(Number.parseInt(payload.slice(i, i + 2), 16));
  }
  if (bytes.length < 6) return undefined;
  const [address, , sw1Lo, sw1Hi, sw2, sw3] = bytes as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const fp = bytes.length === 13;
  const flags = fp ? (bytes[8] ?? 0) : undefined;
  return {
    address,
    sw1: bits(sw1Lo | (sw1Hi << 8), 10),
    capacityCode: sw2,
    sw3: bits(sw3, 8),
    swc: flags === undefined ? undefined : (flags & 0x08) !== 0,
    cn32Lockout: flags === undefined ? undefined : (flags & 0x02) !== 0,
    payloadLength: bytes.length,
  };
}

/** 1-based positions of the switches that are ON, e.g. `[1, 7, 8, 9]`. */
export function switchesOn(bank: readonly boolean[]): number[] {
  return bank.flatMap((on, i) => (on ? [i + 1] : []));
}
