# Reasoning-effort announcements

Sellers may advertise `serviceCapabilities[service].reasoningEfforts` as a list of
opaque, seller-defined labels. There is no protocol-wide enum. Lists contain at most
32 unique labels of at most 64 UTF-8 bytes each, without empty strings, surrounding
whitespace, control characters (C0/C1), invisible format characters such as bidi
overrides and zero-width characters, lone surrogates, or line/paragraph separators. These labels describe the service's supported
controls, not a guarantee that every API protocol can represent every label.

```json
{
  "model": {
    "reasoning": true,
    "reasoningEfforts": ["adaptive", "deep-analysis"]
  }
}
```

Use this shape in provider `serviceCapabilities` configuration or the existing
`ANTSEED_SERVICE_CAPABILITIES_JSON` environment variable. Omission means unknown;
it does not mean unsupported. An empty list explicitly advertises no supported
reasoning choices. Duplicates and malformed labels are rejected. If `reasoning` is
explicitly false, its effort list must be empty or omitted; no label is given a
special hardcoded meaning such as disabled reasoning.

The list is covered by the seller's metadata signature and sorted by code-unit
order for binary encoding. Metadata v13 uses a two-byte capability presence mask;
bit 8 indicates the effort list. The payload is a one-byte count followed by length-prefixed UTF-8 labels, after
supported parameters. Metadata v12 retains its one-byte mask. Encoding efforts on
older versions fails instead of silently discarding them.

Per-peer discovery and catalog entries preserve these announcements. They do not
change requests, choose reasoning levels, or add UI controls. A model-wide
capability summary must not be treated as a particular seller's effort list.

This capability is independent of quantity billing. Sellers without
effort lists continue announcing metadata v12, including those with existing v1
unit billing. Metadata v13 retains that billing format and adds only the wider
capability mask and effort lists. Older buyers that support only metadata v12
cannot consume v13 announcements. Future incompatible wire changes must use a
new metadata version rather than redefine v13.
