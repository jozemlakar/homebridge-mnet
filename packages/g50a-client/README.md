# g50a-client

Node.js / TypeScript client for Mitsubishi Electric's **G-50A** / **GB-50A** (and close cousins **G-50**, **G-50B**, **G-50BA**, plus the newer **AE-200 / EW-50** family) centralized air-conditioning controllers. Communicates with the controller's built-in `/servlet/MIMEReceiveServlet` over plain HTTP using the MELANS XML protocol.

Framework-free — no Homebridge / no HAP dependency. Useful for:

- Building HomeKit / Home Assistant / Hubitat / etc. integrations
- Operational scripts ("turn off every unit at 9pm", "alert if any unit reports a fault")
- Trend logging into your own metrics pipeline

The full reverse-engineered protocol reference is at [`docs/g50a-protocol.md`](../../docs/g50a-protocol.md) in this repo.

## Install

```bash
pnpm add g50a-client
# or
npm install g50a-client
```

Requires Node 22.10+ (uses built-in `fetch` / `undici`).

## Usage

```ts
import { G50AClient } from 'g50a-client';

const client = new G50AClient({ host: '192.168.1.1' });

client.on('ready', () => console.log('Connected, groups:', client.getGroups()));
client.on('stateChanged', ({ group, current, changed }) => {
  console.log(`Group ${group} changed`, changed, '→', current);
});
client.on('error', (err) => console.error('Controller unreachable', err));

await client.start();

// Combined write — Drive + Mode + SetTemp in one XML round-trip.
const after = await client.setState(3, { drive: 'ON', mode: 'HEAT', setTemp: 22.5 });
console.log('Group 3 readback:', after);

await client.stop();
```

## API

### `new G50AClient(opts: ClientOptions, transport?: Transport)`

| Option | Default | Notes |
|---|---|---|
| `host` | — | Required. Controller hostname or IP. |
| `port` | `80` | |
| `pollIntervalMs` | `5000` | Bulk-poll cadence. Clamped to `2000–60000`. |
| `groupListIntervalMs` | `600000` | How often to re-fetch the group list (~10 min). |
| `requestTimeoutMs` | `8000` | Per-request timeout. |
| `errorThreshold` | `3` | Consecutive transport failures before entering backoff. |
| `backoffIntervalMs` | `30000` | Poll cadence while in backoff. |
| `removalQuorum` | `3` | Group-list cycles a group must be absent before unpublishing. |
| `logger` | silent | `{ debug?, info, warn, error }`. |

The second constructor argument lets you inject a `Transport` instance for testing.

### Methods

- `start(): Promise<void>` — reads SystemData, group list, performs first bulk poll, emits `ready`.
- `stop(): Promise<void>`
- `getGroups(): GroupInfo[]` — last-known IC groups.
- `getState(group): GroupState | undefined`
- `getSystemInfo(): SystemInfo | undefined`
- `setState(group, patch): Promise<GroupState>` — see "Writes" below.

### Events

| Event | Payload |
|---|---|
| `ready` | — |
| `groupsChanged` | `GroupInfo[]` |
| `stateChanged` | `{ group, previous, current, changed: (keyof GroupState)[] }` |
| `warning` | `{ group?, message, detail? }` |
| `error` | `Error` (typically `TransportError`) |

### Writes

`setState` accepts a partial patch. Calls within a 150ms window for the same group are merged into a single combined `<Mnet>` element — see [`docs/g50a-protocol.md §4.2`](../../docs/g50a-protocol.md). Resolves with the post-write readback, which is authoritative (the controller's writes are non-atomic; a `setErrorResponse` can still partially apply).

```ts
await client.setState(3, { drive: 'ON', mode: 'HEAT', setTemp: 22.5 });
```

- `drive` patches bypass the debouncer for snappy on/off.
- All temperatures are in degrees Celsius. If the controller is configured for Fahrenheit (`SystemData.TempUnit === 'F'`), the client converts at the boundary so consumers always see °C.

### Errors

```ts
import { PartialWriteError, ProtocolError, TransportError } from 'g50a-client';

try {
  await client.setState(...);
} catch (err) {
  if (err instanceof PartialWriteError) {
    // Some attributes persisted; err.readback is the authoritative state.
  } else if (err instanceof ProtocolError) {
    // Hard rejection: err.errors lists every <ERROR> element.
  } else if (err instanceof TransportError) {
    // Network / timeout. Retryable.
  }
}
```

### Raw M-NET pass-through (`MnetRouter`)

Beyond the high-level `<Mnet Group="N" ...>` interface, the controller exposes a low-level pass-through that forwards arbitrary M-NET frames to any unit on the bus. This is the same primitive Mitsubishi's MainteToolNet uses to read compressor frequencies, valve positions, refrigerant pressures — everything the public XML hides. No license, no authentication. See [`docs/g50a-protocol.md §8c`](../../docs/g50a-protocol.md) for details.

```ts
// Send raw M-NET command frames (hex) to a specific bus address.
// 66 = OC, 67 = BC main, 1..N = indoor units.
const replies = await client.sendMnetRaw(66, ['397EF0', '2100', '3112']);
// → [{ destination: 66, data: '397EF0', reply: '39FEF000DE...' }, ...]

// Convenience: read a 16-byte memory bank (returns the payload after the 3-byte header).
const bank80 = await client.readMnetBank(66, 0x80);
```

## Tests

```bash
pnpm --filter g50a-client test          # unit tests (fixtures + fake transport)
INTEGRATION_HOST=1.2.3.4 \
  pnpm --filter g50a-client test:integration   # live-controller test
```

## License

ISC.
