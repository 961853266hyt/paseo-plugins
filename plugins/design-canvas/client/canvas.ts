import { type Anchor, type Comment, type CommentStatus, isOpen } from "../shared/design";
import { commentsPrompt } from "../shared/prompts";
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
}

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
        node.title = label;
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
  const browseButton = button(t("browseMode"), "pointer", () => setMode("browse"), "dc-btn");
  const commentButton = button(t("commentMode"), "comment", () => setMode("comment"), "dc-btn");
  browseButton.title = `${t("browseMode")} (V)`;
  commentButton.title = `${t("commentMode")} (C)`;
  const zoomOut = button(t("zoomOut"), "minus", () => zoomStep(-1), "dc-btn dc-icon");
  const zoomLabel = el("span", "dc-zoom", "100%");
  const zoomIn = button(t("zoomIn"), "plus", () => zoomStep(1), "dc-btn dc-icon");
  const fitButton = button(t("fit"), "fit", () => fit(), "dc-btn dc-icon");
  const guidesButton = button(t("guides"), "grid", () => setGuides(!guides), "dc-btn dc-icon");
  const status = el("span", "dc-status");
  const newButton = button(t("newDesign"), "sparkles", () => openNewDesign(), "dc-btn");
  const sideButton = button(t("comments"), "panel", () => setSideOpen(side.hidden), "dc-btn");
  toolbar.append(
    picker,
    el("span", "dc-sep"),
    browseButton,
    commentButton,
    el("span", "dc-sep"),
    zoomOut,
    zoomLabel,
    zoomIn,
    fitButton,
    guidesButton,
    el("span", "dc-spacer"),
    status,
    newButton,
    sideButton,
  );

  const body = el("div", "dc-body");
  const viewport = el("div", "dc-viewport");
  const world = el("div", "dc-world");
  viewport.append(world);
  const side = el("div", "dc-side");
  const sideHead = el("div", "dc-side-head");
  const sideTitle = el("span", "", t("comments"));
  const resolvedToggle = el("label", "dc-check");
  const resolvedBox = el("input");
  resolvedBox.type = "checkbox";
  resolvedToggle.append(resolvedBox, doc.createTextNode(t("showResolved")));
  sideHead.append(sideTitle, el("span", "dc-spacer"), resolvedToggle);
  const sideList = el("div", "dc-side-list");
  const sideFoot = el("div", "dc-side-foot");
  const sendButton = button("", "send", () => void sendComments(), "dc-btn dc-primary");
  sendButton.dataset.testid = "design-canvas-send";
  const sendLabel = el("span");
  sendButton.append(sendLabel);
  const sendHint = el("span", "dc-hint");
  sideFoot.append(sendButton, sendHint);
  side.append(sideHead, sideList, sideFoot);
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
  let mode: CanvasMode = "browse";
  let guides = false;
  let showResolved = false;
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
    };
    label.addEventListener("click", () => focusBoard(artboard.id));
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
      const reload = existing.view.version !== artboard.version || existing.view.html !== artboard.html;
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
        const meta = el("div", "dc-item-meta", comment.anchor.text || `<${comment.anchor.tag}>`);
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
    browseButton.classList.toggle("dc-on", mode === "browse");
    commentButton.classList.toggle("dc-on", mode === "comment");
    broadcast({ type: "mode", mode });
    if (mode === "browse" && popover?.state.kind === "new") closePopover();
    renderSide();
  }

  function setGuides(on: boolean): void {
    guides = on;
    guidesButton.classList.toggle("dc-on", on);
    broadcast({ type: "guides", on });
  }

  function setSideOpen(open: boolean): void {
    side.hidden = !open;
    sideButton.classList.toggle("dc-on", open);
  }

  function handleKey(key: string, meta: boolean, shift: boolean): boolean {
    if (meta && (key === "=" || key === "+")) zoomStep(1);
    else if (meta && key === "-") zoomStep(-1);
    else if (meta && key === "0") fit();
    else if (shift && (key === "G" || key === "g")) setGuides(!guides);
    else if (!meta && !shift && key === "c") setMode("comment");
    else if (!meta && !shift && key === "v") setMode("browse");
    else if (key === "Escape") {
      if (modal) closeModal();
      else if (popover) closePopover();
      else if (mode === "comment") setMode("browse");
      else return false;
    } else return false;
    return true;
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
    hideEmpty();
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
      showBanner(next.error);
      if (next.manifest) syncBoards(next);
      else clearBoards();
      refreshComments();
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
      if (slug && design && !popoverEditing()) {
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
    if (!(onBackground || spaceHeld || event.button === 1)) return;
    if (event.button !== 0 && event.button !== 1) return;
    if (popover && onBackground && !spaceHeld) closePopover();
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
    if (mode !== "comment") return;
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
    if (!spaceHeld) world.classList.remove("dc-panning");
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

  setMode("browse");
  // Focus the canvas so its shortcuts work right away; the chat keeps its own focus when shown beside it.
  if (!doc.activeElement || doc.activeElement === doc.body) root.focus({ preventScroll: true });
  setSideOpen(host.clientWidth >= 900);
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
      clearInterval(timer);
      if (toastTimer) clearTimeout(toastTimer);
      resizeObserver.disconnect();
      win.removeEventListener("message", onMessage);
      root.remove();
    },
  };
}
