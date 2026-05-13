import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { G50AClient } from '../src/G50AClient.js';
import type { Transport } from '../src/transport.js';
import type { GroupStatePatch, StateChangeEvent } from '../src/types.js';
import { parsePacket } from '../src/xml.js';

const fixture = (name: string): string =>
  readFileSync(join(__dirname, '..', 'fixtures', name), 'utf8');

interface FakeTransportRecord {
  body: string;
}

function makeFakeTransport(responder: (body: string) => string): {
  transport: Transport;
  calls: FakeTransportRecord[];
} {
  const calls: FakeTransportRecord[] = [];
  const transport = {
    async send(body: string) {
      calls.push({ body });
      return parsePacket(responder(body));
    },
    async close() {},
  } as unknown as Transport;
  return { transport, calls };
}

describe('G50AClient — startup sequence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads SystemData, group list, then polls bulk; emits ready once', async () => {
    const groupListXml = fixture('group-list.xml');
    const bulkXml = fixture('bulk-poll-5.xml');
    const systemDataXml = fixture('system-data.xml');

    const { transport } = makeFakeTransport((body) => {
      if (body.includes('SystemData')) return systemDataXml;
      if (body.includes('MnetGroupList')) return groupListXml;
      if (body.includes('Bulk=')) return bulkXml;
      throw new Error(`Unexpected request: ${body.slice(0, 120)}`);
    });

    const client = new G50AClient({ host: '127.0.0.1' }, transport);
    const readySpy = vi.fn();
    const groupsSpy = vi.fn();
    client.on('ready', readySpy);
    client.on('groupsChanged', groupsSpy);

    await client.start();
    expect(readySpy).toHaveBeenCalledTimes(1);
    expect(groupsSpy).toHaveBeenCalledTimes(1);
    expect(client.getGroups().length).toBeGreaterThan(0);
    const g3 = client.getState(3);
    expect(g3?.drive).toBeDefined();
    const sys = client.getSystemInfo();
    expect(sys?.tempUnit).toBe('C');
    await client.stop();
  });
});

describe('G50AClient — setState coalescing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces three setState calls within the debounce window into one POST', async () => {
    const groupListXml = fixture('group-list.xml');
    const bulkXml = fixture('bulk-poll-5.xml');
    const systemDataXml = fixture('system-data.xml');
    const setResponseXml = fixture('set-response.xml');

    let setRequestCount = 0;
    const { transport, calls } = makeFakeTransport((body) => {
      if (body.includes('SystemData')) return systemDataXml;
      if (body.includes('<Command>setRequest')) {
        setRequestCount++;
        return setResponseXml;
      }
      if (body.includes('MnetGroupList')) return groupListXml;
      if (body.includes('Bulk=')) return bulkXml;
      throw new Error(`Unexpected request: ${body.slice(0, 120)}`);
    });

    const client = new G50AClient({ host: '127.0.0.1' }, transport);
    await client.start();

    const patches: GroupStatePatch[] = [{ mode: 'HEAT' }, { setTemp: 25 }, { fanSpeed: 'HIGH' }];
    const promises = patches.map((p) => client.setState(5, p));

    // Coalesce 150ms window — advance and let the chained reads resolve.
    await vi.advanceTimersByTimeAsync(160);
    await Promise.all(promises);

    expect(setRequestCount).toBe(1);
    // Find the single setRequest body — should contain all three attributes.
    const setCall = calls.find((c) => c.body.includes('<Command>setRequest'));
    expect(setCall?.body).toContain('Mode="HEAT"');
    expect(setCall?.body).toContain('SetTemp="25.0"');
    expect(setCall?.body).toContain('FanSpeed="HIGH"');

    await client.stop();
  });

  it('flushes a drive change immediately without waiting for the debounce window', async () => {
    const groupListXml = fixture('group-list.xml');
    const bulkXml = fixture('bulk-poll-5.xml');
    const systemDataXml = fixture('system-data.xml');
    const setResponseXml = fixture('set-response.xml');

    const { transport, calls } = makeFakeTransport((body) => {
      if (body.includes('SystemData')) return systemDataXml;
      if (body.includes('<Command>setRequest')) return setResponseXml;
      if (body.includes('MnetGroupList')) return groupListXml;
      if (body.includes('Bulk=')) return bulkXml;
      throw new Error(`Unexpected request: ${body.slice(0, 120)}`);
    });

    const client = new G50AClient({ host: '127.0.0.1' }, transport);
    await client.start();

    const setPromise = client.setState(5, { drive: 'OFF' });
    // Without advancing fake timers past the debounce window, the call must
    // have already been dispatched.
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.some((c) => c.body.includes('<Command>setRequest'))).toBe(true);
    await setPromise;
    await client.stop();
  });
});

