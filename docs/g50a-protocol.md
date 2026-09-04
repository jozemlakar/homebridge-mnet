# G-50A / GB-50A XML Protocol Reference

Unofficial reverse-engineered reference for the centralized-controller XML protocol used by Mitsubishi Electric's G-50A / GB-50A (and close relatives — G-50, G-50B, G-50BA). All findings come from disassembling the controller's own Java applets, `g50.jar` and `g50pub.jar`, served directly by the controller at `/g50.jar` and `/g50pub.jar`.

The same protocol is also spoken by the newer **AE-200 / EW-50** family (verified on **EW-50E** firmware 7.70). Newer firmware emits a few additional attributes (e.g. `SubModel` on `MnetGroupRecord`) but envelope, command verbs, and the runtime `<Mnet>` schema are unchanged.

> **Status**: in-progress. The runtime control subset (sections 2–4) is confirmed working against a live controller. Group registration and authenticated maintenance operations (sections 5–6) are reconstructed from class fields and have not all been verified end-to-end.

## 1. Transport

- HTTP/1.0, `POST /servlet/MIMEReceiveServlet`
- `Content-Type: text/xml`, `Content-Length` set
- Body is a single `<Packet>` envelope, UTF-8
- No HTTP-level authentication (`Authorization`, cookies, `WWW-Authenticate` are all absent in `g50/core/HttpClientNml`). Authentication happens *inside* the XML envelope — see §6.
- Single endpoint constant: `HttpClient.DEFAULT_URL = "/servlet/MIMEReceiveServlet"` (`g50/core/HttpClient`).

## 2. Envelope

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Packet>
  <Command>getRequest</Command>           <!-- or setRequest -->
  <!-- optional: UserAuth, Client/Server, Display, Delivery, DestinationManager, LonDevice, ViewManager -->
  <DatabaseManager>
    <!-- subsystem queries / mutations -->
  </DatabaseManager>
