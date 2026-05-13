import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import type { ProtocolErrorEntry } from './errors.js';

/**
 * The controller emits XML with attributes only (no text content beyond the
 * `<Command>` element). We treat everything as attribute-bearing nodes and
 * pull text out of `Command` explicitly.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  // Always coerce to arrays — much easier to consume than fast-xml-parser's
  // default "single child = object, multiple = array" inconsistency.
  isArray: (tagName) =>
    [
      'MnetGroupRecord',
      'MnetRecord',
      'Mnet',
      'ERROR',
      'UserRecord',
      'AreaRecord',
      'AreaGroupRecord',
      'McRecord',
      'McNameRecord',
      'InterlockRecord',
      'ViewInfoRecord',
      'DdcInfoRecord',
      'WPatternRecord',
      'YPatternRecord',
      'TodayRecord',
      'YearlyRecord',
      'WSeasonRecord',
      'RefSystemRecord',
      'AlarmStatusRecord',
      'FilterStatusRecord',
    ].includes(tagName),
});

const TEXT_NODE = '#text';

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: TEXT_NODE,
  format: false,
  suppressEmptyNode: true,
});

const XML_PROLOG = '<?xml version="1.0" encoding="UTF-8"?>';

export interface PacketRoot {
  Packet: PacketInner;
}

export interface PacketInner {
  Command?: string;
  DatabaseManager?: DatabaseManager;
  ERROR?: ErrorElement[];
  [k: string]: unknown;
}

export interface DatabaseManager {
  ControlGroup?: ControlGroup;
  Mnet?: MnetElement[];
  SystemData?: Record<string, string>;
  ERROR?: ErrorElement[];
  [k: string]: unknown;
}

export interface ControlGroup {
  MnetGroupList?: { MnetGroupRecord?: MnetGroupRecordEl[] };
  MnetList?: { MnetRecord?: MnetRecordEl[] };
  ERROR?: ErrorElement[];
  [k: string]: unknown;
}

export interface MnetGroupRecordEl {
  Group: string;
  Model: string;
  Address?: string;
  Contact?: string;
  /**
   * Refined model classification emitted by newer firmware families
   * (EW-50E / AE-200E). Older G-50A / GB-50A firmware does not include
   * this attribute. Often empty even when present.
   */
  SubModel?: string;
}

export interface MnetRecordEl {
  Group: string;
  GroupNameLcd?: string;
  GroupNameWeb?: string;
}

export interface MnetElement {
  Group: string;
  Bulk?: string;
  Drive?: string;
  Mode?: string;
  SetTemp?: string;
  FanSpeed?: string;
  AirDirection?: string;
  [k: string]: string | undefined;
}

export interface ErrorElement {
  Point: string;
  Code: string;
  Message: string;
}

export function parsePacket(xml: string): PacketRoot {
  return parser.parse(xml) as PacketRoot;
}

export function buildPacket(inner: PacketInner): string {
  // fast-xml-parser treats scalar properties as XML attributes by default;
  // for the few text-bearing elements we emit (just `Command` today), wrap
  // the value in `{ '#text': value }` so the builder produces a child element.
  const wrapped: Record<string, unknown> = { ...inner };
  if (typeof wrapped['Command'] === 'string') {
    wrapped['Command'] = { [TEXT_NODE]: wrapped['Command'] };
  }
  return XML_PROLOG + builder.build({ Packet: wrapped });
}

/**
 * Extract all `<ERROR>` elements from anywhere in the response. The controller
 * may put them under `Packet`, `DatabaseManager`, or `ControlGroup` depending
 * on which subsystem rejected the request.
 */
export function collectErrors(packet: PacketRoot): ProtocolErrorEntry[] {
  const out: ProtocolErrorEntry[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.ERROR)) {
      for (const e of obj.ERROR as ErrorElement[]) {
        out.push({ point: e.Point ?? '', code: e.Code ?? '', message: e.Message ?? '' });
      }
    }
    for (const key of Object.keys(obj)) {
      if (key === 'ERROR') continue;
      visit(obj[key]);
    }
  };
  visit(packet);
  return out;
}

export function isErrorResponse(command: string | undefined): boolean {
  return command === 'getErrorResponse' || command === 'setErrorResponse';
}
