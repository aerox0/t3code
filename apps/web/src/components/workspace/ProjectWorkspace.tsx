import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
} from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useResizeDrag } from "~/hooks/useResizeDrag";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useProject, useThreadShell } from "~/state/entities";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import {
  useWorkspaceStore,
  emptyProjectWorkspace,
  workspaceChatId,
  workspaceTabPane,
  type WorkspacePane,
} from "~/workspaceStore";
import type { ThreadRouteTarget } from "~/threadRoutes";
import { ThreadRouteView } from "../ThreadRouteView";
import { SidebarInset } from "../ui/sidebar";
import { Button } from "../ui/button";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { WorkspaceToolView, WorkspacePreviewSync } from "./WorkspaceToolView";
import {
  importThreadSurfaces,
  subscribeWorkspaceSurfaceOpenings,
  workspaceOwnerTarget,
  workspaceTabRef,
  workspaceTargetRef,
} from "./workspaceBindings";
import { useWorkspaceCloseTab } from "./useWorkspaceTools";
import { ThreadRelationshipsPanel } from "../chat/ThreadRelationshipsControl";
import { WorkspaceCommands } from "./WorkspaceCommands";

const EMPTY_LAYOUT = emptyProjectWorkspace();

export function ProjectWorkspaceRoute({ target: routeTarget }: { target: ThreadRouteTarget }) {
  const navigate = useNavigate();
  const promotedTarget = useWorkspaceStore((state) => {
    if (routeTarget.kind !== "draft") return null;
    const id = workspaceChatId(routeTarget);
    for (const layout of Object.values(state.byProject)) {
      const tab = layout.tabs[id] ?? layout.closedChats.find((entry) => entry.id === id);
      if (tab?.kind === "chat" && tab.target.kind === "server") return tab.target;
    }
    return null;
  });
  const target = promotedTarget ?? routeTarget;
  useEffect(() => {
    if (promotedTarget)
      void navigate({
        to: "/$environmentId/$threadId",
        params: promotedTarget.threadRef,
        replace: true,
      });
  }, [navigate, promotedTarget]);
  const draft = useComposerDraftStore((state) =>
    target.kind === "draft" ? state.getDraftSession(target.draftId) : null,
  );
  const thread = useThreadShell(target.kind === "server" ? target.threadRef : null);
  const environmentId =
    target.kind === "server" ? target.threadRef.environmentId : draft?.environmentId;
  const projectId = thread?.projectId ?? draft?.projectId;
  const projectRef = useMemo(
    () => (environmentId && projectId ? scopeProjectRef(environmentId, projectId) : null),
    [environmentId, projectId],
  );
  const locationKey = useLocation({
    select: (location) => location.state.__TSR_key ?? location.href,
  });
  const [initialEntryKey] = useState(locationKey);
  useEffect(subscribeWorkspaceSurfaceOpenings, []);
  if (!projectRef) return <ThreadRouteView target={target} />;
  return (
    <ProjectWorkspace
      key={scopedProjectKey(projectRef)}
      projectRef={projectRef}
      target={target}
      restoreSelection={initialEntryKey === locationKey}
    />
  );
}

function SideDropTarget() {
  const { setNodeRef, isOver } = useDroppable({ id: "pane:side" });
  return (
    <div
      ref={setNodeRef}
      className={`absolute inset-y-10 right-0 z-50 flex w-36 items-center justify-center border-2 border-dashed ${isOver ? "border-primary bg-primary/20" : "border-border bg-muted/80"}`}
    >
      <span className="p-3 text-center text-sm">Move to side pane</span>
    </div>
  );
}

