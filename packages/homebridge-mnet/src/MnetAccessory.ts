import type { GroupInfo, GroupState, GroupStatePatch, SystemInfo } from 'g50a-client';
import type { API, Logger, PlatformAccessory } from 'homebridge';
import { MnetHeaterCoolerService } from './MnetHeaterCoolerService.js';

const MANUFACTURER = 'Mitsubishi Electric';

export interface AccessoryContext {
  group: number;
  displayName: string;
  /** Stable across controller IP changes when MacAddress is known. */
  serialNumber: string;
}

export interface AccessoryOptions {
  api: API;
  log: Logger;
  accessory: PlatformAccessory;
  group: GroupInfo;
  system: SystemInfo | undefined;
  autoModeDeadbandC: number;
  pushPatch: (group: number, patch: GroupStatePatch) => void;
}

/**
 * Wraps one Homebridge `PlatformAccessory` for a single M-NET group. Owns the
 * `AccessoryInformation` and `HeaterCooler` services and surfaces the
 * `applyState` / `setFault` hooks the platform uses to drive HomeKit updates.
 */
export class MnetAccessory {
  readonly group: number;
  readonly accessory: PlatformAccessory;
  private readonly service: MnetHeaterCoolerService;

  constructor(opts: AccessoryOptions) {
    this.group = opts.group.group;
    this.accessory = opts.accessory;

    const Characteristic = opts.api.hap.Characteristic;
    const Service = opts.api.hap.Service;

    const infoService =
      this.accessory.getService(Service.AccessoryInformation) ??
      this.accessory.addService(Service.AccessoryInformation);
    infoService
      .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(Characteristic.Model, opts.system?.model || 'G-50A')
      .setCharacteristic(
        Characteristic.SerialNumber,
        (this.accessory.context as AccessoryContext).serialNumber ?? `g${this.group}`,
      )
      .setCharacteristic(Characteristic.FirmwareRevision, opts.system?.version || '0.0.0');

    this.service = new MnetHeaterCoolerService({
      accessory: this.accessory,
      api: opts.api,
      log: opts.log,
      group: this.group,
      autoModeDeadbandC: opts.autoModeDeadbandC,
      pushPatch: opts.pushPatch,
    });
  }

  applyState(state: GroupState, changed: (keyof GroupState)[]): void {
    this.service.applyState(state, changed);
  }

  setFault(faulted: boolean): void {
    this.service.setFault(faulted);
  }
}
