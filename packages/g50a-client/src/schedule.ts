/**
 * Schedule (ScheduleControl) encode / decode helpers.
 *
 * G-50A / GB-50A firmware uses a `WPatternList Group="N" Pattern="P"` query
 * where `Pattern` is the day-of-week index (1=Sunday, 2=Monday, …, 7=Saturday).
 * Each `WPatternRecord` is one event in that day's timeline.
 *
 * EW-50E / AE-200 firmware adds a `Season="N"` dimension to `WPatternList`
 * and changes a few `WPatternRecord` fields — see `encodeWPatternRecord` and
 * `wPatternListAttrs` for the per-family encoding.
 *
 * The controller's wire format uses empty strings (`Drive=""`, `DriveItem=""`)
 * for unset fields. We translate those to `undefined`/`false` on read and back
 * to empty strings on write so the public API is well-typed.
 *
 * See docs/g50a-protocol.md §6a for the full schema.
 */
import type { FirmwareFamily } from './firmware.js';
import type {
  DayOfWeek,
  Drive,
  Mode,
  ScheduleEvent,
  WeeklySchedule,
} from './types.js';

/**
 * Day-of-week → Pattern attribute value. Verified against a live G-50BA where
 * Pattern 2..6 carried a Mon–Fri working-week schedule and TodayList for a
 * Tuesday matched the Pattern 3 contents.
 */
const PATTERN_BY_DAY: Record<DayOfWeek, number> = {
  sunday: 1,
  monday: 2,
  tuesday: 3,
  wednesday: 4,
  thursday: 5,
  friday: 6,
  saturday: 7,
};

const DAY_BY_PATTERN: Record<number, DayOfWeek> = {
  1: 'sunday',
  2: 'monday',
  3: 'tuesday',
  4: 'wednesday',
  5: 'thursday',
  6: 'friday',
  7: 'saturday',
};

