import { Dimensions, Platform } from "react-native";

/** Below the app's `md` breakpoint (packages/app/src/styles/unistyles.ts) its layout is compact. */
const COMPACT_BELOW_WIDTH = 720;

/**
 * Whether a panel can open in the Explorer sidebar beside the chat. Only the web and desktop app
 * draw plugin panels there, and only in their wide layout: native apps show one pane at a time,
 * even on a tablet. Commands run outside any component, so they get no `layout` prop; the window
 * width is what the app's own breakpoint reads.
 */
export function canOpenBesideChat(): boolean {
  return Platform.OS === "web" && Dimensions.get("window").width >= COMPACT_BELOW_WIDTH;
}
