/**
 * IPv4/TCP stream reassembly over decoded capture packets.
 *
 * The G-50 talks HTTP/1.0 and plaintext SMTP, and both split their payloads
 * across TCP segments at arbitrary points — mid-XML-tag, mid-CSV-row. Regexing
 * over `tcpdump -A` output therefore silently loses records; every extractor in
 * `mtool.ts` runs against a reassembled stream instead.
 */

import type { CapturedPacket } from './pcapng.js';

export interface StreamMark {
  /** Byte offset within `data`. */
  offset: number;
  tsUsec: bigint;
}

export interface StreamGap {
  offset: number;
  length: number;
}

export interface TcpStream {
  src: string;
  srcPort: number;
  dst: string;
  dstPort: number;
  /** Reassembled payload, gaps zero-filled. */
  data: Buffer;
  /** One entry per contributing segment, ascending — see {@link timeAt}. */
  marks: StreamMark[];
  /** Byte ranges never captured; non-empty means the stream is incomplete. */
  gaps: StreamGap[];
  /** Segments accepted into the stream (retransmissions excluded). */
  segmentCount: number;
}

const LINKTYPE_NULL = 0;
const LINKTYPE_ETHERNET = 1;
const LINKTYPE_RAW = 101;
const LINKTYPE_LINUX_SLL = 113;

const IPPROTO_TCP = 6;

interface Segment {
  /** Offset relative to the direction's initial sequence number. */
  rel: number;
  payload: Buffer;
  tsUsec: bigint;
}

interface Direction {
  src: string;
  srcPort: number;
  dst: string;
  dstPort: number;
  /** Absolute sequence number that maps to relative offset 0. */
  base: number | null;
  segments: Segment[];
}

/**
 * Group every TCP payload in the capture into per-direction streams.
 *
 * Each direction of a connection is returned separately: request and response
 * bodies are parsed independently and interleaving them would corrupt both.
 */
export function reassemble(packets: Iterable<CapturedPacket>): TcpStream[] {
  const dirs = new Map<string, Direction>();

  for (const pkt of packets) {
    const ip = stripLinkLayer(pkt.data, pkt.linkType);
    if (!ip) continue;
    const tcp = parseIpv4Tcp(ip);
    if (!tcp) continue;

    const key = `${tcp.src}:${tcp.srcPort}>${tcp.dst}:${tcp.dstPort}`;
    let dir = dirs.get(key);
    if (!dir) {
      dir = {
        src: tcp.src,
        srcPort: tcp.srcPort,
        dst: tcp.dst,
        dstPort: tcp.dstPort,
        base: null,
        segments: [],
      };
      dirs.set(key, dir);
    }

    // A captured SYN gives the true initial sequence number; without one we
    // infer the base from the lowest sequence actually seen (below).
    if (tcp.syn) dir.base = (tcp.seq + 1) >>> 0;

    if (tcp.payload.length === 0) continue;
    if (dir.base === null) dir.base = tcp.seq;

    dir.segments.push({
      rel: seqDelta(tcp.seq, dir.base),
      payload: tcp.payload,
      tsUsec: pkt.tsUsec,
    });
  }

  const streams: TcpStream[] = [];
  for (const dir of dirs.values()) {
    if (dir.segments.length > 0) streams.push(buildStream(dir));
  }
  return streams;
}

function buildStream(dir: Direction): TcpStream {
  // If the capture began mid-connection the first segment we saw need not be
  // the earliest; rebase so no offset is negative.
  let minRel = 0;
  for (const seg of dir.segments) if (seg.rel < minRel) minRel = seg.rel;
  if (minRel !== 0) for (const seg of dir.segments) seg.rel -= minRel;

  const byOffset = new Map<number, Segment>();
  let end = 0;
  for (const seg of dir.segments) {
    const existing = byOffset.get(seg.rel);
    // Retransmissions repeat an offset. Keep the first arrival, but prefer a
    // longer payload — captures sometimes truncate the original.
    if (!existing || existing.payload.length < seg.payload.length) {
      byOffset.set(seg.rel, seg);
    }
    end = Math.max(end, seg.rel + seg.payload.length);
  }

  const data = Buffer.alloc(end);
  const covered = Buffer.alloc(end); // 1 byte per data byte; cheap and clear
  const marks: StreamMark[] = [];

  for (const seg of [...byOffset.values()].sort((a, b) => a.rel - b.rel)) {
    seg.payload.copy(data, seg.rel);
    covered.fill(1, seg.rel, seg.rel + seg.payload.length);
    marks.push({ offset: seg.rel, tsUsec: seg.tsUsec });
  }

  const gaps: StreamGap[] = [];
  let gapStart = -1;
  for (let i = 0; i <= end; i++) {
    const missing = i < end && covered[i] === 0;
    if (missing && gapStart < 0) gapStart = i;
    else if (!missing && gapStart >= 0) {
      gaps.push({ offset: gapStart, length: i - gapStart });
      gapStart = -1;
    }
  }

  return {
    src: dir.src,
    srcPort: dir.srcPort,
    dst: dir.dst,
    dstPort: dir.dstPort,
    data,
    marks,
    gaps,
    segmentCount: byOffset.size,
  };
}

