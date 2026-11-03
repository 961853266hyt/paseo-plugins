/**
 * Hooks into the Paseo app's web DOM. Plugins have no API to read or add composer attachments
 * (Paseo 0.13), so this relies on the app's test ids and on the composer's own paste handler.
 */
export const SELECTORS = {
  /** The image viewer every chat image opens in: composer, user and assistant images alike. */
  lightbox: '[data-testid="attachment-lightbox"]',
  lightboxImage: '[data-testid="attachment-lightbox-image"]',
  lightboxClose: '[data-testid="attachment-lightbox-close"]',
  composerInput: "textarea[data-composer-input]",
  composerImagePill: '[data-testid="composer-image-attachment-pill"]',
} as const;

export const ANNOTATE_BUTTON_CLASS = "pim-annotate";

/** The URL of the image a lightbox shows. React Native Web draws it as an `<img>` and a background. */
export function findLightboxImageUrl(lightbox: Element): string | null {
  const scope = lightbox.querySelector(SELECTORS.lightboxImage) ?? lightbox;
  for (const img of Array.from(scope.querySelectorAll("img"))) {
    const src = img.getAttribute("src");
    if (src) return src;
  }
  const nodes = [scope, ...Array.from(scope.querySelectorAll("*"))];
  for (const node of nodes) {
    const background = (node as HTMLElement).style?.backgroundImage;
    const url = background && /url\((['"]?)(.+?)\1\)/.exec(background)?.[2];
    if (url) return url;
  }
  return null;
}

function isVisible(element: Element): boolean {
  // Hidden tabs keep their composer mounted under `display: none`, which leaves no client rects.
  return element.isConnected && element.getClientRects().length > 0;
}

/**
 * The message box nearest to `origin`, the element the image was opened from. Walking up from it,
 * the first ancestor that holds a composer is that chat's own pane, even with panes side by side.
 */
export function findComposerNear(
  doc: Document,
  origin: Element | null,
  lastFocused: HTMLTextAreaElement | null,
): HTMLTextAreaElement | null {
  for (let node = origin; node; node = node.parentElement) {
    const found = Array.from(node.querySelectorAll<HTMLTextAreaElement>(SELECTORS.composerInput)).find(isVisible);
    if (found) return found;
  }
  if (lastFocused && lastFocused.isConnected && isVisible(lastFocused)) return lastFocused;
  return Array.from(doc.querySelectorAll<HTMLTextAreaElement>(SELECTORS.composerInput)).find(isVisible) ?? null;
}

/**
 * Hands the file to the composer as if it were pasted, so the app stores and shows it like any
 * pasted screenshot. True when the composer took it: its handler cancels the paste.
 */
export function pasteImageInto(textarea: HTMLTextAreaElement, file: File): boolean {
  const view = textarea.ownerDocument.defaultView!;
  const data = new view.DataTransfer();
  data.items.add(file);
  const event = new view.ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data });
  // Some engines drop `clipboardData` from the constructor.
  if (!event.clipboardData) Object.defineProperty(event, "clipboardData", { value: data });
  return !textarea.dispatchEvent(event);
}

/** Presses the remove button next to a composer image pill. */
export function removeComposerImage(pill: Element): boolean {
  const remove = pill.nextElementSibling;
  if (!(remove instanceof pill.ownerDocument.defaultView!.HTMLElement)) return false;
  if (remove.getAttribute("role") !== "button") return false;
  remove.click();
  return true;
}

export function closeLightbox(lightbox: Element): void {
  const close = lightbox.ownerDocument.querySelector<HTMLElement>(SELECTORS.lightboxClose);
  if (close) {
    close.click();
    return;
  }
  // The app's overlay closes the viewer on Escape too.
  const view = lightbox.ownerDocument.defaultView!;
  lightbox.ownerDocument.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

export interface LightboxWatcherOptions {
  doc: Document;
  label: () => string;
  buttonHtml: string;
  onAnnotate: (input: { lightbox: Element; origin: Element | null; composer: HTMLTextAreaElement | null }) => void;
}

/**
 * Adds an Annotate button to every image viewer the app opens, and remembers what the user last
 * clicked outside one: the image that opened it, and with it the chat it belongs to.
 */
export function watchLightboxes(options: LightboxWatcherOptions): () => void {
  const { doc } = options;
  let origin: Element | null = null;
  let lastFocused: HTMLTextAreaElement | null = null;

  const isOurs = (target: EventTarget | null) =>
    target instanceof Element && (target.closest(SELECTORS.lightbox) || target.closest(".pim-overlay"));

  const onPointerDown = (event: Event) => {
    if (event.target instanceof Element && !isOurs(event.target)) origin = event.target;
  };
  const onFocusIn = (event: Event) => {
    if (event.target instanceof Element && event.target.matches(SELECTORS.composerInput)) {
      lastFocused = event.target as HTMLTextAreaElement;
    }
  };

  const decorate = () => {
    for (const lightbox of Array.from(doc.querySelectorAll(SELECTORS.lightbox))) {
      if (lightbox.querySelector(`.${ANNOTATE_BUTTON_CLASS}`)) continue;
      const button = doc.createElement("button");
      button.type = "button";
      button.className = ANNOTATE_BUTTON_CLASS;
      button.dataset.testid = "image-markup-annotate";
      button.innerHTML = options.buttonHtml;
      const text = options.label();
      button.append(doc.createTextNode(text));
      button.setAttribute("aria-label", text);
      // The viewer pans and zooms on pointer input; keep it from seeing presses on the button.
      for (const type of ["pointerdown", "mousedown", "touchstart", "wheel"]) {
        button.addEventListener(type, (event) => event.stopPropagation());
      }
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        options.onAnnotate({ lightbox, origin, composer: findComposerNear(doc, origin, lastFocused) });
      });
      lightbox.appendChild(button);
    }
  };

  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("focusin", onFocusIn, true);
  const observer = new (doc.defaultView!.MutationObserver)(decorate);
  observer.observe(doc.body, { childList: true, subtree: true });
  decorate();

  return () => {
    observer.disconnect();
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("focusin", onFocusIn, true);
    for (const button of Array.from(doc.querySelectorAll(`.${ANNOTATE_BUTTON_CLASS}`))) button.remove();
  };
}

/**
 * Loads an image so the editor can read its pixels. Fetching it into a blob keeps the canvas
 * untainted for `blob:`, `data:` and same-origin URLs; a cross-origin image needs CORS.
 */
export async function loadImage(doc: Document, url: string): Promise<{ image: CanvasImageSource; width: number; height: number }> {
  const view = doc.defaultView!;
  let source = url;
  let revoke: string | null = null;
  try {
    const response = await view.fetch(url);
    if (response.ok) {
      source = view.URL.createObjectURL(await response.blob());
      revoke = source;
    }
  } catch {
    // Fall back to loading the URL directly with CORS.
  }
  try {
    const image = new view.Image();
    if (!revoke && !/^(data|blob):/.test(url)) image.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("the image did not load"));
      image.src = source;
    });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("the image is empty");
    return { image, width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    // The decoded image stays usable after its blob URL is revoked.
    if (revoke) view.URL.revokeObjectURL(revoke);
  }
}
