// P5 - Ownership properties (G3): the page's values reach the page only through fill's ownership stage
// (helper/src/fill/fill.ts:2094-2170, eitherChoice/theUsers/otherPerson; WHOSE_CUTOFF = 0.5, fill.ts:121).
//
// The desk is the G2 harness (test/g2-ownership.test.ts): a page form driven through proposeFill with a
// scripted Jev that answers each question by rule and records every request. `whose` answers here sweep the
// two asks; the owner answers sweep both asks' whose-value questions. Values are synthetic people.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../../src/model.ts";
import { proposeFill } from "../../src/fill/fill.ts";
import { writtenFields } from "../../src/offers/fill-popup.ts";
import type { AboutValue } from "../../src/fill/about.ts";
import { aboutKind } from "../../src/fill/about.ts";
import type { AskJev, JevRequest } from "../../src/fill/jev.ts";
import { toWindowSnapshot } from "../../src/engines/page-link.ts";
import { EngineSession } from "../../src/engines/session.ts";
import { optionIs } from "../builders.ts";
import { onWire } from "../page-wire.ts";
import { PROTOCOL_VERSION, type PageControl, type PageSnapshot, type Snapshot } from "../../src/protocol.ts";
import { arbUserAndDecoy, runs } from "./gens.ts";

const chrome = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
const session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: "kcmlnoabcdefghijklmnopabcdefghij", bridgeVersion: "0", connectedAt: 0 }, () => true);
const WIN = "page:eng1:7";
const control = (id: string, name: string): PageControl => onWire({ id, key: `form[apply]/${"text"}:${name.toLowerCase()}~0`, strongKey: null, kind: "text", role: "text", name, form: "form#apply", rect: [0, Number(id.slice(1)) * 30, 100, 20], value: "" });
const keyOf = (c: PageControl): string => `f0/${c.key}`;

/** g2's noteWindow, focused before the form: the window the user just left. */
const noteWindow = (content: string): Snapshot => ({
  type: "snapshot", v: PROTOCOL_VERSION, seq: 1, at: 900, reason: "initial", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" },
  window: { windowId: "w4-note", kind: "standard", title: "Application details.txt", frame: [0, 0, 700, 500] }, focused: true, root: null,
  nodes: [{ key: "com.apple.TextEdit/standard/textarea:~0", parent: null, role: "AXTextArea", value: content, editable: true }], values: [], focusedKey: null, stats: { walkMs: 0, visited: 1, truncated: false },
});

function desk(page: PageControl[], sources: Snapshot[]): ScreenModel {
  const snap: PageSnapshot = {
    type: "pageSnapshot", v: PROTOCOL_VERSION, id: "w1", at: 1000, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Apply",
    frames: [{ frameId: 0, parentFrameId: -1, documentId: "D0", origin: "http://127.0.0.1:4310", path: "/apply", navGen: 1, title: "Apply", headings: ["Apply"], iframes: [], excluded: {}, truncated: false, controls: page }],
    missing: [], focused: { frameId: 0, id: page[0]?.id ?? "e1", selection: [0, 0] },
  };
  const m = new ScreenModel();
  for (const s of sources) m.apply(s);
  m.apply(toWindowSnapshot(snap, session, 1));
  return m;
}

type Answer = { choice: string; confidence: number };
/**
 * g2's scripted Jev with both stages swept: `pick` names the value a field takes by its label, `owner`
 * answers a whose-value question by the value's text and the ask (0 or 1), `whose` answers a
 * whose-details question by the ask. Records every request.
 */
