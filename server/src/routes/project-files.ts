import { Router, type Request, type Response } from "express";
import { promises as fs, createReadStream } from "node:fs";
import * as path from "node:path";
import { ZipArchive } from "archiver";
import type { Db } from "@paperclipai/db";
import { projectService, executionWorkspaceService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

const MARKDOWN_EXTS = new Set([".md", ".mdx"]);
const IMAGE_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp", ".ico",
]);
const HTML_EXTS = new Set([".html", ".htm"]);
const TEXT_EXTS = new Set([
  ".txt", ".json", ".csv", ".tsv", ".log", ".yaml", ".yml", ".xml", ".toml",
  ".ini", ".env", ".css", ".js", ".jsx", ".ts", ".tsx", ".sh", ".py", ".sql",
]);

export type FileViewKind = "markdown" | "text" | "image" | "html";

function classifyViewKind(ext: string): FileViewKind | null {
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (HTML_EXTS.has(ext)) return "html";
  if (TEXT_EXTS.has(ext)) return "text";
  return null;
}

const RAW_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
};

const MAX_TREE_ENTRIES = 5_000;
const MAX_VIEW_BYTES = 2 * 1024 * 1024;
const MAX_RAW_BYTES = 25 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const IGNORE_NAMES = new Set([
  ".git",
  "node_modules",
  ".turbo",
  ".next",
  "dist",
  "build",
  ".vscode",
  ".idea",
  ".DS_Store",
  "coverage",
  ".cache",
  ".pnpm-store",
]);

// A workspace the file explorer can browse: either a user-declared project
// workspace or a Paperclip-managed execution workspace that lives on local disk.
type BrowsableWorkspace = {
  id: string;
  name: string;
  cwd: string | null;
  isPrimary: boolean;
  sourceType: string;
  managed: boolean;
};

type ResolvedWorkspace = {
  root: string;
  realRoot: string;
  workspace: BrowsableWorkspace;
};

