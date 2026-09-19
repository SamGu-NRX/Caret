# Plan Phase - Level 4: Complex System

This document guides the planning phase for a Level 4 task. The L4 plan is a milestone list - a breakdown of the overall project into multiple independent sub-runs, each scoped as L1, L2, or L3. Every subsequent step in the L4 workflow is driven by this list. A bad milestone decomposition causes compounding problems across every sub-run; a good one makes the rest of the project mechanical.

## Step 1: Load Context

Read:
- `memory-bank/active/projectbrief.md`
- `memory-bank/active/tasks.md`
- `memory-bank/systemPatterns.md`
- `memory-bank/techContext.md`
- `memory-bank/active/activeContext.md`
- `.cursor/rules/shared/niko/memory-bank/active/milestones.mdc` (milestone format and quality criteria)

## Step 2: Verify Prerequisites

- Confirm `memory-bank/active/projectbrief.md` exists with the user story and requirements. If it's missing or too vague to decompose, ask the operator for clarification before continuing.
- Confirm `memory-bank/active/milestones.md` does **not** exist. If it does, a plan has already run for this task - re-entry routing applies. Stop and inform the operator which milestone is next.

## Step 3: Generate Milestone List

Decompose the overall task into an appropriate, optimal number of milestones. Apply the quality criteria from `.cursor/rules/shared/niko/memory-bank/active/milestones.mdc` (loaded in Step 1):

- Each milestone is independently deliverable as an L1/L2/L3 sub-run
- Each milestone is concrete enough that a future agent can classify it without additional context beyond the milestone + the memory bank files.
- Milestones cover the full project scope - no gaps, no overlap
- Milestones that change documented behavior must include documentation updates in their scope (README files, doc comments, configuration docs, user-facing guides)
- Sequence in dependency order: milestone N must not require work from milestone N+1. The checklist is always a serial-safe walk.
- If milestones have opportunities for parallelization, add a flowchart under Execution Order in `memory-bank/active/milestones.md` that shows which milestones may run in parallel.

For each milestone, estimate its complexity level (L1/L2/L3) using the decision tree in `.cursor/skills/shared/niko/references/core/complexity-analysis.md`. This estimate is advisory - the actual classification happens at the start of each sub-run - but a milestone estimated as L4 is a signal it needs to be split further.

**If the task description is too vague to produce a confident milestone list**, stop here and ask the operator to clarify scope. Do not guess; a wrong decomposition cannot be fixed cheaply once sub-runs begin.

After enumerating the milestones, state the **cross-milestone invariants**: the constraints that every sub-run must preserve regardless of which milestone it implements. These are not goals or requirements - they are properties of the system that no milestone is permitted to violate. Examples: "API backward compatibility is maintained at every milestone boundary," "the database migration is reversible after any individual milestone," "no milestone introduces a dependency that another milestone would need to remove."

Record these invariants in `memory-bank/active/milestones.md` alongside the milestone checklist.

## Step 4: Write milestones.md

Write `memory-bank/active/milestones.md` following the format in `.cursor/rules/shared/niko/memory-bank/active/milestones.mdc`:

```markdown
# Milestones: <task-id>

## Cross-milestone invariants & constraints

[properties no milestone may violate. When two milestones share an artifact, state the handoff rule.]

## Execution Order

[optional dependency flowchart — omit if all milestones are sequential]

- [ ] <Milestone 1 description, optional existing ticket>
- [ ] <Milestone 2 description, optional existing ticket>
- [ ] <Milestone 3 description, optional existing ticket>

## Per-milestone done and risks

### <exact checkbox text>
- Done: <what shipped looks like>
- Risks: <what this sub-run must not lose, or "see invariants">
```

Write estimates in the plan result, not on checkbox lines. Do not create tickets. If a ticket exists, put it on the checkbox line.

## Step 5: Update Memory Bank

Update `memory-bank/active/progress.md` to record completion of the L4 plan phase, including each milestone's advisory L1/L2/L3 estimate and a one-line rationale. Do **not** write those estimates onto checkbox lines in `milestones.md`.

Update `memory-bank/active/activeContext.md`:
   - Phase: `PLAN - COMPLETE`
   - What was done: milestone list generated (N milestones)
   - Next step: preflight to validate the milestone list

## Step 6: Log Progress

Record the results by printing a summary in the following format:

~~~markdown
# L4 Plan Result

✅ COMPLETE

## Milestones

- [ ] [Milestone 1 description] - estimated L[N]
- [ ] [Milestone 2 description] - estimated L[N]
- [ ] [Milestone 3 description] - estimated L[N]

## Next Steps

Preflight will now validate the milestone list.
~~~

## Step 7: Phase Transition

Spawn a subagent (prefer smarter / different family if available); the only instruction you add is `` Run the `/niko-preflight` skill ``. Do not run the skill in this conversation.
