// Ten synthetic goals with frozen snapshots for measuring plan writers (scripts/writer-eval.ts). Every
// name, address and number is invented. `expected` is what a correct plan does; waitFor steps are not
// scored. `choose` is the answer a deterministic stand-in for Jev gives, so the run measures the writer.
import type { PlanningSnapshot } from "../../src/codemode/types.ts";
import { FORM, MAIL } from "./fixtures.ts";

export interface WriterCase {
  id: string;
  goal: string;
  snapshots: PlanningSnapshot[];
  choose: string | null;
  expected: { fills: [string, string][]; presses: [string, string][]; asks: string[] };
}

type Target = PlanningSnapshot["targets"][number];
const field = (ref: string, label: string): Target => ({ ref, label, kind: "textField", canFill: true, options: [], allowedPressEffects: [] });
const button = (ref: string, label: string, effect: string): Target => ({ ref, label, kind: "button", canFill: false, options: [], allowedPressEffects: [effect] });
const val = (snapshot: string, ref: string, display: string, at = 0) => ({ ref, display, origin: { kind: "span" as const, snapshot, source: "body", startUTF16: at, endUTF16: at + display.length, digest: `d${at}` } });
const mem = (ref: string, display: string) => ({ ref, display, origin: { kind: "memory" as const, entryId: `m-${ref}`, fileRevision: "rev1", digest: `m${display.length}` } });
const win = (id: string, title: string, targets: Target[], values: PlanningSnapshot["values"] = [], questions: PlanningSnapshot["questions"] = []): PlanningSnapshot => ({
  snapshot: `snap:${id}`,
  window: `win:${id}`,
  revision: "r1",
  title,
  targets,
  values,
  questions,
});

