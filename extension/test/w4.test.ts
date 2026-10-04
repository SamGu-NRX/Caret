// W4's pure pieces: which frames a walk keeps when captcha frames sit beside a page's own (Lever's hidden full-size
// hCaptcha frames). The DOM halves run in a real browser in fixtures/web-form/accept.ts.
import { describe, expect, it } from "vitest";
import { composeFrames, isCaptchaUrl, type Answered, type CaptchaFrame, type FrameRow, type FrameSelf } from "../src/worker/compose.ts";

const LEVER = "https://jobs.lever.co";
const HC = "https://newassets.hcaptcha.com/captcha/v1/0521/static/hcaptcha-enclave.html";
const EMBED = "https://boards.example.test/embed/job_app";

const row = (frameId: number, parentFrameId: number, url: string): FrameRow => ({ frameId, parentFrameId, url });
const self = (origin: string, viewport: [number, number], iframes: FrameSelf["iframes"] = []): FrameSelf => ({ origin, viewport, iframes });
/** The worker's origin for a frame: its URL's, or for about:blank its parent's (frames.ts frameOrigin); here, Lever's. */
const answer = (f: FrameRow, r: FrameSelf): Answered<FrameSelf> => ({ f, r, origin: f.url.startsWith("about:") ? LEVER : new URL(f.url).origin });

describe("captcha frames (W4, Lever)", () => {
  // Lever's apply page as W3 walked it: two hCaptcha enclaves in hidden iframes the size of the page, a 1 px iframe,
  // and no visible iframe. Here a visible 600 by 400 iframe holding an embedded form is added beside them.
  const top = row(0, -1, `${LEVER}/palantir/x/apply`);
  const hc1 = row(22, 0, HC);
  const hc2 = row(23, 0, HC);
  const pixel = row(21, 0, "about:blank");
  const form = row(30, 0, EMBED);
  const frames = [top, pixel, hc1, hc2, form];
  const captchas: CaptchaFrame[] = [
    { f: hc1, viewport: [1265, 1457] },
    { f: hc2, viewport: [1265, 1457] },
  ];
  const topSelf = self(LEVER, [1280, 1600], [{ src: EMBED, inner: [600, 400] }]);

  it("keeps a visible embedded form beside hidden full-size captcha frames, and never walks the captchas", () => {
    const { kept, missing } = composeFrames(frames, [answer(top, topSelf), answer(pixel, self(LEVER, [1, 1])), answer(form, self("https://boards.example.test", [600, 400]))], captchas);
    expect(kept.map((k) => k.f.frameId)).toEqual([0, 30]);
    expect(missing.filter((m) => m.reason.includes("captcha")).map((m) => m.frameId)).toEqual([22, 23]);
    expect(missing.find((m) => m.frameId === 21)?.reason).toContain("not visible");
  });

  it("drops every other child when the captchas are counted as ordinary frames, which is what W3 did", () => {
    const asPlain = [answer(top, topSelf), answer(pixel, self(LEVER, [1, 1])), answer(form, self("https://boards.example.test", [600, 400])), answer(hc1, self("https://newassets.hcaptcha.com", [1265, 1457])), answer(hc2, self("https://newassets.hcaptcha.com", [1265, 1457]))];
    const { kept } = composeFrames(frames, asPlain, []);
    expect(kept.map((k) => k.f.frameId)).toEqual([0]);
  });

  it("does not let a captcha in a visible iframe vouch for a hidden frame of the same size", () => {
    // The page shows a 300 by 150 iframe holding a real captcha, and hides another of the same size holding a form.
    const shown = row(40, 0, "https://www.google.com/recaptcha/api2/anchor");
    const hidden = row(41, 0, "https://evil.example.test/form");
    const parent = self(LEVER, [1280, 1600], [{ src: "https://evil.example.test/frame", inner: [300, 150] }]);
    const { kept, missing } = composeFrames([top, shown, hidden], [answer(top, parent), answer(hidden, self("https://evil.example.test", [300, 150]))], [{ f: shown, viewport: [300, 150] }]);
    expect(kept.map((k) => k.f.frameId)).toEqual([0]);
    expect(missing.find((m) => m.frameId === 41)?.reason).toContain("more frames than visible iframes");
  });

  it("counts a captcha frame whose viewport is unknown as one that may fill any visible iframe", () => {
    const { kept } = composeFrames(frames, [answer(top, topSelf), answer(form, self("https://boards.example.test", [600, 400]))], [{ f: hc1, viewport: null }]);
    expect(kept.map((k) => k.f.frameId)).toEqual([0]);
  });

  it("does not count a visible iframe whose src is a captcha's as one a form may claim", () => {
    const parent = self(LEVER, [1280, 1600], [{ src: "https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html", inner: [600, 400] }]);
    const { kept } = composeFrames([top, form], [answer(top, parent), answer(form, self("https://boards.example.test", [600, 400]))], []);
    expect(kept.map((k) => k.f.frameId)).toEqual([0]);
  });

  it("still drops both children when two sized frames share one visible iframe and neither is a captcha (the decoy)", () => {
    const a = row(50, 0, "https://a.example.test/f");
    const b = row(51, 0, "https://b.example.test/f");
    const parent = self(LEVER, [1280, 1600], [{ src: "https://a.example.test/f", inner: [300, 150] }]);
    const { kept } = composeFrames([top, a, b], [answer(top, parent), answer(a, self("https://a.example.test", [300, 150])), answer(b, self("https://b.example.test", [300, 150]))], []);
    expect(kept.map((k) => k.f.frameId)).toEqual([0]);
  });

  it("knows the captcha services by URL, reCAPTCHA only under /recaptcha/", () => {
    for (const u of [HC, "https://hcaptcha.com/x", "https://www.google.com/recaptcha/api2/anchor", "https://www.recaptcha.net/recaptcha/enterprise/anchor", "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x", "https://client-api.arkoselabs.com/fc/gc/"]) expect(isCaptchaUrl(u), u).toBe(true);
    for (const u of ["https://www.google.com/maps/embed", "https://jobs.lever.co/apply", "https://hcaptcha.com.evil.test/x", "https://nothcaptcha.com/x", "about:blank", "not a url"]) expect(isCaptchaUrl(u), u).toBe(false);
  });
});
