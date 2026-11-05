// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Comment } from "../shared/design";
import type { DesignView } from "../shared/rpc";
import { type CanvasApi, type CanvasHandle, mountCanvas } from "../client/canvas";

const theme = {
  surface0: "#fff",
  surface1: "#fafafa",
  surface2: "#eee",
  border: "#ddd",
  foreground: "#111",
  foregroundMuted: "#666",
  accent: "#20744a",
  accentForeground: "#fff",
  statusSuccess: "#0a0",
  statusWarning: "#aa0",
  statusDanger: "#a00",
};

const t = (key: string, values?: Record<string, string>) => (values ? `${key}:${JSON.stringify(values)}` : key);

const comment: Comment = {
  id: "c-aaaa1111",
  number: 1,
  body: "Bigger",
  anchor: { artboardId: "desktop", dcId: "cta", path: "body > button:nth-of-type(1)", tag: "button", text: "Buy", html: "<button>", rect: { x: 0, y: 0, width: 10, height: 10 } },
  status: "pending",
  createdAt: 1,
};

function design(comments: Comment[]): DesignView {
  return {
    slug: "pricing",
    manifest: {
      version: 1,
      title: "Pricing",
      kind: "prototype",
      artboards: [{ id: "desktop", title: "Desktop", file: "desktop.html", width: 1200 }],
    },
    error: null,
    artboards: [{ id: "desktop", title: "Desktop", file: "desktop.html", width: 1200, html: "<!doctype html><p>Hi</p>", error: null, version: "v1", source: "s1" }],
    comments,
    tweakValues: {},
    version: "d1",
  };
}

function fakeApi(view: DesignView | null): CanvasApi & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    listDesigns: async () =>
      view
        ? { initialized: true, designs: [{ slug: "pricing", title: "Pricing", kind: "prototype", artboards: 1, openComments: 1, error: null }], version: "l1" }
        : { initialized: false, designs: [], version: "l0" },
    getDesign: async () => view!,
    getDesignVersion: async () => view!.version,
    addComment: vi.fn(),
    updateComment: vi.fn(),
    deleteComment: vi.fn(),
    markSent: vi.fn(async () => {}),
    moveElement: vi.fn(async () => ({ source: "s2", version: "v2" })),
    moveArtboard: vi.fn(async () => {}),
    editText: vi.fn(async () => ({ source: "s3", version: "v3" })),
    saveTweaks: vi.fn(async (_slug: string, values: Record<string, unknown>) => ({ values: values as never, versions: { desktop: "v4" } })),
    sendToAgent: vi.fn(async (text: string) => {
      sent.push(text);
    }),
    startDesign: vi.fn(async () => {}),
    renameDesign: vi.fn(async () => {}),
    deleteDesign: vi.fn(async (slug: string) => `design/.trash/${slug}-2026-11-05T00-00-00Z`),
  };
}

let handle: CanvasHandle | null = null;
afterEach(() => {
  handle?.destroy();
  handle = null;
  document.body.innerHTML = "";
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function mount(api: CanvasApi, pollMs = 60_000) {
  const host = document.createElement("div");
  document.body.append(host);
  handle = mountCanvas({ host, t, api, theme, initialSlug: null, onSlugChange: () => {}, pollMs });
  return host;
}

describe("canvas", () => {
  test("with no designs it asks for a brief and hands it to the agent", async () => {
    const api = fakeApi(null);
    const host = mount(api);
    await settle();
    const card = host.querySelector('[data-testid="design-canvas-new"]');
    expect(card?.textContent).toContain("emptyTitle");
    const area = card!.querySelector("textarea")!;
    area.value = "A pricing page";
    (card!.querySelector(".dc-primary") as HTMLButtonElement).click();
    await settle();
    expect(api.startDesign).toHaveBeenCalledWith("A pricing page");
  });

  test("polling the empty list keeps a half-typed brief", async () => {
    const api = fakeApi(null);
    const listDesigns = vi.spyOn(api, "listDesigns");
    const host = mount(api, 5);
    await settle();
    const area = host.querySelector('[data-testid="design-canvas-new"] textarea') as HTMLTextAreaElement;
    area.value = "A pricing page with";
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(listDesigns.mock.calls.length).toBeGreaterThan(1);
    expect(host.querySelectorAll('[data-testid="design-canvas-new"]')).toHaveLength(1);
    expect((host.querySelector('[data-testid="design-canvas-new"] textarea') as HTMLTextAreaElement).value).toBe("A pricing page with");
  });

  test("shows each artboard in a sandboxed frame with the runtime and CSP", async () => {
    const host = mount(fakeApi(design([])));
    await settle();
    const frame = host.querySelector("iframe.dc-board-frame") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-modals");
    expect(frame.srcdoc).toContain("Content-Security-Policy");
    expect(frame.srcdoc).toContain("design-canvas/1");
    expect(frame.srcdoc).toContain("<p>Hi</p>");
  });

  test("sends pending comments in one message, marks them sent, and is off while the agent works", async () => {
    const api = fakeApi(design([comment]));
    const host = mount(api);
    await settle();
    const send = host.querySelector('[data-testid="design-canvas-send"]') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    handle!.setAgentStatus("running");
    expect(send.disabled).toBe(true);
    handle!.setAgentStatus("idle");
    send.click();
    await settle();
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]).toContain('#1 on Desktop (desktop.html)');
    expect(api.markSent).toHaveBeenCalledWith("pricing", ["c-aaaa1111"]);
    expect(send.disabled).toBe(true);
    expect(host.querySelector(".dc-num.sent")).not.toBeNull();
  });
});

