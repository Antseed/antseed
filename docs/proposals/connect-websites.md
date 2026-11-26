Enable user-authorised websites to connect to Antseed Desktop

Summary

We would like users to connect a website directly to their own locally running Antseed Desktop, using their own Antseed account and balance.

This would enable browser-based creative studios and other applications without requiring a separately downloaded application, a hosted gateway, or copying instructions into an agent’s chat window.

Intended user experience

1. The user opens a website and clicks Connect Antseed.
2. Antseed Desktop asks the user to approve that website.
3. Once approved, the website can discover available models, capabilities and pricing.
4. The user supplies their prompt, reference files and desired settings.
5. The website obtains quotes across compatible models and suppliers, allowing the user to compare options.
6. The user chooses an option and explicitly confirms generation.
7. The website submits the request, displays progress, retrieves the result and lets the user save it.

Scope

Our initial implementation is a Seedance video-generation page. This is the starting point for a broader studio with dedicated pages for WAN, Grok and other models, each offering the inputs and controls appropriate to that model.

The connection should therefore be general-purpose, rather than specific to Seedance, video generation, or a particular website layout.

Requested capabilities

- User-controlled website approval: the user decides which websites may connect to their Desktop and can revoke access at any time. Approval should not require a central registry or permission from Antseed or another third party.
- Browser connection support: support requests from explicitly user-approved website origins, including the necessary CORS and preflight handling.
- Secure authorisation: provide a supported way for a website to authenticate without exposing the user’s underlying identity key.
- Model and capability discovery: allow websites to discover models, suppliers, supported inputs, settings and limits.
- Quotes and comparison: allow websites to obtain quotes across all available models and suppliers capable of fulfilling the requested task. Quotes should reflect the selected inputs and settings, with any distinction between an estimate and a confirmed price made clear.
- Complete job lifecycle: support required media uploads or references, submission, progress/status checks, result retrieval and recovery of an existing job after a page reload.
- Existing safeguards: retain authentication and spending protections. Approving a website connection should not itself initiate a paid generation.

Current blocker

In our test, the local gateway was reachable, but an OPTIONS /v1/models browser-preflight request returned 404 without CORS permission headers. This prevents the authenticated browser connection in the tested setup.

Acceptance criteria

From an HTTPS-hosted website, a user should be able to:

- Approve connection to Antseed Desktop running on the same computer.
- Discover models and obtain comparable quotes for a task.
- Select an option and explicitly authorise a paid request.
- Submit reference media where supported.
- Follow progress and retrieve the completed result.
- Reload the website and recover an existing job without submitting it again.
- Revoke the website’s access from Desktop.

Connecting should be straightforward, with clear instructions if the browser asks the user for permission
