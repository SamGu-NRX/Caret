# Preflight Phase - Level 2 and Level 3

This document validates an L2 or L3 implementation plan in `memory-bank/active/tasks.md`.

## Checks

1. **Wrong-reference guard**
   - If `memory-bank/active/progress.md` `**Complexity:**` is Level 4, this is the wrong reference. Write `FAIL (blocking)`. Do not run the remaining checks.
2. **Verify Prerequisites**
   - Check `memory-bank/active/tasks.md` for planning completion
   - For Level 3: Verify creative phase documents exist (if creative phases were flagged)
   - Read implementation plan and design decisions
3. **TDD Plan Encoding** *(blocking)*
   - The test-first process lives in `.cursor/rules/shared/always-tdd.mdc`
   - This check governs units that change executable behavior. A unit delivering user-facing prose or policy (docs content, PR/issue templates, CONTRIBUTING, instructional comments, rule/skill wording, etc.) owes no tests for those artifacts; omitting tests for those artifacts passes this check
   - Classify a unit as executable only when a user of this product can observe the behavior breaking. An agent or a developer tool invoking it is not enough. The plan's "executable" label is not decisive when it contradicts that test.
   - For each implementable unit of executable work (function, slice — whatever granularity the plan uses), confirm the ordered substeps place test-writing before production code, explicitly enough that a reasonable implementer cannot follow the plan by coding first
   - When a numbered step is a scheduled change-detector (a test that can only go red when someone deliberately edits the artifact it asserts on — heading, phrase, link, or checklist assertions on a document), or a scheduled contract test that is not the published contract of this product, delete that step. Keep the other steps. Record the finding and continue.
   - When a unit already has both test steps and production steps and they are in the wrong order, put the test steps first. Same steps. Record the finding and continue.
   - Do not invent tests. Do not emit always-tdd stages.
   - FAIL when the numbered steps for a unit that is executable under What TDD Governs have no test steps (implementation-only under a "we follow TDD" disclaimer, or TDD only in the preamble). This still applies after a strike that left such a unit with no tests. After a strike, a unit that is not executable under that rule owes no tests; omitting them passes.
   - On FAIL: cite the executable units lacking test steps. Write `FAIL (blocking)`.
4. **Convention Compliance**
   - Verify the plan's proposed file locations, naming conventions, and patterns align with established codebase conventions documented in `memory-bank/systemPatterns.md`
   - Cross-reference proposed module structure against existing project organization
   - Flag any deviation from established patterns with specific recommendations
5. **Dependency Impact**
   - Trace the plan's touchpoints through the dependency graph
   - Identify modules, consumers, or tests that will be affected but aren't accounted for in the plan
   - Verify that all downstream impacts are documented and addressed
6. **Conflict Detection**
   - Search for existing implementations, utilities, or patterns that overlap with or contradict the plan's approach
   - Identify duplication-in-waiting - cases where the plan proposes building something the codebase already provides
   - Flag any proposed changes that would break public contracts or published interfaces — internal restructuring that preserves the public API surface is not a conflict
7. **Completeness Precheck**
   - Verify the plan addresses all stated requirements with concrete implementation steps mapped to each one - not aspirationally, but with specific files, functions, and approaches identified
   - Flag any requirements that are acknowledged but lack a clear implementation path
   - Verify test coverage is planned for all new executable behavior — not for prose or policy artifacts, and not because the plan labeled a unit executable; the TDD Plan Encoding check governs that boundary
