# Levanto routing integration

The canonical integration contract is [model-routing](model-routing.md), the
AntSeed binding of [Inference Routing Protocol (IRP)](https://github.com/inference-routing/spec/blob/main/SPEC.md)
suggest-only mode. Use that document for endpoints, request and response shapes,
model-name matching, cost/quality semantics, and error handling. There is no
separate Levanto wire format or buyer adapter.

The router sees the conversation supplied for ranking but only ranks candidates.
Each successful ranking is a separate completed-request purchase; the buyer
sends inference to, and pays, the chosen inference seller independently.

This file remains an entry point for the development fixture named Levanto:

- [Desktop verification](../levanto-vpr-release.md): local fixture commands and UI checks.
- [Completed-request billing](unit-billing-services.md): provider metadata and billing behavior.
- [Provider guide](../../apps/website/docs/guides/become-a-provider.md#offering-a-model-routing-service): offering a `model-routing` service.
