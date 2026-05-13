import { G50AClient, type GroupInfo, type GroupState, type StateChangeEvent } from 'g50a-client';
import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';
import { MnetAccessory, type AccessoryContext } from './MnetAccessory.js';

export const PLATFORM_NAME = 'MNET';
export const PLUGIN_NAME = 'homebridge-mnet';

interface GroupNameEntry {
  group: number;
  name: string;
}

interface MnetPluginConfig extends PlatformConfig {
  host?: string;
  port?: number;
  pollIntervalMs?: number;
  autoModeDeadbandC?: number;
  /**
   * Accepts the modern array shape (preferred — UI-friendly) or the legacy
   * `Record<string, string>` shape (kept for back-compat with hand-edited
   * config.json from earlier versions).
   */
  groupNames?: GroupNameEntry[] | Record<string, string>;
  excludeGroups?: number[];
}

function normalizeGroupNames(
  input: GroupNameEntry[] | Record<string, string> | undefined,
): Record<string, string> {
  if (!input) return {};
  if (Array.isArray(input)) {
    const out: Record<string, string> = {};
    for (const entry of input) {
      if (typeof entry?.group === 'number' && typeof entry?.name === 'string' && entry.name.length > 0) {
        out[String(entry.group)] = entry.name;
      }
    }
    return out;
  }
  return input;
}

const DEFAULTS = {
  port: 80,
  pollIntervalMs: 5000,
  autoModeDeadbandC: 2.0,
};

/**
 * Homebridge DynamicPlatformPlugin entry point.
 *
 * Lifecycle:
 *   1. constructor: register `configureAccessory` and `didFinishLaunching` listeners
 *   2. configureAccessory(cached): cached accessories restored — stash them
 *   3. didFinishLaunching: start the G50AClient, reconcile against the cached
 *      set (register new, unregister gone), and wire change events through
 *      to `MnetAccessory.applyState`.
 */
export class MnetPlatform implements DynamicPlatformPlugin {
  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly accessories = new Map<number, MnetAccessory>();
  private readonly host: string;
  private readonly excludeGroups: Set<number>;
  private readonly groupNames: Record<string, string>;
  private readonly autoModeDeadbandC: number;
  private client: G50AClient | undefined;

  constructor(
    private readonly log: Logger,
    private readonly config: MnetPluginConfig,
    private readonly api: API,
  ) {
    this.host = (config.host ?? '').trim();
    this.excludeGroups = new Set(config.excludeGroups ?? []);
    this.groupNames = normalizeGroupNames(config.groupNames);
    this.autoModeDeadbandC = config.autoModeDeadbandC ?? DEFAULTS.autoModeDeadbandC;

    if (!this.host) {
      this.log.error(
        'No "host" configured for the MNET platform — set it in config.json or the Homebridge UI.',
      );
      return;
    }

    this.api.on('didFinishLaunching', () => {
      this.start().catch((err) => this.log.error('Platform start failed', err));
    });
    this.api.on('shutdown', () => {
      this.stop().catch((err) => this.log.error('Platform shutdown failed', err));
    });
  }

