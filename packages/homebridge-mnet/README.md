# homebridge-mnet

Homebridge plugin that bridges Mitsubishi Electric M-NET centralized AC controllers (G-50A / GB-50A / G-50 / G-50B / G-50BA) to Apple HomeKit. Each indoor unit appears as a HomeKit HeaterCooler accessory.

Built on top of the [`g50a-client`](../g50a-client) library — auto-discovers indoor units from the controller, no manual address mapping needed.

## Install

Through the Homebridge UI: search **homebridge-mnet** and click *Install*. Or via npm:

```bash
sudo npm install -g homebridge-mnet
```

## Configure

Minimal config — just the controller's IP:

```jsonc
{
  "platforms": [
    {
      "platform": "MNET",
      "name": "M-NET",
      "host": "192.168.1.1"
    }
  ]
}
```

Full config schema (all fields beyond `host` are optional):

| Field | Default | Notes |
|---|---|---|
| `host` | — | **Required.** IP or hostname of your G-50A controller. |
| `port` | `80` | Almost never needs changing. |
| `pollIntervalMs` | `5000` | How often to read state from the controller. Range 2000–60000. |
| `autoModeDeadbandC` | `2.0` | HomeKit's AUTO mode wants two thresholds; the controller has one setpoint. We bracket the setpoint by ±half this value. |
| `groupNames` | `{}` | Per-group display-name overrides keyed by group number string. |
| `excludeGroups` | `[]` | Group numbers to hide from HomeKit. |

The Homebridge UI surfaces all of this through a form — no need to edit JSON by hand.

## What gets exposed

For each registered indoor unit on the controller, a HeaterCooler accessory with:

- **Active** — on/off
- **CurrentHeaterCoolerState** — Inactive / Idle / Heating / Cooling, derived from the live mode and the room-vs-setpoint delta
- **TargetHeaterCoolerState** — Auto / Heat / Cool
- **CurrentTemperature** — room (inlet) temperature
- **CoolingThresholdTemperature** / **HeatingThresholdTemperature** — setpoints, with min/max pulled from the controller's reported `CoolMin/CoolMax/HeatMin/HeatMax`
- **RotationSpeed** — fan speed, bucketed (Low / Mid1 / Mid2 / High) per the unit's reported capability
- **SwingMode** — Swing / Auto louver
- **StatusFault** — flips to *general fault* if the indoor unit reports `ErrorSign` or the controller becomes unreachable

## Migration from v1

The v1 plugin required a hand-written `mnet_config.json` with KNX-style `1/3/2` sub-addresses for every characteristic. v2 throws all of that away — set `host` and optionally `groupNames`, the rest is auto-discovered. There is no automated migration tool; just re-enter your room names in the UI.

## Requirements

- Node 22.10+ (or 24+)
- Homebridge 1.8+ (works on 2.x)
- A G-50A / GB-50A / similar controller reachable over HTTP on your LAN. The plugin does not require any controller-side configuration beyond the indoor units being registered as groups.

## Security

The XML protocol on these controllers is **unauthenticated on the wire** — the applet's "login" only gates the UI. Anyone on the LAN can reconfigure the controller. Treat your controller as needing network segmentation; do not expose it to the internet.

See [`docs/g50a-protocol.md §6`](../../docs/g50a-protocol.md) for the disassembly evidence behind this claim.

## Troubleshooting

- **"No host configured"** — set `host` in the platform config.
- **"Controller unreachable"** — verify `ping` works to the controller and HTTP responds: `curl http://<host>/index.html` returns HTML.
- **Group missing in HomeKit** — restart Homebridge once after first install. The plugin auto-discovers but waits for the controller's group-list refresh (10 min) before unpublishing missing groups, which can confuse first-run timing.
- **Group `Model="??"`** — appears for the first 1–2 minutes after registering new units on the controller. The plugin filters these out until they resolve to `Model="IC"`. Restart Homebridge or wait.

## License

ISC.
