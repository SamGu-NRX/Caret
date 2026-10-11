// Which answered frames of a tab the worker keeps (worker.ts walk). A frame is kept only when its document's own origin
// (self.origin, opaque for a sandboxed frame) is the one the worker derived from Chrome's URL for it (W1 review #8), and,
// below the top, when it can be shown to sit in a visible <iframe> of its parent (#5). Chrome gives content scripts no
// frame id for an iframe element (chrome.runtime.getFrameId is undefined there in Chrome 154), so that is argued from
// counts and sizes, and where the argument fails every child of the parent is dropped:
//   - a child whose own viewport is a pixel or less sits in an iframe hidden by display:none or zero size, and is
//     dropped by itself;
//   - every visible iframe holds a child whose viewport is that iframe's content box, so if a parent has no more
//     sized children than visible iframes, every sized child is in a visible one (pigeonhole). If it has more, some
//     sized child is hidden and nothing says which, so all of the parent's children are dropped (review round 3: a
//     decoy iframe sized to vouch for a hidden one);
//   - each kept child must also take a distinct visible iframe whose content box is exactly its viewport (src preferred).
//
// W4: captcha frames. Lever puts two full-size hCaptcha frames in hidden iframes, which made the count fail and dropped
// every child frame, so a real embedded form beside them would have been lost. A frame whose URL is a captcha service's
// is never walked (it is not the page's form, and it is the user's to answer), and it leaves the count, but only as far
// as the proof survives: a captcha frame could itself sit in a visible iframe, so each captcha frame whose viewport fits
// some visible iframe (or whose viewport is unknown) takes one visible iframe out of what the other children may claim.
// So a parent keeps its other sized children only when they number no more than its visible iframes less those captcha
// frames. A visible iframe whose src is a captcha service's is not counted at all. The captcha list decides only which
// frames are dropped; a frame wrongly taken for a captcha is lost to the walk, never kept unproven.

export interface FrameRow {
  frameId: number;
  parentFrameId: number;
  url: string;
}

/** What a frame's own script said about itself that composition reads (FrameReport). */
export interface FrameSelf {
  origin: string;
  /** [innerWidth, innerHeight]: 0 by 0 inside an iframe hidden with display:none. */
  viewport: [number, number];
  /** The frame's visible iframes: src (origin and path) and content box. */
  iframes: { src: string; inner: [number, number] }[];
}

export interface Answered<R extends FrameSelf, F extends FrameRow = FrameRow> {
  f: F;
  r: R;
  /** The origin the worker derived from Chrome's URL for the frame. */
  origin: string;
}

/** A captcha frame: its row, and its viewport when its script answered (null: unknown, so it may fit any iframe). */
export interface CaptchaFrame {
  f: FrameRow;
  viewport: [number, number] | null;
}

const CAPTCHA_HOSTS: readonly (string | RegExp)[] = [
  /(^|\.)hcaptcha\.com$/,
  /(^|\.)arkoselabs\.com$/,
  /(^|\.)funcaptcha\.com$/,
  "challenges.cloudflare.com",
];
/** Google's reCAPTCHA frames live under /recaptcha/ on these hosts. */
const RECAPTCHA_HOSTS = new Set(["www.google.com", "google.com", "www.recaptcha.net", "recaptcha.net", "recaptcha.google.com"]);

/** Whether a URL (or an iframe's src, origin plus path) is a captcha service's frame. */
export function isCaptchaUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.hostname.toLowerCase();
  if (CAPTCHA_HOSTS.some((h) => (typeof h === "string" ? h === host : h.test(host)))) return true;
  return RECAPTCHA_HOSTS.has(host) && u.pathname.startsWith("/recaptcha/");
}

const fits = (a: readonly [number, number], b: readonly [number, number]): boolean => Math.abs(a[0] - b[0]) <= 1 && Math.abs(a[1] - b[1]) <= 1;
const sized = (v: readonly [number, number]): boolean => v[0] > 1 && v[1] > 1;

export function composeFrames<R extends FrameSelf, F extends FrameRow>(
  frames: readonly FrameRow[],
  answered: readonly Answered<R, F>[],
  captchas: readonly CaptchaFrame[] = [],
): { kept: Answered<R, F>[]; missing: { frameId: number; reason: string }[] } {
  const missing: { frameId: number; reason: string }[] = captchas.map((c) => ({ frameId: c.f.frameId, reason: "a captcha frame; Caret never reads one" }));
  const isCaptcha = new Set(captchas.map((c) => c.f.frameId));
  const kept: Answered<R, F>[] = [];
  const used = new Set<string>();
  /** The parent's visible iframes a child may claim: every one whose src is not a captcha service's. */
  const claimable = (parent: Answered<R, F>): { i: FrameSelf["iframes"][number]; key: string }[] =>
    parent.r.iframes.flatMap((i, n) => (isCaptchaUrl(i.src) ? [] : [{ i, key: `${parent.f.frameId}:${n}` }]));
  /** Non-captcha children that may be sized: answered with a viewport over a pixel each way, or not answered at all. */
  const sizedChildren = (parentId: number): number =>
    frames.filter((f) => f.parentFrameId === parentId && !isCaptcha.has(f.frameId)).filter((f) => {
      const a = answered.find((x) => x.f.frameId === f.frameId);
      return a === undefined || sized(a.r.viewport);
    }).length;
  /** Captcha children that could be sitting in one of these iframes. */
  const captchasThatFit = (parentId: number, slots: readonly { i: FrameSelf["iframes"][number] }[]): number =>
    captchas.filter((c) => c.f.parentFrameId === parentId && (c.viewport === null ? slots.length > 0 : sized(c.viewport) && slots.some((s) => fits(s.i.inner, c.viewport as [number, number])))).length;
  const ordered = answered.filter((x) => !isCaptcha.has(x.f.frameId));
  for (const k of ordered.filter((x) => x.f.parentFrameId < 0).concat(ordered.filter((x) => x.f.parentFrameId >= 0))) {
    if (k.r.origin !== k.origin) {
      missing.push({ frameId: k.f.frameId, reason: `its document's origin ${k.r.origin} is not ${k.origin}` });
      continue;
    }
    if (k.f.parentFrameId >= 0) {
      const parent = kept.find((p) => p.f.frameId === k.f.parentFrameId);
      const [vw, vh] = k.r.viewport;
      if (parent === undefined || vw <= 1 || vh <= 1) {
        missing.push({ frameId: k.f.frameId, reason: "its <iframe> is not visible in the parent frame" });
        continue;
      }
      const slots = claimable(parent);
      if (sizedChildren(parent.f.frameId) > slots.length - captchasThatFit(parent.f.frameId, slots)) {
        missing.push({ frameId: k.f.frameId, reason: "its parent holds more frames than visible iframes, so which are seen cannot be told" });
        continue;
      }
      const src = k.f.url.startsWith("about:") ? "about:" : (() => {
        const u = new URL(k.f.url);
        return `${u.origin}${u.pathname}`;
      })();
      const candidates = slots.filter((c) => !used.has(c.key) && fits(c.i.inner, [vw, vh]));
      const pick = candidates.find((c) => c.i.src.startsWith(src)) ?? candidates[0];
      if (pick === undefined) {
        missing.push({ frameId: k.f.frameId, reason: "no visible <iframe> in the parent has its size" });
        continue;
      }
      used.add(pick.key);
    }
    kept.push(k);
  }
  kept.sort((a, b) => a.f.frameId - b.f.frameId);
  missing.sort((a, b) => a.frameId - b.frameId);
  return { kept, missing };
}
