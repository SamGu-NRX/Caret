/** Sam excluded every Vercel route from shipping because its data handling cannot be disclosed. */
export function requireVercelDevelopment(env: NodeJS.ProcessEnv = process.env): void {
  if (process.env.CARET_RELEASE_HOST === "1" || env.CARET_RELEASE_HOST === "1") {
    throw new Error("Vercel AI Gateway is disabled under a release host");
  }
  if (env.CARET_DEV_VERCEL_GEMINI !== "1") {
    throw new Error("Vercel AI Gateway is disabled; development only: set CARET_DEV_VERCEL_GEMINI=1 to enable it");
  }
}
