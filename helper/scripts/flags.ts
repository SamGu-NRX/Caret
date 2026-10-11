// Numeric command-line flags, checked before a script does any work. Number() turns a typo into NaN,
// and a guard such as `spent >= NaN` is never true, so a bad --max-usd would leave live Jev spend
// unbounded and a bad --rounds would run nothing and report zeros.

/** A finite number above zero, such as a dollar budget. */
export const positiveNumber = (flag: string, raw: string | undefined): number => {
  const n = Number(raw);
  if (raw === undefined || !Number.isFinite(n) || n <= 0) throw new Error(`--${flag} must be a positive number, not ${JSON.stringify(raw)}`);
  return n;
};

/** A whole number above zero, such as a round or repeat count. */
export const positiveInt = (flag: string, raw: string | undefined): number => {
  const n = Number(raw);
  if (raw === undefined || !Number.isSafeInteger(n) || n <= 0) throw new Error(`--${flag} must be a positive whole number, not ${JSON.stringify(raw)}`);
  return n;
};
