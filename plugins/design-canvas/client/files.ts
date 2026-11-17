/** Whether this client can open a file picker: the web and desktop apps, not the phone apps. */
export const canPickFiles = typeof document !== "undefined" && typeof document.createElement === "function";

/** Asks the user for a zip. Resolves null when they cancel (where the browser says so). */
export function pickZip(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,application/zip";
    input.style.display = "none";
    const done = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => done(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => done(null));
    document.body.append(input);
    input.click();
  });
}

export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

export interface FileDropHandlers {
  /** Files are being dragged over the element. */
  enter(): void;
  leave(): void;
  /** The first .zip dropped, or null when none of the files is one. */
  drop(file: File | null): void;
}

/** Lets files be dropped on an element. Web only; returns the cleanup. */
export function watchFileDrops(host: HTMLElement, handlers: FileDropHandlers): () => void {
  let depth = 0;
  const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
  const onEnter = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (depth++ === 0) handlers.enter();
  };
  const onOver = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  };
  const onLeave = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    if (--depth <= 0) {
      depth = 0;
      handlers.leave();
    }
  };
  const onDrop = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth = 0;
    handlers.leave();
    const files = Array.from(event.dataTransfer?.files ?? []);
    handlers.drop(files.find((file) => /\.zip$/i.test(file.name) || file.type === "application/zip") ?? null);
  };
  host.addEventListener("dragenter", onEnter);
  host.addEventListener("dragover", onOver);
  host.addEventListener("dragleave", onLeave);
  host.addEventListener("drop", onDrop);
  return () => {
    host.removeEventListener("dragenter", onEnter);
    host.removeEventListener("dragover", onOver);
    host.removeEventListener("dragleave", onLeave);
    host.removeEventListener("drop", onDrop);
  };
}
