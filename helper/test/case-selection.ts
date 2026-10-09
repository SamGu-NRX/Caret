/** A task as Vitest hands it to `afterAll((context, suite) => …)`: a test, or a suite with its own tasks. */
interface TaskTree {
  readonly mode: string;
  readonly tasks?: readonly TaskTree[];
}

/**
 * Whether every case under `suite` was selected to run. A `-t` name filter or an `.only` marks each case it leaves out
 * "skip", so an aggregate check over a whole set of cases (every fixture seen, more than N cases run) would fail a
 * filtered run whose selected cases all passed. Such a check applies only when this returns true; each case still
 * checks itself in its own test.
 */
export function everyCaseSelected(suite: TaskTree): boolean {
  return (suite.tasks ?? []).every((t) => t.mode === "run" && everyCaseSelected(t));
}
