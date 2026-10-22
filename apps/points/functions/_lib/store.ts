// Profile links in Cloudflare KV.
//   addr:<address>  -> Link (which X account a wallet belongs to)
//   x:<xId>         -> XRecord (the X account and every wallet it linked)
//   h:<handle>      -> xId (lookup by @handle for profile URLs)
import type { KV } from './env';
import type { XIdentity } from './session';

export interface Link {
  address: string;
  xId: string;
  handle: string;
  name: string;
  avatar: string;
  /** The wallet that signed the link: the address itself or its reward wallet (Deposits operator). */
  signer: string;
  linkedAt: string;
}

export interface XRecord extends XIdentity {
  addresses: string[];
  updatedAt: string;
}

const lc = (s: string) => s.toLowerCase();

export async function getLink(kv: KV, address: string): Promise<Link | null> {
  const raw = await kv.get(`addr:${lc(address)}`);
  return raw ? (JSON.parse(raw) as Link) : null;
}

export async function getX(kv: KV, xId: string): Promise<XRecord | null> {
  const raw = await kv.get(`x:${xId}`);
  return raw ? (JSON.parse(raw) as XRecord) : null;
}

export async function getXByHandle(kv: KV, handle: string): Promise<XRecord | null> {
  const xId = await kv.get(`h:${lc(handle.replace(/^@/, ''))}`);
  return xId ? getX(kv, xId) : null;
}

/** Keep the stored X profile fresh on every sign-in (handles and avatars change). */
export async function upsertX(kv: KV, id: XIdentity): Promise<XRecord> {
  const prev = await getX(kv, id.xId);
  if (prev && lc(prev.handle) !== lc(id.handle)) await kv.delete(`h:${lc(prev.handle)}`);
  const next: XRecord = { ...id, addresses: prev?.addresses ?? [], updatedAt: new Date().toISOString() };
  await kv.put(`x:${id.xId}`, JSON.stringify(next));
  await kv.put(`h:${lc(id.handle)}`, id.xId);
  for (const a of next.addresses) {
    const link = await getLink(kv, a);
    if (link && link.xId === id.xId) await kv.put(`addr:${a}`, JSON.stringify({ ...link, handle: id.handle, name: id.name, avatar: id.avatar }));
  }
  return next;
}

export async function link(kv: KV, id: XIdentity, address: string, signer: string): Promise<Link> {
  const a = lc(address);
  const existing = await getLink(kv, a);
  if (existing && existing.xId !== id.xId) {
    // A wallet belongs to one X account at a time; the newer signed claim wins and the old account loses it.
    const old = await getX(kv, existing.xId);
    if (old) await kv.put(`x:${old.xId}`, JSON.stringify({ ...old, addresses: old.addresses.filter((x) => x !== a) }));
  }
  const rec = (await getX(kv, id.xId)) ?? (await upsertX(kv, id));
  const addresses = Array.from(new Set([...rec.addresses, a])).slice(0, 10);
  await kv.put(`x:${id.xId}`, JSON.stringify({ ...rec, ...id, addresses, updatedAt: new Date().toISOString() }));
  await kv.put(`h:${lc(id.handle)}`, id.xId);
  const value: Link = { address: a, xId: id.xId, handle: id.handle, name: id.name, avatar: id.avatar, signer: lc(signer), linkedAt: new Date().toISOString() };
  await kv.put(`addr:${a}`, JSON.stringify(value));
  return value;
}

export async function unlink(kv: KV, xId: string, address: string): Promise<boolean> {
  const a = lc(address);
  const existing = await getLink(kv, a);
  if (!existing || existing.xId !== xId) return false;
  await kv.delete(`addr:${a}`);
  const rec = await getX(kv, xId);
  if (rec) await kv.put(`x:${xId}`, JSON.stringify({ ...rec, addresses: rec.addresses.filter((x) => x !== a) }));
  return true;
}
