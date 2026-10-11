// H14: a page's file controls as the host's attach rows show them. The walk's accept types reach the screen model's
// node (engines/page-link.ts), and a page segment's view (protocol GoalPageView.files) gives each attach step's row its
// control's name and those types. A control the plan attaches to is not also named as the user's (`attach`). Every
// name and value is invented.
import { afterEach, describe, expect, it } from "vitest";
import { HelperMessage, PROTOCOL_VERSION, type PageControl } from "../src/protocol.ts";
import { EngineSession } from "../src/engines/session.ts";
import { toWindowSnapshot } from "../src/engines/page-link.ts";
import { c } from "./fake-page.ts";
import { closeRigs, rig, type Segment } from "./page-rig.ts";

afterEach(closeRigs);

const CHROME = { pid: 5200, bundleId: "com.google.Chrome", name: "Google Chrome" };

describe("a file control's accepted types in the screen model (H14)", () => {
  it("copies the walk's accept list to the file control's node, and gives none to a control without one", () => {
    const session = new EngineSession({ engine: "eng1", browser: CHROME, extensionId: "kcmlnoabcdefghijklmnopabcdefghij", bridgeVersion: "0", connectedAt: 0 }, () => true);
    const s = toWindowSnapshot(
      {
        type: "pageSnapshot", v: PROTOCOL_VERSION, id: "w1", at: 1000, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Apply",
        frames: [{
          frameId: 0, parentFrameId: -1, documentId: "D0", origin: "https://jobs.example-ats.test", path: "/larkspur/apply", navGen: 1, title: "Apply", headings: [], iframes: [], excluded: {}, truncated: false,
          controls: [
            { id: "e1", key: "form/button:resume~0", strongKey: null, kind: "file", role: "button", name: "Resume", form: null, rect: [0, 0, 100, 20], accept: [".pdf", ".doc", ".docx"] },
            { id: "e2", key: "form/button:drop~0", strongKey: null, kind: "file", role: "button", name: "Drop a cover letter", form: null, rect: [0, 30, 100, 20] },
          ],
        }],
        focused: null, missing: [],
      } as never,
      session,
      1,
    );
    expect(s.nodes.find((n) => n.label === "Resume")?.accept).toEqual([".pdf", ".doc", ".docx"]);
    expect(s.nodes.find((n) => n.label === "Drop a cover letter")).not.toHaveProperty("accept");
  });
});

/** A documents page: a name, a file input that takes PDF and Word files, a dropzone's hidden input, and Submit. */
function documents(): PageControl[] {
  return [
    c("r0", "text", "Full name", { value: "" }),
    c("r1", "file", "Resume", { accept: [".pdf", ".doc", ".docx"] }),
    c("r2", "file", "Or drop your cover letter here"),
    c("r3", "button", "Submit application"),
  ];
}

describe("attach rows in a page segment's view (H14)", () => {
  it("gives each attach step's row its control's name and types, and names no control the plan attaches to as the user's", async () => {
    const r = await rig({ goalFiles: true, controls: documents, title: "Apply: step 3" });
    const s = (await r.ask("fill out this form from my note")) as Segment;
    const steps = s.steps.filter((x) => x.kind === "attach").map((x) => x.index);
    expect(steps).toHaveLength(2);
    expect(s.page?.files).toEqual([
      { step: steps[0], label: "Resume", accept: [".pdf", ".doc", ".docx"] },
      { step: steps[1], label: "Or drop your cover letter here", accept: [] },
    ]);
    expect(s.page?.attach).toEqual([]);
    expect(HelperMessage.parse(s)).toEqual(s);
  });

  it("has no attach rows for a host that cannot show them, and names the file controls as the user's as before", async () => {
    const r = await rig({ controls: documents, title: "Apply: step 3" });
    const s = (await r.ask("fill out this form from my note")) as Segment;
    expect(s.steps.some((x) => x.kind === "attach")).toBe(false);
    expect(s.page).not.toHaveProperty("files");
    expect(s.page?.attach).toEqual(["Resume", "Or drop your cover letter here"]);
  });
});
