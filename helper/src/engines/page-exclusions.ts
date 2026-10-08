// SCP1: the page walk's self-identification exclusion (extension/src/content/walker.ts SELF_IDENTIFICATION), applied
// again where the helper projects a page walk, so a heading or section name it matches never reaches a request even
// from an extension that sent one. The two copies are checked against the same cases
// (fixtures/golden/self-identification.json; extension test/sections.test.ts and helper test/scp1-section-scope.test.ts).

/** Self-identification and consent sections: demographic questions and agreements, the user's to answer. */
export const SELF_IDENTIFICATION = /\b(self[- ]identif\w*|gender|sex|race|racial|ethnicity|hispanic|latin[oax]|veteran|disabilit(y|ies)|disabled|pronouns?|sexual orientation|sexuality|transgender|lgbt\w*|queer|lesbian|gay|bisexual|non-?binary|intersex|consent|i agree|i accept|i acknowledge|i certify|terms (of|and) (service|use|conditions)|privacy policy|signature|e-?sign)\b/i;
