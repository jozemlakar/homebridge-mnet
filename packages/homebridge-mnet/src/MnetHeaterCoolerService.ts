import type { GroupState, GroupStatePatch, FanSpeedCapability } from 'g50a-client';
import type {
  API,
  Characteristic as CharacteristicNS,
  CharacteristicValue,
  Logger,
  PlatformAccessory,
  Service,
} from 'homebridge';
import {
  HK,
  airDirectionFromHkSwing,
  driveFromHkActive,
  fanSpeedFromHkRotation,
  hkActiveFromDrive,
  hkCurrentFromState,
  hkRotationFromFanSpeed,
  hkSwingFromAirDirection,
  hkTargetFromMode,
  hkThresholdsFromState,
  modeFromHkTarget,
  setTempFromHkThresholds,
  type HKActive,
  type HKSwing,
  type HKTarget,
} from './mapping.js';

const SET_DEBOUNCE_MS = 250;

export interface ServiceOptions {
  accessory: PlatformAccessory;
  api: API;
  log: Logger;
  group: number;
  /** Auto-mode threshold deadband in °C. */
  autoModeDeadbandC: number;
  /** Async sink for state changes (the platform-level G50AClient.setState). */
  pushPatch: (group: number, patch: GroupStatePatch) => void;
}

/**
 * Per-group HeaterCooler service. Wires HAP characteristic getters/setters to
 * a cached `GroupState`. Getters always return synchronously from cache;
 * setters push patches into a 250 ms debouncer that fans out to the client.
 *
 * The client itself has its own 150 ms coalescing window — together they
 * absorb both HomeKit's per-user-action characteristic bursts and Home-app
 * scene applies hitting multiple groups simultaneously.
 */
export class MnetHeaterCoolerService {
  private readonly service: Service;
  private readonly log: Logger;
  private readonly group: number;
  private readonly autoModeDeadbandC: number;
  private readonly pushPatch: ServiceOptions['pushPatch'];
  private readonly Characteristic: typeof CharacteristicNS;

  private state: GroupState | undefined;
  private pendingPatch: GroupStatePatch = {};
  private debounceTimer: NodeJS.Timeout | null = null;
  /**
   * When true, characteristic getters throw — HomeKit reads that as
   * "No Response" and dims the accessory tile. Set by the platform when the
   * client enters transport backoff after repeated controller failures.
   */
  private faulted = false;

  constructor(opts: ServiceOptions) {
    this.log = opts.log;
    this.group = opts.group;
    this.autoModeDeadbandC = opts.autoModeDeadbandC;
    this.pushPatch = opts.pushPatch;
    this.Characteristic = opts.api.hap.Characteristic;

    const HeaterCooler = opts.api.hap.Service.HeaterCooler;
    const Characteristic = this.Characteristic;

    this.service =
      opts.accessory.getService(HeaterCooler) ?? opts.accessory.addService(HeaterCooler);

    this.service
      .getCharacteristic(Characteristic.Active)
      .onGet(() => this.guard(this.state ? hkActiveFromDrive(this.state.drive) : HK.Active.INACTIVE))
      .onSet((v) => this.handleActive(v));

    this.service
      .getCharacteristic(Characteristic.CurrentHeaterCoolerState)
      .onGet(() =>
        this.guard(
          this.state ? hkCurrentFromState(this.state) : HK.CurrentHeaterCoolerState.INACTIVE,
        ),
      );

    this.service
      .getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .onGet(() =>
        this.guard(this.state ? hkTargetFromMode(this.state.mode) : HK.TargetHeaterCoolerState.AUTO),
      )
      .onSet((v) => this.handleTarget(v));

    this.service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.guard(this.state?.inletTemp ?? 20));

    this.service
      .getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .onGet(() => this.guard(this.thresholds().cooling))
      .onSet((v) => this.handleThreshold('cooling', v));

    this.service
      .getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .onGet(() => this.guard(this.thresholds().heating))
      .onSet((v) => this.handleThreshold('heating', v));

    this.service
      .getCharacteristic(Characteristic.RotationSpeed)
      .onGet(() =>
        this.guard(this.state ? hkRotationFromFanSpeed(this.state.fanSpeed) : 50),
      )
      .onSet((v) => this.handleRotationSpeed(v));

