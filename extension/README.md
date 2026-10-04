# Caret for Chrome

The MV3 extension that is Caret's page engine: a second reader, beside the Swift Accessibility reader, for web content (`~/.caret-run/plans/browser-layer.md`). Same build for Chrome and Helium.

- `src/content.ts`: the content script, in every http(s) frame and the about:blank and srcdoc frames they own. Dormant until the worker asks: no observer, no timer. It walks controls only (`content/walker.ts`), drops excluded controls by code before anything leaves the frame, keeps each element in a per-frame `WeakRef` registry (`content/registry.ts`), and performs the act the worker hands it after its own recheck (`content/actions.ts`).
- `src/worker.ts`: the service worker. The only holder of the Native Messaging port to `caret-bridge`. It keeps the grant table (`shared/grants.ts`) and each frame's navigation generation (`worker/frames.ts`), checks every mutating verb's grant, document, generation and origin, and hands it to the frame's content script pinned to the exact document.
- `manifest.json` carries a fixed `key`, so the id is always `EXTENSION_ID` (`idbkbnaepbamcdecogahbinlcodkbmmj`). The private key is not in the repository. `storage` holds a random per-profile id, so two profiles of one browser are two engines. `scripting` gives tabs open before install a content script.

```
pnpm install && pnpm build    # dist/, for --load-extension
pnpm test                     # tsc, then the unit tests
```

The browser checks are in `fixtures/web-form/accept.ts`.
