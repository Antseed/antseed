import { cn } from "@/chat/lib/utils";
import { lazy, Suspense } from "react";
import type { StreamdownProps } from "streamdown";

/** Starts downloading the Markdown renderer; the chat page calls it on open so it is ready by the first answer. */
export const loadMarkdown = () => import("./markdown-renderer");

const MarkdownRenderer = lazy(loadMarkdown);

/**
 * Renders Markdown with Streamdown, which (with its code and math plugins) is most of the chat's
 * JavaScript. It is split out so the chat opens without waiting for it: until it arrives, the text
 * shows as plain text.
 */
export function Markdown({ className, children, ...props }: StreamdownProps) {
  return (
    <Suspense fallback={<div className={cn("whitespace-pre-wrap break-words", className)}>{children}</div>}>
      <MarkdownRenderer className={className} {...props}>{children}</MarkdownRenderer>
    </Suspense>
  );
}