export const DAYS_OF_WEEK: DayOfWeek[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

export function patternFromDay(day: DayOfWeek): number {
  return PATTERN_BY_DAY[day];
}

export function dayFromPattern(pattern: number): DayOfWeek {
  const day = DAY_BY_PATTERN[pattern];
  if (!day) throw new RangeError(`Pattern ${pattern} is out of range 1..7`);
  return day;
}

// ---------------------------------------------------------------------------
// Wire-shaped record (matches what fast-xml-parser emits)
// ---------------------------------------------------------------------------

export interface WPatternRecordEl {
  Index?: string;
  Hour?: string;
  Minute?: string;
  Drive?: string;
  Mode?: string;
  SetTemp?: string;
  /** g50 family only — accepted on G-50A/GB-50A, rejected on AE-200/EW-50. */
  SetBack?: string;
  /** ae200 family only — required on writes. */
  AirDirection?: string;
  /** ae200 family — accepted on writes. */
  FanSpeed?: string;
  DriveItem?: string;
  ModeItem?: string;
  SetTempItem?: string;
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

const ITEM_ON = 'CHK_ON';

/**
 * `*Item` flags use `CHK_ON` / `CHK_OFF` to indicate whether the event applies
 * the field. Some firmware also returns an empty string for un-checked events;
 * we treat anything that isn't `CHK_ON` as disabled.
 */
function decodeItem(value: string | undefined): boolean {
  return value === ITEM_ON;
}

function decodeValueString(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  return value;
}

function decodeNumber(value: string | undefined): number | undefined {
  const s = decodeValueString(value);
  if (s === undefined) return undefined;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}

function decodeInt(value: string | undefined, fallback: number): number {
  const s = decodeValueString(value);
  if (s === undefined) return fallback;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function decodeWPatternRecord(el: WPatternRecordEl, fallbackIndex: number): ScheduleEvent {
  const event: ScheduleEvent = {
    index: decodeInt(el.Index, fallbackIndex),
    hour: decodeInt(el.Hour, 0),
    minute: decodeInt(el.Minute, 0),
    driveEnabled: decodeItem(el.DriveItem),
    modeEnabled: decodeItem(el.ModeItem),
    setTempEnabled: decodeItem(el.SetTempItem),
  };
  const drive = decodeValueString(el.Drive) as Drive | undefined;
  if (drive !== undefined) event.drive = drive;
  const mode = decodeValueString(el.Mode) as Mode | undefined;
  if (mode !== undefined) event.mode = mode;
  const setTemp = decodeNumber(el.SetTemp);
  if (setTemp !== undefined) event.setTemp = setTemp;
  const setBack = decodeNumber(el.SetBack);
  if (setBack !== undefined) event.setBack = setBack;
  return event;
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

/**
 * Build the attribute bag for a `<WPatternRecord/>` write.
 *
 * - `g50` family emits `SetBack`. `AirDirection` is omitted.
 * - `ae200` family omits `SetBack` (controller rejects it) and includes
 *   `AirDirection` + `FanSpeed` (controller requires `AirDirection`,
 *   tolerates `FanSpeed`). Empty strings are acceptable for both — the
 *   controller treats them as "no change" since `*Item` flags gate firing.
 *
 * All other fields are always emitted (empty strings for unset ones) —
 * matches the format observed on the wire from both G-50BA fw 3.33 and
 * EW-50E fw 7.70.
 */
export function encodeWPatternRecord(
  event: ScheduleEvent,
  family: FirmwareFamily = 'g50',
): WPatternRecordEl {
  const base: WPatternRecordEl = {
    Index: String(event.index),
    Hour: String(event.hour),
    Minute: String(event.minute),
    Drive: event.drive ?? '',
    Mode: event.mode ?? '',
    SetTemp: event.setTemp !== undefined ? formatTemp(event.setTemp) : '',
    DriveItem: event.driveEnabled ? 'CHK_ON' : 'CHK_OFF',
    ModeItem: event.modeEnabled ? 'CHK_ON' : 'CHK_OFF',
    SetTempItem: event.setTempEnabled ? 'CHK_ON' : 'CHK_OFF',
  };
  if (family === 'ae200') {
    base.AirDirection = '';
    base.FanSpeed = '';
  } else {
    base.SetBack = event.setBack !== undefined ? formatTemp(event.setBack) : '';
  }
  return base;
}

/**
 * Build the attribute bag for a `<WPatternList>` element on a given firmware
 * family. The `g50` shape carries only `Group` and `Pattern`; the `ae200`
 * shape also carries `Season` (omitting it on ae200 silently returns empty
 * data on reads and is rejected on writes).
 */
export function wPatternListAttrs(
  group: number,
  pattern: number,
  family: FirmwareFamily,
  season = 1,
): Record<string, string> {
  const attrs: Record<string, string> = {
    Group: String(group),
    Pattern: String(pattern),
  };
  if (family === 'ae200') {
    attrs['Season'] = String(season);
  }
  return attrs;
}

function formatTemp(c: number): string {
  return (Math.round(c * 10) / 10).toFixed(1);
}

// ---------------------------------------------------------------------------
// WeeklySchedule helpers
// ---------------------------------------------------------------------------

export function emptyWeeklySchedule(group: number): WeeklySchedule {
  return {
    group,
    sunday: [],
    monday: [],
    tuesday: [],
    wednesday: [],
    thursday: [],
    friday: [],
    saturday: [],
  };
}

/**
 * Quick validator: do all event timestamps fit (hour 0..23, minute 0..59)
 * and are events ordered chronologically within each day?
 */
export function validateWeeklySchedule(s: WeeklySchedule): void {
  for (const day of DAYS_OF_WEEK) {
    const events = s[day];
    let last = -1;
    for (const e of events) {
      if (e.hour < 0 || e.hour > 23)
        throw new RangeError(`${day} event ${e.index}: hour ${e.hour} out of range 0..23`);
      if (e.minute < 0 || e.minute > 59)
        throw new RangeError(`${day} event ${e.index}: minute ${e.minute} out of range 0..59`);
      const stamp = e.hour * 60 + e.minute;
      if (stamp <= last)
        throw new RangeError(
          `${day} events must be chronologically ordered (event ${e.index} at ${e.hour}:${pad2(
            e.minute,
          )} not after previous at ${minutesToTime(last)})`,
        );
      last = stamp;
    }
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function minutesToTime(m: number): string {
  return `${Math.floor(m / 60)}:${pad2(m % 60)}`;
}
