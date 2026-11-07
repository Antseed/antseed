/** Words a person can act on, for what the gateway reports when a chat request fails. */
export function describeChatError(message: string, modelLabel: (id: string) => string | undefined): string {
  const text = message.replace(/^\d{3}\s+/, '').trim();
  const noPeer = /^No policy-allowed peer currently serves model "([^"]+)"/.exec(text);
  if (noPeer) {
    const id = noPeer[1] ?? '';
    return `No provider for ${modelLabel(id) ?? id} fits your policy right now.`;
  }
  // A seller's refusal arrives as its raw response, wrapped in network boilerplate.
  const original = /Original Response:\s*(\{[\s\S]*\})\s*$/.exec(text)?.[1];
  if (original) {
    try {
      const body = JSON.parse(original) as { message?: unknown; error?: { message?: unknown } };
      const said = typeof body.message === 'string' ? body.message : body.error?.message;
      if (typeof said === 'string' && said.trim()) {
        return `The provider refused this request: ${said.split(/: messages\./)[0]!.trim()} You can try another model.`;
      }
    } catch {
      // Not JSON after all: show it as it came.
    }
  }
  return text;
}
