export const typography = {
  fontFamily: {
    sans: `'Inter var', ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Noto Sans KR", sans-serif`,
    mono: `ui-monospace, SFMono-Regular, Menlo, monospace`,
  },
  fontSize: {
    xs: '11px',
    sm: '12px',
    base: '14px',
    md: '15px',
    lg: '16px',
    xl: '20px',
    '2xl': '24px',
  },
  fontWeight: { normal: 400, medium: 500, semibold: 600, bold: 700 },
  lineHeight: { tight: 1.2, normal: 1.5, loose: 1.75 },
} as const;
