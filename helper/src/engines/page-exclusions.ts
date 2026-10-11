// SCP1: the page walk's self-identification exclusion (extension/src/content/walker.ts SELF_IDENTIFICATION), applied
// again where the helper projects a page walk, so a heading or section name it matches never reaches a request even
// from an extension that sent one. The two copies are checked against the same cases
// (fixtures/golden/self-identification.json; extension test/sections.test.ts and helper test/scp1-section-scope.test.ts).

/** Self-identification and consent sections: demographic questions and agreements, the user's to answer. */
export const SELF_IDENTIFICATION = /\b(self[- ]identif\w*|gender|sex|race|racial|ethnicity|hispanic|latin[oax]|veteran|disabilit(y|ies)|disabled|pronouns?|sexual orientation|sexuality|transgender|lgbt\w*|queer|lesbian|gay|bisexual|non-?binary|intersex|consent|i agree|i accept|i acknowledge|i certify|terms (of|and) (service|use|conditions)|privacy policy|signature|e-?sign)\b/i;

/**
 * SCP1: a section name as every comparison reads it, here and in the extension (extension/src/content/sections.ts
 * sectionName, the same function, checked against fixtures/golden/section-names.json): NFKC, case folded, whitespace
 * collapsed. The exclusion reads it too, so a fullwidth "Ｖｏｌｕｎｔａｒｙ ｓｅｌｆ－ｉｄｅｎｔｉｆｉｃａｔｉｏｎ" is excluded as the
 * ASCII one is, and equal names are equal however they are typed.
 */
export function sectionName(s: string): string {
  return s.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC").replace(/\s+/gu, " ").trim();
}

/** SCP1: whether a section text is one the walk's self-identification exclusion takes, read as sectionName reads it. */
export const excludedSection = (text: string): boolean => SELF_IDENTIFICATION.test(sectionName(text));
