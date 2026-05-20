import { describe, expect, it } from 'vitest';
import { detectFirmwareFamily } from '../src/firmware.js';
import {
  DAYS_OF_WEEK,
  dayFromPattern,
  decodeWPatternRecord,
  emptyWeeklySchedule,
  encodeWPatternRecord,
  patternFromDay,
  validateWeeklySchedule,
  wPatternListAttrs,
} from '../src/schedule.js';
import type { ScheduleEvent, WeeklySchedule } from '../src/types.js';

describe('day-of-week ↔ Pattern mapping', () => {
  it('uses Sunday=1, Saturday=7 (Japan/ISO convention)', () => {
    expect(patternFromDay('sunday')).toBe(1);
    expect(patternFromDay('monday')).toBe(2);
    expect(patternFromDay('saturday')).toBe(7);
    expect(dayFromPattern(1)).toBe('sunday');
    expect(dayFromPattern(7)).toBe('saturday');
  });

  it('rejects out-of-range patterns', () => {
    expect(() => dayFromPattern(0)).toThrow(RangeError);
    expect(() => dayFromPattern(8)).toThrow(RangeError);
  });
});

describe('decodeWPatternRecord', () => {
  it('decodes a populated event with prohibit-set on every attribute', () => {
    // `*Item="CHK_ON"` on the wire == this event SETS prohibit on the IC's
    // wall remote for that attribute (NOT "this event fires this attribute").
    const event = decodeWPatternRecord(
      {
        Index: '1',
        Hour: '6',
        Minute: '0',
        Drive: 'ON',
        Mode: 'HEAT',
        SetTemp: '22.5',
        SetBack: '18.0',
        DriveItem: 'CHK_ON',
        ModeItem: 'CHK_ON',
        SetTempItem: 'CHK_ON',
      },
      1,
    );
    expect(event.index).toBe(1);
    expect(event.hour).toBe(6);
    expect(event.minute).toBe(0);
    expect(event.drive).toBe('ON');
    expect(event.mode).toBe('HEAT');
    expect(event.setTemp).toBe(22.5);
    expect(event.setBack).toBe(18);
    expect(event.driveProhibit).toBe('set');
    expect(event.modeProhibit).toBe('set');
    expect(event.setTempProhibit).toBe('set');
  });

  it('decodes a prohibit-release event (Drive empty + DriveItem=CHK_OFF)', () => {
    // Matches the AE-2000 / web-UI "release prohibit" event shape.
    const event = decodeWPatternRecord(
      {
        Index: '1',
        Hour: '19',
        Minute: '10',
        Drive: '',
        Mode: '',
        SetTemp: '',
        DriveItem: 'CHK_OFF',
        ModeItem: '',
        SetTempItem: '',
      },
      1,
    );
    expect(event.drive).toBeUndefined();
    expect(event.driveProhibit).toBe('release');
    expect(event.modeProhibit).toBeUndefined();
    expect(event.setTempProhibit).toBeUndefined();
  });

  it('treats empty *Item strings as "no prohibit interaction"', () => {
    // The shape observed on the well-behaved :82 g3 schedule.
    const event = decodeWPatternRecord(
      {
        Index: '1',
        Hour: '7',
        Minute: '0',
        Drive: 'ON',
        Mode: 'COOL',
        DriveItem: '',
        ModeItem: '',
        SetTempItem: '',
      },
      1,
    );
    expect(event.drive).toBe('ON');
    expect(event.mode).toBe('COOL');
    expect(event.driveProhibit).toBeUndefined();
    expect(event.modeProhibit).toBeUndefined();
    expect(event.setTempProhibit).toBeUndefined();
  });

  it('falls back to provided index when the controller omits one', () => {
    expect(decodeWPatternRecord({ Hour: '10' }, 5).index).toBe(5);
  });
});

