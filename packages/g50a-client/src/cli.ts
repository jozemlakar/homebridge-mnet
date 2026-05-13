#!/usr/bin/env node
/**
 * g50a — small CLI on top of the protocol client.
 *
 * Subcommands:
 *   g50a state    --host <h> [--port P]
 *   g50a dump     --host <h> [--port P] [--group N] [-o file.json]
 *   g50a apply    --host <h> --in file.json [--dry-run]
 *   g50a report   --in file.json [--names names.json] [-o report.md]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { G50AClient } from './G50AClient.js';
import { renderScheduleReport, type NameLookup } from './report.js';
import type { WeeklySchedule } from './types.js';

interface Flags {
  host?: string;
  port?: number;
  group?: number;
  out?: string;
  in?: string;
  names?: string;
  title?: string;
  dryRun: boolean;
  pollIntervalMs?: number;
  /** MnetRouter destination address. */
  da?: number;
  /** Inter-command interval (ms) for MnetRouter requests. */
  intervalMs?: number;
  /** Memory bank id for `mnet-bank` subcommand (decimal or 0xNN). */
  bank?: number;
  /** Positional args left over after flag parsing — raw hex frames for `mnet-raw`. */
  positional: string[];
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = { dryRun: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    let key: string | undefined;
    let inlineVal: string | undefined;
    if (a.startsWith('--')) {
      [key, inlineVal] = a.slice(2).split('=', 2) as [string, string | undefined];
    } else if (a.startsWith('-') && a.length === 2) {
      key = a.slice(1);
    } else {
      f.positional.push(a);
      continue;
    }
    const take = (): string | undefined => {
      if (inlineVal !== undefined) return inlineVal;
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        i++;
        return next;
      }
      return undefined;
    };
    switch (key) {
      case 'host':
        f.host = take();
        break;
      case 'port':
        f.port = Number.parseInt(take() ?? '80', 10);
        break;
      case 'group':
        f.group = Number.parseInt(take() ?? '', 10);
        break;
      case 'out':
      case 'o':
        f.out = take();
        break;
      case 'in':
      case 'i':
        f.in = take();
        break;
      case 'names':
        f.names = take();
        break;
      case 'title':
        f.title = take();
        break;
      case 'dry-run':
        f.dryRun = true;
        break;
      case 'poll':
        f.pollIntervalMs = Number.parseInt(take() ?? '5000', 10);
        break;
      case 'da':
        f.da = Number.parseInt(take() ?? '', 10);
        break;
      case 'interval-ms':
        f.intervalMs = Number.parseInt(take() ?? '', 10);
        break;
      case 'bank': {
        const v = take() ?? '';
        f.bank = v.toLowerCase().startsWith('0x')
          ? Number.parseInt(v.slice(2), 16)
          : Number.parseInt(v, /^[0-9]+$/.test(v) ? 10 : 16);
        break;
      }
      default:
        // ignore unknown flags so subcommand args can fall through
        break;
    }
  }
  return f;
}

