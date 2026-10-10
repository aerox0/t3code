import {
  scopeProjectRef,
  scopeThreadRef,
  scopedProjectKey,
} from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { DraftId } from "./composerDraftStore";
import {
  useWorkspaceStore,
  workspaceChatId,
  workspaceToolId,
  restoreProjectWorkspaces,
} from "./workspaceStore";

const environmentId = EnvironmentId.make("local");
const project = scopeProjectRef(environmentId, ProjectId.make("project"));
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread"));
const target = { kind: "server", threadRef } as const;
const chat = { id: workspaceChatId(target), kind: "chat", target } as const;
const browser = {
  id: workspaceToolId(threadRef, "browser:1"),
  kind: "tool",
  threadRef,
  surfaceId: "browser:1",
} as const;
const store = () => useWorkspaceStore.getState();
const layout = () => store().byProject[scopedProjectKey(project)]!;

beforeEach(() => useWorkspaceStore.setState({ byProject: {} }));

describe("project workspace", () => {
  it.each(["activate", "open", "move", "focus"] as const)(
    "reveals main when %s selects it after expanding side",
    (action) => {
      store().open(project, chat);
      store().open(project, browser, "side");
      store().setSideExpanded(project, true);
      if (action === "activate") store().activate(project, chat.id);
      if (action === "open") store().open(project, chat);
      if (action === "move") store().move(project, browser.id, "main");
      if (action === "focus") store().focus(project, "main");
      expect(layout().sideExpanded).toBe(false);
      expect(layout().focusedPane).toBe("main");
    },
  );
  it("repairs duplicate placement and stale selections while restoring valid tabs", () => {
    store().open(project, chat);
    store().open(project, browser, "side");
    const restored = restoreProjectWorkspaces({
      byProject: {
        test: {
          ...layout(),
          main: { tabIds: [chat.id, "deleted", chat.id], activeTabId: "deleted" },
          side: { tabIds: [chat.id, browser.id], activeTabId: browser.id },
          sideWidth: Number.NaN,
        },
      },
    }).test!;
    expect(restored.main).toEqual({ tabIds: [chat.id], activeTabId: chat.id });
    expect(restored.side).toEqual({ tabIds: [browser.id], activeTabId: browser.id });
    expect(restored.sideWidth).toBe(440);
    expect(restoreProjectWorkspaces({ byProject: { broken: { tabs: null } } })).toEqual({});
  });
  it("moves a browser from side to main and back with the same resource and independent selections", () => {
    store().open(project, chat);
    store().open(project, browser, "side");
    store().move(project, browser.id, "main", 0);
    expect(layout().main).toEqual({ tabIds: [browser.id, chat.id], activeTabId: browser.id });
    expect(layout().sideOpen).toBe(false);
    expect(layout().tabs[browser.id]).toEqual(browser);
    store().move(project, browser.id, "side");
    expect(layout().main.activeTabId).toBe(chat.id);
    expect(layout().side.activeTabId).toBe(browser.id);
    expect(layout().sideOpen).toBe(true);
    expect(Object.keys(layout().tabs)).toHaveLength(2);
  });

  it("reorders within a pane without duplication and chooses the adjacent tab on close", () => {
    store().open(project, chat);
    store().open(project, browser);
    store().move(project, browser.id, "main", 0);
    store().close(project, browser.id);
    expect(layout().main).toEqual({ tabIds: [chat.id], activeTabId: chat.id });
  });

  it("hides and restores the side pane without closing its tabs", () => {
    store().open(project, browser, "side");
    store().setSideOpen(project, false);
    expect(layout().side.tabIds).toEqual([browser.id]);
    expect(layout().tabs[browser.id]).toEqual(browser);
    store().setSideOpen(project, true);
    expect(layout().side.activeTabId).toBe(browser.id);
  });

  it("promotes a background draft in place without changing either selection or focus", () => {
    const draftTarget = { kind: "draft", draftId: DraftId.make("draft") } as const;
    const draft = { id: workspaceChatId(draftTarget), kind: "chat", target: draftTarget } as const;
    store().open(project, draft);
    store().open(project, browser, "side");
    store().promoteDraft(project, draftTarget.draftId, threadRef);
    expect(layout().tabs[draft.id]).toEqual({ ...draft, target });
    expect(layout().focusedPane).toBe("side");
    expect(layout().side.activeTabId).toBe(browser.id);
    store().open(project, chat);
    expect(layout().main.tabIds).toEqual([draft.id]);
  });

  it("does not merge projects or environments with identical ids", () => {
    store().open(project, chat);
    const remote = scopeProjectRef(EnvironmentId.make("remote"), project.projectId);
    store().open(remote, browser);
    expect(layout().main.tabIds).toEqual([chat.id]);
    expect(store().byProject[scopedProjectKey(remote)]?.main.tabIds).toEqual([browser.id]);
  });

  it("keeps a moved tab in its pane when opened again and remembers closed chats", () => {
    store().open(project, chat);
    store().move(project, chat.id, "side");
    store().open(project, chat, "main");
    expect(layout().main.tabIds).toEqual([]);
    expect(layout().side.tabIds).toEqual([chat.id]);
    store().close(project, chat.id);
    expect(layout().closedChats).toEqual([chat]);
    expect(layout().sideOpen).toBe(false);
  });
});
