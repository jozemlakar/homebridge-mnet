/**
 * Render a Markdown summary of a controller's weekly schedules.
 *
 * The renderer is offline-only — it takes a previously-captured dump (as
 * produced by `g50a dump`) plus an optional mapping of group number → display
 * name, and emits a Markdown document grouping schedules by identical profile.
 *
 * Use cases:
 *  - Backup documentation when archiving a TG-2000A-managed install.
 *  - Diff two dumps over time to spot drift.
 *  - Audit a building's schedules in one glance.
 */
import type { DayOfWeek, ScheduleEvent, WeeklySchedule } from './types.js';

const DAYS: DayOfWeek[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

const DAY_LABEL: Record<DayOfWeek, string> = {
  sunday: 'Sun',
  monday: 'Mon',
  tuesday: 'Tue',
  wednesday: 'Wed',
  thursday: 'Thu',
  friday: 'Fri',
  saturday: 'Sat',
};

export interface GroupNameEntry {
  group: number;
  name: string;
}

export type NameLookup = GroupNameEntry[] | Record<string, string>;

export interface ReportOptions {
  /** Optional title for the report (default: derived from controller info). */
  title?: string;
  /** Optional controller info to surface in the header. */
  controller?: { model?: string; version?: string; macAddress?: string };
  /** Optional ISO date string included in the header (default: today). */
  capturedAt?: string;
  /** Group-number → display-name mapping. */
  names?: NameLookup;
}

/**
 * Render a Markdown report for a single controller's worth of schedules.
 *
 * The schedules are grouped by identical weekly profile; each profile is
 * rendered once with the list of groups sharing it. Consecutive identical
 * days are collapsed (e.g. "Mon-Fri" rather than five separate lines).
 */
export function renderScheduleReport(schedules: WeeklySchedule[], opts: ReportOptions = {}): string {
  const lookup = normalizeNames(opts.names);
  const out: string[] = [];

  const title = opts.title ?? defaultTitle(opts.controller);
  out.push(`# ${title}`);
  out.push('');
  const meta: string[] = [];
  if (opts.controller?.model) {
    meta.push(`Model: ${opts.controller.model}${opts.controller.version ? ` fw ${opts.controller.version}` : ''}`);
  }
  if (opts.controller?.macAddress) meta.push(`MAC: ${opts.controller.macAddress}`);
  meta.push(`Captured: ${opts.capturedAt ?? new Date().toISOString().slice(0, 10)}`);
  out.push(meta.join(' · '));
  out.push('');

  // Legend
  out.push('## Legend');
  out.push('');
  out.push("Events are written `HH:MM[flags] field=value …`. Flag letters mark which `*Item` enable flags are CHK_ON for this event:");
  out.push('');
  out.push('- `D` — Drive change fires');
  out.push('- `M` — Mode change fires');
  out.push('- `T` — SetTemp change fires');
  out.push('');
  out.push("Events without a flag bracket are placeholder slots (`*Item=CHK_OFF` / empty) — stored but inert when they fire.");
  out.push('');

  // Per-controller summary
  const total = schedules.length;
  const eventTotal = schedules.reduce((n, s) => n + DAYS.reduce((m, d) => m + s[d].length, 0), 0);
  const empty = schedules.filter((s) => DAYS.every((d) => s[d].length === 0));
  out.push(`## Summary`);
  out.push('');
  out.push(`- Total groups: **${total}**`);
  out.push(`- Total events: **${eventTotal}**`);
  out.push(`- Empty schedules: **${empty.length}** · populated: **${total - empty.length}**`);
  out.push('');

  // Group by identical weekly profile, sort by descending size
  const byProfile = new Map<string, WeeklySchedule[]>();
  for (const s of schedules) {
    const key = weeklyProfileKey(s);
    const bucket = byProfile.get(key) ?? [];
    bucket.push(s);
    byProfile.set(key, bucket);
  }
  const profiles = [...byProfile.values()].sort((a, b) => b.length - a.length);

  for (const bucket of profiles) {
    const first = bucket[0]!;
    const isEmpty = DAYS.every((d) => first[d].length === 0);

    if (isEmpty) {
      out.push(`<details><summary><b>${bucket.length} groups — empty schedule</b></summary>`);
      out.push('');
      out.push('| Group | Name |');
      out.push('|---|---|');
      for (const s of bucket) {
        out.push(`| ${s.group} | ${lookupName(lookup, s.group) ?? '—'} |`);
      }
      out.push('');
      out.push('</details>');
      out.push('');
      continue;
    }

    out.push(`### ${bucket.length} group${bucket.length === 1 ? '' : 's'} sharing this profile`);
    out.push('');
    out.push('| Group | Name |');
    out.push('|---|---|');
    for (const s of bucket) {
      out.push(`| ${s.group} | ${lookupName(lookup, s.group) ?? '—'} |`);
    }
    out.push('');
    out.push('Weekly events:');
    out.push('');
    out.push(renderWeeklyCompact(first));
    out.push('');
  }

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function defaultTitle(c: ReportOptions['controller']): string {
  if (!c) return 'Schedule report';
  const bits = ['Schedule report'];
  if (c.model) bits.push(c.model);
  if (c.version) bits.push(`fw ${c.version}`);
  return bits.join(' — ');
}

function normalizeNames(input: NameLookup | undefined): Record<string, string> {
  if (!input) return {};
  if (Array.isArray(input)) {
    const map: Record<string, string> = {};
    for (const entry of input) {
      if (entry && typeof entry.group === 'number' && typeof entry.name === 'string') {
        map[String(entry.group)] = entry.name;
      }
    }
    return map;
  }
  return input;
}

function lookupName(map: Record<string, string>, group: number): string | undefined {
  return map[String(group)];
}

function fmtEvent(e: ScheduleEvent): string {
  const t = `${pad2(e.hour)}:${pad2(e.minute)}`;
  const flags: string[] = [];
  if (e.driveEnabled) flags.push('D');
  if (e.modeEnabled) flags.push('M');
  if (e.setTempEnabled) flags.push('T');
  const flagStr = flags.length ? ` [${flags.join('')}]` : '';
  const bits: string[] = [];
  if (e.drive) bits.push(`Drive=${e.drive}`);
  if (e.mode) bits.push(`Mode=${e.mode}`);
  if (e.setTemp !== undefined) bits.push(`SetTemp=${e.setTemp}`);
  if (e.setBack !== undefined) bits.push(`SetBack=${e.setBack}`);
  return `${t}${flagStr}${bits.length ? ' ' + bits.join(' ') : ''}`;
}

function fmtDay(events: ScheduleEvent[]): string {
  if (events.length === 0) return '(empty)';
  return events.map(fmtEvent).join('; ');
}

function dayProfileKey(events: ScheduleEvent[]): string {
  return events
    .map(
      (e) =>
        `${e.hour}:${e.minute}|${e.drive ?? ''}|${e.mode ?? ''}|${e.setTemp ?? ''}|${e.setBack ?? ''}|${e.driveEnabled ? 1 : 0}${e.modeEnabled ? 1 : 0}${e.setTempEnabled ? 1 : 0}`,
    )
    .join(',');
}

function weeklyProfileKey(s: WeeklySchedule): string {
  return DAYS.map((d) => dayProfileKey(s[d])).join('||');
}

function renderWeeklyCompact(s: WeeklySchedule): string {
  const lines: string[] = [];
  let i = 0;
  while (i < DAYS.length) {
    let j = i + 1;
    const key = dayProfileKey(s[DAYS[i]!]);
    while (j < DAYS.length && dayProfileKey(s[DAYS[j]!]) === key) j++;
    const range =
      i === j - 1 ? DAY_LABEL[DAYS[i]!] : `${DAY_LABEL[DAYS[i]!]}-${DAY_LABEL[DAYS[j - 1]!]}`;
    lines.push(`- **${range}**: ${fmtDay(s[DAYS[i]!])}`);
    i = j;
  }
  return lines.join('\n');
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
