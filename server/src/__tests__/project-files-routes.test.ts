import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  listWorkspaces: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

const EXECUTION_WORKSPACE_READ_CONDITION = vi.hoisted(() => ({ sql: "execution-workspace-read-condition" }));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  projectService: () => mockProjectService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
}));

vi.mock("../services/authorization.js", () => ({
  executionWorkspaceReadSqlCondition: vi.fn(async () => EXECUTION_WORKSPACE_READ_CONDITION),
}));

async function createApp() {
  vi.resetModules();
  const [{ errorHandler }, { projectFileRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/project-files.js") as Promise<typeof import("../routes/project-files.js")>,
  ]);
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", projectFileRoutes({} as never));
  app.use(errorHandler);
  return app;
}

async function runRequest<T>(
  app: express.Express,
  buildRequest: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

const PROJECT = {
  id: "project-1",
  companyId: "company-1",
};

const baseWorkspace = {
  id: "workspace-1",
  companyId: "company-1",
  projectId: "project-1",
  name: "main",
  sourceType: "local_path" as const,
  cwd: null as string | null,
  repoUrl: null,
  repoRef: null,
  defaultRef: null,
  visibility: "default" as const,
  setupCommand: null,
  cleanupCommand: null,
  remoteProvider: null,
  remoteWorkspaceRef: null,
  sharedWorkspaceKey: null,
  metadata: null,
  runtimeConfig: null,
  isPrimary: true,
  runtimeServices: [],
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("project files routes", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    mockProjectService.getById.mockReset();
    mockProjectService.listWorkspaces.mockReset();
    mockExecutionWorkspaceService.list.mockReset();
    // Default: no managed execution workspaces (keeps existing tests behaviour).
    mockExecutionWorkspaceService.list.mockResolvedValue([]);
    mockAccessService.decide.mockReset();
    mockAccessService.decide.mockResolvedValue({ allowed: true });
    tmpRoot = await mkdtemp(path.join(tmpdir(), "paperclip-files-test-"));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("answers 404 without touching the filesystem when project:read is denied", async () => {
    mockProjectService.getById.mockResolvedValue(PROJECT);
    mockProjectService.listWorkspaces.mockResolvedValue([{ ...baseWorkspace, cwd: tmpRoot }]);
    mockAccessService.decide.mockResolvedValue({ allowed: false, explanation: "private project" });
    await writeFile(path.join(tmpRoot, "secret.md"), "# secret");

    const app = await createApp();
    for (const route of ["workspaces", "tree", "content?path=secret.md", "download?path=secret.md"]) {
      const response = await runRequest(app, (baseUrl) =>
        request(baseUrl).get(`/api/projects/${PROJECT.id}/files/${route}`).expect(404),
      );
      expect(response.body).toEqual({ error: "Project not found" });
    }
    expect(mockAccessService.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "project:read",
        resource: { type: "project", companyId: PROJECT.companyId, projectId: PROJECT.id },
      }),
    );
    expect(mockProjectService.listWorkspaces).not.toHaveBeenCalled();
  });

  it("answers 404 for a project in a company the actor cannot access", async () => {
    mockProjectService.getById.mockResolvedValue({ ...PROJECT, companyId: "company-other" });

    const app = await createApp();
    const response = await runRequest(app, (baseUrl) =>
      request(baseUrl).get(`/api/projects/${PROJECT.id}/files/workspaces`).expect(404),
    );
    expect(response.body).toEqual({ error: "Project not found" });
    expect(mockAccessService.decide).not.toHaveBeenCalled();
  });

  it("lists managed execution workspaces through the actor's read condition", async () => {
    mockProjectService.getById.mockResolvedValue(PROJECT);
    mockProjectService.listWorkspaces.mockResolvedValue([]);

    const app = await createApp();
    await runRequest(app, (baseUrl) =>
      request(baseUrl).get(`/api/projects/${PROJECT.id}/files/workspaces`).expect(200),
    );
    expect(mockExecutionWorkspaceService.list).toHaveBeenCalledWith(PROJECT.companyId, {
      projectId: PROJECT.id,
      status: "active",
      readCondition: EXECUTION_WORKSPACE_READ_CONDITION,
    });
  });

  it("returns 404 with reason no_local_path when project has no browsable workspaces", async () => {
    mockProjectService.getById.mockResolvedValue(PROJECT);
    mockProjectService.listWorkspaces.mockResolvedValue([{ ...baseWorkspace, cwd: null }]);

    const app = await createApp();
    const response = await runRequest(app, (baseUrl) =>
      request(baseUrl).get(`/api/projects/${PROJECT.id}/files/tree`).expect(404),
    );
    expect(response.body).toEqual({ error: "No browsable workspace", reason: "no_local_path" });
  });

  it("returns 404 reason path_missing when the workspace cwd does not exist", async () => {
    mockProjectService.getById.mockResolvedValue(PROJECT);
    mockProjectService.listWorkspaces.mockResolvedValue([
      { ...baseWorkspace, cwd: path.join(tmpRoot, "does-not-exist") },
    ]);

    const app = await createApp();
    const response = await runRequest(app, (baseUrl) =>
      request(baseUrl).get(`/api/projects/${PROJECT.id}/files/tree`).expect(404),
    );
    expect(response.body).toMatchObject({ reason: "path_missing" });
  });

  it("lists tree entries for the primary workspace", async () => {
    await writeFile(path.join(tmpRoot, "README.md"), "# hello");
    await writeFile(path.join(tmpRoot, "config.yaml"), "key: value");
    await mkdir(path.join(tmpRoot, "docs"));
    await mkdir(path.join(tmpRoot, "node_modules"));
    await writeFile(path.join(tmpRoot, "node_modules", "ignored.txt"), "no");

    mockProjectService.getById.mockResolvedValue(PROJECT);
    mockProjectService.listWorkspaces.mockResolvedValue([{ ...baseWorkspace, cwd: tmpRoot }]);

    const app = await createApp();
    const response = await runRequest(app, (baseUrl) =>
      request(baseUrl).get(`/api/projects/${PROJECT.id}/files/tree`).expect(200),
    );
    const names = response.body.items.map((entry: { name: string }) => entry.name);
    expect(names).toEqual(["docs", "config.yaml", "README.md"]);
    const readme = response.body.items.find((entry: { name: string }) => entry.name === "README.md");
    expect(readme).toMatchObject({ type: "file", viewable: true, viewKind: "markdown", ext: ".md" });
    const yaml = response.body.items.find((entry: { name: string }) => entry.name === "config.yaml");
    expect(yaml).toMatchObject({ type: "file", viewable: true, viewKind: "text" });
    expect(names).not.toContain("node_modules");
  });

  it("classifies images and html as viewable in the tree", async () => {
    await writeFile(path.join(tmpRoot, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(tmpRoot, "report.html"), "<h1>hi</h1>");
    mockProjectService.getById.mockResolvedValue(PROJECT);
    mockProjectService.listWorkspaces.mockResolvedValue([{ ...baseWorkspace, cwd: tmpRoot }]);

    const app = await createApp();
    const response = await runRequest(app, (baseUrl) =>
      request(baseUrl).get(`/api/projects/${PROJECT.id}/files/tree`).expect(200),
    );
    const png = response.body.items.find((e: { name: string }) => e.name === "logo.png");
    const html = response.body.items.find((e: { name: string }) => e.name === "report.html");
    expect(png).toMatchObject({ viewable: true, viewKind: "image" });
    expect(html).toMatchObject({ viewable: true, viewKind: "html" });
  });

  it("rejects path-traversal attempts with 400", async () => {
    mockProjectService.getById.mockResolvedValue(PROJECT);
    mockProjectService.listWorkspaces.mockResolvedValue([{ ...baseWorkspace, cwd: tmpRoot }]);

    const app = await createApp();
    for (const evilPath of ["..", "../etc/passwd", "../../etc/passwd", "/etc/passwd"]) {
      await runRequest(app, (baseUrl) =>
        request(baseUrl)
          .get(`/api/projects/${PROJECT.id}/files/tree`)
          .query({ path: evilPath })
          .expect(400),
      );
    }
  });

  it("rejects symlinks that escape the workspace root", async () => {
    const outsideTarget = await mkdtemp(path.join(tmpdir(), "paperclip-outside-"));
    try {
      await symlink(outsideTarget, path.join(tmpRoot, "escape"));
      mockProjectService.getById.mockResolvedValue(PROJECT);
      mockProjectService.listWorkspaces.mockResolvedValue([{ ...baseWorkspace, cwd: tmpRoot }]);

      const app = await createApp();
      await runRequest(app, (baseUrl) =>
        request(baseUrl)
          .get(`/api/projects/${PROJECT.id}/files/tree`)
          .query({ path: "escape" })
          .expect(400),
      );
    } finally {
      await rm(outsideTarget, { recursive: true, force: true });
    }
  });

  it("returns markdown content via /files/content", async () => {
    await writeFile(path.join(tmpRoot, "doc.md"), "# heading\n\nbody");
    mockProjectService.getById.mockResolvedValue(PROJECT);
    mockProjectService.listWorkspaces.mockResolvedValue([{ ...baseWorkspace, cwd: tmpRoot }]);

    const app = await createApp();
    const response = await runRequest(app, (baseUrl) =>
      request(baseUrl)
        .get(`/api/projects/${PROJECT.id}/files/content`)
        .query({ path: "doc.md" })
        .expect(200),
    );
    expect(response.body).toMatchObject({
      path: "doc.md",
      content: "# heading\n\nbody",
      size: "# heading\n\nbody".length,
    });
  });

  it("serves text files (e.g. yaml) via /files/content", async () => {
    await writeFile(path.join(tmpRoot, "config.yaml"), "k: v");
    mockProjectService.getById.mockResolvedValue(PROJECT);
    mockProjectService.listWorkspaces.mockResolvedValue([{ ...baseWorkspace, cwd: tmpRoot }]);

    const app = await createApp();
    const response = await runRequest(app, (baseUrl) =>
      request(baseUrl)
        .get(`/api/projects/${PROJECT.id}/files/content`)
        .query({ path: "config.yaml" })
        .expect(200),
    );
    expect(response.body).toMatchObject({ content: "k: v", viewKind: "text" });
  });

  it("rejects /files/content for image extensions with 415", async () => {
    await writeFile(path.join(tmpRoot, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    mockProjectService.getById.mockResolvedValue(PROJECT);
    mockProjectService.listWorkspaces.mockResolvedValue([{ ...baseWorkspace, cwd: tmpRoot }]);

    const app = await createApp();
    await runRequest(app, (baseUrl) =>
      request(baseUrl)
        .get(`/api/projects/${PROJECT.id}/files/content`)
        .query({ path: "pic.png" })
        .expect(415),
    );
  });

  it("serves images inline via /files/raw with the real content type", async () => {
    await writeFile(path.join(tmpRoot, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]));
    mockProjectService.getById.mockResolvedValue(PROJECT);
    mockProjectService.listWorkspaces.mockResolvedValue([{ ...baseWorkspace, cwd: tmpRoot }]);

    const app = await createApp();
    const response = await runRequest(app, (baseUrl) =>
      request(baseUrl)
        .get(`/api/projects/${PROJECT.id}/files/raw`)
        .query({ path: "logo.png" })
        .expect(200),
    );
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["content-disposition"]).toBe("inline");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("serves html inline via /files/raw with a hardening sandbox CSP", async () => {
    await writeFile(path.join(tmpRoot, "report.html"), "<h1>hi</h1>");
    mockProjectService.getById.mockResolvedValue(PROJECT);
    mockProjectService.listWorkspaces.mockResolvedValue([{ ...baseWorkspace, cwd: tmpRoot }]);

    const app = await createApp();
    const response = await runRequest(app, (baseUrl) =>
      request(baseUrl)
        .get(`/api/projects/${PROJECT.id}/files/raw`)
        .query({ path: "report.html" })
        .expect(200),
    );
    expect(response.headers["content-type"]).toMatch(/^text\/html/);
    expect(response.headers["content-security-policy"]).toContain("sandbox");
  });

  it("rejects /files/raw for text files with 415", async () => {
    await writeFile(path.join(tmpRoot, "notes.txt"), "hi");
    mockProjectService.getById.mockResolvedValue(PROJECT);
    mockProjectService.listWorkspaces.mockResolvedValue([{ ...baseWorkspace, cwd: tmpRoot }]);

    const app = await createApp();
    await runRequest(app, (baseUrl) =>
      request(baseUrl)
        .get(`/api/projects/${PROJECT.id}/files/raw`)
        .query({ path: "notes.txt" })
        .expect(415),
    );
  });

  it("zips a folder via /files/download-folder", async () => {
    await mkdir(path.join(tmpRoot, "sub"));
    await writeFile(path.join(tmpRoot, "sub", "a.txt"), "alpha");
    await writeFile(path.join(tmpRoot, "sub", "b.txt"), "bravo");
    mockProjectService.getById.mockResolvedValue(PROJECT);
    mockProjectService.listWorkspaces.mockResolvedValue([{ ...baseWorkspace, cwd: tmpRoot }]);

    const app = await createApp();
    const response = await runRequest(app, (baseUrl) =>
      request(baseUrl)
        .get(`/api/projects/${PROJECT.id}/files/download-folder`)
        .query({ path: "sub" })
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200),
    );
    expect(response.headers["content-type"]).toBe("application/zip");
    expect(response.headers["content-disposition"]).toMatch(/attachment; filename="sub\.zip"/);
    // Zip local-file-header magic bytes "PK\x03\x04".
    const body = Buffer.from(response.body as ArrayBufferLike);
    expect(body.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  it("zips in-root symlinks as content and skips links that escape the workspace", async () => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), "paperclip-files-outside-"));
    try {
      await writeFile(path.join(outsideDir, "secret.txt"), "outside-secret");
      await writeFile(path.join(tmpRoot, "real.txt"), "inside");
      await symlink(path.join(tmpRoot, "real.txt"), path.join(tmpRoot, "inside-link.txt"));
      await symlink(path.join(outsideDir, "secret.txt"), path.join(tmpRoot, "escape-file.txt"));
      await symlink(outsideDir, path.join(tmpRoot, "escape-dir"));
      await symlink(tmpRoot, path.join(tmpRoot, "loop-dir"));
      mockProjectService.getById.mockResolvedValue(PROJECT);
      mockProjectService.listWorkspaces.mockResolvedValue([{ ...baseWorkspace, cwd: tmpRoot }]);

      const app = await createApp();
      const response = await runRequest(app, (baseUrl) =>
        request(baseUrl)
          .get(`/api/projects/${PROJECT.id}/files/download-folder`)
          .buffer(true)
          .parse((res, callback) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => callback(null, Buffer.concat(chunks)));
          })
          .expect(200),
      );
      // Entry names are stored uncompressed in the zip headers.
      const body = Buffer.from(response.body as ArrayBufferLike).toString("latin1");
      expect(body).toContain("real.txt");
      expect(body).toContain("inside-link.txt");
      expect(body).not.toContain("escape-file.txt");
      expect(body).not.toContain("escape-dir");
      expect(body).not.toContain("loop-dir");
      expect(body).not.toContain("secret.txt");
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects /files/download-folder on a file path with 400", async () => {
    await writeFile(path.join(tmpRoot, "single.txt"), "x");
    mockProjectService.getById.mockResolvedValue(PROJECT);
    mockProjectService.listWorkspaces.mockResolvedValue([{ ...baseWorkspace, cwd: tmpRoot }]);

    const app = await createApp();
    await runRequest(app, (baseUrl) =>
      request(baseUrl)
        .get(`/api/projects/${PROJECT.id}/files/download-folder`)
        .query({ path: "single.txt" })
        .expect(400),
    );
  });

  it("streams any file via /files/download with attachment headers", async () => {
    await writeFile(path.join(tmpRoot, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    mockProjectService.getById.mockResolvedValue(PROJECT);
    mockProjectService.listWorkspaces.mockResolvedValue([{ ...baseWorkspace, cwd: tmpRoot }]);

    const app = await createApp();
    const response = await runRequest(app, (baseUrl) =>
      request(baseUrl)
        .get(`/api/projects/${PROJECT.id}/files/download`)
        .query({ path: "binary.bin" })
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200),
    );
    expect(response.headers["content-disposition"]).toMatch(/attachment; filename="binary\.bin"/);
    expect(response.headers["content-length"]).toBe("4");
    expect(Buffer.from(response.body as ArrayBufferLike).equals(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBe(true);
  });

  it("lists browsable workspaces filtering out remote_managed without cwd", async () => {
    mockProjectService.getById.mockResolvedValue(PROJECT);
    mockProjectService.listWorkspaces.mockResolvedValue([
      { ...baseWorkspace, id: "ws-local", cwd: tmpRoot, isPrimary: true },
      { ...baseWorkspace, id: "ws-remote", cwd: null, sourceType: "remote_managed", isPrimary: false },
    ]);

    const app = await createApp();
    const response = await runRequest(app, (baseUrl) =>
      request(baseUrl).get(`/api/projects/${PROJECT.id}/files/workspaces`).expect(200),
    );
    expect(response.body.workspaces).toHaveLength(1);
    expect(response.body.workspaces[0].id).toBe("ws-local");
  });

  it("includes managed execution workspaces and dedupes against declared paths", async () => {
    const managedDir = await mkdtemp(path.join(tmpdir(), "paperclip-managed-"));
    try {
      mockProjectService.getById.mockResolvedValue(PROJECT);
      mockProjectService.listWorkspaces.mockResolvedValue([
        { ...baseWorkspace, id: "ws-declared", cwd: tmpRoot, isPrimary: true },
      ]);
      mockExecutionWorkspaceService.list.mockResolvedValue([
        // Same path as the declared workspace -> filtered out as a duplicate.
        { id: "ew-dup", name: "MAR-1", cwd: tmpRoot, providerType: "local_fs", status: "active" },
        // Distinct local dir -> surfaced as a managed workspace.
        { id: "ew-managed", name: "MAR-2", cwd: managedDir, providerType: "local_fs", status: "active" },
        // Non-local provider -> excluded.
        { id: "ew-remote", name: "MAR-3", cwd: "/elsewhere", providerType: "remote", status: "active" },
      ]);

      const app = await createApp();
      const response = await runRequest(app, (baseUrl) =>
        request(baseUrl).get(`/api/projects/${PROJECT.id}/files/workspaces`).expect(200),
      );
      const ids = response.body.workspaces.map((w: { id: string }) => w.id);
      expect(ids).toEqual(["ws-declared", "ew-managed"]);
      expect(response.body.workspaces.find((w: { id: string }) => w.id === "ew-managed")).toMatchObject({
        managed: true,
        sourceType: "managed",
      });
      expect(response.body.workspaces.find((w: { id: string }) => w.id === "ws-declared")).toMatchObject({
        managed: false,
      });
    } finally {
      await rm(managedDir, { recursive: true, force: true });
    }
  });

  it("browses a managed workspace when the project has no declared workspace", async () => {
    await writeFile(path.join(tmpRoot, "managed-note.md"), "# managed");
    mockProjectService.getById.mockResolvedValue(PROJECT);
    mockProjectService.listWorkspaces.mockResolvedValue([]);
    mockExecutionWorkspaceService.list.mockResolvedValue([
      { id: "ew-1", name: "MAR-9", cwd: tmpRoot, providerType: "local_fs", status: "active" },
    ]);

    const app = await createApp();
    const response = await runRequest(app, (baseUrl) =>
      request(baseUrl).get(`/api/projects/${PROJECT.id}/files/tree`).expect(200),
    );
    const names = response.body.items.map((e: { name: string }) => e.name);
    expect(names).toContain("managed-note.md");
    expect(response.body.workspaceId).toBe("ew-1");
  });

  it("returns 404 when project not found", async () => {
    mockProjectService.getById.mockResolvedValue(null);
    const app = await createApp();
    await runRequest(app, (baseUrl) =>
      request(baseUrl).get(`/api/projects/missing/files/tree`).expect(404),
    );
  });
});
