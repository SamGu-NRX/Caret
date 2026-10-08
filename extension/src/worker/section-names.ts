// SCP1: section name tokens for one tab snapshot. A frame says nothing about another frame's sections, and an excluded
// section's name never leaves its frame, so per-frame checks missed a kept "Equipment details" in the top frame that a
// self-identification fieldset in a child frame also has. Here, where the frames are composed into one snapshot, every
// section name gets a token: HMAC-SHA256 over the frame's digest of the name (content/sections.ts), keyed by a salt
// made fresh for each snapshot, held only here and never sent. The helper compares tokens for equality across the
// window: a name two occurrences share, excluded or past a frame's cap or not, is two sections, and it withholds.
// Without the salt a token says nothing about the name.
import type { FrameReport } from "../shared/messages.ts";

/** A frame report's section occurrences with tokens in place of digests, and the tokens of names past its cap. */
export interface FrameSections {
  sections: { id: string; heading: boolean; text?: string; name?: string }[];
  sectionNames: string[];
  sectionsCut: boolean;
}

const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Each report's sections with a token per name, keyed by a salt made here and dropped when this returns. */
export async function sectionTokens(reports: readonly Pick<FrameReport, "sections" | "sectionOverflow" | "sectionsCut">[]): Promise<FrameSections[]> {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const token = async (digest: string): Promise<string> => hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(digest)));
  return Promise.all(
    reports.map(async (r) => ({
      sections: await Promise.all((r.sections ?? []).map(async ({ digest, ...o }) => (digest === undefined ? o : { ...o, name: await token(digest) }))),
      sectionNames: await Promise.all((r.sectionOverflow ?? []).map(token)),
      sectionsCut: r.sectionsCut === true,
    })),
  );
}