describe('encodeWPatternRecord', () => {
  it('round-trips through decode for a fully populated event with prohibit-set', () => {
    const original: ScheduleEvent = {
      index: 1,
      hour: 6,
      minute: 30,
      drive: 'ON',
      mode: 'COOL',
      setTemp: 24,
      setBack: 28,
      driveProhibit: 'set',
      modeProhibit: 'set',
      setTempProhibit: 'set',
    };
    const encoded = encodeWPatternRecord(original);
    const decoded = decodeWPatternRecord(encoded, 1);
    expect(decoded).toEqual(original);
  });

  it('emits empty strings for *Item when no prohibit toggle is set', () => {
    // This is the safe default — matches :82 g3 working schedule shape.
    // Previously this test asserted `CHK_OFF`, which was the bug that caused
    // central-control lockout on every event fire.
    const event: ScheduleEvent = {
      index: 1,
      hour: 17,
      minute: 0,
    };
    const encoded = encodeWPatternRecord(event);
    expect(encoded.Drive).toBe('');
    expect(encoded.Mode).toBe('');
    expect(encoded.SetTemp).toBe('');
    expect(encoded.SetBack).toBe('');
    expect(encoded.DriveItem).toBe('');
    expect(encoded.ModeItem).toBe('');
    expect(encoded.SetTempItem).toBe('');
  });

  it('rounds SetTemp to one decimal place', () => {
    const event: ScheduleEvent = { index: 1, hour: 8, minute: 0, setTemp: 22.34 };
    expect(encodeWPatternRecord(event).SetTemp).toBe('22.3');
  });

  it('defaults to g50 family — emits SetBack, no AirDirection/FanSpeed', () => {
    const event: ScheduleEvent = { index: 1, hour: 6, minute: 0, drive: 'ON' };
    const e = encodeWPatternRecord(event);
    expect(e.SetBack).toBe('');
    expect(e.AirDirection).toBeUndefined();
    expect(e.FanSpeed).toBeUndefined();
    expect(e.DriveItem).toBe(''); // safe default
  });

  it('ae200 family omits SetBack and adds empty AirDirection + FanSpeed', () => {
    const event: ScheduleEvent = { index: 1, hour: 6, minute: 0, drive: 'ON' };
    const e = encodeWPatternRecord(event, 'ae200');
    expect(e.SetBack).toBeUndefined();
    expect(e.AirDirection).toBe('');
    expect(e.FanSpeed).toBe('');
    expect(e.Drive).toBe('ON');
    expect(e.DriveItem).toBe(''); // safe default — no prohibit pushed
  });

  it('encodes an explicit prohibit-release event (the AE-2000 unlock pattern)', () => {
    const event: ScheduleEvent = {
      index: 1,
      hour: 19,
      minute: 10,
      driveProhibit: 'release',
    };
    const e = encodeWPatternRecord(event);
    expect(e.Drive).toBe('');
    expect(e.DriveItem).toBe('CHK_OFF');
    expect(e.ModeItem).toBe('');
    expect(e.SetTempItem).toBe('');
  });
});

describe('wPatternListAttrs', () => {
  it('emits only Group + Pattern on g50 family', () => {
    expect(wPatternListAttrs(5, 2, 'g50')).toEqual({ Group: '5', Pattern: '2' });
  });

  it('adds Season=1 by default on ae200 family', () => {
    expect(wPatternListAttrs(5, 2, 'ae200')).toEqual({ Group: '5', Pattern: '2', Season: '1' });
  });

  it('respects an explicit season override', () => {
    expect(wPatternListAttrs(5, 2, 'ae200', 3)).toEqual({ Group: '5', Pattern: '2', Season: '3' });
  });
});

describe('detectFirmwareFamily', () => {
  it('classifies G-50 family models', () => {
    expect(detectFirmwareFamily('G-50A')).toBe('g50');
    expect(detectFirmwareFamily('GB-50A')).toBe('g50');
    expect(detectFirmwareFamily('G-50B')).toBe('g50');
    expect(detectFirmwareFamily('G-50BA')).toBe('g50');
  });

  it('classifies AE-200 / EW-50 family models', () => {
    expect(detectFirmwareFamily('AE-200')).toBe('ae200');
    expect(detectFirmwareFamily('AE-200E')).toBe('ae200');
    expect(detectFirmwareFamily('EW-50')).toBe('ae200');
    expect(detectFirmwareFamily('EW-50E')).toBe('ae200');
  });

  it('falls back to prefix match for unknown but family-shaped strings', () => {
    expect(detectFirmwareFamily('AE-500')).toBe('ae200');
    expect(detectFirmwareFamily('EW-99X')).toBe('ae200');
  });

  it('defaults to g50 on missing / unrecognised models', () => {
    expect(detectFirmwareFamily(undefined)).toBe('g50');
    expect(detectFirmwareFamily('')).toBe('g50');
    expect(detectFirmwareFamily('Mystery')).toBe('g50');
  });
});

describe('emptyWeeklySchedule', () => {
  it('returns a schedule with all days populated as empty arrays', () => {
    const s = emptyWeeklySchedule(7);
    expect(s.group).toBe(7);
    for (const day of DAYS_OF_WEEK) {
      expect(s[day]).toEqual([]);
    }
  });
});

describe('validateWeeklySchedule', () => {
  it('accepts an empty schedule', () => {
    expect(() => validateWeeklySchedule(emptyWeeklySchedule(1))).not.toThrow();
  });

  it('accepts chronologically ordered events', () => {
    const s = emptyWeeklySchedule(1);
    s.monday = [
      { index: 1, hour: 6, minute: 0, drive: 'ON' },
      { index: 2, hour: 17, minute: 30 },
      { index: 3, hour: 20, minute: 0, drive: 'OFF' },
    ];
    expect(() => validateWeeklySchedule(s)).not.toThrow();
  });

  it('rejects events at the same time', () => {
    const s = emptyWeeklySchedule(1);
    s.tuesday = [
      { index: 1, hour: 6, minute: 0 },
      { index: 2, hour: 6, minute: 0 },
    ];
    expect(() => validateWeeklySchedule(s)).toThrow(/chronologically/);
  });

  it('rejects out-of-range hour', () => {
    const s = emptyWeeklySchedule(1);
    s.wednesday = [
      { index: 1, hour: 24, minute: 0 },
    ];
    expect(() => validateWeeklySchedule(s)).toThrow(/hour/);
  });

  it('rejects out-of-range minute', () => {
    const s: WeeklySchedule = emptyWeeklySchedule(1);
    s.friday = [
      { index: 1, hour: 6, minute: 60 },
    ];
    expect(() => validateWeeklySchedule(s)).toThrow(/minute/);
  });
});
