import type { GroupState } from 'g50a-client';
import { describe, expect, it } from 'vitest';
import {
  airDirectionFromHkSwing,
  driveFromHkActive,
  fanSpeedFromHkRotation,
  HK,
  hkActiveFromDrive,
  hkCurrentFromState,
  hkRotationFromFanSpeed,
  hkSwingFromAirDirection,
  hkTargetFromMode,
  hkThresholdsFromState,
  modeFromHkTarget,
  setTempFromHkThresholds,
} from '../src/mapping.js';

function makeState(overrides: Partial<GroupState>): GroupState {
  return {
    drive: 'OFF',
    mode: 'AUTO',
    setTemp: 22,
    inletTemp: 21,
    fanSpeed: 'AUTO',
    fanSpeedCapability: '4STAGES',
    airDirection: 'AUTO',
    airStageCapability: '4STAGES',
    tempLimits: { coolMin: 16, coolMax: 31, heatMin: 16, heatMax: 31, autoMin: 16, autoMax: 31 },
    tempDetail: true,
    raw: {},
    ...overrides,
  };
}

describe('Active ↔ Drive', () => {
  it('round-trips ON/OFF', () => {
    expect(hkActiveFromDrive('ON')).toBe(HK.Active.ACTIVE);
    expect(hkActiveFromDrive('OFF')).toBe(HK.Active.INACTIVE);
    expect(hkActiveFromDrive('TESTRUN')).toBe(HK.Active.INACTIVE);
    expect(driveFromHkActive(HK.Active.ACTIVE)).toBe('ON');
    expect(driveFromHkActive(HK.Active.INACTIVE)).toBe('OFF');
  });
});

describe('TargetHeaterCoolerState ↔ Mode', () => {
  it('handles direct modes', () => {
    expect(hkTargetFromMode('HEAT')).toBe(HK.TargetHeaterCoolerState.HEAT);
    expect(hkTargetFromMode('COOL')).toBe(HK.TargetHeaterCoolerState.COOL);
    expect(hkTargetFromMode('AUTO')).toBe(HK.TargetHeaterCoolerState.AUTO);
  });

  it('treats AUTOCOOL/AUTOHEAT as the cardinal direction (HomeKit has no sub-mode)', () => {
    expect(hkTargetFromMode('AUTOCOOL')).toBe(HK.TargetHeaterCoolerState.COOL);
    expect(hkTargetFromMode('AUTOHEAT')).toBe(HK.TargetHeaterCoolerState.HEAT);
  });

  it('surfaces DRY/FAN/etc as AUTO until v0.2 adds dedicated services', () => {
    expect(hkTargetFromMode('DRY')).toBe(HK.TargetHeaterCoolerState.AUTO);
    expect(hkTargetFromMode('FAN')).toBe(HK.TargetHeaterCoolerState.AUTO);
    expect(hkTargetFromMode('BAHP')).toBe(HK.TargetHeaterCoolerState.AUTO);
  });

  it('reverse mapping', () => {
    expect(modeFromHkTarget(HK.TargetHeaterCoolerState.HEAT)).toBe('HEAT');
    expect(modeFromHkTarget(HK.TargetHeaterCoolerState.COOL)).toBe('COOL');
    expect(modeFromHkTarget(HK.TargetHeaterCoolerState.AUTO)).toBe('AUTO');
  });
});

describe('CurrentHeaterCoolerState', () => {
  it('reports INACTIVE when Drive is OFF', () => {
    expect(hkCurrentFromState(makeState({ drive: 'OFF', mode: 'HEAT' }))).toBe(
      HK.CurrentHeaterCoolerState.INACTIVE,
    );
  });

  it('reports HEATING when in HEAT and below setpoint', () => {
    expect(hkCurrentFromState(makeState({ drive: 'ON', mode: 'HEAT', inletTemp: 20, setTemp: 22 }))).toBe(
      HK.CurrentHeaterCoolerState.HEATING,
    );
  });

  it('reports IDLE when in HEAT and at/above setpoint', () => {
    expect(hkCurrentFromState(makeState({ drive: 'ON', mode: 'HEAT', inletTemp: 23, setTemp: 22 }))).toBe(
      HK.CurrentHeaterCoolerState.IDLE,
    );
  });

  it('reports COOLING when in COOL and above setpoint', () => {
    expect(hkCurrentFromState(makeState({ drive: 'ON', mode: 'COOL', inletTemp: 26, setTemp: 22 }))).toBe(
      HK.CurrentHeaterCoolerState.COOLING,
    );
  });

  it('reports IDLE in AUTO without a sub-mode hint', () => {
    expect(hkCurrentFromState(makeState({ drive: 'ON', mode: 'AUTO' }))).toBe(
      HK.CurrentHeaterCoolerState.IDLE,
    );
  });
});

