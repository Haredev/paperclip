import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FileText, File as FileIcon, FolderClosed } from "lucide-react";
import { projectsApi } from "../api/projects";
import { ApiError } from "../api/client";
import { cn } from "../lib/utils";

export interface ProjectFileTreeProps {
  projectId: string;
  companyId?: string;
  workspaceId?: string;
  /** Currently selected path (file). When matched, the row is highlighted. */
  selectedPath: string | null;
  onSelectFile: (entry: { path: string; viewable: boolean; ext: string; name: string }) => void;
}

type Entry = {
  name: string;
  type: "directory" | "file";
  viewable: boolean;
  ext: string;
};

type LoadedDir = {
  state: "loading" | "loaded" | "error";
  items: Entry[];
  error?: string;
};

function joinPath(parent: string, name: string): string {
  if (!parent) return name;
  return `${parent}/${name}`;
}

function DirectoryNode({
  projectId,
  companyId,
  workspaceId,
  parentPath,
  depth,
  selectedPath,
  onSelectFile,
}: {
  projectId: string;
  companyId?: string;
  workspaceId?: string;
  parentPath: string;
  depth: number;
  selectedPath: string | null;
  onSelectFile: ProjectFileTreeProps["onSelectFile"];
}) {
  const [loaded, setLoaded] = useState<LoadedDir | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoaded({ state: "loading", items: [] });
    try {
      const response = await projectsApi.getFileTree(projectId, {
        path: parentPath,
        workspaceId,
        companyId,
      });
      setLoaded({ state: "loaded", items: response.items });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to load directory";
      setLoaded({ state: "error", items: [], error: message });
    }
  }, [projectId, companyId, workspaceId, parentPath]);

  useEffect(() => {
    load();
  }, [load]);

  if (!loaded || loaded.state === "loading") {
    return (
      <div className="pl-4 py-1 text-xs text-muted-foreground" style={{ paddingLeft: depth * 12 + 8 }}>
        Loading…
      </div>
    );
  }
  if (loaded.state === "error") {
    return (
      <div className="pl-4 py-1 text-xs text-destructive" style={{ paddingLeft: depth * 12 + 8 }}>
        {loaded.error}
      </div>
    );
  }
  if (loaded.items.length === 0) {
    return (
      <div className="pl-4 py-1 text-xs text-muted-foreground" style={{ paddingLeft: depth * 12 + 8 }}>
        Empty
      </div>
    );
  }

  return (
    <ul className="text-sm">
      {loaded.items.map((entry) => {
        const fullPath = joinPath(parentPath, entry.name);
        if (entry.type === "directory") {
          const isOpen = !!expanded[entry.name];
          return (
            <li key={entry.name}>
              <button
                type="button"
                onClick={() =>
                  setExpanded((prev) => ({ ...prev, [entry.name]: !prev[entry.name] }))
                }
                className="flex w-full items-center gap-1 rounded px-2 py-1 text-left hover:bg-muted/60"
                style={{ paddingLeft: depth * 12 + 8 }}
              >
                {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <FolderClosed className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="truncate">{entry.name}</span>
              </button>
              {isOpen && (
                <DirectoryNode
                  projectId={projectId}
                  companyId={companyId}
                  workspaceId={workspaceId}
                  parentPath={fullPath}
                  depth={depth + 1}
                  selectedPath={selectedPath}
                  onSelectFile={onSelectFile}
                />
              )}
            </li>
          );
        }
        const isSelected = selectedPath === fullPath;
        return (
          <li key={entry.name}>
            <button
              type="button"
              onClick={() =>
                onSelectFile({ path: fullPath, viewable: entry.viewable, ext: entry.ext, name: entry.name })
              }
              className={cn(
                "flex w-full items-center gap-1 rounded px-2 py-1 text-left hover:bg-muted/60",
                isSelected && "bg-muted",
              )}
              style={{ paddingLeft: depth * 12 + 8 + 16 }}
            >
              {entry.viewable ? (
                <FileText className="h-3.5 w-3.5 text-blue-500" />
              ) : (
                <FileIcon className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <span className={cn("truncate", !entry.viewable && "text-muted-foreground")}>
                {entry.name}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function ProjectFileTree({
  projectId,
  companyId,
  workspaceId,
  selectedPath,
  onSelectFile,
}: ProjectFileTreeProps) {
  return (
    <DirectoryNode
      projectId={projectId}
      companyId={companyId}
      workspaceId={workspaceId}
      parentPath=""
      depth={0}
      selectedPath={selectedPath}
      onSelectFile={onSelectFile}
    />
  );
}
