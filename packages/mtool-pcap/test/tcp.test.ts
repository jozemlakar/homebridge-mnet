import { describe, expect, it } from 'vitest';

import { readPackets } from '../src/pcapng.js';
import { reassemble, timeAt } from '../src/tcp.js';
import { buildPcapng } from './helpers.js';

const A = { src: '192.168.1.2', dst: '192.168.1.100', srcPort: 4245, dstPort: 25 };

function streamsOf(segments: Parameters<typeof buildPcapng>[0]) {
  return reassemble(readPackets(buildPcapng(segments)));
}

describe('reassemble', () => {
  it('joins segments that split a record mid-way', () => {
    // The real failure mode this tool exists for: one CSV row arriving in two
    // pieces, which `tcpdump -A` reports as two unparseable fragments.
    const streams = streamsOf([
      { ...A, seq: 1000, payload: '081157,48,39FE82002E01080A01' },
      { ...A, seq: 1000 + 28, payload: '030020640104\r\n' },
    ]);

    expect(streams).toHaveLength(1);
    expect(streams[0]!.data.toString()).toBe('081157,48,39FE82002E01080A01030020640104\r\n');
    expect(streams[0]!.gaps).toEqual([]);
  });

  it('keeps the two directions of a connection separate', () => {
    const streams = streamsOf([
      { ...A, seq: 1, payload: 'from-controller' },
      { src: A.dst, dst: A.src, srcPort: A.dstPort, dstPort: A.srcPort, seq: 1, payload: '220 ok' },
    ]);

    expect(streams).toHaveLength(2);
    expect(streams.map((s) => s.data.toString()).sort()).toEqual(['220 ok', 'from-controller']);
  });

  it('orders out-of-order segments and drops retransmissions', () => {
    const streams = streamsOf([
      { ...A, seq: 106, payload: 'CCC' },
      { ...A, seq: 100, payload: 'AAA' },
      { ...A, seq: 100, payload: 'AAA' }, // retransmission
      { ...A, seq: 103, payload: 'BBB' },
    ]);

    expect(streams[0]!.data.toString()).toBe('AAABBBCCC');
    expect(streams[0]!.segmentCount).toBe(3);
  });

  it('reports a hole rather than silently closing it', () => {
    const streams = streamsOf([
      { ...A, seq: 100, payload: 'AAA' },
      { ...A, seq: 110, payload: 'BBB' },
    ]);

    expect(streams[0]!.gaps).toEqual([{ offset: 3, length: 7 }]);
    expect(streams[0]!.data.length).toBe(13);
  });

  it('handles sequence numbers that wrap past 2^32', () => {
    const streams = streamsOf([
      { ...A, seq: 0xfffffffe, payload: 'AB' },
      { ...A, seq: 0x00000000, payload: 'CD' },
    ]);

    expect(streams[0]!.data.toString()).toBe('ABCD');
    expect(streams[0]!.gaps).toEqual([]);
  });

  it('rebases when the capture starts mid-connection', () => {
    // No SYN, and the first packet seen is not the earliest byte.
    const streams = streamsOf([
      { ...A, seq: 500, payload: 'ZZZ' },
      { ...A, seq: 400, payload: 'YYY' },
    ]);

    expect(streams[0]!.data.subarray(0, 3).toString()).toBe('YYY');
  });

  it('uses the SYN to place the first data byte at offset 0', () => {
    const streams = streamsOf([
      { ...A, seq: 999, payload: '', syn: true },
      { ...A, seq: 1000, payload: 'hello' },
    ]);

    expect(streams[0]!.data.toString()).toBe('hello');
  });

  it('decodes VLAN-tagged frames', () => {
    const streams = streamsOf([{ ...A, seq: 1, payload: 'tagged', vlan: 192 }]);
    expect(streams[0]!.data.toString()).toBe('tagged');
  });

  it('ignores Ethernet padding on short frames', () => {
    // A 3-byte payload makes the frame shorter than Ethernet's 60-byte floor,
    // so the NIC pads it; that padding must not become stream content.
    const capture = buildPcapng([{ ...A, seq: 1, payload: 'abc' }]);
    const padded = Buffer.concat([capture, Buffer.alloc(0)]);
    const streams = reassemble(readPackets(padded));
    expect(streams[0]!.data.toString()).toBe('abc');
  });
});

describe('timeAt', () => {
  it('returns the time of the segment carrying an offset', () => {
    const streams = streamsOf([
      { ...A, seq: 100, payload: 'AAAA', tsUsec: 1_000_000 },
      { ...A, seq: 104, payload: 'BBBB', tsUsec: 2_500_000 },
    ]);

    const s = streams[0]!;
    expect(timeAt(s, 0)).toBe(1_000_000n);
    expect(timeAt(s, 3)).toBe(1_000_000n);
    expect(timeAt(s, 4)).toBe(2_500_000n);
    expect(timeAt(s, 99)).toBe(2_500_000n);
  });
});
