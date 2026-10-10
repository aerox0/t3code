import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isElectron } from "~/env";
import { useAtomValue } from "@effect/atom-react";
import { type ProjectId, type ScopedProjectRef, type ScopedThreadRef } from "@t3tools/contracts";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useThreadPreviewState } from "~/previewStateStore";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useRightPanelStore, type RightPanelSurface } from "~/rightPanelStore";
import { primaryServerAvailableEditorsAtom, primaryServerKeybindingsAtom } from "~/state/server";
import { randomUUID } from "~/lib/utils";
import type { WorkspacePane } from "~/workspaceStore";
import { PersistentThreadTerminalPanel } from "../PersistentThreadTerminalPanel";
import { useWorkspaceTools } from "./useWorkspaceTools";
import { usePreviewSession } from "../preview/usePreviewSession";

const PreviewPanel = lazy(() =>
  import("../preview/PreviewPanel").then((module) => ({ default: module.PreviewPanel })),
);
const DiffPanel = lazy(() => import("../DiffPanel"));
const FilePreviewPanel = lazy(() => import("../files/FilePreviewPanel"));
const DevicePanel = lazy(() =>
  import("../device/DevicePanel").then((module) => ({ default: module.DevicePanel })),
);
const PullRequestDetailPanel = lazy(() =>
  import("../pullRequest/PullRequestDetailPanel").then((module) => ({
    default: module.PullRequestDetailPanel,
  })),
);
const ThreadPullRequestsPanel = lazy(() =>
  import("../pullRequest/ThreadPullRequestsPanel").then((module) => ({
    default: module.ThreadPullRequestsPanel,
  })),
);

