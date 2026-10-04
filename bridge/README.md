# caret-bridge

The Native Messaging host Chrome (or Chrome for Testing, or Helium) launches for Caret's extension (`extension/`). It is one authenticated pipe between the extension's service worker and the helper's `page.sock` (`helper/src/engines/`). Design: `~/.caret-run/plans/browser-layer.md`, section 2.

## What it does

Chrome runs it with the calling extension's origin as its only argument and speaks Native Messaging frames (a 32-bit little-endian length, then UTF-8 JSON) on stdin and stdout. The bridge:

1. connects to `page.sock` (`$CARET_PAGE_SOCKET`, default `~/.caret-run/sockets/page.sock`) and refuses a listener whose uid is not this user's (`getpeereid`);
2. reads the launch's page key from `<socket>.key`, refusing a file that is not a regular 0600 file owned by this user, or a directory that group or others can write. The helper derives the key from the launch secret `src/launch.ts` hands it (B23's scheme), as HMAC-SHA256(launch secret, "caret-page-key"), so the file never holds the secret that authenticates the helper to the reader;
3. answers the helper's challenge with HMAC-SHA256 over both nonces, and requires the helper's own HMAC back, bound to the helper's pid, before it relays anything. The pid must be the socket's peer (`LOCAL_PEERPID`), as the reader requires of the helper (`engineChallenge`, `engineHello`, `engineWelcome` in `helper/src/protocol.ts`);
4. relays: each extension frame becomes one NDJSON line, each helper line becomes a frame, split into `pageChunk` parts past Chrome's 1 MB host-to-extension cap. Each direction carries only its own message types (`Relay.swift`).

It writes nothing to stdout before the helper has proved itself, and exits when either side closes.

## Threat model

The same user's processes are the boundary, as for the reader's socket.

- **Another user** cannot connect to `page.sock` (0600 in a directory only the user can write) or read the key.
- **A same-user process that takes over the socket path** cannot answer the bridge's challenge without the key, so the bridge relays nothing to it: no snapshots, no grants.
- **A same-user process that relays the bridge's handshake to the real helper** is refused: the helper's proof names the helper's pid, and the relay is the bridge's peer.
- **A same-user process that connects to `page.sock` without the key** is refused before any page message (`helper/test/page-engine.test.ts`).
- **A same-user process that can read the key file** can impersonate either side of `page.sock`, but not the helper to the reader: the file holds a key derived from the launch secret, not the secret. Same-user isolation is out of scope here, as it is for the reader; the browser's own extension identity (`allowed_origins`, the fixed `key`) is what keeps other extensions from launching this host.
- **The page** never reaches the bridge: only the extension's worker holds the port, and the bridge passes only helper-direction types to it.

Why a key file and not an inherited descriptor (the reader's way since B23): Chrome, not Caret, launches the bridge, so there is no Caret parent to hand it one. Node cannot read a socket peer's uid or pid, so on the helper's side the peer check is the filesystem's. Batch W3 replaces the key file with XPC and a code-signing requirement.

## Build and test

```
/usr/bin/lockf -k ~/.long-run/locks/heavy.lock swift build -c release --product caret-bridge
/usr/bin/lockf -k ~/.long-run/locks/heavy.lock swift test
```

`CaretPageProtocol` is the Swift mirror of the page wire; its tests decode every line of `helper/fixtures/golden/page.ndjson` and check the HMAC vector in `page-auth.json`. The end-to-end run is `fixtures/web-form/accept.ts`.
