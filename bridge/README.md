# caret-bridge

The Native Messaging host Chrome (or Chrome for Testing, or Helium) launches for Caret's extension (`extension/`). It is one authenticated pipe between the extension's service worker and the helper's `page.sock` (`helper/src/engines/`). Design: `~/.caret-run/plans/browser-layer.md`, section 2.

## What it does

Chrome runs it with the calling extension's origin as its only argument and speaks Native Messaging frames (a 32-bit little-endian length, then UTF-8 JSON) on stdin and stdout. The bridge:

1. connects to `page.sock` (`$CARET_PAGE_SOCKET`, default `~/.caret-run/sockets/page.sock`) and refuses a listener whose uid is not this user's (`getpeereid`);
2. reads the helper's per-start secret from `<socket>.key`, refusing a file that is not a regular 0600 file owned by this user, or a directory that group or others can write;
3. answers the helper's challenge with HMAC-SHA256 over both nonces, and requires the helper's own HMAC back before it relays anything (`engineChallenge`, `engineHello`, `engineWelcome` in `helper/src/protocol.ts`);
4. relays: each extension frame becomes one NDJSON line, each helper line becomes a frame, split into `pageChunk` parts past Chrome's 1 MB host-to-extension cap. Each direction carries only its own message types (`Relay.swift`).

It writes nothing to stdout before the helper has proved itself, and exits when either side closes.

## Threat model

The same user's processes are the boundary, as for the reader's socket.

- **Another user** cannot connect to `page.sock` (0600 in a directory only the user can write) or read the secret.
- **A same-user process that takes over the socket path** cannot answer the bridge's challenge without the secret, so the bridge relays nothing to it: no snapshots, no grants.
- **A same-user process that connects to `page.sock` without the secret** is refused before any page message (`helper/test/page-engine.test.ts`).
- **A same-user process that can read the secret file** can impersonate either side. Same-user isolation is out of scope here, as it is for the reader; the browser's own extension identity (`allowed_origins`, the fixed `key`) is what keeps other extensions from launching this host.
- **The page** never reaches the bridge: only the extension's worker holds the port, and the bridge passes only helper-direction types to it.

Why a secret file and not an inherited descriptor (the reader's plan after B23): Chrome, not Caret, launches the bridge, so there is no Caret parent to hand it one. Node cannot read a socket peer's uid, so on the helper's side the uid check is the filesystem's.

## Build and test

```
/usr/bin/lockf -k ~/.long-run/locks/heavy.lock swift build -c release --product caret-bridge
/usr/bin/lockf -k ~/.long-run/locks/heavy.lock swift test
```

`CaretPageProtocol` is the Swift mirror of the page wire; its tests decode every line of `helper/fixtures/golden/page.ndjson` and check the HMAC vector in `page-auth.json`. The end-to-end run is `fixtures/web-form/accept.ts`.
