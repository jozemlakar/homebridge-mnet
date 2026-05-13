# Deploying homebridge-mnet on a Raspberry Pi 4

End-to-end playbook for taking a wiped Raspberry Pi 4 and getting all 5 indoor units of your home G-50BA exposed to Apple HomeKit. About 45 minutes start to finish; ~30 of those are the OS image flash.

This is for a fresh wipe — if your Pi already runs Homebridge, jump straight to §4.

## 0. What you need

- **Raspberry Pi 4** (any RAM tier; 2 GB is plenty for Homebridge)
- **microSD card**, 16 GB+, Class 10 — UHS-1 or better
- **USB-C power supply**, the official 3 A one
- **Ethernet cable** to your home switch — strongly preferred over Wi-Fi for HomeKit's mDNS reliability. Wi-Fi works but expect occasional accessory drop-outs the first time HomeKit re-pairs.
- An **SD card reader** for your Mac
- A workstation on the same LAN as the Pi (you're already there)

You'll also need the two pnpm-packed tarballs from this repo:
- `dist-pack/g50a-client-0.1.0.tgz`
- `dist-pack/homebridge-mnet-2.0.0.tgz`

Both are produced by `pnpm -r pack` at the workspace root — see §3.

## 1. Flash the Homebridge Raspbian image

Don't bother with plain Raspberry Pi OS + manual Homebridge install. The official **Homebridge Raspbian Image** is a customised Pi OS Lite with Homebridge, Node.js LTS, and Homebridge Config UI X pre-installed and running on boot. The maintainers update it regularly and it's what 95% of Pi-based Homebridge installs use.

1. Download the latest image from <https://github.com/homebridge/homebridge-raspbian-image/releases>. Pick the **64-bit** asset (e.g. `image_<date>-Homebridge-trixie-64bit.zip` — ~1 GB). The Pi 4 is a 64-bit ARM (Cortex-A72); the 32-bit `armhf` build is only for older Pis (Pi 3 and earlier). "trixie" is Debian 13, the current stable.
2. Install **Raspberry Pi Imager** from <https://www.raspberrypi.com/software/>.
3. In Imager:
   - Pi device → **Raspberry Pi 4**
   - OS → **Use custom image** → select the downloaded `.img.xz`
   - Storage → your SD card (**verify the device** before clicking write — Imager overwrites without warning)
4. **Use the gear icon ⚙** in Imager before writing:
   - **Set hostname** → `homebridge` (default) or whatever you prefer
   - **Enable SSH** → check, **use password authentication**
   - **Set username and password** → `pi` / a strong password (you'll SSH in once)
   - **Configure wireless LAN** → skip if you're using Ethernet (recommended)
   - **Set locale** → your timezone (matters for HomeKit logs and the future schedule API)
5. Write the image. ~5-15 minutes depending on card speed.
6. Eject, put the card in the Pi, connect Ethernet, plug in power.
7. Wait ~2 minutes for first boot (image expands the partition, sets keys, starts services).

## 2. Find and reach the Pi

Three ways:

```bash
# Easiest if your router is mDNS-friendly (most are):
ssh pi@homebridge.local

# If that doesn't resolve, find the IP from your router's DHCP leases, or scan:
arp -a | grep -i "b8:27:eb\|dc:a6:32\|d8:3a:dd\|2c:cf:67"     # Pi MAC OUI prefixes
# Or: nmap -sn 192.168.1.0/24
```

Pin the Pi's IP in your router as a DHCP reservation. HomeKit cares less about the Pi's IP than the controller's, but consistent addresses help when debugging.

**First-time login:**

```bash
ssh pi@homebridge.local       # use the password you set in Imager
hb-config                     # one-time Homebridge interactive setup
```

The `hb-config` tool walks you through swapping the default port, generating a fresh PIN, etc. Accept defaults unless you know better.

## 3. Build and pack the plugin tarballs on your workstation

Back on your Mac:

```bash
cd ~/Razvijam/GitHub/homebridge-mnet
nvm use 22                                # or 24
pnpm install
pnpm -r build
pnpm -r test                              # all 45 tests should pass
mkdir -p dist-pack
(cd packages/g50a-client && pnpm pack --pack-destination ../../dist-pack)
(cd packages/homebridge-mnet && pnpm pack --pack-destination ../../dist-pack)
ls dist-pack/
# → g50a-client-0.1.0.tgz   homebridge-mnet-2.0.0.tgz
```

`pnpm pack` rewrites the `workspace:^` dependency in `homebridge-mnet/package.json` to `^0.1.0` — a real semver. The Pi will install `g50a-client` from its own tarball, not from npm (since we haven't published).

Copy both tarballs to the Pi:

```bash
scp dist-pack/*.tgz pi@homebridge.local:~
```

## 4. Install the plugin on the Pi

On the Pi (`ssh pi@homebridge.local`):

```bash
cd ~
# Homebridge plugins live under /var/lib/homebridge/node_modules on the Raspbian image.
# Install both tarballs side-by-side; the g50a-client tarball satisfies the dep.
sudo -u homebridge npm install -g ~/g50a-client-0.1.0.tgz ~/homebridge-mnet-2.0.0.tgz
```

Verify install:

```bash
sudo -u homebridge npm ls -g --depth=0 | grep -E 'g50a|homebridge-mnet'
# → homebridge-mnet@2.0.0
# → g50a-client@0.1.0
```

## 5. Configure the platform

Open the Homebridge UI in your browser: <http://homebridge.local:8581> (default port). Login with the admin user you set during `hb-config`.

1. **Plugins** tab → **Homebridge M-Net** card → ⚙ Settings.
2. Fill in:
   - **Controller IP or hostname**: `192.168.1.1` (the G-50BA at your home)
   - Leave port at `80`.
   - **Group display names** (optional): map your 5 indoor units. Group numbers come from the controller (`g50a state --host 192.168.1.1` will list them).

   Example:
   ```json
   {
     "platform": "MNET",
     "name": "M-NET",
     "host": "192.168.1.1",
     "groupNames": {
       "1": "Fitness",
       "2": "Living Room",
       "3": "Dining Room",
       "4": "Wardrobe",
       "5": "Bedroom"
     }
   }
   ```
3. Click **Save**, then **Restart Homebridge** from the dashboard.

Watch the Homebridge logs (Status tab) for `[M-NET]` lines. You should see:

```
[M-NET] [g50a] info: connecting to 192.168.1.1:80
[M-NET] Registered group 1 → "Fitness"
[M-NET] Registered group 2 → "Living Room"
... × 5
```

## 6. Pair with HomeKit

On any iPhone in the same Wi-Fi:

1. **Home app** → **+** → **Add or Scan Accessory** → **More options…**
2. Pick **Homebridge** from the list of nearby accessories. (If it doesn't appear, the Pi may not be mDNS-broadcasting — restart the Homebridge service: `sudo systemctl restart homebridge`.)
3. Enter the 8-digit PIN shown on the Homebridge dashboard.
4. Walk through the Home setup. Each of your 5 indoor units appears as a separate **Heater Cooler** accessory. Assign each to a Home room.

## 7. Verify end-to-end

On the iPhone:

- Tap any accessory tile → tap **Off** → tile flips to **Heating** or **Cooling**. The actual indoor unit should turn on within ~2 seconds.
- Drag the temperature slider — the controller should pick up the new setpoint on its next 5-second poll.
- Switch mode (Heat / Cool / Auto) — the unit's mode changes within a poll cycle.

Cross-check on the Pi:

```bash
ssh pi@homebridge.local
sudo journalctl -u homebridge -f | grep -i 'mnet\|setRequest\|setResponse'
```

Every Home app action should produce a corresponding `setRequest` line within the configured 250 ms debounce window.

## 8. Maintenance

- **Logs**: `sudo journalctl -u homebridge -e` (last screen) or `-f` (tail).
- **Restart**: `sudo systemctl restart homebridge`.
- **Update**: re-pack on the workstation and re-install on the Pi the same way as §4. The plugin's UUIDs are derived from the controller's MAC + group number ([packages/homebridge-mnet/src/MnetPlatform.ts](../packages/homebridge-mnet/src/MnetPlatform.ts) `uuidFor`), so accessories persist across reinstalls without losing their HomeKit-side pairings or scenes.
- **Backup**: the Homebridge UI has a one-click backup. Pull a backup before any controller-side schedule changes.
- **SD card health**: cheap cards die after ~3-5 years of Homebridge writes. Move to a USB-3 SSD if you care about longevity; the Pi 4 boots fine from SSD.

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| No `[M-NET]` lines in logs | Wrong `host` or controller unreachable | `ping 192.168.1.1` from the Pi; check the controller has an Ethernet cable; the controller's IP did not change (DHCP). |
| Pi can reach default gateway but not the controller (different subnet) | ICMP-redirect / pfSense routing — see §9a below | One sysctl + cache flush. |
| `[g50a] warning: SystemData read failed` | Controller doesn't answer the SystemData query in time | First connection on a cold controller can be slow. Plugin retries; ignore unless persistent. |
| Accessory shows "No Response" in Home | Controller unreachable for 3 consecutive poll cycles | Plugin auto-recovers when reachable again. If permanent, restart Homebridge after fixing the network. |
| Wrong room names | `groupNames` keys don't match the controller's group numbers | Run `g50a state --host 192.168.1.1` on the Pi (or your workstation) — the printed `group` column is the key to use. |
| Pi feels sluggish | Memory pressure or SD-card-bound | `htop` to check; usually Homebridge sits at ~80 MB RSS. Don't run on a 1 GB Pi. |

### 9a. Multi-subnet networks behind pfSense / OPNsense (the ICMP-redirect trap)

If your G-50A lives on a different subnet than the Pi (e.g. Pi on `192.168.0.0/24`, controller on `192.168.1.0/24`, both routed by pfSense), the plugin may report `Connect Timeout Error` to the controller even when ping from your Mac on the same Pi subnet works fine.

Cause: pfSense responds to the Pi's first packet with an ICMP redirect saying "go direct to the controller, skip me." The Pi's kernel honours it by default and caches a route to the controller via the controller's own IP on `eth0`. Subsequent packets reach the controller, but the controller's replies — which still go through pfSense — get dropped on an asymmetric path. Macs accept the redirects without issue because their existing connection state on pfSense is already warm; the Pi as a new client doesn't have that grace.

Diagnose:

```bash
ssh pi@homebridge.local
ip route get <controller-ip>
# If you see "cache <redirected>" → that's the issue.
```

Fix — disable ICMP redirect acceptance and flush the bad cache:

```bash
sudo sysctl -w net.ipv4.conf.all.accept_redirects=0 \
                net.ipv4.conf.default.accept_redirects=0 \
                net.ipv4.conf.eth0.accept_redirects=0
sudo ip route flush cache
# Persist across reboots:
echo 'net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0' | sudo tee /etc/sysctl.d/99-no-redirects.conf
sudo systemctl restart homebridge
```

Verify: `ping <controller-ip>` should now succeed, and `ip route get <controller-ip>` should resolve via your default gateway (no `<redirected>` flag).

## 10. The plugin's own diagnostics

The `g50a` CLI ships with the plugin. From the Pi:

```bash
# Where does it live after global install?
sudo -u homebridge npm root -g    # → /var/lib/homebridge/node_modules

cd /var/lib/homebridge/node_modules/g50a-client
node dist/cli.js state --host 192.168.1.1            # current state of every group
node dist/cli.js dump  --host 192.168.1.1 --out=backup.json     # back up schedules
```

These are read-only by default; `apply` is the only write command.

## Appendix: hardware caveats

- **Pi 5** also works (faster), but the Homebridge Raspbian Image lags behind by a few months on Pi 5 compatibility — check the release notes before going Pi 5.
- **Pi Zero 2 W** is borderline — runs Homebridge but laggy with this many accessories; not recommended.
- **Heat**: a bare Pi 4 throttles after ~20 minutes under sustained load. Homebridge load is light, so it's fine, but the official Pi 4 case has decent passive cooling — worth using.
