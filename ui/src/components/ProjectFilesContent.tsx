import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, FileText } from "lucide-react";
import { projectsApi } from "../api/projects";
import { ApiError } from "../api/client";
import { MarkdownEditor } from "./MarkdownEditor";
import { ProjectFileTree } from "./ProjectFileTree";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";

export interface ProjectFilesContentProps {
  projectId: string;
  companyId?: string;
}

type SelectedFile = {
  path: string;
  name: string;
  ext: string;
  viewable: boolean;
};

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
    enabled: !!selectedFile && selectedFile.viewable && !!activeWorkspaceId,
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

  const downloadHref = selectedFile && activeWorkspaceId
    ? projectsApi.fileDownloadUrl(projectId, {
        path: selectedFile.path,
        workspaceId: activeWorkspaceId,
        companyId,
      })
    : null;

  return (
    <div className="space-y-3">
      {workspaces.length > 1 && (
        <div className="flex items-center gap-2 text-sm">
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
              </option>
            ))}
          </select>
        </div>
      )}

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
              Select a file to view it. Only <code>.md</code> and <code>.mdx</code> files render inline;
              other files can be downloaded.
            </p>
          )}

          {selectedFile && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2 border-b pb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="font-mono text-xs truncate" title={selectedFile.path}>
                    {selectedFile.path}
                  </span>
                </div>
                {downloadHref && (
                  <Button asChild variant="outline" size="sm">
                    <a href={downloadHref} download={selectedFile.name}>
                      <Download className="h-3.5 w-3.5 mr-1" />
                      Download
                    </a>
                  </Button>
                )}
              </div>

              {selectedFile.viewable ? (
                contentQuery.isLoading ? (
                  <p className="text-sm text-muted-foreground">Loading…</p>
                ) : contentQuery.error ? (
                  <p className="text-sm text-destructive">
                    {contentQuery.error instanceof ApiError
                      ? contentQuery.error.message
                      : "Failed to load file"}
                  </p>
                ) : contentQuery.data ? (
                  <MarkdownEditor
                    value={contentQuery.data.content}
                    onChange={() => {
                      /* read-only */
                    }}
                    readOnly
                    bordered={false}
                    className={cn("prose prose-sm max-w-none")}
                  />
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
