import { scopedProjectKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import type { ThreadRouteTarget } from "./threadRoutes";

export type WorkspacePane = "main" | "side";
export type WorkspaceTab =
  | { id: string; kind: "chat"; target: ThreadRouteTarget }
  | { id: string; kind: "tool"; threadRef: ScopedThreadRef; surfaceId: string }
  | { id: string; kind: "agents"; threadRef: ScopedThreadRef };

export interface WorkspacePaneState {
  tabIds: string[];
  activeTabId: string | null;
}

export interface ProjectWorkspace {
  tabs: Record<string, WorkspaceTab>;
  main: WorkspacePaneState;
  side: WorkspacePaneState;
  focusedPane: WorkspacePane;
  sideOpen: boolean;
  sideExpanded: boolean;
  sideWidth: number;
  importedThreadKeys: string[];
  closedChats: Extract<WorkspaceTab, { kind: "chat" }>[];
}

export const emptyProjectWorkspace = (): ProjectWorkspace => ({
  tabs: {},
  main: { tabIds: [], activeTabId: null },
  side: { tabIds: [], activeTabId: null },
  focusedPane: "main",
  sideOpen: false,
  sideExpanded: false,
  sideWidth: 440,
  importedThreadKeys: [],
  closedChats: [],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isThreadRef = Schema.is(ScopedThreadRef);
function isWorkspaceTab(value: unknown): value is WorkspaceTab {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) return false;
  if (value.kind === "chat") {
    const target = value.target;
    return (
      isRecord(target) &&
      ((target.kind === "draft" &&
        typeof target.draftId === "string" &&
        target.draftId.length > 0) ||
        (target.kind === "server" && isThreadRef(target.threadRef)))
    );
  }
  return (
    isThreadRef(value.threadRef) &&
    (value.kind === "agents" ||
      (value.kind === "tool" && typeof value.surfaceId === "string" && value.surfaceId.length > 0))
  );
}

/** A stale selection or interrupted storage write must not make the whole workspace unusable. */
export function restoreProjectWorkspaces(value: unknown): Record<string, ProjectWorkspace> {
  if (!isRecord(value) || !isRecord(value.byProject)) return {};
  const restored: Record<string, ProjectWorkspace> = {};
  for (const [key, saved] of Object.entries(value.byProject)) {
    if (!isRecord(saved) || !isRecord(saved.tabs)) continue;
    const tabs: Record<string, WorkspaceTab> = {};
    for (const [id, tab] of Object.entries(saved.tabs))
      if (isWorkspaceTab(tab) && tab.id === id) tabs[id] = tab;
    const placed = new Set<string>();
    const readPane = (input: unknown): WorkspacePaneState => {
      if (!isRecord(input) || !Array.isArray(input.tabIds))
        return { tabIds: [], activeTabId: null };
      const tabIds = input.tabIds.filter((id): id is string => {
        if (typeof id !== "string" || !tabs[id] || placed.has(id)) return false;
        placed.add(id);
        return true;
      });
      return {
        tabIds,
        activeTabId:
          typeof input.activeTabId === "string" && tabIds.includes(input.activeTabId)
            ? input.activeTabId
            : (tabIds[0] ?? null),
      };
    };
    const main = readPane(saved.main);
    const side = readPane(saved.side);
    for (const id of Object.keys(tabs)) if (!placed.has(id)) main.tabIds.push(id);
    main.activeTabId ??= main.tabIds[0] ?? null;
    const sideOpen = saved.sideOpen === true;
    restored[key] = {
      tabs,
      main,
      side,
      focusedPane: sideOpen && saved.focusedPane === "side" ? "side" : "main",
      sideOpen,
      sideExpanded: sideOpen && saved.focusedPane === "side" && saved.sideExpanded === true,
      sideWidth:
        typeof saved.sideWidth === "number" && Number.isFinite(saved.sideWidth)
          ? Math.max(280, Math.min(1000, saved.sideWidth))
          : 440,
      importedThreadKeys: Array.isArray(saved.importedThreadKeys)
        ? saved.importedThreadKeys.filter((key): key is string => typeof key === "string")
        : [],
      closedChats: Array.isArray(saved.closedChats)
        ? saved.closedChats
            .filter(
              (tab): tab is Extract<WorkspaceTab, { kind: "chat" }> =>
                isWorkspaceTab(tab) && tab.kind === "chat" && !tabs[tab.id],
            )
            .slice(0, 20)
        : [],
    };
  }
  return restored;
}

export const workspaceChatId = (target: ThreadRouteTarget) =>
  target.kind === "draft"
    ? `chat:draft:${target.draftId}`
    : `chat:${scopedThreadKey(target.threadRef)}`;
export const workspaceToolId = (ref: ScopedThreadRef, surfaceId: string) =>
  `tool:${JSON.stringify([ref.environmentId, ref.threadId, surfaceId])}`;

/** Empty drafts can still own open tabs and terminals. Project remapping must retain them. */
export function workspaceRetainsDraft(draftId: string, ref?: ScopedThreadRef) {
  return Object.values(useWorkspaceStore.getState().byProject).some((layout) =>
    [...Object.values(layout.tabs), ...layout.closedChats].some((tab) =>
      tab.kind === "chat"
        ? tab.target.kind === "draft" && tab.target.draftId === draftId
        : ref !== undefined && scopedThreadKey(tab.threadRef) === scopedThreadKey(ref),
    ),
  );
}

export function workspaceTabPane(layout: ProjectWorkspace, tabId: string): WorkspacePane | null {
  return layout.main.tabIds.includes(tabId)
    ? "main"
    : layout.side.tabIds.includes(tabId)
      ? "side"
      : null;
}

function withoutTab(pane: WorkspacePaneState, tabId: string): WorkspacePaneState {
  const index = pane.tabIds.indexOf(tabId);
  if (index < 0) return pane;
  const tabIds = pane.tabIds.filter((id) => id !== tabId);
  return {
    tabIds,
    activeTabId:
      pane.activeTabId === tabId
        ? (tabIds[Math.min(index, tabIds.length - 1)] ?? null)
        : pane.activeTabId,
  };
}

/** Placement only: moving or hiding a view never closes its underlying resource. */
export function moveWorkspaceTab(
  layout: ProjectWorkspace,
  tabId: string,
  destination: WorkspacePane,
  index?: number,
): ProjectWorkspace {
  if (!layout.tabs[tabId]) return layout;
  const main = withoutTab(layout.main, tabId);
  const side = withoutTab(layout.side, tabId);
  const pane = destination === "main" ? main : side;
  const tabIds = [...pane.tabIds];
  tabIds.splice(Math.max(0, Math.min(index ?? tabIds.length, tabIds.length)), 0, tabId);
  return {
    ...layout,
    main,
    side,
    [destination]: { tabIds, activeTabId: tabId },
    focusedPane: destination,
    sideExpanded: destination === "side" && layout.sideExpanded,
    sideOpen: destination === "side" || (layout.sideOpen && side.tabIds.length > 0),
  };
}

function closeWorkspaceTab(layout: ProjectWorkspace, tabId: string): ProjectWorkspace {
  const tab = layout.tabs[tabId];
  if (!tab) return layout;
  const { [tabId]: _closed, ...tabs } = layout.tabs;
  const main = withoutTab(layout.main, tabId);
  const side = withoutTab(layout.side, tabId);
  return {
    ...layout,
    tabs,
    main,
    side,
    sideOpen: layout.sideOpen && side.tabIds.length > 0,
    sideExpanded: layout.sideExpanded && side.tabIds.length > 0,
    focusedPane:
      layout.focusedPane === "side" && side.tabIds.length === 0 ? "main" : layout.focusedPane,
    closedChats:
      tab.kind === "chat"
        ? [tab, ...layout.closedChats.filter((entry) => entry.id !== tabId)].slice(0, 20)
        : layout.closedChats,
  };
}

interface WorkspaceStore {
  byProject: Record<string, ProjectWorkspace>;
  open: (
    project: ScopedProjectRef,
    tab: WorkspaceTab,
    pane?: WorkspacePane,
    activate?: boolean,
  ) => void;
  activate: (project: ScopedProjectRef, tabId: string) => void;
  move: (project: ScopedProjectRef, tabId: string, pane: WorkspacePane, index?: number) => void;
  close: (project: ScopedProjectRef, tabId: string) => void;
  focus: (project: ScopedProjectRef, pane: WorkspacePane) => void;
  setSideOpen: (project: ScopedProjectRef, open: boolean) => void;
  setSideExpanded: (project: ScopedProjectRef, expanded: boolean) => void;
  setSideWidth: (project: ScopedProjectRef, width: number) => void;
  markImported: (project: ScopedProjectRef, ref: ScopedThreadRef) => void;
  promoteDraft: (project: ScopedProjectRef, draftId: string, ref: ScopedThreadRef) => void;
}

export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    (set) => {
      const update = (
        project: ScopedProjectRef,
        transform: (layout: ProjectWorkspace) => ProjectWorkspace,
      ) =>
        set((state) => {
          const key = scopedProjectKey(project);
          const previous = state.byProject[key] ?? emptyProjectWorkspace();
          const next = transform(previous);
          return next === previous ? state : { byProject: { ...state.byProject, [key]: next } };
        });
      return {
        byProject: {},
        open: (project, tab, pane = "main", activate = true) =>
          update(project, (layout) => {
            // Draft promotion keeps its original tab id and mounted view.
            const existing =
              tab.kind === "chat"
                ? Object.values(layout.tabs).find(
                    (entry) =>
                      entry.kind === "chat" &&
                      workspaceChatId(entry.target) === workspaceChatId(tab.target),
                  )
                : layout.tabs[tab.id];
            const id = existing?.id ?? tab.id;
            const destination = workspaceTabPane(layout, id) ?? pane;
            const previous = layout[destination];
            return {
              ...layout,
              tabs: { ...layout.tabs, [id]: existing ?? tab },
              closedChats: layout.closedChats.filter((entry) => entry.id !== id),
              [destination]: {
                tabIds: previous.tabIds.includes(id) ? previous.tabIds : [...previous.tabIds, id],
                activeTabId: activate ? id : (previous.activeTabId ?? id),
              },
              focusedPane: activate ? destination : layout.focusedPane,
              sideExpanded: activate && destination === "main" ? false : layout.sideExpanded,
              sideOpen: layout.sideOpen || (activate && destination === "side"),
            };
          }),
        activate: (project, tabId) =>
          update(project, (layout) => {
            const pane = workspaceTabPane(layout, tabId);
            if (!pane) return layout;
            return {
              ...layout,
              [pane]: { ...layout[pane], activeTabId: tabId },
              focusedPane: pane,
              sideExpanded: pane === "side" && layout.sideExpanded,
              sideOpen: layout.sideOpen || pane === "side",
            };
          }),
        move: (project, tabId, pane, index) =>
          update(project, (layout) => moveWorkspaceTab(layout, tabId, pane, index)),
        close: (project, tabId) => update(project, (layout) => closeWorkspaceTab(layout, tabId)),
        focus: (project, pane) =>
          update(project, (layout) =>
            layout.focusedPane === pane
              ? layout
              : {
                  ...layout,
                  focusedPane: pane,
                  sideExpanded: pane === "side" && layout.sideExpanded,
                },
          ),
        setSideOpen: (project, sideOpen) =>
          update(project, (layout) => ({
            ...layout,
            sideOpen,
            sideExpanded: sideOpen && layout.sideExpanded,
            focusedPane: sideOpen ? layout.focusedPane : "main",
          })),
        setSideExpanded: (project, sideExpanded) =>
          update(project, (layout) => ({
            ...layout,
            sideExpanded,
            sideOpen: layout.sideOpen || sideExpanded,
            focusedPane: sideExpanded ? "side" : layout.focusedPane,
          })),
        setSideWidth: (project, sideWidth) =>
          update(project, (layout) => ({
            ...layout,
            sideWidth: Math.max(280, Math.min(1000, sideWidth)),
          })),
        markImported: (project, ref) =>
          update(project, (layout) => {
            const key = scopedThreadKey(ref);
            return layout.importedThreadKeys.includes(key)
              ? layout
              : { ...layout, importedThreadKeys: [...layout.importedThreadKeys, key] };
          }),
        promoteDraft: (project, draftId, ref) =>
          update(project, (layout) => {
            if (
              ![...Object.values(layout.tabs), ...layout.closedChats].some(
                (tab) =>
                  tab.kind === "chat" &&
                  tab.target.kind === "draft" &&
                  tab.target.draftId === draftId,
              )
            )
              return layout;
            const promote = (tab: WorkspaceTab): WorkspaceTab =>
              tab.kind === "chat" && tab.target.kind === "draft" && tab.target.draftId === draftId
                ? { ...tab, target: { kind: "server", threadRef: ref } }
                : tab;
            const tabs = Object.fromEntries(
              Object.entries(layout.tabs).map(([id, tab]) => [id, promote(tab)]),
            );
            const closedChats = layout.closedChats.map(
              (tab) => promote(tab) as Extract<WorkspaceTab, { kind: "chat" }>,
            );
            return { ...layout, tabs, closedChats };
          }),
      };
    },
    {
      name: "t3code:project-workspaces:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window === "undefined" ? undefined : window.localStorage),
      ),
      partialize: (state) => ({ byProject: state.byProject }),
      merge: (persisted, current) => ({
        ...current,
        byProject: restoreProjectWorkspaces(persisted),
      }),
    },
  ),
);
