// Every instruction the B28 reviews and probes used to get past the scope words, with the form's title where the
// review set one. None may be a whole form or a section that stands without Jev: test/scope-words.test.ts checks the grammar
// alone, test/ask.test.ts checks planAsk with a Jev that confirms nothing.
/**
 * B28b: one sentence per exclusion word of the lead decision, holding that word and no other. Each names Email, Phone
 * and LinkedIn, so a writer's list of them was trusted by naming before B28b (test/ask.test.ts).
 */
export const BY_WORD: readonly [string, string][] = [
  ["not", "fill in the email and phone, not linkedin"],
  ["n't", "fill in the email and phone, linkedin isn't needed"],
  ["except", "fill in the email and phone except linkedin"],
  ["but", "fill in the email and phone but linkedin is mine to do"],
  ["without", "fill in the email and phone without linkedin"],
  ["skip", "fill in the email and phone, skip linkedin"],
  ["leave", "fill in the email and phone, leave linkedin"],
  ["besides", "fill in the email and phone besides linkedin"],
  ["other than", "fill in the email and phone other than linkedin"],
  ["no", "fill in the email and phone, no linkedin"],
  ["don't", "fill in the email and phone, don't do linkedin"],
  ["instead", "fill in the email and phone instead of linkedin"],
];

export const REVIEWED: readonly [string, string?][] = [
  // B28b probes: a writer's list or section the instruction names while ruling part of it out.
  ["fill out the email and not phone"],
  ["do the contact section except phone"],
  ...BY_WORD.map(([, s]): [string] => [s]),
  // B28b review: "n't" apart from its verb, and restrictions the lead decision's twelve words do not hold.
  ["fill in the email and phone, linkedin is n't needed"],
  ["fill in the email and phone, do n’t fill linkedin"],
  ["only email, phone later"],
  ["fill everything bar phone"],
  ["fill in the email, phone is optional"],
  // B28b re-check.
  ["fill only Email in the contact section"],
  ["fill in the email, defer phone"],
  ["fill in the email, phone tomorrow"],
  // Review 5: quote characters the quote rule missed, a restriction inside the form's title, and a period before "in"
  // that let "in my email" be read as where to copy from.
  ["fill in ＂everything＂"],
  ["fill in 〝everything〞"],
  ["fill out the email only", "Email only"],
  ["fill out the email and not phone", "Email and not phone"],
  ["fill.in my email on this form"],
  // The same period beside a section phrase.
  ["fill.in my email, my contact info"],
  ["do my contact info.in my email only"],
  // Reviews 1-4.
  ["just fill my email on this form"],
  ["put everything from my note in Notes"],
  ["fill the rest of the address"],
  ["do the rest of the address"],
  ["only the rest of the address"],
  ["Write ‘everything’ in Notes"],
  ["Write 'fill in everything' in Notes"],
  ["my email from the 'everything' note"],
  ['fill "Email" on this form'],
  ["fill in everything, the phone is (512) 555-0147"],
  ["skip my contact info, do the rest"],
  ["avoid my contact info, do the rest"],
  ["my contact info, but not the phone"],
  ["only my email in contact info"],
  ["only the second box in contact info"],
  ["fill only part of my contact info"],
  ["fill a bit of my details"],
  ["do everything from my note except email"],
  ["do everything in my details except email"],
  ["put that in this form"],
  ["do it on this form"],
  ["fill out the email only", "Email signup | Members only"],
  ["fill in Bea's linkedin on this form"],
  ["fill in what I typed on this form"],
  ["fill only Bea's linkedin in my contact info"],
  ["fill only what I wrote in contact info"],
  ["do the whole form but `phone`"],
  ["fill in everything «Email»"],
  ["fill in only the `contact info`"],
  ["fill in only the «contact info»"],
  ["fill in only the „contact info“"],
  ['only my "Email" in contact info'],
  ["everything but the phone"],
  ["fill out everything except LinkedIn"],
  ["don't do the whole form"],
  ["just my email, leave the rest"],
  ["my email and phone, leave the rest"],
  ["Fill only Email; do not change Phone"],
];
