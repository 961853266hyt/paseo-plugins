import {
  clampPoint,
  clampRect,
  fitScale,
  fontSize,
  History,
  isMeaningfulDrag,
  type Point,
  rectFromPoints,
  type Shape,
  type Size,
  strokeWidth,
} from "./geometry";
import type { TextKey } from "./i18n";
import { icon, type IconName } from "./icons";
import { exportPng, renderScene, TEXT_LINE_HEIGHT, textFont } from "./render";

export type Tool = "pen" | "arrow" | "rect" | "text" | "blur" | "crop";

const TOOLS: readonly { tool: Tool; key: string; icon: IconName }[] = [
  { tool: "pen", key: "p", icon: "pen" },
  { tool: "arrow", key: "a", icon: "arrow" },
  { tool: "rect", key: "r", icon: "rect" },
  { tool: "text", key: "t", icon: "text" },
  { tool: "blur", key: "b", icon: "blur" },
  { tool: "crop", key: "c", icon: "crop" },
];

export const COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#ffffff", "#111111"] as const;

export type Translate = (key: TextKey, values?: Readonly<Record<string, string>>) => string;

export interface EditorOptions {
  doc: Document;
  image: CanvasImageSource;
  size: Size;
  /** File name stem for downloads and the composer attachment. */
  name: string;
  t: Translate;
  /** Null when no message box is around to take the image: only Copy and Download remain. */
  send: ((png: Blob, replaceOriginal: boolean) => Promise<void>) | null;
  /** Offer to replace the composer image the editor was opened from. */
  canReplace: boolean;
  onClose?: () => void;
}

export interface EditorHandle {
  readonly root: HTMLElement;
  close(): void;
}

type Draft =
  | { kind: "shape"; shape: Shape }
  | { kind: "crop"; from: Point; to: Point };

interface TextEdit {
  at: Point;
  color: string;
  size: number;
  input: HTMLTextAreaElement;
}