</Packet>
```

Top-level vocabulary (`g50/core/G50XmlTb`):

| Element | Purpose |
|---|---|
| `Packet` | Envelope root |
| `Command` | Text content: `getRequest` or `setRequest` |
| `Client`, `Server` | Optional endpoint identifiers |
| `Database`, `DatabaseManager` | Container for record-style subsystems |
| `Delivery`, `DestinationManager`, `DestinationDomain`, `DestinationCategory`, `SourceDomain`, `SourceManager` | Routing in multi-controller setups (TG-2000A) |
| `Display`, `LonDevice`, `ViewManager` | Misc |
| `UserAuth` | Authentication tokens for the request (see §6) |

Error responses use `<Command>getErrorResponse</Command>` (or `setErrorResponse`) with `<ERROR Point="..." Code="..." Message="..."/>`. Multiple `<ERROR>` elements can appear in one response.

Observed error codes:

| Code | Message | Trigger |
|---|---|---|
| `0001` | `Unknown Object` | Element not supported by this firmware (e.g. `<ConnectionInfo/>`) |
| `0101` | `Unknown Attribute` | Attribute placed on the wrong element (e.g. `Group` on `<ScheduleControl>` itself rather than on its child list elements). |
| `0102` | `Insufficiency Attribute` | A required attribute is missing (e.g. `Pattern` omitted on a `<WPatternList>` query). |
| `0201` | `Invalid Value` | Attribute value failed per-field validation. `Point` is reported as `<AttributeName>[<your value>]`. Other attributes in the same request may have applied successfully — always `getRequest` to confirm. |

## 3. DatabaseManager subsystems

`g50/apl/ControlGroup` exposes the following list types under `<DatabaseManager><ControlGroup>...</ControlGroup></DatabaseManager>`, each with both read (`getRequest`) and write (`setRequest`) support:

| Element | Record element | Purpose |
|---|---|---|
| `MnetGroupList` | `MnetGroupRecord` | Logical groups (HomeKit "rooms"): one group = one or more M-NET units treated together |
| `MnetList` | `MnetRecord` | Per-group display names |
| `AreaList` | `AreaRecord` | Areas/zones |
| `AreaGroupList` | `AreaGroupRecord` | Group-to-area assignment |
| `McList` | `McRecord` | Maintenance Controllers (MC / MC-p / MC-t) |
| `McNameList` | `McNameRecord` | MC display names |
| `InterlockList` | `InterlockRecord` | Cross-unit interlocks |
| `DdcInfoList` | `DdcInfoRecord` | Direct Digital Controllers (DIDO/AI/PI extension units) |
| `ViewInfoList` | `ViewInfoRecord` | Floor-plan view info |

Direct M-NET runtime control lives one level up, directly under `<DatabaseManager>`:

| Element | Class | Purpose |
|---|---|---|
| `Mnet` | `g50/apl/Mnet` | Per-group runtime state (Drive, Mode, SetTemp, ...) — see §4 |

Other top-level subsystems (each handled by its own `g50/apl/*` class — `Alarm`, `Clock`, `SummerTime`, `EnergyControl`, `FunctionControl`, `LANRouter`, `Measure`, `ScheduleControl`, `SystemData`, `UserAuth`, ...). These follow the same `getData`/`setData` pattern but are not documented here yet.

## 4. Runtime control: the `<Mnet>` element

Used by both `getRequest` (read state) and `setRequest` (write commands) against an already-registered group. **No authentication required** — `getRequest` and `setRequest` Drive/Mode/Temp work anonymously against the controller (confirmed in this plugin, see [lib/mnet_client.js](../lib/mnet_client.js)).

### 4.1 Read all state for a group

```xml
<Packet>
  <Command>getRequest</Command>
  <DatabaseManager>
    <Mnet Group="1" Bulk="*"/>
  </DatabaseManager>
</Packet>
```

The response carries `<Mnet Group="1" Bulk="..."/>` with an opaque, hex-encoded payload. Decoding is implemented in `g50/apl/MnetGroupBulk` (and parsed locally in [lib/mnet_parser.js](../lib/mnet_parser.js)). The bulk's logical fields are enumerated in `g50/apl/MnetGroupTb`:

```
Drive, DriveItem, Mode, ModeItem, ModeStatus, SetTemp, SetTempItem, FanSpeed,
AirDirection, AirAutoSW, AirDirectionSW, AirStageSW, AutoMax, AutoMin, AutoModeSW,
BypassSW, ControlValue, CoolMax, CoolMin, DryModeSW, EnergyControl, ErrorSign,
FanAutoSW, FanModeSW, FanSpeedSW, FilterItem, FilterSign, GroupNameLcd,
HeatMax, HeatMin, HeatRecoverySW, IcKind, InletTemp, LcAutoSW, MaxSaveValue,
MidTempSW, Model, RemoCon, Schedule, SwingSW, TempDetail, TempLimit,
TempLimitCool, TempLimitHeat, TurnOff, Ventilation, VentilationSW
```

`*SW` fields are capability flags (whether the unit supports a feature), not state.

### 4.2 Write runtime state

Each attribute in the table below can be written individually or **combined into a single `<Mnet>` element**; both forms are accepted (verified). Multiple `<Mnet>` elements for different groups can also be packed into one `setRequest`.

```xml
<!-- one attribute at a time (what the current plugin code does — needlessly chatty) -->
<Mnet Group="N" Drive="ON"/>
<Mnet Group="N" Mode="HEAT"/>
<Mnet Group="N" SetTemp="22.0"/>

<!-- combined: same effect, one round-trip -->
<Mnet Group="N" Drive="ON" Mode="HEAT" SetTemp="22.0" FanSpeed="LOW" AirDirection="SWING"/>

<!-- multiple groups in one Packet -->
<DatabaseManager>
  <Mnet Group="2" Drive="ON" Mode="HEAT" SetTemp="25"/>
  <Mnet Group="3" Drive="ON" Mode="HEAT" SetTemp="25"/>
</DatabaseManager>
```

Attribute set:

| Attribute | Values |
|---|---|
| `Drive` | `ON` / `OFF` / `TESTRUN` |
| `Mode` | see §4.3 |
| `SetTemp` | decimal degrees in the controller's `TempUnit` (C or F) |
| `FanSpeed` | see §4.3 |
| `AirDirection` | see §4.3 |

### 4.3 Enum values (`g50/apl/MnetGroupValTb`)

**Drive**: `ON`, `OFF`, `TESTRUN`

**Mode** (full set the firmware knows about):

```
AUTO, COOL, HEAT, DRY, FAN, AUTOCOOL, AUTOHEAT, LC_AUTO,
BYPASS, BAHP, HEATRECOVERY, DEFLOST, OUTCOOL, PANECOOL, PANEHEAT, VENTILATE
```

The everyday user-settable subset is `AUTO`, `COOL`, `HEAT`, `DRY`, `FAN`. `AUTOCOOL`/`AUTOHEAT` are reported by the unit when in AUTO mode and currently cooling/heating. The rest describe special equipment states (defrost, bypass, heat-recovery cycles, ventilation-only units).

**FanSpeed**: `AUTO`, `LOW`, `MID1`, `MID2`, `HIGH`
**FanSpeed capability** (`FanSpeedSW`): `NONE`, `2STAGES`, `3STAGES`, `4STAGES`

**AirDirection**: `AUTO`, `SWING`, `HORIZONTAL`, `VERTICAL`, `MID0`, `MID1`, `MID2`
**AirStage capability** (`AirStageSW`): `4STAGES`, `5STAGES`

**Model** codes (`g50/apl/MnetGroupValTb` MODEL_*):

```
NONE, NOUSE, TMP, QQ,
IC,  OC,  OCi,        ← indoor / outdoor / outdoor-i
AN,  BC, BS,
CDC, CR,  DC, DDC,
FU, GR, GW, IDC, IU,
KA, KIC, LC, MA,
MC, MCp, MCt, ME,
OS, RC, SC, SR, ST, TR, TU, VDC, AIC
```

For HomeKit-relevant home installations, **`IC`** is the only one we filter on (indoor unit) — see [lib/mnet_client.js:107](../lib/mnet_client.js#L107).

### 4.4 Bulk poll multiple groups in one request

```xml
<Packet><Command>getRequest</Command>
  <DatabaseManager>
    <Mnet Group="1" Bulk="*"/>
    <Mnet Group="2" Bulk="*"/>
    ...
  </DatabaseManager>
</Packet>
```

This is how [lib/mnet_client.js:fetchAllGroups](../lib/mnet_client.js#L132) implements its 2-second status poll.

## 5. Group registration (Maintenance)

> **Reconstruction.** Schema derived from `g50/apl/MnetGroupRecord`, `g50/apl/MnetRecord`, `g50/apl/ControlGroup`. Not yet verified end-to-end. Almost certainly requires `<UserAuth>` (§6).

### 5.1 Read current group list

```xml
<Packet><Command>getRequest</Command>
  <DatabaseManager>
    <ControlGroup>
      <MnetGroupList/>
    </ControlGroup>
  </DatabaseManager>
</Packet>
```

Response (when populated):

```xml
<MnetGroupList>
  <MnetGroupRecord Group="1" Model="IC" Address="1" Contact="0"/>
  <MnetGroupRecord Group="2" Model="IC" Address="2" Contact="0"/>
  ...
</MnetGroupList>
```

| `MnetGroupRecord` attr | Meaning |
|---|---|
| `Group` | Logical group number (1-50, see §5.3) |
| `Model` | Unit type code (§4.3); `IC` for indoor units |
| `Address` | Physical M-NET bus address of the unit (1-50 for IC, see `Mnet.IC_ADDRESS_MIN/MAX`) |
| `Contact` | "Contact" / hand-controller flag — typically `0` |
| `SubModel` *(EW-50E / AE-200 family only)* | Optional refined classification. Frequently empty even when present. Older G-50A / GB-50A firmware does not emit this attribute. |

Group numbers can be **sparse** in practice (missing IDs between registered groups) and may **exceed 30** — observed up to 38 on a 34-unit install. Clients that derive accessory identity from group numbers should treat them as opaque keys, not consecutive indices.

### 5.2 Write the group list

```xml
<Packet><Command>setRequest</Command>
  <DatabaseManager>
    <ControlGroup>
      <MnetGroupList>
        <MnetGroupRecord Group="1" Model="IC" Address="1"/>
        <MnetGroupRecord Group="2" Model="IC" Address="2"/>
        <MnetGroupRecord Group="3" Model="IC" Address="3"/>
        <MnetGroupRecord Group="4" Model="IC" Address="4"/>
        <MnetGroupRecord Group="5" Model="IC" Address="5"/>
      </MnetGroupList>
      <MnetList>
        <MnetRecord Group="1" GroupNameLcd="ROOM1" GroupNameWeb="Room 1"/>
        <MnetRecord Group="2" GroupNameLcd="ROOM2" GroupNameWeb="Room 2"/>
        <!-- one MnetRecord per group; see §5.2 quirks below -->
      </MnetList>
    </ControlGroup>
  </DatabaseManager>
</Packet>
```

No `<UserAuth>` required — see §6. Set requests on `ControlGroup` are accepted anonymously.

`GroupNameLcd` is the short name shown on the controller's LCD and on simple remote controllers. `GroupNameWeb` is the longer name shown in the web UI.

**Empirically observed validation rules** (probed against firmware copyright 2002-2007):

| Field | Behaviour |
|---|---|
| `GroupNameLcd` | Fixed 10-byte field, space-padded. Character-set restricted: lowercase Latin letters are **silently stripped** (not errored). Writing a mixed-case string like `"Mixedcase"` results in stored value `"M         "` (only the leading uppercase `M` survives). Try uppercase ASCII first; the LCD's character ROM likely only includes a subset of CP-437. |
| `GroupNameWeb` | Stricter validator: `<ERROR Point="GroupNameWeb[<your value>]" Code="0201" Message="Invalid Value"/>`. Rejects multi-word lowercase ASCII strings. Length limit, charset, or both — not yet pinned down. The field gets cleared to `""` when rejected. |

**Important: non-atomic writes**. A `setErrorResponse` does **not** mean nothing was written. The above probe was logged as `setErrorResponse` with errors on every `GroupNameWeb`, yet the `MnetGroupList` part of the same request succeeded fully and the `GroupNameLcd` fields were partially applied (with stripping). After any `setErrorResponse`, always `getRequest` to see what actually persisted.

### 5.3 Address / group ranges (`g50/apl/Mnet`, `g50/apl/Common`)

| Constant | Range | Notes |
|---|---|---|
| `Mnet.IC_ADDRESS_MIN` / `MAX` | 1..50 | Indoor unit M-NET addresses |
| `Mnet.OC_ADDRESS_MIN` / `MAX` | 51..100 | Outdoor unit addresses (`OC_ADDRESS_OFFSET` = 50) |
| `Mnet.ADDRESS_MIN` / `MAX` | 1..255 | Hard protocol range |
| `ControlGroup.ADDRESS_MIN` / `MAX` | — | Group-number range (typically 1..50 on G-50A) |

### 5.4 What is NOT registered through `MnetGroupList`

Sub-elements of a group beyond the head unit (e.g. a remote controller attached to the same group, or a second IC slaved off the first) are typically registered via separate sub-records. The applet additionally writes:

- `<McList>` / `<McNameList>` — remote controllers in the system
- `<InterlockList>` — relations like "turn off group A when group B turns off"
- `<AreaList>` / `<AreaGroupList>` — only used by the area-based UI

For a simple installation (5 IC units, each its own group, no second remote, no interlocks), the §5.2 request alone should suffice. To-be-verified.

## 6. Authentication (`g50/apl/UserAuth`, `g50/apl/Crypt`)

> **Verified by disassembly: the XML protocol is unauthenticated.** `UserAuth` exists only as a UI gate inside the applet — it controls which panels are enabled after "login" — but the controller itself does not validate authentication on incoming HTTP requests. Privileged writes (group registration, network config, user-list edits) are accepted from any client on the LAN.
>
> Evidence:
> - `g50/core/HttpClient` is a 2-method interface (`sendXML`, `getBody`) with no auth state. `HttpClientNml` constructors take only `(host, port[, proxy, ...])` — never credentials.
> - `g50/apl/ControlGroup` and `g50/apl/Mnet` (the classes that build all the `setRequest` packets) contain **zero** references to `UserAuth`, `Crypt`, `AuthID`, `AuthKey` or `Password` in their bytecode.
> - `UserAuth` is referenced only by UI classes: `G50Applet`, `LoginSettings`, `UserRecordSettings*`, `UserRecord*Panel*`, and the `View*SettingsPanel` classes that filter visible groups by `AvailableGroup`.
>
> This is the trust model these controllers were designed under (LAN-isolated, behind a building's management network). Treat any G-50A reachable from a non-trusted network as effectively unauthenticated — segment it.

### 6.1 User categories

`g50/apl/UserAuth` exposes three categories:

| Constant | XML value | Default credentials (factory) |
|---|---|---|
| `USER_CATEGORY_PUBLIC_USER` | `PublicUser` | None (anonymous read) |
| `USER_CATEGORY_ADMINISTRATOR` | `Administrator` | `administrator` / `admin` (confirm with manual) |
| `USER_CATEGORY_MAINTENANCE` | `Maintenance` | `initial` / `init` (confirm with manual) |

### 6.2 Vocabulary

`UserAuth` element attributes (from `g50/apl/UserAuth` constants):

| XML name | Constant | Notes |
|---|---|---|
| `AuthID` | `AUTH_ID` | Session token issued by the controller |
| `AuthKey` | `AUTH_KEY` | Session secret, also issued by the controller |
| `PasswordKey` | `PASSWORD_KEY` | Encrypted form of `Password` for transport |
| `HtmlKey` | `HTML_KEY` | Used by the HTML-based UI variants |

User record (`g50/apl/UserRecord`):

| XML name | Notes |
|---|---|
| `User` | Username |
| `Password` | Cleartext (never sent over the wire — `PasswordKey` is used) |
| `UserCategory` | `Administrator` / `Maintenance` / `PublicUser` |
| `AvailableGroup` | Comma-separated list of group numbers this user is allowed to control |
| `Html` | HTML flag |
| `HtmlKey` | HTML-key encrypted form |
| `AuthID`, `AuthKey` | Persisted session info |

### 6.3 Login flow (reconstructed)

The applet's `LoginSettings` panel:

1. Reads `<UserList>` and a controller-provided random seed via `getRequest UserAuth`.
2. Computes `PasswordKey` = `Crypt.encryption(password, key)` where `key` is derived via `Crypt.createKey()` from the seed and a per-user salt.
3. Sends `setRequest UserAuth` with `<User name="..." PasswordKey="..."/>` (no cleartext password).
4. Controller responds with the user's `AuthID` and `AuthKey`.
5. Subsequent privileged requests carry `<UserAuth AuthID="..." AuthKey="..."/>` inside the `Packet`.

### 6.4 `Crypt` algorithm (`g50/apl/Crypt`)

`Crypt` only exposes:

```
public static String encryption(String plaintext, String key)
public static String decryption(String ciphertext, String key)
public static String createKey(String seed, int rounds)
```

Internals: builds a `StringBuffer`, walks `charAt`, calls `random`, calls `parseInt`. This is a custom string-level cipher — not AES/DES. It exists to keep cleartext passwords off the wire over plain HTTP; it is not strong cryptography.

### 6.5 Important: Crypt scope

Crypt is used for **credential fields only** (`PasswordKey`, `HtmlKey`, derivation of `AuthKey`). The XML payload itself is **not** encrypted — runtime control `setRequest`s containing `Drive="ON"` are sent in cleartext today by [lib/mnet_client.js](../lib/mnet_client.js) and work fine.

## 6a. ScheduleControl — timers / weekly + yearly programs

Reconstructed from `g50/apl/ScheduleControl`, `g50/apl/PatternRecord`, `g50/apl/WPatternRecord`, `g50/apl/YPatternRecord`. Reads against a live controller confirm the element/attribute names below.

### 6a.1 Wire shape

```xml
<DatabaseManager>
  <ScheduleControl>
    <TodayList Group="N"/>                <!-- today's computed events -->
    <WPatternList Group="N" Pattern="P"/> <!-- weekly events for day P (1..7) -->
    <YPatternList Group="N" Pattern="P"/> <!-- yearly slot P -->
    <YearlyList Group="N"/>               <!-- calendar: day → Y-pattern index -->
  </ScheduleControl>
</DatabaseManager>
```

The `Group` attribute lives on each child list, not on `<ScheduleControl>` itself. To target multiple groups in one packet, replace `Group="N"` with `MultiGroup="<bitstring>"` — a per-group enable bitmap (see `ScheduleControl.MULTI_GROUP_ENABLE/DISABLE`).

**`Pattern` is day-of-week, range 1..7** on G-50A/GB-50A firmware (`Pattern=1` is **Sunday**, 2=Monday, …, 7=Saturday). `Pattern>=8` returns `0201 Invalid Value`. Verified against a live controller where the populated `WPatternList` for `Pattern=2..6` matched the contents of `TodayList` on a Tuesday — i.e. weekday patterns hold three events each, while weekend patterns (1, 7) hold one.

`TodayList Group="N"` returns the controller-computed event list for today — the union of the relevant day's `WPatternRecord`s plus any `YearlyList`/`YPatternList` override that applies to today's date. Useful as a sanity check on schedule wiring without having to figure out which day-of-week index the controller uses.

### 6a.2 Pattern records

`WPatternRecord` and `YPatternRecord` share fields from `PatternRecord`:

| Attribute | Meaning |
|---|---|
| `Index` | Event index within the day (1 = first scheduled change of the day, 2 = second, …) |
| `Hour`, `Minute` | Time of day |
| `Drive` | `ON` / `OFF` (only meaningful when `DriveItem` enables it) |
| `Mode` | Runtime Mode enum (only meaningful when `ModeItem` enables it) |
| `SetTemp` | Target temperature in the controller's `TempUnit` (only meaningful when `SetTempItem` enables it) |
| `SetBack` | Energy-saving setback temperature for periods between events |
| `DriveItem`, `ModeItem`, `SetTempItem` | Per-field enable flags. Documented values: `CHK_ON` / `CHK_OFF`. |

**Observed wire encoding quirk**: G-50BA firmware 3.33 returns *empty strings* for both the data fields and the `*Item` flags on events that aren't fully populated by the operator — yet those events still fire. The most likely interpretation is that the empty string is the controller's compact form for "default / not-set", and the legacy `0/1` byte encoding inside the applet maps to `""` on the wire when zero. **For decoding: treat `<Field>=""` as "not present" / OFF, and accept the same XML on write — controllers that want explicit values will accept `CHK_ON` / `CHK_OFF` for `*Item`s.** The `Drive` field stays explicit (`"ON"` for turn-on events) — only the unset values come back blank.

**Confirmed by live round-trip (G-50BA fw 3.33, 2026-05-12)**: writing a `WPatternRecord` with `Drive="ON" DriveItem="CHK_ON"` is accepted, persisted, and read back with the same `CHK_ON`. Writing a record with `Drive="ON" DriveItem=""` works too (that's what TG-2000A historically wrote). Both forms appear to fire equivalently — `CHK_ON` is the preferred explicit form when authoring new records.

### 6a.3 The `Schedule` and `TurnOff` per-unit attributes — not the schedule data

The `<Mnet>` element exposes two per-unit timer-related attributes that are **not** the schedule itself:

- `Schedule="ON"|"OFF"` — whether the controller's schedule subsystem is currently driving this group. `OFF` does **not** mean "no schedule configured" — the WPatternList records can still be fully populated; this just means the controller isn't applying them to the unit right now.
- `TurnOff="ON"|"OFF"` — the unit's own internal auto-off countdown timer (a feature on the indoor unit, separate from controller-level schedules). `ON` means a countdown is running; `OFF` means none.
- `ScheduleAvail="ON"|"OFF"` (EW-50E only) — whether the controller offers a schedule slot for this group at all.

To find out what schedules are actually stored, you must read `<WPatternList>` / `<YPatternList>` / `<YearlyList>` directly — `Schedule="OFF"` units may still have a fully populated weekly program waiting unused.

### 6a.5 EW-50E / AE-200 family extensions

Newer firmware keeps the same envelope but extends the model:

- **Season dimension on weekly patterns.** `<WPatternList>` queries on EW-50E require a `Season="S"` attribute in addition to `Group` and `Pattern` (`getWPatternList` on EW-50E takes three `int` arguments where the older version took one). A companion list element `<WSeasonList>` enumerates the configured seasons.
- **Richer pattern records.** EW-50E's `PatternRecord` adds `AirDirection`, `FanSpeed`, `Humid`, and **five distinct setpoint slots** `SetTemp1..SetTemp5` alongside the original `SetTemp` — likely per-mode setpoint slots so a single event can encode different targets for Cool / Heat / Auto / Dry / etc.
- **Longer Mnet bulk payload.** EW-50E units return considerably more bytes in `<Mnet Bulk="*"/>` responses than G-50A (energy / demand / refrigerant-system fields). The legacy 48-byte decode is a strict prefix; longer bulks decode safely.

A live EW-50E with timers in use returned empty `WPatternList` / `YPatternList` / `TodayList` / `YearlyList` for every group × pattern × season slot probed — suggesting either the timers seen on the LCD are stored under a yet-undocumented element on this firmware, or that controller's schedule simply isn't authored via `ScheduleControl`. **The G-50A / GB-50A side of §6a.1–6a.2 is the well-grounded part; the AE-200-family extension above is partially documented.**

**EW-50E write deltas vs G-50A (verified end-to-end against EW-50E fw 7.70, 2026-05-12)**:

- `<WPatternList>` writes require `Season="N"` in addition to `Group` and `Pattern`. Omitting it returns no error but writes nothing. `Season="1"` works for the basic single-season case.
- `WPatternRecord` writes **must omit `SetBack`** — present in the legacy schema, removed on EW-50E. Including it returns `<ERROR Point="SetBack" Code="0101" Message="Unknown Attribute"/>`.
- `WPatternRecord` writes **must include `AirDirection`** (empty string is fine, `""` is accepted). Omitting it returns `<ERROR Point="AirDirection" Code="0102" Message="Insufficiency Attribute"/>`.
- After a successful write, readback on EW-50E auto-populates `SetTemp1..SetTemp5`, `VentMode`, `Humid` as empty strings even if the writer didn't send them. Decoders should accept these extra attributes without erroring.

A minimal EW-50E-compatible write looks like:

```xml
<WPatternList Group="N" Pattern="P" Season="1">
  <WPatternRecord Index="1" Hour="4" Minute="0"
                  Drive="ON" Mode="" AirDirection="" FanSpeed="" SetTemp=""
                  DriveItem="CHK_ON" ModeItem="CHK_OFF" SetTempItem="CHK_OFF"/>
</WPatternList>
```

### 6a.4 Worked example: weekly "turn on at 08:00 heat to 22, off at 18:00"

```xml
<DatabaseManager>
  <ScheduleControl>
    <WPatternList Group="1" Pattern="1">
      <WPatternRecord Index="1" Hour="8"  Minute="0"
                      Drive="ON"  Mode="HEAT" SetTemp="22.0"
                      DriveItem="ON" ModeItem="ON" SetTempItem="ON"/>
      <WPatternRecord Index="2" Hour="18" Minute="0"
                      Drive="OFF"
                      DriveItem="ON" ModeItem="OFF" SetTempItem="OFF"/>
    </WPatternList>
  </ScheduleControl>
</DatabaseManager>
```

**Verified end-to-end on G-50BA fw 3.33** (2026-05-12): the corresponding `setRequest` is accepted and a follow-up `getRequest` returns the same records. All 7 day-of-week patterns can be batched in a single `setRequest` by emitting multiple `<WPatternList>` children with different `Pattern` values inside one `<ScheduleControl>`. **Replace semantics**: the records inside a `<WPatternList>` write replace the entire day's pattern — there is no partial-update; if you write 1 record for a day, any others previously stored for that day are deleted.

## 6b. Operation Prohibit — IC wall-remote lockout

> **Status (2026-05-19, FULLY UNDERSTOOD)**: see §6b.6 below for the actual mechanism. Prior speculation in this section (about `SystemData.Prohibit` policy, ON-only schedule shapes, mute events, "controller-internal latch") was wrong. The real mechanism is much simpler: **schedules carry per-event prohibit toggles via the `*Item` wire attributes, and the controller continuously pushes the schedule's computed active-prohibit state to ICs**. Our schedule encoder was emitting `CHK_ON` on `DriveItem` for every Drive event, which means "set prohibit on Drive" on every push — hence the locks. Fix: emit empty string for `*Item` when no prohibit interaction is intended.

When the IC's prohibit flag is set, the unit's local wall remote displays "centrally controlled" and refuses user input for the locked attributes. **Cannot be written as an XML attribute on `<Mnet>`** — the controller rejects `Prohibit`, `ProhibitDrive`, `Lock` etc. with `<ERROR Point="..." Code="0101" Message="Unknown Attribute"/>`. Must be sent as a raw M-NET frame via `<MnetRouter>` (§8c.1).

### Wire format (`OperationProhibitionSet`, command class `0D0B`)

```
0D 0B 00 <mode> <bitmap> <duration-hi> <duration-lo>
```

| Byte(s) | Meaning |
|---|---|
| `0D 0B` | command class |
| `00` | reserved / padding |
| `<mode>` | `02` = release, `03` = prohibit |
| `<bitmap>` | 8-bit prohibit selector — `bit 0`=OnOff, `1`=Mode, `2`=SetTemp, `5`=Timer, `6`=FanSpeed, `7`=AirDirection. Bits 3+4 reserved. |
| `<duration>` | 16-bit big-endian seconds. `0000` = permanent. |

**Worked examples** (verified live, 2026-05-15, G-50BA fw 3.33):

```
Release every flag, permanent:    0D0B0002000000   →   reply 0D8B00
Prohibit every flag, permanent:   0D0B0003E70000   →   reply 0D8B00
Prohibit OnOff only, 60s timeout: 0D0B000301003C   →   reply 0D8B00
```

Reply pattern `0D 8B <status>` — `8B` is `0x0B | 0x80` (response marker), `<status>=00` means OK.

### Reading current state (`OperationProhibitionMonitor`, command `2D0B`)

Send `2D0B` (no payload) via `MnetRouter` to an IC. Reply is `2D8B…`. The prohibit bitmap is at **OP[3]** — i.e. byte index 5 of the response frame (after the 2-byte command header `2D 8B` and 3 bytes of `OP[0..2]`). `0x00` = no prohibits set; non-zero = same bitmap layout as the set command.

This is the **authoritative read** for the IC's actual state, not the bulk byte. Use it for diagnostics.

### G-50A's cache vs IC reality

The G-50A maintains a per-group prohibit shadow in its `<Mnet Bulk>` payload (byte index 10 in the legacy 48-byte layout). **The shadow does not update when `OperationProhibitionSet` is sent through `MnetRouter`** because the frame bypasses the controller's cache write-path. The IC's actual lock state is what the wall remote honors, so a manual `0D0B0002000000` is effective even if the bulk poll continues to show `01`. **Treat bulk byte 10 as a lying cache** — always cross-check with `2D0B`.

### Controller-wide policy: `SystemData.Prohibit`

Two values observed in production:

- `SC_ALL` — labelled "SC/RC" in the G-50A web UI under "Range of Prohibited Controllers"
- `RC_ONLY` — labelled "RC only" in the same UI

Both writable via:

```xml
<DatabaseManager><SystemData Prohibit="RC_ONLY" /></DatabaseManager>
```

> **What this setting does NOT do (correction, 2026-05-18)**: previous wording here claimed `RC_ONLY` prevents the controller from re-pushing prohibit when a schedule fires. **Empirically untrue**. After flipping a controller from `SC_ALL` to `RC_ONLY` and clearing all per-IC locks, the locks reappeared anyway within hours. Meanwhile a third controller with the same `RC_ONLY` setting never showed locks. So the setting alone does not explain the difference — see §6b.5.

### 6b.5 Stale notes — earlier hypotheses (kept for context)

The mute-event / paired-ON-OFF heuristic discussed in earlier revisions of this section was wrong. Both were artefacts of an unrelated mechanism (§6b.6 below). The previous text is dropped — see git history.

### 6b.6 Actual mechanism (2026-05-19, confirmed)

The schedule subsystem and the IC-prohibit lockout are **the same system**:

1. **Schedules are stored on the controller** as `WPatternList` records.
2. Each `WPatternRecord` carries three "prohibit toggle" attributes — `DriveItem`, `ModeItem`, `SetTempItem` — each of which takes one of three values:
   - `"CHK_ON"`  → "**set** prohibit on this attribute when the event is the current active schedule entry"
   - `"CHK_OFF"` → "**release** prohibit on this attribute"
   - `""` *(empty)*  → "do not touch the prohibit state for this attribute"
3. The controller maintains a computed **active-prohibit state per group**, derived from "which schedule events have fired up to now today". This is independent of whether an event is *firing right now*.
4. **Every few minutes the controller pushes that computed state to the IC.** This is the periodic `OperationProhibitionSet` (`0D0B…`) frame we observe on the wire.
5. Therefore, **`g50a clear-prohibit` (which targets the IC directly) is overridden on the next push** unless the schedule's computed active-prohibit state is also "no prohibit".

Implications for the encoder in this library:

- **Default to empty string** for all `*Item` attributes when authoring schedules. This matches the well-behaved `:82 g3` reference (`"Drive":"ON","DriveItem":""`) which never locks ICs.
- Use `"CHK_ON"` / `"CHK_OFF"` **only when explicitly modeling a per-event prohibit toggle** — for example, an AE-2000-style "unlock at 17:00" event that releases the wall remote at end-of-day.
- In our TypeScript shape, this is the `driveProhibit` / `modeProhibit` / `setTempProhibit` field on `ScheduleEvent`, taking values `'set'` | `'release'` | `undefined`. The `*Enabled` boolean fields used before 2026-05-19 mapped these to the wrong semantics and were removed.

The earlier confusion arose because we read the `CHK_ON`/`CHK_OFF` names literally as "checkbox state for whether this event fires", instead of as "checkbox state for whether this event toggles prohibit". The XML attribute names look like booleans for a different question. The mtool's UI for the toggles is labelled "Prohibit Remote Controller Operation: [ON/OFF, Mode, Set Temp]" — a separate section from the time + drive value fields — confirming the toggle's purpose.

Practical remediation if locks reappear after a manual fix:

```bash
# 1. read what's actually stored (look for non-empty *Item values that you didn't intend)
g50a dump --host <controller>
# 2. re-author with corrected encoding (empty *Item by default)
g50a apply --host <controller> --in <corrected.json>
# 3. clear IC-level state once; controller's next push will keep it cleared
g50a clear-prohibit --host <controller>
```

### Legacy command variant (`OperationProhibition`, class `0D24`)

Older AE/G-50 generations used a different encoding:

```
0D 24 <onOff:2> <mode:2> <setTemp:2> <timer:2> <fanSpeed:2> <airDir:2> 00000000
```

Each 2-char hex slot: `00`=no change, `10`=release, `11`=prohibit. Total payload truncated to 20 chars before the trailing 8 zeros. **G-50BA fw 3.33 rejects this with reply `0DA4FF`** — the `0D0B` form is what's live on current hardware.

## 7. SystemData (controller-wide configuration)

`g50/apl/SystemData` — top-level controller settings. Read/written via:

```xml
<DatabaseManager>
  <SystemData/>
</DatabaseManager>
```

Selected attributes (full list in the class):

| Attribute | Purpose |
|---|---|
| `Model` | One of `G-50`, `G-50A`, `G-50B`, `G-50BA` |
| `Version` | Firmware version |
| `MacAddress` | Controller's MAC |
| `LocationID` | Site identifier |
| `IPAdrsLan`, `SubnetMaskLan`, `GwLan`, `DNSPri`, `DNSSec` | LAN config |
| `MnetAdrs`, `KaAdrs` | Controller's own M-NET address |
| `MCpAdrs` | MC-p address |
| `TempUnit` | `C` or `F` |
| `DateFormat` | `YYYYMMDD` / `MMDDYYYY` / `DDMMYYYY` |
| `DecimalPoint` | `DOT` or `COMMA` |
| `CsvSeparator` | `COMMA` or `SEMICOLON` |
| `External` | External-signal mode: `WITHOUT` / `EMERGENCY` / `ONOFF` / `ALL` |
| `Prohibit` | Lockout mode: `RC_ONLY` / `SC_ALL` |
| `FilterSign` | Filter-cleanup indicator: `ON` / `OFF` |
| `ShortName` | Short-name display: `ON` / `OFF` |
| `MailTitle`, `PopServer`, `PopUser`, `PopPass`, `PopInterval`, `SmtpServer`, `SmtpAuth` | Mail notification |
| `DemandUnit` | Demand-control hardware: `G50` / `MC_P` / `PLC_D` / `PLC_P` / `OTHERS` / `NOP` |
| `IPDemand`, `IPDemandG50`, `IPIoNotify`, `IPPowerCount`, `PortDemand`, `PortIoNotify`, `PortPowerCount` | External-control endpoints |
| `WhmNo`, `TrendInterval` | Trend / metering |

## 8. Reading additional subsystems

The applet classes one-to-one correspond to top-level XML elements. To work out the schema for a subsystem not yet documented here:

1. `jar xf g50.jar g50/apl/<Name>.class`
2. `strings g50/apl/<Name>.class | grep -v '^\(java\|com\|<\)'` — surfaces XML element/attribute names and enum values
3. `javap -p -c -constants g50/apl/<Name>.class` — shows the construction logic (calls to `XmlTxDoc.addAttribute`, `setTagText`, `addChildren`)
4. Cross-check against `g50/core/G50XmlTb` for top-level element names

`*_I`-suffixed string constants are the internal field name (used as a key into Java tables); the non-suffixed neighbour is the XML name used on the wire. The applet's table-driven design means almost every attribute name is a string constant, easy to recover.

## 8a. Refrigerant-system topology — `<Mnet><RefSystemList/></Mnet>`

The controller can report **which indoor units share an outdoor unit** — useful for spotting mixed-mode HEAT/COOL deadlocks on single-mode VRF systems before they happen.

```xml
<Packet><Command>getRequest</Command>
  <DatabaseManager>
    <Mnet><RefSystemList/></Mnet>
  </DatabaseManager>
</Packet>
```

Response: a flat list of `<RefSystemRecord>` elements, one per device, with three attributes:

| Attribute | Meaning |
|---|---|
| `Address` | This device's M-NET address |
| `OcAddress` | The address of the outdoor unit this device belongs to. For an OC itself, `Address === OcAddress`. |
| `Model` | `IC` / `OC` / `OCi` / `BC` / `BS` / etc. — see `MnetGroupValTb` MODEL_* enum |

To check whether a refrigerant loop supports **mixed-mode** operation (different indoor units running HEAT and COOL simultaneously), look for a **Branch Controller (`Model="BC"`)** and/or a **Branch Selector (`Model="BS"`)** on the same `OcAddress`:

- **BC present** → typically a Mitsubishi R2-series heat-recovery system (PURY / PWFY / WR2). Mixed-mode supported.
- **BS present** → older / specific HR architectures. Mixed-mode supported.
- **Neither** → heat-pump-style single-mode outdoor (Y-series, WY). HEAT + COOL across indoor units leaves the minority direction unsatisfied; the controller accepts the conflicting `setRequest` without complaint.

Worked example output (G-50BA fw 3.33, 30-unit office install):

```
OC  51   IC: 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 14   BC: 52         → mixed-mode (HR)
OC  66   IC: 16..29, 31, 33-35, 37                    BC: 67  BS: 82 → mixed-mode (HR)
OC  95   IC: 45, 46, 47, 48                           (no BC/BS)     → single-mode
OC  97   IC: 49                                       (no BC/BS)     → single-mode
```

The `g50a-client` `getTopology()` helper builds this structure from the flat list and surfaces `supportsMixedMode` per outdoor system.

## 8b. Controller real-time clock — `<Clock>`

The controller has its own RTC that drives schedules. It's stored as local time with **no timezone field** — operators must match the install's locale themselves. The controller has no NTP — drift is normal over months.

Read:
```xml
<Packet><Command>getRequest</Command>
  <DatabaseManager>
    <Clock Year="*" Month="*" Day="*" Hour="*" Minute="*" Second="*"/>
  </DatabaseManager>
</Packet>
```

Returns:
```xml
<Clock Year="2026" Month="5" Day="13" Hour="6" Minute="20" Second="47"/>
```

Write:
```xml
<Packet><Command>setRequest</Command>
  <DatabaseManager>
    <Clock Year="2026" Month="5" Day="13" Hour="6" Minute="30" Second="0"/>
  </DatabaseManager>
</Packet>
```

`DayOfWeek` is **not accepted** on G-50BA fw 3.33 (returns `<ERROR Point="DayOfWeek" Code="0101"/>`). Other Clock fields are mandatory on write.

The controller is the **time master for the entire M-NET system** — it propagates the time to outdoor and indoor units via M-NET broadcasts. Setting `<Clock>` once on the controller is enough; individual units pick it up downstream.

**Operational use**: schedule a periodic clock sync from a NTP-clocked host. The legacy TG-2000A Windows tool did this on a timer; the same can be a one-liner cron on any modern box. The `g50a-client` CLI has a `time-sync` subcommand that writes the host's local time to the controller — wrap in cron to keep drift bounded.

## 8c. The deeper telemetry — `MnetRouter` (no port 30000 needed)

> **2026-05-13 update**: prior wisdom was that the deep telemetry lived on port 30000 behind a Mitsubishi-licensed token. **That was wrong**. Wireshark capture of the patched MainteToolNet 2017 talking to a G-50BA fw 3.33 shows the entire "Operation Status Monitor" panel using `/servlet/MIMEReceiveServlet` on port 80 — same servlet as the public XML API, no port-30000 traffic at all, no authentication. See `.local/mtool-2017-session-1.pcapng`.
>
> The mechanism is two new XML constructs the public docs don't describe: **`MnetRouter`** (synchronous raw-M-NET pass-through) and **`MnetMonitor`** (async polling with SMTP push-back).

### 8c.1 `MnetRouter` — synchronous raw-M-NET pass-through

The controller will forward arbitrary M-NET frames to any M-NET address on its bus and return the unit's reply verbatim. This is the TG-2000A-class capability the high-level XML hides.

**Request shape:**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Packet>
  <Command>setRequest</Command>
  <DatabaseManager>
    <MnetRouter>
      <MnetCommandList DA="66" CommandInterval="400">
        <MnetCommandRecord Data="397EF0" RcvData="*" />
        <MnetCommandRecord Data="397EF1" RcvData="*" />
        <MnetCommandRecord Data="3112"   RcvData="*" />
      </MnetCommandList>
    </MnetRouter>
  </DatabaseManager>
</Packet>
```

**Response shape:**

```xml
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
</Packet>
```

Attributes:

| Attr | Meaning |
|---|---|
| `DA` | **Destination M-NET address** of the target unit (decimal). OC, BC, IC addresses you'd see in `RefSystemList`. Example: `66`=OC@066, `67`=BC main@067, `82`=BC sub@082, `16-25`=ICs@016-025. |
| `CommandInterval` | Milliseconds to wait between successive `MnetCommandRecord` entries when batched. The M-NET bus is slow; `400` ms is what the mtool defaults to. |
| `MnetCommandRecord Data` | Raw M-NET request bytes (hex string, no spaces). |
| `MnetCommandRecord RcvData` | `"*"` in the request = "return here". In the response, contains the unit's raw reply bytes. |

The reply byte pattern: **response = request with the second byte's high bit set** (`0x80` OR'd). Example: request `397EF0` → response starts `39FEF0…` (`7E` → `FE`); request `2100` → response starts `2180…` (`00` → `80`); request `3112` → `3192…` (`12` → `92`). Then unit-specific payload bytes follow.

### 8c.2 `MnetMonitor` — async polling with SMTP push-back

For continuous trend display the mtool sets up an `MnetMonitor` job. The controller polls the requested registers itself on a timer and ships the results back **as plain-text email to an SMTP server the tool runs locally on port 25**.

```xml
<MnetMonitor RequestID="0929-58_20260513_104418" Command="SET"
             LocalAddress="g50@g50.com" SmtpServer="192.168.1.100"
             Subject="@mt 0929-58_20260513_104418"
             SendAddress1="mnttool@mnttool.com"
             CommandInterval="300" LifeSpan="10800"
             NotifyInterval="30"  SendInterval="60" />
<MnetMonitor>
  <SendCommandList RequestID="0929-58_20260513_104418">
    <SendCommandRecord DA="66" Data="397E00" />
    <SendCommandRecord DA="66" Data="397E01" />
    …
  </SendCommandList>
</MnetMonitor>
```

| Attr | Meaning |
|---|---|
| `RequestID` | Client-chosen, must be unique. Tool format: `<controllerSerial>_<YYYYMMDD>_<HHMMSS>`. |
| `Command` | `SET` (create), `REFRESH` (extend lifespan), `DEL` (cancel). |
| `LocalAddress` | "From" email address the controller uses when sending. Cosmetic. |
| `SmtpServer` | IP of an SMTP server reachable from the controller. The mtool runs its own SMTP listener on port 25 of the laptop. |
| `SendAddress1..5` | Up to 5 recipients. |
| `CommandInterval` | ms between successive M-NET commands within one polling cycle. |
| `LifeSpan` | seconds the job persists on the controller. After this the controller drops it silently. |
| `NotifyInterval` | seconds between full polling cycles. |
| `SendInterval` | seconds between batched email send-outs. |

SMTP body format (verbatim from a capture):

```text
From: <g50@g50.com>
To: <mnttool@mnttool.com>
Subject:@mt 0929-58_20260513_104418
Content-Type: text/plain; charset=ASCII

[MnetMonitor]
RequestID="0929-58_20260513_104418"
StartDate="20260513"
StartTime="104454"
[Data]
104456,,#Monitor Start
104456,66,21808583428443A652801080118012
104456,66,218085834280138014801580168017
104457,66,21800183428025
[END]
```

Lines under `[Data]` are `HHMMSS,DA,raw_response_bytes`. The controller batches multiple replies per line when convenient (the example above has multiple `2180…` segments concatenated).

**For `g50a-client` we don't need `MnetMonitor`** — `MnetRouter` gives us the same data synchronously. We poll at our own cadence and skip the SMTP-server-on-laptop dance entirely. `MnetMonitor` is documented here for completeness.

### 8c.3 M-NET command bytes (observed)

These are the raw M-NET frame types seen in the capture. The first byte is the command class, the second is the sub-command (high bit set on response). Detailed decoding TBD.

| Cmd | Direction | Likely purpose (inferred from mtool screenshot context) |
|---|---|---|
| `2100` | Req | Generic state read (returns ~10 bytes: drive/mode/fan/etc.) |
| `2103` | Req | Address / model identifier (`21830110` etc.) |
| `2104` | Req | Version / capability descriptor |
| `2108` | Req | Capability flags |
| `210A` | Req | ? (single-byte payload `218A01..04`) |
| `2118` | Req | Sub-info (8-byte payload) |
| `3112` | Req | ? (`319201` for ICs, `3192FF` for OC) |
| `3511` | Req | Status flags (`3591NNNNNN`) |
| `397E00..92` | Req | **Memory bank read** — 16 bytes per bank. This is where pressures (PS1/PS3), temperatures (TH1-TH7), valve positions (LEV/SVx), compressor frequency (F), demand state, etc. live. The mtool subscribes a different set of banks per unit type (OC vs BC vs IC). |
| `397EF0` | Req | Per-IC capability + temp-limit block (16 bytes). |
| `397EF1` | Req | Per-IC extended capability (16 bytes). |
| `197F00..10` | Req | Memory write (e.g., `197F10ACFFFFFF` sets something on the OC). |

**Banks the OC was monitored on** (per `MnetMonitor.SendCommandList`): `397E00, 397E01, 397E02, 397E04, 397E30, 397E50, 397E80, 397E90, 397E91`.
**Banks the BC main was monitored on**: `397E00, 397E01, 397E02, 397E80, 397E91, 397E92`.
**Banks the BC sub was monitored on**: `397E00, 397E01, 397E02, 397E91, 397E92`.
**Banks per IC**: `397E00, 397E80, 397E81, 397E82, 397E90`.

The screenshot ([.local/mtool-2017-screenshot.png] not committed) shows what the bytes decode to: `Tc/Te` saturation temps, `THHS/2ISA4a/SV1a/SV1b/SV1c/SV1d/SV9` valve states, `F/Foc/FAN/QiC/Vdc/Iu/Iw` compressor variables, `63HS1/63LS1/TH3-TH18/FAN-Ver/Save/Ope_Status/Attribute/Start-up_unit` — together this **is** the full Operation Status Monitor data. Decoding each bank is the v0.2 work item.

### 8c.4 The previously-suspected port 30000 path

Earlier this doc speculated about a separate authenticated port-30000 service for these queries. Reviewing `MainteToolNetLibrary.dll` more carefully and watching live traffic: **the `MainteHttpClient` class is only used when the operator picks "MN-Converter" at startup** (a dedicated IP-to-M-NET bridge appliance). When the operator picks "G-50", everything routes through `/servlet/MIMEReceiveServlet:80` via `MnetRouter` and `MnetMonitor`. Port 30000 may still serve a role for the MN-Converter path but is not needed for G-50 deep telemetry.

## 8d. What the protocol still does NOT expose

Install-specific facts that need to live in operator runbooks, not protocol queries:

- **Indoor-unit physical interlocks** — fire-alarm relays, occupancy sensors, BMS overrides. The controller may report `Schedule="ON"` and accept `Drive="ON"`, but the indoor unit's contactor stays open if an upstream interlock has tripped. Operators must reset these manually at the unit.
- **External BACnet / Modbus / KNX gateway state** — if a separate gateway is fronting the controller, its translation rules and any state it caches are invisible here.
- **Outdoor-unit model identification** — `RefSystemRecord` carries `Model="OC"` or `OCi` but not the actual model number (PURY-P300 vs PURY-P400 etc.). Confirmation that an OC supports mixed-mode comes from BC/BS presence (§8a heuristic), not a definitive query.

## 9. References to local code

- [lib/mnet_client.js](../lib/mnet_client.js) — verified-working implementation of §2–§4
- [lib/mnet_parser.js](../lib/mnet_parser.js) — partial Bulk decoder (subset of `MnetGroupBulk`)
- [mnet_config.json](../mnet_config.json) — mapping from HomeKit characteristics to per-group sub-addresses

---

## 8d. Memory banks DECODED — IC block (2026-09-03)

**This supersedes the "decoding each bank is the v0.2 work item" note in §8c** for the IC banks.
Decoded by capturing `MnetMonitor` SMTP push-back on the wire while reading the same values off
MainteToolNet's *Operation Status Monitor*, giving a labelled pair for every unit — so these are
observed, not inferred. Verified against 19 ICs on one OC.

### Encoding: signed 4-digit BCD, tenths

Temperature and superheat fields are **16-bit BCD**, value in tenths, with the **top nibble used as
a sign flag** (`8..F` = negative):

| Raw | Decodes to |
|---|---|
| `0255` | +25.5 |
| `0016` | +1.6 |
| `8178` | **−17.8** |
| `7FFF` | **sentinel — sensor not present** (renders blank in the GUI) |

```python
def bcd_temp(f):                      # f = 4 hex chars
    if f == '7FFF': return None
    neg = f[0] in '89ABCDEF'
    return (-1 if neg else 1) * int(('0' + f[1:]) if neg else f) / 10.0
```

### Bank `00` — IC pipe temperatures

Response `39FE00` + 13 payload bytes: one lead byte, then six 16-bit fields.

| Offset (payload) | Field | Meaning |
|---|---|---|
| 0 | lead | `00` |
| 1–2 | **TH1** | intake / return-air temp |
| 3–4 | **TH2** | liquid-pipe temp |
| 5–6 | **TH3** | gas-pipe temp |
| 7–8 | **TH4** | `7FFF` when the unit has no TH4 |
| 9–10 | *unidentified* | equals TH1 on most units, but **not** on units with negative superheat — do not rely on it |
| 11–12 | — | `0000` |

TH1/TH2/TH3 matched the GUI **exactly on every unit tested**.

### Bank `81` — capacity save + superheat

Response `39FE81` + 13 payload bytes:

| Offset | Field | Meaning |
|---|---|---|
| 0 | lead | `00` |
| 1 | Save | `0x64` = 100 % (plain hex, **not** BCD) |
| 2 | Save2 | `0x64` = 100 % |
| 3–4 | **SH/SC** | superheat, signed BCD (see above) |
| 5–12 | *unidentified* | |

Decode matched the GUI on **13 of 15** units. The two misses are explained, not unexplained: one
unit's superheat genuinely varies minute-to-minute (the capture and the screenshot were a minute
apart), and the other was the single unit in **Heating** mode, where this field is presumably SC
rather than SH. Treat heat-mode units as undecoded.

### Bank `90` — LEV opening

Response `39FE90` + 6 payload bytes. **This is where `Li` (LEV pulses) lives.**

| Offset | Field | Meaning |
|---|---|---|
| 0 | lead | `00` |
| 1 | flags | varies `04`–`07`; not yet identified |
| 2–3 | **LEV opening** | **pulses, 4-digit BCD — a plain integer, NOT tenths** |
| 4–5 | state trailer | `9001` = cooling active, `9000` = cooling idle, `8000` = off / heating-idle |

Decoded **15/15 exact** against the GUI across one OC's indoor units, and confirmed live: a unit
switched off went from `000601769001` (LEV 176, cooling) to `000600418000` (LEV 41, off) —
i.e. the trailer tracks drive state and 41 is the shut-valve floor.

Note the units differ from the temperature banks: bank `00`/`81` are BCD **tenths**, bank `90`'s LEV
is BCD **whole pulses**. Don't apply a `/10` here.

### Bank `80` — setpoint in the tail

Response `39FE80` + 13 payload bytes. The last two bytes are the **setpoint (`TO`)**, signed BCD
tenths, same encoding as the temperature banks — `0190` = 19.0 °C, `0210` = 21.0 °C.
Decoded **15/15 exact**. The preceding bytes (`002E0101FE0100080A0000…`) are near-identical across
units and not yet identified.

### On-demand fetch

All of the above are reachable synchronously via `MnetRouter`, so no `MnetMonitor`/SMTP job is
needed to read one unit:

```sh
g50a mnet-bank --host <h> [--port P] --da <IC address> --bank 0x90   # LEV
g50a mnet-bank --host <h> [--port P] --da <IC address> --bank 0x00   # TH1/TH2/TH3
g50a mnet-bank --host <h> [--port P] --da <IC address> --bank 0x81   # superheat
```

This matters because the SMTP trend path only works from the controller's own subnet (see above),
whereas these reads work from anywhere that can reach the servlet.

### The `Schedule` attribute is READ-ONLY

`<Mnet Group='N' Schedule='OFF'/>` in a `setRequest` is **rejected** — the controller echoes the
element and returns `<ERROR Point="Schedule" Code="0101" Message="Unknown Attribute"/>`, and the
flag keeps its previous value. §6a.3 documents `Schedule` as a per-unit attribute; it is readable
but not writable this way.

To disarm a group's timer, **write an empty weekly schedule** (`g50a clear-schedule --group N`).
The arming flag then auto-disarms to `OFF` on its own, as §6a.3 notes — confirmed again on a
G-50BA 3.33: two groups went `Schedule="ON"` → `"OFF"` with `today` reporting no events, and the
`Drive=OFF` state then survived. Take a `dump` backup first; `apply` restores it.

### Derived relationships worth knowing

- **`SH = TH3 − TH2`** — exact on every Cool-ON row, every sample. Useful as a self-check that the
  BCD decode is right.
- **`Li` is the LEV opening in pulses.** It reads exactly **`41`** whenever `IC S = Cool OFF` (valve
  shut) and 150–318 when cooling, scaling with the unit's `QJ` capacity code.
- A **healthy cooling unit** shows TH2 ≈ 2–5 °C (near `Te`). A **satisfied** one lets TH2 drift up
  toward TH1 with `Li = 41`.
- A unit whose TH2 sits ~15 K above its siblings while TH3 stays cold yields an impossible negative
  superheat, and indicates a **refrigerant-side fault local to that unit** (suspect the TH2
  thermistor first). Low airflow gives the opposite signature: cold TH2 and low superheat.

### Other observations from the same capture

- **`MnetMonitor` SMTP push-back is confirmed on the wire** — the controller opens TCP to
  `SmtpServer:25` from ephemeral ports and delivers `[MnetMonitor] … [Data] … [END]` bodies in
  cleartext, one connection per send interval. §8c.2's description is accurate.
- **Controllers ship with no default gateway** in at least one real deployment (`GwLan=""` in
  `SystemData`), which means `MnetMonitor` can only ever deliver to an SMTP listener on the
  controller's **own subnet**. Snapshot reads over `MnetRouter` are unaffected, since those are
  replies. Plan trend capture accordingly.
- **`SystemData` needs explicit attribute wildcards.** A bare `<SystemData/>` `getRequest` returns
  an empty `<SystemData/>` echo, not the configuration. Ask for `Model='*' GwLan='*'` etc.
- **`FilterSign` is a runtime-hours service counter, not a blockage measurement.** On a site where
  it had never been reset it read `ON` for *all* 36 units on a controller. It carries no per-unit
  diagnostic signal — don't treat it as evidence a particular filter is dirty.
- **Attribute support varies per controller and is not predictable from model/firmware.** A G-50BA
  3.33 accepted `FilterSign`/`ErrorSign`; another G-50BA on the *same* firmware rejected them with
  `Unknown Attribute`, and — importantly — **the error fails the entire request**, not just the
  offending attribute. Probe per controller and fall back to the minimal attribute set.

---

## 8e. BC branch valves `a` / `b` / `c` — meaning

The three rows in mtool's BC panel are the **branch solenoid valves**, one set per branch:

| Row | Valve | Open when |
|---|---|---|
| **a** | **SVA** — liquid-side feed | that branch's indoor unit is being fed liquid refrigerant to **cool** |
| **b** | **SVB** — hot-gas feed | the branch is **heating** |
| **c** | **SVC** — suction / return to the low-pressure line | the branch is connected to suction (stays open for cooling-capable branches even when the IC is thermo-off) |

Established on a `C.Only` loop of 19 ICs:

- **`b` was `0` on every branch in every sample** — nothing was heating, exactly as SVB predicts.
- **`a` tracked each IC's cooling demand exactly — 15/15** against the IC table's `IC S`: `a=1` iff
  `Cool ON`, `a=0` when `Cool OFF` / `Stand by`.
- **`c` was `1` on every cooling-capable branch** regardless of demand, and `0` on exactly two: the
  single branch whose IC was in **Heating**, and an **unused** branch.

So `a=1, b=0, c=1` reads as "branch lined up for cooling and actively feeding"; `a=0, b=0, c=1` as
"lined up for cooling, thermo-off"; `c=0` as "not on suction" (heating, or nothing connected).

⚠️ **The bitmap is NOT in the `397Exx` memory banks.** Every bank the mtool subscribed to for the
BC was searched for the 16-bit `a`/`c` patterns and they are absent — the BC banks decode to
temperatures, pressures and LEV positions instead (below). mtool must read the valve states with a
different command class. The likely carriers, seen in the same capture against DA 66/67/82, are the
`2180…`, `19FF…` and `3192…` responses; those are the next thing to target.

## 8f. Decoded field map — verified against 7–8 GUI samples

All temperatures/pressures are **signed BCD tenths** (§8d). Offsets are **payload byte indexes**,
i.e. after the `39FE<bank>` header.

### OC (PURY-(W)P400, tested on fw 3.10/5.02)

| Field | Bank | Byte | Width | Encoding |
|---|---|---|---|---|
| `63HS1` high pressure | `00` | 1 | 2 | BCD/10 |
| `TH4` | `00` | 3 | 2 | BCD/10 |
| `TH7` | `00` | 5 | 2 | BCD/10 |
| `63LS` low pressure | `00` | 8 | 1 | BCD/10 |
| `TH5` | `00` | 9 | 2 | BCD/10 |
| `TH3` | `01` | 1 | 2 | BCD/10 |
| `TH6` | `01` | 3 | 2 | BCD/10 |
| `THHS` | `02` | 1 | 2 | BCD/10 |
| `Tc` condensing | `02` | 3 | 2 | BCD/10 |
| `Te` evaporating | `02` | 5 | 2 | BCD/10 |
| `Vdc` | `02` | 7 | 2 | BCD/10 |
| `Iu` | `50` | 1 | 2 | BCD/10 |
| `Iw` | `50` | 3 | 2 | BCD/10 |
| `QjC` | `80` | 6 | 1 | plain u8 |
| `F` (compressor Hz) | `90` | 2 | 1 | plain u8 |
| `FAN` | `90` | 7 | 1 | plain u8 |

Each matched **7/7 samples** with varying values, so these are not chance fits.

⚠️ **`F` vs `Foc` cannot be separated from this capture** — they were equal in all 7 samples.
Bank `90` bytes 4, 5 and 6 also vary over the same value set as `F` (`0x29–0x37` = 41–55), so
`Foc` is among them. Resolve with a capture taken during a compressor ramp, when the two differ.

### BC (main 067 / sub 082)

| Field | Bank | Byte | Width | Encoding |
|---|---|---|---|---|
| `PS1` | `00` | 1 | 2 | BCD/10 |
| `PS3` | `00` | 5 | 2 | BCD/10 |
| `T1` | `00` | 7 | 2 | BCD/10 |
| `T2` | `00` | 9 | 2 | BCD/10 |
| `T5` | `01` | 3 | 2 | BCD/10 |
| `T6` | `01` | 5 | 2 | BCD/10 |
| `PT1` | `01` | 7 | 2 | BCD/10 |
| `PT3` | `01` | 11 | 2 | BCD/10 |
| `dPHM` | `02` | 1 | 2 | BCD/10 |
| `SC1` | `02` | 3 | 2 | BCD/10 |
| `SC6` | `02` | 5 | 2 | BCD/10 |
| `SH2` | `02` | 7 | 2 | BCD/10 |
| `L1`, `L2`, `L3` | `92` | 1, 3, 5 | 2 each | BCD (whole) |

A recurring `B276` / `3276` in the BC banks appears to be a **not-present sentinel**, distinct from
the ICs' `7FFF`.

### Still undecoded, and what it needs

Everything below was **constant for the whole capture**, so there is no signal to correlate against
— these are not hard, just un-observed:

- OC booleans/enums: `Ctrl Mode`, `Ope Mode`, `21S4a`, `SV1a`, `SV2`, `SV4a–d`, `SV5b`, `SV5c`,
  `SV9`, `DEMAND`, `DEMAND2`, `NIGHT`, `NIGHT2`, `SNOW`, `CH21`, `ALh`, `Ope Status`, `Attribute`,
  `Start-up unit`, `FAN-Ver`, `Rotation Timer`, `QjH`, `TH15`–`TH18` (blank on this model).
- BC: `BC Sig`, `OC Sig`, `SVM`, `SVM2`.
- IC: `QJ` (capacity code), `B_No`, and the `Mode` / `State` / `IC S` enums — though bank `90`'s
  trailer (`9001` / `9000` / `8000`) clearly tracks drive state and is the obvious candidate.

**To finish the client, capture with the same bank subscription while the plant does something
different:** heating operation (makes the `b` row and `BC Sig` non-trivial), a defrost cycle, an
active DEMAND or NIGHT signal, an alarm, and a compressor ramp where `F ≠ Foc`. Plus target the
non-`397E` opcodes for the valve bitmap.

---

## 8g. IC identity opcodes — branch number IS readable (2026-09-03)

**This corrects §8c / the `project-4th-floor-relocation` note that "no XML query exists" for the BC
branch-port per indoor unit and that only MainteToolNet's raw pass-through reads it.** It is read
with a single raw M-NET frame through `MnetRouter`, so any client can do it.

Found by parsing the **HTTP** side of a MainteToolNet session (`/servlet/MIMEReceiveServlet`, the
synchronous `MnetRouter` calls) rather than the `MnetMonitor` SMTP trend — mtool issues these during
its *Connect Infor* scan. Worth remembering: the trend stream and the interactive queries are two
different channels, and the interesting one-shot identity data is only in the latter.

| Request | Response | Meaning | Verified |
|---|---|---|---|
| `210A` | `218A <bb>` | **BC branch port**, 1 byte. `0x01`–`0x0E` = branch 1–14, `0x00` = the 16th branch (shown as `0` in mtool) | **19/19 ICs** |
| `2108` | `2188 02 <cc>` | **Capacity code** (mtool's `QJ`) | **19/19 ICs** |
| `2103` | `2183 01 <aa>` | The unit's own M-NET address | 19/19 |
| `2100` | `2180 03 80<ic> 83<oc> 84<bc> 1100` | Unit relations: own address (type `0x80`=IC), its OC (`0x83`), its BC (`0x84`) | 19/19 |
| `2104` | `2184 …` | Model / capability block | not decoded |
| `2118`, `3112`, `3511` | — | near-constant across units; not decoded | — |

Example — read one unit's branch and capacity:

```sh
g50a mnet-raw --host <h> [--port P] --da 24 210A 2108
#   210A -> 218A09      branch 9
#   2108 -> 21880204    capacity code 4
```

### Splitting main BC from sub BS

`210A` gives the branch *number*, not which BC controller — on a main-BC-plus-sub-BS system the
numbering restarts, so several ICs legitimately report the same value. `2100` is no help either: it
reports the **main** BC address even for units hanging off the sub BS.

**The rule: the lower IC addresses belong to the main BC, the higher ones to the sub BS.** The two
sets do not interleave, so there is a single address boundary between them.

What the rule does *not* fix is the boundary's position — you don't know a priori how many ICs sit
on the main BC. Find it by grouping on the first branch-number collision, since a repeated branch
number can only mean a second controller:

```python
groups, seen = [[]], set()
for ic, br in sorted(branch_by_ic.items()):   # ascending IC address
    if br in seen:                            # a repeat can only mean a new controller
        groups.append([]); seen = set()
    groups[-1].append((ic, br)); seen.add(br)
# groups[0] -> main BC, groups[1] -> sub BS, in address order
```

Two cheap cross-checks on the result:

1. group sizes fit their controllers (main BC 16 branches, sub BS 8),
2. the sub group's branch numbers equal the occupied branches in the **BC(sub) valve bitmap**.

Verified on a 19-IC system: ICs 16–31 → main BC 067 (branches 1–14 and 0), ICs 33–37 → sub BS 082
(branches 2, 3, 4, 8) — consistent with the rule, and the sub group matches the bitmap exactly.

A loop with **no repeated branch number has a single BC**, which is the same check in the negative.
Confirmed on a 12-IC loop: 12 distinct branches, and `RefSystemList` reports `BC 52, BS —`.

### Branch numbering within a controller is unordered

A separate point, not a qualification of the BC/BS rule above: **branch position within one
controller bears no relation to IC address** and must be read per unit with `210A`. Two loops on the
same G-50 order it differently:

| Loop | Ordering |
|---|---|
| OC 66 | **ascending** — IC 16→br 1, 17→2, … 29→14 |
| OC 51 | **descending, then not** — IC 1→br 9, 2→8, 3→7, 4→6, 6→4, 7→3, 8→2, 9→1, then 10→11, 11→10, 12→12, 14→13 |

So a client that guesses branch from address order will be right on one loop and wrong on the next.
Branch numbers also need not be contiguous — OC 51 leaves branch 5 unused.

### Reading an OC's connected ICs

Two ways, and the first is better:

1. **`<Mnet><RefSystemList/></Mnet>`** (what `g50a topology` uses) — one query, returns every OC
   with its full IC list plus BC/BS addresses.
2. **`2100` against the OC** — returns `2180 85 83<oc> 84<bc> [A6<bs>] 80<ic> 80<ic> …`, but the
   frame is a fixed length so the IC list is **paged**: an OC with a BS fits 3 ICs per response,
   one without a BS fits 4. mtool issues it repeatedly to walk the list. Use `RefSystemList` unless
   you specifically need the raw path.

`2108` also works on an **OC**, returning its own capacity code — `0x50` = 80 → P400, `0x46` = 70
→ P350. Summing the ICs' codes against it gives the connection ratio.


Type prefixes seen in `2100` and in the OC/BC `2180` enumerations: **`0x80` = IC, `0x83` = OC,
`0x84` = BC, `0xA6` = BS.** The OC's enumeration lists its ICs in ascending address order, *not*
branch order, so it is not a shortcut to the branch map.

---

## 8h. Corrections and family differences (2026-09-03)

### `MnetRouter` is a `setRequest`

Easy to get wrong: the raw-frame pass-through is issued as
`<Command>setRequest</Command>`, **not** `getRequest`, even though it is a read. A `getRequest`
carrying `MnetRouter` is rejected with
`<ERROR Point="MnetCommandList" Code="0101" Message="Unknown Attribute"/>` — a misleading message
that points at the wrong element.

### Branch `0x00` is context-dependent

`210A` returning `0x00` means **the 16th branch** on a system that has a BC — but **"not
applicable"** on a system that has none. Verified on a PUHY-300 (2-pipe heat pump, no BC): both its
ICs return `218A00`.

Consequence for the grouping algorithm in §8g: **check `RefSystemList` for a BC/BS first and skip
grouping entirely when the loop has neither.** Otherwise two ICs both reporting `0` look like a
branch-number collision and you infer a phantom second controller.

### Capacity code: `QJ = round(P / 5)`

Exact, not a lookup: P20→4, P25→5, P32→6, P40→8, P50→10, P63→13, and it continues P80→16,
P100→20, P125→25. The rounding is what makes P32→6 (not 6.4) and P63→13 (not 12.6). Inverting
`QJ → P` needs the standard-size list, since 6 could be 30 or 32 and only 32 is a real product.

`2108` works on an **OC** as well as an IC: `0x50`→P400, `0x46`→P350, `0x3C`→P300.

### PUMY-SP is a different frame format — the PURY offsets do NOT transfer

On `PUMY-SP112YMK` outdoor units all 14 banks answer, but:

- the byte after `39FE<bank>` is **not** the PURY's constant `00`. It is systematic:
  **`(330 − DA − bank) mod 256`**, verified on every bank of two units — i.e. these frames carry a
  leading check byte the PURY frames don't, which shifts everything;
- the payloads are heavily `FF`-filled — far fewer live fields than a PURY.

Unconfirmed reads pending a labelled sample: bank `02` looks like it holds **Vdc** (556.0 / 579.0 V
on two units), bank `50` a **current** (6.6 A on a running unit, 0.0 on a stopped one), bank `90` a
**frequency** (~20 Hz running, 0 stopped). Do not ship these without verification.

### `RefSystemList` omits powered-off systems

A refrigerant system whose outdoor unit is powered down **does not appear** in `RefSystemList` at
all, even though its indoor units still exist and are still addressable. Useful as a quick
"is that OC alive" check — and a trap if you treat the list as a static inventory.

### Absent devices answer `#NO ACK ERROR`

Probing an M-NET address with nothing on it returns `#NO ACK ERROR` (address-level, independent of
opcode). `SystemData`'s `MCpAdrs` / `DemandUnit` being empty strings is the corresponding
controller-side signal that no MC-p or demand controller is configured.

---

## 8i. Mixed-mode operation — decoded from a live HEAT test (2026-09-03)

Method: switch one indoor unit on a cooling-dominant heat-recovery loop into **HEAT**, and read raw
banks against matched MainteToolNet frames. Worth doing rather than waiting for winter — a single
small unit is enough to tip the loop into mixed mode, though **not immediately** (see the Pre.H.
note below).

### `QjC` and `QjH`

Both live in OC bank `80`:

| Field | Bank | Byte | Encoding |
|---|---|---|---|
| `QjC` cooling indoor capacity | `80` | 6 | plain u8 |
| `QjH` heating indoor capacity | `80` | 8 | plain u8 |

`QjC` verified exactly against labelled frames: `0x1A` = 26 and `0x1F` = 31 matched mtool's 26 and
31. `QjH` sat at `00` through every cooling-only frame and went to **`04`** in the same frame mtool
showed `QjH = 4`. Byte 9 moved with byte 8 in that frame; on one sample it cannot be told apart
from byte 8, so treat byte 9 as unidentified.

### Mode enums

| Field | Cooling-only | Mixed, cooling-dominant |
|---|---|---|
| OC `Ope Mode` | `C.Only` | **`C.Main`** |
| BC `OC Sig` | `C.Only` | **`C.Main`** |
| BC `BC Sig` | `C.O.ON` | **`C.H.ON`** |

**`21S4a` stayed `0`** throughout, i.e. the 4-way valve keeps its cooling orientation in `C.Main`.
So `21S4a` will only be exercised by a heating-dominant loop, not by mixed mode.

### The BC `b` row is confirmed as SVB, empirically

The `b` row had been all-zero in every sample ever taken. During the test it went **non-zero on
exactly the one branch whose IC reached `Heat ON`**, and that branch read `a=0, b=1, c=0` — hot-gas
valve open, liquid and suction shut. That is precisely what §8e predicted from theory; it is now
observed.

### `c=0` means "not on suction", covering stopped units too

§8e originally said `c=0` marked a heating branch or an unused one. A labelled frame with two
**stopped** units showed `c=0` on both of their branches as well, and a unit switched from HEAT to
COOL had its `c` go `0 → 1`. So `c=0` = branch isolated from suction, which includes stopped,
heating, and unused. The `a` row's 1:1 correspondence with `IC S = Cool ON` held in every frame
checked, including with 7 units cooling simultaneously.

### `State = Pre.H.` — a unit can look heating for minutes without being served

IC `State` has a value beyond ON / Run / Stand by / Stop: **`Pre.H.`**. A unit commanded to HEAT
entered `Pre.H.` with `IC S = Heat OFF`, and stayed there for **~7 minutes** — opening its LEV to
500 pulses and letting TH2 rise above room temperature — while the OC still reported `C.Only`,
`QjH = 0` and an all-zero `b` row. Only later did `IC S` become `Heat ON` and the loop flip to
`C.Main`. Do not infer "this unit is heating" from Mode, LEV or pipe temperatures; use `IC S`.

### In HEATING, `SH/SC` is not `TH3 − TH2`

Confirmed: a heating unit displayed `SH/SC = 21.7` with TH2 and TH3 both reading 14.7 — difference
zero. The §8d formula is **cooling-only**, as scoped. The heating (subcool) formula is not yet
established; `Tc − TH2` was close on one sample but not exact, so it is not claimed here.

### Bank-90 trailer — earlier claim RETRACTED

§8d claimed the bank `90` trailer meant `9001` = cooling active, `9000` = idle, `8000` = off. **That
is wrong.** Observed on one IC across the test:

| State | LEV | Trailer |
|---|---|---|
| OFF, mode COOL | 41 | `8000` |
| ON, HEAT, `Pre.H.` / `Heat OFF` | 41 | `9000` *and* `8000` on different samples |
| ON, HEAT, `Pre.H.` / **`Heat ON`** | 180 | **`A001`** |
| ON, COOL, `Cool ON` (earlier) | 150–318 | `9001` |

What survives: **low byte `01` = thermo-ON** (seen for both `Cool ON` → `9001` and `Heat ON` →
`A001`), and the high nibble distinguishes cooling (`9`) from heating (`A`) *when thermo-on*. The
thermo-off values are not explained — the same displayed state produced both `8000` and `9000`.

### The BC valve bitmap is definitively not in the memory banks

Proven, not suspected: with a labelled frame captured **4 seconds** after a raw snapshot, the
16-bit `a` pattern (`0000110000001000`) and `c` pattern (`1111110111111101`) appear in **none** of
BC banks `00, 01, 02, 40, 80, 91, 92`, in either bit order. mtool must obtain valve state through an
opcode not yet identified. Bank `91` is the only BC bank that moved during the test, so it remains
the best place to look, but it does not contain the bitmap itself.

---

## 8j. Reading a MainteToolNet pcapng — what worked, so nobody relearns it

Notes from extracting `.local/analiza-20260903.pcapng` (16 min, mtool ↔ a G-50BA). Test fixtures:
that pcap plus the older `mtool-2017-session-*.pcapng` and `capture-81-2026-05-19.pcapng`.

### Tooling

**There is no `tshark` on this Mac, but `/usr/sbin/tcpdump` reads pcapng fine** (it announces
`reading from PCAP-NG file …`). No conversion needed.

```sh
# ASCII payloads for one side of the traffic
tcpdump -r cap.pcapng -nn -A 'tcp port 25' | sed 's/[^[:print:]]/./g' > smtp.txt   # trend push
tcpdump -r cap.pcapng -nn -A 'tcp port 80' | sed 's/[^[:print:]]/./g' > http.txt   # queries
# who talks to whom
tcpdump -r cap.pcapng -nn | awk '{print $3" > "$5}' | sed 's/:$//' | sort | uniq -c | sort -rn
```

The `sed` stripping non-printables is **essential** — raw bytes otherwise corrupt the text and
break every regex downstream.

⚠️ `tcpdump -A` interleaves payload with its own header lines, and XML gets split across TCP
segments. It was good enough for line-oriented data, but **a real tool should reassemble TCP
streams** rather than regex over `-A` output.

Timestamps: `-A` emits a header line per packet, e.g.
`17:04:40.216887 IP 192.168.1.100.56472 > 192.168.1.2.80: Flags [P.], …`. Track the most recent
such line to attribute payload lines to a time — needed to pair captures with GUI screenshots.

### Port 25 — the `MnetMonitor` trend push (bulk bank data)

Plaintext SMTP bodies: `[MnetMonitor]`, `RequestID=`, `SmtpServer=`, `[Data]`, rows, `[END]`.
Each data row is `HHMMSS,<DA>,<HEX>`:

```python
re.findall(r'^(\d{6}),(\d*),([0-9A-Fa-f]{4,})\s*$', text, re.M)
```

861 of 881 rows in that capture were `39FE<bank>` memory-bank responses. This is the cheap way to
get a large labelled-in-time corpus of bank payloads for many units at once.

### Port 80 — synchronous queries and the subscription setup

**The trap that cost time: `DA` is an attribute of `MnetCommandList`, not `MnetRouter`.** A regex
anchored on `<MnetRouter[^>]*DA="…"` matches **zero** times.

```python
for da, body in re.findall(r'<MnetCommandList DA="(\d+)"[^>]*>(.*?)</MnetCommandList>', t, re.S):
    for data, rcv in re.findall(r'Data="([0-9A-Fa-f]*)"\s*RcvData="([^"]*)"', body):
        ...   # request has RcvData="*", the response carries the hex
```

**The single most valuable query — which banks mtool actually polls per unit:**

```python
re.findall(r'<SendCommandRecord\s+DA="(\d+)"\s+Data="([0-9A-Fa-f]+)"', t)
```

That is how the `210A` branch opcode was found, and how it was established that a panel field must
live in the subscribed set. Run it first on any new capture.

### Frame conventions worth knowing before parsing

- **Response = request with the second byte's high bit set:** `397E`→`39FE`, `2100`→`2180`,
  `210A`→`218A`, `2D0B`→`2D8B`.
- `MnetRouter` is issued as **`setRequest`**, even though it reads (see §8h).
- `RcvData="#NO ACK ERROR"` = nothing at that M-NET address, independent of opcode.
- Payload encoding: signed BCD tenths, `7FFF` = sensor absent (§8d). **PUMY frames prepend a check
  byte `(330 − DA − bank) mod 256`** which must be skipped or every offset is wrong (§8h).
- Synchronous `MnetRouter` traffic in that capture is confined to the *Connect Infor* scan and model
  selection; the Operation Status Monitor panel itself is fed by the SMTP subscription. So if a
  displayed field isn't in a subscribed bank, look for a **different dialog's** one-shot query.
