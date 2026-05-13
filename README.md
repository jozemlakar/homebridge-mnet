# homebridge-mnet (v2 monorepo)

Bridge Mitsubishi Electric M-NET centralized AC controllers (G-50A / GB-50A / G-50 / G-50B / G-50BA, and the newer EW-50E / AE-200 family) to Apple HomeKit. Each indoor unit appears as a HomeKit HeaterCooler accessory; commands round-trip through the controller's XML-over-HTTP servlet.

## Packages

| Package | npm | Description |
|---|---|---|
| [`packages/g50a-client`](packages/g50a-client) | [`g50a-client`](https://www.npmjs.com/package/g50a-client) | Framework-free Node.js / TypeScript client for the G-50A XML protocol. Polling, write coalescing, change-event emitter. |
| [`packages/homebridge-mnet`](packages/homebridge-mnet) | [`homebridge-mnet`](https://www.npmjs.com/package/homebridge-mnet) | Homebridge DynamicPlatform plugin built on top of the client. UI-driven config, auto-discovery of indoor units. |

Install via Homebridge UI ("Plugins" → search `homebridge-mnet`), or:

```bash
npm install -g homebridge-mnet
```

## Quick start

```bash
nvm use 22       # or 24
corepack enable
pnpm install
pnpm -r build
pnpm -r test
```

To smoke-test against your controller without Homebridge:

```bash
INTEGRATION_HOST=192.168.1.1 pnpm --filter g50a-client test:integration
```

## Reverse-engineered protocol

The G-50A XML protocol is documented in [`docs/g50a-protocol.md`](docs/g50a-protocol.md). It was reverse-engineered by disassembling the controller's Java applets and verified against a live G-50BA running firmware 3.22. The doc covers the envelope, all `DatabaseManager` subsystems, the runtime `<Mnet>` element with full enum tables, group registration, error codes, and the (non-)authentication model.

## License

ISC.