describe('G50AClient — change events', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits stateChanged with the diff list on subsequent polls', async () => {
    const groupListXml = fixture('group-list.xml');
    const systemDataXml = fixture('system-data.xml');
    const baseBulk = fixture('bulk-poll-5.xml');

    // Simulate a follow-up poll where Group 3 changed mode.
    const variantBulk = baseBulk.replace(
      'Group="3" Bulk="010002190000E6000600',
      'Group="3" Bulk="010101180000E6000600',
    );

    let pollCount = 0;
    const { transport } = makeFakeTransport((body) => {
      if (body.includes('SystemData')) return systemDataXml;
      if (body.includes('MnetGroupList')) return groupListXml;
      if (body.includes('Bulk=')) {
        pollCount++;
        return pollCount === 1 ? baseBulk : variantBulk;
      }
      throw new Error(`Unexpected request: ${body.slice(0, 120)}`);
    });

    const client = new G50AClient(
      { host: '127.0.0.1', pollIntervalMs: 2000 },
      transport,
    );
    const events: StateChangeEvent[] = [];
    client.on('stateChanged', (e) => {
      if (e.group === 3) events.push(e);
    });
    await client.start();
    // First poll emits an initial-state event for every group.
    expect(events.length).toBe(1);

    await vi.advanceTimersByTimeAsync(2010);
    // Flush microtasks until the second poll has been ingested.
    await vi.advanceTimersByTimeAsync(0);

    expect(events.length).toBeGreaterThanOrEqual(2);
    const diff = events[events.length - 1]!;
    expect(diff.changed).toContain('drive');
    expect(diff.changed).toContain('mode');
    expect(diff.changed).toContain('setTemp');
    expect(diff.previous.mode).toBe('HEAT');
    expect(diff.current.mode).toBe('COOL');

    await client.stop();
  });
});

describe('G50AClient — MnetRouter raw frames', () => {
  it('round-trips a multi-command MnetRouter request', async () => {
    const { transport, calls } = makeFakeTransport(() => {
      return `<?xml version="1.0" encoding="UTF-8"?>
<Packet>
  <Command>setResponse</Command>
  <DatabaseManager>
    <MnetRouter>
      <MnetCommandList DA="66" CommandInterval="400">
        <MnetCommandRecord Data="397EF0" RcvData="39FEF000DE00040002840310E0050200" />
        <MnetCommandRecord Data="397EF1" RcvData="39FEF100100E0F000000000000000000" />
        <MnetCommandRecord Data="3112"   RcvData="3192FF" />
      </MnetCommandList>
    </MnetRouter>
  </DatabaseManager>
</Packet>`;
    });
    const client = new G50AClient({ host: '127.0.0.1' }, transport);
    const replies = await client.sendMnetRaw(66, ['397EF0', '397EF1', '3112']);
    expect(replies).toHaveLength(3);
    expect(replies[0]).toEqual({
      destination: 66,
      data: '397EF0',
      reply: '39FEF000DE00040002840310E0050200',
    });
    expect(replies[2]?.reply).toBe('3192FF');
    expect(calls[0]?.body).toContain('<MnetRouter>');
    expect(calls[0]?.body).toContain('DA="66"');
    expect(calls[0]?.body).toContain('CommandInterval="400"');
    expect(calls[0]?.body).toContain('Data="397EF0"');
    await client.stop();
  });

  it('readMnetBank strips the response header and returns the 16-byte payload', async () => {
    const { transport } = makeFakeTransport(() => {
      return `<?xml version="1.0" encoding="UTF-8"?>
<Packet><Command>setResponse</Command><DatabaseManager><MnetRouter>
  <MnetCommandList DA="66" CommandInterval="400">
    <MnetCommandRecord Data="397E80" RcvData="39FE80000264640000150000040000" />
  </MnetCommandList>
</MnetRouter></DatabaseManager></Packet>`;
    });
    const client = new G50AClient({ host: '127.0.0.1' }, transport);
    const bytes = await client.readMnetBank(66, 0x80);
    // Payload after stripping "39FE80"
    expect([...bytes]).toEqual([0x00, 0x02, 0x64, 0x64, 0x00, 0x00, 0x15, 0x00, 0x00, 0x04, 0x00, 0x00]);
    await client.stop();
  });

  it('rejects invalid destination + non-hex data + mismatched destinations', async () => {
    const { transport } = makeFakeTransport(() => '<Packet><Command>setResponse</Command></Packet>');
    const client = new G50AClient({ host: '127.0.0.1' }, transport);
    await expect(client.sendMnetRaw(0, ['397EF0'])).rejects.toThrow(/destination/);
    await expect(client.sendMnetRaw(66, ['39 7EF0'])).rejects.toThrow(/even-length hex/);
    await expect(
      client.sendMnetRaw(66, [{ destination: 67, data: '397EF0' }]),
    ).rejects.toThrow(/must share destination/);
    await client.stop();
  });

  it('surfaces controller-side ERROR responses as ProtocolError', async () => {
    const { transport } = makeFakeTransport(() => {
      return `<?xml version="1.0" encoding="UTF-8"?>
<Packet><Command>setErrorResponse</Command><DatabaseManager>
  <MnetRouter><MnetCommandList DA="99"/></MnetRouter>
  <ERROR Point="MnetRouter[DA=99]" Code="0001" Message="Unknown Object" />
</DatabaseManager></Packet>`;
    });
    const client = new G50AClient({ host: '127.0.0.1' }, transport);
    await expect(client.sendMnetRaw(99, ['397EF0'])).rejects.toThrow(/DA=99/);
    await client.stop();
  });
});
