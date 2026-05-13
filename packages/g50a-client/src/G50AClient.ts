import { EventEmitter } from 'node:events';
import { decodeBulk } from './bulkDecoder.js';
import { PartialWriteError, ProtocolError, TransportError } from './errors.js';
import { detectFirmwareFamily, type FirmwareFamily } from './firmware.js';
import {
  DAYS_OF_WEEK,
  decodeWPatternRecord,
  emptyWeeklySchedule,
  encodeWPatternRecord,
  patternFromDay,
  validateWeeklySchedule,
  wPatternListAttrs,
  type WPatternRecordEl,
} from './schedule.js';
import { buildTopology, decodeRefSystemRecord, type RefSystemRecordEl } from './topology.js';
import { Transport } from './transport.js';
import type {
  AlarmStatusRecord,
  ClientOptions,
  ClockReading,
  FilterStatusRecord,
  GroupInfo,
  GroupState,
  GroupStatePatch,
  Logger,
  MnetName,
  MnetRawCommand,
  MnetRawReply,
  RefSystemRecord,
  ScheduleEvent,
  StateChangeEvent,
  SystemInfo,
  Topology,
  WarningEvent,
  WeeklySchedule,
} from './types.js';
import {
  buildPacket,
  collectErrors,
  isErrorResponse,
  type DatabaseManager,
  type MnetElement,
  type PacketRoot,
} from './xml.js';

const SILENT_LOGGER: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const DEFAULT_OPTS = {
  port: 80,
  pollIntervalMs: 5000,
  groupListIntervalMs: 600_000,
  requestTimeoutMs: 8000,
  errorThreshold: 3,
  backoffIntervalMs: 30_000,
  removalQuorum: 3,
};

const MIN_POLL_MS = 2000;
const MAX_POLL_MS = 60_000;
const WRITE_DEBOUNCE_MS = 150;

interface PendingWrite {
  patch: GroupStatePatch;
  timer: NodeJS.Timeout | null;
  resolvers: Array<{
    resolve: (state: GroupState) => void;
    reject: (err: unknown) => void;
  }>;
}

/**
 * Strongly-typed event signatures emitted by {@link G50AClient}.
 *
 *  - `ready`          — initial group list fetched and first bulk poll completed
 *  - `groupsChanged`  — the set of IC groups changed since the last group-list cycle
 *  - `stateChanged`   — at least one decoded field of a group differs from the previous poll
 *  - `warning`        — non-fatal issue (e.g. partial-write recovery, unexpected XML)
 *  - `error`          — transport failure after backoff threshold; client keeps retrying
 */
export interface G50AClientEvents {
  ready: () => void;
  groupsChanged: (groups: GroupInfo[]) => void;
  stateChanged: (event: StateChangeEvent) => void;
  warning: (event: WarningEvent) => void;
  error: (err: Error) => void;
}

export declare interface G50AClient {
  on<U extends keyof G50AClientEvents>(event: U, listener: G50AClientEvents[U]): this;
  off<U extends keyof G50AClientEvents>(event: U, listener: G50AClientEvents[U]): this;
  emit<U extends keyof G50AClientEvents>(
    event: U,
    ...args: Parameters<G50AClientEvents[U]>
  ): boolean;
}

export class G50AClient extends EventEmitter {
  private readonly transport: Transport;
  private readonly logger: Logger;
  private readonly opts: typeof DEFAULT_OPTS;

  private readonly groups = new Map<number, GroupInfo>();
  private readonly state = new Map<number, GroupState>();
  private readonly absentCount = new Map<number, number>();
  private readonly pendingWrites = new Map<number, PendingWrite>();

  private systemInfo: SystemInfo | undefined;
  private fromFahrenheit = false;
  private firmwareFamily: FirmwareFamily = 'g50';
  private consecutiveFailures = 0;
  private inBackoff = false;
  private running = false;
  private bulkTimer: NodeJS.Timeout | null = null;
  private groupListTimer: NodeJS.Timeout | null = null;
  private readyEmitted = false;

