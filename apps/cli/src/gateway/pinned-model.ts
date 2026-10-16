/**
 * A request can pin a seller with `<peerId>@<model>`. The request log, the
 * spend ledger and usage reports keep the model and the seller apart, so a
 * model reads as a model and groups as one however it was pinned.
 */
const PINNED_MODEL_RE = /^(?:0x)?([0-9a-fA-F]{40})@(.+)$/

export function splitPinnedModel(model: string | null | undefined): { model: string | null; peerId: string | null } {
  if (!model) return { model: model ?? null, peerId: null }
  const match = PINNED_MODEL_RE.exec(model)
  return match ? { model: match[2]!, peerId: match[1]!.toLowerCase() } : { model, peerId: null }
}

/** SQL that splits `<peerId>@<model>` rows of `table` the same way, for the migration of rows recorded before. */
export function splitPinnedModelSql(table: string): string {
  const at = "instr(model, '@')"
  const hex40 = (from: number) => `(lower(substr(model, ${from}, 40)) NOT GLOB '*[^0-9a-f]*')`
  const plain = `(${at} = 41 AND ${hex40(1)})`
  const prefixed = `(${at} = 43 AND lower(substr(model, 1, 2)) = '0x' AND ${hex40(3)})`
  return `
  UPDATE ${table} SET
    seller_peer_id = COALESCE(seller_peer_id, CASE WHEN ${at} = 43 THEN lower(substr(model, 3, 40)) ELSE lower(substr(model, 1, 40)) END),
    model = substr(model, ${at} + 1)
  WHERE model IS NOT NULL AND (${plain} OR ${prefixed});`
}
