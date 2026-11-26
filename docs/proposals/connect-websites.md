# Allow user-approved websites to connect directly to Antseed Desktop

Status: proposal for discussion, not an implemented feature or an approved API or security design.

## Problem

A user should be able to open an external website, click **Connect Antseed**, and use their own locally running Antseed Desktop with their own account and balance. They should not need a separate downloaded studio, a hosted gateway, or to copy prompts into an agent chat.

This is an external website connection flow, not a redesign of the built-in Desktop Studio.

## Proposed user experience

1. Open an HTTPS website on the same computer as Antseed Desktop and click **Connect Antseed**.
2. Desktop identifies the requesting website's exact origin and asks the user to approve access.
3. The website discovers available models, their capabilities, supported inputs and settings, limits, and pricing.
4. The user supplies a prompt, selects reference media, and chooses generation settings.
5. The website requests settings-specific quotes across all compatible models and suppliers, clearly distinguishing estimates from confirmed prices.
6. The user chooses a model and supplier, reviews the applicable price, and explicitly confirms the paid generation. Connecting alone never initiates spending.
7. The website submits the request, shows progress, and lets the user retrieve and save the result.
8. After a page reload, the website can recover the existing job and its result without creating a duplicate paid generation.

## Initial scope

Start with a Seedance page only. The connection and capability interface should not hard-code Seedance controls: future WAN, Grok, and other individual model pages should be able to use the same approach with each model's supported controls. Those additional pages are outside the initial scope.

## Required capabilities

### User-approved website access

- Let the user approve individual exact website origins rather than requiring a centrally maintained website whitelist.
- Let the user inspect and revoke a website's access in Desktop.
- Provide a supported browser connection and authentication flow without exposing the user's identity private key to the website.
- Handle browser CORS and preflight requirements for the approved origin without treating CORS as a substitute for authentication or user approval.
- Preserve existing authentication, spending controls, and payment protections. Approval to connect is not approval to spend.

### Catalogue and quotes

- Expose a catalogue of models and suppliers with their capabilities, accepted inputs, supported settings, and limits.
- Quote across all compatible models and suppliers for the user's actual prompt, media, and selected settings, rather than showing a single supplier or a generic model price.
- Distinguish an estimate from a confirmed price and make the selected model, supplier, settings, and applicable price clear before paid confirmation.

### Media and jobs

- Support upload or reference submission of the media the user explicitly selects.
- Submit the chosen generation only after explicit confirmation, expose progress and job status, and support result retrieval and saving.
- Recover existing jobs after a reload or reconnection without duplicate submissions or charges.

These are requested outcomes, not a specification of endpoints, token formats, transport, or payment changes. The supported connection mechanism and security design need maintainer discussion before implementation.

## Observed blocker

In the user's test on November 26, 2026, the local gateway was reachable, but an `OPTIONS` request to `http://127.0.0.1:8379/v1/models` with origin `https://web01.antbeacon.com` returned HTTP 404 without CORS headers. This blocked that attempted browser connection.

The Desktop/CLI version was not recorded. This observation describes that installation and test only; it does not establish that every version or current upstream lacks a supported connection flow. It is not a request to bypass browser protections or expose an unauthenticated local service.

## Alternatives and non-goals

- A hosted gateway is not the requested route: the user wants the website connected directly to their own Desktop and account.
- A separately downloaded studio or copying prompts into agent chat does not provide the requested website workflow.
- Redesigning the built-in Studio, implementing additional model pages, and changing payment logic are outside this proposal.
- This document does not implement an API, alter the protocol specification, or claim maintainer approval.

## Acceptance criteria for a future implementation

- An HTTPS website on the same computer can request access, and Desktop shows the exact origin for user approval.
- Once approved, the website can discover the catalogue and settings-specific quotes across all compatible models and suppliers.
- The user can supply selected reference media, choose a model and supplier, and explicitly confirm the paid generation separately from connecting.
- The website can submit the confirmed request, display progress, retrieve the result, and let the user save it.
- Reloading or reconnecting recovers the existing job without duplicate paid generation.
- Revoking access prevents further use of that website's authorization.
- Identity private keys remain private and existing authentication and spending protections remain in force.

Connecting should be straightforward, with clear instructions if the browser asks the user for permission
