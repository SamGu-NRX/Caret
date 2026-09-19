import path from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  turbopack: { root: path.dirname(fileURLToPath(import.meta.url)) },
  // Inputs and the skill are read from disk at request time; make sure Vercel bundles them with the route.
  outputFileTracingIncludes: { "/api/run": ["./inputs/**/*", "./skills/**/*"] },
};
export default nextConfig;
