/** Words a person can act on, for what the gateway reports when a chat request fails. */
export function describeChatError(message: string, modelLabel: (id: string) => string | undefined): string {
  const text = message.replace(/^\d{3}\s+/, '').trim();
  const noPeer = /^No policy-allowed peer currently serves model "([^"]+)"/.exec(text);
  if (noPeer) {
    const id = noPeer[1] ?? '';
    return `No provider for ${modelLabel(id) ?? id} fits your policy right now.`;
  }
  return text;
}
