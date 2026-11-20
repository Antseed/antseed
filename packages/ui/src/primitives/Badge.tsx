import type { HTMLAttributes, ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
/** `outline` (the default) is a bordered tag; `soft` is a quiet filled pill for values such as prices. */
export type BadgeVariant = 'outline' | 'soft';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  variant?: BadgeVariant;
  children: ReactNode;
}

export function Badge({ tone = 'neutral', variant = 'outline', children, className, ...rest }: BadgeProps) {
  return (
    <span className={['as-badge', `as-badge--${tone}`, variant === 'soft' ? 'as-badge--soft' : null, className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </span>
  );
}
