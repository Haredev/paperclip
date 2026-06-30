import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, FileArchive, FileText, FolderClosed } from "lucide-react";
import { projectsApi } from "../api/projects";
import { ApiError } from "../api/client";
import { MarkdownEditor } from "./MarkdownEditor";
import { ProjectFileTree, type SelectedFileEntry } from "./ProjectFileTree";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";

export interface ProjectFilesContentProps {
  projectId: string;
  companyId?: string;
}

type SelectedFile = SelectedFileEntry;

export function ProjectFilesContent({ projectId, companyId }: ProjectFilesContentProps) {
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);

  const workspacesQuery = useQuery({
    queryKey: ["project-file-workspaces", projectId, companyId ?? null],
    queryFn: () => projectsApi.listFileWorkspaces(projectId, companyId),
  });

  const workspaces = workspacesQuery.data?.workspaces ?? [];

  const activeWorkspaceId = useMemo(() => {
    if (selectedWorkspaceId && workspaces.some((w) => w.id === selectedWorkspaceId)) {
      return selectedWorkspaceId;
    }
    const primary = workspaces.find((w) => w.isPrimary);
    return primary?.id ?? workspaces[0]?.id ?? null;
  }, [selectedWorkspaceId, workspaces]);

  const contentQuery = useQuery({
    queryKey: [
      "project-file-content",
      projectId,
      activeWorkspaceId,
      selectedFile?.path ?? null,
    ],
    queryFn: () =>
      projectsApi.getFileContent(projectId, {
        path: selectedFile!.path,
        workspaceId: activeWorkspaceId ?? undefined,
        companyId,
      }),
    enabled:
      !!selectedFile &&
      !!activeWorkspaceId &&
      (selectedFile.viewKind === "markdown" || selectedFile.viewKind === "text"),
  });

  if (workspacesQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading workspaces…</p>;
  }

  if (workspacesQuery.error) {
    return (
      <p className="text-sm text-destructive">
        Failed to load workspaces:{" "}
        {workspacesQuery.error instanceof Error ? workspacesQuery.error.message : "Unknown error"}
      </p>
    );
  }

  if (workspaces.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center">
        <p className="text-sm text-muted-foreground">
          No browsable workspaces. Add a workspace with a local path under the{" "}
          <span className="font-medium">Workspaces</span> tab to browse its files here.
        </p>
      </div>
    );
  }

  const isDir = selectedFile?.type === "directory";

  const downloadHref =
    selectedFile && activeWorkspaceId
      ? isDir
        ? projectsApi.folderDownloadUrl(projectId, {
            path: selectedFile.path,
            workspaceId: activeWorkspaceId,
            companyId,
          })
        : projectsApi.fileDownloadUrl(projectId, {
            path: selectedFile.path,
            workspaceId: activeWorkspaceId,
            companyId,
          })
      : null;

  const rawHref =
    selectedFile &&
    activeWorkspaceId &&
    (selectedFile.viewKind === "image" || selectedFile.viewKind === "html")
      ? projectsApi.fileRawUrl(projectId, {
          path: selectedFile.path,
          workspaceId: activeWorkspaceId,
          companyId,
        })
      : null;

  const workspaceZipHref = activeWorkspaceId
    ? projectsApi.folderDownloadUrl(projectId, { workspaceId: activeWorkspaceId, companyId })
    : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 text-sm">
        {workspaces.length > 1 ? (
          <div className="flex items-center gap-2">
            <label htmlFor="files-workspace-picker" className="text-muted-foreground">
              Workspace
            </label>
            <select
              id="files-workspace-picker"
              className="rounded border bg-background px-2 py-1 text-sm"
              value={activeWorkspaceId ?? ""}
              onChange={(e) => {
                setSelectedWorkspaceId(e.target.value);
                setSelectedFile(null);
              }}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                  {workspace.isPrimary ? " (primary)" : ""}
                  {workspace.managed ? " (managed)" : ""}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <span />
        )}
        {workspaceZipHref && (
          <Button asChild variant="outline" size="sm">
            <a href={workspaceZipHref}>
              <FileArchive className="h-3.5 w-3.5 mr-1" />
              Download all (zip)
            </a>
          </Button>
        )}
      </div>

      <div className="grid grid-cols-12 gap-4 rounded-lg border bg-background min-h-[60vh]">
        <div className="col-span-4 border-r overflow-auto max-h-[80vh] p-2">
          {activeWorkspaceId ? (
            <ProjectFileTree
              projectId={projectId}
              companyId={companyId}
              workspaceId={activeWorkspaceId}
              selectedPath={selectedFile?.path ?? null}
              onSelectFile={(entry) => setSelectedFile(entry)}
            />
          ) : (
            <p className="p-2 text-xs text-muted-foreground">Select a workspace.</p>
          )}
        </div>

        <div className="col-span-8 overflow-auto max-h-[80vh] p-4">
          {!selectedFile && (
            <p className="text-sm text-muted-foreground">
              Select a file to view it. Markdown, text, images, and HTML render inline; other
              files can be downloaded. Click a folder to select it, then download it as a zip.
            </p>
          )}

          {selectedFile && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2 border-b pb-2">
                <div className="flex items-center gap-2 min-w-0">
                  {isDir ? (
                    <FolderClosed className="h-4 w-4 text-muted-foreground shrink-0" />
                  ) : (
                    <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                  )}
                  <span className="font-mono text-xs truncate" title={selectedFile.path}>
                    {selectedFile.path || "(workspace root)"}
                  </span>
                </div>
                {downloadHref && (
                  <Button asChild variant="outline" size="sm">
                    <a href={downloadHref} {...(isDir ? {} : { download: selectedFile.name })}>
                      {isDir ? (
                        <FileArchive className="h-3.5 w-3.5 mr-1" />
                      ) : (
                        <Download className="h-3.5 w-3.5 mr-1" />
                      )}
                      {isDir ? "Download folder (zip)" : "Download"}
                    </a>
                  </Button>
                )}
              </div>

              {isDir ? (
                <p className="text-sm text-muted-foreground">
                  Folder selected. Use <span className="font-medium">Download folder (zip)</span>{" "}
                  above to download its contents, or expand it in the tree to open individual files.
                </p>
              ) : selectedFile.viewKind === "image" && rawHref ? (
                <div className="flex justify-center rounded border bg-muted/30 p-3">
                  <img
                    src={rawHref}
                    alt={selectedFile.name}
                    className="max-h-[70vh] max-w-full object-contain"
                  />
                </div>
              ) : selectedFile.viewKind === "html" && rawHref ? (
                <iframe
                  // sandbox (no allow-scripts) + a hardening CSP on the response
                  // keep agent-generated HTML from running scripts in our origin.
                  sandbox=""
                  src={rawHref}
                  title={selectedFile.name}
                  className="h-[70vh] w-full rounded border bg-white"
                />
              ) : selectedFile.viewKind === "markdown" || selectedFile.viewKind === "text" ? (
                contentQuery.isLoading ? (
                  <p className="text-sm text-muted-foreground">Loading…</p>
                ) : contentQuery.error ? (
                  <p className="text-sm text-destructive">
                    {contentQuery.error instanceof ApiError
                      ? contentQuery.error.message
                      : "Failed to load file"}
                  </p>
                ) : contentQuery.data ? (
                  selectedFile.viewKind === "markdown" ? (
                    <MarkdownEditor
                      value={contentQuery.data.content}
                      onChange={() => {
                        /* read-only */
                      }}
                      readOnly
                      bordered={false}
                      className={cn("prose prose-sm max-w-none")}
                    />
                  ) : (
                    <pre className="overflow-auto rounded border bg-muted/30 p-3 text-xs">
                      {contentQuery.data.content}
                    </pre>
                  )
                ) : null
              ) : (
                <p className="text-sm text-muted-foreground">
                  This file type can't be previewed inline. Use the Download button to save it.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
