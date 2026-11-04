/**
 * The Comment tool's cursor: the same shape as a comment pin (round on three corners, pointed at
 * the bottom left) with a plus, white with a dark outline so it shows on light and dark designs.
 * The hotspot is the pointed corner, where the comment lands.
 */
const COMMENT_CURSOR_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>" +
  "<path d='M3 20.5V12a9 9 0 0 1 9-9a9 9 0 0 1 9 9a9 9 0 0 1-9 9H3.5a.5.5 0 0 1-.5-.5z' fill='#fff' stroke='#1b1a17' stroke-width='1.5' stroke-linejoin='round'/>" +
  "<path d='M12 8.5v7M8.5 12h7' stroke='#1b1a17' stroke-width='1.8' stroke-linecap='round'/>" +
  "</svg>";

/** A CSS `cursor` value, falling back to the crosshair where custom cursors are not drawn. */
export const COMMENT_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(COMMENT_CURSOR_SVG)}") 3 21, crosshair`;
