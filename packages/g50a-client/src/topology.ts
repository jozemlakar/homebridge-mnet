/**
 * Build a structured view of the refrigerant-system topology from the flat
 * `<RefSystemRecord>` list the controller returns.
 *
 * The XML response is one record per device, each carrying its own `address`
 * plus the `ocAddress` of the outdoor unit it shares. We re-bucket by OC and
 * surface the operationally-important fact: whether the outdoor unit
 * supports **mixed-mode operation** (different indoor units running HEAT and
 * COOL simultaneously on the same refrigerant loop).
 *
 * Heuristic: an outdoor system supports mixed mode if it has a Branch
 * Controller (BC — typical for Mitsubishi R2-series PURY heat-recovery
 * systems) and/or a Branch Selector (BS — older / specific HR
 * architectures). Outdoor units with neither attached are heat-pump-style
 * single-mode systems: HEAT + COOL mixed across their indoor units silently
 * leaves the minority direction unsatisfied (the controller accepts the
 * `setRequest` without error, but the unit doesn't actually condition).
 *
 * Caveat: the heuristic is informed by the protocol + common Mitsubishi
 * product-line conventions; it is not authoritative for every model. When in
 * doubt, consult the install's commissioning data.
 */
import type { OutdoorSystem, RefSystemRecord, Topology } from './types.js';

export interface RefSystemRecordEl {
  Address?: string;
  OcAddress?: string;
  Model?: string;
}

export function decodeRefSystemRecord(el: RefSystemRecordEl): RefSystemRecord | undefined {
  const address = Number.parseInt(el.Address ?? '', 10);
  const ocAddress = Number.parseInt(el.OcAddress ?? '', 10);
  if (!Number.isFinite(address) || !Number.isFinite(ocAddress)) return undefined;
  return { address, ocAddress, model: el.Model ?? '' };
}

export function buildTopology(records: RefSystemRecord[]): Topology {
  const byOc = new Map<number, OutdoorSystem>();
  for (const r of records) {
    let sys = byOc.get(r.ocAddress);
    if (!sys) {
      sys = {
        ocAddress: r.ocAddress,
        indoor: [],
        branchControllers: [],
        branchSelectors: [],
        other: [],
        supportsMixedMode: false,
      };
      byOc.set(r.ocAddress, sys);
    }
    switch (r.model) {
      case 'IC':
      case 'IDC':
      case 'KIC':
      case 'AIC':
        sys.indoor.push(r);
        break;
      case 'BC':
        sys.branchControllers.push(r);
        sys.supportsMixedMode = true;
        break;
      case 'BS':
        sys.branchSelectors.push(r);
        sys.supportsMixedMode = true;
        break;
      // Outdoor units (OC / OCi) appear in their own record. We don't need to
      // separately track them — their address is `ocAddress`, which is
      // already the bucket key.
      default:
        sys.other.push(r);
    }
  }
  const outdoorSystems = [...byOc.values()].sort((a, b) => a.ocAddress - b.ocAddress);
  return { records, outdoorSystems };
}