function usage(): void {
  process.stderr.write(
    [
      'Usage:',
      '  g50a state      --host <h> [--port P]',
      '  g50a dump       --host <h> [--port P] [--group N] [-o file.json]',
      '  g50a apply      --host <h> [--port P] --in file.json [--dry-run]',
      '  g50a report     --in file.json [--names names.json] [--title "..."] [-o report.md]',
      '  g50a topology   --host <h> [--port P]',
      '  g50a names      --host <h> [--port P] [-o names.json]',
      '  g50a alarms     --host <h> [--port P]',
      '  g50a today      --host <h> [--port P] --group N',
      '  g50a time       --host <h> [--port P]                # read controller clock',
      '  g50a time-sync  --host <h> [--port P] [--dry-run]    # write Mac local time to controller',
      '  g50a mnet-raw   --host <h> [--port P] --da N [--interval-ms 400] <hex> [<hex>...]',
      '  g50a mnet-bank  --host <h> [--port P] --da N --bank 0x80',
      '',
      'state    — print current state of every group',
      'dump     — read weekly schedule(s) and emit JSON (all groups by default)',
      'apply    — replace the weekly schedule(s) from a previous `dump` file',
      'report   — render a Markdown summary of a dump file (offline-only)',
      'topology — print the refrigerant-system topology (which devices share an OC)',
      'names    — read controller-side group names (LCD + Web)',
      'alarms   — list currently-active alarms across the controller',
      'today    — show the controller-computed schedule events for today for one group',
      'time     — read the controller real-time clock',
      'time-sync — set the controller clock to the host machine\'s local time',
      'mnet-raw  — send raw M-NET command frames to a unit via the controller',
      '            (e.g. `g50a mnet-raw --host 1.2.3.4 --da 66 397EF0 397EF1 3112`)',
      'mnet-bank — read one 16-byte memory bank from a unit',
      '            (e.g. `g50a mnet-bank --host 1.2.3.4 --da 66 --bank 0x80`)',
      '',
      'Schedules cover MnetGroupRecord Model="IC" units only. The JSON shape is',
      'the WeeklySchedule type exported by g50a-client.',
      '',
      'For `report`, the optional --names file is either an array of',
      '{group, name} objects (matching homebridge-mnet config) or a plain',
      'group→name object map.',
      '',
    ].join('\n'),
  );
}

async function withClient<T>(
  flags: Flags,
  fn: (c: G50AClient) => Promise<T>,
  options: { fullStart?: boolean } = {},
): Promise<T> {
  if (!flags.host) {
    process.stderr.write('Error: --host is required\n\n');
    usage();
    process.exit(2);
  }
  const opts = {
    host: flags.host,
    ...(flags.port !== undefined && { port: flags.port }),
    ...(flags.pollIntervalMs !== undefined && { pollIntervalMs: flags.pollIntervalMs }),
    // Long timeout for slow controllers (notably the older G-50BA's servlet).
    requestTimeoutMs: 60_000,
    // For dump/apply we don't need the running poll loop; set the interval high
    // and stop the client before it fires.
    pollIntervalMs: 60_000,
    logger: {
      info: (m: string) => process.stderr.write(`[info] ${m}\n`),
      warn: (m: string) => process.stderr.write(`[warn] ${m}\n`),
      error: (m: string) => process.stderr.write(`[error] ${m}\n`),
    },
  };
  const client = new G50AClient(opts);
  try {
    if (options.fullStart) {
      await client.start();
    } else {
      // Light start: just enough to populate getGroups() / getSystemInfo().
      // Avoids the bulk poll which takes ~30s on slow controllers.
      await client.refreshSystemInfo();
      await client.refreshGroupList();
    }
    return await fn(client);
  } finally {
    await client.stop();
  }
}

async function cmdState(flags: Flags): Promise<void> {
  await withClient(
    flags,
    async (client) => {
    const groups = client.getGroups();
    const sys = client.getSystemInfo();
    process.stdout.write(
      `Controller: ${sys?.model ?? '?'} fw ${sys?.version ?? '?'} (MAC ${sys?.macAddress ?? '?'})\n`,
    );
    process.stdout.write(`Groups: ${groups.length}\n`);
    process.stdout.write(
      'group | drive | mode      | setTemp | inletTemp | model\n--------------------------------------------------------------\n',
    );
    for (const g of groups) {
      const s = client.getState(g.group);
      const line =
        s !== undefined
          ? `${pad(g.group, 5)} | ${pad(s.drive, 5)} | ${pad(s.mode, 9)} | ${pad(s.setTemp, 7)} | ${pad(s.inletTemp, 9)} | ${g.model}\n`
          : `${pad(g.group, 5)} | (no state)\n`;
      process.stdout.write(line);
    }
    },
    { fullStart: true },
  );
}