function scripted(pick: Record<string, string>, owner: (text: string, ask: number) => Answer, whose: (ask: number) => Answer): { ask: AskJev; requests: JevRequest[] } {
  const requests: JevRequest[] = [];
  let n = 0;
  const ask: AskJev = async (req) => {
    requests.push(req);
    const which = n++ % 2;
    const answers: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      const ins = String(q.instructions);
      if (id.endsWith("_whose")) answers[id] = whose(which);
      else if (id.endsWith("_owner")) answers[id] = owner(/"(.*?)" \(/su.exec(ins)?.[1] ?? "", which);
      else {
        const label = /Label: '(.+?)'\./u.exec(ins)?.[1];
        const want = label === undefined ? undefined : pick[label];
        const hit = want === undefined ? undefined : Object.entries(q.criteria).find(([, d]) => optionIs(d, want))?.[0];
        answers[id] = { choice: hit ?? "none", confidence: 0.95 };
      }
    }
    return { model: "scripted", answers, inputTokens: 0, latencyMs: 0, costUsd: 0 };
  };
  return { ask, requests };
}
const ownerQuestions = (requests: JevRequest[]): string[] => requests.flatMap((r) => Object.entries(r.questions).filter(([id]) => id.endsWith("_owner")).map(([, q]) => String(q.instructions)));
const ownerQuestionOf = (requests: JevRequest[], text: string): string | undefined => ownerQuestions(requests).find((q) => q.includes(`"${text}" (`));
const written = (p: Awaited<ReturnType<typeof proposeFill>>, key: string): string | null => writtenFields(p).fields.find((f) => f.key === key)?.value ?? null;

const email = control("e1", "Email");
/** An owner answer at one of the two confidence levels the sweep needs (WHOSE_CUTOFF = 0.5). */
const OWNER = ["user", "other", "unclear"].flatMap((choice) => [0.9, 0.3].map((confidence) => ({ choice, confidence })));

describe("someone else's value is withheld unless both asks call it the user's at the cutoff (fill.ts:2094-2170)", () => {
  it("a decoy in the note is written only when both asks say the user's at >= 0.5; the user sees the proposal either way", async () => {
    fc.assert(
      fc.asyncProperty(arbUserAndDecoy, fc.constantFrom(...OWNER), fc.constantFrom(...OWNER), async ([, decoy], c0, c1) => {
        const note = `Email: ${decoy.email}\nName: ${decoy.name}\nMobile phone: ${decoy.phone}`;
        const { ask } = scripted({ Email: decoy.email }, (_text, a) => (a === 0 ? c0 : c1), () => ({ choice: "user", confidence: 0.95 }));
        const p = await proposeFill(desk([email], [noteWindow(note)]), ask, WIN, keyOf(email), 2000, { about: [] });
        const decided = written(p, keyOf(email));
        if (c0.choice === "user" && c0.confidence >= 0.5 && c1.choice === "user" && c1.confidence >= 0.5) expect(decided).toBe(decoy.email);
        else expect(decided, `${c0.choice}@${c0.confidence}/${c1.choice}@${c1.confidence}`).not.toBe(decoy.email);
      }),
      runs(40),
    );
  });

  it("one ask saying someone else's withholds it even though the owner says the user's (the b-032 mirror)", async () => {
    fc.assert(
      fc.asyncProperty(arbUserAndDecoy, fc.constantFrom(...OWNER), fc.constantFrom(...OWNER), async ([user], w0, w1) => {
        const { ask } = scripted({ Email: user.email }, () => ({ choice: "user", confidence: 0.95 }), (a) => (a === 0 ? w0 : w1));
        const p = await proposeFill(desk([email], [noteWindow(`Email: ${user.email}`)]), ask, WIN, keyOf(email), 2000, { about: [] });
        const decided = written(p, keyOf(email));
        // The owner says the user's, so the value stands unless a whose-details ask says someone else's.
        if (w0.choice === "other" || w1.choice === "other") expect(decided).not.toBe(user.email);
        else expect(decided).toBe(user.email);
      }),
      runs(40),
    );
  });

  it("the user's own value is decided by code, not the owner: a case-spelling of the address in memory is written and never asked about", async () => {
    fc.assert(
      fc.asyncProperty(arbUserAndDecoy, async ([user]) => {
        const variant = user.email.toUpperCase();
        const about: AboutValue[] = [];
        const kind = aboutKind("primary email", user.email);
        if (kind !== null) about.push({ id: "about-1", label: "primary email", value: user.email, kind });
        const { ask, requests } = scripted({ Email: variant }, () => ({ choice: "other", confidence: 0.9 }), () => ({ choice: "user", confidence: 0.95 }));
        const p = await proposeFill(desk([email], [noteWindow(`Email: ${variant}`)]), ask, WIN, keyOf(email), 2000, { about });
        expect(written(p, keyOf(email))).toBe(variant);
        expect(ownerQuestionOf(requests, variant)).toBeUndefined();
      }),
      runs(30),
    );
  });
});
