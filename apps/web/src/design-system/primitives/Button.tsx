import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

/**
 * The ONLY button used across the app. Every variant is a token composition —
 * no primitive colors allowed here either. Loading state is deliberately
 * absent: callers should render a spinner outside or change the label.
 */
export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = 'primary', size = 'md', className, type = 'button', ...rest },
  ref,
) {
  const base =
    'inline-flex items-center justify-center font-medium rounded-md transition-colors duration-fast ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50';
  const sizes: Record<ButtonSize, string> = {
    sm: 'h-8 px-3 text-xs',
    md: 'h-9 px-4 text-sm',
    lg: 'h-11 px-6 text-base',
  };
  const variants: Record<ButtonVariant, string> = {
    primary: 'bg-bg-primary text-fg-primary hover:opacity-90',
    secondary: 'bg-bg-subtle text-foreground hover:bg-bg-muted border border-border-subtle',
    ghost: 'bg-transparent text-foreground hover:bg-bg-subtle',
    danger: 'bg-danger text-fg-primary hover:opacity-90',
  };
  return (
    <button
      ref={ref}
      type={type}
      className={cn(base, sizes[size], variants[variant], className)}
      {...rest}
    />
  );
});