    this.service
      .getCharacteristic(Characteristic.SwingMode)
      .onGet(() =>
        this.guard(
          this.state ? hkSwingFromAirDirection(this.state.airDirection) : HK.SwingMode.DISABLED,
        ),
      )
      .onSet((v) => this.handleSwing(v));
  }

  /**
   * Pass-through for getter values that throws if the accessory is currently
   * faulted. HAP-NodeJS converts a thrown error into a HAP "Communication
   * Error" status code, which HomeKit surfaces as "No Response" on the tile.
   */
  private guard<T>(value: T): T {
    if (this.faulted) {
      // hap-nodejs's HapStatusError isn't trivially importable from the plain
      // 'homebridge' API surface; throwing any Error works — HAP-NodeJS maps
      // it to SERVICE_COMMUNICATION_FAILURE.
      throw new Error('Controller unreachable');
    }
    return value;
  }

  /**
   * Push a freshly-observed state. Updates the synchronous getter cache and
   * pushes `updateCharacteristic` for the changed fields only.
   */
  applyState(next: GroupState, changed: (keyof GroupState)[]): void {
    const Characteristic = this.Characteristic;
    const previousMode = this.state?.mode;
    this.state = next;

    if (changed.includes('drive')) {
      this.service.updateCharacteristic(Characteristic.Active, hkActiveFromDrive(next.drive));
    }
    if (changed.includes('mode') || changed.includes('drive')) {
      this.service.updateCharacteristic(
        Characteristic.CurrentHeaterCoolerState,
        hkCurrentFromState(next),
      );
    }
    if (changed.includes('mode')) {
      this.service.updateCharacteristic(
        Characteristic.TargetHeaterCoolerState,
        hkTargetFromMode(next.mode),
      );
    }
    if (changed.includes('inletTemp')) {
      this.service.updateCharacteristic(Characteristic.CurrentTemperature, next.inletTemp);
      // Inlet crossing the setpoint may flip CurrentHeaterCoolerState
      // (idle ↔ heating/cooling) even when Mode hasn't changed.
      this.service.updateCharacteristic(
        Characteristic.CurrentHeaterCoolerState,
        hkCurrentFromState(next),
      );
    }
    if (changed.includes('setTemp') || changed.includes('mode')) {
      const t = hkThresholdsFromState(next, this.autoModeDeadbandC);
      this.service.updateCharacteristic(Characteristic.CoolingThresholdTemperature, t.cooling);
      this.service.updateCharacteristic(Characteristic.HeatingThresholdTemperature, t.heating);
    }
    if (changed.includes('fanSpeed')) {
      this.service.updateCharacteristic(Characteristic.RotationSpeed, hkRotationFromFanSpeed(next.fanSpeed));
    }
    if (changed.includes('airDirection')) {
      this.service.updateCharacteristic(Characteristic.SwingMode, hkSwingFromAirDirection(next.airDirection));
    }
    if (changed.includes('tempLimits') || previousMode !== next.mode) {
      this.applyThresholdLimits();
    }
  }

  /**
   * Mark the accessory as faulted in HomeKit. While faulted, characteristic
   * getters throw, which surfaces as "No Response" on the tile in the Home
   * app. Once cleared, the next state update repopulates values normally.
   */
  setFault(faulted: boolean): void {
    this.faulted = faulted;
  }

  // ---------------------------------------------------------------------------
  // setter handlers (all return immediately; debounced flush)
  // ---------------------------------------------------------------------------

  private handleActive(value: CharacteristicValue): void {
    const active = (value as number) as HKActive;
    // Drive bypasses the debouncer for snappy on/off, but we still merge with
    // any pending patch in case the user also changed mode in the same gesture.
    this.pendingPatch.drive = driveFromHkActive(active);
    this.flushNow();
  }

  private handleTarget(value: CharacteristicValue): void {
    const target = (value as number) as HKTarget;
    this.pendingPatch.mode = modeFromHkTarget(target);
    this.scheduleFlush();
  }

  private handleThreshold(which: 'cooling' | 'heating', value: CharacteristicValue): void {
    if (!this.state) return;
    const target = hkTargetFromMode(this.pendingPatch.mode ?? this.state.mode);
    const current = hkThresholdsFromState(this.state, this.autoModeDeadbandC);
    const next = { ...current, [which]: value as number };
    this.pendingPatch.setTemp = setTempFromHkThresholds(
      target,
      next.cooling,
      next.heating,
      this.state.tempDetail,
    );
    this.scheduleFlush();
  }

  private handleRotationSpeed(value: CharacteristicValue): void {
    const cap: FanSpeedCapability = this.state?.fanSpeedCapability ?? '4STAGES';
    this.pendingPatch.fanSpeed = fanSpeedFromHkRotation(value as number, cap);
    this.scheduleFlush();
  }

  private handleSwing(value: CharacteristicValue): void {
    const swing = (value as number) as HKSwing;
    this.pendingPatch.airDirection = airDirectionFromHkSwing(swing);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flushNow(), SET_DEBOUNCE_MS);
  }

  private flushNow(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (Object.keys(this.pendingPatch).length === 0) return;
    const patch = this.pendingPatch;
    this.pendingPatch = {};
    this.log.debug(`[group ${this.group}] pushing patch ${JSON.stringify(patch)}`);
    this.pushPatch(this.group, patch);
  }

  // ---------------------------------------------------------------------------
  // misc
  // ---------------------------------------------------------------------------

  private thresholds(): { cooling: number; heating: number } {
    if (!this.state) return { cooling: 22, heating: 22 };
    return hkThresholdsFromState(this.state, this.autoModeDeadbandC);
  }

  private applyThresholdLimits(): void {
    if (!this.state) return;
    const Characteristic = this.Characteristic;
    const t = this.state.tempLimits;
    // The bulk reports limits only on capable units. When zero (G-50A/GB-50A
    // omit them), fall back to 16-31 °C — the range Mitsubishi IC indoor units
    // accept across both heat and cool modes. HAP's default for the heating
    // threshold is 0-25, which would cap users below the controller's real
    // limit; the cooling default of 10-35 is harmless but we override for
    // symmetry.
    const DEFAULT_MIN = 16;
    const DEFAULT_MAX = 31;
    const coolMin = t.coolMin > 0 ? t.coolMin : DEFAULT_MIN;
    const coolMax = t.coolMax > 0 ? t.coolMax : DEFAULT_MAX;
    const heatMin = t.heatMin > 0 ? t.heatMin : DEFAULT_MIN;
    const heatMax = t.heatMax > 0 ? t.heatMax : DEFAULT_MAX;
    const step = this.state.tempDetail ? 0.5 : 1.0;
    this.service
      .getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .setProps({ minValue: coolMin, maxValue: coolMax, minStep: step });
    this.service
      .getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .setProps({ minValue: heatMin, maxValue: heatMax, minStep: step });
  }

}
