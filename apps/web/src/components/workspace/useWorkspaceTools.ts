import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  AuthPreviewOperateScope,
  AuthTerminalOperateScope,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { useComposerDraftStore } from "~/composerDraftStore";
import { usePreviewAvailable } from "~/browser/previewRuntime";
import { useProject, useThreadShell } from "~/state/entities";
import { useEnvironmentScope, readEnvironmentScope } from "~/state/session";
import { terminalEnvironment } from "~/state/terminal";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  useRightPanelStore,
  selectThreadRightPanelState,
  type RightPanelSurface,
} from "~/rightPanelStore";
import {
  useWorkspaceStore,
  workspaceToolId,
  type WorkspacePane,
  type WorkspaceTab,
} from "~/workspaceStore";
import { useDiffPanelStore } from "~/diffPanelStore";
import { randomUUID } from "~/lib/utils";
import { confirmTerminalClose } from "~/lib/terminalCloseConfirm";
import { readThreadPreviewState } from "~/previewStateStore";
import { openPreviewSession } from "../preview/openPreviewSession";
import { closePreviewSession } from "../preview/closePreviewSession";
import { agentControlledBrowserCloseConfirmation } from "../ChatView.logic";
import { readLocalApi } from "~/localApi";
import { MAX_TERMINALS_PER_GROUP } from "~/types";

export function useWorkspaceThread(ref: ScopedThreadRef | null) {
  const thread = useThreadShell(ref);
  const draft = useComposerDraftStore((state) => (ref ? state.getDraftSessionByRef(ref) : null));
  const draftId = useComposerDraftStore((state) => (ref ? state.getDraftIdByRef(ref) : null));
  const projectId = thread?.projectId ?? draft?.projectId;
  const project = useProject(
    projectId && ref ? scopeProjectRef(ref.environmentId, projectId) : null,
  );
  const worktreePath = thread?.worktreePath ?? draft?.worktreePath ?? null;
  return {
    thread,
    draft,
    project,
    worktreePath,
    cwd: worktreePath ?? project?.workspaceRoot ?? null,
    composerTarget: draftId,
  };
}

/** Creates/closes resources through the existing environment commands; placement stays local. */
export function useWorkspaceTools(
  projectRef: ScopedProjectRef,
  ref: ScopedThreadRef,
  pane: WorkspacePane,
) {
  const threadContext = useWorkspaceThread(ref);
  const context = { ...threadContext, composerTarget: threadContext.composerTarget ?? ref };
  const closeTab = useWorkspaceCloseTab(projectRef);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: true });
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: true });
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: true });
  const canPreview = useEnvironmentScope(ref.environmentId, AuthPreviewOperateScope);
  const canTerminal = useEnvironmentScope(ref.environmentId, AuthTerminalOperateScope);
  const browserAvailable = usePreviewAvailable(ref.environmentId) && canPreview;

  const place = (surfaceId: string) => {
    const id = workspaceToolId(ref, surfaceId);
    useWorkspaceStore
      .getState()
      .open(projectRef, { id, kind: "tool", threadRef: ref, surfaceId }, pane);
    useWorkspaceStore.getState().move(projectRef, id, pane);
  };
  const addBrowser = async () => {
    if (!canPreview) return;
    const result = await openPreviewSession({ openPreview, threadRef: ref });
    if (result._tag === "Failure") return;
    useRightPanelStore.getState().openBrowser(ref, result.value.tabId);
    place(`browser:${result.value.tabId}`);
  };
  const addTerminal = async (split?: {
    surfaceId: string;
    direction: "horizontal" | "vertical";
  }) => {
    if (!canTerminal || !context.cwd || !context.project) return;
    if (split) {
      const surface = selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        ref,
      ).surfaces.find((entry) => entry.id === split.surfaceId);
      if (surface?.kind !== "terminal" || surface.terminalIds.length >= MAX_TERMINALS_PER_GROUP)
        return;
    }
    const terminalId = randomUUID();
    const result = await openTerminal({
      environmentId: ref.environmentId,
      input: {
        threadId: ref.threadId,
        terminalId,
        cwd: context.cwd,
        ...(context.worktreePath ? { worktreePath: context.worktreePath } : {}),
        env: projectScriptRuntimeEnv({
          project: { cwd: context.project.workspaceRoot },
          worktreePath: context.worktreePath,
        }),
      },
    });
    if (result._tag === "Failure") return;
    if (split)
      useRightPanelStore
        .getState()
        .splitTerminal(ref, split.surfaceId, terminalId, split.direction);
    else {
      useRightPanelStore.getState().openTerminal(ref, terminalId);
      place(`terminal:${terminalId}`);
    }
  };
  const add = (kind: "files" | "diff" | "device" | "pull-requests" | "agents") => {
    if (kind === "agents") {
      const id = workspaceToolId(ref, "agents");
      useWorkspaceStore.getState().open(projectRef, { id, kind, threadRef: ref }, pane);
      return;
    }
    if (kind === "diff") useDiffPanelStore.getState().selectGitScope(ref, "branch");
    useRightPanelStore.getState().open(ref, kind);
    place(kind);
  };
  const openFile = (path: string) => {
    useRightPanelStore.getState().openFile(ref, path);
    place(`file:${path}`);
  };
  const closeTerminalSession = async (surfaceId: string, terminalId: string) => {
    if (!readEnvironmentScope(ref.environmentId, AuthTerminalOperateScope)) return;
    const result = await closeTerminal({
      environmentId: ref.environmentId,
      input: { threadId: ref.threadId, terminalId, deleteHistory: true },
    });
    if (result._tag !== "Failure")
      useRightPanelStore.getState().closeTerminal(ref, surfaceId, terminalId);
  };
  const closeSurface = (surface: RightPanelSurface) =>
    closeTab({
      id: workspaceToolId(ref, surface.id),
      kind: "tool",
      threadRef: ref,
      surfaceId: surface.id,
    });
  return {
    ...context,
    browserAvailable,
    canTerminal,
    addBrowser,
    addTerminal,
    add,
    openFile,
    closeSurface,
    closeTerminalSession,
  };
}