async function cmdDump(flags: Flags): Promise<void> {
  await withClient(flags, async (client) => {
    const groups =
      flags.group !== undefined
        ? client.getGroups().filter((g) => g.group === flags.group)
        : client.getGroups();
    if (groups.length === 0) {
      process.stderr.write(`No IC groups found${flags.group !== undefined ? ` matching group ${flags.group}` : ''}\n`);
      process.exit(3);
    }
    const out: WeeklySchedule[] = [];
    for (const g of groups) {
      process.stderr.write(`[dump] reading group ${g.group}...\n`);
      out.push(await client.getWeeklySchedule(g.group));
    }
    const json = JSON.stringify(out, null, 2);
    if (flags.out) {
      writeFileSync(flags.out, json);
      process.stderr.write(`[dump] wrote ${out.length} schedule(s) to ${flags.out}\n`);
    } else {
      process.stdout.write(json + '\n');
    }
  });
}

async function cmdNames(flags: Flags): Promise<void> {
  await withClient(
    flags,
    async (client) => {
      const names = await client.getMnetList();
      if (flags.out) {
        writeFileSync(flags.out, JSON.stringify(names, null, 2));
        process.stderr.write(`[names] wrote ${names.length} entries to ${flags.out}\n`);
      } else {
        process.stdout.write('group | lcd        | web\n--------------------------------------------\n');
        for (const n of names) {
          process.stdout.write(`${pad(n.group, 5)} | ${pad(n.lcdName, 10)} | ${n.webName}\n`);
        }
      }
    },
    { fullStart: false },
  );
}

async function cmdAlarms(flags: Flags): Promise<void> {
  await withClient(
    flags,
    async (client) => {
      const alarms = await client.getAlarmStatusList();
      if (alarms.length === 0) {
        process.stdout.write('no active alarms\n');
        return;
      }
      process.stdout.write('address | group | model | code | detected\n----------------------------------------------------\n');
      for (const a of alarms) {
        process.stdout.write(
          `${pad(a.address, 7)} | ${pad(a.group ?? '—', 5)} | ${pad(a.model ?? '—', 5)} | ${pad(a.alarmCode, 5)} | ${a.detected ?? '—'}\n`,
        );
      }
    },
    { fullStart: false },
  );
}

async function cmdToday(flags: Flags): Promise<void> {
  if (flags.group === undefined) {
    process.stderr.write('Error: --group N is required for today\n');
    process.exit(2);
  }
  await withClient(
    flags,
    async (client) => {
      const events = await client.getTodayList(flags.group!);
      if (events.length === 0) {
        process.stdout.write(`group ${flags.group}: no events today\n`);
        return;
      }
      process.stdout.write(`group ${flags.group} — today's events:\n`);
      for (const e of events) {
        const flagStr =
          (e.driveEnabled ? 'D' : '') + (e.modeEnabled ? 'M' : '') + (e.setTempEnabled ? 'T' : '');
        const fields = [
          e.drive ? `Drive=${e.drive}` : '',
          e.mode ? `Mode=${e.mode}` : '',
          e.setTemp !== undefined ? `SetTemp=${e.setTemp}` : '',
        ]
          .filter(Boolean)
          .join(' ');
        process.stdout.write(
          `  ${pad2(e.hour)}:${pad2(e.minute)}${flagStr ? ` [${flagStr}]` : ''}${fields ? ' ' + fields : ''}\n`,
        );
      }
    },
    { fullStart: false },
  );
}

