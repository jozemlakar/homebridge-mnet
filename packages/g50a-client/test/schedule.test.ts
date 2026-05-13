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
  it('decodes a populated event', () => {
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
    expect(event.driveEnabled).toBe(true);
    expect(event.modeEnabled).toBe(true);
    expect(event.setTempEnabled).toBe(true);
  });

  it('treats empty strings as "unset" (the on-the-wire encoding for default)', () => {
    const event = decodeWPatternRecord(
      {
        Index: '2',
        Hour: '17',
        Minute: '0',
        Drive: '',
        Mode: '',
        SetTemp: '',
        SetBack: '',
        DriveItem: '',
        ModeItem: '',
        SetTempItem: '',
      },
      2,
    );
    expect(event.drive).toBeUndefined();
    expect(event.mode).toBeUndefined();
    expect(event.setTemp).toBeUndefined();
    expect(event.setBack).toBeUndefined();
    expect(event.driveEnabled).toBe(false);
    expect(event.modeEnabled).toBe(false);
    expect(event.setTempEnabled).toBe(false);
  });

  it('falls back to provided index when the controller omits one', () => {
    expect(decodeWPatternRecord({ Hour: '10' }, 5).index).toBe(5);
  });
});

describe('encodeWPatternRecord', () => {
  it('round-trips through decode for a fully populated event', () => {
    const original: ScheduleEvent = {
      index: 1,
      hour: 6,
      minute: 30,
      drive: 'ON',
      mode: 'COOL',
      setTemp: 24,
      setBack: 28,
      driveEnabled: true,
      modeEnabled: true,
      setTempEnabled: true,
    };
    const encoded = encodeWPatternRecord(original);
    const decoded = decodeWPatternRecord(encoded, 1);
    expect(decoded).toEqual(original);
  });

  it('emits empty strings for unset fields', () => {
    const event: ScheduleEvent = {
      index: 1,
      hour: 17,
      minute: 0,
      driveEnabled: false,
      modeEnabled: false,
      setTempEnabled: false,
    };
    const encoded = encodeWPatternRecord(event);
    expect(encoded.Drive).toBe('');
    expect(encoded.Mode).toBe('');
    expect(encoded.SetTemp).toBe('');
    expect(encoded.SetBack).toBe('');
    expect(encoded.DriveItem).toBe('CHK_OFF');
    expect(encoded.ModeItem).toBe('CHK_OFF');
    expect(encoded.SetTempItem).toBe('CHK_OFF');
  });

  it('rounds SetTemp to one decimal place', () => {
    const event: ScheduleEvent = {
      index: 1,
      hour: 8,
      minute: 0,
      setTemp: 22.34,
      setTempEnabled: true,
      driveEnabled: false,
      modeEnabled: false,
    };
    expect(encodeWPatternRecord(event).SetTemp).toBe('22.3');
  });

  it('defaults to g50 family — emits SetBack, no AirDirection/FanSpeed', () => {
    const event: ScheduleEvent = {
      index: 1,
      hour: 6,
      minute: 0,
      drive: 'ON',
      driveEnabled: true,
      modeEnabled: false,
      setTempEnabled: false,
    };
    const e = encodeWPatternRecord(event);
    expect(e.SetBack).toBe('');
    expect(e.AirDirection).toBeUndefined();
    expect(e.FanSpeed).toBeUndefined();
  });

  it('ae200 family omits SetBack and adds empty AirDirection + FanSpeed', () => {
    const event: ScheduleEvent = {
      index: 1,
      hour: 6,
      minute: 0,
      drive: 'ON',
      driveEnabled: true,
      modeEnabled: false,
      setTempEnabled: false,
    };
    const e = encodeWPatternRecord(event, 'ae200');
    expect(e.SetBack).toBeUndefined();
    expect(e.AirDirection).toBe('');
    expect(e.FanSpeed).toBe('');
    // Sanity: AE-200 still carries the same core attrs.
    expect(e.Drive).toBe('ON');
    expect(e.DriveItem).toBe('CHK_ON');
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
      { index: 1, hour: 6, minute: 0, driveEnabled: true, drive: 'ON', modeEnabled: false, setTempEnabled: false },
      { index: 2, hour: 17, minute: 30, driveEnabled: false, modeEnabled: false, setTempEnabled: false },
      { index: 3, hour: 20, minute: 0, driveEnabled: true, drive: 'OFF', modeEnabled: false, setTempEnabled: false },
    ];
    expect(() => validateWeeklySchedule(s)).not.toThrow();
  });

  it('rejects events at the same time', () => {
    const s = emptyWeeklySchedule(1);
    s.tuesday = [
      { index: 1, hour: 6, minute: 0, driveEnabled: false, modeEnabled: false, setTempEnabled: false },
      { index: 2, hour: 6, minute: 0, driveEnabled: false, modeEnabled: false, setTempEnabled: false },
    ];
    expect(() => validateWeeklySchedule(s)).toThrow(/chronologically/);
  });

  it('rejects out-of-range hour', () => {
    const s = emptyWeeklySchedule(1);
    s.wednesday = [
      { index: 1, hour: 24, minute: 0, driveEnabled: false, modeEnabled: false, setTempEnabled: false },
    ];
    expect(() => validateWeeklySchedule(s)).toThrow(/hour/);
  });

  it('rejects out-of-range minute', () => {
    const s: WeeklySchedule = emptyWeeklySchedule(1);
    s.friday = [
      { index: 1, hour: 6, minute: 60, driveEnabled: false, modeEnabled: false, setTempEnabled: false },
    ];
    expect(() => validateWeeklySchedule(s)).toThrow(/minute/);
  });
});
