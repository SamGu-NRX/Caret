# Third-party sources

`sources.json` records exact upstream commits. Each `packages/` entry is a Git submodule, not code relicensed by Caret. Preserve upstream copyright and license notices when extracting code. The root MIT license covers original Caret files only. No upstream code runs in the default starter.

| Upstream | License at pin |
| --- | --- |
| KeyType, GhostType | MIT |
| Jev Ultrafast, TypeSafe Computer Use, Computer Use Jev, Browser Harness | MIT |
| Backscroll | MIT |
| Retrace | Apache-2.0 |
| ActivityWatch | MPL-2.0 |
| Skyvern, OpenRecall | AGPL-3.0 |
| Screenpipe `892199f…` | MIT for the repository except `ee/`, which retains its separate enterprise license |

Screenpipe's later releases use a commercial license. This starter deliberately pins the earlier commit. Do not copy its `ee/` code or apply newer upstream changes assuming they are MIT. Review the license at the exact revision before changing any pin or distributing integrated code.

Skyvern and ActivityWatch contain nested submodules. Those dependencies retain their own licenses and are not initialized by the default setup. Screenpipe also declares Git LFS assets. Keep these optional research trees separate from Caret's shipped executable until the team chooses an integration and checks its dependencies.