/** A surface's owner is fixed even when another chat occupies the neighbouring pane. */
export function WorkspaceToolView({
  projectRef,
  threadRef,
  surface,
  pane,
  focused,
  visible,
  onOpenChat,
}: {
  projectRef: ScopedProjectRef;
  threadRef: ScopedThreadRef;
  surface: RightPanelSurface;
  pane: WorkspacePane;
  focused: boolean;
  visible: boolean;
  onOpenChat: () => void;
}) {
  const tools = useWorkspaceTools(projectRef, threadRef, pane);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const editors = useAtomValue(primaryServerAvailableEditorsAtom);
  const [pendingPaths, setPendingPaths] = useState<ReadonlySet<string>>(() => new Set());
  const onPendingChange = useCallback(
    (path: string, pending: boolean) =>
      setPendingPaths((previous) => {
        const next = new Set(previous);
        if (pending) next.add(path);
        else next.delete(path);
        return next;
      }),
    [],
  );
  if (!tools.project)
    return (
      <div className="p-6 text-sm text-muted-foreground">
        This tab’s project is unavailable. Reconnect to its environment or close the tab.
      </div>
    );
  const composerTarget = tools.composerTarget;
  let content;
  switch (surface.kind) {
    case "preview":
      content = (
        <PreviewPanel
          mode="embedded"
          threadRef={threadRef}
          tabId={surface.resourceId}
          visible={visible}
          shortcutsEnabled={focused}
          layoutVersion={pane}
          onSendAnnotation={(annotation, image) => {
            const store = useComposerDraftStore.getState();
            store.addPreviewAnnotation(composerTarget, annotation);
            if (image) store.addImage(composerTarget, image);
            onOpenChat();
          }}
        />
      );
      break;
    case "terminal":
      content = (
        <PersistentThreadTerminalPanel
          threadRef={threadRef}
          surface={surface}
          visible={visible}
          launchContext={null}
          focusRequestId={focused ? 1 : 0}
          autoFocus={focused}
          keybindings={keybindings}
          onAddTerminalContext={(selection) => {
            useComposerDraftStore.getState().addTerminalContext(composerTarget, {
              ...selection,
              id: randomUUID(),
              threadId: threadRef.threadId,
              createdAt: new Date().toISOString(),
            });
            onOpenChat();
          }}
          onSplitTerminal={() =>
            void tools.addTerminal({ surfaceId: surface.id, direction: "horizontal" })
          }
          onSplitTerminalVertical={() =>
            void tools.addTerminal({ surfaceId: surface.id, direction: "vertical" })
          }
          onNewTerminal={() => void tools.addTerminal()}
          onActiveTerminalChange={(id) =>
            useRightPanelStore.getState().activateTerminal(threadRef, surface.id, id)
          }
          onCloseTerminal={(id) => void tools.closeTerminalSession(surface.id, id)}
        />
      );
      break;
    case "diff":
      content = (
        <DiffPanel
          mode="embedded"
          threadRef={threadRef}
          composerDraftTarget={composerTarget}
          workspaceMutationId={tools.thread?.updatedAt ?? null}
        />
      );
      break;
    case "files":
    case "file":
      content = (
        <FilePreviewPanel
          environmentId={threadRef.environmentId}
          cwd={tools.cwd ?? ""}
          projectName={tools.project.title}
          threadRef={threadRef}
          composerDraftTarget={composerTarget}
          keybindings={keybindings}
          availableEditors={editors}
          relativePath={surface.kind === "file" ? surface.relativePath : null}
          {...(surface.kind === "file" && surface.attachment
            ? { attachment: surface.attachment }
            : {})}
          revealLine={surface.kind === "file" ? surface.revealLine : null}
          revealRequestId={surface.kind === "file" ? surface.revealRequestId : 0}
          onOpenFile={tools.openFile}
          onAddToChat={(mention) => {
            const store = useComposerDraftStore.getState();
            const prompt = store.getComposerDraft(composerTarget)?.prompt ?? "";
            store.setPrompt(
              composerTarget,
              `${prompt}${prompt && !/\s$/.test(prompt) ? " " : ""}${mention} `,
            );
            onOpenChat();
          }}
          onPendingChange={onPendingChange}
          selectedFilePending={surface.kind === "file" && pendingPaths.has(surface.relativePath)}
          workspaceMutationId={tools.thread?.updatedAt ?? null}
        />
      );
      break;
    case "device":
      content = (
        <DevicePanel
          mode="embedded"
          threadRef={threadRef}
          surface={surface}
          visible={visible}
          onDismissSetup={() => void tools.closeSurface(surface)}
        />
      );
      break;
    case "pull-requests":
      content = <ThreadPullRequestsPanel threadRef={threadRef} />;
      break;
    case "pull-request":
      content = (
        <PullRequestDetailPanel
          environmentId={threadRef.environmentId}
          threadRef={threadRef}
          reference={{
            projectId: surface.projectId as ProjectId,
            repository: surface.repository,
            number: surface.number,
            ...(surface.host ? { host: surface.host } : {}),
          }}
          shortcutsEnabled={focused && visible}
          getShortcutContext={() => ({
            terminalFocus: false,
            terminalOpen: false,
            previewFocus: false,
            previewOpen: false,
            editableFocus: false,
            modelPickerOpen: false,
            isWeb: !isElectron,
            isDesktop: isElectron,
          })}
          composerDraftTarget={composerTarget}
          onSelectPullRequest={(reference) =>
            useRightPanelStore.getState().openPullRequest(threadRef, {
              projectId: reference.projectId,
              repository: reference.repository,
              number: reference.number,
              ...(reference.host ? { host: reference.host } : {}),
            })
          }
        />
      );
      break;
  }
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      {content}
    </Suspense>
  );
}

export function WorkspacePreviewSync({ threadRef: inputRef }: { threadRef: ScopedThreadRef }) {
  const { environmentId, threadId } = inputRef;
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  usePreviewSession(threadRef);
  const state = useThreadPreviewState(threadRef);
  useEffect(() => {
    if (!state.listLoaded) return;
    useRightPanelStore.getState().reconcileBrowserSurfaces(
      threadRef,
      Object.keys(state.sessions),
      new Set(
        Object.values(state.sessions)
          .filter((session) => session.runtime === "server" && session.reveal === false)
          .map((session) => session.tabId),
      ),
    );
  }, [threadRef, state.listLoaded, state.sessions]);
  return null;
}
