import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedProjectKey,
} from "@t3tools/client-runtime/environment";
import { useRightPanelStore } from "~/rightPanelStore";
import { useWorkspaceStore, workspaceChatId, workspaceToolId } from "~/workspaceStore";
import {
  importThreadSurfaces,
  subscribeWorkspaceSurfaceOpenings,
  toggleWorkspaceTool,
} from "./workspaceBindings";

vi.mock("~/state/entities", () => ({ readThreadShell: () => ({ projectId: "project" }) }));
const ref = scopeThreadRef(EnvironmentId.make("test"), ThreadId.make("thread"));
const project = scopeProjectRef(ref.environmentId, ProjectId.make("project"));
const target = { kind: "server", threadRef: ref } as const;
const chat = { id: workspaceChatId(target), kind: "chat", target } as const;
const layout = () => useWorkspaceStore.getState().byProject[scopedProjectKey(project)]!;

beforeEach(() => {
  useWorkspaceStore.setState({ byProject: {} });
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
});

describe("workspace tool integration", () => {
  it("imports existing side tools once, keeping subsequent placement", () => {
    useRightPanelStore.getState().openTerminal(ref, "shell");
    useWorkspaceStore.getState().open(project, chat);
    importThreadSurfaces(project, ref);
    const id = workspaceToolId(ref, "terminal:shell");
    expect(layout().side.tabIds).toEqual([id]);
    useWorkspaceStore.getState().move(project, id, "main");
    importThreadSurfaces(project, ref);
    expect(layout().side.tabIds).toEqual([]);
    expect(layout().main.tabIds).toEqual([chat.id, id]);
  });

  it("legacy openings focus an existing moved tool, and session close removes its tab", () => {
    useWorkspaceStore.getState().open(project, chat);
    const unsubscribe = subscribeWorkspaceSurfaceOpenings();
    try {
      useRightPanelStore.getState().openTerminal(ref, "shell");
      const id = workspaceToolId(ref, "terminal:shell");
      useWorkspaceStore.getState().move(project, id, "main");
      useWorkspaceStore.getState().activate(project, chat.id);
      useRightPanelStore.getState().openTerminal(ref, "shell");
      expect(layout().main.activeTabId).toBe(id);
      expect(layout().side.tabIds).toEqual([]);
      useRightPanelStore.getState().closeTerminal(ref, "terminal:shell", "shell");
      expect(layout().tabs[id]).toBeUndefined();
      expect(layout().main.activeTabId).toBe(chat.id);
    } finally {
      unsubscribe();
    }
  });

  it("toggles the same terminal without creating or closing any session", () => {
    useWorkspaceStore.getState().open(project, chat);
    expect(toggleWorkspaceTool(project, ref, "terminal")).toBe(false);
    useRightPanelStore.getState().openTerminal(ref, "shell");
    importThreadSurfaces(project, ref);
    const id = workspaceToolId(ref, "terminal:shell");
    toggleWorkspaceTool(project, ref, "terminal");
    expect(layout().side.activeTabId).toBe(id);
    expect(layout().focusedPane).toBe("side");
    toggleWorkspaceTool(project, ref, "terminal");
    expect(layout().sideOpen).toBe(false);
    toggleWorkspaceTool(project, ref, "terminal");
    expect(layout().sideOpen).toBe(true);
    useWorkspaceStore.getState().move(project, id, "main");
    toggleWorkspaceTool(project, ref, "terminal");
    expect(layout().main.activeTabId).toBe(chat.id);
    toggleWorkspaceTool(project, ref, "terminal");
    expect(layout().main.activeTabId).toBe(id);
    expect(Object.keys(layout().tabs)).toHaveLength(2);
  });
});