async function cmdTopology(flags: Flags): Promise<void> {
  await withClient(
    flags,
    async (client) => {
      const topology = await client.getTopology();
      const sys = client.getSystemInfo();
      process.stdout.write(
        `Controller: ${sys?.model ?? '?'} fw ${sys?.version ?? '?'}\n`,
      );
      process.stdout.write(`Devices on the M-NET bus: ${topology.records.length}\n`);
      process.stdout.write(`Outdoor systems (refrigerant loops): ${topology.outdoorSystems.length}\n\n`);
      for (const oc of topology.outdoorSystems) {
        const mixed = oc.supportsMixedMode ? '✓ mixed-mode (HR)' : '✗ single-mode only';
        const indoorAddrs = oc.indoor.map((i) => i.address).join(', ') || '—';
        const bcAddrs = oc.branchControllers.map((b) => b.address).join(', ') || '—';
        const bsAddrs = oc.branchSelectors.map((b) => b.address).join(', ') || '—';
        const otherAddrs = oc.other.map((o) => `${o.model}@${o.address}`).join(', ') || '—';
        process.stdout.write(`OC ${oc.ocAddress}   ${mixed}\n`);
        process.stdout.write(`  IC (${oc.indoor.length}): ${indoorAddrs}\n`);
        process.stdout.write(`  BC: ${bcAddrs}    BS: ${bsAddrs}\n`);
        if (oc.other.length > 0) process.stdout.write(`  Other: ${otherAddrs}\n`);
        process.stdout.write('\n');
      }
    },
    { fullStart: false },
  );
}

async function cmdTime(flags: Flags): Promise<void> {
  await withClient(
    flags,
    async (client) => {
      const t = await client.getClock();
      const iso = `${String(t.year).padStart(4, '0')}-${pad2(t.month)}-${pad2(t.day)}T${pad2(t.hour)}:${pad2(t.minute)}:${pad2(t.second)}`;
      process.stdout.write(`controller: ${iso}\n`);
      const host = new Date();
      const hostIso = `${host.getFullYear()}-${pad2(host.getMonth() + 1)}-${pad2(host.getDate())}T${pad2(host.getHours())}:${pad2(host.getMinutes())}:${pad2(host.getSeconds())}`;
      process.stdout.write(`host:       ${hostIso} (local)\n`);
      const drift =
        new Date(host.getFullYear(), t.month - 1, t.day, t.hour, t.minute, t.second).valueOf() -
        host.valueOf();
      process.stdout.write(`drift:      ${Math.round(drift / 1000)}s (controller - host)\n`);
    },
    { fullStart: false },
  );
}

async function cmdTimeSync(flags: Flags): Promise<void> {
  const now = new Date();
  const reading = {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
    hour: now.getHours(),
    minute: now.getMinutes(),
    second: now.getSeconds(),
  };
  const iso = `${reading.year}-${pad2(reading.month)}-${pad2(reading.day)}T${pad2(reading.hour)}:${pad2(reading.minute)}:${pad2(reading.second)}`;
  if (flags.dryRun) {
    process.stderr.write(`[dry-run] would set controller clock to ${iso}\n`);
    return;
  }
  await withClient(
    flags,
    async (client) => {
      await client.setClock(reading);
      const readback = await client.getClock();
      const readbackIso = `${String(readback.year).padStart(4, '0')}-${pad2(readback.month)}-${pad2(readback.day)}T${pad2(readback.hour)}:${pad2(readback.minute)}:${pad2(readback.second)}`;
      process.stderr.write(`[time-sync] set controller clock to ${iso}\n`);
      process.stderr.write(`[time-sync] readback: ${readbackIso}\n`);
    },
    { fullStart: false },
  );
}

async function cmdReport(flags: Flags): Promise<void> {
  if (!flags.in) {
    process.stderr.write('Error: --in <dump.json> is required for report\n\n');
    usage();
    process.exit(2);
  }
  const dump = JSON.parse(readFileSync(flags.in, 'utf8')) as WeeklySchedule[];
  if (!Array.isArray(dump)) {
    process.stderr.write('Error: input file must be a JSON array of WeeklySchedule\n');
    process.exit(3);
  }
  let names: NameLookup | undefined;
  if (flags.names) {
    names = JSON.parse(readFileSync(flags.names, 'utf8')) as NameLookup;
  }
  const md = renderScheduleReport(dump, {
    ...(flags.title !== undefined && { title: flags.title }),
    ...(names !== undefined && { names }),
  });
  if (flags.out) {
    writeFileSync(flags.out, md);
    process.stderr.write(`[report] wrote ${md.length} bytes to ${flags.out}\n`);
  } else {
    process.stdout.write(md + '\n');
  }
}

