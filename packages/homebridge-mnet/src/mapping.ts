/**
 * Pure HK ↔ M-NET mapping. No HAP runtime imports here — the service layer
 * is responsible for plugging these values into characteristics.
 *
 * HAP characteristic value tables (HeaterCooler service):
 *  - Active                        0 = INACTIVE, 1 = ACTIVE
 *  - CurrentHeaterCoolerState      0 = INACTIVE, 1 = IDLE, 2 = HEATING, 3 = COOLING
 *  - TargetHeaterCoolerState       0 = AUTO,     1 = HEAT, 2 = COOL
 *  - SwingMode                     0 = DISABLED, 1 = ENABLED
 */
import type {
  AirDirection,
  Drive,
  FanSpeed,
  FanSpeedCapability,
  GroupState,
  Mode,
} from 'g50a-client';

export const HK = {
  Active: { INACTIVE: 0, ACTIVE: 1 } as const,
  CurrentHeaterCoolerState: { INACTIVE: 0, IDLE: 1, HEATING: 2, COOLING: 3 } as const,
  TargetHeaterCoolerState: { AUTO: 0, HEAT: 1, COOL: 2 } as const,
  SwingMode: { DISABLED: 0, ENABLED: 1 } as const,
};

export type HKActive = 0 | 1;
export type HKCurrent = 0 | 1 | 2 | 3;
export type HKTarget = 0 | 1 | 2;
export type HKSwing = 0 | 1;

// ---------------------------------------------------------------------------
// Active ↔ Drive
// ---------------------------------------------------------------------------

export function hkActiveFromDrive(drive: Drive): HKActive {
  return drive === 'ON' ? HK.Active.ACTIVE : HK.Active.INACTIVE;
}

export function driveFromHkActive(active: HKActive): Drive {
  return active === HK.Active.ACTIVE ? 'ON' : 'OFF';
}

// ---------------------------------------------------------------------------
// TargetHeaterCoolerState ↔ Mode
// ---------------------------------------------------------------------------

export function hkTargetFromMode(mode: Mode): HKTarget {
  switch (mode) {
    case 'HEAT':
    case 'AUTOHEAT':
    case 'PANEHEAT':
      return HK.TargetHeaterCoolerState.HEAT;
    case 'COOL':
    case 'AUTOCOOL':
    case 'PANECOOL':
    case 'OUTCOOL':
      return HK.TargetHeaterCoolerState.COOL;
    case 'AUTO':
    case 'LC_AUTO':
    default:
      // DRY / FAN / BAHP / BYPASS / DEFROST / HEATRECOVERY / VENTILATE
      // all surface as AUTO target until v0.2 introduces dedicated services
      return HK.TargetHeaterCoolerState.AUTO;
  }
}

export function modeFromHkTarget(target: HKTarget): Mode {
  switch (target) {
    case HK.TargetHeaterCoolerState.HEAT:
      return 'HEAT';
    case HK.TargetHeaterCoolerState.COOL:
      return 'COOL';
    case HK.TargetHeaterCoolerState.AUTO:
    default:
      return 'AUTO';
  }
}

// ---------------------------------------------------------------------------
// CurrentHeaterCoolerState — derived from (Drive, Mode, SetTemp vs InletTemp)
// ---------------------------------------------------------------------------

/**
 * What the unit is *actually doing* right now, distinct from what the user
 * told it to do. The HAP characteristic reflects this. We don't have a direct
 * "compressor engaged" signal, so we infer from the live `Mode` reported by
 * the controller (which already encodes AUTOCOOL / AUTOHEAT for AUTO mode)
 * combined with whether the room temperature has crossed the setpoint.
 */
export function hkCurrentFromState(state: GroupState): HKCurrent {
  if (state.drive !== 'ON') return HK.CurrentHeaterCoolerState.INACTIVE;

  // The controller emits AUTOCOOL/AUTOHEAT inside AUTO mode when the
  // compressor is actively cooling/heating — most reliable signal.
  if (state.mode === 'AUTOCOOL' || state.mode === 'COOL' || state.mode === 'PANECOOL') {
    return state.inletTemp > state.setTemp
      ? HK.CurrentHeaterCoolerState.COOLING
      : HK.CurrentHeaterCoolerState.IDLE;
  }
  if (state.mode === 'AUTOHEAT' || state.mode === 'HEAT' || state.mode === 'PANEHEAT') {
    return state.inletTemp < state.setTemp
      ? HK.CurrentHeaterCoolerState.HEATING
      : HK.CurrentHeaterCoolerState.IDLE;
  }
  // AUTO without a directional sub-mode, plus FAN/DRY/etc.: best effort idle.
  return HK.CurrentHeaterCoolerState.IDLE;
}

