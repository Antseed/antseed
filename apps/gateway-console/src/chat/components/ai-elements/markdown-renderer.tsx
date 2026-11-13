import { streamdownPlugins, streamdownRehypePlugins } from "@/chat/lib/streamdown";
import { Streamdown, type StreamdownProps } from "streamdown";

/** Streamdown with the console's plugins. Heavy (Markdown, math, Shiki): only loaded through `Markdown`. */
export default function MarkdownRenderer(props: StreamdownProps) {
  return <Streamdown plugins={streamdownPlugins} rehypePlugins={streamdownRehypePlugins} {...props} />;
}
