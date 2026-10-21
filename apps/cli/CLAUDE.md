# @antseed/cli

The `antseed` command, the buyer proxy (`src/proxy/`), the gateway (`src/gateway/`) and plugin loading (`src/plugins/registry.ts`). It is glue over `@antseed/node`, with no protocol or payment logic of its own. It is also the one buyer both hosts run (`buyer start`). Its local `/_antseed/*` API is how the desktop and the gateway read and steer that buyer. So anything a host needs from the buyer is added here, once, as a route or a command, for both hosts.

**Ask first:** a new or changed `/_antseed/*` route (both hosts call it); a removed or renamed command or flag, or a changed default (users script them); what the proxy forwards, or to which peer.