function ProjectWorkspace({
  projectRef,
  target,
  restoreSelection,
}: {
  projectRef: ScopedProjectRef;
  target: ThreadRouteTarget;
  restoreSelection: boolean;
}) {
  const key = scopedProjectKey(projectRef);
  const layout = useWorkspaceStore((state) => state.byProject[key] ?? EMPTY_LAYOUT);
  const project = useProject(projectRef);
  const panelStates = useRightPanelStore((state) => state.byThreadKey);
  const navigate = useNavigate();
  const location = useLocation();
  const pendingNavigation = useRef<string | null>(null);
  const handledLocation = useRef<string | null>(null);
  const initialized = useRef(false);
  const lastFocusedOwner = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const createChat = useNewThreadHandler();
  const closeTab = useWorkspaceCloseTab(projectRef);
  const [dragging, setDragging] = useState<string | null>(null);
  const [visitedTools, setVisitedTools] = useState<ReadonlySet<string>>(() => new Set());
  const narrow = useMediaQuery("(max-width: 760px)");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const routeKey = workspaceChatId(target);
  const navigateTo = useCallback(
    (next: ThreadRouteTarget, replace = false) => {
      if (workspaceChatId(next) === routeKey) return;
      pendingNavigation.current = workspaceChatId(next);
      if (next.kind === "draft")
        void navigate({ to: "/draft/$draftId", params: { draftId: next.draftId }, replace });
      else void navigate({ to: "/$environmentId/$threadId", params: next.threadRef, replace });
    },
    [navigate, routeKey],
  );

  useLayoutEffect(() => {
    // Router location updates can precede the matched route params. Wait until
    // both describe the same chat before interpreting this as external navigation.
    const expectedPath =
      target.kind === "draft"
        ? `/draft/${encodeURIComponent(target.draftId)}`
        : `/${encodeURIComponent(target.threadRef.environmentId)}/${encodeURIComponent(target.threadRef.threadId)}`;
    if (location.pathname !== expectedPath) return;
    const requestKey = JSON.stringify([location.state.__TSR_key ?? location.href, routeKey]);
    if (handledLocation.current === requestKey) return;
    handledLocation.current = requestKey;
    const store = useWorkspaceStore.getState();
    const current = store.byProject[key];
    const internal = pendingNavigation.current === routeKey;
    pendingNavigation.current = null;
    const savedTab = current?.tabs[current[current.focusedPane].activeTabId ?? ""];
    const savedOwner = savedTab ? workspaceTabRef(savedTab) : null;
    const restored =
      !initialized.current &&
      restoreSelection &&
      savedOwner !== null &&
      workspaceChatId(workspaceOwnerTarget(savedOwner)) === routeKey;
    initialized.current = true;
    if (!internal && !restored) store.open(projectRef, { id: routeKey, kind: "chat", target });
    const ref = workspaceTargetRef(target);
    if (ref) importThreadSurfaces(projectRef, ref);
    const updated = useWorkspaceStore.getState().byProject[key];
    const selected = updated?.tabs[updated[updated.focusedPane].activeTabId ?? ""];
    const selectedRef = selected ? workspaceTabRef(selected) : null;
    lastFocusedOwner.current = selectedRef
      ? workspaceChatId(workspaceOwnerTarget(selectedRef))
      : null;
  }, [key, location, projectRef, restoreSelection, routeKey, target]);

  const activate = useCallback(
    (id: string) => {
      const tab = useWorkspaceStore.getState().byProject[key]?.tabs[id];
      if (!tab) return;
      useWorkspaceStore.getState().activate(projectRef, id);
      const owner = workspaceTabRef(tab);
      if (owner) navigateTo(tab.kind === "chat" ? tab.target : workspaceOwnerTarget(owner));
    },
    [key, navigateTo, projectRef],
  );
  const promote = useCallback(
    (draftId: string, ref: ScopedThreadRef) => {
      useWorkspaceStore.getState().promoteDraft(projectRef, draftId, ref);
      if (target.kind === "draft" && target.draftId === draftId)
        navigateTo({ kind: "server", threadRef: ref }, true);
    },
    [navigateTo, projectRef, target],
  );
  const focusedTab = layout.tabs[layout[layout.focusedPane].activeTabId ?? ""];
  const owner = focusedTab ? workspaceTabRef(focusedTab) : workspaceTargetRef(target);
  useEffect(() => {
    const current = useWorkspaceStore.getState().byProject[key];
    if (current !== layout) return;
    const selected = current?.tabs[current[current.focusedPane].activeTabId ?? ""];
    const selectedRef = selected ? workspaceTabRef(selected) : null;
    if (!selectedRef) return;
    const next = selected?.kind === "chat" ? selected.target : workspaceOwnerTarget(selectedRef);
    const ownerKey = workspaceChatId(next);
    if (lastFocusedOwner.current === ownerKey) return;
    lastFocusedOwner.current = ownerKey;
    navigateTo(next, true);
  }, [key, layout, navigateTo]);
  const close = (id: string) => {
    const tab = layout.tabs[id];
    if (tab) void closeTab(tab);
  };
  const newChat = async (pane: WorkspacePane) => {
    const result = await createChat(projectRef, { newTab: true, navigate: false });
    if (!result) return;
    const next = { kind: "draft", draftId: result.draftId } as const;
    const id = workspaceChatId(next);
    useWorkspaceStore.getState().open(projectRef, { id, kind: "chat", target: next }, pane);
    useWorkspaceStore.getState().move(projectRef, id, pane);
    navigateTo(next);
  };
  const reopen = (pane: WorkspacePane) => {
    const tab = layout.closedChats[0];
    if (!tab) return;
    useWorkspaceStore.getState().open(projectRef, tab, pane);
    navigateTo(tab.target);
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    if (!over) return;
    const id = String(active.id);
    const overId = String(over.id);
    if (id === overId) return;
    const pane =
      overId === "pane:side"
        ? "side"
        : overId === "pane:main"
          ? "main"
          : workspaceTabPane(layout, overId);
    if (!pane) return;
    const index = layout[pane].tabIds.indexOf(overId);
    useWorkspaceStore.getState().move(projectRef, id, pane, index < 0 ? undefined : index);
    activate(id);
  };
  const resize = useResizeDrag<HTMLDivElement>(() => {
    const element = root.current;
    if (!element) return null;
    const max = Math.max(280, element.clientWidth - 360);
    return {
      width: Math.min(layout.sideWidth, max),
      edge: "left",
      resize: (width) => {
        const next = Math.max(280, Math.min(max, width));
        element.style.setProperty("--workspace-side-width", `${next}px`);
        return next;
      },
      finish: (width) => useWorkspaceStore.getState().setSideWidth(projectRef, width),
    };
  }, key);
  const mainVisible =
    !(layout.sideOpen && layout.sideExpanded) &&
    (!narrow || layout.focusedPane === "main" || !layout.sideOpen);
  const sideVisible = layout.sideOpen && (!narrow || layout.focusedPane === "side");
  const activeIds = [
    mainVisible ? layout.main.activeTabId : null,
    sideVisible ? layout.side.activeTabId : null,
  ].filter((id) => id !== null);
  const newlyVisited = activeIds.filter(
    (id) => layout.tabs[id]?.kind === "tool" && !visitedTools.has(id),
  );
  if (newlyVisited.length) setVisitedTools(new Set([...visitedTools, ...newlyVisited]));
  const refs = new Map<string, ScopedThreadRef>();
  for (const tab of Object.values(layout.tabs)) {
    if (tab.kind === "agents") continue;
    if (
      tab.kind === "tool" &&
      !selectThreadRightPanelState(panelStates, tab.threadRef).surfaces.some(
        (surface) => surface.id === tab.surfaceId && surface.kind === "preview",
      )
    )
      continue;
    const ref = workspaceTabRef(tab);
    if (ref) refs.set(scopedThreadKey(ref), ref);
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden md:h-dvh">
      {owner ? (
        <WorkspaceCommands projectRef={projectRef} threadRef={owner} layout={layout} />
      ) : null}
      <div className="flex h-[var(--workspace-topbar-height)] shrink-0 items-center border-b border-border px-4 pl-12 text-sm font-medium [-webkit-app-region:drag]">
        <span className="flex-1">{project?.title ?? "Project"}</span>
        {narrow && layout.sideOpen ? (
          <div className="[-webkit-app-region:no-drag]">
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                useWorkspaceStore
                  .getState()
                  .focus(projectRef, layout.focusedPane === "main" ? "side" : "main")
              }
            >
              Show {layout.focusedPane === "main" ? "side" : "main"} pane
            </Button>
          </div>
        ) : null}
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={(args) => {
          const hits = pointerWithin(args);
          return hits.length ? hits : rectIntersection(args);
        }}
        onDragStart={({ active }) => setDragging(String(active.id))}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <div
          ref={root}
          className="relative grid min-h-0 flex-1 overflow-hidden"
          data-project-workspace=""
          style={
            {
              "--workspace-side-width": `${layout.sideWidth}px`,
              gridTemplateColumns:
                mainVisible && sideVisible
                  ? "minmax(0, 1fr) 4px minmax(280px, min(var(--workspace-side-width), 55%))"
                  : "minmax(0, 1fr)",
              gridTemplateRows: "40px minmax(0, 1fr)",
            } as CSSProperties
          }
        >
          {(["main", "side"] as const).map((pane) => {
            const visible = pane === "main" ? mainVisible : sideVisible;
            if (!visible) return null;
            return (
              <div
                key={pane}
                className="min-w-0"
                style={{ gridColumn: pane === "side" && mainVisible ? 3 : 1, gridRow: 1 }}
              >
                <WorkspaceTabs
                  projectRef={projectRef}
                  layout={layout}
                  pane={pane}
                  owner={owner}
                  onActivate={activate}
                  onClose={close}
                  onNewChat={() => void newChat(pane)}
                  onReopen={() => reopen(pane)}
                />
              </div>
            );
          })}
          {mainVisible && sideVisible ? (
            <div
              role="separator"
              aria-label="Resize side pane"
              aria-orientation="vertical"
              tabIndex={0}
              className="z-20 row-span-2 col-start-2 row-start-1 cursor-col-resize bg-border hover:bg-primary/50 focus-visible:bg-primary"
              {...resize}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault();
                  useWorkspaceStore
                    .getState()
                    .setSideWidth(
                      projectRef,
                      layout.sideWidth + (event.key === "ArrowLeft" ? 24 : -24),
                    );
                }
              }}
            />
          ) : null}
          {Object.values(layout.tabs).map((tab) => {
            const pane = workspaceTabPane(layout, tab.id);
            if (!pane) return null;
            const visible = activeIds.includes(tab.id);
            if (!visible && (tab.kind !== "tool" || !visitedTools.has(tab.id))) return null;
            const focused = visible && layout.focusedPane === pane;
            const ref = workspaceTabRef(tab);
            const surface =
              tab.kind === "tool"
                ? selectThreadRightPanelState(panelStates, tab.threadRef).surfaces.find(
                    (entry) => entry.id === tab.surfaceId,
                  )
                : null;
            return (
              <section
                key={tab.id}
                role="tabpanel"
                aria-label={`${pane} pane content`}
                hidden={!visible}
                inert={!visible}
                data-workspace-content={tab.id}
                className="relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-background"
                style={{
                  gridColumn: pane === "side" && mainVisible ? 3 : 1,
                  gridRow: 2,
                  display: visible ? undefined : "none",
                }}
                onPointerDownCapture={() => {
                  if (!focused) activate(tab.id);
                }}
                onFocusCapture={() => {
                  if (!focused) activate(tab.id);
                }}
              >
                {tab.kind === "chat" ? (
                  <ThreadRouteView
                    target={tab.target}
                    embedded
                    focused={focused}
                    onPromote={promote}
                  />
                ) : tab.kind === "agents" ? (
                  <ThreadRelationshipsPanel
                    environmentId={tab.threadRef.environmentId}
                    threadId={tab.threadRef.threadId}
                  />
                ) : surface ? (
                  <WorkspaceToolView
                    projectRef={projectRef}
                    threadRef={tab.threadRef}
                    surface={surface}
                    pane={pane}
                    focused={focused}
                    visible={visible}
                    onOpenChat={() => {
                      if (!ref) return;
                      const next = workspaceOwnerTarget(ref);
                      const id = workspaceChatId(next);
                      useWorkspaceStore
                        .getState()
                        .open(projectRef, { id, kind: "chat", target: next }, pane);
                      navigateTo(next);
                    }}
                  />
                ) : (
                  <div className="p-6 text-sm text-muted-foreground">
                    This surface is no longer available.
                  </div>
                )}
              </section>
            );
          })}
          {(["main", "side"] as const).map((pane) =>
            (pane === "main" ? mainVisible : sideVisible) && !layout[pane].activeTabId ? (
              <div
                key={`empty:${pane}`}
                className="flex min-h-0 flex-col items-center justify-center gap-3 text-sm text-muted-foreground"
                style={{ gridColumn: pane === "side" && mainVisible ? 3 : 1, gridRow: 2 }}
              >
                <p>Open a tab or drag one here.</p>
                <Button variant="outline" onClick={() => void newChat(pane)}>
                  New chat
                </Button>
              </div>
            ) : null,
          )}
          {dragging && !layout.sideOpen ? <SideDropTarget /> : null}
        </div>
        <DragOverlay dropAnimation={null}>
          {dragging ? (
            <div className="rounded border border-border bg-background px-4 py-2 text-sm shadow-lg">
              Move tab
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      {[...refs].map(([id, ref]) => (
        <WorkspacePreviewSync key={id} threadRef={ref} />
      ))}
    </SidebarInset>
  );
}
