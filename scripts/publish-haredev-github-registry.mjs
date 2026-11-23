#!/usr/bin/env node
/**
 * Fork (Haredev): publish the server stack to GitHub Packages as
 * @haredev/paperclip-* so `npm install @haredev/paperclipai` can pull a
 * matching @paperclipai/server via an npm package alias in the CLI manifest.
 *
 * The set of packages is discovered at publish time: @paperclipai/server plus
 * every workspace package it transitively depends on (dependencies,
 * optionalDependencies, peerDependencies with a `workspace:` spec), published
 * dependencies-first. No hardcoded list to fall out of date on upstream bumps.
 *
 * Requires: PUBLISH_VERSION (e.g. 2026.1117.0-sha.abcdef12), NODE_AUTH_TOKEN,
 * and .npmrc / setup-node configured for @haredev -> npm.pkg.github.com.
 *
 * UI: not published separately — the server's prepack runs prepare:ui-dist
 * and ships static assets under server/ui-dist/.
 *
 * Flags:
 *   --dry-run   print the publish plan and rewritten manifests; build and
 *               publish nothing (PUBLISH_VERSION defaults to 0.0.0-dry-run).
 */

import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const REGISTRY = "https://npm.pkg.github.com";
const ROOT_PACKAGE = "@paperclipai/server";
const DRY_RUN = process.argv.includes("--dry-run");

const PUBLISH_VERSION = process.env.PUBLISH_VERSION?.trim() || (DRY_RUN ? "0.0.0-dry-run" : "");
if (!PUBLISH_VERSION) {
  console.error("publish-haredev-github-registry: set PUBLISH_VERSION");
  process.exit(1);
}

/** @paperclipai/foo -> @haredev/paperclip-foo */
function toHaredevName(paperclipName) {
  if (!paperclipName.startsWith("@paperclipai/")) return paperclipName;
  return `@haredev/paperclip-${paperclipName.slice("@paperclipai/".length)}`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function workspaceDepNames(pkg) {
  const all = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
  return Object.entries(all)
    .filter(([, spec]) => typeof spec === "string" && spec.startsWith("workspace:"))
    .map(([name]) => name);
}

/** Map every workspace package name -> absolute directory. */
function listWorkspacePackages() {
  const raw = execFileSync("pnpm", ["-r", "ls", "--depth", "-1", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const dirs = new Map();
  for (const entry of JSON.parse(raw)) {
    if (entry.name && entry.path) dirs.set(entry.name, entry.path);
  }
  return dirs;
}

/** ROOT_PACKAGE and its transitive workspace deps, dependencies first. */
function resolvePublishOrder(dirs) {
  const order = [];
  const state = new Map(); // name -> "visiting" | "done"
  const visit = (name, trail) => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") {
      throw new Error(`Workspace dependency cycle: ${[...trail, name].join(" -> ")}`);
    }
    const dir = dirs.get(name);
    if (!dir) throw new Error(`Workspace package ${name} (needed by ${trail.at(-1)}) not found`);
    state.set(name, "visiting");
    const pkg = readJson(resolve(dir, "package.json"));
    for (const dep of workspaceDepNames(pkg)) visit(dep, [...trail, name]);
    state.set(name, "done");
    order.push(name);
  };
  visit(ROOT_PACKAGE, []);
  return order;
}

function rewriteDeps(deps, publishSet) {
  if (!deps) return deps;
  const out = { ...deps };
  for (const [name, spec] of Object.entries(out)) {
    if (typeof spec !== "string" || !spec.startsWith("workspace:")) continue;
    if (!publishSet.has(name)) {
      throw new Error(`Workspace dep ${name} is not in the publish set`);
    }
    out[name] = `npm:${toHaredevName(name)}@${PUBLISH_VERSION}`;
  }
  return out;
}

function makePublishablePackageJson(original, paperclipName, publishSet) {
  const next = { ...original };
  next.name = toHaredevName(paperclipName);
  next.version = PUBLISH_VERSION;
  delete next.private;

  // Workspace manifests keep dev-time `exports` -> ./src/*.ts. Flatten
  // publishConfig onto the manifest so installs resolve dist/.
  const pub = original.publishConfig && typeof original.publishConfig === "object"
    ? original.publishConfig
    : {};
  for (const key of ["exports", "main", "types", "module", "bin"]) {
    if (pub[key] != null) next[key] = pub[key];
  }

  next.publishConfig = { registry: REGISTRY, access: "public" };
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (next[field]) next[field] = rewriteDeps(next[field], publishSet);
  }
  delete next.devDependencies;

  // Some upstream packages (e.g. hermes) ship prepack/postpack hooks running
  // their own publish prep (prepare-publish-package / restore-dev-package).
  // Those re-resolve workspace deps to @paperclipai/* names and expect an
  // unflattened publishConfig, fighting this script. Drop only those hooks;
  // keep unrelated ones such as the server's `prepare:ui-dist` prepack.
  if (next.scripts && typeof next.scripts === "object") {
    const scripts = { ...next.scripts };
    for (const hook of ["prepack", "postpack", "prepare", "prepublish", "prepublishOnly"]) {
      const cmd = scripts[hook];
      if (typeof cmd === "string" && /prepare-publish-package|restore-dev-package/.test(cmd)) {
        delete scripts[hook];
      }
    }
    next.scripts = scripts;
  }
  return next;
}

