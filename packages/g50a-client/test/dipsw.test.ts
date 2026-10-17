import { describe, expect, it } from 'vitest';
import { decodeIndoorDipSwitches, switchesOn } from '../src/dipsw.js';

// Live replies captured 2026-10-15..17 on a 4th-floor PURY loop (protocol-doc §8l).
const IC13 = '19FF000D76C101058CD0280048E42503'; // runs normally, SWC off
const IC15_LOCKED = '19FF000F78C101048CD0280A48E40503'; // CN32 lockout + SWC
const IC15_FIXED = '19FF000F78C101048CD0280848E40503'; // same unit, CN32 unplugged
const IC16_LOCKED = '19FF001079C101058CD0280208E02503'; // CN32 lockout, SWC off
const IC22 = '19FF001675C101048CD0280848E02503'; // runs normally, SWC on
const GUF30 = '19FF001E0400000D0011008801'; // GUF-100RD: 10-byte payload

describe('decodeIndoorDipSwitches', () => {
  it('decodes SW1/SW2/SW3 as labelled in the DipSW Monitor', () => {
    const d = decodeIndoorDipSwitches(IC13)!;
    expect(d.address).toBe(13);
    expect(switchesOn(d.sw1)).toEqual([1, 7, 8, 9]);
    expect(d.capacityCode).toBe(5); // P25
    expect(switchesOn(d.sw3)).toEqual([3, 4, 8]);
    expect(d.payloadLength).toBe(13);
  });

  it('reads SWC from byte 8 bit 3', () => {
    expect(decodeIndoorDipSwitches(IC13)!.swc).toBe(false);
    expect(decodeIndoorDipSwitches(IC22)!.swc).toBe(true);
  });

  it('reads the CN32 lockout from byte 8 bit 1, independent of SWC', () => {
    expect(decodeIndoorDipSwitches(IC13)!.cn32Lockout).toBe(false);
    expect(decodeIndoorDipSwitches(IC22)!.cn32Lockout).toBe(false);
    expect(decodeIndoorDipSwitches(IC16_LOCKED)!).toMatchObject({ cn32Lockout: true, swc: false });
    expect(decodeIndoorDipSwitches(IC15_LOCKED)!).toMatchObject({ cn32Lockout: true, swc: true });
    expect(decodeIndoorDipSwitches(IC15_FIXED)!).toMatchObject({ cn32Lockout: false, swc: true });
  });

  it('keeps the fixed bytes but leaves byte-8 flags undefined on non-F/P layouts', () => {
    const d = decodeIndoorDipSwitches(GUF30)!;
    expect(d.address).toBe(30);
    expect(d.capacityCode).toBe(13); // P63
    expect(d.payloadLength).toBe(10);
    expect(d.swc).toBeUndefined();
    expect(d.cn32Lockout).toBeUndefined();
  });

  it('returns undefined for error strings and foreign replies', () => {
    expect(decodeIndoorDipSwitches('#No Ack Error')).toBeUndefined();
    expect(decodeIndoorDipSwitches('')).toBeUndefined();
    expect(decodeIndoorDipSwitches('2183010D')).toBeUndefined();
    expect(decodeIndoorDipSwitches('19FF000D76')).toBeUndefined();
  });
});
