/** Stacking order. Anything not in this list should stay at z=0. */
export const zIndex = {
  base: 0,
  sticky: 5,
  sidebar: 10,
  overlay: 30,
  modal: 40,
  toast: 50,
  tooltip: 60,
  commandPalette: 70,
} as const;
