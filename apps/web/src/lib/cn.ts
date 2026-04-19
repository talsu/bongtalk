/** Tiny classnames helper — primitives concatenate strings, no clsx needed. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