describe("tools", () => {
  test("icon buttons carry their own tooltip with the shortcut, not a native title", async () => {
    const host = mount(fakeApi(design([])));
    await settle();
    const preview = host.querySelector('[data-tool="preview"]') as HTMLElement;
    expect(preview.dataset.tip).toBe("toolPreview");
    expect(preview.dataset.key).toBe("P");
    expect(preview.getAttribute("aria-label")).toBe("toolPreview (P)");
    expect(host.querySelectorAll(".dc-icon[title]")).toHaveLength(0);
  });

  test("V, H, C and P switch tools; Hand makes the artboards let the pointer through", async () => {
    const host = mount(fakeApi(design([])));
    await settle();
    const root = host.querySelector('[data-testid="design-canvas"]') as HTMLElement;
    const on = () => (host.querySelector(".dc-btn.dc-on[data-tool]") as HTMLElement | null)?.dataset.tool;
    expect(on()).toBe("move");
    for (const [key, tool] of [["h", "hand"], ["c", "comment"], ["p", "preview"], ["v", "move"]] as const) {
      root.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      expect(on()).toBe(tool);
      expect(host.querySelector(".dc-world")!.classList.contains("dc-panning")).toBe(tool === "hand");
    }
  });

  test("a move from a design is written once the nudges stop, and undo writes it back", async () => {
    const api = fakeApi(design([]));
    const host = mount(api);
    await settle();
    const frame = host.querySelector("iframe.dc-board-frame") as HTMLIFrameElement;
    const source = frame.contentWindow;
    if (!source) return; // happy-dom without iframe windows: covered by the browser check
    const moved = (after: string) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source,
          data: { mark: "design-canvas/1", type: "moved", dcId: "cta", before: { translate: "" }, after: { translate: after } },
        }),
      );
    moved("1px 0px");
    moved("2px 0px");
    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(api.moveElement).toHaveBeenCalledTimes(1);
    expect(api.moveElement).toHaveBeenCalledWith("pricing", "desktop", "cta", { translate: "2px 0px" }, "s1");
    const root = host.querySelector('[data-testid="design-canvas"]') as HTMLElement;
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    await settle();
    expect(api.moveElement).toHaveBeenLastCalledWith("pricing", "desktop", "cta", { translate: "" }, "s2");
  });
});

describe("text", () => {
  test("text edited in a page is written, and undo puts it back", async () => {
    const api = fakeApi(design([]));
    const host = mount(api);
    await settle();
    const frame = host.querySelector("iframe.dc-board-frame") as HTMLIFrameElement;
    const source = frame.contentWindow;
    if (!source) return; // happy-dom without iframe windows: covered by the browser check
    const target = { dcId: "title", path: [], index: 0 };
    window.dispatchEvent(new MessageEvent("message", { source, data: { mark: "design-canvas/1", type: "text-edited", target, before: "Hi", after: "Hello" } }));
    await settle();
    expect(api.editText).toHaveBeenCalledWith("pricing", "desktop", target, "Hi", "Hello", "s1");
    const root = host.querySelector('[data-testid="design-canvas"]') as HTMLElement;
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    await settle();
    expect(api.editText).toHaveBeenLastCalledWith("pricing", "desktop", target, "Hello", "Hi", "s3");
  });
});

