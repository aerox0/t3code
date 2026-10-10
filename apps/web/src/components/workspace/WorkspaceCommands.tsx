import { toggleWorkspaceTool } from "./workspaceBindings";
import {
  preventRepeatedTerminalCloseShortcut,
  preventTerminalCloseShortcut,
} from "~/lib/terminalCloseShortcut";
import { confirmTerminalClose, isTerminalCloseConfirmPending } from "~/lib/terminalCloseConfirm";
import { useAtomValue } from "@effect/atom-react";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { resolveShortcutCommand } from "~/keybindings";
import { isEditableFocused } from "~/lib/editableFocus";
import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { isElectron } from "~/env";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { useWorkspaceStore, type ProjectWorkspace } from "~/workspaceStore";
import { dispatchPreviewAction, subscribePreviewAction } from "../preview/previewActionBus";
import { useWorkspaceCloseTab, useWorkspaceTools } from "./useWorkspaceTools";

/** One shortcut owner per workspace, including while a tool has focus and no chat is mounted. */
export function WorkspaceCommands({
  projectRef,
  threadRef,
  layout,
}: {
  projectRef: ScopedProjectRef;
  threadRef: ScopedThreadRef;
  layout: ProjectWorkspace;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const tools = useWorkspaceTools(projectRef, threadRef, layout.focusedPane);
  const closeTab = useWorkspaceCloseTab(projectRef);
  const dispatch = useEffectEvent((command: string) => {
    const tab = layout.tabs[layout[layout.focusedPane].activeTabId ?? ""];
    const surface =
      tab?.kind === "tool"
        ? selectThreadRightPanelState(
            useRightPanelStore.getState().byThreadKey,
            tab.threadRef,
          ).surfaces.find((entry) => entry.id === tab.surfaceId)
        : null;
    switch (command) {
      case "rightPanel.toggle":
        useWorkspaceStore.getState().setSideOpen(projectRef, !layout.sideOpen);
        return true;
      case "rightPanel.toggleMaximized":
        useWorkspaceStore.getState().setSideExpanded(projectRef, !layout.sideExpanded);
        return true;
      case "terminal.close":
        if (surface?.kind !== "terminal" || !tools.canTerminal) return false;
        void confirmTerminalClose(["Terminal"]).then((confirmed) => {
          if (confirmed) void tools.closeTerminalSession(surface.id, surface.activeTerminalId);
        });
        return true;
      case "rightPanel.close":
        if (!tab) return false;
        void closeTab(tab);
        return true;
      case "terminal.toggle":
        if (!toggleWorkspaceTool(projectRef, threadRef, "terminal")) void tools.addTerminal();
        return true;
      case "terminal.new":
        void tools.addTerminal();
        return true;
      case "terminal.split":
      case "terminal.splitVertical":
        if (surface?.kind !== "terminal") return false;
        void tools.addTerminal({
          surfaceId: surface.id,
          direction: command === "terminal.split" ? "horizontal" : "vertical",
        });
        return true;
      case "preview.toggle":
        if (!toggleWorkspaceTool(projectRef, threadRef, "preview")) void tools.addBrowser();
        return true;
      case "diff.toggle":
        tools.add("diff");
        return true;
      case "rightPanel.new":
        document
          .querySelector<HTMLButtonElement>(`[aria-label="Add ${layout.focusedPane} pane tab"]`)
          ?.click();
        return true;
      default:
        if (surface?.kind !== "preview") return false;
        switch (command) {
          case "preview.refresh":
            dispatchPreviewAction("refresh");
            return true;
          case "preview.focusUrl":
            dispatchPreviewAction("focus-url");
            return true;
          case "preview.zoomIn":
            dispatchPreviewAction("zoom-in");
            return true;
          case "preview.zoomOut":
            dispatchPreviewAction("zoom-out");
            return true;
          case "preview.resetZoom":
            dispatchPreviewAction("reset-zoom");
            return true;
        }
        return false;
    }
  });
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      isCommandPaletteOpen() ||
      (event.target instanceof Element && event.target.closest("[data-keybinding-capture]"))
    )
      return;
    const tab = layout.tabs[layout[layout.focusedPane].activeTabId ?? ""];
    const surface =
      tab?.kind === "tool"
        ? selectThreadRightPanelState(
            useRightPanelStore.getState().byThreadKey,
            tab.threadRef,
          ).surfaces.find((entry) => entry.id === tab.surfaceId)
        : null;
    if (
      preventRepeatedTerminalCloseShortcut(event, keybindings) ||
      (isTerminalCloseConfirmPending() && preventTerminalCloseShortcut(event, keybindings))
    ) {
      event.stopPropagation();
      return;
    }
    const command = resolveShortcutCommand(event, keybindings, {
      context: {
        terminalFocus: surface?.kind === "terminal",
        terminalOpen: surface?.kind === "terminal",
        previewFocus: surface?.kind === "preview",
        previewOpen: surface?.kind === "preview",
        rightPanelOpen: true,
        editableFocus: isEditableFocused(event.target),
        isWeb: !isElectron,
        isDesktop: isElectron,
      },
    });
    if (command && !event.repeat && dispatch(command)) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", handler, true);
    const unsubscribeDesktop = window.desktopBridge?.onMenuAction((action) => {
      dispatch(action);
    });
    const unsubscribePreview = subscribePreviewAction((action) => {
      if (action === "toggle-panel") dispatch("preview.toggle");
    });
    return () => {
      window.removeEventListener("keydown", handler, true);
      unsubscribeDesktop?.();
      unsubscribePreview();
    };
  }, []);
  return null;
}
