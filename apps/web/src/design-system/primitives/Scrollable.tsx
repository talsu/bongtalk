import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

// Scrollbar colors come from the DS (--scrollbar-thumb / --scrollbar-thumbH
// applied globally via /design-system/tokens.css); this wrapper just owns
// overflow + overscroll behavior.
export const Scrollable = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function Scrollable({ className, children, ...rest }, ref) {
    return (
      <div ref={ref} className={cn('overflow-y-auto overscroll-contain', className)} {...rest}>
        {children}
      </div>
    );
  },
);
