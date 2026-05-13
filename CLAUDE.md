# homebridge-mnet (v2)

pnpm monorepo containing a Homebridge plugin and a framework-free protocol client for **Mitsubishi Electric M-NET** centralized AC controllers (G-50A / GB-50A and close cousins).

The full XML protocol is reverse-engineered in [docs/g50a-protocol.md](docs/g50a-protocol.md) and **is the source of truth**. Update it whenever you discover new behavior — protocol-doc accuracy is load-bearing for both packages.

## Layout

```
homebridge-mnet/
├── docs/g50a-protocol.md            # protocol reference (must stay in sync)
├── packages/
│   ├── g50a-client/                 # framework-free protocol client (publishable)
│   │   ├── src/
│   │   │   ├── G50AClient.ts        # central client (polling, write coalescing, events, schedules)
│   │   │   ├── transport.ts         # undici HTTP + serialization queue
│   │   │   ├── xml.ts               # fast-xml-parser wrappers
│   │   │   ├── bulkDecoder.ts       # byte-layout decoder for Mnet Bulk
│   │   │   ├── schedule.ts          # WPatternRecord encode/decode, day-of-week mapping
│   │   │   ├── cli.ts               # g50a CLI: state / dump / apply
│   │   │   ├── errors.ts            # TransportError / ProtocolError / PartialWriteError
│   │   │   └── types.ts             # GroupState, GroupInfo, ClientOptions, WeeklySchedule
│   │   ├── test/                    # vitest, fixture-driven goldens
│   │   └── fixtures/                # captured XML responses + bulk hex strings
│   └── homebridge-mnet/             # Homebridge DynamicPlatform plugin
│       ├── src/
│       │   ├── index.ts             # registerPlatform export
│       │   ├── MnetPlatform.ts      # DynamicPlatform, owns one G50AClient
│       │   ├── MnetAccessory.ts     # per-group accessory (AccessoryInfo + HeaterCooler)
│       │   ├── MnetHeaterCoolerService.ts  # HAP characteristic wiring + 250ms debounce
│       │   └── mapping.ts           # pure HK↔M-NET converters (no HAP imports)
│       ├── config.schema.json
│       └── test/
├── .github/workflows/               # CI (build+test on Node 22/24), publish on tag
├── pnpm-workspace.yaml
├── tsconfig.base.json               # strict, NodeNext, ES2022
└── eslint.config.mjs                # flat config, shared
```

## Toolchain

- **Node** ≥ 22.10 (LTS) — see `engines` in each `package.json`. Activate via `nvm use 22`.
- **pnpm** 9.x — `corepack enable && corepack prepare pnpm@9.15.0 --activate`.
- **TypeScript** 5.7+, CommonJS output, NodeNext resolution.
- **vitest** for tests (per-package config; `g50a-client` has a separate integration config gated by `INTEGRATION_HOST`).
- **ESLint 9 flat config** at the root, **Prettier** for formatting.

## Common commands

```bash
pnpm install                              # install all workspace deps
pnpm -r build                             # build both packages
pnpm -r test                              # run all unit tests
pnpm --filter g50a-client test            # one package
pnpm --filter g50a-client test:integration # live-controller test
INTEGRATION_HOST=192.168.1.1 pnpm --filter g50a-client test:integration
pnpm lint                                 # eslint
pnpm format                               # prettier --write
```

For a local Homebridge smoke test against the live controller:

```bash
pnpm --filter homebridge-mnet build
cd ~/.homebridge && npm link homebridge-mnet
homebridge -D
```

The `g50a` CLI under `packages/g50a-client/dist/cli.js` can be invoked directly for offline schedule management (the TG-2000A replacement use case):

```bash
node packages/g50a-client/dist/cli.js state  --host <h> [--port <p>]
node packages/g50a-client/dist/cli.js dump   --host <h> [--port <p>] [--group N] --out=schedules.json
node packages/g50a-client/dist/cli.js apply  --host <h> [--port <p>] --in=schedules.json [--dry-run]
```

The `apply` command sends ALL records for each Group×Day in one packet — replace semantics, no partial-update. Backup first with `dump` before any write.

## Architecture notes

- **`g50a-client` has zero Homebridge or HAP dependencies.** It's pure protocol. The `homebridge-mnet` package consumes it via `workspace:^`.
- **Transport queue invariant**: only one HTTP request to the controller in flight at a time. The controller is HTTP/1.0 and pipelining causes response interleaving. Don't break this without revisiting `Transport.send`.
- **Write coalescing**: two-level debounce. HeaterCooler service holds 250 ms on the HK side; client holds 150 ms more on the protocol side. Drive changes bypass both for snappy on/off.
- **Read-after-write**: after every `setRequest`, the client immediately polls `<Mnet Bulk="*"/>` for the affected group and treats the readback as authoritative. The protocol's writes are non-atomic — a `setErrorResponse` can still partially apply.
- **No authentication**: the controller does not validate XML-level credentials. `<UserAuth>` is a UI gate in the applet only. Verified by disassembly — see [docs/g50a-protocol.md §6](docs/g50a-protocol.md).

## Conventions

- TypeScript everywhere; no JS in `src/`.
- File-level imports use `.js` extensions on relative paths (NodeNext requires this even when source is `.ts`).
- No `any` in `src/`; tests may use it sparingly.
- All public API in `g50a-client` is re-exported through `src/index.ts`.
- Tests live in `test/` next to `src/`, not interleaved. Fixtures live in `fixtures/`.
- No comments that re-state the code. Comments explain *why* — protocol quirks, deliberate non-obvious choices.
- Don't write to `mnet_config.json` — it's gone. Config lives in Homebridge's `config.json` under the `MNET` platform, schema in [packages/homebridge-mnet/config.schema.json](packages/homebridge-mnet/config.schema.json).

## Live test environment

A G-50BA running firmware 3.22 is available on the local network for integration testing. The integration test (`INTEGRATION_HOST=<host> pnpm --filter g50a-client test:integration`) reads its address from the environment variable so nothing repo-resident pins to a specific install.

Controller-side group names are partial / cosmetic — see [docs/g50a-protocol.md §5.2](docs/g50a-protocol.md) for the `GroupNameWeb` validation quirk. The Homebridge plugin uses its own `groupNames` config so this never affects HomeKit.

## Verified-plugin checklist (homebridge-mnet)

Already in place:
- `pluginAlias: MNET`, `pluginType: platform`, `singular: true`, `strictValidation: false`
- engines for both `node` (^22.10 || ^24) and `homebridge` (^1.8 || ^2)
- Keyword `homebridge-plugin`, displayName, repository, bugs URL, homepage
- `config.schema.json` rendering via homebridge-config-ui-x
- No peerDependencies, no TTY at startup, no post-install hacks
- Cache files only under Homebridge's `storagePath` (we don't write any)

Outstanding before applying for the verified badge:
- Publish to npm and create the first GitHub release
- README screenshots