async function cmdApply(flags: Flags): Promise<void> {
  if (!flags.in) {
    process.stderr.write('Error: --in <file.json> is required for apply\n\n');
    usage();
    process.exit(2);
  }
  const raw = readFileSync(flags.in, 'utf8');
  const parsed = JSON.parse(raw) as WeeklySchedule | WeeklySchedule[];
  const schedules = Array.isArray(parsed) ? parsed : [parsed];
  if (flags.dryRun) {
    process.stderr.write(`[dry-run] would write ${schedules.length} schedule(s):\n`);
    for (const s of schedules) summarize(s);
    return;
  }
  await withClient(flags, async (client) => {
    for (const s of schedules) {
      process.stderr.write(`[apply] writing group ${s.group}...\n`);
      await client.setWeeklySchedule(s);
    }
    process.stderr.write(`[apply] wrote ${schedules.length} schedule(s)\n`);
  });
}

function summarize(s: WeeklySchedule): void {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
  process.stderr.write(`  group ${s.group}:\n`);
  for (const d of days) {
    const events = s[d];
    if (events.length === 0) {
      process.stderr.write(`    ${d}: (empty)\n`);
      continue;
    }
    const summary = events
      .map((e) => `${pad2(e.hour)}:${pad2(e.minute)}${e.drive ? `→${e.drive}` : ''}`)
      .join(', ');
    process.stderr.write(`    ${d}: ${summary}\n`);
  }
}

async function cmdMnetRaw(flags: Flags): Promise<void> {
  if (flags.da === undefined || !Number.isFinite(flags.da)) {
    process.stderr.write('Error: mnet-raw requires --da <address>\n');
    process.exit(2);
  }
  if (flags.positional.length === 0) {
    process.stderr.write('Error: mnet-raw needs at least one hex frame, e.g. 397EF0\n');
    process.exit(2);
  }
  await withClient(flags, async (client) => {
    const replies = await client.sendMnetRaw(flags.da!, flags.positional, {
      ...(flags.intervalMs !== undefined && { commandIntervalMs: flags.intervalMs }),
    });
    for (const r of replies) {
      process.stdout.write(`${r.data} -> ${r.reply || '(no reply)'}\n`);
    }
  });
}

async function cmdMnetBank(flags: Flags): Promise<void> {
  if (flags.da === undefined || !Number.isFinite(flags.da)) {
    process.stderr.write('Error: mnet-bank requires --da <address>\n');
    process.exit(2);
  }
  if (flags.bank === undefined || !Number.isFinite(flags.bank)) {
    process.stderr.write('Error: mnet-bank requires --bank <0x00..0xFF>\n');
    process.exit(2);
  }
  await withClient(flags, async (client) => {
    const bytes = await client.readMnetBank(flags.da!, flags.bank!);
    const hex = Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    process.stdout.write(`DA=${flags.da} bank=0x${flags.bank!.toString(16).toUpperCase().padStart(2, '0')}: ${hex}\n`);
  });
}

function pad(v: unknown, w: number): string {
  const s = String(v);
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  const flags = parseFlags(rest);
  switch (cmd) {
    case 'state':
      await cmdState(flags);
      break;
    case 'dump':
      await cmdDump(flags);
      break;
    case 'apply':
      await cmdApply(flags);
      break;
    case 'report':
      await cmdReport(flags);
      break;
    case 'topology':
      await cmdTopology(flags);
      break;
    case 'names':
      await cmdNames(flags);
      break;
    case 'alarms':
      await cmdAlarms(flags);
      break;
    case 'today':
      await cmdToday(flags);
      break;
    case 'time':
      await cmdTime(flags);
      break;
    case 'time-sync':
      await cmdTimeSync(flags);
      break;
    case 'mnet-raw':
      await cmdMnetRaw(flags);
      break;
    case 'mnet-bank':
      await cmdMnetBank(flags);
      break;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;
    default:
      process.stderr.write(`Unknown subcommand: ${cmd}\n\n`);
      usage();
      process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
