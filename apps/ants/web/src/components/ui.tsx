import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

/*
 * Local primitives for the checkout look (black on white, Stripe-Checkout feel).
 * Deliberately not the shared @antseed/ui set — those are tuned to the green
 * portal theme. Styles live in ../styles.scss under .btn, .card, .alert,
 * .skeleton, .field and .icon-button.
 */

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* ---------- Button ---------- */

export type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  fullWidth?: boolean;
  leadingIcon?: ReactNode;
  size?: ButtonSize;
  variant?: ButtonVariant;
}

export function Button({ children, className, fullWidth = false, leadingIcon, size = 'md', type = 'button', variant = 'primary', ...rest }: ButtonProps) {
  return (
    <button type={type} className={cx('btn', `btn--${variant}`, `btn--${size}`, fullWidth && 'btn--full', className)} {...rest}>
      {leadingIcon ? (
        <span className="btn__icon" aria-hidden="true">
          {leadingIcon}
        </span>
      ) : null}
      <span className="btn__label">{children}</span>
    </button>
  );
}

/* ---------- Card ---------- */

export type CardTone = 'surface' | 'muted' | 'accent' | 'danger';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  tone?: CardTone;
}

/** White 16px-radius card with a hairline border and a very soft shadow. `muted`/`accent` = inset panel surface, `danger` = red hairline. */
export function Card({ children, className, tone = 'surface', ...rest }: CardProps) {
  return (
    <div className={cx('card', tone !== 'surface' && `card--${tone}`, className)} {...rest}>
      {children}
    </div>
  );
}

/* ---------- Alert ---------- */

export interface AlertProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  action?: ReactNode;
  children: ReactNode;
  title?: ReactNode;
  tone?: 'info' | 'success' | 'warning' | 'danger';
}

/** Notice box on the panel surface. Only `success` (green) and `danger` (red) are tinted; info/warning stay neutral. */
export function Alert({ action, children, className, title, tone = 'info', ...rest }: AlertProps) {
  return (
    <div className={cx('alert', `alert--${tone}`, className)} role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'} {...rest}>
      <div className="alert__content">
        {title ? <div className="alert__title">{title}</div> : null}
        <div className="alert__body">{children}</div>
      </div>
      {action ? <div className="alert__action">{action}</div> : null}
    </div>
  );
}

/* ---------- Skeleton ---------- */

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  height?: number | string;
  radius?: number | string;
  width?: number | string;
}

export function Skeleton({ className, height, radius, style, width, ...rest }: SkeletonProps) {
  return (
    <div
      className={cx('skeleton', className)}
      style={{
        ...style,
        ...(height !== undefined ? { height } : {}),
        ...(radius !== undefined ? { borderRadius: radius } : {}),
        ...(width !== undefined ? { width } : {}),
      }}
      {...rest}
    />
  );
}

/* ---------- TextField ---------- */

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: ReactNode;
  hint?: ReactNode;
  label?: ReactNode;
}

export function TextField({ className, error, hint, id, label, ...rest }: TextFieldProps) {
  const inputId = id ?? rest.name;
  return (
    <label className={cx('field', className)} htmlFor={inputId}>
      {label ? <span className="field__label">{label}</span> : null}
      <input id={inputId} className="field__input" {...rest} />
      {error ? <span className="field__error">{error}</span> : hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

/* ---------- IconButton ---------- */

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
}

export function IconButton({ children, className, label, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button type={type} className={cx('icon-button', className)} aria-label={label} title={rest.title ?? label} {...rest}>
      {children}
    </button>
  );
}
