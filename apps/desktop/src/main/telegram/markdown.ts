// ── Markdown → Telegram HTML ──
// The agent replies in standard Markdown; Telegram renders entities only
// with a parse_mode. HTML mode is used because MarkdownV2 requires escaping
// most punctuation and breaks easily on model output. Conservative subset:
// fenced code, inline code, bold, headers (rendered bold), and links —
// everything else passes through as escaped text.

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatInline(text: string): string {
  // Protect inline code spans from the other substitutions.
  const segments = text.split(/(`[^`\n]+`)/);
  return segments.map((segment) => {
    if (segment.length > 2 && segment.startsWith('`') && segment.endsWith('`')) {
      return `<code>${escapeHtml(segment.slice(1, -1))}</code>`;
    }
    let s = escapeHtml(segment);
    s = s.replace(/\*\*([^*\n][^*]*?)\*\*/g, '<b>$1</b>');
    s = s.replace(/(^|\n)#{1,6}[ \t]+(.+)/g, '$1<b>$2</b>');
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
    return s;
  }).join('');
}

export function markdownToTelegramHtml(markdown: string): string {
  // Even indices are prose, odd are fenced code (an unclosed trailing fence
  // simply renders its remainder as code).
  return markdown.split('```').map((part, index) => {
    if (index % 2 === 0) return formatInline(part);
    const newline = part.indexOf('\n');
    const lang = newline >= 0 ? part.slice(0, newline).trim() : '';
    const code = newline >= 0 ? part.slice(newline + 1) : part;
    const cls = /^[\w+-]+$/.test(lang) ? ` class="language-${lang}"` : '';
    return `<pre><code${cls}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`;
  }).join('');
}
