/**
 * Minimal reader for pcapng and classic pcap files.
 *
 * Exists because the machines these captures are taken on have no `tshark`, and
 * `tcpdump -A` mangles the payload it prints (see docs/g50a-protocol.md §8j).
 * Only the block types that carry packets are decoded; anything else is skipped
 * via its length field.
 */

export interface CapturedPacket {
  /** Capture timestamp in microseconds since the Unix epoch. */
  tsUsec: bigint;
  /** PCAP link type of the interface the packet arrived on. */
  linkType: number;
  data: Buffer;
}

const BT_SHB = 0x0a0d0d0a;
const BT_IDB = 0x00000001;
const BT_SPB = 0x00000003;
const BT_EPB = 0x00000006;

const PCAP_MAGIC_USEC = 0xa1b2c3d4;
const PCAP_MAGIC_NSEC = 0xa1b23c4d;

interface Endian {
  u16(buf: Buffer, off: number): number;
  u32(buf: Buffer, off: number): number;
}

const LE: Endian = {
  u16: (b, o) => b.readUInt16LE(o),
  u32: (b, o) => b.readUInt32LE(o),
};
const BE: Endian = {
  u16: (b, o) => b.readUInt16BE(o),
  u32: (b, o) => b.readUInt32BE(o),
};

/** Per-interface state: link type plus the divisor implied by `if_tsresol`. */
interface Iface {
  linkType: number;
  /** Ticks per second, as encoded by the `if_tsresol` option. */
  ticksPerSecond: bigint;
}

export class CaptureFormatError extends Error {}

/**
 * Decode a capture file into packets, in file order.
 *
 * Both container formats are accepted; the caller does not need to know which
 * one it has. Interface-scoped metadata (link type, timestamp resolution) is
 * tracked per interface id, because a pcapng file may legitimately mix them.
 */
export function* readPackets(buf: Buffer): Generator<CapturedPacket> {
  if (buf.length < 4) throw new CaptureFormatError('file too short to be a capture');

  const magic = buf.readUInt32BE(0);
  if (magic === BT_SHB) {
    yield* readPcapng(buf);
    return;
  }

  const magicLE = buf.readUInt32LE(0);
  if (
    magic === PCAP_MAGIC_USEC ||
    magic === PCAP_MAGIC_NSEC ||
    magicLE === PCAP_MAGIC_USEC ||
    magicLE === PCAP_MAGIC_NSEC
  ) {
    yield* readClassicPcap(buf);
    return;
  }

  throw new CaptureFormatError(
    `not a pcap or pcapng file (leading bytes ${buf.subarray(0, 4).toString('hex')})`,
  );
}

function* readPcapng(buf: Buffer): Generator<CapturedPacket> {
  let off = 0;
  // Endianness is per section, and a file may contain several sections.
  let e: Endian = LE;
  let ifaces: Iface[] = [];

  while (off + 12 <= buf.length) {
    const blockType = buf.readUInt32BE(off) === BT_SHB ? BT_SHB : e.u32(buf, off);

    if (blockType === BT_SHB) {
      // The byte-order magic that follows the length tells us how to read the
      // rest of the section, so it has to be probed before the length itself.
      const bom = buf.readUInt32BE(off + 8);
      e = bom === 0x1a2b3c4d ? BE : LE;
      ifaces = [];
    }

    const blockLen = e.u32(buf, off + 4);
    if (blockLen < 12 || off + blockLen > buf.length) break; // truncated tail

    const body = buf.subarray(off + 8, off + blockLen - 4);

    switch (blockType) {
      case BT_IDB:
        ifaces.push(readIdb(body, e));
        break;
      case BT_EPB: {
        const ifaceId = e.u32(body, 0);
        const iface = ifaces[ifaceId];
        if (iface) {
          const hi = BigInt(e.u32(body, 4));
          const lo = BigInt(e.u32(body, 8));
          const capLen = e.u32(body, 12);
          yield {
            tsUsec: (((hi << 32n) | lo) * 1_000_000n) / iface.ticksPerSecond,
            linkType: iface.linkType,
            data: body.subarray(20, 20 + capLen),
          };
        }
        break;
      }
      case BT_SPB: {
        // Simple packets carry no timestamp and no interface id at all.
        const iface = ifaces[0];
        if (iface) {
          yield { tsUsec: 0n, linkType: iface.linkType, data: body.subarray(4) };
        }
        break;
      }
      default:
        break;
    }

    off += blockLen;
  }
}

function readIdb(body: Buffer, e: Endian): Iface {
  const linkType = e.u16(body, 0);
  let ticksPerSecond = 1_000_000n;

  // Options follow the fixed 8-byte IDB body; if_tsresol (code 9) changes the
  // meaning of every timestamp on this interface, so it must be honoured.
  let off = 8;
  while (off + 4 <= body.length) {
    const code = e.u16(body, off);
    const len = e.u16(body, off + 2);
    if (code === 0) break; // opt_endofopt
    if (code === 9 && len >= 1) {
      const raw = body[off + 4] ?? 6;
      ticksPerSecond = (raw & 0x80) !== 0 ? 2n ** BigInt(raw & 0x7f) : 10n ** BigInt(raw & 0x7f);
    }
    off += 4 + len + ((4 - (len % 4)) % 4);
  }

  return { linkType, ticksPerSecond };
}

function* readClassicPcap(buf: Buffer): Generator<CapturedPacket> {
  const beMagic = buf.readUInt32BE(0);
  const e: Endian = beMagic === PCAP_MAGIC_USEC || beMagic === PCAP_MAGIC_NSEC ? BE : LE;
  const nanos = e.u32(buf, 0) === PCAP_MAGIC_NSEC;
  const linkType = e.u32(buf, 20);

  let off = 24;
  while (off + 16 <= buf.length) {
    const sec = BigInt(e.u32(buf, off));
    const frac = BigInt(e.u32(buf, off + 4));
    const capLen = e.u32(buf, off + 8);
    if (off + 16 + capLen > buf.length) break; // truncated tail
    yield {
      tsUsec: sec * 1_000_000n + (nanos ? frac / 1000n : frac),
      linkType,
      data: buf.subarray(off + 16, off + 16 + capLen),
    };
    off += 16 + capLen;
  }
}