export const WRITER_CORPUS: WriterCase[] = [
  {
    id: "workshop-signup",
    goal: "Fill in the workshop signup from the email and go on to the next page.",
    snapshots: [FORM, MAIL],
    choose: "o:wed",
    expected: { fills: [["t:name", "v:name"], ["t:email", "v:email"], ["t:session", "v:wed"]], presses: [["t:next", "e:next-page"]], asks: [] },
  },
  {
    id: "shipping-address",
    goal: "Fill in the shipping address from my order confirmation.",
    snapshots: [
      win("ship", "Checkout - Shipping", [field("a:name", "Recipient"), field("a:street", "Street address"), field("a:city", "City"), field("a:zip", "ZIP code"), button("a:cont", "Continue to payment", "e:payment")]),
      win("order", "Order #48213 confirmed", [], [val("snap:order", "ov:name", "Jordan Okafor", 5), val("snap:order", "ov:street", "1180 Alder Lane", 40), val("snap:order", "ov:city", "Portland", 60), val("snap:order", "ov:zip", "97214", 70), val("snap:order", "ov:total", "$64.20", 90)]),
    ],
    choose: null,
    expected: { fills: [["a:name", "ov:name"], ["a:street", "ov:street"], ["a:city", "ov:city"], ["a:zip", "ov:zip"]], presses: [], asks: [] },
  },
  {
    id: "contact-from-memory",
    goal: "Put my name and email into this contact form.",
    snapshots: [win("contact", "Contact us", [field("c:name", "Your name"), field("c:email", "Email address"), field("c:msg", "Message"), button("c:send", "Send", "e:send")], [mem("cm:name", "Sam Lee"), mem("cm:email", "sam.lee@example.org")])],
    choose: null,
    expected: { fills: [["c:name", "cm:name"], ["c:email", "cm:email"]], presses: [], asks: [] },
  },
  {
    id: "event-date-choice",
    goal: "Create the event for the meeting the thread settled on.",
    snapshots: [
      win("event", "New event", [field("ev:title", "Title"), field("ev:when", "Date and time"), button("ev:save", "Save", "e:save-event")], [], [
        { ref: "eq:when", text: "Which meeting time did the thread settle on?", options: [{ ref: "eo:mon", label: "Mon Nov 2, 9:30 AM" }, { ref: "eo:thu", label: "Thu Nov 5, 2:00 PM" }] },
      ]),
      win("thread", "Re: planning sync", [], [val("snap:thread", "tv:title", "Planning sync", 3), val("snap:thread", "tv:mon", "Mon Nov 2, 9:30 AM", 30), val("snap:thread", "tv:thu", "Thu Nov 5, 2:00 PM", 70)]),
    ],
    choose: "eo:thu",
    // "Create the event" asks for Save. Run 1 (2026-10-04) scored this without the press, which was wrong.
    expected: { fills: [["ev:title", "tv:title"], ["ev:when", "tv:thu"]], presses: [["ev:save", "e:save-event"]], asks: [] },
  },
  {
    id: "expense-receipt",
    goal: "Fill the expense report from the receipt.",
    snapshots: [
      win("expense", "Expense report", [field("x:merchant", "Merchant"), field("x:amount", "Amount"), field("x:date", "Date"), field("x:note", "Business purpose")]),
      win("receipt", "Receipt.pdf", [], [val("snap:receipt", "rv:merchant", "Bluebird Cafe", 0), val("snap:receipt", "rv:amount", "23.40", 30), val("snap:receipt", "rv:date", "2026-09-28", 50)]),
    ],
    choose: null,
    expected: { fills: [["x:merchant", "rv:merchant"], ["x:amount", "rv:amount"], ["x:date", "rv:date"]], presses: [], asks: [] },
  },
  {
    id: "newsletter-subscribe",
    goal: "Subscribe me to this newsletter.",
    snapshots: [win("news", "The Weekly Field Notes", [field("n:email", "Email"), button("n:sub", "Subscribe", "e:subscribe")], [mem("nm:email", "sam.lee@example.org")])],
    choose: null,
    expected: { fills: [["n:email", "nm:email"]], presses: [["n:sub", "e:subscribe"]], asks: [] },
  },
  {
    id: "missing-phone",
    goal: "Fill in my contact details for the delivery.",
    snapshots: [
      win("delivery", "Delivery details", [field("d:name", "Name"), field("d:phone", "Phone number")], [mem("dm:name", "Sam Lee")], [
        { ref: "dq:phone", text: "What phone number should the courier use?", options: [{ ref: "do:skip", label: "Leave it blank" }] },
      ]),
    ],
    choose: null,
    expected: { fills: [["d:name", "dm:name"]], presses: [], asks: ["dq:phone"] },
  },
  {
    id: "search-and-wait",
    goal: "Search the library catalog for the book title from my note.",
    snapshots: [
      win("catalog", "City Library Catalog", [field("s:query", "Search"), button("s:go", "Search", "e:results")]),
      win("note", "Reading list", [], [val("snap:note", "sv:book", "The Quiet Harbor", 4), val("snap:note", "sv:author", "M. Ellery", 24)]),
    ],
    choose: null,
    expected: { fills: [["s:query", "sv:book"]], presses: [["s:go", "e:results"]], asks: [] },
  },
  {
    id: "preferred-name",
    goal: "Update the display name to my preferred name.",
    snapshots: [win("profile", "Profile settings", [field("p:display", "Display name"), field("p:legal", "Legal name"), field("p:pronouns", "Pronouns")], [mem("pm:preferred", "Sam"), mem("pm:legal", "Samuel Lee")])],
    choose: null,
    expected: { fills: [["p:display", "pm:preferred"]], presses: [], asks: [] },
  },
  {
    id: "rsvp-yes",
    goal: "Tell them I'm coming to the dinner.",
    snapshots: [win("rsvp", "Dinner RSVP", [button("r:yes", "Yes, I'll attend", "e:rsvp-yes"), button("r:no", "No, can't make it", "e:rsvp-no"), field("r:note", "Note to host")])],
    choose: null,
    expected: { fills: [], presses: [["r:yes", "e:rsvp-yes"]], asks: [] },
  },
];