// ---------------------------------------------------------------------------
// Threshold temperatures ↔ SetTemp
// ---------------------------------------------------------------------------

export interface HkThresholds {
  cooling: number;
  heating: number;
}

/**
 * Expose the single `setTemp` to HomeKit as either one specific threshold (in
 * COOL/HEAT mode) or two thresholds bracketing the setpoint by ±deadband/2
 * (in AUTO mode). HomeKit lets the user manipulate either threshold; the
 * setter resolution lives in {@link setTempFromHkThresholds}.
 */
export function hkThresholdsFromState(state: GroupState, deadbandC: number): HkThresholds {
  const target = hkTargetFromMode(state.mode);
  if (target === HK.TargetHeaterCoolerState.AUTO) {
    return {
      cooling: round1(state.setTemp + deadbandC / 2),
      heating: round1(state.setTemp - deadbandC / 2),
    };
  }
  return { cooling: state.setTemp, heating: state.setTemp };
}

/**
 * Compute the `SetTemp` value to write given the HomeKit target mode and the
 * two threshold characteristics. In AUTO mode HK sends both; we collapse to
 * their midpoint and round to the unit's resolution.
 */
export function setTempFromHkThresholds(
  target: HKTarget,
  cooling: number,
  heating: number,
  tempDetail: boolean,
): number {
  const resolution = tempDetail ? 0.5 : 1.0;
  if (target === HK.TargetHeaterCoolerState.COOL) return roundTo(cooling, resolution);
  if (target === HK.TargetHeaterCoolerState.HEAT) return roundTo(heating, resolution);
  return roundTo((cooling + heating) / 2, resolution);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function roundTo(n: number, step: number): number {
  return Math.round(n / step) * step;
}

// ---------------------------------------------------------------------------
// RotationSpeed ↔ FanSpeed
// ---------------------------------------------------------------------------

/**
 * Buckets used for both directions. The controller can report `AUTO`, but on
 * the HomeKit side we show the bucket the unit is currently *running at* (we
 * never write AUTO from HomeKit — that's a v0.2 separate-Switch feature).
 *
 * For `AUTO`, we report the median position (50). The user can override by
 * sliding to a specific bucket; we round to the nearest valid stage for the
 * unit's capability.
 */
export function hkRotationFromFanSpeed(fan: FanSpeed): number {
  switch (fan) {
    case 'LOW':
      return 25;
    case 'MID1':
      return 50;
    case 'MID2':
      return 75;
    case 'HIGH':
      return 100;
    case 'AUTO':
    default:
      return 50;
  }
}

export function fanSpeedFromHkRotation(rotation: number, cap: FanSpeedCapability): FanSpeed {
  const clamped = Math.max(0, Math.min(100, rotation));
  switch (cap) {
    case 'NONE':
      // No fan control — stick with HIGH so a slider drag still does something.
      return 'HIGH';
    case '2STAGES':
      return clamped < 50 ? 'LOW' : 'HIGH';
    case '3STAGES':
      if (clamped < 33) return 'LOW';
      if (clamped < 67) return 'MID1';
      return 'HIGH';
    case '4STAGES':
    default:
      if (clamped < 25) return 'LOW';
      if (clamped < 50) return 'MID1';
      if (clamped < 75) return 'MID2';
      return 'HIGH';
  }
}

// ---------------------------------------------------------------------------
// SwingMode ↔ AirDirection
// ---------------------------------------------------------------------------

export function hkSwingFromAirDirection(dir: AirDirection): HKSwing {
  return dir === 'SWING' ? HK.SwingMode.ENABLED : HK.SwingMode.DISABLED;
}

/**
 * When swing is disabled, restore (or keep) AUTO; HomeKit doesn't expose the
 * individual louver positions, so we don't preserve them on toggle.
 */
export function airDirectionFromHkSwing(swing: HKSwing): AirDirection {
  return swing === HK.SwingMode.ENABLED ? 'SWING' : 'AUTO';
}
