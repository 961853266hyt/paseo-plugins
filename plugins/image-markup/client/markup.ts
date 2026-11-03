import {
  closeLightbox,
  findComposerNear,
  findLightboxImageUrl,
  loadImage,
  pasteImageInto,
  removeComposerImage,
  SELECTORS,
  watchLightboxes,
} from "./dom";
import { openEditor, type EditorHandle, type Translate } from "./editor";
import { icon } from "./icons";
import { ensureStyles, showToast } from "./styles";

interface Source {
  url: string;
  /** The message box the result goes to; null when none is in reach. */
  composer: HTMLTextAreaElement | null;
  /** The composer image this one came from, which the result can replace. */
  pill: Element | null;
}

/** Adds the Annotate button to the app's image viewer. Returns a function that removes it. */
export function installImageMarkup(doc: Document, t: Translate): () => void {
  const removeStyles = ensureStyles(doc);
  let editor: EditorHandle | null = null;
  let lastFocused: HTMLTextAreaElement | null = null;
  const onFocusIn = (event: Event) => {
    if (event.target instanceof Element && event.target.matches(SELECTORS.composerInput)) {
      lastFocused = event.target as HTMLTextAreaElement;
    }
  };
  doc.addEventListener("focusin", onFocusIn, true);

  async function open(source: Source): Promise<void> {
    editor?.close();
    let loaded: Awaited<ReturnType<typeof loadImage>>;
    try {
      loaded = await loadImage(doc, source.url);
    } catch (error) {
      showToast(doc, t("errors.loadFailed", { error: error instanceof Error ? error.message : String(error) }));
      return;
    }
    const name = `annotated-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
    editor = openEditor({
      doc,
      image: loaded.image,
      size: { width: loaded.width, height: loaded.height },
      name,
      t,
      canReplace: source.pill !== null,
      send: source.composer
        ? async (png, replaceOriginal) => {
            const composer = source.composer?.isConnected
              ? source.composer
              : findComposerNear(doc, null, lastFocused);
            if (!composer) throw new Error(t("errors.noComposer"));
            const file = new File([png], `${name}.png`, { type: "image/png" });
            if (!pasteImageInto(composer, file)) throw new Error(t("errors.pasteRejected"));
            // Add first, then remove, so a refused paste never loses the original.
            if (replaceOriginal && source.pill?.isConnected) removeComposerImage(source.pill);
            composer.focus();
          }
        : null,
      onClose: () => {
        editor = null;
      },
    });
  }

  const stopWatching = watchLightboxes({
    doc,
    label: () => t("annotate"),
    buttonHtml: icon("annotate", 15),
    onAnnotate: ({ lightbox, origin, composer }) => {
      const url = findLightboxImageUrl(lightbox);
      if (!url) {
        showToast(doc, t("errors.noImage"));
        return;
      }
      const pill = origin?.closest(SELECTORS.composerImagePill) ?? null;
      closeLightbox(lightbox);
      void open({ url, composer, pill });
    },
  });

  return () => {
    editor?.close();
    stopWatching();
    doc.removeEventListener("focusin", onFocusIn, true);
    removeStyles();
  };
}
