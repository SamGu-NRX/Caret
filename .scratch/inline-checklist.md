# v2/inline checklist (working file, never committed)

Brief: Caret replaces Cotypist for inline writing. Order 1, 6, 2, 3, 5, 4, 7, 8.
Push only to `sam`. No EngineLoader edits until the lead names the dogfood commit.
Heavy: lr-lease + heavy.lock (probe: .scratch/probe/run.sh); swift tests via caret-heavy swift-tests --inputs-from caret-v2-host.
VM: needs > 12 GiB free; h13 harness hardcodes caret-v2-host + v2/host ancestry -> own copy needed.
Stay out of OnboardingController / OnboardingFlow (v2/access).

## Done (typecheck only; Swift tests NOT run, disk blocked)
748cc96f probe-length; 14047ab4 keys setting; 4ae2e126 words-that-fit native; 80c10eee Electron ask; f1f7dfad current word fix;
16c84d4c page words-that-fit; 2ea029d6 page replace verb (helper 19/19); 98c04a4d page writing fixes; 11dcbcd0 apps off + keys menu;
a7b2867d personal instructions + Cotypist import; 920ae919 chromium family; 0335d8e7 secret field rule; 7b0ef1f4 Writing tab;
4ac85292 page word walk.

## Open
- [ ] item 1: run probe (blocked: disk), pick length rule, maybe extend mode; constants still 4/60
- [ ] swift tests for all commits (blocked: disk); record InlineRenderTests references and look at them
- [ ] items 2/3 VM rows (blocked: disk); rich-editor fixture pages (ProseMirror, Lexical, Draft.js) for item 3
- [ ] web-form tab-text browser tests (6) unrun
- [ ] audit (a) missing-AX-value fallback: proposal only, needs Catalyst evidence
- [ ] item 8: waits for dogfood EngineLoader commit
- [ ] auditor review findings
