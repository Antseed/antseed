# antseed-ask

Ask another AI model a question through your Antseed gateway, without switching your agent's own model: a second opinion, a comparison across models, or a model your agent does not have.

## Install

Antseed Desktop installs it from **Home → Use it with your agent**. With the [GitHub CLI](https://cli.github.com/) (v2.90.0+):

```bash
gh skill install Antseed/antseed antseed-ask
```

## Prerequisites

Antseed Desktop or an Antseed gateway must be running. The skill reads the gateway URL from `$ANTSEED_PROXY_URL` and the key from `$ANTSEED_API_KEY`.

A copy installed with `gh skill install` isn't pointed at your gateway. Set `ANTSEED_PROXY_URL` and `ANTSEED_API_KEY` (in Antseed Desktop, **Agents & apps → Copy setup prompt** has both). Without them the skill stops and asks which gateway to use; it never falls back to a local buyer on its own.
