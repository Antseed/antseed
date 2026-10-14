import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

/**
 * `link` renders as inline text (underlined), for quiet actions inside a sentence.
 * `brand` is the Antseed green pill (the website's download button): at most one per screen, for its main action.
 */
export type ButtonVariant = "primary" | "brand" | "outline" | "ghost" | "danger" | "link";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  fullWidth?: boolean;
  leadingIcon?: ReactNode;
  size?: ButtonSize;
  trailingIcon?: ReactNode;
  variant?: ButtonVariant;
  /** Renders a link styled as a button (for downloads, external pages, redirects). */
  href?: string;
  download?: AnchorHTMLAttributes<HTMLAnchorElement>["download"];
  target?: AnchorHTMLAttributes<HTMLAnchorElement>["target"];
  rel?: AnchorHTMLAttributes<HTMLAnchorElement>["rel"];
}

export function Button({
  children,
  className,
  fullWidth = false,
  leadingIcon,
  size = "md",
  trailingIcon,
  type = "button",
  variant = "primary",
  href,
  download,
  target,
  rel,
  ...rest
}: ButtonProps) {
  const classes = [
    "as-button",
    `as-button--${variant}`,
    `as-button--${size}`,
    fullWidth ? "as-button--full" : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const content = (
    <>
      {leadingIcon && (
        <span className="as-button__icon" aria-hidden="true">
          {leadingIcon}
        </span>
      )}
      <span className="as-button__label">{children}</span>
      {trailingIcon && (
        <span className="as-button__icon" aria-hidden="true">
          {trailingIcon}
        </span>
      )}
    </>
  );

  // A disabled link renders as a disabled <button> below: it must not navigate,
  // and it picks up the same disabled styling as any other button.
  if (href !== undefined && !rest.disabled) {
    // Drop the attributes that only mean something on a <button>; everything
    // else (handlers, aria-*, data-*, title, style...) applies to the link.
    const { disabled, form, formAction, formEncType, formMethod, formNoValidate, formTarget, name, value, ...anchorProps } = rest;
    const safeRel = target === "_blank" ? rel ?? "noopener noreferrer" : rel;
    return (
      <a
        {...(anchorProps as AnchorHTMLAttributes<HTMLAnchorElement>)}
        className={classes}
        href={href}
        download={download}
        target={target}
        rel={safeRel}
      >
        {content}
      </a>
    );
  }

  return (
    <button type={type} className={classes} {...rest}>
      {content}
    </button>
  );
}
