export { G50AClient, type G50AClientEvents } from './G50AClient.js';
export { decodeBulk } from './bulkDecoder.js';
export { detectFirmwareFamily, type FirmwareFamily } from './firmware.js';
export {
  renderScheduleReport,
  type GroupNameEntry,
  type NameLookup,
  type ReportOptions,
} from './report.js';
export { buildTopology, decodeRefSystemRecord, type RefSystemRecordEl } from './topology.js';
export {
  ClientError,
  PartialWriteError,
  ProtocolError,
  TransportError,
  type ProtocolErrorEntry,
} from './errors.js';
export {
  DAYS_OF_WEEK,
  dayFromPattern,
  decodeWPatternRecord,
  emptyWeeklySchedule,
  encodeWPatternRecord,
  patternFromDay,
  validateWeeklySchedule,
  wPatternListAttrs,
} from './schedule.js';
export type {
  AirDirection,
  AirStageCapability,
  AlarmStatusRecord,
  ClientOptions,
  ClockReading,
  DayOfWeek,
  Drive,
  FanSpeed,
  FanSpeedCapability,
  FilterStatusRecord,
  GroupInfo,
  GroupState,
  GroupStatePatch,
  Logger,
  MnetName,
  MnetRawCommand,
  MnetRawReply,
  Mode,
  OutdoorSystem,
  RefSystemRecord,
  ScheduleEvent,
  StateChangeEvent,
  SystemInfo,
  TempLimits,
  Topology,
  UnitModel,
  WarningEvent,
  WeeklySchedule,
} from './types.js';
