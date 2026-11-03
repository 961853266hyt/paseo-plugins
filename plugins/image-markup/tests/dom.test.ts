// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  findComposerNear,
  findLightboxImageUrl,
  pasteImageInto,
  removeComposerImage,
  SELECTORS,
  watchLightboxes,
} from "../client/dom";

/** Two chat panes side by side, each with messages and its own message box. */
function twoPanes(): { left: HTMLElement; right: HTMLElement } {
  document.body.innerHTML = `
    <div id="workspace">
      <div id="left">
        <div class="messages"><div id="left-image" role="button">image</div></div>
        <div class="composer">
          <div><div data-testid="composer-image-attachment-pill" role="button"><img src="blob:one"></div><div role="button" id="remove-one">x</div></div>
          <div><div data-testid="composer-image-attachment-pill" role="button"><img src="blob:two"></div><div role="button" id="remove-two">x</div></div>
          <textarea data-composer-input id="left-input"></textarea>
        </div>
      </div>
      <div id="right">
        <div class="messages"><div id="right-image" role="button">image</div></div>
        <div class="composer"><textarea data-composer-input id="right-input"></textarea></div>
      </div>
    </div>`;
  return { left: document.getElementById("left")!, right: document.getElementById("right")! };
}

beforeEach(() => {
  // happy-dom does no layout; treat every connected element as visible unless marked hidden.
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
    const hidden = this.closest("[data-hidden]");
    return (hidden ? [] : [{}]) as unknown as DOMRectList;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("findLightboxImageUrl", () => {
  test("reads the image element React Native Web renders", () => {
    document.body.innerHTML = `<div data-testid="attachment-lightbox"><div data-testid="attachment-lightbox-image"><div style="background-image: url(&quot;blob:bg&quot;)"></div><img src="blob:img"></div></div>`;
    expect(findLightboxImageUrl(document.querySelector('[data-testid="attachment-lightbox"]')!)).toBe("blob:img");
  });

  test("falls back to the background image", () => {
    document.body.innerHTML = `<div data-testid="attachment-lightbox"><div data-testid="attachment-lightbox-image"><div style='background-image: url("data:image/png;base64,AAA")'></div></div></div>`;
    expect(findLightboxImageUrl(document.querySelector('[data-testid="attachment-lightbox"]')!)).toBe(
      "data:image/png;base64,AAA",
    );
  });
});

describe("findComposerNear", () => {
  test("picks the message box of the pane the image was opened in", () => {
    twoPanes();
    expect(findComposerNear(document, document.getElementById("right-image"), null)?.id).toBe("right-input");
    expect(findComposerNear(document, document.getElementById("left-image"), null)?.id).toBe("left-input");
  });

  test("skips hidden tabs and falls back to the last focused box", () => {
    twoPanes();
    document.getElementById("left")!.setAttribute("data-hidden", "");
    const right = document.getElementById("right-input") as HTMLTextAreaElement;
    expect(findComposerNear(document, document.getElementById("left-image"), null)?.id).toBe("right-input");
    expect(findComposerNear(document, null, right)?.id).toBe("right-input");
  });
});

describe("pasteImageInto", () => {
  test("hands the file to the composer's paste handler and reports that it took it", () => {
    twoPanes();
    const textarea = document.getElementById("left-input") as HTMLTextAreaElement;
    const received: File[] = [];
    textarea.addEventListener("paste", (event) => {
      const items = Array.from((event as ClipboardEvent).clipboardData?.items ?? []);
      for (const item of items) {
        const file = item.getAsFile();
        if (file) received.push(file);
      }
      event.preventDefault();
    });
    const file = new File([new Uint8Array([1, 2, 3])], "annotated.png", { type: "image/png" });
    expect(pasteImageInto(textarea, file)).toBe(true);
    expect(received.map((entry) => [entry.name, entry.type])).toEqual([["annotated.png", "image/png"]]);
  });

  test("reports a paste nobody took", () => {
    twoPanes();
    const textarea = document.getElementById("right-input") as HTMLTextAreaElement;
    expect(pasteImageInto(textarea, new File(["x"], "a.png", { type: "image/png" }))).toBe(false);
  });
});

describe("removeComposerImage", () => {
  test("presses the remove button beside the pill", () => {
    twoPanes();
    const pills = Array.from(document.querySelectorAll(SELECTORS.composerImagePill));
    expect(pills.map((pill) => pill.querySelector("img")?.getAttribute("src"))).toEqual(["blob:one", "blob:two"]);
    const clicked = vi.fn();
    document.getElementById("remove-two")!.addEventListener("click", clicked);
    expect(removeComposerImage(pills[1]!)).toBe(true);
    expect(clicked).toHaveBeenCalledOnce();
  });
});

describe("watchLightboxes", () => {
  test("adds one Annotate button per viewer and reports where it was opened from", async () => {
    twoPanes();
    const onAnnotate = vi.fn();
    const stop = watchLightboxes({ doc: document, label: () => "Annotate", buttonHtml: "", onAnnotate });

    const opener = document.getElementById("right-image")!;
    opener.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    const lightbox = document.createElement("div");
    lightbox.dataset.testid = "attachment-lightbox";
    document.body.appendChild(lightbox);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Further DOM changes do not add a second button.
    lightbox.appendChild(document.createElement("span"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const buttons = lightbox.querySelectorAll<HTMLButtonElement>('[data-testid="image-markup-annotate"]');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe("Annotate");
    // Pressing the button itself must not count as the opener.
    buttons[0]!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    buttons[0]!.click();
    expect(onAnnotate).toHaveBeenCalledOnce();
    const input = onAnnotate.mock.calls[0]![0];
    expect(input.origin).toBe(opener);
    expect(input.composer.id).toBe("right-input");

    stop();
    expect(lightbox.querySelector('[data-testid="image-markup-annotate"]')).toBeNull();
  });
});
