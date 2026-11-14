---
title: Privacy Policy
description: AntSeed Privacy Policy
slug: /privacy-policy
---

# AntSeed - Privacy Policy

**Last Updated: August 26, 2026**

This Privacy Policy explains what information is collected when you use the AntSeed websites (antseed.com and its subdomains, including download.antseed.com), the AntSeed VPR desktop application, the AntSeed CLI, and the AntSeed peer-to-peer protocol, and how that information is used. It should be read together with our [Terms of Service](/terms-of-service).

The short version: **we don't require accounts, we don't collect names or email addresses on the website, and we don't sell data.** The website uses standard analytics; the protocol is peer-to-peer by design, which has its own privacy properties described below.

## 1. Websites

### Analytics

antseed.com uses Google Analytics 4, loaded through Google Tag Manager, to understand how visitors use the site. This records standard analytics data: pages viewed, approximate location (country/city derived from IP by Google), device and browser type, referral source, and interaction events such as clicks on download buttons. Google Analytics sets cookies for this purpose. We do not receive your IP address from these tools in any report we use.

We also run advertising campaigns (e.g. Google Ads). Advertising cookies may be used to measure whether ads lead to visits and downloads. You can opt out of Google Analytics with the [Google Analytics Opt-out Browser Add-on](https://tools.google.com/dlpage/gaoptout) and manage ad personalization at [adssettings.google.com](https://adssettings.google.com).

### Installer downloads

Installers are served from download.antseed.com, which is operated on Cloudflare. When you download the desktop app, we record technical delivery telemetry: which installer was requested (platform and version), the country the request came from, the browser or tool's user-agent string, whether the transfer completed, how many bytes were delivered, and how long it took. This is used to make sure downloads actually work and to measure aggregate conversion. We do not store IP addresses in this telemetry. Cloudflare, as the network operator, processes connection data (including IP addresses) under [its own privacy policy](https://www.cloudflare.com/privacypolicy/).

## 2. Desktop App and CLI

The AntSeed VPR desktop app and CLI run locally on your machine.

- **Keys and credentials** (wallet keys, API keys you configure) are stored locally on your device — in your operating system's keychain where available — and are never transmitted to us.
- **Conversations and prompts** you send through AntSeed are routed peer-to-peer to the provider you (or the router) selected. They are not sent to, stored by, or readable by any central AntSeed server, because there isn't one. See "The protocol" below for what providers can see.
- **Update checks**: the app periodically checks GitHub for new releases. This discloses your IP address to GitHub like any web request, under [GitHub's privacy policy](https://docs.github.com/en/site-policy/privacy-policies).
- **Network statistics**: the app fetches public, aggregate network data (model listings, price statistics) from AntSeed ecosystem endpoints. These requests carry no personal information beyond what any HTTP request carries.
- The desktop app does not currently include usage analytics or crash reporting.

## 3. The Protocol

AntSeed is a peer-to-peer network. This design means:

- **Providers see what they serve.** When you send a request, the provider peer you are routed to receives the request content (e.g. your prompt) in order to process it. Choose providers accordingly, as you would any AI service. Transport between peers is encrypted.
- **Peer identifiers are pseudonymous.** Peers are identified by cryptographic addresses, not names or emails.
- **Payments are on-chain.** Deposits, payment channels, and settlements happen on public blockchains (e.g. Base). Like all blockchain transactions, they are public, permanent, and linkable to the addresses involved. Nothing about your request content goes on-chain; payment amounts and addresses do.

## 4. What We Share

We do not sell personal information. Data is processed by the infrastructure services named above — Google (analytics, ads), Cloudflare (website and download delivery), GitHub (code hosting, releases) — each under their own privacy policies. Aggregate, non-identifying statistics (e.g. total downloads, network usage) may be published publicly.

## 5. Data Retention

Website analytics data is retained according to our Google Analytics settings and Google's standard retention controls. Download telemetry contains no directly identifying information. We keep aggregate statistics indefinitely.

## 6. Your Choices and Rights

Depending on where you live (e.g. under GDPR or CCPA), you may have rights to access, correct, or delete personal data. Because we don't operate accounts and don't hold directly identifying data about website visitors, in most cases there is nothing for us to look up — but if you believe we hold personal data about you, or you have any privacy question or request, contact us and we will respond: open an issue at [github.com/AntSeed/antseed](https://github.com/AntSeed/antseed/issues) or use the contact channels listed on this site.

You can also: browse with cookies disabled or cleared, use the opt-outs linked in section 1, and download installers directly from [GitHub releases](https://github.com/AntSeed/antseed/releases) instead of download.antseed.com if you prefer GitHub's handling.

## 7. Children

The Services are not directed at children under 16, and we do not knowingly collect personal information from them.

## 8. Changes

We will update this policy as the Services evolve and change the "Last Updated" date above. Material changes will be noted on this page.
