# caret-bridge

The Native Messaging host that Chrome, Chrome for Testing or Helium launches for Caret's extension (`extension/`). It carries messages between the extension's service worker and the Caret host over XPC, and the host relays them to the helper's `page.sock` (`helper/src/engines/`). Design: `~/.caret-run/plans/browser-layer.md` section 2 and its W3 lead decision. The host's half is specified in `~/.caret-run/plans/xpc-bridge-host.md`.

```
extension ─NM stdio─ caret-bridge ─XPC─ Caret host ─page.sock─ helper
```

## What it does

Chrome runs the bridge with the calling extension's origin as its only argument. It speaks Native Messaging frames on stdin and stdout: a 32-bit little-endian length, then UTF-8 JSON. The bridge:

1. connects to the host's Mach service (`BridgeTrust.machService`; `$CARET_BRIDGE_SERVICE` points a test bridge elsewhere). It holds that connection to the host's code-signing requirement: the team's `dev.caret.host`. A service owned by any other code never delivers it a message;
2. calls `open` with the extension id from Chrome's origin, and sends nothing else until the host's reply arrives. The host:
   - holds the bridge to the bridge requirement (the team's `dev.caret.bridge`);
   - checks that the bridge's parent process is a browser whose signature it knows;
   - connects to `page.sock` and completes the helper's handshake (`engineChallenge`, `engineHello`, `engineWelcome` in `helper/src/protocol.ts`). It proves the launch's page key and requires the helper's proof to name the socket's peer pid. The host derives the key from the launch secret it holds in memory;
3. relays. Each extension frame becomes one line to the host. Each host line becomes a frame, split into `pageChunk` parts past Chrome's 1 MB host-to-extension cap. Each direction carries only its own message types (`Relay.swift`), here and again at the host.

It writes nothing to stdout before the host has opened the engine. It exits with status 1 when the host refuses it, and 0 when either side closes after that.

## Targets

- `CaretPageProtocol`: the page wire's Swift mirror, framing, page.sock's handshake proofs and the peer checks.
- `CaretBridgeXPC`: the XPC contract (`Contract.swift`) and the requirements and parent check (`Trust.swift`). Also the bridge's client behind `HostLink` (`Client.swift`) and the host's listener and relay (`HostRelay.swift`). Caret.app links this library.
- `caret-bridge`: the executable Chrome launches.
- `caret-bridge-testhost`: a stand-in for Caret.app's side, used by the acceptance run as a temporary launchd job. Not shipped.

## Threat model

The same user's processes are the boundary, as for the reader's socket. What macOS enforces now:

- **Another user** cannot reach `page.sock` (0600, in a directory only the user can write).
- **No key file.** The helper keeps the page key in memory and deletes a `<socket>.key` left by an earlier build. A same-user process has nothing to read.
- **A bridge signed by another team, or ad hoc,** is refused by the host's requirement before its session sees a message.
- **The team's bridge started by something that is not a browser** is refused by the host's parent check.
- **A process that registered the service name first** cannot answer the bridge: its code fails the host requirement. It does see `open`'s two arguments, the extension id and the bridge version.
- **A relay between the host and the real helper** is refused both ways. Say a same-user process swaps the socket path and passes the host's hello through to the real helper. The host bound that hello to the pid it saw as its peer, the swapper, and the helper accepts only a hello bound to its own pid. The host in turn requires the helper's proof to name its socket's peer.
- **Injected code.** The bridge is signed with the hardened runtime, so `DYLD_INSERT_LIBRARIES` cannot put code inside it.

What it does not cover: a same-user process that starts a real, signed Chrome with an unpacked extension claiming Caret's id. The id comes from the public `key` in the manifest. That process could point Chrome at the real bridge. See the host spec's residual risks.

## Build, sign and test

```
/usr/bin/lockf -k ~/.long-run/locks/heavy.lock swift build -c release --package-path bridge
/usr/bin/lockf -k ~/.long-run/locks/heavy.lock swift test --package-path bridge
```

The in-process suite `BridgeXPCTrust` runs the real requirement checks and relay over an anonymous listener. A wrongly signed bridge, a wrongly signed host, a non-browser parent and a wrong page key are each refused. `CaretPageProtocolTests` decodes every line of `helper/fixtures/golden/page.ndjson` and checks the HMAC vector in `page-auth.json`.

The end-to-end run is `fixtures/web-form/accept.ts --sign-identity <SHA-1> --other-identity <SHA-1>`. It signs the bridge and the test host with the team identity, and signs refusal cases with another team's identity and ad hoc. It runs the test host as a temporary launchd job and boots it out at the end.