describe("tweaks panel", () => {
  function tweaked(): DesignView {
    const view = design([]);
    view.manifest!.tweaks = [
      { id: "gap", label: "Gap", type: "range", var: "--gap", min: 8, max: 48, step: 4, unit: "px", default: 24 },
      { id: "badge", label: "Badge", type: "toggle", var: "--badge", on: "inline-flex", off: "none", default: true },
    ];
    view.artboards[0]!.html = "<!doctype html><style>p { gap: var(--gap) }</style><p>Hi</p>";
    return view;
  }

  test("shows a control per tweak, warns about unused variables, and saves once the value settles", async () => {
    const api = fakeApi(tweaked());
    const host = mount(api);
    await settle();
    const pane = host.querySelector('[data-testid="design-canvas-tweaks"]') as HTMLElement;
    expect(pane.querySelectorAll(".dc-tweak")).toHaveLength(2);
    expect(pane.querySelector('[data-tweak="gap"] .dc-tweak-warn')).toBeNull();
    expect(pane.querySelector('[data-tweak="badge"] .dc-tweak-warn')?.textContent).toContain("--badge");
    const range = pane.querySelector('[data-tweak="gap"] input[type="range"]') as HTMLInputElement;
    range.value = "31";
    range.dispatchEvent(new Event("input"));
    range.value = "32";
    range.dispatchEvent(new Event("input"));
    expect(pane.querySelector('[data-tweak="gap"] .dc-tweak-value')?.textContent).toBe("32px");
    expect(api.saveTweaks).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(api.saveTweaks).toHaveBeenCalledTimes(1);
    expect(api.saveTweaks).toHaveBeenCalledWith("pricing", { gap: 32 });
    (pane.querySelector(".dc-tweak-actions .dc-btn:last-child") as HTMLButtonElement).click();
    await settle();
    expect(api.sent[0]).toContain("--gap = 32px (now 24px)");
  });

  test("with no tweaks it offers to ask the agent", async () => {
    const api = fakeApi(design([]));
    const host = mount(api);
    await settle();
    const pane = host.querySelector('[data-testid="design-canvas-tweaks"]') as HTMLElement;
    expect(pane.textContent).toContain("tweaksEmpty");
    (pane.querySelector(".dc-primary") as HTMLButtonElement).click();
    await settle();
    expect(api.sent[0]).toContain("design_set_tweaks");
  });
});

describe("design menu", () => {
  async function openMenu() {
    const api = fakeApi(design([comment]));
    const host = mount(api);
    await settle();
    const picker = host.querySelector('[data-testid="design-canvas-picker"]') as HTMLButtonElement;
    expect(picker.textContent).toContain("Pricing");
    picker.click();
    const menu = host.querySelector('[data-testid="design-canvas-menu"]') as HTMLElement;
    return { api, host, menu };
  }

  test("lists each design by its name only, with new design last", async () => {
    const { menu } = await openMenu();
    expect([...menu.querySelectorAll(".dc-menu-title")].map((n) => n.textContent)).toEqual(["Pricing", "newDesign"]);
    expect(menu.querySelector(".dc-menu-new .dc-menu-icon svg")).not.toBeNull();
  });

  test("renames in the row: Enter keeps the name, Escape puts it back", async () => {
    const { api, menu } = await openMenu();
    (menu.querySelector(".dc-act") as HTMLButtonElement).click();
    let field = menu.querySelector(".dc-menu-field") as HTMLInputElement;
    field.value = "Nope";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(api.renameDesign).not.toHaveBeenCalled();
    expect(menu.querySelector(".dc-menu-field")).toBeNull();
    (menu.querySelector(".dc-act") as HTMLButtonElement).click();
    field = menu.querySelector(".dc-menu-field") as HTMLInputElement;
    field.value = "  Pricing v2 ";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(api.renameDesign).toHaveBeenCalledWith("pricing", "Pricing v2");
  });

  test("deletes after the row asks", async () => {
    const { api, menu } = await openMenu();
    (menu.querySelector(".dc-act-danger") as HTMLButtonElement).click();
    const asking = menu.querySelector(".dc-asking") as HTMLElement;
    expect(asking.textContent).toContain("deleteDesignTitle");
    expect(api.deleteDesign).not.toHaveBeenCalled();
    (asking.querySelector(".dc-mini-danger") as HTMLButtonElement).click();
    await settle();
    expect(api.deleteDesign).toHaveBeenCalledWith("pricing");
  });
});

describe("tweak reach", () => {
  test("shows what the pages counted, and lights up the tweaks driving the hovered element", async () => {
    const view = design([]);
    view.manifest!.tweaks = [{ id: "gap", label: "Gap", type: "range", var: "--gap", min: 8, max: 48, unit: "px", default: 24 }];
    view.artboards[0]!.html = "<!doctype html><style>p { gap: var(--gap) }</style><p>Hi</p>";
    const host = mount(fakeApi(view));
    await settle();
    (host.querySelector(".dc-toolbar .dc-btn:nth-last-child(2)") as HTMLButtonElement).click();
    const frame = host.querySelector("iframe.dc-board-frame") as HTMLIFrameElement;
    const source = frame.contentWindow;
    if (!source) return; // happy-dom without iframe windows: covered by the browser check
    const say = (data: object) => window.dispatchEvent(new MessageEvent("message", { source, data: { mark: "design-canvas/1", ...data } }));
    say({ type: "tweak-uses", counts: { "--gap": 4 } });
    const row = host.querySelector('[data-tweak="gap"]') as HTMLElement;
    expect(row.querySelector(".dc-tweak-uses")?.textContent).toBe('elements_other:{"count":"4"} · artboards_one:{"count":"1"}');
    say({ type: "tweak-hover", names: ["--gap"] });
    expect(row.classList.contains("dc-linked")).toBe(true);
    say({ type: "tweak-uses", counts: { "--gap": 0 } });
    expect(row.querySelector(".dc-tweak-warn")?.textContent).toContain("--gap");
  });
});

