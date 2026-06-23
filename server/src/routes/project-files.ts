import { Router, type Request, type Response } from "express";
import { promises as fs, createReadStream } from "node:fs";
import * as path from "node:path";
import type { Db } from "@paperclipai/db";
import type { ProjectWorkspace } from "@paperclipai/shared";
import { projectService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

const VIEWABLE_EXTS = new Set([".md", ".mdx"]);
const MAX_TREE_ENTRIES = 5_000;
const MAX_VIEW_BYTES = 2 * 1024 * 1024;
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

type ResolvedWorkspace = {
  root: string;
  realRoot: string;
  workspace: ProjectWorkspace;
};

export function projectFileRoutes(db: Db) {
  const router = Router();
  const svc = projectService(db);

  async function resolveWorkspaceRoot(req: Request, res: Response): Promise<ResolvedWorkspace | null> {
    const projectId = req.params.id as string;
    const project = await svc.getById(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return null;
    }
    assertCompanyAccess(req, project.companyId);

    const workspaces = await svc.listWorkspaces(projectId);
    const requestedId = typeof req.query.workspaceId === "string" ? req.query.workspaceId.trim() : "";

    let workspace: ProjectWorkspace | null = null;
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
          return {
            name: entry.name,
            type: isDirectory ? ("directory" as const) : ("file" as const),
            viewable: !isDirectory && VIEWABLE_EXTS.has(ext),
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
    if (!VIEWABLE_EXTS.has(ext)) {
      res.status(415).json({
        error: "Only .md and .mdx files can be viewed inline. Use /files/download for other files.",
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
        size: stat.size,
      });
    } catch {
      res.status(404).json({ error: "File not found" });
    }
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
    const workspaces = await svc.listWorkspaces(projectId);
    const browsable = workspaces
      .filter((entry) => !!entry.cwd)
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        cwd: entry.cwd,
        isPrimary: entry.isPrimary,
        sourceType: entry.sourceType,
      }));
    res.json({ workspaces: browsable });
  });

  return router;
}
