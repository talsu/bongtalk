import * as RTooltip from '@radix-ui/react-tooltip';

/**
 * Wrapper around Radix Tooltip so every tooltip in the shell gets the same
 * animation / padding / color treatment without callers knowing the
 * underlying library.
 */
export function TooltipProvider({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <RTooltip.Provider delayDuration={200} skipDelayDuration={400}>
      {children}
    </RTooltip.Provider>
  );
}

export function Tooltip({
  label,
  children,
  side = 'right',
}: {
  label: string;
  children: React.ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
}): JSX.Element {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          className="z-tooltip rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-sm"
        >
          {label}
          <RTooltip.Arrow className="fill-foreground" />
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}
