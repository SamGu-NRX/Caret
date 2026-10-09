import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, matchesGlob, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const fail = (message) => { throw new Error(`verify-store: ${message}`); };

export function verifyStore(archive) {
  const temp = mkdtempSync(join(tmpdir(), "caret-store-verify-"));
  try {
    let entries;
    try {
      entries = execFileSync("unzip", ["-Z1", resolve(archive)], { encoding: "utf8" }).trimEnd().split("\n");
    } catch {
      fail(`cannot list ZIP ${archive}`);
    }
    for (const entry of entries) {
      if (!entry || entry.startsWith("/") || entry.includes("\\") || entry.split("/").some((part) => part === ".." || part === ".")) {
        fail(`unsafe ZIP entry ${JSON.stringify(entry)}`);
      }
    }
    if (new Set(entries).size !== entries.length) fail("ZIP contains duplicate entries");
    const files = entries.filter((entry) => !entry.endsWith("/"));
    if (!files.includes("manifest.json")) fail("manifest.json is missing from ZIP root");
    try {
      execFileSync("unzip", ["-q", resolve(archive), "-d", temp]);
    } catch {
      fail(`cannot extract ZIP ${archive}`);
    }
    for (const file of files) {
      if (!lstatSync(join(temp, file)).isFile()) fail(`ZIP entry is not a regular file: ${file}`);
    }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(temp, "manifest.json"), "utf8"));
    } catch {
      fail("manifest.json is not valid JSON");
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("manifest.json must be an object");
    if (Object.hasOwn(manifest, "key")) fail("manifest.json contains forbidden key field");
    const pkg = JSON.parse(readFileSync(`${here}package.json`, "utf8"));
    if (manifest.version !== pkg.version) fail(`manifest version ${JSON.stringify(manifest.version)} does not equal package.json version ${pkg.version}`);
    const referenced = new Set(["manifest.json"]);
    const reference = (value, label, glob = false) => {
      if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => part === ".." || part === "." || !part)) {
        fail(`${label} has invalid file reference ${JSON.stringify(value)}`);
      }
      const found = glob ? files.filter((file) => matchesGlob(file, value)) : files.filter((file) => file === value);
      if (!found.length) fail(`${label} references missing file ${value}`);
      for (const file of found) referenced.add(file);
    };
    const array = (value, label) => {
      if (!Array.isArray(value)) fail(`${label} must be an array`);
      return value;
    };
    const icons = (value, label) => {
      if (typeof value === "string") {
        reference(value, label);
        return;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an icon size map`);
      for (const [size, file] of Object.entries(value)) {
        reference(file, `${label}.${size}`);
        if (!/^[1-9]\d*$/.test(size)) fail(`${label} has invalid pixel size ${size}`);
        const png = readFileSync(join(temp, file));
        if (png.length < 33 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || png.readUInt32BE(8) !== 13 || png.toString("ascii", 12, 16) !== "IHDR") {
          fail(`${file} is not a PNG with an IHDR header`);
        }
        const width = png.readUInt32BE(16);
        const height = png.readUInt32BE(20);
        if (width !== Number(size) || height !== Number(size)) fail(`${file} is ${width}x${height}; ${label}.${size} requires ${size}x${size}`);
      }
    };
    if (manifest.background?.service_worker !== undefined) reference(manifest.background.service_worker, "background.service_worker");
    for (const [index, script] of array(manifest.content_scripts ?? [], "content_scripts").entries()) {
      for (const kind of ["js", "css"]) {
        for (const file of array(script[kind] ?? [], `content_scripts[${index}].${kind}`)) reference(file, `content_scripts[${index}].${kind}`);
      }
    }
    if (manifest.icons !== undefined) icons(manifest.icons, "icons");
    if (manifest.action?.default_icon !== undefined) icons(manifest.action.default_icon, "action.default_icon");
    for (const [index, resource] of array(manifest.web_accessible_resources ?? [], "web_accessible_resources").entries()) {
      for (const file of array(resource.resources, `web_accessible_resources[${index}].resources`)) reference(file, `web_accessible_resources[${index}].resources`, true);
    }
    const unexpected = files.filter((file) => !referenced.has(file));
    if (unexpected.length) fail(`unexpected files in ZIP: ${unexpected.sort().join(", ")}`);
    console.log(`verify-store: OK ${archive} (${files.length} files, version ${manifest.version}, no key)`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const manifest = JSON.parse(readFileSync(`${here}manifest.json`, "utf8"));
    verifyStore(process.argv[2] ?? `${here}dist-store/caret-for-chrome-${manifest.version}.zip`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
