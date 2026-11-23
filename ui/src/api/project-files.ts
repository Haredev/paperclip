// Fork (Haredev): API client for the project Files tab
// (server/src/routes/project-files.ts). Kept out of api/projects.ts so
// upstream changes to that file don't conflict with the fork.
import { api } from "./client";

function withCompanyScope(path: string, companyId?: string) {
  if (!companyId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}companyId=${encodeURIComponent(companyId)}`;
}

export type FileViewKind = "markdown" | "text" | "image" | "html";

export const projectFilesApi = {
  listFileWorkspaces: (projectId: string, companyId?: string) =>
    api.get<{
      workspaces: Array<{
        id: string;
        name: string;
        cwd: string | null;
        isPrimary: boolean;
        sourceType: string;
        managed: boolean;
      }>;
    }>(withCompanyScope(`/projects/${encodeURIComponent(projectId)}/files/workspaces`, companyId)),
  getFileTree: (
    projectId: string,
    params: { path?: string; workspaceId?: string; companyId?: string },
  ) => {
    const search = new URLSearchParams();
    if (params.path) search.set("path", params.path);
    if (params.workspaceId) search.set("workspaceId", params.workspaceId);
    if (params.companyId) search.set("companyId", params.companyId);
    const qs = search.toString();
    return api.get<{
      workspaceId: string;
      workspaceName: string;
      path: string;
      items: Array<{
        name: string;
        type: "directory" | "file";
        viewable: boolean;
        viewKind: FileViewKind | null;
        ext: string;
      }>;
      truncated: boolean;
    }>(
      `/projects/${encodeURIComponent(projectId)}/files/tree${qs ? `?${qs}` : ""}`,
    );
  },
  getFileContent: (
    projectId: string,
    params: { path: string; workspaceId?: string; companyId?: string },
  ) => {
    const search = new URLSearchParams({ path: params.path });
    if (params.workspaceId) search.set("workspaceId", params.workspaceId);
    if (params.companyId) search.set("companyId", params.companyId);
    return api.get<{
      workspaceId: string;
      path: string;
      content: string;
      viewKind: FileViewKind;
      size: number;
    }>(`/projects/${encodeURIComponent(projectId)}/files/content?${search.toString()}`);
  },
  fileDownloadUrl: (
    projectId: string,
    params: { path: string; workspaceId?: string; companyId?: string },
  ) => {
    const search = new URLSearchParams({ path: params.path });
    if (params.workspaceId) search.set("workspaceId", params.workspaceId);
    if (params.companyId) search.set("companyId", params.companyId);
    return `/api/projects/${encodeURIComponent(projectId)}/files/download?${search.toString()}`;
  },
  // Inline render URL for images and HTML (served with the file's real content type).
  fileRawUrl: (
    projectId: string,
    params: { path: string; workspaceId?: string; companyId?: string },
  ) => {
    const search = new URLSearchParams({ path: params.path });
    if (params.workspaceId) search.set("workspaceId", params.workspaceId);
    if (params.companyId) search.set("companyId", params.companyId);
    return `/api/projects/${encodeURIComponent(projectId)}/files/raw?${search.toString()}`;
  },
  // Zip download URL for a folder (omit path to download the whole workspace).
  folderDownloadUrl: (
    projectId: string,
    params: { path?: string; workspaceId?: string; companyId?: string },
  ) => {
    const search = new URLSearchParams();
    if (params.path) search.set("path", params.path);
    if (params.workspaceId) search.set("workspaceId", params.workspaceId);
    if (params.companyId) search.set("companyId", params.companyId);
    const qs = search.toString();
    return `/api/projects/${encodeURIComponent(projectId)}/files/download-folder${qs ? `?${qs}` : ""}`;
  },
};
