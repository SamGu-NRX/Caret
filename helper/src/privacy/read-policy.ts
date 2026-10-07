// SC1 2a: the apps and sites the user switched off never enter the screen model. The reader already skips an app on its
// deny list (apps/screen-reader ScreenReader.swift DenyList) and the page engine every frame at a site the user turned
// Caret off for (pageSitesOff); the helper checks both again, so the property holds whatever sends it a snapshot.
import { readFileSync } from "node:fs";

/** The reader's default deny list (ScreenReader.swift DenyList.defaults), word for word; test/sc1-exclusions.test.ts compares them. */
export const DEFAULT_APPS_OFF: readonly string[] = [
  "com.apple.keychainaccess", "com.apple.Passwords", "com.bitwarden.desktop", "com.1password", "com.agilebits",
  "com.lastpass", "com.dashlane", "com.callpod.keeper", "org.keepassxc", "me.proton.pass", "ch.protonmail.pass",
  "in.sinew.Enpass", "com.nordsec.nordpass", "com.apple.systempreferences.passwords",
];

/** Whether a bundle identifier is on the list, as the reader decides it: the identifier itself or one under it. */
export function appOff(bundleId: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => bundleId === p || bundleId.startsWith(`${p}.`));
}

/**
 * The deny list file the reader reads (one bundle identifier prefix per line, "#" starts a comment), or null when there
 * is none: the reader creates it with the defaults on its first start, and the helper never writes it.
 */
export function readAppsOff(path: string): string[] | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  return text.split(/\r?\n/u).map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
}
