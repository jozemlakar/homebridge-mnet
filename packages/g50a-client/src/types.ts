export type Drive = 'ON' | 'OFF' | 'TESTRUN';

export type Mode =
  | 'AUTO'
  | 'COOL'
  | 'HEAT'
  | 'DRY'
  | 'FAN'
  | 'AUTOCOOL'
  | 'AUTOHEAT'
  | 'LC_AUTO'
  | 'BYPASS'
  | 'BAHP'
  | 'HEATRECOVERY'
  | 'DEFROST'
  | 'OUTCOOL'
  | 'PANECOOL'
  | 'PANEHEAT'
  | 'VENTILATE';

export type FanSpeed = 'AUTO' | 'LOW' | 'MID1' | 'MID2' | 'HIGH';

export type FanSpeedCapability = 'NONE' | '2STAGES' | '3STAGES' | '4STAGES';

export type AirDirection =
  | 'AUTO'
  | 'SWING'
  | 'HORIZONTAL'
  | 'VERTICAL'
  | 'MID0'
  | 'MID1'
  | 'MID2';

export type AirStageCapability = '4STAGES' | '5STAGES';

export type UnitModel =
  | 'IC'
  | 'OC'
  | 'OCi'
  | 'BC'
  | 'LC'
  | 'CR'
  | 'KIC'
  | 'NONE'
  | 'NOUSE'
  | 'TMP'
  | '??'
  | string;

export interface GroupInfo {
  group: number;
  model: UnitModel;
  /** Physical M-NET address bound to this group, if known. */
  address?: number;
}

export interface TempLimits {
  coolMin: number;
  coolMax: number;
  heatMin: number;
  heatMax: number;
  autoMin: number;
  autoMax: number;
}

export interface GroupState {
  drive: Drive;
  mode: Mode;
  /** Setpoint in degrees Celsius (normalized at the client boundary). */
  setTemp: number;
  /** Room (inlet) temperature in degrees Celsius. */
  inletTemp: number;
  fanSpeed: FanSpeed;
  fanSpeedCapability: FanSpeedCapability;
  airDirection: AirDirection;
  airStageCapability: AirStageCapability;
  tempLimits: TempLimits;
  /** True when the unit supports 0.5 °C SetTemp resolution; false for 1.0 °C. */
  tempDetail: boolean;
  /** Error code reported by the indoor unit; absent / empty = no fault. */
  errorSign?: string;
  /** Filter-cleanup indicator. */
  filterSign?: boolean;
  /** All decoded bulk fields as raw strings — escape hatch for fields not yet typed. */
  raw: Record<string, string>;
}

export interface GroupStatePatch {
  drive?: Drive;
  mode?: Mode;
  setTemp?: number;
  fanSpeed?: FanSpeed;
  airDirection?: AirDirection;
}

export interface StateChangeEvent {
  group: number;
  previous: GroupState;
  current: GroupState;
  /** Field names whose value differs between previous and current. */
  changed: (keyof GroupState)[];
}

export interface WarningEvent {
  group?: number;
  message: string;
  detail?: unknown;
}

export interface SystemInfo {
  model: string;
  version: string;
  macAddress: string;
  tempUnit: 'C' | 'F';
  ipAdrsLan?: string;
  locationID?: string;
}

// ---------------------------------------------------------------------------
// Refrigerant-system topology (which devices share an outdoor unit)
// ---------------------------------------------------------------------------

/**
 * One device sitting on the M-NET bus, as reported by `<RefSystemList>`.
 *
 * `address` is the device's M-NET bus address; `ocAddress` is the address of
 * the outdoor unit (OC) it belongs to. For an OC itself, `address === ocAddress`.
 */
export interface RefSystemRecord {
  /** This device's M-NET address. */
  address: number;
  /** Outdoor unit (OC) address this device belongs to. */
  ocAddress: number;
  /** Model code (`IC`, `OC`, `OCi`, `BC`, `BS`, …) — see `MODEL_*` enum. */
  model: UnitModel;
}

/**
 * One outdoor-unit refrigerant system. The presence of a `branchSelector`
 * (`Model="BS"`) is the practical marker for heat-recovery systems — those
 * support indoor units running in different modes (HEAT vs COOL) at the same
 * time. Without a BS, the outdoor unit can only condition one direction at a
 * time across all its indoor units.
 */
export interface OutdoorSystem {
  ocAddress: number;
  /** All indoor units (Model='IC') on this outdoor's refrigerant loop. */
  indoor: RefSystemRecord[];
  /** Branch controllers (Model='BC') on this system. Usually one. */
  branchControllers: RefSystemRecord[];
  /** Branch selectors (Model='BS') — presence means heat-recovery / mixed-mode capable. */
  branchSelectors: RefSystemRecord[];
  /** Anything else on the loop (KA, AN, AHC, etc.). */
  other: RefSystemRecord[];
  /** True when at least one BS is present — indoor units can mix HEAT and COOL freely. */
  supportsMixedMode: boolean;
}

export interface Topology {
  /** All records as the controller reported them. */
  records: RefSystemRecord[];
  /** Records re-organised by outdoor unit. */
  outdoorSystems: OutdoorSystem[];
}

// ---------------------------------------------------------------------------
// Controller-side display names (MnetList)
// ---------------------------------------------------------------------------

