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
    artboards: [{ id: "desktop", title: "Desktop", file: "desktop.html", width: 1200, html: "<!doctype html><p>Hi</p>", error: null, version: "v1" }],
    comments,
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
    sendToAgent: vi.fn(async (text: string) => {
      sent.push(text);
    }),
    startDesign: vi.fn(async () => {}),
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

function mount(api: CanvasApi) {
  const host = document.createElement("div");
  document.body.append(host);
  handle = mountCanvas({ host, t, api, theme, initialSlug: null, onSlugChange: () => {}, pollMs: 60_000 });
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
