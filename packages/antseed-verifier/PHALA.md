# Phala (dstack TDX CVM)

Run the seller inside the Phala CVM. Mount `/var/run/dstack.sock` into the container.

```bash
export ANTSEED_TEE_PEER_ID=<peer id, no 0x>
export ANTSEED_VERIFIER_SIGNING_KEY=<hex key; address == peer id>
export ANTSEED_VERIFIER_NODE_TEE=dstack
# export ANTSEED_VERIFIER_DSTACK_SOCKET=/custom/path.sock   # if not /var/run/dstack.sock
```

Start the seller with `--verifiers antseed-verifier`. Buyers attest with `--require-verifier`.

Ports: the container port is the announced address for signaling (TCP) and DHT (UDP), so the
public host port must match it. The VM-layer docker-compose mapping can differ (Phala assigns
it); a 1:1 VM-to-container mapping can delay the DHT advert on some workers.
