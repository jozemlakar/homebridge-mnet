import { describe, expect, it } from 'vitest';

import { readPackets } from '../src/pcapng.js';
import { reassemble } from '../src/tcp.js';
import {
  decodeBcdTenths,
  hasPumyCheckByte,
  isResponseOf,
  parseQueries,
  parseSubscriptions,
  parseTrendPushes,
  pumyCheckByte,
  responseOpcode,
} from '../src/mtool.js';
import { buildPcapng, trendBody } from './helpers.js';

describe('parseTrendPushes', () => {
  const rows = [
    '080949,,#Monitor Start',
    '080950,95,19FF10067600F401860B3C003C00',
    '080955,45,39FE02000280031102777FFF00410240',
  ];

  it('reads the header, the data rows and the marker rows', () => {
    const [push] = parseTrendPushes(trendBody(rows, '0929-58_20260904_075751'));

    expect(push!.requestId).toBe('0929-58_20260904_075751');
    expect(push!.sendInterval).toBe('60');
    expect(push!.rows).toHaveLength(3);
    expect(push!.rows[0]).toEqual({ time: '080949', da: null, hex: '', note: '#Monitor Start' });
    expect(push!.rows[1]).toEqual({
      time: '080950',
      da: 95,
      hex: '19FF10067600F401860B3C003C00',
    });
  });

  it('separates several pushes on one reused connection', () => {
    const text = `${trendBody(rows, 'a')}\r\n${trendBody(rows, 'b')}`;
    expect(parseTrendPushes(text).map((p) => p.requestId)).toEqual(['a', 'b']);
  });

  it('survives a row split across TCP segments', () => {
    // Reassembly has to happen before parsing or this row is lost entirely —
    // the case that motivated the whole package.
    const body = trendBody(['081157,48,39FE82002E01080A01030020640104']);
    const cut = body.indexOf('080A01') + 6;
    const streams = reassemble(
      readPackets(
        buildPcapng([
          {
            src: '192.168.1.2',
            dst: '192.168.1.100',
            srcPort: 4245,
            dstPort: 25,
            seq: 1,
            payload: body.slice(0, cut),
          },
          {
            src: '192.168.1.2',
            dst: '192.168.1.100',
            srcPort: 4245,
            dstPort: 25,
            seq: 1 + cut,
            payload: body.slice(cut),
          },
        ]),
      ),
    );

    const [push] = parseTrendPushes(streams[0]!.data.toString('latin1'));
    expect(push!.rows[0]!.hex).toBe('39FE82002E01080A01030020640104');
  });
});

describe('parseQueries', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Packet><Command>setRequest</Command><DatabaseManager>
<MnetRouter><MnetCommandList DA="95"><ReceiveCommandRecord Data="197F1006" RcvData="*"/></MnetCommandList>
<MnetCommandList DA="95"><ReceiveCommandRecord Data="197F1006" RcvData="19FF1006F3000000000000000000"/></MnetCommandList>
<MnetCommandList DA="44"><ReceiveCommandRecord Data="2108" RcvData="#NO ACK ERROR"/></MnetCommandList>
</MnetRouter></DatabaseManager></Packet>`;

  it('takes DA from MnetCommandList, not MnetRouter', () => {
    // Anchoring on MnetRouter matches nothing at all — the trap in §8j.
    expect(/<MnetRouter[^>]*DA="/.test(xml)).toBe(false);
    expect(parseQueries(xml).map((q) => q.da)).toEqual([95, 95, 44]);
  });

  it('keeps the request leg distinguishable and preserves error replies', () => {
    const queries = parseQueries(xml);
    expect(queries[0]!.rcvData).toBe('*');
    expect(queries[1]!.rcvData).toBe('19FF1006F3000000000000000000');
    expect(queries[2]!.rcvData).toBe('#NO ACK ERROR');
  });

  it('finds the subscription list', () => {
    // In a MnetMonitor subscription DA sits on SendCommandRecord itself, unlike
    // the synchronous MnetRouter list above where it sits on MnetCommandList.
    const subscribe = `<MnetMonitor><MnetCommandList DA="95" CommandInterval="400">
<SendCommandRecord DA="95" Data="197F1006" />
<SendCommandRecord DA="95" Data="397E02" />
</MnetCommandList></MnetMonitor>`;

    expect(parseSubscriptions(subscribe)).toEqual([
      { da: 95, data: '197F1006' },
      { da: 95, data: '397E02' },
    ]);
    expect(parseSubscriptions(xml)).toEqual([]);
  });
});

describe('frame conventions', () => {
  it('sets the high bit of the second byte for the response opcode', () => {
    expect(responseOpcode('397E00')).toBe('39FE00');
    expect(responseOpcode('2100')).toBe('2180');
    expect(responseOpcode('210A')).toBe('218A');
    expect(responseOpcode('2D0B')).toBe('2D8B');
    expect(responseOpcode('197F1006')).toBe('19FF1006');
  });

  it('matches a response to its request', () => {
    expect(isResponseOf('397EF0', '39FEF000DE00040002840310E0050200')).toBe(true);
    expect(isResponseOf('397EF0', '21880250')).toBe(false);
  });

  it('computes the PUMY leading check byte', () => {
    // Verified live against four (DA, bank) pairs on two PUMY outdoor units.
    expect(pumyCheckByte(95, 0x02)).toBe(0xe9);
    expect(pumyCheckByte(95, 0x91)).toBe(0x5a);
    expect(pumyCheckByte(95, 0xf0)).toBe(0xfb);
    expect(pumyCheckByte(97, 0xf0)).toBe(0xf9);
  });

  it('tells a PUMY frame from a PURY frame by that byte', () => {
    expect(hasPumyCheckByte(95, '39FE02E90418035 2FFFF54800063FFFF'.replace(/ /g, ''))).toBe(true);
    // A PURY indoor unit puts a plain 00 there.
    expect(hasPumyCheckByte(45, '39FE02000280031102777FFF00410240')).toBe(false);
  });
});

describe('decodeBcdTenths', () => {
  it('decodes the documented cases', () => {
    expect(decodeBcdTenths(0x0255)).toBe(25.5);
    expect(decodeBcdTenths(0x0016)).toBe(1.6);
    expect(decodeBcdTenths(0x8178)).toBe(-17.8);
    expect(decodeBcdTenths(0x7fff)).toBeNull();
  });

  it('keeps all four digits when the value is positive', () => {
    // The sign is only the top bit, so 548.0 V still fits.
    expect(decodeBcdTenths(0x5480)).toBe(548.0);
  });
});