export function useWorkspaceCloseTab(projectRef: ScopedProjectRef) {
  const closePreview = useAtomCommand(previewEnvironment.close, { reportFailure: true });
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: true });
  return async (tab: WorkspaceTab) => {
    if (tab.kind !== "tool") {
      useWorkspaceStore.getState().close(projectRef, tab.id);
      return true;
    }
    const ref = tab.threadRef;
    const surface = selectThreadRightPanelState(
      useRightPanelStore.getState().byThreadKey,
      ref,
    ).surfaces.find((entry) => entry.id === tab.surfaceId);
    if (!surface) {
      useWorkspaceStore.getState().close(projectRef, tab.id);
      return true;
    }
    const confirmation = agentControlledBrowserCloseConfirmation(
      [surface],
      readThreadPreviewState(ref).desktopByTabId,
    );
    if (
      confirmation &&
      !(await readLocalApi()?.dialogs.confirm(confirmation, { variant: "destructive" }))
    )
      return false;
    if (
      surface.kind === "terminal" &&
      readEnvironmentScope(ref.environmentId, AuthTerminalOperateScope)
    ) {
      if (
        !(await confirmTerminalClose([
          "Terminal",
          ...surface.terminalIds.slice(1).map((_, index) => `Terminal ${index + 2}`),
        ]))
      )
        return false;
      for (const terminalId of surface.terminalIds) {
        const result = await closeTerminal({
          environmentId: ref.environmentId,
          input: { threadId: ref.threadId, terminalId, deleteHistory: true },
        });
        if (result._tag === "Failure") return false;
      }
    }
    if (
      surface.kind === "preview" &&
      surface.resourceId &&
      readEnvironmentScope(ref.environmentId, AuthPreviewOperateScope)
    ) {
      const result = await closePreviewSession({
        closePreview,
        threadRef: ref,
        tabId: surface.resourceId,
        snapshot: readThreadPreviewState(ref).sessions[surface.resourceId] ?? null,
      });
      if (result._tag === "Failure") return false;
    }
    useRightPanelStore.getState().closeSurface(ref, surface.id);
    useWorkspaceStore.getState().close(projectRef, workspaceToolId(ref, surface.id));
    return true;
  };
}
