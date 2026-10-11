// Reads one API key at call time, from the process environment or from the .env file named by
// CARET_ENV_FILE. Errors name the variable and file, never the value.
import { readFileSync } from "node:fs";

export function readKey(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const direct = env[name];
  if (direct !== undefined && direct.length > 0) return direct;
  const file = env.CARET_ENV_FILE;
  if (file === undefined || file.length === 0) throw new Error(`${name} missing: set it, or CARET_ENV_FILE to a .env file that defines it`);
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)\\s*$`);
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = pattern.exec(line);
    if (m?.[1] !== undefined) {
      const v = m[1].replace(/^(['"])(.*)\1$/, "$2").trim();
      if (v.length > 0) return v;
    }
  }
  throw new Error(`${name} missing: ${file} has no ${name} line`);
}