function publishOne(paperclipName, dir, publishSet) {
  const pkgPath = resolve(dir, "package.json");
  if (!existsSync(pkgPath)) throw new Error(`Missing ${pkgPath}`);
  const original = readJson(pkgPath);
  const publishable = makePublishablePackageJson(original, paperclipName, publishSet);

  if (DRY_RUN) {
    const { name, version, exports, main, types, dependencies, optionalDependencies, peerDependencies, scripts } =
      publishable;
    const pick = (deps) =>
      deps && Object.fromEntries(Object.entries(deps).filter(([, v]) => String(v).startsWith("npm:@haredev/")));
    console.log(JSON.stringify({
      name, version, exports, main, types,
      haredevDeps: { ...pick(dependencies), ...pick(optionalDependencies), ...pick(peerDependencies) },
      packHooks: Object.fromEntries(
        Object.entries(scripts ?? {}).filter(([k]) => /^(pre|post)(pack|publish)|^prepare$/.test(k)),
      ),
    }, null, 2));
    return;
  }

  execSync(`pnpm --filter ${JSON.stringify(paperclipName)} run build`, { stdio: "inherit", cwd: ROOT });

  const backup = resolve(dir, "package.json.publish-backup");
  copyFileSync(pkgPath, backup);
  try {
    writeFileSync(pkgPath, JSON.stringify(publishable, null, 2) + "\n");
    execSync("npm publish --access public --tag dev", { stdio: "inherit", cwd: dir, env: process.env });
  } finally {
    copyFileSync(backup, pkgPath);
    try {
      unlinkSync(backup);
    } catch {
      /* ignore */
    }
  }
}

const dirs = listWorkspacePackages();
const order = resolvePublishOrder(dirs);
const publishSet = new Set(order);

console.log(`${DRY_RUN ? "[dry-run] " : ""}Publishing ${order.length} packages @ ${PUBLISH_VERSION} to ${REGISTRY}:`);
for (const name of order) console.log(`  ${toHaredevName(name).padEnd(52)} <- ${relative(ROOT, dirs.get(name))}`);

for (const name of order) {
  console.log(`\n==> ${name}\n`);
  publishOne(name, dirs.get(name), publishSet);
}

console.log("\nDone. CLI should depend on:");
console.log(`  npm:${toHaredevName(ROOT_PACKAGE)}@${PUBLISH_VERSION}`);
console.log("(set PAPERCLIP_SERVER_NPM_SPECIFIER for generate-npm-package-json.mjs)\n");
