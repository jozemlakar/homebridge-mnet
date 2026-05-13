import { describe, expect, it } from 'vitest';
import { renderScheduleReport } from '../src/report.js';
import { emptyWeeklySchedule } from '../src/schedule.js';
import type { ScheduleEvent, WeeklySchedule } from '../src/types.js';

function schedule(group: number, build: (s: WeeklySchedule) => void): WeeklySchedule {
  const s = emptyWeeklySchedule(group);
  build(s);
  return s;
}

function event(hour: number, drive?: 'ON' | 'OFF', enabled = true): ScheduleEvent {
  const e: ScheduleEvent = {
    index: 1,
    hour,
    minute: 0,
    driveEnabled: enabled,
    modeEnabled: false,
    setTempEnabled: false,
  };
  if (drive) e.drive = drive;
  return e;
}

describe('renderScheduleReport', () => {
  it('produces a header with controller info when supplied', () => {
    const md = renderScheduleReport([], {
      controller: { model: 'G-50BA', version: '3.33', macAddress: 'AABBCCDDEEFF' },
      capturedAt: '2026-05-13',
    });
    expect(md).toContain('# Schedule report — G-50BA — fw 3.33');
    expect(md).toContain('MAC: AABBCCDDEEFF');
    expect(md).toContain('Captured: 2026-05-13');
  });

  it('summarises group and event counts', () => {
    const dump = [
      schedule(1, (s) => {
        s.monday = [event(4, 'ON')];
        s.tuesday = [event(4, 'ON')];
      }),
      schedule(2, () => {}),
    ];
    const md = renderScheduleReport(dump, { capturedAt: '2026-05-13' });
    expect(md).toMatch(/Total groups: \*\*2\*\*/);
    expect(md).toMatch(/Total events: \*\*2\*\*/);
    expect(md).toMatch(/Empty schedules: \*\*1\*\*/);
  });

  it('groups identical profiles together', () => {
    // Two groups with the same weekly schedule should appear in the same profile
    const dump = [
      schedule(1, (s) => {
        for (const d of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const) {
          s[d] = [event(4, 'ON')];
        }
      }),
      schedule(2, (s) => {
        for (const d of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const) {
          s[d] = [event(4, 'ON')];
        }
      }),
    ];
    const md = renderScheduleReport(dump);
    expect(md).toContain('2 groups sharing this profile');
    // Both groups should appear in the same table
    const profileBlock = md.split('### ')[1] ?? '';
    expect(profileBlock).toContain('| 1 |');
    expect(profileBlock).toContain('| 2 |');
  });

  it('collapses consecutive identical days into ranges', () => {
    const dump = [
      schedule(1, (s) => {
        // Mon..Fri identical, Sun and Sat different
        for (const d of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const) {
          s[d] = [event(4, 'ON')];
        }
      }),
    ];
    const md = renderScheduleReport(dump);
    expect(md).toContain('**Mon-Fri**: 04:00 [D] Drive=ON');
    expect(md).toContain('**Sun**: (empty)');
    expect(md).toContain('**Sat**: (empty)');
  });

  it('resolves group names from an array', () => {
    const dump = [schedule(1, (s) => (s.monday = [event(4, 'ON')]))];
    const md = renderScheduleReport(dump, {
      names: [{ group: 1, name: 'Living Room' }],
    });
    expect(md).toContain('| 1 | Living Room |');
  });

  it('resolves group names from a plain object map', () => {
    const dump = [schedule(7, (s) => (s.monday = [event(4, 'ON')]))];
    const md = renderScheduleReport(dump, { names: { '7': 'Kitchen' } });
    expect(md).toContain('| 7 | Kitchen |');
  });

  it('falls back to an em-dash for groups without a name', () => {
    const dump = [schedule(99, (s) => (s.monday = [event(4, 'ON')]))];
    const md = renderScheduleReport(dump, { names: [{ group: 1, name: 'Other' }] });
    expect(md).toContain('| 99 | — |');
  });

  it('renders empty schedules in a collapsible section', () => {
    const dump = [schedule(1, () => {}), schedule(2, () => {})];
    const md = renderScheduleReport(dump);
    expect(md).toContain('<details><summary>');
    expect(md).toContain('2 groups — empty schedule');
  });

  it('marks event flags correctly', () => {
    const dump = [
      schedule(1, (s) => {
        s.monday = [
          {
            index: 1,
            hour: 6,
            minute: 0,
            drive: 'ON',
            driveEnabled: true,
            modeEnabled: false,
            setTempEnabled: false,
          },
          {
            index: 2,
            hour: 18,
            minute: 30,
            drive: 'OFF',
            mode: 'COOL',
            setTemp: 22,
            driveEnabled: true,
            modeEnabled: true,
            setTempEnabled: true,
          },
        ];
      }),
    ];
    const md = renderScheduleReport(dump);
    expect(md).toContain('06:00 [D] Drive=ON');
    expect(md).toContain('18:30 [DMT] Drive=OFF Mode=COOL SetTemp=22');
  });
});
