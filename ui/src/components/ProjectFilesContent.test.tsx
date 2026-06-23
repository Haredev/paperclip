// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectFilesContent } from "./ProjectFilesContent";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockProjectsApi = vi.hoisted(() => ({
  listFileWorkspaces: vi.fn(),
  getFileTree: vi.fn(),
  getFileContent: vi.fn(),
  fileDownloadUrl: vi.fn(),
}));

vi.mock("../api/projects", () => ({ projectsApi: mockProjectsApi }));

// MarkdownEditor is heavyweight (Lexical, CodeMirror, etc.) — replace with a simple div.
vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({ value }: { value: string }) => (
    <div data-testid="markdown-editor">{value}</div>
  ),
}));

// Tree is exercised in its own integration tests; here we just need a stable double.
vi.mock("./ProjectFileTree", () => ({
  ProjectFileTree: ({
    onSelectFile,
  }: {
    onSelectFile: (entry: { path: string; viewable: boolean; ext: string; name: string }) => void;
  }) => (
    <button
      type="button"
      data-testid="tree-select-md"
      onClick={() =>
        onSelectFile({ path: "README.md", viewable: true, ext: ".md", name: "README.md" })
      }
    >
      pick-md
    </button>
  ),
}));

describe("ProjectFilesContent", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockProjectsApi.listFileWorkspaces.mockReset();
    mockProjectsApi.getFileTree.mockReset();
    mockProjectsApi.getFileContent.mockReset();
    mockProjectsApi.fileDownloadUrl.mockReset();
    mockProjectsApi.fileDownloadUrl.mockImplementation(
      (projectId: string, params: { path: string; workspaceId?: string }) =>
        `/api/projects/${projectId}/files/download?path=${params.path}&workspaceId=${params.workspaceId}`,
    );
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={client}>
          <ProjectFilesContent projectId="project-1" companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("shows empty state when project has no browsable workspaces", async () => {
    mockProjectsApi.listFileWorkspaces.mockResolvedValue({ workspaces: [] });
    await render();
    expect(container.textContent).toContain("No browsable workspaces");
  });

  it("hides the workspace picker when there is exactly one workspace", async () => {
    mockProjectsApi.listFileWorkspaces.mockResolvedValue({
      workspaces: [
        { id: "ws-1", name: "main", cwd: "/tmp/a", isPrimary: true, sourceType: "local_path" },
      ],
    });
    await render();
    expect(container.querySelector("#files-workspace-picker")).toBeNull();
  });

  it("shows the workspace picker when multiple workspaces are browsable", async () => {
    mockProjectsApi.listFileWorkspaces.mockResolvedValue({
      workspaces: [
        { id: "ws-1", name: "main", cwd: "/tmp/a", isPrimary: true, sourceType: "local_path" },
        { id: "ws-2", name: "alt", cwd: "/tmp/b", isPrimary: false, sourceType: "local_path" },
      ],
    });
    await render();
    expect(container.querySelector("#files-workspace-picker")).not.toBeNull();
  });

  it("renders markdown content via MarkdownEditor when a viewable file is selected", async () => {
    mockProjectsApi.listFileWorkspaces.mockResolvedValue({
      workspaces: [
        { id: "ws-1", name: "main", cwd: "/tmp/a", isPrimary: true, sourceType: "local_path" },
      ],
    });
    mockProjectsApi.getFileContent.mockResolvedValue({
      workspaceId: "ws-1",
      path: "README.md",
      content: "# hello",
      size: 7,
    });
    await render();

    await act(async () => {
      const button = container.querySelector<HTMLButtonElement>("[data-testid=tree-select-md]");
      button?.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector("[data-testid=markdown-editor]")?.textContent).toBe("# hello");
    expect(mockProjectsApi.getFileContent).toHaveBeenCalledWith("project-1", {
      path: "README.md",
      workspaceId: "ws-1",
      companyId: "company-1",
    });
    const downloadLink = container.querySelector<HTMLAnchorElement>("a[download]");
    expect(downloadLink?.getAttribute("href")).toBe(
      "/api/projects/project-1/files/download?path=README.md&workspaceId=ws-1",
    );
  });
});
