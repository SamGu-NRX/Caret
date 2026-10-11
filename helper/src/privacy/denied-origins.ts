// The web half of the deny list, applied again where page content enters the helper (engines/session.ts), so a page
// on it never reaches the screen model or a request even from an extension that walked it. A copy of the extension's
// list (extension/src/worker/left-tab.ts DENIED_HOSTS); test/denied-origins.test.ts fails when the two differ.

/** Password managers, the system's password store and account pages: Caret reads nothing from them. */
export const DENIED_HOSTS: readonly RegExp[] = [
  /(^|\.)1password\.(com|eu|ca)$/,
  /(^|\.)bitwarden\.(com|eu)$/,
  /(^|\.)lastpass\.com$/,
  /(^|\.)dashlane\.com$/,
  /(^|\.)keepersecurity\.(com|eu)$/,
  /(^|\.)nordpass\.com$/,
  /^pass\.proton\.me$/,
  /^account\.proton\.me$/,
  /(^|\.)enpass\.io$/,
  /^passwords\.google\.com$/,
  /^accounts\.google\.com$/,
  /^myaccount\.google\.com$/,
  /^appleid\.apple\.com$/,
  /^account\.apple\.com$/,
];

/**
 * The one form every "Not on this site" comparison uses, for the origins the user switched off and the ones a frame
 * has: the URL parser's origin (lower case, default port dropped) without the host's trailing dot. The extension's
 * worker uses the same function (extension/src/worker/left-tab.ts canonicalOrigin); test/denied-origins.test.ts checks
 * the two agree.
 */
export function canonicalOrigin(origin: string): string {
  let o: string;
  try {
    o = new URL(origin).origin;
  } catch {
    o = origin.trim().toLowerCase();
  }
  return o.replace(/\.(?=(:\d+)?$)/u, "");
}

/** Whether an origin is one Caret never reads. Anything that is not an http(s) origin is denied, as in the extension. */
export function deniedOrigin(origin: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return true;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return true;
  // "accounts.google.com." is the same host as "accounts.google.com": a fully qualified name's trailing dot goes.
  const host = u.hostname.toLowerCase().replace(/\.$/u, "");
  return DENIED_HOSTS.some((h) => h.test(host));
}
