import { useEffect, useRef } from "react";
import { Platform, View } from "react-native";
import type { ArtboardView } from "../shared/rpc";
import { buildSrcdoc } from "./runtime";

/**
 * A design's first artboard drawn small, as the page itself in a sandboxed frame. Fixed-height
 * artboards are fitted whole; full-length pages show their top. Web only: native draws the box.
 */
export function Thumbnail({ cover, width, height, background }: { cover: ArtboardView | null; width: number; height: number; background: string }) {
  const hostRef = useRef<View>(null);
  const html = cover?.html ?? null;
  const pageWidth = cover?.width ?? 0;
  const pageHeight = cover?.height ?? null;

  useEffect(() => {
    if (Platform.OS !== "web" || !html || width <= 0 || height <= 0) return;
    const host = hostRef.current as unknown as HTMLElement | null;
    if (!host) return;
    const frameHeight = pageHeight ?? Math.round((pageWidth * height) / width);
    const scale = Math.min(width / pageWidth, height / frameHeight);
    const frame = host.ownerDocument.createElement("iframe");
    // No allow-same-origin: the design runs in an opaque origin and cannot reach Paseo.
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("tabindex", "-1");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("loading", "lazy");
    Object.assign(frame.style, {
      position: "absolute",
      left: `${(width - pageWidth * scale) / 2}px`,
      top: `${(height - frameHeight * scale) / 2}px`,
      width: `${pageWidth}px`,
      height: `${frameHeight}px`,
      border: "0",
      transform: `scale(${scale})`,
      transformOrigin: "0 0",
      pointerEvents: "none",
      background: "white",
    });
    frame.srcdoc = buildSrcdoc(html);
    host.append(frame);
    return () => frame.remove();
  }, [html, pageWidth, pageHeight, width, height]);

  return <View ref={hostRef} style={{ width, height, overflow: "hidden", backgroundColor: background }} />;
}
