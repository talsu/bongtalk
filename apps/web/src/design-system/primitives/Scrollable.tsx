import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

/**
 * Overflow container with a consistent scrollbar look. Wraps a `<div>`
 * rather than forcing a specific tag so consumers can still add `role`s
 * and data-testids.
 */
export const Scrollable = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function Scrollable({ className, children, ...rest }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          'overflow-y-auto overscroll-contain',
          // scrollbar styling that doesn't break in dark mode
          '[scrollbar-color:hsl(var(--border-strong))_transparent] [scrollbar-width:thin]',
          className,
        )}
        {...rest}
      >
        {children}
      </div>
    );
  },
);
