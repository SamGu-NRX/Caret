import type { Node } from "../protocol.ts";
import { DATE_FORMAT, fieldKinds } from "./kinds.ts";
import { readMonth, type Reading } from "./when.ts";
import { sourceURL } from "./line-values.ts";

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
  if (/^https?:\/\//iu.test(text)) return null;
  // A reader span must be the entire link text of a source token, not a suffix inside a host, query or fragment.
  const token = sourceURL(sourceText, text);
  if (token === null) return null;
  // WHATWG parsing applies IDNA before this comparison. A visually similar host is not the known site.
  const { parsed } = token;
  if (parsed.hostname !== "github.com" || parsed.username !== "" || parsed.password !== "" || parsed.port !== "" || parsed.pathname === "/") return null;
  const value = `https://${token.text}`;
  return { value, display: value, sourceToken: token.original, assumptions: [`the source's address "${token.original}" written as a full web address with https:// added; Caret chose HTTPS for the known site github.com${token.original === token.text ? "" : "; trailing punctuation excluded by GFM extended-autolink path validation"}`] };
}
