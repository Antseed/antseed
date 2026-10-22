// The exact text a wallet signs to link itself to an X account. Shared by the
// site (which asks the wallet to sign it) and the API (which checks it), so it
// has no imports.
export function linkMessage(p: { handle: string; xId: string; address: string; issuedAt: string }): string {
  return [
    'Antseed Points: link my X account to this wallet',
    `X account: @${p.handle} (id ${p.xId})`,
    `Wallet: ${p.address.toLowerCase()}`,
    `Issued at: ${p.issuedAt}`,
    'This signature only proves ownership. It does not send a transaction or cost gas.',
  ].join('\n');
}
