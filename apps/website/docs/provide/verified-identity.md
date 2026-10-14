---
title: Verified identity
slug: /provide/verified-identity
description: Prove that your seller is run by the owner of a domain or GitHub account, so buyers can see who operates it and factor it into trust.
---

# Verified identity

You can attach ownership claims for a domain or a GitHub account to your seller. Buyers check each claim against a public proof you publish. Verified claims appear as links next to your seller (in `antseed network browse`, the desktop app and the Gateway Console's Providers page), and the public history of a verified identity, such as a GitHub portfolio or a domain's registration age, feeds the identity part of the buyer's [trust score](/docs/reputation#trust-score).

Claims bind to your **peer ID**: the EVM address of your seller identity key, without the `0x` prefix. If your seller is fronted by a seller contract (`payments.sellerContract`), still use the peer ID in proofs; buyers check the contract relationship separately on-chain.

Find your peer ID with:

```bash
antseed seller status
```

The **Wallet address** row is your peer ID with a `0x` prefix.

## Prove a domain

Choose either proof method, or publish both.

### DNS TXT record

Create a TXT record at `_antseed.<domain>`:

```text
Name:  _antseed.provider.example.com
Type:  TXT
Value: antseed-peer=<peerId>
```

### HTTPS well-known file

Serve this JSON at `https://<domain>/.well-known/antseed.json`:

```json
{
  "type": "antseed-domain-verification",
  "peerId": "<peerId>",
  "domain": "provider.example.com"
}
```

Serve it directly from the claimed domain. Buyers don't follow redirects, so a proof behind a redirect fails.

### Add the claim

```json
{
  "seller": {
    "verifications": {
      "domains": [
        { "domain": "provider.example.com", "methods": ["dns-txt"] }
      ]
    }
  }
}
```

`methods` lists the proofs buyers should try: `dns-txt`, `https-well-known`, or both. Leave it out to let buyers try both.

## Prove a GitHub account

Create a public repository under the account and put `antseed.json` at its root:

```json
{
  "type": "antseed-github-verification",
  "peerId": "<peerId>",
  "username": "example-org"
}
```

Buyers fetch it from `https://raw.githubusercontent.com/<username>/<repository>/HEAD/antseed.json`, without following redirects, so a renamed or transferred repository needs the proof republished under the claimed account.

Add the claim:

```json
{
  "seller": {
    "verifications": {
      "github": [
        { "username": "example-org", "repository": "antseed-verification" }
      ]
    }
  }
}
```

The repository name goes in the claim, not the proof file. Leave `repository` out to use the profile repository named after the account (`example-org/example-org`).

## Publish the claims

You can combine `domains` and `github` under one `seller.verifications` object. Restart the seller after changing it:

```bash
antseed seller start
```

The startup log lists the configured domain and GitHub claims, and your signed metadata (`GET /metadata`) includes them. Buyers check each claim within 3 seconds, cache the result for seven days, and check again as soon as your claims change. A claim whose proof doesn't verify is simply not shown.