  constructor(rawOpts: ClientOptions, transportOverride?: Transport) {
    super();
    const pollIntervalMs = clamp(
      rawOpts.pollIntervalMs ?? DEFAULT_OPTS.pollIntervalMs,
      MIN_POLL_MS,
      MAX_POLL_MS,
    );
    this.opts = {
      ...DEFAULT_OPTS,
      ...rawOpts,
      pollIntervalMs,
      groupListIntervalMs: rawOpts.groupListIntervalMs ?? DEFAULT_OPTS.groupListIntervalMs,
      requestTimeoutMs: rawOpts.requestTimeoutMs ?? DEFAULT_OPTS.requestTimeoutMs,
      errorThreshold: rawOpts.errorThreshold ?? DEFAULT_OPTS.errorThreshold,
      backoffIntervalMs: rawOpts.backoffIntervalMs ?? DEFAULT_OPTS.backoffIntervalMs,
      removalQuorum: rawOpts.removalQuorum ?? DEFAULT_OPTS.removalQuorum,
      port: rawOpts.port ?? DEFAULT_OPTS.port,
    };
    this.logger = rawOpts.logger ?? SILENT_LOGGER;
    this.transport =
      transportOverride ??
      new Transport({
        host: rawOpts.host,
        port: this.opts.port,
        requestTimeoutMs: this.opts.requestTimeoutMs,
      });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.refreshSystemInfo();
    await this.refreshGroupList();
    await this.pollAll();
    if (!this.readyEmitted) {
      this.readyEmitted = true;
      this.emit('ready');
    }
    this.scheduleNextBulk();
    this.scheduleNextGroupList();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.bulkTimer) {
      clearTimeout(this.bulkTimer);
      this.bulkTimer = null;
    }
    if (this.groupListTimer) {
      clearTimeout(this.groupListTimer);
      this.groupListTimer = null;
    }
    for (const pending of this.pendingWrites.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      for (const r of pending.resolvers) r.reject(new Error('Client stopped'));
    }
    this.pendingWrites.clear();
    await this.transport.close();
  }

  getGroups(): GroupInfo[] {
    return [...this.groups.values()];
  }

  getState(group: number): GroupState | undefined {
    return this.state.get(group);
  }

  getSystemInfo(): SystemInfo | undefined {
    return this.systemInfo;
  }

  /**
   * Apply a patch to a group's state. Calls within {@link WRITE_DEBOUNCE_MS}
   * for the same group are coalesced into a single combined `<Mnet>` element.
   * The exception is `drive` — drive patches flush immediately to keep on/off
   * feel snappy.
   *
   * Resolves with the post-write readback (authoritative). On `setErrorResponse`
   * with at least one accepted attribute, resolves with the readback and emits
   * a `warning`. Rejects on transport failure or hard protocol error.
   */
  async setState(group: number, patch: GroupStatePatch): Promise<GroupState> {
    if (!this.running) {
      throw new Error('Client not started');
    }
    return new Promise<GroupState>((resolve, reject) => {
      const existing = this.pendingWrites.get(group);
      const merged: GroupStatePatch = { ...(existing?.patch ?? {}), ...patch };
      const resolvers = existing?.resolvers ?? [];
      resolvers.push({ resolve, reject });
      if (existing?.timer) clearTimeout(existing.timer);

      const flush = () => {
        this.pendingWrites.delete(group);
        this.flushWrite(group, merged).then(
          (state) => resolvers.forEach((r) => r.resolve(state)),
          (err) => resolvers.forEach((r) => r.reject(err)),
        );
      };

      // Drive changes bypass the debouncer for snappy on/off.
      if (patch.drive !== undefined) {
        this.pendingWrites.set(group, { patch: merged, timer: null, resolvers });
        flush();
        return;
      }

      const timer = setTimeout(flush, WRITE_DEBOUNCE_MS);
      this.pendingWrites.set(group, { patch: merged, timer, resolvers });
    });
  }

  // ---------------------------------------------------------------------------
  // Schedules — weekly (TG-2000A-style) read/write
  // ---------------------------------------------------------------------------

  /**
   * Get the firmware family the client detected from `SystemData.Model` at
   * startup. Mainly useful for tests / diagnostics; the schedule API picks
   * the right encoding automatically.
   */
  getFirmwareFamily(): FirmwareFamily {
    return this.firmwareFamily;
  }

  /**
   * Read the full 7-day weekly schedule for a group. The controller accepts
   * multiple `<WPatternList>` children in a single `getRequest`, so all 7
   * days fetch in one round-trip.
   *
   * On `ae200` firmware (AE-200 / EW-50), each `<WPatternList>` query also
   * carries a `Season="1"` attribute — without it the controller silently
   * returns empty data.
   *
   * Resolves with an empty per-day array when that day has no events.
   */
  async getWeeklySchedule(group: number): Promise<WeeklySchedule> {
    const schedule = emptyWeeklySchedule(group);
    const wPatternLists = DAYS_OF_WEEK.map((day) =>
      wPatternListAttrs(group, patternFromDay(day), this.firmwareFamily),
    );
    const packet = await this.transport.send(
      buildPacket({
        Command: 'getRequest',
        DatabaseManager: {
          ScheduleControl: { WPatternList: wPatternLists },
        } as Record<string, unknown>,
      }),
    );
    this.assertNonError(packet);
    const lists =
      (
        packet.Packet.DatabaseManager as
          | {
              ScheduleControl?: {
                WPatternList?:
                  | { Group?: string; Pattern?: string; WPatternRecord?: WPatternRecordEl[] }
                  | { Group?: string; Pattern?: string; WPatternRecord?: WPatternRecordEl[] }[];
              };
            }
          | undefined
      )?.ScheduleControl?.WPatternList ?? [];
    const listArr = Array.isArray(lists) ? lists : [lists];
    for (const list of listArr) {
      const pattern = Number.parseInt(list?.Pattern ?? '', 10);
      if (!Number.isFinite(pattern) || pattern < 1 || pattern > 7) continue;
      const day = DAYS_OF_WEEK[pattern - 1];
      if (!day) continue;
      const records = list.WPatternRecord ?? [];
      schedule[day] = records.map((r, i) => decodeWPatternRecord(r, i + 1));
    }
    return schedule;
  }

  /**
   * Write a full 7-day weekly schedule for a group. All 7 day-of-week patterns
   * go in a single `setRequest` packet (the controller's `<ScheduleControl>`
   * accepts multiple `<WPatternList>` children). The schedule is validated
   * locally first (time ranges, event ordering) — see `validateWeeklySchedule`.
   *
   * The response is checked for `<ERROR>` elements; any error throws.
   */
  async setWeeklySchedule(schedule: WeeklySchedule): Promise<void> {
    validateWeeklySchedule(schedule);
    const family = this.firmwareFamily;
    const wPatternLists = DAYS_OF_WEEK.map((day) => {
      const events: ScheduleEvent[] = schedule[day].map((e, i) => ({ ...e, index: i + 1 }));
      return {
        ...wPatternListAttrs(schedule.group, patternFromDay(day), family),
        WPatternRecord: events.map((e) => encodeWPatternRecord(e, family)),
      };
    });
    const packet = await this.transport.send(
      buildPacket({
        Command: 'setRequest',
        DatabaseManager: {
          ScheduleControl: { WPatternList: wPatternLists },
        } as Record<string, unknown>,
      }),
    );
    const errors = collectErrors(packet);
    if (errors.length > 0) {
      throw new ProtocolError(`setWeeklySchedule failed for group ${schedule.group}`, errors);
    }
  }

  // ---------------------------------------------------------------------------
  // Controller-side display names, filter / alarm enumeration, today's events
  // ---------------------------------------------------------------------------

  /**
   * Read the controller-side display names for every group (the `MnetList` /
   * `<MnetRecord>` data — what TG-2000A / MainteToolNet authored). Both LCD
   * and Web names are returned; either may be empty.
   *
   * Use cases include auto-populating HomeKit / Home Assistant accessory
   * names without requiring the user to configure them manually.
   */
  async getMnetList(): Promise<MnetName[]> {
    const packet = await this.transport.send(
      buildPacket({
        Command: 'getRequest',
        DatabaseManager: { ControlGroup: { MnetList: {} } } as Record<string, unknown>,
      }),
    );
    this.assertNonError(packet);
    const list = (
      packet.Packet.DatabaseManager as
        | { ControlGroup?: { MnetList?: { MnetRecord?: Array<Record<string, string>> } } }
        | undefined
    )?.ControlGroup?.MnetList?.MnetRecord;
    return (list ?? [])
      .map((r) => {
        const group = Number.parseInt(r['Group'] ?? '', 10);
        if (!Number.isFinite(group)) return undefined;
        return {
          group,
          lcdName: (r['GroupNameLcd'] ?? '').trimEnd(),
          webName: r['GroupNameWeb'] ?? '',
        } satisfies MnetName;
      })
      .filter((x): x is MnetName => x !== undefined);
  }

  /**
   * Read the controller's active-alarm list. Empty when there are no current
   * faults. The numeric `alarmCode` corresponds to Mitsubishi M-NET alarm
   * codes — `0701`, `1300`, `2502`, etc. Look these up in vendor docs for a
   * description.
   */
  async getAlarmStatusList(): Promise<AlarmStatusRecord[]> {
    const packet = await this.transport.send(
      buildPacket({
        Command: 'getRequest',
        DatabaseManager: { Mnet: [{ AlarmStatusList: {} } as unknown as MnetElement] } as Record<
          string,
          unknown
        >,
      }),
    );
    this.assertNonError(packet);
    const mnet = packet.Packet.DatabaseManager?.Mnet;
    const records: AlarmStatusRecord[] = [];
    const buckets = Array.isArray(mnet) ? mnet : mnet ? [mnet] : [];
    for (const m of buckets) {
      const list = (m as unknown as { AlarmStatusList?: { AlarmStatusRecord?: Array<Record<string, string>> } })
        .AlarmStatusList?.AlarmStatusRecord;
      for (const el of list ?? []) {
        const address = Number.parseInt(el['Address'] ?? '', 10);
        if (!Number.isFinite(address)) continue;
        const rec: AlarmStatusRecord = {
          address,
          alarmCode: el['AlarmCode'] ?? '',
        };
        const group = Number.parseInt(el['Group'] ?? '', 10);
        if (Number.isFinite(group)) rec.group = group;
        if (el['Model']) rec.model = el['Model'];
        if (el['Detect']) rec.detected = el['Detect'];
        records.push(rec);
      }
    }
    return records;
  }

  /**
   * Read the list of filter-capable indoor units. Each record includes the
   * group's controller-side display name. To know whether a specific unit's
   * filter is currently dirty, check `state.filterSign` from the bulk poll —
   * this list is just the enumeration.
   */
  async getFilterStatusList(): Promise<FilterStatusRecord[]> {
    const packet = await this.transport.send(
      buildPacket({
        Command: 'getRequest',
        DatabaseManager: { Mnet: [{ FilterStatusList: {} } as unknown as MnetElement] } as Record<
          string,
          unknown
        >,
      }),
    );
    this.assertNonError(packet);
    const mnet = packet.Packet.DatabaseManager?.Mnet;
    const records: FilterStatusRecord[] = [];
    const buckets = Array.isArray(mnet) ? mnet : mnet ? [mnet] : [];
    for (const m of buckets) {
      const list = (m as unknown as { FilterStatusList?: { FilterStatusRecord?: Array<Record<string, string>> } })
        .FilterStatusList?.FilterStatusRecord;
      for (const el of list ?? []) {
        const address = Number.parseInt(el['Address'] ?? '', 10);
        const group = Number.parseInt(el['Group'] ?? '', 10);
        if (!Number.isFinite(address) || !Number.isFinite(group)) continue;
        const rec: FilterStatusRecord = {
          address,
          group,
          model: el['Model'] ?? '',
        };
        if (el['GroupNameWeb']) rec.groupNameWeb = el['GroupNameWeb'];
        records.push(rec);
      }
    }
    return records;
  }

  /**
   * Read the controller's computed event list for *today* (the day the
   * controller's clock thinks it is — see `getClock`). Combines the relevant
   * day's `WPatternList` with any `YearlyList` overrides; useful as a
   * "what will happen today?" diagnostic.
   */
  async getTodayList(group: number): Promise<ScheduleEvent[]> {
    const packet = await this.transport.send(
      buildPacket({
        Command: 'getRequest',
        DatabaseManager: {
          ScheduleControl: { TodayList: { Group: String(group) } },
        } as Record<string, unknown>,
      }),
    );
    this.assertNonError(packet);
    const list = (
      packet.Packet.DatabaseManager as
        | { ScheduleControl?: { TodayList?: { TodayRecord?: WPatternRecordEl[] } } }
        | undefined
    )?.ScheduleControl?.TodayList?.TodayRecord;
    return (list ?? []).map((r, i) => decodeWPatternRecord(r, i + 1));
  }

  // ---------------------------------------------------------------------------
  // Refrigerant-system topology
  // ---------------------------------------------------------------------------

  /**
   * Read the refrigerant-system topology — every device on the M-NET bus
   * (indoor units, branch controllers, branch selectors, outdoor units) plus
   * the outdoor unit they belong to. Returns a flat list of records.
   */
  async getRefSystemList(): Promise<RefSystemRecord[]> {
    const packet = await this.transport.send(
      buildPacket({
        Command: 'getRequest',
        DatabaseManager: {
          Mnet: [{ RefSystemList: {} } as unknown as MnetElement],
        } as Record<string, unknown>,
      }),
    );
    this.assertNonError(packet);
    const mnet = packet.Packet.DatabaseManager?.Mnet;
    const elements: RefSystemRecordEl[] = [];
    if (Array.isArray(mnet)) {
      for (const m of mnet) {
        const list = (m as unknown as { RefSystemList?: { RefSystemRecord?: RefSystemRecordEl[] } })
          .RefSystemList?.RefSystemRecord;
        if (list) elements.push(...list);
      }
    } else if (mnet) {
      const list = (mnet as unknown as { RefSystemList?: { RefSystemRecord?: RefSystemRecordEl[] } })
        .RefSystemList?.RefSystemRecord;
      if (list) elements.push(...list);
    }
    const records: RefSystemRecord[] = [];
    for (const el of elements) {
      const r = decodeRefSystemRecord(el);
      if (r) records.push(r);
    }
    return records;
  }

  /**
   * Convenience: read the topology and re-bucket by outdoor unit, marking each
   * outdoor system as mixed-mode-capable based on BC / BS presence. See
   * `topology.ts` for the heuristic.
   */
  async getTopology(): Promise<Topology> {
    const records = await this.getRefSystemList();
    return buildTopology(records);
  }

  // ---------------------------------------------------------------------------
  // Controller clock
  // ---------------------------------------------------------------------------

  /** Read the controller's internal real-time clock (local time, no TZ). */
  async getClock(): Promise<ClockReading> {
    const packet = await this.transport.send(
      buildPacket({
        Command: 'getRequest',
        DatabaseManager: {
          Clock: { Year: '*', Month: '*', Day: '*', Hour: '*', Minute: '*', Second: '*' },
        } as Record<string, unknown>,
      }),
    );
    this.assertNonError(packet);
    const c = (packet.Packet.DatabaseManager as { Clock?: Record<string, string> } | undefined)
      ?.Clock;
    if (!c) throw new ProtocolError('Empty Clock response', []);
    const reading: ClockReading = {
      year: parseClockInt(c['Year']),
      month: parseClockInt(c['Month']),
      day: parseClockInt(c['Day']),
      hour: parseClockInt(c['Hour']),
      minute: parseClockInt(c['Minute']),
      second: parseClockInt(c['Second']),
    };
    return reading;
  }

  /**
   * Set the controller's real-time clock. Pass a fully-specified
   * {@link ClockReading} — the controller expects all six fields.
   *
   * Caller is responsible for picking a sensible local-time value. The
   * controller has no timezone field and treats the value as local wall-clock.
   */
  async setClock(time: ClockReading): Promise<void> {
    const packet = await this.transport.send(
      buildPacket({
        Command: 'setRequest',
        DatabaseManager: {
          Clock: {
            Year: String(time.year),
            Month: String(time.month),
            Day: String(time.day),
            Hour: String(time.hour),
            Minute: String(time.minute),
            Second: String(time.second),
          },
        } as Record<string, unknown>,
      }),
    );
    const errors = collectErrors(packet);
    if (errors.length > 0) throw new ProtocolError(`setClock failed`, errors);
  }

  // ---------------------------------------------------------------------------
  // MnetRouter — raw M-NET frame pass-through
  // ---------------------------------------------------------------------------

  /**
   * Send one or more raw M-NET command frames through the controller and
   * return the units' raw replies. This is the same primitive Mitsubishi's
   * MainteToolNet uses to read compressor frequencies, valve positions,
   * refrigerant pressures, and every other field the high-level XML hides.
   *
   * All commands must target the same M-NET destination address. To address
   * multiple units, call this method once per destination — or batch them
   * yourself if you need precise interleaving.
   *
   * `commandIntervalMs` controls how long the controller waits between
   * successive frames on the M-NET bus. The maintenance tool defaults to
   * 400 ms; lower values may work for single-frame calls but risk bus
   * contention. The controller enforces a minimum.
   *
   * Reply bytes are returned verbatim (hex string). The first three bytes of
   * each reply mirror the request with the second byte's high bit set
   * (`0x39 0x7E 0xF0` → reply `0x39 0xFE 0xF0…`). See protocol-doc §8c.
   */
  async sendMnetRaw(
    destination: number,
    commands: readonly MnetRawCommand[] | readonly string[],
    options?: { commandIntervalMs?: number },
  ): Promise<MnetRawReply[]> {
    if (!Number.isInteger(destination) || destination < 1 || destination > 250) {
      throw new RangeError(`MnetRouter destination must be 1..250, got ${destination}`);
    }
    if (commands.length === 0) return [];
    const interval = options?.commandIntervalMs ?? 400;
    const records = commands.map((c) => {
      const data = typeof c === 'string' ? c : c.data;
      if (typeof c !== 'string' && c.destination !== destination) {
        throw new RangeError(
          `sendMnetRaw: all commands must share destination=${destination}, got ${c.destination}`,
        );
      }
      if (!/^[0-9A-Fa-f]+$/.test(data) || data.length % 2 !== 0) {
        throw new RangeError(`sendMnetRaw: command data must be even-length hex, got "${data}"`);
      }
      return { Data: data.toUpperCase(), RcvData: '*' };
    });
    const packet = await this.transport.send(
      buildPacket({
        Command: 'setRequest',
        DatabaseManager: {
          MnetRouter: {
            MnetCommandList: {
              DA: String(destination),
              CommandInterval: String(interval),
              MnetCommandRecord: records,
            },
          },
        } as Record<string, unknown>,
      }),
    );
    const errors = collectErrors(packet);
    if (errors.length > 0) {
      throw new ProtocolError(`sendMnetRaw failed (DA=${destination})`, errors);
    }
    const list = (
      packet.Packet.DatabaseManager as
        | {
            MnetRouter?: {
              MnetCommandList?: {
                MnetCommandRecord?:
                  | Array<{ Data?: string; RcvData?: string }>
                  | { Data?: string; RcvData?: string };
              };
            };
          }
        | undefined
    )?.MnetRouter?.MnetCommandList?.MnetCommandRecord;
    const arr = Array.isArray(list) ? list : list ? [list] : [];
    return arr.map((rec) => ({
      destination,
      data: (rec.Data ?? '').toUpperCase(),
      reply: (rec.RcvData ?? '').toUpperCase().replace(/^\*$/, ''),
    }));
  }

  /**
   * Convenience: read one M-NET memory bank (16-byte block) from a unit using
   * the `39 7E <bank>` request. Returns the reply payload with the 3-byte
   * response header (`39 FE <bank>`) stripped.
   */
  async readMnetBank(destination: number, bank: number): Promise<Uint8Array> {
    if (!Number.isInteger(bank) || bank < 0 || bank > 0xff) {
      throw new RangeError(`Bank must be 0x00..0xFF, got ${bank}`);
    }
    const data = `397E${bank.toString(16).toUpperCase().padStart(2, '0')}`;
    const [reply] = await this.sendMnetRaw(destination, [data]);
    if (!reply?.reply) {
      throw new ProtocolError(`No reply from DA=${destination} for bank ${data}`, []);
    }
    const expected = `39FE${data.slice(4)}`;
    if (!reply.reply.startsWith(expected)) {
      throw new ProtocolError(
        `Bank reply header mismatch (DA=${destination} bank=${data}): got ${reply.reply.slice(0, 6)}`,
        [],
      );
    }
    const payloadHex = reply.reply.slice(6);
    const bytes = new Uint8Array(payloadHex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(payloadHex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  async refreshSystemInfo(): Promise<void> {
    try {
      const packet = await this.transport.send(
        buildPacket({
          Command: 'getRequest',
          DatabaseManager: {
            SystemData: {
              Model: '*',
              Version: '*',
              MacAddress: '*',
              TempUnit: '*',
              IPAdrsLan: '*',
              LocationID: '*',
            },
          },
        }),
      );
      this.assertNonError(packet);
      const sd = (packet.Packet.DatabaseManager as DatabaseManager | undefined)?.SystemData ?? {};
      this.systemInfo = {
        model: sd['Model'] ?? '',
        version: sd['Version'] ?? '',
        macAddress: sd['MacAddress'] ?? '',
        tempUnit: sd['TempUnit'] === 'F' ? 'F' : 'C',
        ...(sd['IPAdrsLan'] !== undefined && { ipAdrsLan: sd['IPAdrsLan'] }),
        ...(sd['LocationID'] !== undefined && { locationID: sd['LocationID'] }),
      };
      this.fromFahrenheit = this.systemInfo.tempUnit === 'F';
      this.firmwareFamily = detectFirmwareFamily(this.systemInfo.model);
    } catch (err) {
      // SystemData isn't strictly required — log and continue with defaults.
      this.logger.warn?.(`Failed to read SystemData; using defaults`, err);
      this.emit('warning', { message: 'SystemData read failed', detail: err });
    }
  }

  async refreshGroupList(): Promise<void> {
    const packet = await this.transport.send(
      buildPacket({
        Command: 'getRequest',
        DatabaseManager: { ControlGroup: { MnetGroupList: {} } },
      }),
    );
    this.assertNonError(packet);
    const records =
      packet.Packet.DatabaseManager?.ControlGroup?.MnetGroupList?.MnetGroupRecord ?? [];
    const seen = new Set<number>();
    let changed = false;
    for (const r of records) {
      if (!isIcLike(r.Model)) continue;
      const group = Number.parseInt(r.Group, 10);
      if (!Number.isFinite(group)) continue;
      seen.add(group);
      this.absentCount.delete(group);
      const next: GroupInfo = {
        group,
        model: r.Model,
        ...(r.Address !== undefined && { address: Number.parseInt(r.Address, 10) }),
      };
      const prev = this.groups.get(group);
      if (!prev || prev.model !== next.model || prev.address !== next.address) {
        changed = true;
      }
      this.groups.set(group, next);
    }
    for (const group of [...this.groups.keys()]) {
      if (seen.has(group)) continue;
      const n = (this.absentCount.get(group) ?? 0) + 1;
      this.absentCount.set(group, n);
      if (n >= this.opts.removalQuorum) {
        this.groups.delete(group);
        this.state.delete(group);
        this.absentCount.delete(group);
        changed = true;
      }
    }
    if (changed) {
      this.emit('groupsChanged', this.getGroups());
    }
  }

  private async pollAll(): Promise<void> {
    const groups = [...this.groups.keys()];
    if (groups.length === 0) return;
    const packet = await this.transport.send(
      buildPacket({
        Command: 'getRequest',
        DatabaseManager: {
          Mnet: groups.map((g) => ({ Group: String(g), Bulk: '*' }) as MnetElement),
        },
      }),
    );
    this.assertNonError(packet);
    const elements = packet.Packet.DatabaseManager?.Mnet ?? [];
    for (const el of elements) {
      this.ingestBulk(Number.parseInt(el.Group, 10), el.Bulk);
    }
  }

  private ingestBulk(group: number, bulk: string | undefined): void {
    if (!bulk) return;
    try {
      const decoded = decodeBulk(bulk, { fromFahrenheit: this.fromFahrenheit });
      const previous = this.state.get(group);
      this.state.set(group, decoded);
      if (!previous) {
        this.emit('stateChanged', {
          group,
          previous: decoded,
          current: decoded,
          changed: Object.keys(decoded) as (keyof GroupState)[],
        });
        return;
      }
      const changed = diffStates(previous, decoded);
      if (changed.length > 0) {
        this.emit('stateChanged', { group, previous, current: decoded, changed });
      }
    } catch (err) {
      this.logger.warn?.(`Failed to decode bulk for group ${group}`, err);
      this.emit('warning', { group, message: 'Bulk decode failed', detail: err });
    }
  }

  private async flushWrite(group: number, patch: GroupStatePatch): Promise<GroupState> {
    const attrs: MnetElement = { Group: String(group) };
    if (patch.drive !== undefined) attrs.Drive = patch.drive;
    if (patch.mode !== undefined) attrs.Mode = patch.mode;
    if (patch.setTemp !== undefined) attrs.SetTemp = formatTemp(patch.setTemp);
    if (patch.fanSpeed !== undefined) attrs.FanSpeed = patch.fanSpeed;
    if (patch.airDirection !== undefined) attrs.AirDirection = patch.airDirection;

    const packet = await this.transport.send(
      buildPacket({
        Command: 'setRequest',
        DatabaseManager: { Mnet: [attrs] },
      }),
    );

    const command = readCommand(packet);
    const errors = collectErrors(packet);

    // Read back regardless of success — the controller's writes are non-atomic
    // and the readback is the only authoritative source.
    await this.pollGroup(group);
    const readback = this.state.get(group);

    if (isErrorResponse(command)) {
      if (readback) {
        this.emit('warning', {
          group,
          message: 'Partial write — see readback',
          detail: errors,
        });
        throw new PartialWriteError(group, errors, readback);
      }
      throw new ProtocolError(`setRequest failed for group ${group}`, errors);
    }

    if (!readback) {
      throw new ProtocolError(`No state available for group ${group} after write`, errors);
    }
    return readback;
  }

  private async pollGroup(group: number): Promise<void> {
    const packet = await this.transport.send(
      buildPacket({
        Command: 'getRequest',
        DatabaseManager: { Mnet: [{ Group: String(group), Bulk: '*' }] as MnetElement[] },
      }),
    );
    this.assertNonError(packet);
    const el = packet.Packet.DatabaseManager?.Mnet?.[0];
    if (el) this.ingestBulk(group, el.Bulk);
  }

  private scheduleNextBulk(): void {
    if (!this.running) return;
    const interval = this.inBackoff ? this.opts.backoffIntervalMs : this.opts.pollIntervalMs;
    this.bulkTimer = setTimeout(() => {
      this.pollAll().then(
        () => this.onPollSuccess(),
        (err) => this.onPollFailure(err),
      );
    }, interval);
  }

  private scheduleNextGroupList(): void {
    if (!this.running) return;
    this.groupListTimer = setTimeout(() => {
      this.refreshGroupList().then(
        () => this.scheduleNextGroupList(),
        (err) => {
          this.logger.warn?.('GroupList refresh failed', err);
          this.emit('warning', { message: 'GroupList refresh failed', detail: err });
          this.scheduleNextGroupList();
        },
      );
    }, this.opts.groupListIntervalMs);
  }

  private onPollSuccess(): void {
    if (this.consecutiveFailures > 0 || this.inBackoff) {
      this.consecutiveFailures = 0;
      this.inBackoff = false;
      this.emit('ready');
    }
    this.scheduleNextBulk();
  }

  private onPollFailure(err: unknown): void {
    this.consecutiveFailures++;
    if (err instanceof TransportError) {
      this.logger.warn?.(`Poll failed (${this.consecutiveFailures}/${this.opts.errorThreshold})`, err);
    } else {
      this.logger.error?.('Unexpected poll error', err);
    }
    if (this.consecutiveFailures >= this.opts.errorThreshold && !this.inBackoff) {
      this.inBackoff = true;
      this.emit('error', err as Error);
    }
    this.scheduleNextBulk();
  }

  private assertNonError(packet: PacketRoot): void {
    const command = readCommand(packet);
    if (isErrorResponse(command)) {
      throw new ProtocolError(`Controller returned ${command}`, collectErrors(packet));
    }
  }
}

function parseClockInt(value: string | undefined): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : 0;
}

function readCommand(packet: PacketRoot): string | undefined {
  const c = packet.Packet?.Command;
  return typeof c === 'string' ? c : undefined;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function isIcLike(model: string | undefined): boolean {
  // Accept fully-confirmed IC units and the "pending" placeholder the
  // controller emits during the brief window after group registration
  // before the M-NET poll has resolved the unit's true model.
  return model === 'IC' || model === '??';
}

function formatTemp(c: number): string {
  // The controller accepts decimals; clamp to 1 fractional digit.
  return (Math.round(c * 10) / 10).toFixed(1);
}

const COMPARED_FIELDS: (keyof GroupState)[] = [
  'drive',
  'mode',
  'setTemp',
  'inletTemp',
  'fanSpeed',
  'fanSpeedCapability',
  'airDirection',
  'airStageCapability',
  'tempDetail',
  'errorSign',
  'filterSign',
];

function diffStates(a: GroupState, b: GroupState): (keyof GroupState)[] {
  const changed: (keyof GroupState)[] = [];
  for (const field of COMPARED_FIELDS) {
    if (a[field] !== b[field]) changed.push(field);
  }
  // Deep-compare tempLimits since it's an object.
  const al = a.tempLimits;
  const bl = b.tempLimits;
  if (
    al.coolMin !== bl.coolMin ||
    al.coolMax !== bl.coolMax ||
    al.heatMin !== bl.heatMin ||
    al.heatMax !== bl.heatMax ||
    al.autoMin !== bl.autoMin ||
    al.autoMax !== bl.autoMax
  ) {
    changed.push('tempLimits');
  }
  return changed;
}
