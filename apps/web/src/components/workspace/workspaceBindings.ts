import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import { useComposerDraftStore } from "~/composerDraftStore";
import { readThreadShell } from "~/state/entities";
import { useRightPanelStore, selectThreadRightPanelState } from "~/rightPanelStore";
import {
  useWorkspaceStore,
  workspaceToolId,
  workspaceChatId,
  workspaceTabPane,
  type WorkspaceTab,
} from "~/workspaceStore";
import type { ThreadRouteTarget } from "~/threadRoutes";

export function workspaceTargetRef(target: ThreadRouteTarget): ScopedThreadRef | null {
  if (target.kind === "server") return target.threadRef;
  const draft = useComposerDraftStore.getState().getDraftSession(target.draftId);
  return draft ? scopeThreadRef(draft.environmentId, draft.threadId) : null;
}

export function workspaceTabRef(tab: WorkspaceTab): ScopedThreadRef | null {
  return tab.kind === "chat" ? workspaceTargetRef(tab.target) : tab.threadRef;
}

export function workspaceOwnerTarget(ref: ScopedThreadRef): ThreadRouteTarget {
  const draftId = useComposerDraftStore.getState().getDraftIdByRef(ref);
  return draftId ? { kind: "draft", draftId } : { kind: "server", threadRef: ref };
}

function projectForThread(ref: ScopedThreadRef) {
  const thread = readThreadShell(ref) ?? useComposerDraftStore.getState().getDraftSessionByRef(ref);
  return thread ? scopeProjectRef(ref.environmentId, thread.projectId) : null;
}

export function importThreadSurfaces(project: ScopedProjectRef, ref: ScopedThreadRef) {
  const store = useWorkspaceStore.getState();
  if (store.byProject[scopedProjectKey(project)]?.importedThreadKeys.includes(scopedThreadKey(ref)))
    return;
  store.markImported(project, ref);
  const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
  for (const surface of panel.surfaces) {
    store.open(
      project,
      { id: workspaceToolId(ref, surface.id), kind: "tool", threadRef: ref, surfaceId: surface.id },
      "side",
      false,
    );
  }
  if (panel.isOpen && panel.surfaces.length) store.setSideOpen(project, true);
}

/** Existing entry points (timeline links, palette, agents) all open through this store. */
export function subscribeWorkspaceSurfaceOpenings() {
  return useRightPanelStore.subscribe((next, previous) => {
    if (next.byThreadKey === previous.byThreadKey) return;
    for (const key of new Set([
      ...Object.keys(next.byThreadKey),
      ...Object.keys(previous.byThreadKey),
    ])) {
      const panel = next.byThreadKey[key];
      const before = previous.byThreadKey[key];
      if (before === panel) continue;
      const ref = parseScopedThreadKey(key);
      const project = ref && projectForThread(ref);
      if (!ref || !project) continue;
      const store = useWorkspaceStore.getState();
      const layout = store.byProject[scopedProjectKey(project)];
      if (!layout) continue;
      if (!panel) {
        for (const surface of before?.surfaces ?? [])
          store.close(project, workspaceToolId(ref, surface.id));
        continue;
      }
      const removed =
        before?.surfaces.filter(
          (surface) => !panel.surfaces.some((entry) => entry.id === surface.id),
        ) ?? [];
      for (const surface of removed) store.close(project, workspaceToolId(ref, surface.id));
      for (const surface of panel.surfaces) {
        if (!before?.surfaces.some((entry) => entry.id === surface.id)) {
          store.open(
            project,
            {
              id: workspaceToolId(ref, surface.id),
              kind: "tool",
              threadRef: ref,
              surfaceId: surface.id,
            },
            "side",
            false,
          );
        }
      }
      const explicitlyOpened =
        panel.isOpen &&
        panel.activeSurfaceId &&
        (panel.activeSurfaceId !== before?.activeSurfaceId ||
          !before.isOpen ||
          next.userActionRevisionByThreadKey[key] !== previous.userActionRevisionByThreadKey[key]);
      if (explicitlyOpened && panel.activeSurfaceId) {
        store.open(
          project,
          {
            id: workspaceToolId(ref, panel.activeSurfaceId),
            kind: "tool",
            threadRef: ref,
            surfaceId: panel.activeSurfaceId,
          },
          "side",
        );
      }
    }
  });
}

/** Toggle commands reuse a tool and return to its owner instead of allocating another session. */
export function toggleWorkspaceTool(
  project: ScopedProjectRef,
  ref: ScopedThreadRef,
  kind: "preview" | "terminal",
) {
  const store = useWorkspaceStore.getState();
  const layout = store.byProject[scopedProjectKey(project)];
  if (!layout) return false;
  const surfaces = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    ref,
  ).surfaces;
  const matching = Object.values(layout.tabs).filter(
    (tab) =>
      tab.kind === "tool" &&
      scopedThreadKey(tab.threadRef) === scopedThreadKey(ref) &&
      surfaces.some((surface) => surface.id === tab.surfaceId && surface.kind === kind),
  );
  const focusedId = layout[layout.focusedPane].activeTabId;
  const tab = matching.find((tab) => tab.id === focusedId) ?? matching.at(-1);
  if (!tab) return false;
  const pane = workspaceTabPane(layout, tab.id);
  if (tab.id === focusedId && (pane === "main" || layout.sideOpen)) {
    if (pane === "side") store.setSideOpen(project, false);
    else {
      const target = workspaceOwnerTarget(ref);
      store.open(project, { id: workspaceChatId(target), kind: "chat", target });
    }
  } else store.activate(project, tab.id);
  return true;
}
