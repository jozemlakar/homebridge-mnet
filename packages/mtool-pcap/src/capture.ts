import { readFileSync } from 'node:fs';

import { readPackets } from './pcapng.js';
import { reassemble, type TcpStream } from './tcp.js';

export interface Capture {
  streams: TcpStream[];
  packetCount: number;
}

/** Read a capture file and reassemble every TCP direction in it. */
export function loadCapture(path: string): Capture {
  const packets = [...readPackets(readFileSync(path))];
  return { streams: reassemble(packets), packetCount: packets.length };
}

/** Streams whose source or destination port matches, in first-byte order. */
export function streamsOnPort(capture: Capture, port: number): TcpStream[] {
  return capture.streams.filter((s) => s.srcPort === port || s.dstPort === port);
}

/**
 * Payload text of the matching streams, non-printables replaced with `.`.
 *
 * The substitution matters: raw bytes inside an otherwise textual body corrupt
 * downstream regexes (§8j). Each stream is separated by a newline so a record
 * can never appear to span two connections.
 */
export function textOnPort(capture: Capture, port: number): string {
  return streamsOnPort(capture, port)
    .map((s) => s.data.toString('latin1').replace(/[^\x20-\x7e\r\n]/g, '.'))
    .join('\n');
}
