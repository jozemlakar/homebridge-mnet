/**
 * Live-controller integration test. Opt-in: set INTEGRATION_HOST to the
 * controller's IP. Skipped otherwise so CI stays green.
 *
 *     INTEGRATION_HOST=192.168.1.1 pnpm --filter g50a-client test:integration
 */
import { describe, expect, it } from 'vitest';
import { G50AClient } from '../src/G50AClient.js';

const HOST = process.env['INTEGRATION_HOST'];
const describeFn = HOST ? describe : describe.skip;

describeFn('G50AClient — live controller', () => {
  it('discovers groups, polls state, and round-trips a Drive=OFF write', async () => {
    const client = new G50AClient({ host: HOST!, pollIntervalMs: 2000 });
    try {
      await client.start();
      const groups = client.getGroups();
      expect(groups.length).toBeGreaterThan(0);

      const target = groups[0]!;
      const before = client.getState(target.group);
      expect(before).toBeDefined();
      const after = await client.setState(target.group, { drive: 'OFF' });
      expect(after.drive).toBe('OFF');

      const sys = client.getSystemInfo();
      expect(sys?.macAddress).toMatch(/^[0-9A-F]{12}$/);
    } finally {
      await client.stop();
    }
  });
});
