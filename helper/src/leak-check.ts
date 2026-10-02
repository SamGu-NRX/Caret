// Checks that files written from real-window runs hold none of the text those windows showed,
// without keeping that text. While an audit runs, every string it sees is cut into units (the
// whole text, each line, each word of 6 or more characters) and only a keyed hash of each unit is
// kept. Afterwards every word-bounded substring of each line of the files under check is hashed
// with the same key and looked up.
import { createHmac, randomBytes } from "node:crypto";

/** Units shorter than this are words like "Cancel" or "Open" that any file can hold by chance. */
export const MIN_UNIT = 6;
/** Longer units are paragraphs; their lines and words are kept as units of their own. */
const MAX_UNIT = 400;
const OTHER_APPS = "(apps after the 31st)";

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
const EDGE = /^[\s"'“”‘’()[\]{}<>.,;:!?*`|-]+|[\s"'“”‘’()[\]{}<>.,;:!?*`|-]+$/g;
const isWord = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** The units a seen string contributes: the whole text, each line and each word, normalized, of MIN_UNIT to MAX_UNIT characters. */
export function seenUnits(text: string): string[] {
  const out = new Set<string>();
  const add = (s: string): void => {
    const t = norm(s);
    if (t.length >= MIN_UNIT && t.length <= MAX_UNIT) out.add(t);
  };
  add(text);
  for (const line of text.split(/\r?\n/)) {
    add(line);
    for (const word of line.split(/\s+/)) add(word.replace(EDGE, ""));
  }
  return [...out];
}

export interface SeenFile {
  /** Hex key for the hashes. Whoever holds it can test guesses against the hashes, so the file is deleted after the check. */
  salt: string;
  bundles: string[];
  /** Unit lengths present, so the scan hashes only substrings that could match. */
  lengths: number[];
  /** Hash to a bit mask over `bundles`: the apps whose windows showed the unit. */
  hashes: Record<string, number>;
}

/** The hashes of everything seen, and in which apps. Holds no text. */
export class SeenSet {
  private readonly salt: Buffer;
  private readonly hashes = new Map<string, number>();
  private readonly bundles: string[] = [];
  private readonly lengths = new Set<number>();

  constructor(salt: Buffer = randomBytes(32)) {
    this.salt = salt;
  }

  get size(): number {
    return this.hashes.size;
  }

  hash(unit: string): string {
    return createHmac("sha256", this.salt).update(unit).digest("hex").slice(0, 16);
  }

  add(text: string, bundleId: string): void {
    let bit = this.bundles.indexOf(bundleId);
    if (bit < 0) {
      // A bit per app. The 32nd bit stands for every app after the 31st, which only blurs which app showed a unit.
      if (this.bundles.length < 31) this.bundles.push(bundleId);
      else if (this.bundles.length === 31) this.bundles.push(OTHER_APPS);
      bit = Math.min(this.bundles.length - 1, 31);
    }
    for (const u of seenUnits(text)) {
      const h = this.hash(u);
      this.hashes.set(h, (this.hashes.get(h) ?? 0) | (1 << bit));
      this.lengths.add(u.length);
    }
  }

  toJSON(): SeenFile {
    return { salt: this.salt.toString("hex"), bundles: [...this.bundles], lengths: [...this.lengths].sort((a, b) => a - b), hashes: Object.fromEntries(this.hashes) };
  }

  static fromJSON(f: SeenFile): SeenSet {
    if (!/^[0-9a-f]{64}$/.test(f.salt)) throw new Error("seen file: salt must be 64 hex characters");
    const s = new SeenSet(Buffer.from(f.salt, "hex"));
    s.bundles.push(...f.bundles);
    for (const l of f.lengths) s.lengths.add(l);
    for (const [h, mask] of Object.entries(f.hashes)) s.hashes.set(h, mask);
    return s;
  }

  /** The apps that showed this hash, or null when it was never seen. */
  lookup(h: string): string[] | null {
    const mask = this.hashes.get(h);
    if (mask === undefined) return null;
    return this.bundles.filter((_, i) => (mask & (1 << i)) !== 0);
  }

  lengthSet(): ReadonlySet<number> {
    return this.lengths;
  }
}

export interface LeakHit {
  /** The matching text, taken from the file under check. */
  unit: string;
  bundles: string[];
}

/**
 * Every word-bounded substring of each line of `text` whose normalized form hashes to a seen unit.
 * A start is a word boundary when the character before it, or the character itself, is not a letter
 * or digit; ends likewise. Units that match inside a longer word are not reported.
 */
export function scanText(text: string, seen: SeenSet): LeakHit[] {
  const lengths = seen.lengthSet();
  const maxLen = Math.max(0, ...lengths);
  const hits = new Map<string, LeakHit>();
  for (const raw of text.split(/\r?\n/)) {
    const line = norm(raw);
    const n = line.length;
    const starts: number[] = [];
    const ends = new Set<number>();
    for (let i = 0; i <= n; i++) {
      const boundary = !isWord(line[i - 1]) || !isWord(line[i]);
      if (boundary && i < n) starts.push(i);
      if (boundary && i > 0) ends.add(i);
    }
    for (const s of starts) {
      for (let e = s + MIN_UNIT; e <= Math.min(n, s + maxLen); e++) {
        if (!ends.has(e) || !lengths.has(e - s)) continue;
        const unit = line.slice(s, e);
        if (unit !== unit.trim()) continue;
        if (hits.has(unit)) continue;
        const bundles = seen.lookup(seen.hash(unit));
        if (bundles !== null) hits.set(unit, { unit, bundles });
      }
    }
  }
  return [...hits.values()];
}
