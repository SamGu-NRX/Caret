// Environment names shared with native launchers. Tests derive their inventory here.
export const HOST_ENV = [
  { key: "caret_release_host", name: "CARET_RELEASE_HOST", direction: "host-to-helper", meaning: "Release host disables development providers.", caret: null, legacy: null },
  { key: "typesafe_api_key", name: "TYPESAFE_API_KEY", direction: "host-to-helper", meaning: "TypeSafe Jev credential.", caret: null, legacy: null },
  { key: "caret_jev_provider", name: "CARET_JEV_PROVIDER", direction: "host-to-helper", meaning: "Explicit Jev provider.", caret: null, legacy: "Legacy transport launches the Python core, not the v2 helper; other parent settings are inherited." },
  { key: "caret_jev_model", name: "CARET_JEV_MODEL", direction: "host-to-helper", meaning: "Explicit Jev model.", caret: null, legacy: "Legacy transport launches the Python core, not the v2 helper; other parent settings are inherited." },
  { key: "caret_jev_daily_cap", name: "CARET_JEV_DAILY_CAP", direction: "host-to-helper", meaning: "Daily Jev dollar cap.", caret: null, legacy: "Legacy transport launches the Python core, not the v2 helper; other parent settings are inherited." },
  { key: "caret_env_file", name: "CARET_ENV_FILE", direction: "host-to-helper", meaning: "Development env-file path, removed in release.", caret: null, legacy: null },
  { key: "caret_dev_vercel_gemini", name: "CARET_DEV_VERCEL_GEMINI", direction: "host-to-helper", meaning: "Development-only Vercel opt-in.", caret: null, legacy: "Legacy transport launches the Python core, not the v2 helper; other parent settings are inherited." },
  { key: "caret_jev_gateway_key", name: "CARET_JEV_GATEWAY_KEY", direction: "host-to-helper", meaning: "Development Jev gateway credential.", caret: null, legacy: null },
  { key: "ai_gateway_api_key", name: "AI_GATEWAY_API_KEY", direction: "host-to-helper", meaning: "Legacy development writer gateway credential.", caret: "The v2 host has no writer route or forwards no launch markers.", legacy: null },
  { key: "groq_api_key", name: "GROQ_API_KEY", direction: "host-to-helper", meaning: "Legacy development Groq writer credential.", caret: "The v2 host has no writer route or forwards no launch markers.", legacy: null },
  { key: "caret_launchd_agent", name: "CARET_LAUNCHD_AGENT", direction: "host-only", meaning: "LaunchRole marker; helper cache refuses shipped runs.", caret: "The v2 host has no writer route or forwards no launch markers.", legacy: "Legacy transport launches the Python core, not the v2 helper; other parent settings are inherited." },
  { key: "caret_opened_by_launchservices", name: "CARET_OPENED_BY_LAUNCHSERVICES", direction: "host-only", meaning: "LaunchServices marker; helper cache refuses shipped runs.", caret: "The v2 host has no writer route or forwards no launch markers.", legacy: "Legacy transport launches the Python core, not the v2 helper; other parent settings are inherited." },
  { key: "caret_screen_fixture_acts", name: "CARET_SCREEN_FIXTURE_ACTS", direction: "test-to-reader", meaning: "Reader fixture-only act permission; never set by product.", caret: "Only the fixture harness sets this in the reader or bridge, not the helper.", legacy: "Legacy transport launches the Python core, not the v2 helper; other parent settings are inherited." },
  { key: "caret_bridge_service", name: "CARET_BRIDGE_SERVICE", direction: "test-to-bridge", meaning: "Fixture bridge Mach service override; never set by product.", caret: "Only the fixture harness sets this in the reader or bridge, not the helper.", legacy: "Legacy transport launches the Python core, not the v2 helper; other parent settings are inherited." },
] as const;

// Helper-only names need a reason because no native launcher supplies them.
export const HELPER_ONLY_ENV = [
  { key: "caret_jev_spend_dir", name: "CARET_JEV_SPEND_DIR", reason: "Harness spend-file directory; the host uses helper defaults." },
  { key: "caret_jev_cache", name: "CARET_JEV_CACHE", reason: "Harness-only decision cache; the real helper refuses it." },
  { key: "caret_jev_cache_mode", name: "CARET_JEV_CACHE_MODE", reason: "Harness-only cache mode; the host never enables caching." },
  { key: "caret_test_markers_off", name: "CARET_TEST_MARKERS_OFF", reason: "Test-only redaction override; helper startup refuses it." },
  { key: "vitest", name: "VITEST", reason: "Vitest sets this to enable the isolated verifier seam." },
  { key: "caret_engine_calibration", name: "CARET_ENGINE_CALIBRATION", reason: "Harness calibration file; not a host launch setting." },
  { key: "caret_llama_prompt", name: "CARET_LLAMA_PROMPT", reason: "Harness local-server prompt template; not a host setting." },
  { key: "caret_llama_model", name: "CARET_LLAMA_MODEL", reason: "Harness local-server model; not a host setting." },
  { key: "caret_llama_url", name: "CARET_LLAMA_URL", reason: "Harness local-server URL; not a host setting." },
  { key: "caret_llama_thinking", name: "CARET_LLAMA_THINKING", reason: "Harness local-server thinking option; not a host setting." },
  { key: "caret_slow_eval_events", name: "CARET_SLOW_EVAL_EVENTS", reason: "Harness events file; not a host launch setting." },
  { key: "caret_slow_eval_pace_ms", name: "CARET_SLOW_EVAL_PACE_MS", reason: "Harness pacing interval; not a host setting." },
  { key: "caret_slow_eval_hold", name: "CARET_SLOW_EVAL_HOLD", reason: "Harness hold-file path; not a host setting." },
  { key: "caret_slow_eval_disk_gib", name: "CARET_SLOW_EVAL_DISK_GIB", reason: "Harness disk floor; not a host setting." },
  { key: "caret_slow_eval_pace_file", name: "CARET_SLOW_EVAL_PACE_FILE", reason: "Harness pace-file path; not a host setting." },
] as const;

const entries = [...HOST_ENV, ...HELPER_ONLY_ENV];
type Entry = typeof entries[number];
export const ENV = Object.fromEntries(entries.map((e) => [e.key, e.name])) as {
  readonly [K in Entry["key"]]: Extract<Entry, { key: K }>["name"];
};

/** The environment typed to the names above, so reading an unlisted name is a type error. */
export type HostEnv = { readonly [N in Entry["name"]]?: string };

const listed: ReadonlySet<string> = new Set(entries.map((e) => e.name));
const present = (name: string | symbol): name is Entry["name"] => typeof name === "string" && listed.has(name) && Object.hasOwn(process.env, name);

/**
 * The helper's only reference to process.env (test/host-env.test.ts): listed names, read live, by key, enumeration or
 * spread; any other name reads as unset. Live because test setup replaces process.env with a guard on reads.
 */
const view: HostEnv = new Proxy({}, {
  get: (_, name) => (typeof name === "string" && listed.has(name) ? process.env[name] : undefined),
  ownKeys: () => [...listed].filter(present),
  getOwnPropertyDescriptor: (_, name) => (present(name) ? { value: process.env[name], enumerable: true, configurable: true } : undefined),
});

export function processEnv(): HostEnv {
  return view;
}
