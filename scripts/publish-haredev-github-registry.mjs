#!/usr/bin/env node
/**
 * Publish @haredev/paperclip-* packages to GitHub npm registry so that
 * `npm install @haredev/paperclipai` can pull a matching @paperclipai/server
 * (via npm package alias in the CLI's published package.json).
 *
 * Requires: PUBLISH_VERSION (e.g. 0.3.1-sha.abcdef12), NODE_AUTH_TOKEN,
 * and .npmrc / setup-node configured for @haredev -> npm.pkg.github.com.
 *
 * UI: not published separately — server prepack runs prepare:ui-dist and
 * ships static assets under server/ui-dist/.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const PUBLISH_VERSION = process.env.PUBLISH_VERSION?.trim();
if (!PUBLISH_VERSION) {
  console.error("publish-haredev-github-registry: set PUBLISH_VERSION");
  process.exit(1);
}

const REGISTRY = "https://npm.pkg.github.com";

/** @paperclipai/foo -> @haredev/paperclip-foo */
function toHaredevName(paperclipName) {
  if (!paperclipName.startsWith("@paperclipai/")) return paperclipName;
  return `@haredev/paperclip-${paperclipName.slice("@paperclipai/".length)}`;
}

const PACKAGE_DIR = {
  "@paperclipai/shared": "packages/shared",
  "@paperclipai/adapter-utils": "packages/adapter-utils",
  "@paperclipai/db": "packages/db",
  "@paperclipai/plugin-sdk": "packages/plugins/sdk",
  "@paperclipai/adapter-acpx-local": "packages/adapters/acpx-local",
  "@paperclipai/adapter-claude-local": "packages/adapters/claude-local",
  "@paperclipai/adapter-codex-local": "packages/adapters/codex-local",
  "@paperclipai/adapter-cursor-cloud": "packages/adapters/cursor-cloud",
  "@paperclipai/adapter-cursor-local": "packages/adapters/cursor-local",
  "@paperclipai/adapter-gemini-local": "packages/adapters/gemini-local",
  "@paperclipai/adapter-openclaw-gateway": "packages/adapters/openclaw-gateway",
  "@paperclipai/adapter-opencode-local": "packages/adapters/opencode-local",
  "@paperclipai/adapter-pi-local": "packages/adapters/pi-local",
  "@paperclipai/server": "server",
};

const PUBLISH_ORDER = [
  "@paperclipai/shared",
  "@paperclipai/adapter-utils",
  "@paperclipai/db",
  "@paperclipai/plugin-sdk",
  "@paperclipai/adapter-acpx-local",
  "@paperclipai/adapter-claude-local",
  "@paperclipai/adapter-codex-local",
  "@paperclipai/adapter-cursor-cloud",
  "@paperclipai/adapter-cursor-local",
  "@paperclipai/adapter-gemini-local",
  "@paperclipai/adapter-openclaw-gateway",
  "@paperclipai/adapter-opencode-local",
  "@paperclipai/adapter-pi-local",
  "@paperclipai/server",
];

const PUBLISH_NAME_SET = new Set(PUBLISH_ORDER);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function rewriteDeps(deps) {
  if (!deps) return deps;
  const out = { ...deps };
  for (const [name, spec] of Object.entries(out)) {
    if (typeof spec !== "string") continue;
    if (!name.startsWith("@paperclipai/")) continue;
    if (spec !== "workspace:*" && !spec.startsWith("workspace:")) continue;
    if (!PUBLISH_NAME_SET.has(name)) {
      throw new Error(`Unexpected workspace dep ${name} in publish set — add to PACKAGE_DIR / PUBLISH_ORDER`);
    }
    out[name] = `npm:${toHaredevName(name)}@${PUBLISH_VERSION}`;
  }
  return out;
}

function makePublishablePackageJson(original, paperclipName) {
  const next = { ...original };
  next.name = toHaredevName(paperclipName);
  next.version = PUBLISH_VERSION;
  next.publishConfig = { registry: REGISTRY, access: "public" };
  if (next.dependencies) next.dependencies = rewriteDeps(next.dependencies);
  if (next.optionalDependencies) next.optionalDependencies = rewriteDeps(next.optionalDependencies);
  if (next.peerDependencies) next.peerDependencies = rewriteDeps(next.peerDependencies);
  delete next.devDependencies;
  return next;
}

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: "inherit", cwd: ROOT, ...opts });
}

function publishOne(paperclipName) {
  const rel = PACKAGE_DIR[paperclipName];
  if (!rel) throw new Error(`No directory mapping for ${paperclipName}`);
  const dir = resolve(ROOT, rel);
  const pkgPath = resolve(dir, "package.json");
  if (!existsSync(pkgPath)) throw new Error(`Missing ${pkgPath}`);

  run(`pnpm --filter ${JSON.stringify(paperclipName)} run build`);

  const backup = resolve(dir, "package.json.publish-backup");
  copyFileSync(pkgPath, backup);
  try {
    const original = readJson(pkgPath);
    const publishable = makePublishablePackageJson(original, paperclipName);
    writeFileSync(pkgPath, JSON.stringify(publishable, null, 2) + "\n");
    execSync("npm publish --access public", { stdio: "inherit", cwd: dir, env: process.env });
  } finally {
    copyFileSync(backup, pkgPath);
    try {
      unlinkSync(backup);
    } catch {
      /* ignore */
    }
  }
}

console.log(`Publishing @haredev/paperclip-* @ ${PUBLISH_VERSION} to ${REGISTRY}\n`);

for (const name of PUBLISH_ORDER) {
  console.log(`\n==> ${name}\n`);
  publishOne(name);
}

console.log("\nDone. CLI should depend on:");
console.log(`  npm:@haredev/paperclip-server@${PUBLISH_VERSION}`);
console.log('(set PAPERCLIP_SERVER_NPM_SPECIFIER for generate-npm-package-json.mjs)\n');
