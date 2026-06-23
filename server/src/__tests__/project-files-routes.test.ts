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

vi.mock("../services/index.js", () => ({
  projectService: () => mockProjectService,
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

describe.sequential("project files routes", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    mockProjectService.getById.mockReset();
    mockProjectService.listWorkspaces.mockReset();
    tmpRoot = await mkdtemp(path.join(tmpdir(), "paperclip-files-test-"));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
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
    expect(readme).toMatchObject({ type: "file", viewable: true, ext: ".md" });
    const yaml = response.body.items.find((entry: { name: string }) => entry.name === "config.yaml");
    expect(yaml).toMatchObject({ type: "file", viewable: false });
    expect(names).not.toContain("node_modules");
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

  it("rejects /files/content for non-markdown extensions with 415", async () => {
    await writeFile(path.join(tmpRoot, "config.yaml"), "k: v");
    mockProjectService.getById.mockResolvedValue(PROJECT);
    mockProjectService.listWorkspaces.mockResolvedValue([{ ...baseWorkspace, cwd: tmpRoot }]);

    const app = await createApp();
    await runRequest(app, (baseUrl) =>
      request(baseUrl)
        .get(`/api/projects/${PROJECT.id}/files/content`)
        .query({ path: "config.yaml" })
        .expect(415),
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

  it("returns 404 when project not found", async () => {
    mockProjectService.getById.mockResolvedValue(null);
    const app = await createApp();
    await runRequest(app, (baseUrl) =>
      request(baseUrl).get(`/api/projects/missing/files/tree`).expect(404),
    );
  });
});
