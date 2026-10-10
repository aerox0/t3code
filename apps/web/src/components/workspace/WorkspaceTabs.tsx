import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import {
  Bot,
  File,
  Files,
  GitCompare,
  Globe,
  MessageSquare,
  MoreHorizontal,
  PanelRight,
  Plus,
  Smartphone,
  Terminal,
  X,
} from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { useWorkspaceThread } from "./useWorkspaceTools";
import { useThreadShell } from "~/state/entities";
import { useThreadPreviewState } from "~/previewStateStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { cn } from "~/lib/utils";
import {
  useWorkspaceStore,
  type ProjectWorkspace,
  type WorkspacePane,
  type WorkspaceTab,
} from "~/workspaceStore";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { workspaceTabRef } from "./workspaceBindings";
import { useWorkspaceTools } from "./useWorkspaceTools";

const icons = {
  preview: Globe,
  terminal: Terminal,
  files: Files,
  file: File,
  diff: GitCompare,
  "pull-request": PullRequestGlyph.pullRequest,
  "pull-requests": PullRequestGlyph.pullRequest,
  device: Smartphone,
};

function WorkspaceTabButton({
  tab,
  active,
  onActivate,
  onClose,
}: {
  tab: WorkspaceTab;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const ref = workspaceTabRef(tab);
  const thread = useThreadShell(ref);
  const context = useWorkspaceThread(ref);
  const surface = useRightPanelStore((state) =>
    tab.kind === "tool"
      ? selectThreadRightPanelState(state.byThreadKey, tab.threadRef).surfaces.find(
          (entry) => entry.id === tab.surfaceId,
        )
      : undefined,
  );
  const previews = useThreadPreviewState(surface?.kind === "preview" ? ref : null);
  const snapshot =
    surface?.kind === "preview" && surface.resourceId
      ? previews.sessions[surface.resourceId]
      : null;
  const title =
    tab.kind === "chat"
      ? (thread?.title ?? "New chat")
      : tab.kind === "agents"
        ? "Agents"
        : surface?.kind === "file"
          ? (surface.relativePath.split(/[\\/]/).at(-1) ?? "File")
          : surface?.kind === "preview"
            ? (snapshot && snapshot.navStatus._tag !== "Idle" ? snapshot.navStatus.title : null) ||
              "Browser"
            : surface?.kind === "terminal"
              ? "Terminal"
              : surface?.kind === "files"
                ? "Files"
                : surface?.kind === "diff"
                  ? "Changes"
                  : surface?.kind === "device"
                    ? (surface.title ?? "Device")
                    : surface?.kind === "pull-request"
                      ? `PR #${surface.number}`
                      : "Pull requests";
  const Icon =
    tab.kind === "chat"
      ? MessageSquare
      : tab.kind === "agents"
        ? Bot
        : surface
          ? icons[surface.kind]
          : File;
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({ id: tab.id });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "group flex h-10 min-w-24 max-w-52 shrink-0 items-center border-r border-border",
        active ? "bg-background text-foreground" : "bg-muted/30 text-muted-foreground",
        isDragging && "opacity-40",
      )}
      data-workspace-tab={tab.id}
    >
      <Tooltip>
        <TooltipTrigger
          render={<button />}
          {...attributes}
          {...listeners}
          type="button"
          role="tab"
          aria-selected={active}
          aria-label={title}
          tabIndex={active ? 0 : -1}
          className="flex h-full min-w-0 flex-1 touch-none items-center gap-2 px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={onActivate}
          onAuxClick={(event) => {
            if (event.button === 1) {
              event.preventDefault();
              onClose();
            }
          }}
        >
          <Icon className="size-3.5 shrink-0" />
          <span className="truncate">{title}</span>
        </TooltipTrigger>
        <TooltipPopup>
          <div>{title}</div>
          {tab.kind !== "chat" ? <div>Chat: {thread?.title ?? "New chat"}</div> : null}
          {context.cwd ? <div>{context.cwd}</div> : null}
        </TooltipPopup>
      </Tooltip>
      <div className="mr-1 shrink-0">
        <Button size="icon-xs" variant="ghost" aria-label={`Close ${title} tab`} onClick={onClose}>
          <X />
        </Button>
      </div>
    </div>
  );
}

