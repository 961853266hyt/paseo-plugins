import { type Anchor, type Comment, type CommentStatus, isOpen, type MoveStyle, type TextTarget } from "../shared/design";
import { applyTweaksPrompt, commentsPrompt, tweaksPrompt } from "../shared/prompts";
import type { ArtboardView, DesignSummary, DesignView } from "../shared/rpc";
import {
  type CanvasMode,
  type FromRuntime,
  fromRuntimeSchema,
  type Picked,
  type Pin,
  PROTOCOL_MARK,
  type RuntimeCommand,
} from "../shared/runtime-protocol";
import {
  checkValue,
  effectiveValue,
  formatValue,
  overrides,
  prune,
  type Tweak,
  type TweakValue,
  type TweakValues,
  usesVariable,
} from "../shared/tweaks";
import { icon, type IconName } from "./icons";
import {
  bounds,
  centerOn,
  DEFAULT_PAGE_HEIGHT,
  fitView,
  layoutBoards,
  MAX_PAGE_HEIGHT,
  type Placed,
  stepZoom,
  type View,
  zoomAt,
} from "./layout";
import { buildSrcdoc } from "./runtime";
import { applyTheme, CANVAS_CSS, type ThemeColors } from "./styles";

export type Translate = (key: string, values?: Record<string, string>) => string;
export type AgentStatus = "initializing" | "idle" | "running" | "error" | "closed" | null;

export interface DesignList {
  initialized: boolean;
  designs: DesignSummary[];
  version: string;
}

/** Everything the canvas needs from Paseo, so it can run against fakes in tests. */
export interface CanvasApi {
  listDesigns(): Promise<DesignList>;
  getDesign(slug: string): Promise<DesignView>;
  getDesignVersion(slug: string): Promise<string>;
  addComment(slug: string, body: string, anchor: Anchor): Promise<Comment>;
  updateComment(slug: string, id: string, patch: { body?: string; status?: CommentStatus }): Promise<Comment>;
  deleteComment(slug: string, id: string): Promise<void>;
  markSent(slug: string, ids: string[]): Promise<void>;
  /** Writes a moved element's style into its page; rejects when the page changed since `expected`. */
  moveElement(slug: string, artboardId: string, dcId: string, style: MoveStyle, expected: string): Promise<{ source: string; version: string }>;
  /** Replaces one text node's text in its page; rejects when the page changed since `expected`. */
  editText(slug: string, artboardId: string, target: TextTarget, before: string, after: string, expected: string): Promise<{ source: string; version: string }>;
  /** Saves tweak values and returns each artboard's new version. */
  saveTweaks(slug: string, values: TweakValues): Promise<{ values: TweakValues; versions: Record<string, string> }>;
  /** Pins an artboard on the canvas, or with null returns it to the automatic layout. */
  moveArtboard(slug: string, artboardId: string, position: { x: number; y: number } | null): Promise<void>;
  /** Sends a message to the panel's agent, as if typed in its chat. */
  sendToAgent(text: string): Promise<void>;
  /** Sets the workspace up for the canvas and asks the agent for a new design. */
  startDesign(brief: string): Promise<void>;
}

export interface CanvasOptions {
  host: HTMLElement;
  t: Translate;
  api: CanvasApi;
  theme: ThemeColors;
  initialSlug: string | null;
  onSlugChange(slug: string | null): void;
  /** How often to look for changes on disk. */
  pollMs?: number;
}

export interface CanvasHandle {
  setTheme(colors: ThemeColors): void;
  setAgentStatus(status: AgentStatus): void;
  destroy(): void;
}

interface Board {
  view: ArtboardView;
  wrap: HTMLDivElement;
  label: HTMLDivElement;
  frame: HTMLIFrameElement | null;
  error: HTMLDivElement | null;
  /** The fixed height, else the page's own height once it reports it. */
  height: number;
  ready: boolean;
  placed: Placed | null;
  /** The version our own last write produced, so the canvas does not reload a page it just edited. */
  selfVersion: string | null;
  /** Writes to this page, one after another. */
  writing: Promise<void>;
  /** The user is typing in this page, so it must not reload. */
  editing: boolean;
}

type UndoEntry =
  | { kind: "element"; boardId: string; dcId: string; before: MoveStyle; after: MoveStyle }
  | { kind: "text"; boardId: string; target: TextTarget; before: string; after: string }
  | { kind: "artboard"; boardId: string; before: { x: number; y: number } | null; after: { x: number; y: number } | null };

