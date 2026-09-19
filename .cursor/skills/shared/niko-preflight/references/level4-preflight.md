# Preflight Phase - Level 4: Complex System

This document validates the L4 milestone list in `memory-bank/active/milestones.md` against `memory-bank/active/projectbrief.md`. It judges decomposition, not implementation steps.

## Additional loads

Read:

- `memory-bank/active/milestones.md`
- `memory-bank/active/projectbrief.md`

## Checks

1. **Prerequisites**
   - `memory-bank/active/progress.md` `**Complexity:**` must be Level 4. If it is not, this is the wrong reference. Write `FAIL (blocking)`. Do not run the remaining checks.
   - `memory-bank/active/milestones.md` must exist. If it does not, write `FAIL (blocking)`.
   - Header must be `# Milestones: <task-id>` matching the active task ID in `memory-bank/active/tasks.md`. Header mismatch: write `FAIL (fixable)`.
2. **Checklist shape**
   - Each milestone is one GFM checkbox line (`- [ ]` or `- [x]`). No sub-bullets on those lines.
   - The real checklist is the contiguous GFM checkbox list under Execution Order. Extra `- [ ]` / `- [x]` in Cross-milestone invariants or in Per-milestone done and risks are extra milestones: write `FAIL (blocking)`. Do not FAIL the real checklist for living under Execution Order.
3. **Coverage**
   - Every requirement in `projectbrief.md` maps to at least one milestone.
   - No two milestones cover the same purpose. Gap or overlap: write `FAIL (blocking)`.
4. **Scope and concreteness**
   - Each milestone is independently deliverable, L1–L3 scoped (not itself L4), and names a concrete deliverable.
   - Nested L4, future-dependent work, or a vague activity line: write `FAIL (blocking)`.
5. **Order**
   - The checklist must be serial-safe: walking it one at a time never requires a later milestone. Milestone N must not require work from milestone N+1. Unsafe order or future-dependency: write `FAIL (blocking)`.
   - When the work is not a straight line, Execution Order must include a dependency DAG that agrees with the checklist (the list is a valid serial walk of the DAG). Parallel claimed in prose but no DAG: write `FAIL (fixable)`.
6. **Cross-milestone invariants**
   - A Cross-milestone invariants section must exist. It states properties no milestone may violate — not goals or requirements. Missing section: write `FAIL (fixable)`.
   - When two milestones share an artifact, that section must state a handoff *rule* (who may touch it, and when). Not a file inventory. Missing handoff rule only when a shared artifact exists: write `FAIL (fixable)`. Do not FAIL for a missing handoff rule when no two milestones share an artifact.
7. **Done and risks**
   - Each checkbox has a heading block keyed to the checkbox text (not a checkbox sub-bullet) with:
     - **Done** — a judgeable definition of done
     - **Risks / invariants** — critical risks for that milestone, or an explicit pointer that a cross-milestone invariant covers it
   - Missing Done or Risks/invariants: write `FAIL (fixable)`.
   - Do not create tickets. If a ticket already exists, it belongs on the checkbox line. Do not FAIL for a missing ticket when none exists. Do not require a pointer into `projectbrief.md`.
   - The checkbox plus that block plus `projectbrief.md` (plus the ticket if linked) must be enough to classify and plan the milestone. Too vague to classify: write `FAIL (blocking)`.
