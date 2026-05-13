/**
 * Mitsubishi MELANS controllers come in two firmware families that share the
 * same XML envelope but differ on a handful of subsystem fields. We detect the
 * family from `SystemData.Model` and adapt schedule (and a few other) writes
 * accordingly.
 *
 * - `g50` — G-50A, GB-50A, G-50, G-50B, G-50BA (Copyright 2002-2007 / 2002-2009
 *   applets). Original protocol; `WPatternRecord` carries `SetBack` and does
 *   not require `AirDirection`.
 * - `ae200` — AE-200E, EW-50E, EW-50, AE-200 (Copyright 2002-2018+ applets).
 *   Newer protocol; `WPatternList` writes require `Season`, `WPatternRecord`
 *   writes must omit `SetBack` and must include `AirDirection`. Reads also
 *   require `Season`.
 */
export type FirmwareFamily = 'g50' | 'ae200';

const AE200_MODELS = new Set([
  'AE-200',
  'AE-200E',
  'EW-50',
  'EW-50E',
  'AE-50',
  'AE-50E',
]);

/**
 * Detect the firmware family from the controller's `SystemData.Model` string.
 *
 * Exact-match list first, then prefix fallback (`AE-*` / `EW-*` are all the
 * newer family). Missing / unrecognised models default to `g50`, the original
 * Mitsubishi protocol — known controllers stay correct, anything else gets the
 * older shape which is also what the legacy `mnet_client` always sent.
 */
export function detectFirmwareFamily(model: string | undefined): FirmwareFamily {
  if (!model) return 'g50';
  if (AE200_MODELS.has(model)) return 'ae200';
  if (/^(AE|EW)-/.test(model)) return 'ae200';
  return 'g50';
}
