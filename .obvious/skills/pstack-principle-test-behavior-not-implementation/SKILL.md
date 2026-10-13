---
name: pstack-principle-test-behavior-not-implementation
description: "Apply when you write, change, or keep a test. Call the code the way its users do and assert the result or effect they observe. Check whether assertions detect a missing result, while preserving valid tests of intentional absence and empty collections."
disable-model-invocation: true
---

# Test Behavior, Not Implementation

A test calls the code the way its users do and asserts the result or effect they observe. Prefer a literal expected value when the contract specifies one. Internal call checks and constant pins need a reason tied to that contract.

The check: replace the subject's result with `undefined` mentally and see whether the assertion detects the missing result. For a subject that returns no value, inspect the observable effect instead. Passing this check does not prove a test is sufficient. Failing it does not make a test of intentional absence useless. Judge the behavior and input, not the assertion's name.

**Why:** Tests should catch a wrong result or effect. Checking a hand-maintained constant without exercising the mechanism that reads it can obstruct edits without checking behavior.

These shapes need inspection:

- **No observation.** The subject never runs, or its result and effects are never asserted.
- **Low specificity.** `toBeDefined`, `toBeTruthy`, `toBeInstanceOf`, and `toBeGreaterThan(0)` reject `undefined`, but may accept a wrong result. Keep them when they express the behavior being checked. Use a concrete expected value when the contract has one.
- **Intentional absence.** `toBeUndefined`, `not.toThrow`, and negative mock assertions can be valid. Exercise the input that should produce the absence, and cover a contrasting input when that distinguishes the intended behavior from doing nothing.
- **Empty results.** `toEqual([])` and `toHaveLength(0)` reject `undefined`. Keep them when an empty collection is the expected result.
- **Self-reference or constants.** Comparing the subject with itself or restating a constant does not check an independently expected result. A call-count assertion alone may also miss a wrong payload or state.
- **Fixture asserts fixture.** The assertion reads only data the test built, without observing the subject's behavior.

**The fix:** call the subject with one concrete input and assert the literal output or the observable effect, `expect(slugify("Hello, World!")).toBe("hello-world")`. For a mock, assert the payload or resulting state when the contract requires it. Rewrite or delete a test only after identifying the defect it cannot detect.

**Keep** a test of a relation across a table's rows (a key present in two tables, a parent that exists), and a compile-time check in a `*.test-d.ts` file.
