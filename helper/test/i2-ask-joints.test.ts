// I2: where A3's scope ask (planner/intent-heads.ts) meets G2's disclosure rule and W1's canned dispatch. A3 added a
// request that quotes each field's label, heading, group and neighbours; G2's rule is that screen text holding a secret
// marker word is sent as what it is, never as its words (privacy.ts sendable), and assertNoSecrets stops any request
// that still carries one. W1's canned engines answer by each request's purpose, so the new request must name one.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setGeneratorClock } from "../src/fill/candidates.ts";
import { assertNoSecrets } from "../src/privacy.ts";
import { secretText } from "../src/memory/sensitive.ts";
import { questionKind } from "../src/engines/decide/canned.ts";
import { intentSnapshot } from "../src/planner/intent.ts";
import { headsRequest, scopeId, scopeRequest } from "../src/planner/intent-heads.ts";
import { ScreenModel } from "../src/model.ts";
import { field, node, snap } from "./builders.ts";

beforeEach(() => setGeneratorClock(() => 0));
afterEach(() => setGeneratorClock(null));

const SECRET_LABEL = "Password hint";
const SECRET_HEADING = "Account PIN";

function form() {
  const m = new ScreenModel();
  m.apply(
    snap(
      [
        node("pg/h", "AXHeading", { label: SECRET_HEADING }),
        field("pg/email", "", { label: "Email" }),
        field("pg/hint", "", { label: SECRET_LABEL }),
        field("pg/name", "", { label: "Full name" }),
      ],
      { at: 1000, windowId: "page:i2:1", kind: "page", focused: true, title: "Sign up" },
    ),
  );
  const w = m.windows.get("page:i2:1");
  if (w === undefined) throw new Error("no page");
  return intentSnapshot("put my name and email in", m, w, []);
}

describe("A3's scope ask under G2's disclosure rule", () => {
  it("the fixture's label and heading are ones G2 calls secret", () => {
    expect(secretText(SECRET_LABEL)).toBe(true);
    expect(secretText(SECRET_HEADING)).toBe(true);
  });

  it("sends neither a secret label nor a secret heading, as a field's own text or as a neighbour's, in either wording", () => {
    const s = form();
    expect(s.fields.map((f) => f.name)).toContain(SECRET_LABEL);
    for (const w of [0, 1] as const) {
      const req = scopeRequest(s, w);
      const sent = JSON.stringify([req.state, req.questions]);
      expect(sent, `wording ${w}`).not.toContain(SECRET_LABEL);
      expect(sent, `wording ${w}`).not.toContain(SECRET_HEADING);
      expect(() => assertNoSecrets(req)).not.toThrow();
      // The field is still asked about, named as what it is.
      const hint = s.fields.find((f) => f.name === SECRET_LABEL);
      expect(String(req.questions[scopeId(hint?.ref ?? "")]?.instructions)).toContain("a field Caret leaves to the user");
      // Its neighbour names it the same way.
      const name = s.fields.find((f) => f.name === "Full name");
      expect(String(req.questions[scopeId(name?.ref ?? "")]?.instructions)).toContain("'a field Caret leaves to the user'");
    }
  });

  it("the heads request passes assertNoSecrets with its refuse wording, which names kinds of secret", () => {
    const req = headsRequest(form());
    expect(Object.values(req.questions.route?.criteria ?? {}).some((t) => secretText(t))).toBe(true);
    expect(() => assertNoSecrets(req)).not.toThrow();
    expect(JSON.stringify(req.state)).not.toContain(SECRET_LABEL);
  });

  it("names a purpose on both requests, and every id they ask has a canned kind", () => {
    const s = form();
    const heads = headsRequest(s);
    const scopes = [scopeRequest(s, 0), scopeRequest(s, 1)];
    expect(heads.purpose).toBe("ask.heads");
    for (const r of scopes) expect(r.purpose).toBe("ask.scope");
    expect(Object.keys(heads.questions).map((id) => questionKind(heads, id)).sort()).toEqual(["ask.heads:route", "ask.heads:source", "ask.heads:whose", "ask.heads:why"]);
    for (const r of scopes) for (const id of Object.keys(r.questions)) expect(questionKind(r, id)).toBe("ask.scope:field");
  });
});
