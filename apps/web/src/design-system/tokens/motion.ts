/**
 * Motion tokens. Every transition in the shell uses these so a11y's
 * `prefers-reduced-motion: reduce` can swap them to 0ms in one place.
 */
export const motion = {
  duration: {
    instant: '0ms',
    fast: '120ms',
    base: '200ms',
    slow: '300ms',
  },
  easing: {
    // ease-out-expo — smooth deceleration, good for appearing UI
    standard: 'cubic-bezier(0.16, 1, 0.3, 1)',
    // ease-in-out — balanced, for in-place transforms
    smooth: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
} as const;
