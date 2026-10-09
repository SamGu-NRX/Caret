import { ENV, processEnv, type HostEnv } from "../host-env.ts";
/** Sam excluded every Vercel route from shipping because its data handling cannot be disclosed. */
export function requireVercelDevelopment(env: HostEnv = processEnv()): void {
  if (processEnv()[ENV.caret_release_host] === "1" || env[ENV.caret_release_host] === "1") {
    throw new Error("Vercel AI Gateway is disabled under a release host");
  }
  if (env[ENV.caret_dev_vercel_gemini] !== "1") {
    throw new Error("Vercel AI Gateway is disabled; development only: set CARET_DEV_VERCEL_GEMINI=1 to enable it");
  }
}
