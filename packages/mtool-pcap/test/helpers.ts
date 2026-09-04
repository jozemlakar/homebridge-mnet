/**
 * Synthetic capture builders.
 *
 * Fixtures are constructed rather than sliced out of a real capture: the tests
 * need to exercise cases a real file happens not to contain (sequence wrap,
 * retransmission, a genuine hole) and nothing about the site's traffic needs to
 * live in the repository.
 */

export interface FakeSegment {
  src: string;
  dst: string;
  srcPort: number;
  dstPort: number;
  seq: number;
  payload: string | Buffer;
  /** Capture time in microseconds. */
  tsUsec?: number;
  syn?: boolean;
  /** Emit an 802.1Q tag, to prove VLAN frames are still decoded. */
  vlan?: number;
}

function ipToBytes(ip: string): Buffer {
  return Buffer.from(ip.split('.').map((o) => Number(o)));
}

function ethernetFrame(seg: FakeSegment): Buffer {
  const payload = Buffer.isBuffer(seg.payload) ? seg.payload : Buffer.from(seg.payload, 'latin1');

  const tcp = Buffer.alloc(20 + payload.length);
  tcp.writeUInt16BE(seg.srcPort, 0);
  tcp.writeUInt16BE(seg.dstPort, 2);
  tcp.writeUInt32BE(seg.seq >>> 0, 4);
  tcp[12] = 5 << 4; // data offset, no options
  tcp[13] = seg.syn ? 0x02 : 0x10;
  tcp.writeUInt16BE(1024, 14);
  payload.copy(tcp, 20);

  const ip = Buffer.alloc(20 + tcp.length);
  ip[0] = 0x45;
  ip.writeUInt16BE(ip.length, 2);
  ip[8] = 64;
  ip[9] = 6; // TCP
  ipToBytes(seg.src).copy(ip, 12);
  ipToBytes(seg.dst).copy(ip, 16);
  tcp.copy(ip, 20);

  const tagLen = seg.vlan === undefined ? 0 : 4;
  const eth = Buffer.alloc(14 + tagLen + ip.length);
  eth.fill(0, 0, 12);
  if (seg.vlan === undefined) {
    eth.writeUInt16BE(0x0800, 12);
  } else {
    eth.writeUInt16BE(0x8100, 12);
    eth.writeUInt16BE(seg.vlan, 14);
    eth.writeUInt16BE(0x0800, 16);
  }
  ip.copy(eth, 14 + tagLen);
  return eth;
}

/** Build a pcapng file (little-endian, microsecond resolution). */
export function buildPcapng(segments: FakeSegment[]): Buffer {
  const blocks: Buffer[] = [];

  const shb = Buffer.alloc(28);
  shb.writeUInt32LE(0x0a0d0d0a, 0);
  shb.writeUInt32LE(28, 4);
  shb.writeUInt32LE(0x1a2b3c4d, 8);
  shb.writeUInt16LE(1, 12); // major
  shb.writeUInt16LE(0, 14); // minor
  shb.writeBigInt64LE(-1n, 16); // section length: unknown
  shb.writeUInt32LE(28, 24);
  blocks.push(shb);

  const idb = Buffer.alloc(20);
  idb.writeUInt32LE(0x00000001, 0);
  idb.writeUInt32LE(20, 4);
  idb.writeUInt16LE(1, 8); // LINKTYPE_ETHERNET
  idb.writeUInt32LE(0, 12); // snaplen: no limit
  idb.writeUInt32LE(20, 16);
  blocks.push(idb);

  for (const seg of segments) {
    const frame = ethernetFrame(seg);
    const pad = (4 - (frame.length % 4)) % 4;
    const len = 32 + frame.length + pad;
    const epb = Buffer.alloc(len);
    epb.writeUInt32LE(0x00000006, 0);
    epb.writeUInt32LE(len, 4);
    epb.writeUInt32LE(0, 8); // interface id
    const ts = BigInt(seg.tsUsec ?? 0);
    epb.writeUInt32LE(Number(ts >> 32n), 12);
    epb.writeUInt32LE(Number(ts & 0xffffffffn), 16);
    epb.writeUInt32LE(frame.length, 20);
    epb.writeUInt32LE(frame.length, 24);
    frame.copy(epb, 28);
    epb.writeUInt32LE(len, len - 4);
    blocks.push(epb);
  }

  return Buffer.concat(blocks);
}

/** Wrap trend-push rows in the SMTP body the controller actually sends. */
export function trendBody(rows: string[], requestId = 'test-1'): string {
  return [
    'MAIL FROM:<g50@g50.com>',
    'DATA',
    'Subject:@mt test',
    '',
    '[MnetMonitor]',
    `RequestID="${requestId}"`,
    'SmtpServer="192.168.1.100"',
    'SendInterval="60"',
    'StartDate="20260904"',
    'StartTime="080148"',
    '[Data]',
    ...rows,
    '[END]',
    '.',
  ].join('\r\n');
}