  /**
   * Called by Homebridge for each cached accessory at startup. We just stash
   * them; the actual reconciliation runs in `start()` once we've talked to
   * the controller and know which groups still exist.
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug(`Restoring cached accessory ${accessory.displayName} (${accessory.UUID})`);
    this.cached.set(accessory.UUID, accessory);
  }

  private async start(): Promise<void> {
    if (!this.host) return;

    this.client = new G50AClient({
      host: this.host,
      port: this.config.port ?? DEFAULTS.port,
      pollIntervalMs: this.config.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
      logger: {
        debug: (m, ...a) => this.log.debug(`[g50a] ${m}`, ...a),
        info: (m, ...a) => this.log.info(`[g50a] ${m}`, ...a),
        warn: (m, ...a) => this.log.warn(`[g50a] ${m}`, ...a),
        error: (m, ...a) => this.log.error(`[g50a] ${m}`, ...a),
      },
    });

    this.client.on('groupsChanged', (groups) => this.reconcile(groups));
    this.client.on('stateChanged', (e) => this.handleStateChange(e));
    this.client.on('warning', (e) => this.log.warn(`[g50a] warning`, e));
    this.client.on('error', (err) => {
      this.log.error(`[g50a] controller unreachable`, err);
      for (const a of this.accessories.values()) a.setFault(true);
    });
    this.client.on('ready', () => {
      for (const a of this.accessories.values()) a.setFault(false);
    });

    try {
      await this.client.start();
    } catch (err) {
      this.log.error('Failed to contact controller', err);
      return;
    }

    // Best-effort: pull controller-side group names. Used as a fallback when
    // the operator hasn't set explicit `groupNames` in config — far better UX
    // than "M-NET Group 7" generic labels.
    try {
      const list = await this.client.getMnetList();
      for (const entry of list) {
        const key = String(entry.group);
        if (this.groupNames[key]) continue; // explicit config wins
        const fallback = entry.webName?.trim() || entry.lcdName?.trim();
        if (fallback) this.groupNames[key] = fallback;
      }
    } catch (err) {
      this.log.debug?.('MnetList read failed; falling back to generic names', err);
    }

    this.reconcile(this.client.getGroups());
    // Apply any state already polled during start() to the freshly-created accessories.
    for (const [group, accessory] of this.accessories) {
      const state = this.client.getState(group);
      if (state) {
        accessory.applyState(state, Object.keys(state) as (keyof GroupState)[]);
      }
    }
  }

  private async stop(): Promise<void> {
    if (this.client) {
      await this.client.stop();
      this.client = undefined;
    }
  }

  private reconcile(groups: GroupInfo[]): void {
    const wanted = new Map<number, GroupInfo>();
    for (const g of groups) {
      if (this.excludeGroups.has(g.group)) continue;
      // Ignore the transient "??" model — the controller will resolve it to
      // IC within a couple minutes. The group still gets discovered on the
      // next group-list refresh.
      if (g.model !== 'IC') continue;
      wanted.set(g.group, g);
    }

    // Register any group we don't have an accessory for yet.
    for (const [group, info] of wanted) {
      if (this.accessories.has(group)) continue;
      const uuid = this.uuidFor(group);
      const displayName = this.groupNames[String(group)] ?? `M-NET Group ${group}`;
      const context: AccessoryContext = {
        group,
        displayName,
        serialNumber: this.serialFor(group),
      };

      let accessory = this.cached.get(uuid);
      if (accessory) {
        accessory.displayName = displayName;
        accessory.context = context;
        this.api.updatePlatformAccessories([accessory]);
        this.log.info(`Restored group ${group} → "${displayName}"`);
      } else {
        accessory = new this.api.platformAccessory(displayName, uuid);
        accessory.context = context;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Registered group ${group} → "${displayName}"`);
      }
      this.cached.delete(uuid);
      this.accessories.set(
        group,
        new MnetAccessory({
          api: this.api,
          log: this.log,
          accessory,
          group: info,
          system: this.client?.getSystemInfo(),
          autoModeDeadbandC: this.autoModeDeadbandC,
          pushPatch: (g, p) => this.pushPatch(g, p),
        }),
      );
    }

    // Unregister any cached accessory the controller no longer reports.
    for (const [uuid, accessory] of this.cached) {
      const context = accessory.context as AccessoryContext | undefined;
      if (!context || !wanted.has(context.group)) {
        this.log.info(`Unpublishing stale accessory ${accessory.displayName}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cached.delete(uuid);
      }
    }
  }

  private handleStateChange(event: StateChangeEvent): void {
    const accessory = this.accessories.get(event.group);
    if (!accessory) return;
    accessory.applyState(event.current, event.changed);
  }

  private pushPatch(group: number, patch: Parameters<G50AClient['setState']>[1]): void {
    if (!this.client) return;
    this.client.setState(group, patch).catch((err) => {
      this.log.warn(`[group ${group}] setState failed`, err);
    });
  }

  private uuidFor(group: number): string {
    const mac = this.client?.getSystemInfo()?.macAddress ?? this.host;
    return this.api.hap.uuid.generate(`mnet:${mac}:g${group}`);
  }

  private serialFor(group: number): string {
    const mac = this.client?.getSystemInfo()?.macAddress;
    return mac ? `${mac}-${group}` : `${this.host}-${group}`;
  }
}
