---
title: Test your seller before going live
slug: /provide/test-locally
description: Run your seller and a buyer on one machine with no internet connection and send real requests, with no funds, no registration and nothing announced to the public network.
---

# Test your seller before going live

You can check that your seller serves requests before you fund, register or announce it. Run the seller, a buyer and a small bootstrap node on one machine with no internet connection, then send requests through the buyer as any app would.

You need no ETH, no USDC and no on-chain registration for this test.

## What is and isn't isolated

- **Discovery.** The seller and buyer find each other through a bootstrap node you run locally. `network.bootstrapNodes` adds nodes to the built-in public ones (`dht1.antseed.com` and `dht2.antseed.com`). It can't replace them, so a seller started with internet access still announces itself to the public network. Run this test only where there is no internet connection, for example in a Docker container with its network disconnected.
- **Payments.** `ANTSEED_ENABLE_SETTLEMENT=false` turns payments off on both sides, and `seller start` skips its on-chain checks (registration and gas). Nothing is settled on chain and no USDC moves, although `seller logs` and `seller status` still count the requests and what they would have earned.
- **Not tested.** Registration, gas, payments and settlement, and whether buyers on the internet can reach your ports. Steps 3 and 6 of [Become a provider](/docs/provide) cover those.

## 1. Set up while you are still online

The CLI installs its plugins from npm the first time it needs them, and it can't do that offline. While the machine is still online:

1. [Install the CLI](/docs/install).
2. Add your provider and services, as in [step 4 of Become a provider](/docs/provide#4-add-services). The upstream must run on this machine, so use the `local-llm` plugin with a local model server (for example Ollama with your model already pulled). A hosted API can't be reached offline.
3. Start a buyer once, so it installs its router and verifier plugins. Use a separate data directory, so the buyer gets its own identity:

   ```bash
   ANTSEED_ENABLE_SETTLEMENT=false antseed --data-dir ~/.antseed-test-buyer buyer start
   ```

   When it prints `Proxy listening on http://localhost:8377`, stop it with `Ctrl+C`. A buyer doesn't announce anything.

Now disconnect the machine from the internet. For a Docker container, run this on the host:

```bash
docker network disconnect bridge <container-name>
```

## 2. Start a local network

Each long-running command needs its own terminal.

Start a bootstrap node on a port the seller doesn't use, with its own data directory:

```bash
antseed --data-dir ~/.antseed-test-bootstrap network bootstrap --port 16881
```

Point the seller and buyer at it. They share `~/.antseed/config.json`:

```bash
antseed config set network.bootstrapNodes '["127.0.0.1:16881"]'
```

Start the seller with payments off:

```bash
ANTSEED_ENABLE_SETTLEMENT=false antseed seller start
```

It prints `Seeding active` and your `Peer ID`. The warning that `seller.publicAddress` is empty is expected here.

Start the buyer with payments off, pinned to your seller:

```bash
ANTSEED_ENABLE_SETTLEMENT=false antseed --data-dir ~/.antseed-test-buyer buyer start --peer <your-peer-id>
```

`--peer` is needed because a new seller's trust score is below the buyer's default minimum of 60, so the buyer's own routing won't choose it. Without it, requests fail with `No policy-allowed peer currently serves model`.

## 3. Send requests

Your services should be listed, with your peer ID and prices:

```bash
curl -s http://localhost:8377/v1/models
```

Send a request to one of them:

```bash
curl -s http://localhost:8377/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"<your-service-id>","messages":[{"role":"user","content":"Hello"}]}'
```

The response comes from your upstream. Add `"stream":true` to test streaming. Then check that the seller recorded the requests:

```bash
antseed seller logs
```

## 4. Clean up

Stop the buyer, seller and bootstrap node, then remove the local bootstrap entry from your config:

```bash
antseed config set network.bootstrapNodes '[]'
rm -rf ~/.antseed-test-buyer ~/.antseed-test-bootstrap
```

Reconnect to the internet and continue with [step 3 of Become a provider](/docs/provide#3-fund-and-register).
