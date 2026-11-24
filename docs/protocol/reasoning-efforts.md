# Reasoning-effort announcements

Sellers may announce `serviceCapabilities[service].reasoningEfforts`: the reasoning
efforts the service accepts, as a list of the seller's own labels. There is no
protocol-wide enum. A list holds at most 32 unique labels. A label is 1 to 64 visible
ASCII characters, `!` to `~`: no spaces, no control characters and no other scripts
(`REASONING_EFFORT_PATTERN` in `packages/protocol/src/reasoning.ts`).

```json
{
  "model-a": {
    "reasoning": true,
    "reasoningEfforts": ["low", "medium", "high", "max"]
  }
}
```

With the CLI, put the list in a service's capabilities in the seller config:
`seller.providers.<provider>.services.<service>.capabilities.reasoningEfforts`. The CLI
passes every service's capabilities to the provider plugin as one map, keyed by service,
in the `ANTSEED_SERVICE_CAPABILITIES_JSON` environment variable; a plugin run without
the CLI reads the map shown above from that variable.

## What the list means

A label is a value the service accepts as a request's reasoning effort: `reasoning_effort`
on Chat Completions, `reasoning.effort` on Responses. A service that takes no such value
lists none.

- **Absent:** unknown. The seller has not said which efforts the service takes.
- **Empty:** the service takes none.
- **Present:** the service takes exactly these labels, as written (comparison is
  exact and case-sensitive).

When `reasoning` is `false`, the list must be empty or absent. Duplicates and
malformed labels are refused when the provider's configuration is read and when the
metadata is validated. No label has a special meaning such as "reasoning off".

## How buyers use it

A buyer that adds a default reasoning effort to a request that names none decides
per seller: a service gets the effort only if its announced list contains exactly that
label. A service that announces no list, or an empty one, gets none, and nothing is
substituted for a label the list lacks. The buyer's word for "add nothing" is `off` in
any letter case, so a buyer cannot choose a label named `off`.

The buyer never changes an effort the client set. The list does not change routing.

## Wire format

Metadata v19 (`REASONING_EFFORTS_METADATA_VERSION`) carries the list. In the
per-service capability entry, value bit 5 says a list follows the speech options:
a one-byte count, then each label as `[len:1][utf8]`. The signed bytes hold the labels
in code-unit sorted order, so re-encoding decoded metadata gives the same signed bytes;
the JSON a seller serves on `/metadata` keeps the order the seller configured. An empty
list sets the bit with a zero count, which keeps "none" distinct from "unknown". The
list is covered by the seller's metadata signature.

Sellers sign every version they serve. A document older than v19 keeps the service
and its other capabilities and leaves the list out, so buyers on older releases see
the same seller as before. Encoding a list into a v12 to v18 document fails instead
of silently dropping it, and validation refuses the list in any document older than
v19. Documents before v12 carry no capabilities at all.
