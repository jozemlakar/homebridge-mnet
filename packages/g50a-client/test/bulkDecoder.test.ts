import { describe, expect, it } from 'vitest';
import { decodeBulk } from '../src/bulkDecoder.js';
import type { GroupState } from '../src/types.js';

type ExpectedPartial = Partial<Omit<GroupState, 'raw' | 'tempLimits'>>;

interface Case {
  name: string;
  bulk: string;
  expected: ExpectedPartial;
}

const CASES: Case[] = [
  {
    name: 'OFF, Cool, 22C, room 21.0C',
    bulk: '010001160000D2060600000000000000001F010064000101010101010000000000000000000000000000010001010101',
    expected: {
      drive: 'OFF',
      mode: 'COOL',
      setTemp: 22,
      inletTemp: 21,
      airDirection: 'AUTO',
      fanSpeed: 'AUTO',
    },
  },
  {
    name: 'ON HEAT 24C, room 24.5C',
    bulk: '010102180000F5000600000000000000001F010064000101010101010000000000000000000000000000010001010101',
    expected: {
      drive: 'ON',
      mode: 'HEAT',
      setTemp: 24,
      inletTemp: 24.5,
    },
  },
  {
    name: 'ON HEAT 25C, room 24.0C',
    bulk: '010102190000F0000600000000000000001F010064000101010101010000000000000000000000000000010001010101',
    expected: {
      drive: 'ON',
      mode: 'HEAT',
      setTemp: 25,
      inletTemp: 24,
    },
  },
  {
    name: 'OFF Cool 21C, room 23.0C',
    bulk: '010001150000E6060600000000000000001F010064000101010101010000000000000000000000000000010001010101',
    expected: {
      drive: 'OFF',
      mode: 'COOL',
      setTemp: 21,
      inletTemp: 23,
    },
  },
];

describe('decodeBulk', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const state = decodeBulk(c.bulk);
      for (const [key, value] of Object.entries(c.expected) as [keyof ExpectedPartial, unknown][]) {
        expect(state[key], `${c.name}: ${key}`).toBe(value);
      }
    });
  }

  it('attaches raw byte slices', () => {
    const state = decodeBulk(CASES[0]!.bulk);
    expect(state.raw['bulk']).toBe(CASES[0]!.bulk);
    expect(state.raw['drive']).toBe('00');
    expect(state.raw['mode']).toBe('01');
    expect(state.raw['setTemp']).toBe('1600');
  });

  it('throws on too-short payload', () => {
    expect(() => decodeBulk('0100')).toThrow(RangeError);
  });

  it('preserves filterSign=false when byte is 0', () => {
    const state = decodeBulk(CASES[0]!.bulk);
    expect(state.filterSign).toBe(false);
  });

  it('omits errorSign when byte is 0', () => {
    const state = decodeBulk(CASES[0]!.bulk);
    expect(state.errorSign).toBeUndefined();
  });

  it('reports temperature limits from BCD-encoded bytes', () => {
    const state = decodeBulk(CASES[0]!.bulk);
    // The fixture has bytes 32-37 zero across the board, so all limits are 0.
    // This still verifies that the decoder runs without throwing and produces
    // a fully-populated tempLimits record.
    expect(state.tempLimits).toEqual({
      coolMin: 0,
      coolMax: 0,
      heatMin: 0,
      heatMax: 0,
      autoMin: 0,
      autoMax: 0,
    });
  });
});
