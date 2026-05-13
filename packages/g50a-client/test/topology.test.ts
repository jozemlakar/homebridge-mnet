import { describe, expect, it } from 'vitest';
import { buildTopology, decodeRefSystemRecord } from '../src/topology.js';
import type { RefSystemRecord } from '../src/types.js';

const rec = (address: number, ocAddress: number, model: string): RefSystemRecord => ({
  address,
  ocAddress,
  model,
});

describe('decodeRefSystemRecord', () => {
  it('parses a well-formed element', () => {
    expect(decodeRefSystemRecord({ Address: '1', OcAddress: '51', Model: 'IC' })).toEqual({
      address: 1,
      ocAddress: 51,
      model: 'IC',
    });
  });

  it('returns undefined when address is missing', () => {
    expect(decodeRefSystemRecord({ OcAddress: '51', Model: 'IC' })).toBeUndefined();
    expect(decodeRefSystemRecord({ Address: 'X', OcAddress: '51', Model: 'IC' })).toBeUndefined();
  });
});

describe('buildTopology', () => {
  it('groups records by outdoor unit', () => {
    const t = buildTopology([
      rec(1, 51, 'IC'),
      rec(2, 51, 'IC'),
      rec(52, 51, 'BC'),
      rec(16, 66, 'IC'),
      rec(82, 66, 'BS'),
    ]);
    expect(t.outdoorSystems).toHaveLength(2);
    const oc51 = t.outdoorSystems.find((s) => s.ocAddress === 51)!;
    expect(oc51.indoor).toHaveLength(2);
    expect(oc51.branchControllers).toHaveLength(1);
    expect(oc51.branchSelectors).toHaveLength(0);
    const oc66 = t.outdoorSystems.find((s) => s.ocAddress === 66)!;
    expect(oc66.branchSelectors).toHaveLength(1);
  });

  it('marks systems with BC as mixed-mode', () => {
    const t = buildTopology([rec(1, 51, 'IC'), rec(52, 51, 'BC')]);
    expect(t.outdoorSystems[0]?.supportsMixedMode).toBe(true);
  });

  it('marks systems with BS as mixed-mode', () => {
    const t = buildTopology([rec(1, 66, 'IC'), rec(82, 66, 'BS')]);
    expect(t.outdoorSystems[0]?.supportsMixedMode).toBe(true);
  });

  it('marks systems with neither BC nor BS as single-mode', () => {
    const t = buildTopology([rec(45, 95, 'IC'), rec(46, 95, 'IC'), rec(47, 95, 'IC')]);
    expect(t.outdoorSystems[0]?.supportsMixedMode).toBe(false);
  });

  it('buckets non-IC/BC/BS records into `other`', () => {
    const t = buildTopology([rec(1, 51, 'IC'), rec(60, 51, 'KA')]);
    const oc = t.outdoorSystems[0]!;
    expect(oc.other).toHaveLength(1);
    expect(oc.other[0]?.model).toBe('KA');
  });

  it('sorts outdoor systems by OC address', () => {
    const t = buildTopology([rec(45, 95, 'IC'), rec(1, 51, 'IC'), rec(16, 66, 'IC')]);
    expect(t.outdoorSystems.map((s) => s.ocAddress)).toEqual([51, 66, 95]);
  });

  it('treats indoor variants (IDC, KIC, AIC) as indoor', () => {
    const t = buildTopology([
      rec(1, 51, 'IC'),
      rec(2, 51, 'IDC'),
      rec(3, 51, 'KIC'),
      rec(4, 51, 'AIC'),
    ]);
    expect(t.outdoorSystems[0]?.indoor).toHaveLength(4);
    expect(t.outdoorSystems[0]?.other).toHaveLength(0);
  });
});
