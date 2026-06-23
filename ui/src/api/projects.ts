import type {
  Project,
  ProjectWorkspace,
  WorkspaceOperation,
  WorkspaceRuntimeControlTarget,
} from "@paperclipai/shared";
import { api } from "./client";
import { sanitizeWorkspaceRuntimeControlTarget } from "./workspace-runtime-control";

function withCompanyScope(path: string, companyId?: string) {
  if (!companyId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}companyId=${encodeURIComponent(companyId)}`;
}

function projectPath(id: string, companyId?: string, suffix = "") {
  return withCompanyScope(`/projects/${encodeURIComponent(id)}${suffix}`, companyId);
}

export const projectsApi = {
  list: (companyId: string) => api.get<Project[]>(`/companies/${companyId}/projects`),
  get: (id: string, companyId?: string) => api.get<Project>(projectPath(id, companyId)),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Project>(`/companies/${companyId}/projects`, data),
  update: (id: string, data: Record<string, unknown>, companyId?: string) =>
    api.patch<Project>(projectPath(id, companyId), data),
  listWorkspaces: (projectId: string, companyId?: string) =>
    api.get<ProjectWorkspace[]>(projectPath(projectId, companyId, "/workspaces")),
  createWorkspace: (projectId: string, data: Record<string, unknown>, companyId?: string) =>
    api.post<ProjectWorkspace>(projectPath(projectId, companyId, "/workspaces"), data),
  updateWorkspace: (projectId: string, workspaceId: string, data: Record<string, unknown>, companyId?: string) =>
    api.patch<ProjectWorkspace>(
      projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}`),
      data,
    ),
  controlWorkspaceRuntimeServices: (
    projectId: string,
    workspaceId: string,
    action: "start" | "stop" | "restart",
    companyId?: string,
    target: WorkspaceRuntimeControlTarget = {},
  ) =>
    api.post<{ workspace: ProjectWorkspace; operation: WorkspaceOperation }>(
      projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}/runtime-services/${action}`),
      sanitizeWorkspaceRuntimeControlTarget(target),
    ),
  controlWorkspaceCommands: (
    projectId: string,
    workspaceId: string,
    action: "start" | "stop" | "restart" | "run",
    companyId?: string,
    target: WorkspaceRuntimeControlTarget = {},
  ) =>
    api.post<{ workspace: ProjectWorkspace; operation: WorkspaceOperation }>(
      projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}/runtime-commands/${action}`),
      sanitizeWorkspaceRuntimeControlTarget(target),
    ),
  removeWorkspace: (projectId: string, workspaceId: string, companyId?: string) =>
    api.delete<ProjectWorkspace>(projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}`)),
  remove: (id: string, companyId?: string) => api.delete<Project>(projectPath(id, companyId)),
  listFileWorkspaces: (projectId: string, companyId?: string) =>
    api.get<{
      workspaces: Array<{
        id: string;
        name: string;
        cwd: string | null;
        isPrimary: boolean;
        sourceType: string;
      }>;
    }>(projectPath(projectId, companyId, "/files/workspaces")),
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
      items: Array<{ name: string; type: "directory" | "file"; viewable: boolean; ext: string }>;
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
};
