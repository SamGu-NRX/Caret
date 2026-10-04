// Synthetic planning snapshots for the code-mode tests. Names, addresses and dates are invented.
import type { PlanningSnapshot } from "../../src/codemode/types.ts";

const span = (snapshot: string, text: string, start: number) => ({ kind: "span" as const, snapshot, source: "body", startUTF16: start, endUTF16: start + text.length, digest: `d-${text.length}` });

export const FORM: PlanningSnapshot = {
  snapshot: "snap:form:1",
  window: "win:form",
  revision: "r1",
  title: "Workshop signup",
  targets: [
    { ref: "t:name", label: "Full name", kind: "textField", canFill: true, options: [], allowedPressEffects: [] },
    { ref: "t:email", label: "Email", kind: "textField", canFill: true, options: [], allowedPressEffects: [] },
    { ref: "t:session", label: "Session", kind: "textField", canFill: true, options: [], allowedPressEffects: [] },
    { ref: "t:next", label: "Next", kind: "button", canFill: false, options: [], allowedPressEffects: ["e:next-page"] },
  ],
  values: [],
  questions: [
    {
      ref: "q:session",
      text: "Which session time does the email confirm for the workshop?",
      options: [
        { ref: "o:tue", label: "Tue Oct 20, 3:00 PM" },
        { ref: "o:wed", label: "Wed Oct 21, 10:00 AM" },
      ],
    },
  ],
};

export const MAIL: PlanningSnapshot = {
  snapshot: "snap:mail:1",
  window: "win:mail",
  revision: "r7",
  title: "Re: workshop",
  targets: [{ ref: "t:reply", label: "Reply", kind: "button", canFill: false, options: [], allowedPressEffects: ["e:compose"] }],
  values: [
    { ref: "v:name", display: "Alex Rivera", origin: span("snap:mail:1", "Alex Rivera", 10) },
    { ref: "v:email", display: "alex.rivera@example.com", origin: span("snap:mail:1", "alex.rivera@example.com", 40) },
    { ref: "v:tue", display: "Tue Oct 20, 3:00 PM", origin: span("snap:mail:1", "Tue Oct 20, 3:00 PM", 90) },
    { ref: "v:wed", display: "Wed Oct 21, 10:00 AM", origin: span("snap:mail:1", "Wed Oct 21, 10:00 AM", 130) },
  ],
  questions: [],
};

/** A writer's program for "sign me up for the workshop from the email", as the writer would return it. */
export const CANNED_PROGRAM = `async function main(caret: CaretPlanAPI): Promise<PlanRef> {
  const form = await caret.readWindow();
  const mail = await caret.readWindow("win:mail" as WindowRef);
  const field = (label: string) => form.targets.find((t) => t.label === label)!;
  const value = (display: string) => mail.values.find((v) => v.display === display)!;

  const steps: StepRef[] = [
    caret.fill(field("Full name").ref, value("Alex Rivera").ref),
    caret.fill(field("Email").ref, value("alex.rivera@example.com").ref),
  ];
  const session = form.questions[0]!;
  const pick = await caret.choose(session.options.map((o) => o.ref));
  if (pick === null) {
    steps.push(caret.ask(session.ref));
  } else {
    const label = session.options.find((o) => o.ref === pick)!.label;
    steps.push(caret.fill(field("Session").ref, value(label).ref));
  }
  const next = field("Next");
  steps.push(caret.press(next.ref, next.allowedPressEffects[0]!));
  steps.push(caret.waitFor(next.allowedPressEffects[0]!, 2000));
  return caret.plan({ basedOn: form.snapshot, steps });
}
`;
