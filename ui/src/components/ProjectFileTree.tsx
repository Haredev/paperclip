import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  FileImage,
  Globe,
  File as FileIcon,
  FolderClosed,
} from "lucide-react";
import { projectsApi, type FileViewKind } from "../api/projects";
import { ApiError } from "../api/client";
import { cn } from "../lib/utils";

export type SelectedFileEntry = {
  path: string;
  name: string;
  ext: string;
  type: "file" | "directory";
  viewable: boolean;
  viewKind: FileViewKind | null;
};

export interface ProjectFileTreeProps {
  projectId: string;
  companyId?: string;
  workspaceId?: string;
  /** Currently selected path (file). When matched, the row is highlighted. */
  selectedPath: string | null;
  onSelectFile: (entry: SelectedFileEntry) => void;
}

type Entry = {
  name: string;
  type: "directory" | "file";
  viewable: boolean;
  viewKind: FileViewKind | null;
  ext: string;
};

function fileIconFor(viewKind: FileViewKind | null) {
  if (viewKind === "image") return <FileImage className="h-3.5 w-3.5 text-emerald-500" />;
  if (viewKind === "html") return <Globe className="h-3.5 w-3.5 text-orange-500" />;
  if (viewKind === "markdown" || viewKind === "text") {
    return <FileText className="h-3.5 w-3.5 text-blue-500" />;
  }
  return <FileIcon className="h-3.5 w-3.5 text-muted-foreground" />;
}

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
          const isSelected = selectedPath === fullPath;
          return (
            <li key={entry.name}>
              <div
                className={cn(
                  "flex w-full items-center rounded hover:bg-muted/60",
                  isSelected && "bg-muted",
                )}
              >
                <button
                  type="button"
                  onClick={() =>
                    setExpanded((prev) => ({ ...prev, [entry.name]: !prev[entry.name] }))
                  }
                  className="shrink-0 rounded p-1 hover:bg-muted"
                  title={isOpen ? "Collapse" : "Expand"}
                  style={{ marginLeft: depth * 12 + 4 }}
                >
                  {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setExpanded((prev) => ({ ...prev, [entry.name]: true }));
                    onSelectFile({
                      path: fullPath,
                      name: entry.name,
                      ext: "",
                      viewable: false,
                      viewKind: null,
                      type: "directory",
                    });
                  }}
                  className="flex min-w-0 flex-1 items-center gap-1 px-1 py-1 text-left"
                >
                  <FolderClosed className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="truncate">{entry.name}</span>
                </button>
              </div>
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
                onSelectFile({
                  path: fullPath,
                  viewable: entry.viewable,
                  viewKind: entry.viewKind,
                  ext: entry.ext,
                  name: entry.name,
                  type: "file",
                })
              }
              className={cn(
                "flex w-full items-center gap-1 rounded px-2 py-1 text-left hover:bg-muted/60",
                isSelected && "bg-muted",
              )}
              style={{ paddingLeft: depth * 12 + 8 + 16 }}
            >
              {fileIconFor(entry.viewKind)}
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
