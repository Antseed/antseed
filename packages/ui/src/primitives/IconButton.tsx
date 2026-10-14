import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
  /** `sm` is a compact, borderless button for chips and inline controls. */
  size?: 'sm' | 'md';
}

export function IconButton({
  children,
  className,
  label,
  size = 'md',
  type = 'button',
  ...rest
}: IconButtonProps) {
  const classes = ['as-icon-button', size === 'sm' ? 'as-icon-button--sm' : null, className].filter(Boolean).join(' ');

  return (
    <button type={type} className={classes} aria-label={label} title={rest.title ?? label} {...rest}>
      {children}
    </button>
  );
}
