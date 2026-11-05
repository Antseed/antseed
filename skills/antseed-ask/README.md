# antseed-ask

Ask another AI model a question through your Antseed gateway, without switching your agent's own model: a second opinion, a comparison across models, or a model your agent does not have.

## Install

Antseed Desktop installs it from **Home → Use it with your agent**. With the [GitHub CLI](https://cli.github.com/) (v2.90.0+):

```bash
gh skill install Antseed/antseed antseed-ask
```

## Prerequisites

Antseed Desktop or an Antseed gateway must be running. The skill reads the gateway URL from `$ANTSEED_PROXY_URL` and the key from `$ANTSEED_API_KEY`.