describe('Threshold temperatures', () => {
  it('returns a single setpoint in HEAT mode', () => {
    const t = hkThresholdsFromState(makeState({ mode: 'HEAT', setTemp: 22 }), 2);
    expect(t.cooling).toBe(22);
    expect(t.heating).toBe(22);
  });

  it('returns a single setpoint in COOL mode', () => {
    const t = hkThresholdsFromState(makeState({ mode: 'COOL', setTemp: 24 }), 2);
    expect(t.cooling).toBe(24);
    expect(t.heating).toBe(24);
  });

  it('brackets the setpoint by ±deadband/2 in AUTO mode', () => {
    const t = hkThresholdsFromState(makeState({ mode: 'AUTO', setTemp: 22 }), 2);
    expect(t.cooling).toBe(23);
    expect(t.heating).toBe(21);
  });

  it('writes the cooling threshold directly in COOL mode (rounded to 0.5)', () => {
    expect(setTempFromHkThresholds(HK.TargetHeaterCoolerState.COOL, 23.3, 21, true)).toBe(23.5);
  });

  it('writes the heating threshold directly in HEAT mode', () => {
    expect(setTempFromHkThresholds(HK.TargetHeaterCoolerState.HEAT, 23, 21.4, true)).toBe(21.5);
  });

  it('collapses to the midpoint in AUTO mode', () => {
    expect(setTempFromHkThresholds(HK.TargetHeaterCoolerState.AUTO, 24, 20, true)).toBe(22);
  });

  it('rounds to 1.0 when tempDetail is false', () => {
    expect(setTempFromHkThresholds(HK.TargetHeaterCoolerState.AUTO, 24, 21, false)).toBe(23);
  });
});

describe('FanSpeed ↔ RotationSpeed', () => {
  it('maps fan speeds to canonical RotationSpeed positions', () => {
    expect(hkRotationFromFanSpeed('LOW')).toBe(25);
    expect(hkRotationFromFanSpeed('MID1')).toBe(50);
    expect(hkRotationFromFanSpeed('MID2')).toBe(75);
    expect(hkRotationFromFanSpeed('HIGH')).toBe(100);
    expect(hkRotationFromFanSpeed('AUTO')).toBe(50);
  });

  it('buckets RotationSpeed into 4 stages by default', () => {
    expect(fanSpeedFromHkRotation(10, '4STAGES')).toBe('LOW');
    expect(fanSpeedFromHkRotation(30, '4STAGES')).toBe('MID1');
    expect(fanSpeedFromHkRotation(60, '4STAGES')).toBe('MID2');
    expect(fanSpeedFromHkRotation(90, '4STAGES')).toBe('HIGH');
  });

  it('respects 2-stage capability', () => {
    expect(fanSpeedFromHkRotation(30, '2STAGES')).toBe('LOW');
    expect(fanSpeedFromHkRotation(70, '2STAGES')).toBe('HIGH');
  });

  it('respects 3-stage capability', () => {
    expect(fanSpeedFromHkRotation(20, '3STAGES')).toBe('LOW');
    expect(fanSpeedFromHkRotation(50, '3STAGES')).toBe('MID1');
    expect(fanSpeedFromHkRotation(80, '3STAGES')).toBe('HIGH');
  });
});

describe('SwingMode ↔ AirDirection', () => {
  it('reports ENABLED only when the unit is swinging', () => {
    expect(hkSwingFromAirDirection('SWING')).toBe(HK.SwingMode.ENABLED);
    expect(hkSwingFromAirDirection('AUTO')).toBe(HK.SwingMode.DISABLED);
    expect(hkSwingFromAirDirection('HORIZONTAL')).toBe(HK.SwingMode.DISABLED);
  });

  it('toggles between SWING and AUTO; does not preserve fixed louver positions', () => {
    expect(airDirectionFromHkSwing(HK.SwingMode.ENABLED)).toBe('SWING');
    expect(airDirectionFromHkSwing(HK.SwingMode.DISABLED)).toBe('AUTO');
  });
});