function ToolMenuItems({
  projectRef,
  threadRef,
  pane,
}: {
  projectRef: ScopedProjectRef;
  threadRef: ScopedThreadRef;
  pane: WorkspacePane;
}) {
  const tools = useWorkspaceTools(projectRef, threadRef, pane);
  return (
    <>
      <MenuItem disabled={!tools.browserAvailable} onClick={() => void tools.addBrowser()}>
        <Globe />
        Browser
      </MenuItem>
      <MenuItem
        disabled={!tools.canTerminal || !tools.cwd}
        onClick={() => void tools.addTerminal()}
      >
        <Terminal />
        Terminal
      </MenuItem>
      <MenuItem onClick={() => tools.add("files")}>
        <Files />
        Files
      </MenuItem>
      <MenuItem disabled={!tools.thread} onClick={() => tools.add("diff")}>
        <GitCompare />
        Changes
      </MenuItem>
      <MenuItem disabled={!tools.thread} onClick={() => tools.add("pull-requests")}>
        <PullRequestGlyph.pullRequest />
        Pull requests
      </MenuItem>
      <MenuItem onClick={() => tools.add("device")}>
        <Smartphone />
        Device
      </MenuItem>
      <MenuItem onClick={() => tools.add("agents")}>
        <Bot />
        Agents
      </MenuItem>
    </>
  );
}

export function WorkspaceTabs({
  projectRef,
  layout,
  pane,
  owner,
  onActivate,
  onClose,
  onNewChat,
  onReopen,
}: {
  projectRef: ScopedProjectRef;
  layout: ProjectWorkspace;
  pane: WorkspacePane;
  owner: ScopedThreadRef | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNewChat: () => void;
  onReopen: () => void;
}) {
  const state = layout[pane];
  const { setNodeRef, isOver } = useDroppable({ id: `pane:${pane}` });
  const other = pane === "main" ? "side" : "main";
  const moveTab = useWorkspaceStore((state) => state.move);
  const setSideOpen = useWorkspaceStore((state) => state.setSideOpen);
  const setSideExpanded = useWorkspaceStore((state) => state.setSideExpanded);
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex h-10 min-w-0 items-center border-b border-border bg-muted/20 [-webkit-app-region:no-drag]",
        isOver && "ring-2 ring-inset ring-primary",
      )}
      data-workspace-tabs={pane}
    >
      <div
        role="tablist"
        aria-label={`${pane === "main" ? "Main" : "Side"} pane tabs`}
        className="flex min-w-0 flex-1 overflow-x-auto"
        onKeyDown={(event) => {
          if (
            !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
          )
            return;
          const index = state.tabIds.indexOf(state.activeTabId ?? "");
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? state.tabIds.length - 1
                : (index + (event.key === "ArrowRight" ? 1 : -1) + state.tabIds.length) %
                  state.tabIds.length;
          const id = state.tabIds[next];
          if (id) {
            event.preventDefault();
            onActivate(id);
            event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
          }
        }}
      >
        <SortableContext items={state.tabIds} strategy={horizontalListSortingStrategy}>
          {state.tabIds.map((id) =>
            layout.tabs[id] ? (
              <WorkspaceTabButton
                key={id}
                tab={layout.tabs[id]}
                active={id === state.activeTabId}
                onActivate={() => onActivate(id)}
                onClose={() => onClose(id)}
              />
            ) : null,
          )}
        </SortableContext>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 px-1">
        <Menu>
          <MenuTrigger
            render={<Button size="icon-xs" variant="ghost" aria-label={`Add ${pane} pane tab`} />}
          >
            <Plus />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={onNewChat}>
              <MessageSquare />
              New chat
            </MenuItem>
            {owner ? <ToolMenuItems projectRef={projectRef} threadRef={owner} pane={pane} /> : null}
          </MenuPopup>
        </Menu>
        <Menu>
          <MenuTrigger
            render={<Button size="icon-xs" variant="ghost" aria-label={`${pane} pane actions`} />}
          >
            <MoreHorizontal />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              disabled={!state.activeTabId}
              onClick={() => {
                if (state.activeTabId) moveTab(projectRef, state.activeTabId, other);
              }}
            >
              Move tab to {other} pane
            </MenuItem>
            <MenuItem
              disabled={!state.activeTabId}
              onClick={() => {
                if (state.activeTabId) onClose(state.activeTabId);
              }}
            >
              Close tab
            </MenuItem>
            <MenuItem disabled={!layout.closedChats.length} onClick={onReopen}>
              Reopen closed chat
            </MenuItem>
            <MenuSeparator />
            {pane === "side" ? (
              <MenuItem onClick={() => setSideExpanded(projectRef, !layout.sideExpanded)}>
                {layout.sideExpanded ? "Restore both panes" : "Expand side pane"}
              </MenuItem>
            ) : null}
            <MenuItem onClick={() => setSideOpen(projectRef, !layout.sideOpen)}>
              <PanelRight />
              {layout.sideOpen ? "Hide" : "Show"} side pane
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}
