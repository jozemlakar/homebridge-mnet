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