type Popover =
  | { kind: "new"; boardId: string; picked: Picked; viewport: { x: number; y: number; width: number; height: number } }
  | { kind: "existing"; id: string; boardId: string; viewport: { x: number; y: number; width: number; height: number }; editing: boolean };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function mountCanvas(options: CanvasOptions): CanvasHandle {
  const { host, t, api } = options;
  const doc = host.ownerDocument;
  const win = doc.defaultView;
  if (!win) throw new Error("The canvas needs a window");

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label: string, iconName: IconName | null, onClick: () => void, className = "dc-btn"): HTMLButtonElement {
    const node = el("button", className);
    node.type = "button";
    node.innerHTML = iconName ? icon(iconName) : "";
    if (label) {
      if (className.includes("dc-icon")) {
        // Our own tooltip: the native title one waits about a second and Paseo often never shows it.
        // A trailing "(V)" or "（⌘/Ctrl+0）" becomes the shortcut shown beside the name.
        const match = /^(.*?)\s*[(（]([^()（）]+)[)）]$/.exec(label);
        node.dataset.tip = match ? match[1]! : label;
        if (match) node.dataset.key = match[2]!;
        node.setAttribute("aria-label", label);
      } else node.append(doc.createTextNode(label));
    }
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
    });
    return node;
  }

  // ---- Structure ---------------------------------------------------------------------------

  const root = el("div", "dc-root");
  root.tabIndex = 0;
  root.dataset.testid = "design-canvas";
  const style = el("style");
  style.textContent = CANVAS_CSS;
  root.append(style);
  applyTheme(root, options.theme);

  const toolbar = el("div", "dc-toolbar");
  const picker = el("select", "dc-select");
  picker.setAttribute("aria-label", t("designPicker"));
  const tools: Array<[CanvasMode, HTMLButtonElement]> = [
    ["move", button(`${t("toolMove")} (V)`, "pointer", () => setMode("move"), "dc-btn dc-icon")],
    ["hand", button(`${t("toolHand")} (H)`, "hand", () => setMode("hand"), "dc-btn dc-icon")],
    ["comment", button(`${t("commentMode")} (C)`, "comment", () => setMode("comment"), "dc-btn dc-icon")],
    ["preview", button(`${t("toolPreview")} (P)`, "play", () => setMode("preview"), "dc-btn dc-icon")],
  ];
  for (const [name, node] of tools) node.dataset.tool = name;
  const zoomOut = button(t("zoomOut"), "minus", () => zoomStep(-1), "dc-btn dc-icon");
  const zoomLabel = el("span", "dc-zoom", "100%");
  const zoomIn = button(t("zoomIn"), "plus", () => zoomStep(1), "dc-btn dc-icon");
  const fitButton = button(t("fit"), "fit", () => fit(), "dc-btn dc-icon");
  const guidesButton = button(t("guides"), "grid", () => setGuides(!guides), "dc-btn dc-icon");
  const status = el("span", "dc-status");
  const newButton = button(t("newDesign"), "sparkles", () => openNewDesign(), "dc-btn");
  const sideButton = button(t("comments"), "panel", () => toggleSide("comments"), "dc-btn");
  const tweaksButton = button(t("tweaks"), "sliders", () => toggleSide("tweaks"), "dc-btn");
  toolbar.append(
    picker,
    el("span", "dc-sep"),
    ...tools.map(([, node]) => node),
    el("span", "dc-sep"),
    zoomOut,
    zoomLabel,
    zoomIn,
    fitButton,
    guidesButton,
    el("span", "dc-spacer"),
    status,
    newButton,
    tweaksButton,
    sideButton,
  );

  const body = el("div", "dc-body");
  const viewport = el("div", "dc-viewport");
  const world = el("div", "dc-world");
  viewport.append(world);
  const side = el("div", "dc-side");
  const sideHead = el("div", "dc-side-head");
  const commentsTab = button(t("comments"), null, () => setSide("comments"), "dc-tab");
  const tweaksTab = button(t("tweaks"), null, () => setSide("tweaks"), "dc-tab");
  const resolvedToggle = el("label", "dc-check");
  const resolvedBox = el("input");
  resolvedBox.type = "checkbox";
  resolvedToggle.append(resolvedBox, doc.createTextNode(t("showResolved")));
  sideHead.append(commentsTab, tweaksTab);
  const commentsPane = el("div", "dc-pane");
  const commentsBar = el("div", "dc-pane-bar");
  commentsBar.append(resolvedToggle);
  const sideList = el("div", "dc-side-list");
  const sideFoot = el("div", "dc-side-foot");
  const sendButton = button("", "send", () => void sendComments(), "dc-btn dc-primary");
  sendButton.dataset.testid = "design-canvas-send";
  const sendLabel = el("span");
  sendButton.append(sendLabel);
  const sendHint = el("span", "dc-hint");
  sideFoot.append(sendButton, sendHint);
  commentsPane.append(commentsBar, sideList, sideFoot);
  const tweaksPane = el("div", "dc-pane");
  tweaksPane.dataset.testid = "design-canvas-tweaks";
  const tweakList = el("div", "dc-side-list dc-tweaks");
  const tweakFoot = el("div", "dc-side-foot");
  const tweakActions = el("div", "dc-row dc-tweak-actions");
  const resetButton = button(t("resetTweaks"), "reopen", () => void resetTweaks());
  const applyButton = button(t("applyTweaks"), "check", () => void applyTweaks());
  tweakActions.append(resetButton, applyButton);
  const suggestButton = button(t("suggestTweaks"), "sparkles", () => void suggestTweaks(), "dc-btn dc-primary");
  const tweakHint = el("span", "dc-hint");
  tweakFoot.append(tweakActions, suggestButton, tweakHint);
  tweaksPane.append(tweakList, tweakFoot);
  side.append(sideHead, commentsPane, tweaksPane);
  body.append(viewport, side);
  root.append(toolbar, body);
  host.append(root);

  // ---- State -------------------------------------------------------------------------------

  let destroyed = false;
  let list: DesignList | null = null;
  let slug: string | null = options.initialSlug;
  let design: DesignView | null = null;
  let comments: Comment[] = [];
  const boards = new Map<string, Board>();
  let view: View = { x: 48, y: 48, zoom: 1 };
  let userMoved = false;
  let mode: CanvasMode = "move";
  const undoStack: UndoEntry[] = [];
  const redoStack: UndoEntry[] = [];
  const pendingMoves = new Map<string, { board: Board; dcId: string; before: MoveStyle; after: MoveStyle; timer: ReturnType<typeof setTimeout> }>();
  let unmovableToastAt = 0;
  let guides = false;
  let showResolved = false;
  let sideTab: "comments" | "tweaks" = "comments";
  /** The tweak values on screen; ahead of the server's while a save is pending. */
  let tweakValues: TweakValues = {};
  let tweakSave: ReturnType<typeof setTimeout> | null = null;
  let tweakSaving: Promise<void> = Promise.resolve();
  let tweaksInFlight = 0;
  let tweaksRendered = "";
  let popover: { state: Popover; node: HTMLDivElement } | null = null;
  let agentStatus: AgentStatus = null;
  let sending = false;
  let expectingNew = false;
  let spaceHeld = false;
  let banner: HTMLDivElement | null = null;
  let empty: HTMLDivElement | null = null;
  let modal: HTMLDivElement | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let layoutQueued = false;

  // ---- Small helpers -----------------------------------------------------------------------

  function toast(message: string): void {
    root.querySelector(".dc-toast")?.remove();
    const node = el("div", "dc-toast", message);
    root.append(node);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.remove(), 3500);
  }

  function fail(error: unknown): void {
    toast(t("error", { error: describe(error) }));
  }

  function post(board: Board, message: RuntimeCommand): void {
    board.frame?.contentWindow?.postMessage({ mark: PROTOCOL_MARK, ...message }, "*");
  }

  function broadcast(message: RuntimeCommand): void {
    for (const board of boards.values()) if (board.ready) post(board, message);
  }

  function viewportSize(): { width: number; height: number } {
    return { width: viewport.clientWidth, height: viewport.clientHeight };
  }

  /** A box inside a board's page, in viewport pixels. */
  function toScreen(boardId: string, rect: { x: number; y: number; width: number; height: number }) {
    const placed = boards.get(boardId)?.placed;
    if (!placed) return null;
    return {
      x: view.x + (placed.x + rect.x) * view.zoom,
      y: view.y + (placed.y + rect.y) * view.zoom,
      width: rect.width * view.zoom,
      height: rect.height * view.zoom,
    };
  }

  // ---- View --------------------------------------------------------------------------------

  let sentZoom = 0;
  let zoomQueued = false;
  function sendZoom(): void {
    zoomQueued = false;
    if (sentZoom === view.zoom) return;
    sentZoom = view.zoom;
    broadcast({ type: "zoom", zoom: view.zoom });
  }

  function applyView(): void {
    if (!zoomQueued && sentZoom !== view.zoom) {
      zoomQueued = true;
      win!.requestAnimationFrame(sendZoom);
    }
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
    zoomLabel.textContent = `${Math.round(view.zoom * 100)}%`;
    for (const board of boards.values()) board.label.style.transform = `scale(${1 / view.zoom})`;
    positionPopover();
  }

  function setView(next: View, byUser: boolean): void {
    view = next;
    if (byUser) userMoved = true;
    applyView();
  }

  function contentBounds() {
    return bounds([...boards.values()].flatMap((board) => (board.placed ? [board.placed] : [])));
  }

  function fit(): void {
    const { width, height } = viewportSize();
    setView(fitView(contentBounds(), width, height), false);
    userMoved = false;
  }

  function zoomStep(direction: 1 | -1): void {
    const { width, height } = viewportSize();
    setView(zoomAt(view, stepZoom(view.zoom, direction), width / 2, height / 2), true);
  }

  function wheel(deltaX: number, deltaY: number, zoom: boolean, px: number, py: number): void {
    if (zoom) {
      const step = Math.max(-60, Math.min(60, deltaY));
      setView(zoomAt(view, view.zoom * Math.exp(-step * 0.01), px, py), true);
    } else {
      setView({ ...view, x: view.x - deltaX, y: view.y - deltaY }, true);
    }
  }

  function relayout(): void {
    layoutQueued = false;
    if (!design?.manifest) return;
    const order = design.artboards.map((artboard) => boards.get(artboard.id)).filter((b): b is Board => !!b);
    const placed = layoutBoards(
      order.map((board) => ({
        id: board.view.id,
        width: board.view.width,
        height: board.height,
        ...(board.view.group !== undefined ? { group: board.view.group } : {}),
        ...(board.view.x !== undefined && board.view.y !== undefined ? { x: board.view.x, y: board.view.y } : {}),
      })),
    );
    for (const rect of placed) {
      const board = boards.get(rect.id);
      if (!board) continue;
      board.placed = rect;
      Object.assign(board.wrap.style, {
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
      if (board.frame) board.frame.style.height = `${rect.height}px`;
    }
    if (!userMoved) fit();
    else applyView();
  }

  function queueLayout(): void {
    if (layoutQueued) return;
    layoutQueued = true;
    win!.requestAnimationFrame(relayout);
  }

  // ---- Boards ------------------------------------------------------------------------------

  function boardLabel(board: Board): void {
    const { view: artboard } = board;
    board.label.innerHTML = "";
    const size = artboard.height ? `${artboard.width} × ${artboard.height}` : `${artboard.width}`;
    board.label.append(el("b", "", artboard.title), el("span", "", size));
    if (artboard.group) board.label.append(el("span", "", artboard.group));
  }

  function loadFrame(board: Board): void {
    board.error?.remove();
    board.error = null;
    if (board.view.html === null) {
      board.frame?.remove();
      board.frame = null;
      board.ready = false;
      const error = el("div", "dc-board-error", board.view.error ?? t("pageMissing"));
      board.error = error;
      board.wrap.append(error);
      return;
    }
    if (!board.frame) {
      const frame = el("iframe", "dc-board-frame");
      // No allow-same-origin: the design runs in an opaque origin and cannot reach Paseo.
      frame.setAttribute("sandbox", "allow-scripts allow-modals");
      frame.title = board.view.title;
      frame.style.width = `${board.view.width}px`;
      board.frame = frame;
      board.wrap.append(frame);
    }
    board.ready = false;
    board.frame.srcdoc = buildSrcdoc(board.view.html);
  }

  function createBoard(artboard: ArtboardView): Board {
    const wrap = el("div", "dc-board");
    wrap.dataset.board = artboard.id;
    const label = el("div", "dc-board-label");
    wrap.append(label);
    world.append(wrap);
    const board: Board = {
      view: artboard,
      wrap,
      label,
      frame: null,
      error: null,
      height: artboard.height ?? DEFAULT_PAGE_HEIGHT,
      ready: false,
      placed: null,
      selfVersion: null,
      writing: Promise.resolve(),
      editing: false,
    };
    label.addEventListener("pointerdown", (event) => startBoardDrag(board, event));
    boardLabel(board);
    loadFrame(board);
    return board;
  }

  function syncBoards(next: DesignView): void {
    const wanted = new Set(next.artboards.map((artboard) => artboard.id));
    for (const [id, board] of boards) {
      if (!wanted.has(id)) {
        board.wrap.remove();
        boards.delete(id);
      }
    }
    for (const artboard of next.artboards) {
      const existing = boards.get(artboard.id);
      if (!existing) {
        boards.set(artboard.id, createBoard(artboard));
        continue;
      }
      const ours = existing.selfVersion !== null && artboard.version === existing.selfVersion;
      const reload = !ours && (existing.view.version !== artboard.version || existing.view.html !== artboard.html);
      const resized = existing.view.width !== artboard.width || existing.view.height !== artboard.height;
      existing.view = artboard;
      boardLabel(existing);
      if (existing.frame) existing.frame.style.width = `${artboard.width}px`;
      if (artboard.height) existing.height = artboard.height;
      if (reload) loadFrame(existing);
      if (resized || reload) queueLayout();
    }
    queueLayout();
  }

  function focusBoard(boardId: string): void {
    const board = boards.get(boardId);
    if (!board?.placed) return;
    for (const other of boards.values()) other.wrap.classList.toggle("dc-focus", other === board);
    const { width, height } = viewportSize();
    const top = { ...board.placed, height: Math.min(board.placed.height, height / view.zoom) };
    setView(centerOn(view, top, width, height), true);
    setTimeout(() => board.wrap.classList.remove("dc-focus"), 1600);
  }

  // ---- Pins and comments -------------------------------------------------------------------

  function visibleComments(): Comment[] {
    return comments.filter((comment) => showResolved || isOpen(comment));
  }

  function sendPins(): void {
    const selectedId = popover?.state.kind === "existing" ? popover.state.id : null;
    for (const board of boards.values()) {
      if (!board.ready) continue;
      const pins: Pin[] = visibleComments()
        .filter((comment) => comment.anchor.artboardId === board.view.id)
        .map((comment) => ({
          id: comment.id,
          number: comment.number,
          status: comment.status,
          ...(comment.anchor.dcId ? { dcId: comment.anchor.dcId } : {}),
          path: comment.anchor.path,
          rect: comment.anchor.rect,
        }));
      post(board, { type: "pins", pins, selectedId });
    }
  }

  function pending(): Comment[] {
    return comments.filter((comment) => comment.status === "pending");
  }

  function renderSide(): void {
    sideList.innerHTML = "";
    const sections: Array<[CommentStatus, string]> = [
      ["pending", t("sectionPending")],
      ["sent", t("sectionSent")],
      ["resolved", t("sectionResolved")],
    ];
    let shown = 0;
    for (const [statusName, title] of sections) {
      if (statusName === "resolved" && !showResolved) continue;
      const items = comments.filter((comment) => comment.status === statusName);
      if (items.length === 0) continue;
      sideList.append(el("div", "dc-side-section", `${title} · ${items.length}`));
      for (const comment of items) {
        shown++;
        const item = el("div", "dc-item");
        item.dataset.comment = comment.id;
        if (popover?.state.kind === "existing" && popover.state.id === comment.id) item.classList.add("dc-on");
        const head = el("div", "dc-item-head");
        const artboard = design?.artboards.find((candidate) => candidate.id === comment.anchor.artboardId);
        head.append(el("span", `dc-num ${comment.status}`, String(comment.number)), el("span", "", artboard?.title ?? comment.anchor.artboardId));
        const meta = el("div", "dc-item-meta", comment.anchor.text || comment.anchor.dcId || `<${comment.anchor.tag}>`);
        item.append(head, el("div", "dc-item-body", comment.body), meta);
        if (comment.resolution) item.append(el("div", "dc-item-meta", `✓ ${comment.resolution}`));
        item.addEventListener("click", () => revealComment(comment.id));
        sideList.append(item);
      }
    }
    if (shown === 0) sideList.append(el("div", "dc-side-empty", t(mode === "comment" ? "noCommentsYetComment" : "noCommentsYet")));
    const count = pending().length;
    sendLabel.textContent = count ? t("sendComments", { count: String(count) }) : t("sendNone");
    const running = agentStatus === "running" || agentStatus === "initializing";
    sendButton.disabled = count === 0 || sending || running || !slug;
    sendHint.textContent = running && count ? t("agentBusy") : "";
    sideButton.lastChild?.remove();
    const open = comments.filter(isOpen).length;
    sideButton.append(doc.createTextNode(open ? `${t("comments")} · ${open}` : t("comments")));
    commentsTab.textContent = open ? `${t("comments")} · ${open}` : t("comments");
    renderTweakButtons();
  }

  function refreshComments(): void {
    renderSide();
    sendPins();
    if (popover?.state.kind === "existing" && !comments.some((comment) => popover?.state.kind === "existing" && comment.id === popover.state.id)) {
      closePopover();
    } else if (popover?.state.kind === "existing") {
      renderPopover();
    }
  }

  function revealComment(id: string): void {
    const comment = comments.find((candidate) => candidate.id === id);
    if (!comment) return;
    const board = boards.get(comment.anchor.artboardId);
    if (!board?.placed) return;
    const { width, height } = viewportSize();
    const rect = comment.anchor.rect;
    setView(centerOn(view, { x: board.placed.x + rect.x, y: board.placed.y + rect.y, width: rect.width, height: rect.height }, width, height), true);
    openPopover({ kind: "existing", id, boardId: board.view.id, viewport: rect, editing: false });
  }

  // ---- Popover -----------------------------------------------------------------------------

  function closePopover(): void {
    if (!popover) return;
    popover.node.remove();
    popover = null;
    broadcast({ type: "clear-selection" });
    sendPins();
    renderSide();
  }

  function openPopover(state: Popover): void {
    popover?.node.remove();
    popover = { state, node: el("div", "dc-popover") };
    popover.node.dataset.testid = "design-canvas-popover";
    popover.node.addEventListener("pointerdown", (event) => event.stopPropagation());
    popover.node.addEventListener("wheel", (event) => event.stopPropagation());
    viewport.append(popover.node);
    renderPopover();
    sendPins();
    renderSide();
  }

  function positionPopover(): void {
    if (!popover) return;
    const screen = toScreen(popover.state.boardId, popover.state.viewport);
    if (!screen) return;
    const { width, height } = viewportSize();
    const boxWidth = 300;
    const boxHeight = popover.node.offsetHeight || 160;
    const left = Math.min(Math.max(8, screen.x), Math.max(8, width - boxWidth - 8));
    let top = screen.y + screen.height + 8;
    if (top + boxHeight > height - 8) top = Math.max(8, screen.y - boxHeight - 8);
    popover.node.style.left = `${left}px`;
    popover.node.style.top = `${top}px`;
  }

  function composer(initial: string, submitLabel: string, onSubmit: (text: string) => Promise<void>, onCancel: () => void): HTMLElement {
    const wrap = el("div");
    const area = el("textarea", "dc-textarea");
    area.value = initial;
    area.placeholder = t("commentPlaceholder");
    const row = el("div", "dc-row");
    const hint = el("span", "dc-hint", t("submitHint"));
    const cancel = button(t("cancel"), null, onCancel);
    const submit = button(submitLabel, null, () => void go(), "dc-btn dc-primary");
    async function go(): Promise<void> {
      const text = area.value.trim();
      if (!text || submit.disabled) return;
      submit.disabled = true;
      try {
        await onSubmit(text);
      } catch (error) {
        submit.disabled = false;
        fail(error);
      }
    }
    area.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void go();
      } else if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    });
    row.append(hint, cancel, submit);
    wrap.append(area, row);
    setTimeout(() => area.focus(), 0);
    return wrap;
  }

  function renderPopover(): void {
    if (!popover) return;
    const { state, node } = popover;
    node.innerHTML = "";
    if (state.kind === "new") {
      const head = el("div", "dc-popover-head");
      const target = state.picked.dcId ? state.picked.dcId : `<${state.picked.tag}>`;
      head.append(el("b", "", t("newComment")), el("span", "", target));
      node.append(
        head,
        composer("", t("addComment"), async (text) => {
          if (!slug) return;
          const comment = await api.addComment(slug, text, { artboardId: state.boardId, ...state.picked });
          comments = [...comments, comment];
          closePopover();
          refreshComments();
        }, closePopover),
      );
    } else {
      const comment = comments.find((candidate) => candidate.id === state.id);
      if (!comment) return;
      const head = el("div", "dc-popover-head");
      head.append(el("span", `dc-num ${comment.status}`, String(comment.number)), el("b", "", t(`status_${comment.status}`)));
      head.append(el("span", "dc-spacer"), button(t("close"), "close", closePopover, "dc-btn dc-icon"));
      node.append(head);
      if (state.editing) {
        node.append(
          composer(comment.body, t("save"), async (text) => {
            if (!slug) return;
            // An edited comment the agent already saw goes out again with the next batch.
            const patch = comment.status === "sent" ? { body: text, status: "pending" as const } : { body: text };
            const updated = await api.updateComment(slug, comment.id, patch);
            comments = comments.map((candidate) => (candidate.id === updated.id ? updated : candidate));
            state.editing = false;
            refreshComments();
          }, () => {
            state.editing = false;
            renderPopover();
          }),
        );
      } else {
        node.append(el("div", "dc-popover-body", comment.body));
        if (comment.resolution) node.append(el("div", "dc-resolution", `✓ ${comment.resolution}`));
        const row = el("div", "dc-row");
        const change = async (patch: { status: CommentStatus }) => {
          if (!slug) return;
          try {
            const updated = await api.updateComment(slug, comment.id, patch);
            comments = comments.map((candidate) => (candidate.id === updated.id ? updated : candidate));
            refreshComments();
          } catch (error) {
            fail(error);
          }
        };
        row.append(
          button(t("delete"), "trash", () => {
            if (!slug) return;
            api.deleteComment(slug, comment.id).then(() => {
              comments = comments.filter((candidate) => candidate.id !== comment.id);
              closePopover();
              refreshComments();
            }, fail);
          }, "dc-btn dc-icon"),
          el("span", "dc-spacer"),
        );
        if (comment.status !== "resolved") {
          row.append(
            button(t("edit"), "edit", () => {
              state.editing = true;
              renderPopover();
            }),
            button(t("resolve"), "check", () => void change({ status: "resolved" })),
          );
        } else {
          row.append(button(t("reopen"), "reopen", () => void change({ status: "pending" })));
        }
        node.append(row);
      }
    }
    positionPopover();
  }

  // ---- Sending -----------------------------------------------------------------------------

  async function sendComments(): Promise<void> {
    const batch = pending();
    if (!slug || batch.length === 0 || sending) return;
    sending = true;
    renderSide();
    try {
      await api.sendToAgent(commentsPrompt(slug, design?.manifest ?? null, batch));
      await api.markSent(slug, batch.map((comment) => comment.id));
      const sentIds = new Set(batch.map((comment) => comment.id));
      const now = Date.now();
      comments = comments.map((comment) => (sentIds.has(comment.id) ? { ...comment, status: "sent" as const, sentAt: now } : comment));
      toast(t("sent", { count: String(batch.length) }));
    } catch (error) {
      fail(error);
    } finally {
      sending = false;
      refreshComments();
    }
  }

  // ---- Modes -------------------------------------------------------------------------------

  function setMode(next: CanvasMode): void {
    mode = next;
    root.dataset.mode = mode;
    for (const [name, node] of tools) node.classList.toggle("dc-on", name === mode);
    // Hand: the artboards stop taking the pointer, so a drag anywhere pans
    const panning = mode === "hand" || spaceHeld;
    viewport.classList.toggle("dc-grab", panning);
    world.classList.toggle("dc-panning", panning);
    broadcast({ type: "mode", mode });
    if (mode !== "comment" && popover?.state.kind === "new") closePopover();
    renderSide();
  }

  function setGuides(on: boolean): void {
    guides = on;
    guidesButton.classList.toggle("dc-on", on);
    broadcast({ type: "guides", on });
  }

  function setSide(tab: "comments" | "tweaks" | null): void {
    side.hidden = tab === null;
    if (tab) sideTab = tab;
    commentsPane.hidden = sideTab !== "comments";
    tweaksPane.hidden = sideTab !== "tweaks";
    commentsTab.classList.toggle("dc-on", sideTab === "comments");
    tweaksTab.classList.toggle("dc-on", sideTab === "tweaks");
    sideButton.classList.toggle("dc-on", tab === "comments");
    tweaksButton.classList.toggle("dc-on", tab === "tweaks");
  }

  function toggleSide(tab: "comments" | "tweaks"): void {
    setSide(!side.hidden && sideTab === tab ? null : tab);
  }

  function handleKey(key: string, meta: boolean, shift: boolean): boolean {
    if (meta && (key === "=" || key === "+")) zoomStep(1);
    else if (meta && key === "-") zoomStep(-1);
    else if (meta && key === "0") fit();
    else if (shift && (key === "G" || key === "g")) setGuides(!guides);
    else if (meta && (key === "z" || key === "Z")) void (shift ? redo() : undo());
    else if (!meta && !shift && key === "v") setMode("move");
    else if (!meta && !shift && key === "h") setMode("hand");
    else if (!meta && !shift && key === "c") setMode("comment");
    else if (!meta && !shift && key === "p") setMode("preview");
    else if (key === "Escape") {
      if (modal) closeModal();
      else if (popover) closePopover();
      else if (mode === "comment") setMode("move");
      else return false;
    } else return false;
    return true;
  }

  // ---- Moving ------------------------------------------------------------------------------

  function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * Runs one write to a page after earlier writes to it, keeping the page's source hash current.
   * On failure it puts the page back with `revert` and reloads the design.
   */
  function writePage(
    board: Board,
    write: (expected: string) => Promise<{ source: string; version: string }>,
    revert: () => void,
    errors: { conflict: string; failed: string },
  ): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      if (!slug) return false;
      try {
        const result = await write(board.view.source);
        board.view = { ...board.view, source: result.source };
        board.selfVersion = result.version;
        return true;
      } catch (error) {
        revert();
        const message = describeError(error);
        toast(/changed on disk/.test(message) ? t(errors.conflict, { file: board.view.file }) : t(errors.failed, { error: message }));
        void loadDesign();
        return false;
      }
    };
    const next = board.writing.then(run, run);
    board.writing = next.then(() => undefined);
    return next;
  }

  /** Writes one element's style. */
  function writeElement(board: Board, dcId: string, style: MoveStyle, revert: MoveStyle): Promise<boolean> {
    return writePage(
      board,
      (expected) => api.moveElement(slug!, board.view.id, dcId, style, expected),
      () => post(board, { type: "set-style", dcId, style: revert }),
      { conflict: "moveConflict", failed: "moveFailed" },
    );
  }

  /** Writes one text node's text, which the page shows already. */
  function writeText(board: Board, target: TextTarget, from: string, to: string): Promise<boolean> {
    return writePage(
      board,
      (expected) => api.editText(slug!, board.view.id, target, from, to, expected),
      () => post(board, { type: "set-text", target, text: from }),
      { conflict: "textConflict", failed: "textFailed" },
    );
  }

  async function textEdited(board: Board, target: TextTarget, before: string, after: string): Promise<void> {
    if (await writeText(board, target, before, after)) {
      undoStack.push({ kind: "text", boardId: board.view.id, target, before, after });
      redoStack.length = 0;
    }
  }

  /** Nudges arrive one per key press: merge them and write once the keys go quiet. */
  function queueMove(board: Board, dcId: string, before: MoveStyle, after: MoveStyle): void {
    const key = `${board.view.id}\u0000${dcId}`;
    const existing = pendingMoves.get(key);
    if (existing) clearTimeout(existing.timer);
    const entry = { board, dcId, before: existing?.before ?? before, after, timer: setTimeout(() => void flush(key), 250) };
    pendingMoves.set(key, entry);
  }

  async function flush(key: string): Promise<void> {
    const entry = pendingMoves.get(key);
    if (!entry) return;
    pendingMoves.delete(key);
    if (await writeElement(entry.board, entry.dcId, entry.after, entry.before)) {
      undoStack.push({ kind: "element", boardId: entry.board.view.id, dcId: entry.dcId, before: entry.before, after: entry.after });
      redoStack.length = 0;
    }
  }

  async function applyEntry(entry: UndoEntry, side: "before" | "after"): Promise<boolean> {
    const board = boards.get(entry.boardId);
    if (!board || !slug) return false;
    if (entry.kind === "element") {
      const style = entry[side];
      post(board, { type: "set-style", dcId: entry.dcId, style: style as Record<string, string> });
      return writeElement(board, entry.dcId, style, side === "before" ? entry.after : entry.before);
    }
    if (entry.kind === "text") {
      const [from, to] = side === "before" ? [entry.after, entry.before] : [entry.before, entry.after];
      post(board, { type: "set-text", target: entry.target, text: to });
      return writeText(board, entry.target, from, to);
    }
    const position = entry[side];
    try {
      await api.moveArtboard(slug, entry.boardId, position);
      setBoardPosition(board, position);
      return true;
    } catch (error) {
      toast(t("moveFailed", { error: describeError(error) }));
      return false;
    }
  }

  async function undo(): Promise<void> {
    const entry = undoStack.pop();
    if (!entry) return;
    if (await applyEntry(entry, "before")) redoStack.push(entry);
  }

  async function redo(): Promise<void> {
    const entry = redoStack.pop();
    if (!entry) return;
    if (await applyEntry(entry, "after")) undoStack.push(entry);
  }

  function setBoardPosition(board: Board, position: { x: number; y: number } | null): void {
    const { x: _x, y: _y, ...rest } = board.view;
    board.view = position ? { ...rest, x: position.x, y: position.y } : rest;
    queueLayout();
  }

  /** In the Move tool an artboard's title drags the artboard; elsewhere a click on it centres it. */
  function startBoardDrag(board: Board, event: PointerEvent): void {
    if (event.button !== 0) return;
    event.stopPropagation();
    if (mode !== "move" || !board.placed) {
      if (mode !== "hand") focusBoard(board.view.id);
      return;
    }
    event.preventDefault();
    const start = { x: board.placed.x, y: board.placed.y };
    const before = board.view.x !== undefined && board.view.y !== undefined ? { x: board.view.x, y: board.view.y } : null;
    const from = { x: event.clientX, y: event.clientY };
    let moved = false;
    board.label.setPointerCapture(event.pointerId);
    world.classList.add("dc-panning");
    const move = (next: PointerEvent) => {
      const dx = (next.clientX - from.x) / view.zoom;
      const dy = (next.clientY - from.y) / view.zoom;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3 / view.zoom) return;
      moved = true;
      if (!board.placed) return;
      board.placed = { ...board.placed, x: Math.round(start.x + dx), y: Math.round(start.y + dy) };
      board.wrap.style.left = `${board.placed.x}px`;
      board.wrap.style.top = `${board.placed.y}px`;
      positionPopover();
    };
    const up = () => {
      board.label.removeEventListener("pointermove", move);
      board.label.removeEventListener("pointerup", up);
      board.label.removeEventListener("pointercancel", up);
      if (mode !== "hand" && !spaceHeld) world.classList.remove("dc-panning");
      if (!moved) {
        focusBoard(board.view.id);
        return;
      }
      if (!board.placed || !slug) return;
      const after = { x: board.placed.x, y: board.placed.y };
      userMoved = true;
      setBoardPosition(board, after);
      api.moveArtboard(slug, board.view.id, after).then(
        () => {
          undoStack.push({ kind: "artboard", boardId: board.view.id, before, after });
          redoStack.length = 0;
        },
        (error) => {
          setBoardPosition(board, before);
          toast(t("moveFailed", { error: describeError(error) }));
        },
      );
    };
    board.label.addEventListener("pointermove", move);
    board.label.addEventListener("pointerup", up);
    board.label.addEventListener("pointercancel", up);
  }

  // ---- Tweaks ------------------------------------------------------------------------------

  function declaredTweaks(): Tweak[] {
    return design?.manifest?.tweaks ?? [];
  }

  /** Variables this design's pages were given, so a tweak that goes away is cleared too. */
  const sentVars = new Set<string>();

  function sendTweaks(board?: Board): void {
    const vars: Record<string, string> = Object.fromEntries([...sentVars].map((name) => [name, ""]));
    Object.assign(vars, overrides(declaredTweaks(), tweakValues));
    for (const name of Object.keys(vars)) sentVars.add(name);
    if (board) post(board, { type: "tweaks", vars });
    else broadcast({ type: "tweaks", vars });
  }

  function colorHex(value: string): string | null {
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
    if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
    return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
  }

  function tweakRow(tweak: Tweak): HTMLElement {
    const row = el("div", "dc-tweak");
    row.dataset.tweak = tweak.id;
    const head = el("div", "dc-tweak-head");
    const valueLabel = el("span", "dc-tweak-value");
    head.append(el("span", "dc-tweak-name", tweak.label), valueLabel);
    row.append(head);
    const show = (value: TweakValue) => {
      valueLabel.textContent = tweak.type === "toggle" ? "" : formatValue(tweak, value);
      row.classList.toggle("dc-changed", value !== tweak.default);
    };
    const value = effectiveValue(tweak, tweakValues);
    show(value);
    const change = (next: TweakValue) => {
      const checked = setTweak(tweak, next);
      if (checked !== null) show(checked);
      return checked;
    };
    if (tweak.type === "color") {
      const wrap = el("div", "dc-tweak-color");
      const swatch = el("input");
      swatch.type = "color";
      swatch.value = colorHex(String(value)) ?? "#000000";
      const field = el("input", "dc-input");
      field.value = String(value);
      field.spellcheck = false;
      swatch.addEventListener("input", () => {
        field.value = swatch.value;
        change(swatch.value);
      });
      field.addEventListener("change", () => {
        const checked = change(field.value.trim());
        if (checked === null) field.value = String(effectiveValue(tweak, tweakValues));
        else swatch.value = colorHex(String(checked)) ?? swatch.value;
      });
      wrap.append(swatch, field);
      row.append(wrap);
    } else if (tweak.type === "range") {
      const range = el("input", "dc-range");
      range.type = "range";
      range.min = String(tweak.min);
      range.max = String(tweak.max);
      range.step = String(tweak.step ?? "any");
      range.value = String(value);
      range.addEventListener("input", () => change(Number(range.value)));
      row.append(range);
    } else if (tweak.type === "toggle") {
      const label = el("label", "dc-switch");
      const box = el("input");
      box.type = "checkbox";
      box.checked = value === true;
      box.addEventListener("change", () => change(box.checked));
      label.append(box, el("span"));
      head.append(label);
    } else if (tweak.options.length <= 4) {
      const group = el("div", "dc-segments");
      const buttons = tweak.options.map((option) => {
        const node = button(option.label, null, () => {
          if (change(option.value) === null) return;
          for (const other of buttons) other.classList.toggle("dc-on", other === node);
        }, "dc-segment");
        node.classList.toggle("dc-on", option.value === value);
        return node;
      });
      group.append(...buttons);
      row.append(group);
    } else {
      const select = el("select", "dc-select");
      for (const option of tweak.options) {
        const node = el("option", "", option.label);
        node.value = option.value;
        select.append(node);
      }
      select.value = String(value);
      select.addEventListener("change", () => change(select.value));
      row.append(select);
    }
    const used = design?.artboards.some((artboard) => artboard.html !== null && usesVariable(artboard.html, tweak.var));
    if (!used) row.append(el("div", "dc-tweak-warn", t("tweakUnused", { var: tweak.var })));
    return row;
  }

  function renderTweakButtons(): void {
    const tweaks = declaredTweaks();
    const changed = Object.keys(prune(tweaks, tweakValues)).length > 0;
    const running = agentStatus === "running" || agentStatus === "initializing";
    resetButton.disabled = !changed;
    applyButton.disabled = !changed || running;
    tweakActions.hidden = tweaks.length === 0;
    suggestButton.disabled = !slug || !design?.manifest || running;
    tweakHint.textContent = running ? t("agentBusy") : tweaks.length ? t("tweaksHint") : "";
    tweaksTab.textContent = tweaks.length ? `${t("tweaks")} · ${tweaks.length}` : t("tweaks");
  }

  /** Rebuilds the panel when the tweaks or their values changed; a control being dragged is left alone. */
  function renderTweaks(force = false): void {
    const tweaks = declaredTweaks();
    const signature = JSON.stringify([tweaks, tweakValues, design?.artboards.map((artboard) => artboard.version)]);
    if (force || signature !== tweaksRendered) {
      tweaksRendered = signature;
      tweakList.innerHTML = "";
      if (tweaks.length === 0) tweakList.append(el("div", "dc-side-empty", t("tweaksEmpty")));
      for (const tweak of tweaks) tweakList.append(tweakRow(tweak));
    }
    renderTweakButtons();
  }

  function setTweak(tweak: Tweak, value: TweakValue): TweakValue | null {
    const checked = checkValue(tweak, value);
    if (checked === null) return null;
    tweakValues = { ...tweakValues, [tweak.id]: checked };
    // The panel shows this value already; don't rebuild it under the pointer.
    tweaksRendered = JSON.stringify([declaredTweaks(), tweakValues, design?.artboards.map((artboard) => artboard.version)]);
    sendTweaks();
    renderTweakButtons();
    if (tweakSave) clearTimeout(tweakSave);
    tweakSave = setTimeout(() => {
      tweakSave = null;
      void persistTweaks();
    }, 400);
    return checked;
  }

  /** Saves the values on screen, after earlier saves. */
  function persistTweaks(): Promise<boolean> {
    if (tweakSave) {
      clearTimeout(tweakSave);
      tweakSave = null;
    }
    const wanted = slug;
    if (!wanted) return Promise.resolve(false);
    const values = prune(declaredTweaks(), tweakValues);
    tweaksInFlight++;
    const run = async (): Promise<boolean> => {
      try {
        const result = await api.saveTweaks(wanted, values);
        if (slug === wanted) {
          for (const [id, version] of Object.entries(result.versions)) {
            const board = boards.get(id);
            if (board) board.selfVersion = version;
          }
        }
        return true;
      } catch (error) {
        toast(t("tweaksSaveFailed", { error: describe(error) }));
        return false;
      } finally {
        tweaksInFlight--;
      }
    };
    const next = tweakSaving.then(run, run);
    tweakSaving = next.then(() => undefined);
    return next;
  }

  async function resetTweaks(): Promise<void> {
    tweakValues = {};
    sendTweaks();
    renderTweaks(true);
    await persistTweaks();
  }

  /** The page's CSS is the agent's, so writing values into the design is the agent's job. */
  async function applyTweaks(): Promise<void> {
    if (!slug || !design?.manifest) return;
    applyButton.disabled = true;
    try {
      await persistTweaks();
      await api.sendToAgent(applyTweaksPrompt(slug, design.manifest, tweakValues));
      toast(t("tweaksApplying"));
    } catch (error) {
      fail(error);
    } finally {
      renderTweakButtons();
    }
  }

  async function suggestTweaks(): Promise<void> {
    if (!slug) return;
    suggestButton.disabled = true;
    try {
      await api.sendToAgent(tweaksPrompt(slug, design?.manifest ?? null));
      toast(t("tweaksAsked"));
    } catch (error) {
      fail(error);
    } finally {
      renderTweakButtons();
    }
  }

  // ---- Designs -----------------------------------------------------------------------------

  function clearBoards(): void {
    for (const board of boards.values()) board.wrap.remove();
    boards.clear();
    closePopover();
  }

  function showBanner(message: string | null): void {
    banner?.remove();
    banner = null;
    if (!message) return;
    banner = el("div", "dc-banner", message);
    viewport.append(banner);
  }

  function renderPicker(): void {
    picker.innerHTML = "";
    const designs = list?.designs ?? [];
    for (const summary of designs) {
      const option = el("option", "", summary.error ? `${summary.slug} ⚠` : summary.title);
      option.value = summary.slug;
      picker.append(option);
    }
    picker.hidden = designs.length === 0;
    if (slug) picker.value = slug;
  }

  function showEmpty(): void {
    // The list is polled; keep the card that is up, or a half-typed brief would be lost.
    if (empty) return;
    empty = el("div", "dc-empty");
    empty.append(newDesignCard(false));
    viewport.append(empty);
  }

  function hideEmpty(): void {
    empty?.remove();
    empty = null;
  }

  function newDesignCard(inModal: boolean): HTMLElement {
    const card = el("div", "dc-card");
    card.dataset.testid = "design-canvas-new";
    card.append(el("h2", "", t(inModal ? "newDesignTitle" : "emptyTitle")), el("p", "", t("newDesignHelp")));
    const area = el("textarea", "dc-textarea");
    area.placeholder = t("briefPlaceholder");
    const row = el("div", "dc-row");
    const submit = button(t("startDesign"), "sparkles", () => void go(), "dc-btn dc-primary");
    async function go(): Promise<void> {
      const brief = area.value.trim();
      if (!brief || submit.disabled) return;
      submit.disabled = true;
      try {
        await api.startDesign(brief);
        expectingNew = true;
        closeModal();
        toast(t("startedDesign"));
        area.value = "";
      } catch (error) {
        fail(error);
      } finally {
        submit.disabled = false;
      }
    }
    area.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void go();
      } else if (event.key === "Escape" && inModal) closeModal();
    });
    if (inModal) row.append(el("span", "dc-hint", t("submitHint")), button(t("cancel"), null, closeModal), submit);
    else row.append(el("span", "dc-hint", t("submitHint")), submit);
    card.append(area, row);
    setTimeout(() => area.focus(), 0);
    return card;
  }

  function openNewDesign(): void {
    closeModal();
    modal = el("div", "dc-modal");
    modal.addEventListener("pointerdown", (event) => {
      if (event.target === modal) closeModal();
    });
    modal.append(newDesignCard(true));
    root.append(modal);
  }

  function closeModal(): void {
    modal?.remove();
    modal = null;
  }

  async function selectDesign(next: string | null): Promise<void> {
    if (next === slug && design) return;
    slug = next;
    options.onSlugChange(next);
    design = null;
    comments = [];
    tweakValues = {};
    sentVars.clear();
    tweaksRendered = "";
    clearBoards();
    userMoved = false;
    renderPicker();
    renderSide();
    if (!next) return;
    await loadDesign();
  }

  async function loadDesign(): Promise<void> {
    if (!slug) return;
    const wanted = slug;
    try {
      const next = await api.getDesign(wanted);
      if (destroyed || slug !== wanted) return;
      design = next;
      comments = next.comments;
      // Values the user is still changing win over the saved ones.
      if (!tweakSave && tweaksInFlight === 0) tweakValues = next.tweakValues;
      showBanner(next.error);
      if (next.manifest) syncBoards(next);
      else clearBoards();
      refreshComments();
      renderTweaks();
      sendTweaks();
    } catch (error) {
      if (slug === wanted) showBanner(describe(error));
    }
  }

  async function loadList(): Promise<void> {
    const next = await api.listDesigns();
    if (destroyed) return;
    const before = new Set(list?.designs.map((summary) => summary.slug) ?? []);
    const changed = list?.version !== next.version;
    list = next;
    if (changed) renderPicker();
    const slugs = next.designs.map((summary) => summary.slug);
    if (slugs.length === 0) {
      showEmpty();
      if (slug) await selectDesign(null);
      return;
    }
    hideEmpty();
    const added = slugs.find((candidate) => !before.has(candidate));
    if (expectingNew && added) {
      expectingNew = false;
      await selectDesign(added);
    } else if (!slug || !slugs.includes(slug)) {
      await selectDesign(slugs[0] ?? null);
    } else if (changed) {
      await loadDesign();
    }
  }

  // ---- Polling -----------------------------------------------------------------------------

  let ticking = false;
  let tickCount = 0;
  async function tick(): Promise<void> {
    if (ticking || destroyed || doc.hidden) return;
    ticking = true;
    try {
      if (tickCount++ % 3 === 0) await loadList();
      if (slug && design && !popoverEditing() && ![...boards.values()].some((board) => board.editing)) {
        const version = await api.getDesignVersion(slug);
        if (!destroyed && version !== design.version) await loadDesign();
      }
    } catch {
      // A failed poll is retried on the next tick.
    } finally {
      ticking = false;
    }
  }

  /** Reloading under an open comment box would move it; wait until it closes. */
  function popoverEditing(): boolean {
    return popover?.state.kind === "new" || (popover?.state.kind === "existing" && popover.state.editing);
  }

  // ---- Events ------------------------------------------------------------------------------

  function boardFor(source: unknown): Board | null {
    for (const board of boards.values()) if (board.frame && board.frame.contentWindow === source) return board;
    return null;
  }

  function onMessage(event: MessageEvent): void {
    const board = boardFor(event.source);
    if (!board) return;
    const parsed = fromRuntimeSchema.safeParse(event.data);
    if (!parsed.success) return;
    handle(board, parsed.data);
  }

  function handle(board: Board, message: FromRuntime): void {
    switch (message.type) {
      case "ready":
        board.ready = true;
        post(board, { type: "mode", mode });
        post(board, { type: "guides", on: guides });
        post(board, { type: "zoom", zoom: view.zoom });
        sendTweaks(board);
        sendPins();
        resize(board, message.height);
        break;
      case "size":
        resize(board, message.height);
        break;
      case "pick":
        if (mode === "comment") openPopover({ kind: "new", boardId: board.view.id, picked: message.picked, viewport: message.viewport });
        break;
      case "pin":
        openPopover({ kind: "existing", id: message.id, boardId: board.view.id, viewport: message.viewport, editing: false });
        break;
      case "wheel": {
        const screen = toScreen(board.view.id, { x: message.x, y: message.y, width: 0, height: 0 });
        if (screen) wheel(message.deltaX, message.deltaY, message.zoom, screen.x, screen.y);
        break;
      }
      case "key":
        handleKey(message.key, message.meta, message.shift);
        break;
      case "moved":
        if (mode === "move") queueMove(board, message.dcId, message.before, message.after);
        break;
      case "text-edited":
        if (mode === "move") void textEdited(board, message.target, message.before, message.after);
        break;
      case "editing":
        board.editing = message.on;
        break;
      case "uneditable": {
        const now = Date.now();
        if (now - unmovableToastAt > 3000) toast(t(message.reason === "svg" ? "notEditableSvg" : "notEditable"));
        unmovableToastAt = now;
        break;
      }
      case "unmovable": {
        const now = Date.now();
        if (now - unmovableToastAt > 3000) toast(t(message.reason === "unit" ? "notMovableUnit" : "notMovable"));
        unmovableToastAt = now;
        break;
      }
      case "navigate": {
        const target = design?.artboards.find((artboard) => artboard.file === message.file);
        if (target) focusBoard(target.id);
        else toast(t("noSuchPage", { file: message.file }));
        break;
      }
    }
  }

  function resize(board: Board, height: number): void {
    if (board.view.height) return;
    const next = Math.min(MAX_PAGE_HEIGHT, Math.max(120, Math.ceil(height)));
    if (Math.abs(next - board.height) < 1) return;
    board.height = next;
    queueLayout();
  }

  win.addEventListener("message", onMessage);

  viewport.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      wheel(event.deltaX, event.deltaY, event.ctrlKey || event.metaKey, event.clientX - rect.left, event.clientY - rect.top);
    },
    { passive: false },
  );

  let drag: { x: number; y: number; view: View; pointer: number } | null = null;
  viewport.addEventListener("pointerdown", (event) => {
    const onBackground = event.target === viewport || event.target === world;
    if (!(onBackground || spaceHeld || mode === "hand" || event.button === 1)) return;
    if (event.button !== 0 && event.button !== 1) return;
    if (popover && onBackground && !spaceHeld && mode !== "hand") closePopover();
    drag = { x: event.clientX, y: event.clientY, view, pointer: event.pointerId };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add("dc-grabbing");
    world.classList.add("dc-panning");
    root.focus({ preventScroll: true });
    event.preventDefault();
  });
  // The canvas only hears the pointer when it is not over an artboard.
  let hoverClearedAt = 0;
  root.addEventListener("pointermove", () => {
    if (mode !== "comment" && mode !== "move") return;
    const now = Date.now();
    if (now - hoverClearedAt < 200) return;
    hoverClearedAt = now;
    broadcast({ type: "clear-hover" });
  });
  viewport.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    setView({ ...drag.view, x: drag.view.x + event.clientX - drag.x, y: drag.view.y + event.clientY - drag.y }, true);
  });
  const endDrag = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    drag = null;
    viewport.classList.remove("dc-grabbing");
    if (!spaceHeld && mode !== "hand") world.classList.remove("dc-panning");
  };
  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", endDrag);

  function typing(target: EventTarget | null): boolean {
    return target instanceof win!.HTMLElement && !!target.closest("textarea, input, select, [contenteditable]");
  }

  root.addEventListener("keydown", (event) => {
    if (typing(event.target)) return;
    if (event.key === " " && !event.repeat) {
      spaceHeld = true;
      viewport.classList.add("dc-grab");
      world.classList.add("dc-panning");
      event.preventDefault();
      return;
    }
    if (handleKey(event.key, event.metaKey || event.ctrlKey, event.shiftKey)) event.preventDefault();
  });
  root.addEventListener("keyup", (event) => {
    if (event.key !== " ") return;
    spaceHeld = false;
    if (mode === "hand") return;
    viewport.classList.remove("dc-grab");
    if (!drag) world.classList.remove("dc-panning");
  });

  picker.addEventListener("change", () => void selectDesign(picker.value || null));
  resolvedBox.addEventListener("change", () => {
    showResolved = resolvedBox.checked;
    refreshComments();
  });

  const resizeObserver = new win.ResizeObserver(() => {
    if (!userMoved) fit();
    else positionPopover();
  });
  resizeObserver.observe(viewport);

  setMode("move");
  // Focus the canvas so its shortcuts work right away; the chat keeps its own focus when shown beside it.
  if (!doc.activeElement || doc.activeElement === doc.body) root.focus({ preventScroll: true });
  setSide(host.clientWidth >= 900 ? "comments" : null);
  renderSide();
  applyView();
  void tick();
  const timer = setInterval(() => void tick(), options.pollMs ?? 1500);

  function renderStatus(): void {
    status.innerHTML = "";
    if (agentStatus === "running" || agentStatus === "initializing") {
      status.append(el("span", "dc-dot"), doc.createTextNode(t("agentWorking")));
    }
  }

  return {
    setTheme(colors) {
      applyTheme(root, colors);
    },
    setAgentStatus(next) {
      agentStatus = next;
      renderStatus();
      renderSide();
    },
    destroy() {
      destroyed = true;
      for (const key of [...pendingMoves.keys()]) void flush(key);
      clearInterval(timer);
      if (toastTimer) clearTimeout(toastTimer);
      resizeObserver.disconnect();
      win.removeEventListener("message", onMessage);
      root.remove();
    },
  };
}
