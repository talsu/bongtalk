/**
 * Tailwind color keys are THIN ALIASES over the semantic CSS vars defined
 * in /design-system/tokens.css. The DS is the source of truth — tokens
 * flip automatically via [data-theme="light|dark"] on <html>.
 *
 * Components should prefer the `qf-*` classes in components.css; Tailwind
 * utilities here exist as escape hatches that STILL route through DS tokens,
 * so primitive names (e.g. `blue-500`, `#8b5cf6`) never appear in app code.
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // ─ Semantic surfaces / text — map to DS aliases ─
        background: 'var(--bg-app)',
        foreground: 'var(--text)',
        'bg-subtle': 'var(--bg-panel)',
        'bg-muted': 'var(--bg-hover)',
        'bg-accent': 'var(--bg-selected)',
        'bg-primary': 'var(--accent)',
        'fg-primary': 'var(--text-onAccent)',
        'bg-surface': 'var(--bg-elevated)',
        'bg-input': 'var(--bg-input)',
        'bg-chat': 'var(--bg-chat)',
        'border-subtle': 'var(--divider)',
        'border-strong': 'var(--border-strong)',
        border: 'var(--border)',
        'text-strong': 'var(--text-strong)',
        'text-secondary': 'var(--text-secondary)',
        'text-muted': 'var(--text-muted)',
        'text-disabled': 'var(--text-disabled)',
        accent: 'var(--accent)',
        'accent-hover': 'var(--accent-hover)',
        'accent-press': 'var(--accent-press)',
        'accent-subtle': 'var(--accent-subtle)',
        link: 'var(--link)',
        'link-hover': 'var(--link-hover)',
        mention: 'var(--mention-bg)',
        'mention-hover': 'var(--mention-bgHov)',
        ring: 'var(--accent)',
        // ─ Status semantics ─
        success: 'var(--ok-400)',
        warning: 'var(--warn-400)',
        danger: 'var(--danger-400)',
        info: 'var(--info-400)',
        'presence-online': 'var(--status-online)',
        'presence-idle': 'var(--status-idle)',
        'presence-offline': 'var(--status-offline)',
        'presence-dnd': 'var(--status-dnd)',
      },
      borderRadius: {
        xs: 'var(--r-xs)',
        sm: 'var(--r-sm)',
        md: 'var(--r-md)',
        lg: 'var(--r-lg)',
        xl: 'var(--r-xl)',
        '2xl': 'var(--r-2xl)',
        pill: 'var(--r-pill)',
      },
      fontFamily: {
        sans: 'var(--font-sans)',
        mono: 'var(--font-mono)',
      },
      transitionDuration: {
        instant: 'var(--dur-instant)',
        fast: 'var(--dur-fast)',
        base: 'var(--dur-base)',
        slow: 'var(--dur-slow)',
        deliberate: 'var(--dur-deliberate)',
      },
      transitionTimingFunction: {
        standard: 'var(--ease-standard)',
        emphasized: 'var(--ease-emphasized)',
        spring: 'var(--ease-spring)',
      },
      boxShadow: {
        'elev-1': 'var(--elev-1)',
        'elev-2': 'var(--elev-2)',
        'elev-3': 'var(--elev-3)',
        'elev-4': 'var(--elev-4)',
        'ring-accent': 'var(--ring-accent)',
        'ring-focus': 'var(--ring-focus)',
        'ring-danger': 'var(--ring-danger)',
      },
      spacing: {
        0: 'var(--s-0)',
        1: 'var(--s-1)',
        2: 'var(--s-2)',
        3: 'var(--s-3)',
        4: 'var(--s-4)',
        5: 'var(--s-5)',
        6: 'var(--s-6)',
        7: 'var(--s-7)',
        8: 'var(--s-8)',
        9: 'var(--s-9)',
        10: 'var(--s-10)',
        11: 'var(--s-11)',
        12: 'var(--s-12)',
      },
      width: {
        serverlist: 'var(--w-serverlist)',
        channellist: 'var(--w-channellist)',
        memberlist: 'var(--w-memberlist)',
        thread: 'var(--w-thread)',
        'topbar-search': 'var(--w-topbar-search)',
        settings: 'var(--w-settings)',
      },
      height: {
        topbar: 'var(--h-topbar)',
        'topbar-search': 'var(--h-topbar-search)',
      },
      zIndex: {
        sidebar: 'var(--z-header)',
        overlay: 'var(--z-modal-bg)',
        modal: 'var(--z-modal)',
        toast: 'var(--z-toast)',
        tooltip: 'var(--z-tooltip)',
        palette: '70',
      },
    },
  },
  plugins: [],
};