/**
 * Capture time of the segment that carried `offset`.
 *
 * This is what makes a reassembled stream pairable with a GUI screenshot: a
 * decoded record's byte position maps back to the moment it was on the wire.
 */
export function timeAt(stream: TcpStream, offset: number): bigint | undefined {
  const { marks } = stream;
  if (marks.length === 0) return undefined;

  let lo = 0;
  let hi = marks.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (marks[mid]!.offset <= offset) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found < 0 ? marks[0]!.tsUsec : marks[found]!.tsUsec;
}

/** Format a capture timestamp the way `tcpdump` prints it, in local time. */
export function formatTime(tsUsec: bigint): string {
  const d = new Date(Number(tsUsec / 1000n));
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(Number(tsUsec % 1_000_000n), 6)}`
  );
}

/** Signed 32-bit-wrapping distance from `base` to `seq`. */
function seqDelta(seq: number, base: number): number {
  const d = (seq - base) >>> 0;
  return d > 0x7fffffff ? d - 0x100000000 : d;
}

/** Strip the link-layer header, returning the IP packet, or null if not IP. */
function stripLinkLayer(frame: Buffer, linkType: number): Buffer | null {
  switch (linkType) {
    case LINKTYPE_ETHERNET: {
      if (frame.length < 14) return null;
      let off = 12;
      let etherType = frame.readUInt16BE(off);
      // Walk any VLAN tags; the MNET wire is trunked in places.
      while (etherType === 0x8100 || etherType === 0x88a8) {
        off += 4;
        if (off + 2 > frame.length) return null;
        etherType = frame.readUInt16BE(off);
      }
      if (etherType !== 0x0800) return null;
      return frame.subarray(off + 2);
    }
    case LINKTYPE_RAW:
      return frame;
    case LINKTYPE_NULL:
      return frame.length >= 4 ? frame.subarray(4) : null;
    case LINKTYPE_LINUX_SLL:
      return frame.length >= 16 && frame.readUInt16BE(14) === 0x0800 ? frame.subarray(16) : null;
    default:
      return null;
  }
}

interface TcpSegmentView {
  src: string;
  dst: string;
  srcPort: number;
  dstPort: number;
  seq: number;
  syn: boolean;
  payload: Buffer;
}

function parseIpv4Tcp(ip: Buffer): TcpSegmentView | null {
  if (ip.length < 20) return null;
  if (ip[0]! >> 4 !== 4) return null;
  const ihl = (ip[0]! & 0x0f) * 4;
  if (ip[9] !== IPPROTO_TCP) return null;

  // Trust the IP header's total length over the buffer length: Ethernet pads
  // short frames, and that padding would otherwise become stream content.
  const totalLen = Math.min(ip.readUInt16BE(2), ip.length);
  if (totalLen < ihl + 20) return null;

  const tcp = ip.subarray(ihl, totalLen);
  const dataOff = (tcp[12]! >> 4) * 4;
  if (dataOff < 20 || dataOff > tcp.length) return null;

  return {
    src: ipv4(ip, 12),
    dst: ipv4(ip, 16),
    srcPort: tcp.readUInt16BE(0),
    dstPort: tcp.readUInt16BE(2),
    seq: tcp.readUInt32BE(4),
    syn: (tcp[13]! & 0x02) !== 0,
    payload: tcp.subarray(dataOff),
  };
}

function ipv4(buf: Buffer, off: number): string {
  return `${buf[off]}.${buf[off + 1]}.${buf[off + 2]}.${buf[off + 3]}`;
}
