#!/usr/bin/env node
/**
 * mtool-pcap — offline analysis of MainteToolNet / G-50A captures.
 *
 * Usage:
 *   mtool-pcap streams <cap>                    who talked to whom
 *   mtool-pcap subs    <cap>                    subscription list, per DA
 *   mtool-pcap trend   <cap> [--da N] [--op X]  trend-push rows
 *   mtool-pcap queries <cap> [--da N]           synchronous MnetRouter pairs
 *   mtool-pcap banks   <cap>                    DA x opcode matrix
 *   mtool-pcap text    <cap> --port N           reassembled stream text
 */

import { loadCapture, streamsOnPort, textOnPort } from './capture.js';
import { formatTime } from './tcp.js';
import { parseQueries, parseSubscriptions, parseTrendPushes } from './mtool.js';

interface Args {
  command: string;
  path: string;
  da?: number;
  op?: string;
  port?: number;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string>();

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else flags.set(a.slice(2), argv[++i] ?? '');
    } else {
      positional.push(a);
    }
  }

  const [command, path] = positional;
  if (!command || !path) {
    process.stderr.write(`${usage()}\n`);
    process.exit(2);
  }

  const da = flags.get('da');
  const port = flags.get('port');
  return {
    command,
    path,
    ...(da !== undefined ? { da: Number(da) } : {}),
    ...(flags.has('op') ? { op: flags.get('op')!.toUpperCase() } : {}),
    ...(port !== undefined ? { port: Number(port) } : {}),
  };
}

function usage(): string {
  return [
    'mtool-pcap <streams|subs|trend|queries|banks|text> <capture.pcapng> [options]',
    '  --da N     restrict to one M-NET address',
    '  --op HEX   restrict to frames whose opcode starts with HEX (e.g. 39FE, 19FF)',
    '  --port N   TCP port, for `text`',
  ].join('\n');
}

const args = parseArgs(process.argv.slice(2));
const capture = loadCapture(args.path);

switch (args.command) {
  case 'streams':
    cmdStreams();
    break;
  case 'subs':
    cmdSubs();
    break;
  case 'trend':
    cmdTrend();
    break;
  case 'queries':
    cmdQueries();
    break;
  case 'banks':
    cmdBanks();
    break;
  case 'text':
    process.stdout.write(textOnPort(capture, args.port ?? 80));
    break;
  default:
    process.stderr.write(`unknown command '${args.command}'\n${usage()}\n`);
    process.exit(2);
}

function cmdStreams(): void {
  process.stdout.write(
    `${capture.packetCount} packets, ${capture.streams.length} TCP directions\n\n`,
  );
  const rows = capture.streams
    .map((s) => ({
      label: `${s.src}:${s.srcPort} > ${s.dst}:${s.dstPort}`,
      bytes: s.data.length,
      segs: s.segmentCount,
      gaps: s.gaps.length,
      first: s.marks.length > 0 ? formatTime(s.marks[0]!.tsUsec) : '-',
    }))
    .sort((a, b) => b.bytes - a.bytes);

  for (const r of rows) {
    process.stdout.write(
      `${r.label.padEnd(46)} ${String(r.bytes).padStart(8)} B  ${String(r.segs).padStart(4)} seg` +
        `${r.gaps > 0 ? `  ${r.gaps} GAP` : ''}  first ${r.first}\n`,
    );
  }
}

function cmdSubs(): void {
  const subs = parseSubscriptions(textOnPort(capture, 80));
  if (subs.length === 0) {
    process.stdout.write(
      'no SendCommandRecord in this capture — the monitor panel was already open\n' +
        'before it started. Reopen the panel while capturing to see the subscription.\n',
    );
    return;
  }
  const byDa = new Map<number, string[]>();
  for (const s of subs) {
    if (args.da !== undefined && s.da !== args.da) continue;
    const list = byDa.get(s.da) ?? [];
    if (!list.includes(s.data)) list.push(s.data);
    byDa.set(s.da, list);
  }
  for (const da of [...byDa.keys()].sort((a, b) => a - b)) {
    process.stdout.write(`DA ${String(da).padStart(3)}  ${byDa.get(da)!.join(' ')}\n`);
  }
}

function cmdTrend(): void {
  for (const stream of streamsOnPort(capture, 25)) {
    const text = stream.data.toString('latin1').replace(/[^\x20-\x7e\r\n]/g, '.');
    for (const push of parseTrendPushes(text)) {
      process.stdout.write(`# ${push.requestId ?? '?'} interval=${push.sendInterval ?? '?'}s\n`);
      for (const row of push.rows) {
        if (args.da !== undefined && row.da !== args.da) continue;
        if (args.op && !row.hex.startsWith(args.op)) continue;
        const da = row.da === null ? '   ' : String(row.da).padStart(3);
        process.stdout.write(`${row.time}\t${da}\t${row.hex || row.note}\n`);
      }
    }
  }
}

function cmdQueries(): void {
  for (const stream of streamsOnPort(capture, 80)) {
    const text = stream.data.toString('latin1').replace(/[^\x20-\x7e\r\n]/g, '.');
    for (const q of parseQueries(text)) {
      if (args.da !== undefined && q.da !== args.da) continue;
      if (args.op && !q.data.startsWith(args.op)) continue;
      if (q.rcvData === '*') continue; // request leg; the response carries the data
      process.stdout.write(`DA ${String(q.da).padStart(3)}\t${q.data}\t${q.rcvData}\n`);
    }
  }
}

/**
 * Which opcodes were seen per unit, whether they arrived over the trend push or
 * a synchronous query. This answers the same question as `subs` on a capture
 * that missed the subscription setup.
 */
function cmdBanks(): void {
  const seen = new Map<number, Map<string, number>>();

  const note = (da: number | null, hex: string): void => {
    if (da === null || hex.length < 6) return;
    const opcode = hex.slice(0, 6);
    const perDa = seen.get(da) ?? new Map<string, number>();
    perDa.set(opcode, (perDa.get(opcode) ?? 0) + 1);
    seen.set(da, perDa);
  };

  for (const stream of streamsOnPort(capture, 25)) {
    const text = stream.data.toString('latin1').replace(/[^\x20-\x7e\r\n]/g, '.');
    for (const push of parseTrendPushes(text)) {
      for (const row of push.rows) note(row.da, row.hex);
    }
  }
  for (const q of parseQueries(textOnPort(capture, 80))) {
    if (/^[0-9A-F]+$/.test(q.rcvData)) note(q.da, q.rcvData);
  }

  for (const da of [...seen.keys()].sort((a, b) => a - b)) {
    if (args.da !== undefined && da !== args.da) continue;
    const perDa = seen.get(da)!;
    const opcodes = [...perDa.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([op, n]) => `${op}${n > 1 ? `x${n}` : ''}`);
    process.stdout.write(`DA ${String(da).padStart(3)}  ${opcodes.join(' ')}\n`);
  }
}