export function projectFileRoutes(db: Db) {
  const router = Router();
  const svc = projectService(db);
  const execSvc = executionWorkspaceService(db);

  // Declared project workspaces first, then distinct managed execution
  // workspaces (local_fs, active) that don't duplicate a declared path.
  async function collectBrowsableWorkspaces(
    projectId: string,
    companyId: string,
  ): Promise<BrowsableWorkspace[]> {
    const [declared, managed] = await Promise.all([
      svc.listWorkspaces(projectId),
      execSvc.list(companyId, { projectId, status: "active" }),
    ]);

    const seen = new Set<string>();
    const out: BrowsableWorkspace[] = [];

    for (const w of declared) {
      if (!w.cwd) continue;
      const key = path.resolve(w.cwd);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: w.id,
        name: w.name,
        cwd: w.cwd,
        isPrimary: w.isPrimary,
        sourceType: w.sourceType,
        managed: false,
      });
    }

    for (const w of managed) {
      if (!w.cwd || w.providerType !== "local_fs") continue;
      const key = path.resolve(w.cwd);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: w.id,
        name: path.basename(key) || w.name,
        cwd: w.cwd,
        isPrimary: false,
        sourceType: "managed",
        managed: true,
      });
    }

    return out;
  }

  async function resolveWorkspaceRoot(req: Request, res: Response): Promise<ResolvedWorkspace | null> {
    const projectId = req.params.id as string;
    const project = await svc.getById(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return null;
    }
    assertCompanyAccess(req, project.companyId);

    const workspaces = await collectBrowsableWorkspaces(projectId, project.companyId);
    const requestedId = typeof req.query.workspaceId === "string" ? req.query.workspaceId.trim() : "";

    let workspace: BrowsableWorkspace | null = null;
    if (requestedId) {
      workspace = workspaces.find((entry) => entry.id === requestedId) ?? null;
      if (!workspace) {
        res.status(404).json({ error: "Workspace not found" });
        return null;
      }
    } else {
      workspace =
        workspaces.find((entry) => entry.isPrimary && entry.cwd) ??
        workspaces.find((entry) => !!entry.cwd) ??
        null;
    }

    if (!workspace || !workspace.cwd) {
      res.status(404).json({
        error: "No browsable workspace",
        reason: "no_local_path",
      });
      return null;
    }

    const resolved = path.resolve(workspace.cwd);
    let realRoot: string;
    try {
      realRoot = await fs.realpath(resolved);
      const stat = await fs.stat(realRoot);
      if (!stat.isDirectory()) {
        res.status(404).json({ error: "Workspace path is not a directory", reason: "not_a_directory" });
        return null;
      }
    } catch {
      res.status(404).json({ error: "Workspace path does not exist", reason: "path_missing" });
      return null;
    }

    return { root: resolved, realRoot, workspace };
  }

  async function resolveSandboxedPath(
    realRoot: string,
    requested: string,
  ): Promise<{ ok: true; absolute: string } | { ok: false; reason: "invalid" | "missing" }> {
    const normalized = path.posix.normalize(requested || ".");
    if (normalized.startsWith("..") || normalized.includes("/../") || path.isAbsolute(normalized)) {
      return { ok: false, reason: "invalid" };
    }
    const candidate = path.resolve(realRoot, normalized);
    let real: string;
    try {
      real = await fs.realpath(candidate);
    } catch {
      return { ok: false, reason: "missing" };
    }
    const rel = path.relative(realRoot, real);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return { ok: false, reason: "invalid" };
    }
    return { ok: true, absolute: real };
  }

  router.get("/projects/:id/files/tree", async (req, res) => {
    const ctx = await resolveWorkspaceRoot(req, res);
    if (!ctx) return;

    const requestedPath = typeof req.query.path === "string" ? req.query.path : "";
    const resolved = await resolveSandboxedPath(ctx.realRoot, requestedPath);
    if (!resolved.ok) {
      res.status(resolved.reason === "invalid" ? 400 : 404).json({
        error: resolved.reason === "invalid" ? "Invalid path" : "Directory not found",
      });
      return;
    }

    try {
      const entries = await fs.readdir(resolved.absolute, { withFileTypes: true });
      const items = entries
        .filter((entry) => !IGNORE_NAMES.has(entry.name))
        .slice(0, MAX_TREE_ENTRIES)
        .map((entry) => {
          const isDirectory = entry.isDirectory();
          const ext = isDirectory ? "" : path.extname(entry.name).toLowerCase();
          const viewKind = isDirectory ? null : classifyViewKind(ext);
          return {
            name: entry.name,
            type: isDirectory ? ("directory" as const) : ("file" as const),
            viewable: viewKind !== null,
            viewKind,
            ext,
          };
        })
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      res.json({
        workspaceId: ctx.workspace.id,
        workspaceName: ctx.workspace.name,
        path: requestedPath,
        items,
        truncated: entries.length > MAX_TREE_ENTRIES,
      });
    } catch {
      res.status(404).json({ error: "Directory not found" });
    }
  });

  router.get("/projects/:id/files/content", async (req, res) => {
    const ctx = await resolveWorkspaceRoot(req, res);
    if (!ctx) return;

    const requestedPath = typeof req.query.path === "string" ? req.query.path : "";
    if (!requestedPath) {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }

    const resolved = await resolveSandboxedPath(ctx.realRoot, requestedPath);
    if (!resolved.ok) {
      res.status(resolved.reason === "invalid" ? 400 : 404).json({
        error: resolved.reason === "invalid" ? "Invalid path" : "File not found",
      });
      return;
    }

    const ext = path.extname(resolved.absolute).toLowerCase();
    const viewKind = classifyViewKind(ext);
    if (viewKind !== "markdown" && viewKind !== "text") {
      res.status(415).json({
        error: "Only text-based files can be fetched here. Use /files/raw for images/HTML or /files/download otherwise.",
      });
      return;
    }

    try {
      const stat = await fs.stat(resolved.absolute);
      if (!stat.isFile()) {
        res.status(404).json({ error: "Not a file" });
        return;
      }
      if (stat.size > MAX_VIEW_BYTES) {
        res.status(413).json({ error: `File exceeds ${MAX_VIEW_BYTES} bytes` });
        return;
      }
      const content = await fs.readFile(resolved.absolute, "utf8");
      res.json({
        workspaceId: ctx.workspace.id,
        path: requestedPath,
        content,
        viewKind,
        size: stat.size,
      });
    } catch {
      res.status(404).json({ error: "File not found" });
    }
  });

  // Streams a file inline with its real content type so the UI can render images
  // and HTML directly. HTML/SVG are served with a hardening CSP (and the UI also
  // renders them inside a sandboxed iframe) so embedded scripts can't run in our origin.
  router.get("/projects/:id/files/raw", async (req, res) => {
    const ctx = await resolveWorkspaceRoot(req, res);
    if (!ctx) return;

    const requestedPath = typeof req.query.path === "string" ? req.query.path : "";
    if (!requestedPath) {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }

    const resolved = await resolveSandboxedPath(ctx.realRoot, requestedPath);
    if (!resolved.ok) {
      res.status(resolved.reason === "invalid" ? 400 : 404).json({
        error: resolved.reason === "invalid" ? "Invalid path" : "File not found",
      });
      return;
    }

    const ext = path.extname(resolved.absolute).toLowerCase();
    const viewKind = classifyViewKind(ext);
    if (viewKind !== "image" && viewKind !== "html") {
      res.status(415).json({
        error: "This file type cannot be previewed. Use /files/content for text or /files/download.",
      });
      return;
    }

    try {
      const stat = await fs.stat(resolved.absolute);
      if (!stat.isFile()) {
        res.status(404).json({ error: "Not a file" });
        return;
      }
      if (stat.size > MAX_RAW_BYTES) {
        res.status(413).json({ error: `File exceeds ${MAX_RAW_BYTES} bytes` });
        return;
      }
      const mime = RAW_MIME_BY_EXT[ext] ?? "application/octet-stream";
      res.setHeader("Content-Type", mime);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("Content-Length", String(stat.size));
      // Neutralize active content in HTML and SVG (both can carry scripts). The
      // `sandbox` directive isolates the resource into an opaque origin with no script.
      if (viewKind === "html" || ext === ".svg") {
        res.setHeader(
          "Content-Security-Policy",
          "sandbox; default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; font-src 'self' data:; media-src 'self'",
        );
      }
      createReadStream(resolved.absolute)
        .on("error", () => {
          if (!res.headersSent) {
            res.status(500).json({ error: "Failed to read file" });
          } else {
            res.end();
          }
        })
        .pipe(res);
    } catch {
      res.status(404).json({ error: "File not found" });
    }
  });

  // Streams a directory (or the whole workspace when path is empty) as a zip.
  router.get("/projects/:id/files/download-folder", async (req, res) => {
    const ctx = await resolveWorkspaceRoot(req, res);
    if (!ctx) return;

    const requestedPath = typeof req.query.path === "string" ? req.query.path : "";
    const resolved = await resolveSandboxedPath(ctx.realRoot, requestedPath);
    if (!resolved.ok) {
      res.status(resolved.reason === "invalid" ? 400 : 404).json({
        error: resolved.reason === "invalid" ? "Invalid path" : "Directory not found",
      });
      return;
    }

    let isDirectory = false;
    try {
      isDirectory = (await fs.stat(resolved.absolute)).isDirectory();
    } catch {
      res.status(404).json({ error: "Directory not found" });
      return;
    }
    if (!isDirectory) {
      res.status(400).json({ error: "Not a directory. Use /files/download for single files." });
      return;
    }

    const baseName = path.basename(resolved.absolute) || ctx.workspace.name || "workspace";
    const safeName = baseName.replace(/[\r\n"]/g, "_");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeName}.zip"; filename*=UTF-8''${encodeURIComponent(baseName)}.zip`,
    );

    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.on("error", (err) => {
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to build archive" });
      } else {
        res.destroy(err);
      }
    });
    archive.pipe(res);

    const ignore: string[] = [];
    for (const name of IGNORE_NAMES) {
      ignore.push(name, `${name}/**`, `**/${name}`, `**/${name}/**`);
    }
    archive.glob("**/*", { cwd: resolved.absolute, dot: true, ignore });
    await archive.finalize();
  });

  router.get("/projects/:id/files/download", async (req, res) => {
    const ctx = await resolveWorkspaceRoot(req, res);
    if (!ctx) return;

    const requestedPath = typeof req.query.path === "string" ? req.query.path : "";
    if (!requestedPath) {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }

    const resolved = await resolveSandboxedPath(ctx.realRoot, requestedPath);
    if (!resolved.ok) {
      res.status(resolved.reason === "invalid" ? 400 : 404).json({
        error: resolved.reason === "invalid" ? "Invalid path" : "File not found",
      });
      return;
    }

    try {
      const stat = await fs.stat(resolved.absolute);
      if (!stat.isFile()) {
        res.status(404).json({ error: "Not a file" });
        return;
      }
      if (stat.size > MAX_DOWNLOAD_BYTES) {
        res.status(413).json({ error: `File exceeds ${MAX_DOWNLOAD_BYTES} bytes` });
        return;
      }
      const filename = path.basename(resolved.absolute);
      const safeFilename = filename.replace(/[\r\n"]/g, "_");
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      res.setHeader("Content-Length", String(stat.size));
      createReadStream(resolved.absolute)
        .on("error", () => {
          if (!res.headersSent) {
            res.status(500).json({ error: "Failed to read file" });
          } else {
            res.end();
          }
        })
        .pipe(res);
    } catch {
      res.status(404).json({ error: "File not found" });
    }
  });

  router.get("/projects/:id/files/workspaces", async (req, res) => {
    const projectId = req.params.id as string;
    const project = await svc.getById(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);
    const browsable = await collectBrowsableWorkspaces(projectId, project.companyId);
    res.json({ workspaces: browsable });
  });

  return router;
}
