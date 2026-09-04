# mtool-pcap

Offline analysis of MainteToolNet / G-50A packet captures. Not published — this is a
diagnostic tool for reverse-engineering the M-NET protocol, kept in the repo so the
extraction steps are reproducible instead of being retyped as one-off `grep`s.

Protocol background: [`docs/g50a-protocol.md`](../../docs/g50a-protocol.md) §8j (how to read a
capture) and §8k (what the opcodes mean).

## Why it exists

The machines these captures are taken on have no `tshark`, and `tcpdump -A` — the fallback —
**interleaves its own header lines with payload and loses any record that splits across TCP
segments**. That is not hypothetical: a 3-minute capture of the trend push split a data row
after `39FE82002E01080A01`, and the remaining `030020640104` looked like a separate,
unparseable line.

So this package reassembles streams first, then parses.

## Use

```sh
pnpm --filter mtool-pcap build

node dist/cli.js streams cap.pcapng            # who talked to whom, bytes, gaps
node dist/cli.js banks   cap.pcapng            # DA x opcode matrix
node dist/cli.js subs    cap.pcapng            # MnetMonitor subscription list
node dist/cli.js trend   cap.pcapng --da 95    # trend-push rows for one unit
node dist/cli.js queries cap.pcapng --op 210A  # synchronous MnetRouter pairs
node dist/cli.js text    cap.pcapng --port 25  # reassembled stream, printable
```

`banks` is the one to run first on a new capture: it answers "which opcodes does the tool poll
for this unit", which is what tells you whether a field the GUI displays is in the subscribed
set at all. Prefer it over `subs`, which is **empty unless the capture happens to cover the
moment a monitor panel was opened**.

## Layout

| File             | Contents                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `src/pcapng.ts`  | pcapng and classic-pcap block reader, per-interface timestamp resolution                                                             |
| `src/tcp.ts`     | Ethernet/IPv4/TCP decode and per-direction reassembly; `timeAt()` maps a byte offset back to its capture time                        |
| `src/mtool.ts`   | trend-push, `MnetCommandList` and subscription extractors, plus the frame conventions (response opcode, PUMY check byte, signed BCD) |
| `src/capture.ts` | load a file and get reassembled streams                                                                                              |
| `src/cli.ts`     | the subcommands above                                                                                                                |

`timeAt()` matters more than it looks: pairing a decoded frame with a screenshot of the GUI is
the only way these fields get _labelled_ rather than guessed, and that needs a byte offset to
carry a timestamp.

## Tests

```sh
pnpm --filter mtool-pcap test
```

Fixtures are synthetic (`test/helpers.ts` builds pcapng files byte by byte) so the suite can
cover cases a real capture happens not to contain — sequence wrap, retransmission, a genuine
hole, VLAN tags, Ethernet padding — and so no site traffic lives in the repository.