export function openEditor(options: EditorOptions): EditorHandle {
  const { doc, image, size, t } = options;
  const history = new History();
  let tool: Tool = "arrow";
  let color: string = COLORS[0];
  let step: 1 | 2 | 3 = 2;
  let draft: Draft | null = null;
  let textEdit: TextEdit | null = null;
  let scale = 1;
  let busy = false;
  let replaceOriginal = options.canReplace;
  let closed = false;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    return node;
  };

  const button = (label: string, iconName: IconName | null, onClick: () => void, text?: string) => {
    const node = el("button", "pim-btn");
    node.type = "button";
    node.title = label;
    node.setAttribute("aria-label", label);
    if (iconName) node.innerHTML = icon(iconName);
    if (text) node.append(doc.createTextNode(text));
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
    });
    return node;
  };

  // ── Layout ──────────────────────────────────────────────────────────────────────────────────
  const root = el("div", "pim-overlay");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", t("editorTitle"));
  root.dataset.testid = "image-markup-editor";

  const toolbar = el("div", "pim-toolbar");
  const toolGroup = el("div", "pim-group");
  const toolButtons = new Map<Tool, HTMLButtonElement>();
  for (const entry of TOOLS) {
    const node = button(`${t(`tools.${entry.tool}`)} (${entry.key.toUpperCase()})`, entry.icon, () => setTool(entry.tool));
    node.dataset.tool = entry.tool;
    toolButtons.set(entry.tool, node);
    toolGroup.append(node);
  }

  const colorGroup = el("div", "pim-group");
  const colorButtons = new Map<string, HTMLButtonElement>();
  for (const value of COLORS) {
    const node = button(t("color", { color: value }), null, () => {
      color = value;
      if (textEdit) textEdit.color = value;
      sync();
    });
    const swatch = el("span", "pim-swatch");
    swatch.style.background = value;
    node.append(swatch);
    colorButtons.set(value, node);
    colorGroup.append(node);
  }

  const sizeGroup = el("div", "pim-group");
  const sizeButtons = new Map<number, HTMLButtonElement>();
  for (const value of [1, 2, 3] as const) {
    const node = button(t(`sizes.${value}`), null, () => {
      step = value;
      sync();
    });
    const dot = el("span", "pim-dot");
    dot.style.width = dot.style.height = `${[5, 9, 14][value - 1]}px`;
    node.append(dot);
    sizeButtons.set(value, node);
    sizeGroup.append(node);
  }

  const undoButton = button(t("undo"), "undo", () => undo());
  const redoButton = button(t("redo"), "redo", () => redo());

  const replaceLabel = el("label", "pim-check");
  const replaceBox = el("input");
  replaceBox.type = "checkbox";
  replaceBox.checked = replaceOriginal;
  replaceBox.addEventListener("change", () => {
    replaceOriginal = replaceBox.checked;
  });
  replaceLabel.append(replaceBox, doc.createTextNode(t("replaceOriginal")));

  const cancelButton = button(t("cancel"), "close", () => close());
  const canCopy = typeof ClipboardItem !== "undefined" && !!doc.defaultView?.navigator.clipboard?.write;
  const copyButton = button(t("copy"), "copy", () => void copy());
  const downloadButton = button(t("download"), "download", () => void download());
  const sendButton = button(t("send"), null, () => void send(), t("send"));
  sendButton.classList.add("pim-primary");
  sendButton.dataset.testid = "image-markup-send";

  toolbar.append(toolGroup, el("div", "pim-sep"), colorGroup, el("div", "pim-sep"), sizeGroup);
  toolbar.append(el("div", "pim-sep"), undoButton, redoButton, el("div", "pim-spacer"));
  if (options.send && options.canReplace) toolbar.append(replaceLabel);
  toolbar.append(cancelButton);
  if (canCopy) toolbar.append(copyButton);
  toolbar.append(downloadButton);
  if (options.send) toolbar.append(sendButton);

  const stage = el("div", "pim-stage");
  const canvas = el("canvas", "pim-canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.dataset.testid = "image-markup-canvas";
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable");
  stage.append(canvas);

  const status = el("div", "pim-status");
  status.setAttribute("aria-live", "polite");
  if (!options.send) setStatus(t("errors.noComposer"), "info");

  root.append(toolbar, stage, status);
  doc.body.append(root);

  // ── Drawing ─────────────────────────────────────────────────────────────────────────────────
  function draw(): void {
    const shapes = history.scene.shapes;
    const pending = draft?.kind === "shape" ? [...shapes, draft.shape] : shapes;
    renderScene(ctx!, image, size, pending);
    const crop = draft?.kind === "crop" ? clampRect(rectFromPoints(draft.from, draft.to), size) : history.scene.crop;
    if (crop) {
      ctx!.save();
      ctx!.fillStyle = "rgba(0,0,0,0.55)";
      ctx!.beginPath();
      ctx!.rect(0, 0, size.width, size.height);
      ctx!.rect(crop.x, crop.y, crop.width, crop.height);
      ctx!.fill("evenodd");
      ctx!.strokeStyle = "#ffffff";
      ctx!.lineWidth = Math.max(1, 1.5 / scale);
      ctx!.setLineDash([6 / scale, 4 / scale]);
      ctx!.strokeRect(crop.x, crop.y, crop.width, crop.height);
      ctx!.restore();
    }
  }

  function layout(): void {
    const box = stage.getBoundingClientRect();
    const available = { width: Math.max(1, box.width - 32), height: Math.max(1, box.height - 32) };
    scale = fitScale(size, available);
    canvas.style.width = `${Math.round(size.width * scale)}px`;
    canvas.style.height = `${Math.round(size.height * scale)}px`;
    if (textEdit) placeTextInput(textEdit);
    draw();
  }

  function sync(): void {
    for (const [value, node] of toolButtons) node.setAttribute("aria-pressed", String(value === tool));
    for (const [value, node] of colorButtons) node.setAttribute("aria-pressed", String(value === color));
    for (const [value, node] of sizeButtons) node.setAttribute("aria-pressed", String(value === step));
    canvas.dataset.tool = tool;
    undoButton.disabled = !history.canUndo || busy;
    redoButton.disabled = !history.canRedo || busy;
    for (const node of [sendButton, copyButton, downloadButton]) node.disabled = busy;
    if (textEdit) {
      textEdit.size = fontSize(size, step);
      placeTextInput(textEdit);
    }
    draw();
  }

  function setTool(next: Tool): void {
    commitText();
    tool = next;
    sync();
  }

  function setStatus(message: string, kind: "error" | "info" = "error"): void {
    status.textContent = message;
    status.dataset.kind = kind;
  }

  // ── Pointer input ───────────────────────────────────────────────────────────────────────────
  function toImage(event: PointerEvent | MouseEvent): Point {
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * size.width;
    const y = ((event.clientY - rect.top) / Math.max(rect.height, 1)) * size.height;
    return clampPoint({ x, y }, size);
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || busy) return;
    event.preventDefault();
    const point = toImage(event);
    if (tool === "text") {
      // A click outside the box being typed in finishes it, like most editors.
      if (textEdit) {
        commitText();
        return;
      }
      startText(point);
      return;
    }
    commitText();
    canvas.setPointerCapture?.(event.pointerId);
    const width = strokeWidth(size, step);
    if (tool === "pen") draft = { kind: "shape", shape: { kind: "pen", color, width, points: [point] } };
    else if (tool === "arrow") draft = { kind: "shape", shape: { kind: "arrow", color, width, from: point, to: point } };
    else if (tool === "rect") draft = { kind: "shape", shape: { kind: "rect", color, width, from: point, to: point } };
    else if (tool === "blur") draft = { kind: "shape", shape: { kind: "blur", from: point, to: point } };
    else draft = { kind: "crop", from: point, to: point };
    draw();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!draft) return;
    const point = toImage(event);
    if (draft.kind === "crop") draft = { ...draft, to: point };
    else if (draft.shape.kind === "pen") draft = { kind: "shape", shape: { ...draft.shape, points: [...draft.shape.points, point] } };
    else if (draft.shape.kind !== "text") draft = { kind: "shape", shape: { ...draft.shape, to: point } };
    draw();
  });

  const finishDrag = () => {
    if (!draft) return;
    const done = draft;
    draft = null;
    const scene = history.scene;
    if (done.kind === "crop") {
      const crop = isMeaningfulDrag(done.from, done.to, 8 / scale) ? clampRect(rectFromPoints(done.from, done.to), size) : null;
      // A click with the crop tool clears the crop.
      if (crop || scene.crop) history.push({ ...scene, crop });
    } else {
      const shape = done.shape;
      const keep = shape.kind === "pen" || (shape.kind !== "text" && isMeaningfulDrag(shape.from, shape.to, 3 / scale));
      if (keep) history.push({ ...scene, shapes: [...scene.shapes, shape] });
    }
    sync();
  };
  canvas.addEventListener("pointerup", finishDrag);
  canvas.addEventListener("pointercancel", finishDrag);

  // ── Text ────────────────────────────────────────────────────────────────────────────────────
  function startText(at: Point): void {
    const input = el("textarea", "pim-text");
    input.rows = 1;
    input.spellcheck = false;
    input.placeholder = t("textPlaceholder");
    input.dataset.testid = "image-markup-text";
    textEdit = { at, color, size: fontSize(size, step), input };
    input.addEventListener("input", () => textEdit && placeTextInput(textEdit));
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        cancelText();
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        commitText();
      }
    });
    input.addEventListener("blur", () => commitText());
    stage.append(input);
    placeTextInput(textEdit);
    // The pointerdown that started this is cancelled, so focus stays here; the second try covers
    // engines that move focus anyway once the press ends.
    input.focus();
    setTimeout(() => {
      if (textEdit?.input === input && doc.activeElement !== input) input.focus();
    }, 0);
  }

  function placeTextInput(edit: TextEdit): void {
    const canvasBox = canvas.getBoundingClientRect();
    const stageBox = stage.getBoundingClientRect();
    const px = edit.size * scale;
    const { input } = edit;
    input.style.left = `${canvasBox.left - stageBox.left + edit.at.x * scale}px`;
    input.style.top = `${canvasBox.top - stageBox.top + edit.at.y * scale}px`;
    input.style.font = textFont(px);
    input.style.lineHeight = String(TEXT_LINE_HEIGHT);
    input.style.color = edit.color;
    const lines = input.value.split("\n");
    input.style.height = `${Math.ceil(lines.length * px * TEXT_LINE_HEIGHT) + 4}px`;
    const longest = Math.max(4, ...lines.map((line) => line.length));
    input.style.width = `${Math.ceil(longest * px * 0.62) + 12}px`;
  }

  function commitText(): void {
    const edit = textEdit;
    if (!edit) return;
    textEdit = null;
    edit.input.remove();
    const text = edit.input.value.replace(/\s+$/, "");
    if (text) {
      const scene = history.scene;
      history.push({ ...scene, shapes: [...scene.shapes, { kind: "text", color: edit.color, size: edit.size, at: edit.at, text }] });
    }
    sync();
  }

  function cancelText(): void {
    const edit = textEdit;
    if (!edit) return;
    textEdit = null;
    edit.input.remove();
    sync();
  }

  // ── Actions ─────────────────────────────────────────────────────────────────────────────────
  function undo(): void {
    commitText();
    history.undo();
    sync();
  }

  function redo(): void {
    commitText();
    history.redo();
    sync();
  }

  async function render(): Promise<Blob> {
    commitText();
    return exportPng(image, size, history.scene);
  }

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    setStatus("", "info");
    sync();
    try {
      await action();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
      if (!closed) sync();
    }
  }

  const send = () =>
    run(async () => {
      if (!options.send) return;
      const png = await render();
      await options.send(png, replaceOriginal && options.canReplace);
      close();
    });

  const copy = () =>
    run(async () => {
      const png = await render();
      await doc.defaultView!.navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      setStatus(t("copied"), "info");
    });

  const download = () =>
    run(async () => {
      const png = await render();
      const url = URL.createObjectURL(png);
      const link = el("a");
      link.href = url;
      link.download = `${options.name}.png`;
      doc.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    });

  // ── Keyboard ────────────────────────────────────────────────────────────────────────────────
  const onKeyDown = (event: KeyboardEvent) => {
    if (textEdit && event.target === textEdit.input) return;
    const mod = event.metaKey || event.ctrlKey;
    let handled = true;
    if (event.key === "Escape") close();
    else if (mod && event.key === "Enter") void send();
    else if (mod && event.key.toLowerCase() === "z") (event.shiftKey ? redo : undo)();
    else if (mod && event.key.toLowerCase() === "y") redo();
    else if (!mod && !event.altKey) {
      const entry = TOOLS.find((item) => item.key === event.key.toLowerCase());
      if (entry) setTool(entry.tool);
      else handled = false;
    } else handled = false;
    // While the editor is open, the app behind it gets no keys.
    event.stopPropagation();
    if (handled) event.preventDefault();
  };
  doc.addEventListener("keydown", onKeyDown, true);

  const view = doc.defaultView;
  const resizeObserver = view && "ResizeObserver" in view ? new view.ResizeObserver(() => layout()) : null;
  resizeObserver?.observe(stage);
  view?.addEventListener("resize", layout);

  function close(): void {
    if (closed) return;
    closed = true;
    doc.removeEventListener("keydown", onKeyDown, true);
    resizeObserver?.disconnect();
    view?.removeEventListener("resize", layout);
    root.remove();
    options.onClose?.();
  }

  sync();
  layout();
  root.tabIndex = -1;
  root.focus();

  return { root, close };
}