/**
 * One group's display-name record as stored on the controller — the same data
 * TG-2000A / MainteToolNet authored. Both names may be empty if the operator
 * never set them; the LCD name is space-padded to 10 ASCII chars.
 */
export interface MnetName {
  group: number;
  lcdName: string;
  webName: string;
}

// ---------------------------------------------------------------------------
// Alarm / fault state (AlarmStatusList)
// ---------------------------------------------------------------------------

/**
 * One active or recent alarm reported by the controller. `alarmCode` is the
 * Mitsubishi numeric code (e.g. `1300`, `2503`); look up the human-readable
 * description in the IncidentCodeList table (currently not bundled — see
 * the protocol doc for code categories).
 */
export interface AlarmStatusRecord {
  /** Device M-NET address that raised the alarm. */
  address: number;
  /** Group number on the controller, if this device is in a group. */
  group?: number;
  /** Unit model code (IC, OC, BC, …). */
  model?: string;
  /** Numeric alarm code. */
  alarmCode: string;
  /** Date/time when the alarm was first detected (controller's local time). */
  detected?: string;
  /** Date/time of recovery, if the alarm has cleared. */
  recovered?: string;
}

// ---------------------------------------------------------------------------
// Filter status enumeration (FilterStatusList)
// ---------------------------------------------------------------------------

export interface FilterStatusRecord {
  address: number;
  group: number;
  model: string;
  /** Display name from the controller, if set. */
  groupNameWeb?: string;
}

// ---------------------------------------------------------------------------
// Controller clock
// ---------------------------------------------------------------------------

/**
 * Controller's internal real-time clock reading. `seconds` is 0-59; `month`
 * is 1-12; `day` is 1-31. The controller stores local time — there is no
 * timezone field, so callers are responsible for matching the controller's
 * configured locale.
 */
export interface ClockReading {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface Logger {
  debug?: (msg: string, ...args: unknown[]) => void;
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

// ---------------------------------------------------------------------------
// MnetRouter — raw M-NET frame pass-through (TG-2000A-class access)
// ---------------------------------------------------------------------------

/**
 * One raw M-NET command to send to a unit on the bus. `data` is the request
 * frame as a hex string (e.g. `"397EF0"` to read memory bank 0xF0). The
 * controller forwards the frame to `destination`, waits for the unit's reply,
 * and returns the reply bytes in {@link MnetRawReply.reply}.
 *
 * Common command shapes — see `docs/g50a-protocol.md` §8c.3 for the catalogue.
 */
export interface MnetRawCommand {
  /** M-NET destination address (1–250 decimal). 66=OC@066, 67=BC main, etc. */
  destination: number;
  /** Request frame bytes, hex-encoded, no spaces. */
  data: string;
}

export interface MnetRawReply {
  destination: number;
  /** The request that produced this reply (echoed by the controller). */
  data: string;
  /** Raw response bytes from the unit, hex-encoded. Empty string if the unit didn't respond within the bus timeout. */
  reply: string;
}

// ---------------------------------------------------------------------------
// Schedules (ScheduleControl subsystem — weekly patterns)
// ---------------------------------------------------------------------------

export type DayOfWeek =
  | 'sunday'
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday';

/**
 * One scheduled event in a daily timeline. The `*Enabled` flags map to the
 * controller's `*Item` attributes — they decide which fields the event
 * actually applies; fields whose flag is false are left untouched by the
 * controller when the event fires.
 *
 * On read, the controller emits empty strings (`Drive=""`, `DriveItem=""`)
 * for non-set fields. We normalize them to `undefined` here so the shape is
 * predictable.
 */
export interface ScheduleEvent {
  /** 1..N within the day, ordered chronologically. */
  index: number;
  hour: number;
  minute: number;
  drive?: Drive;
  mode?: Mode;
  /** Setpoint in degrees Celsius (the client converts at the boundary). */
  setTemp?: number;
  /** Energy-saving setback temperature. */
  setBack?: number;
  driveEnabled: boolean;
  modeEnabled: boolean;
  setTempEnabled: boolean;
}

export interface WeeklySchedule {
  group: number;
  sunday: ScheduleEvent[];
  monday: ScheduleEvent[];
  tuesday: ScheduleEvent[];
  wednesday: ScheduleEvent[];
  thursday: ScheduleEvent[];
  friday: ScheduleEvent[];
  saturday: ScheduleEvent[];
}

export interface ClientOptions {
  /** Controller hostname or IP address. */
  host: string;
  /** HTTP port. Default: 80. */
  port?: number;
  /** Bulk-poll cadence in milliseconds. Default: 5000. Range: 2000-60000 enforced. */
  pollIntervalMs?: number;
  /** Group-list refresh cadence in milliseconds. Default: 600000 (10 min). */
  groupListIntervalMs?: number;
  /** Single-request timeout in milliseconds. Default: 8000. */
  requestTimeoutMs?: number;
  /** Number of consecutive transport failures before backoff. Default: 3. */
  errorThreshold?: number;
  /** Backoff poll interval (ms) after errorThreshold failures. Default: 30000. */
  backoffIntervalMs?: number;
  /** Number of missing group-list cycles before unpublishing a group. Default: 3. */
  removalQuorum?: number;
  /** Logger; defaults to a silent logger. */
  logger?: Logger;
}
