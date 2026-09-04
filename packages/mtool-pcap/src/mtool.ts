/**
 * Extractors for the two things a MainteToolNet capture actually contains.
 *
 * Port 25 carries `MnetMonitor`'s trend push — plaintext SMTP whose body is a
 * CSV of time-stamped raw M-NET responses. Port 80 carries the synchronous
 * `MnetRouter` queries, including the subscription that sets the trend up.
 * Both are documented in docs/g50a-protocol.md §8j.
 */

/** One `HHMMSS,<DA>,<HEX>` row of a trend push body. */
export interface TrendRow {
  /** Controller-local time of the sample, as sent (`HHMMSS`). */
  time: string;
  /** M-NET address, or null for the bodyless marker rows. */
  da: number | null;
  /** Raw response frame, hex. Empty for marker rows. */
  hex: string;
  /** Text of a marker row such as `#Monitor Start`. */
  note?: string;
}

export interface TrendPush {
  requestId?: string;
  startDate?: string;
  startTime?: string;
  sendInterval?: string;
  rows: TrendRow[];
}

/**
 * One request/response pair from a `MnetCommandList`.
 *
 * `DA` is an attribute of `MnetCommandList`, never of `MnetRouter` — anchoring
 * a pattern on the latter matches nothing (§8j).
 */
export interface MnetQuery {
  da: number;
  /** Request frame, hex. */
  data: string;
  /** Response frame, hex — or `*` on the request leg, or `#NO ACK ERROR`. */
  rcvData: string;
}

/** A bank the tool asked to have polled continuously. */
export interface Subscription {
  da: number;
  /** Request frame, hex — e.g. `397E00`. */
  data: string;
}

const PUSH_HEADER = /\[MnetMonitor\]/g;
const ROW = /^(\d{6}),(\d*),(.*)$/;

/**
 * Split a stream into trend pushes.
 *
 * Each push is one SMTP message; a single TCP stream normally holds exactly
 * one, but the controller reuses connections, so several are handled.
 */
export function parseTrendPushes(text: string): TrendPush[] {
  const pushes: TrendPush[] = [];
  const starts = [...text.matchAll(PUSH_HEADER)].map((m) => m.index);

  for (let i = 0; i < starts.length; i++) {
    const body = text.slice(starts[i]!, starts[i + 1] ?? text.length);
    const push: TrendPush = { rows: [] };

    push.requestId = attr(body, 'RequestID');
    push.startDate = attr(body, 'StartDate');
    push.startTime = attr(body, 'StartTime');
    push.sendInterval = attr(body, 'SendInterval');

    const dataAt = body.indexOf('[Data]');
    const endAt = body.indexOf('[END]');
    if (dataAt < 0) continue;
    const rows = body.slice(dataAt + 6, endAt < 0 ? undefined : endAt);

    for (const raw of rows.split(/\r?\n/)) {
      const line = raw.trim();
      const m = ROW.exec(line);
      if (!m) continue;
      const [, time, daText, rest] = m as unknown as [string, string, string, string];
      const da = daText === '' ? null : Number(daText);
      if (/^[0-9A-Fa-f]{4,}$/.test(rest)) {
        push.rows.push({ time, da, hex: rest.toUpperCase() });
      } else {
        push.rows.push({ time, da, hex: '', note: rest });
      }
    }

    pushes.push(push);
  }

  return pushes;
}

const COMMAND_LIST = /<MnetCommandList\s+DA="(\d+)"[^>]*>([\s\S]*?)<\/MnetCommandList>/g;
const COMMAND_RECORD = /Data="([0-9A-Fa-f]*)"\s*RcvData="([^"]*)"/g;

/** Pull every `MnetRouter` request/response pair out of a port-80 stream. */
export function parseQueries(text: string): MnetQuery[] {
  const out: MnetQuery[] = [];
  for (const [, daText, body] of text.matchAll(COMMAND_LIST)) {
    const da = Number(daText);
    for (const [, data, rcvData] of body!.matchAll(COMMAND_RECORD)) {
      out.push({ da, data: data!.toUpperCase(), rcvData: rcvData! });
    }
  }
  return out;
}

const SEND_COMMAND_RECORD = /<SendCommandRecord\s+DA="(\d+)"\s+Data="([0-9A-Fa-f]+)"/g;

/**
 * The subscription list: which banks the tool polls per unit.
 *
 * The highest-value single query on a new capture — a field the GUI displays
 * has to come from a subscribed bank or from some other dialog's one-shot
 * query, and this says which. Note it only appears if the capture covers the
 * moment a monitor panel was *opened*.
 */
export function parseSubscriptions(text: string): Subscription[] {
  return [...text.matchAll(SEND_COMMAND_RECORD)].map(([, da, data]) => ({
    da: Number(da),
    data: data!.toUpperCase(),
  }));
}

/**
 * Response opcode for a request opcode: the second byte's high bit is set.
 *
 * `397E`→`39FE`, `2100`→`2180`, `210A`→`218A`, `2D0B`→`2D8B`.
 */
export function responseOpcode(request: string): string {
  const req = request.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (req.length < 4) throw new Error(`opcode too short: ${request}`);
  const second = parseInt(req.slice(2, 4), 16) | 0x80;
  return req.slice(0, 2) + second.toString(16).toUpperCase().padStart(2, '0') + req.slice(4);
}

export function isResponseOf(request: string, response: string): boolean {
  const resp = response.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  return resp.startsWith(responseOpcode(request).slice(0, 4));
}

/**
 * Leading check byte that PUMY-SP outdoor units prepend to a `39FE` response.
 *
 * PURY frames carry a constant `00` here. On a PUMY the byte is
 * `(330 − DA − bank) mod 256`, and skipping it is mandatory or every payload
 * offset is wrong by one (§8h).
 */
export function pumyCheckByte(da: number, bank: number): number {
  return (((330 - da - bank) % 256) + 256) % 256;
}

/** True if `frame`'s byte after `39FE<bank>` is the PUMY check byte for `da`. */
export function hasPumyCheckByte(da: number, frame: string): boolean {
  const hex = frame.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (!hex.startsWith('39FE') || hex.length < 8) return false;
  const bank = parseInt(hex.slice(4, 6), 16);
  return parseInt(hex.slice(6, 8), 16) === pumyCheckByte(da, bank);
}

/** Sentinel written where a sensor is not fitted. */
export const ABSENT = 0x7fff;

/**
 * Decode the protocol's signed 4-digit BCD tenths (§8d).
 *
 * Returns null for the `7FFF` absent sentinel. Only the top nibble's high bit
 * is a sign flag, so a negative reading carries three BCD digits and a positive
 * one carries four — `8178` is −17.8 while `5480` is +548.0.
 */
export function decodeBcdTenths(word: number): number | null {
  if (word === ABSENT) return null;
  const negative = (word & 0x8000) !== 0;
  const digits = negative ? word & 0x0fff : word;
  let value = 0;
  for (let shift = 12; shift >= 0; shift -= 4) {
    value = value * 10 + ((digits >> shift) & 0xf);
  }
  return (negative ? -value : value) / 10;
}

/** Read a `Key="value"` line out of a trend-push header. */
function attr(body: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]*)"`).exec(body)?.[1];
}
