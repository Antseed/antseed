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
the CLI reads the map shown above from that variable. Some plugins fill the list from the
upstream by themselves (see [Filled from the upstream](#filled-from-the-upstream)).

## What the list means

A label is a value the service accepts as a request's reasoning effort: `reasoning_effort`
on Chat Completions, `reasoning.effort` on Responses. List only the levels your upstream
documents as its own distinct levels and that you pass on unchanged in its documented
reasoning-effort field. Do not list words the upstream maps to another level. List `none`
if your upstream turns reasoning off with it. A service that takes no such value lists none.

- **Absent:** unknown. The seller has not said which efforts the service takes.
- **Empty:** the service takes none.
- **Present:** the service takes exactly these labels, as written (comparison is
  exact and case-sensitive).

When `reasoning` is `false`, the list must be empty or absent. Duplicates and
malformed labels are refused when the provider's configuration is read and when the
metadata is validated. No label has a special meaning such as "reasoning off".

## Filled from the upstream

At seller start, these plugins read the upstream's own free, read-only model metadata,
with the base URL, key and headers the relay already uses, and fill the list for Chat
Completions and Responses services. They recognise the upstream by the shape of its answer:

| Plugin | Call | Levels |
| --- | --- | --- |
| `provider-openai` | `GET {base}/v1/models` (next to a rewritten chat path, for example `/v3/models`) | `capabilities.reasoning_effort`, or `effort.supported_levels` |
| `provider-local-llm` (llama.cpp server) | `GET {base}/props?model=<model>&autoload=false` | `chat_template_caps.reasoning_effort_levels` minus `reasoning_effort_rejected` |
| `provider-local-llm` (Ollama) | `POST {base}/api/show` | the named levels in `thinking.values` |

A list the seller configured always wins, and nothing is filled for a service with
`reasoning: false`. `reasoning: true` is set only when the upstream lists a level other
than `none` (or, on Ollama, says the model thinks). A list with any label that breaks the
label rule fills nothing. A filled list is exactly what the upstream publishes, so it may
lack `none` even where the upstream can turn reasoning off with it.

A failed or oversized (over 4 MiB) answer, or one slower than 10 seconds, leaves the
capabilities unchanged, logs one line naming the host and path, and the seller starts
normally. `provider-openai` makes one call per provider; `provider-local-llm` tries
`/props` and then `/api/show`, so a server that answers neither can hold its start for
up to 20 seconds. When providers with the same name offer a service and their upstreams
fill it differently, `antseed seller start` announces the configured capabilities for
all of them and prints a warning, since buyers see one entry per provider name.

Not read: OpenRouter's catalogue (it has no list per host), Venice's model listing (it
publishes no levels), Anthropic's Models API (Messages is out of scope for the list), and
vLLM or SGLang (they publish no levels).

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
