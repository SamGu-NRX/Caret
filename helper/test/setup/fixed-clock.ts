// Fixtures across the suite name dates around 2026-10-08 (goal-desk.ts's 3:00 PM PT meeting with Priya among them),
// and planning drops an event once it is past. Starting every test file's clock at a fixed instant keeps those
// fixtures in the future on any day the suite runs; Date still advances in real time from there, so code that
// measures elapsed time or stamps grants with Date.now() behaves as before. Only Date is faked: timers stay real.
import { vi } from "vitest";

vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-08T16:00:00Z"), shouldAdvanceTime: true });
