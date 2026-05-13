import type {
  AirDirection,
  Drive,
  FanSpeed,
  FanSpeedCapability,
  GroupState,
  Mode,
} from './types.js';

/**
 * Decoder for the opaque `Bulk="..."` payload returned by `<Mnet Bulk="*">`
 * `getRequest`s. The payload is a hex-encoded byte string laid out as
 * fixed-position fields. Byte offsets and tables were carried over from the
 * legacy `lib/mnet_parser.js` and aligned with field names from the
 * disassembled `g50/apl/MnetGroupTb` / `MnetGroupValTb` applet classes — see
 * docs/g50a-protocol.md §4.
 *
 * Conventions:
 *  - `byte(n)` reads the two hex chars at offset n*2 as an unsigned byte.
 *  - `bcd(n)` reads the byte at position n as decimal (two BCD nibbles).
 *  - `nibble(n, half)` reads the high (0) or low (1) nibble at position n.
 */

const DRIVE: Record<number, Drive> = {
  0: 'OFF',
  1: 'ON',
  2: 'TESTRUN',
  4: 'ON',
  5: 'ON',
};

const MODE: Record<number, Mode> = {
  0: 'FAN',
  1: 'COOL',
  2: 'HEAT',
  3: 'DRY',
  4: 'AUTO',
  5: 'BAHP',
  6: 'AUTOCOOL',
  7: 'AUTOHEAT',
  8: 'VENTILATE',
  9: 'PANECOOL',
  10: 'PANEHEAT',
  11: 'OUTCOOL',
  12: 'DEFROST',
  128: 'HEATRECOVERY',
  129: 'BYPASS',
  130: 'LC_AUTO',
};

const AIR_DIRECTION: Record<number, AirDirection> = {
  0: 'SWING',
  1: 'VERTICAL',
  2: 'MID0',
  3: 'MID1',
  4: 'HORIZONTAL',
  5: 'MID2',
  6: 'AUTO',
};

const FAN_SPEED: Record<number, FanSpeed> = {
  0: 'LOW',
  1: 'MID1',
  2: 'MID2',
  3: 'HIGH',
  6: 'AUTO',
};

const FAN_SPEED_SW: Record<number, FanSpeedCapability> = {
  0: '2STAGES',
  1: '4STAGES',
  2: 'NONE',
  3: '3STAGES',
};

function byte(bulk: string, position: number): number {
  const offset = position * 2;
  if (offset + 2 > bulk.length) {
    throw new RangeError(
      `Bulk payload too short: need byte at position ${position}, got ${bulk.length / 2} bytes`,
    );
  }
  return parseInt(bulk.slice(offset, offset + 2), 16);
}

function bcd(bulk: string, position: number): number {
  const offset = position * 2;
  const hi = parseInt(bulk.charAt(offset), 16);
  const lo = parseInt(bulk.charAt(offset + 1), 16);
  return hi * 10 + lo;
}

function nibble(bulk: string, position: number, half: 0 | 1): number {
  return parseInt(bulk.charAt(position * 2 + half), 16);
}

function decodeEnum<T>(table: Record<number, T>, value: number, fallback: T): T {
  return table[value] ?? fallback;
}

/**
 * Decode one `Bulk` string into a typed `GroupState`. `setTemp` and
 * `inletTemp` are returned in degrees Celsius regardless of the controller's
 * `TempUnit`; the caller is responsible for indicating whether a Fahrenheit
 * conversion is needed and passing `fromFahrenheit: true` if so.
 */
export function decodeBulk(bulk: string, opts?: { fromFahrenheit?: boolean }): GroupState {
  if (typeof bulk !== 'string' || bulk.length < 48 * 2) {
    throw new RangeError(`Bulk payload too short (got ${bulk?.length ?? 0} chars)`);
  }

  const driveByte = byte(bulk, 1);
  const modeByte = byte(bulk, 2);
  const setTempInt = byte(bulk, 3);
  const setTempFrac = byte(bulk, 4);
  const inletTempRaw = (byte(bulk, 5) << 8) | byte(bulk, 6);
  const airDirByte = byte(bulk, 7);
  const fanSpeedByte = byte(bulk, 8);
  const errorSignByte = byte(bulk, 16);
  const filterSignByte = byte(bulk, 15);
  const tempDetailByte = byte(bulk, 43);
  const fanSpeedSwByte = byte(bulk, 25);
  const airStageSwByte = byte(bulk, 45);

  const coolMin = bcd(bulk, 32) + 0.1 * nibble(bulk, 38, 0);
  const heatMax = bcd(bulk, 33) + 0.1 * nibble(bulk, 38, 1);
  const coolMax = bcd(bulk, 34) + 0.1 * nibble(bulk, 39, 0);
  const heatMin = bcd(bulk, 35) + 0.1 * nibble(bulk, 39, 1);
  const autoMin = bcd(bulk, 36) + 0.1 * nibble(bulk, 40, 0);
  const autoMax = bcd(bulk, 37) + 0.1 * nibble(bulk, 40, 1);

  let setTempC = setTempInt + setTempFrac * 0.1;
  let inletTempC = inletTempRaw * 0.1;
  if (opts?.fromFahrenheit) {
    setTempC = ((setTempC - 32) * 5) / 9;
    inletTempC = ((inletTempRaw - 32) * 5) / 9;
  }

  const errorSignStr = errorSignByte === 0 ? undefined : errorSignByte.toString(16).toUpperCase();

  const state: GroupState = {
    drive: decodeEnum(DRIVE, driveByte, 'OFF'),
    mode: decodeEnum(MODE, modeByte, 'AUTO'),
    setTemp: round1(setTempC),
    inletTemp: round1(inletTempC),
    fanSpeed: decodeEnum(FAN_SPEED, fanSpeedByte, 'AUTO'),
    fanSpeedCapability: decodeEnum(FAN_SPEED_SW, fanSpeedSwByte, 'NONE'),
    airDirection: decodeEnum(AIR_DIRECTION, airDirByte, 'AUTO'),
    airStageCapability: airStageSwByte === 1 ? '5STAGES' : '4STAGES',
    tempLimits: {
      coolMin: round1(coolMin),
      coolMax: round1(coolMax),
      heatMin: round1(heatMin),
      heatMax: round1(heatMax),
      autoMin: round1(autoMin),
      autoMax: round1(autoMax),
    },
    tempDetail: tempDetailByte === 1,
    filterSign: filterSignByte === 1,
    raw: rawDump(bulk),
  };
  if (errorSignStr !== undefined) {
    state.errorSign = errorSignStr;
  }
  return state;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function rawDump(bulk: string): Record<string, string> {
  return {
    bulk,
    drive: bulk.slice(2, 4),
    mode: bulk.slice(4, 6),
    setTemp: bulk.slice(6, 10),
    inletTemp: bulk.slice(10, 14),
    airDirection: bulk.slice(14, 16),
    fanSpeed: bulk.slice(16, 18),
  };
}
