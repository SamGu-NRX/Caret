import type { Node } from "../protocol.ts";
import { DATE_FORMAT, fieldKinds } from "./kinds.ts";
import { readMonth, type Reading } from "./when.ts";
import { autolinkText, rawURLToken } from "./line-values.ts";

/** Strip one complete wrapper, never an interior bracket or a prefix of the source token. */
function profileText(raw: string): string {
  const trimmed = autolinkText(raw);
  const target = /^\[[^\[\]\s]+\]\(([^()\s]+)\)$/u.exec(trimmed)?.[1];
  if (target !== undefined) return autolinkText(target);
  const pairs: Readonly<Record<string, string>> = { "(": ")", "<": ">", "[": "]", '"': '"', "'": "'" };
  return autolinkText(pairs[trimmed[0] ?? ""] === trimmed.at(-1) ? trimmed.slice(1, -1) : trimmed);
}

/** F1: format only facts the existing month reader knows or a GitHub host and path the source spells out. */
export function formatForField(text: string, labelWords: readonly (string | null)[], inputKind: Node["inputKind"], sourceText: string): (Reading & { sourceToken?: string }) | null {
  const format = DATE_FORMAT.exec(labelWords.filter((s) => s !== null).join(" "))?.[0].replace(/\s+/gu, "").toUpperCase();
  if (format === "MM/YYYY") {
    const month = readMonth(text);
    // A short year uses readMonth's century window. That is not a known year and must not become a field-format value.
    if (month === null || month.assumptions.length !== 0) return null;
    const value = `${month.value.slice(5, 7)}/${month.value.slice(0, 4)}`;
    return value === text ? null : { value, display: value, assumptions: [`the source's month and year "${text}" written as ${value}, the format the field asks for`] };
  }
  // Only the known host and an explicit path qualify, never a username, another host, or a field that asks for plain text.
  if (inputKind !== "url" && !fieldKinds(labelWords).has("url")) return null;
  const raw = rawURLToken(sourceText, text);
  if (raw === null) return null;
  const profile = profileText(raw);
  // The approved F1 shape is one GitHub username: alphanumerics and single interior hyphens, at most 39 characters.
  // Match the whole raw token after documented punctuation/wrapper removal, not a URL substring the extractor found.
  const match = /^(?:https:\/\/)?github\.com\/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\/?$/u.exec(profile);
  if (match === null || match[1]!.length > 39) return null;
  const value = profile.startsWith("https://") ? profile : `https://${profile}`;
  if (value === text) return null;
  const addedScheme = !profile.startsWith("https://");
  return { value, display: value, sourceToken: raw, assumptions: [`the source's address "${raw}" written as "${value}"${addedScheme ? "; Caret chose HTTPS for the known site github.com" : "; retaining the source's HTTPS scheme"}${raw === profile ? "" : "; GFM trailing punctuation and one matched wrapper or markdown target excluded"}`] };
}
