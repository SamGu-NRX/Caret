---
name: niko-preflight
description: Niko Memory Bank System - Preflight Phase - Pre-Build Plan Validation
---

# Preflight Phase - Pre-Build Plan Validation

This command validates the implementation plan against codebase reality before any code is written. It catches design oversights, convention conflicts, TDD violations, and integration issues that would otherwise surface during or after the build.

## Step 1: Load Memory Bank Files

Read:
- `memory-bank/active/tasks.md`
- `memory-bank/active/progress.md`
- `memory-bank/active/projectbrief.md`
- `memory-bank/systemPatterns.md`
- `memory-bank/techContext.md`
- `memory-bank/active/creative/**/*.md` (if any exist)

## Step 2: Determine Complexity Level

If no complexity level is set, or `memory-bank/active/progress.md` does not exist, or Complexity is not Level 2, Level 3, or Level 4: record `FAIL (blocking)`. Skip to Write Status.

## Step 3: Route to Level-Specific Checks

Load the matching check file and follow it:

- Level 2 or Level 3: `.cursor/skills/shared/niko-preflight/references/default-preflight.md`
- Level 4: `.cursor/skills/shared/niko-preflight/references/level4-preflight.md`

## Step 4: Radical Innovation

What's the single smartest and most radically innovative and accretive and useful and compelling change you could make to the plan at this point?

Record that idea as an advisory finding: a specific structural sketch the operator can evaluate against the cost of redesign, not a vague suggestion. Do not make the change to the plan, even if the idea fits the brief. The finding is advisory; it does not block.

## Step 5: Judge, Do Not Fix

Record every issue as a finding. FAIL when the plan must change before build (`FAIL (fixable)` or `FAIL (blocking)`); PASS only when the plan is acceptable as-is (advisories allowed).

Never modify the plan under review, except the TDD step swap and the strike, and only when the loaded checks performed those edits. Do not rewrite Implementation Plan units, behavior lists, or other scheduled work except that swap and that strike.

Allowed writes only:

- `memory-bank/active/.preflight-status`
- the `**Phase:**` field in `activeContext.md` (under End of Verification)
- `progress.md`
- those two in-phase plan edits on `tasks.md`

## Step 6: Write Status

Overwrite `memory-bank/active/.preflight-status`. First line is exactly one allowed value from `.cursor/rules/shared/niko/memory-bank/active/preflight-status.mdc`. After a blank line, write this run's findings.

## Step 7: Log Progress

> 🚨 **Printing this notice is NOT the end of this phase.** After printing, continue immediately to the next step - do not stop.

Update `memory-bank/active/progress.md` to record that Preflight completed and what the first line of `.preflight-status` was.

Print the appropriate block:

### PASS

~~~markdown
# Preflight Result

✅ PASS

## Findings

1. **Findings** - bulleted list of each finding with severity
2. **Advisory items** (if any) - concrete recommendations the operator can evaluate

~~~

### FAIL

~~~markdown
# Preflight Result

❌ FAIL

## Findings

1. **Findings** - bulleted list of each finding with severity
2. **Advisory items** (if any) - concrete recommendations the operator can evaluate

~~~

## Step 8: End of Verification

Update `memory-bank/active/activeContext.md` so `**Phase:**` records Preflight complete with the first line of `.preflight-status` (e.g. `**Phase:** PREFLIGHT - COMPLETE (PASS)`). Do not load a level workflow or begin another phase. Stop.
