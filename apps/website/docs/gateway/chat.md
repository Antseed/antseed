---
title: Chat
slug: /gateway/chat
description: Chat with any model on the network from the gateway console or the terminal, paid, budgeted and logged like any API request.
---

# Chat

The console's **Chat** page lets every member talk to any text model on the network, with an agent that can search and read the web. It runs on your gateway and pays like any other request: through an API key, within its budgets, and recorded in **Logs**.

## Who pays

The first time you open **Chat** in a workspace, the gateway creates an API key for you there, labelled **Web chat**. Every chat request uses that key, so:

- It pays from the workspace's wallet.
- Your member budget, the key's budgets and the workspace budget apply. See [Budgets and spend limits](/docs/gateway/budgets).
- Your routing policies apply, and the model list follows them.
- Each request shows up in **Activity** and **Logs** under the **Web chat** key.

Below the message box, the page shows which key pays, what it spent this month (against its monthly cap, if any) and an estimate of what the current chat cost. The estimate uses the provider's advertised prices; the amount actually paid is in **Logs**.

An organization admin who opens a workspace they are not a member of gets an unowned key labelled `Web chat (<their name>)`.

## Pick a model and a provider

1. Choose a model in the model picker. Models with free offers are marked **Free offers**; others show their price range.
2. Choose a seller, or keep **Auto: the gateway picks the best offer each turn**. With Auto, the page shows which provider automatic routing would pick right now.
3. Type your message.

Every answer shows which provider served it, the tokens used and the estimated cost. Pinning a provider sends every turn to it. If it stops offering the model, the page offers **Use Auto**.

If no free provider offers the model and the wallet is empty, the page links to **Add funds**. See [Funding](/docs/gateway/funding).

## Tools

On models that can use tools, the agent can:

- Search the web and read web pages.
- Read and write files in a private scratch directory for the conversation, on the gateway host.

Models that cannot use tools answer as plain chat. Web search uses Brave Search when the gateway has `ANTSEED_BRAVE_API_KEY` set, and DuckDuckGo otherwise.

### Shell commands (organization admins)

Organization owners and admins also get a shell tool. It runs commands in the chat's scratch directory, as the gateway's own operating-system user, with a 60-second timeout.

No command runs on the model's say-so. Each one stops the answer and asks **Run this command on the gateway host?**, showing the exact command, with **Approve** and **Deny**. Approve only commands you understand: the model's output comes from a network provider and from any page it read, either of which can try to steer it.

:::warning
A shell command has the gateway user's permissions, including access to its data directory and wallet keys. The scratch directory confines the file tools, not the shell.
:::

## Conversations

Your conversations are stored on the gateway and listed on the left of the page. Each member sees only their own. Delete one from its row.

## Chat from the terminal

`antseed chat` opens the same chat in your terminal. It uses the same backend, agent, tools and stored conversations as the console.

On the gateway host, no key is needed: the first run creates a key labelled `CLI chat` in the Default workspace and keeps it in the data directory.

```bash
antseed chat
antseed chat --workspace Research --model deepseek-v4-flash
```

Against a remote gateway, pass its origin and an API key:

```bash
antseed chat --gateway https://gateway.example.com --key "$ANTSEED_API_KEY"
```

| Option | Purpose |
|---|---|
| `--gateway <url>` | Gateway origin (default: the gateway on this machine) |
| `--key <apiKey>` | API key that pays, also read from `ANTSEED_GATEWAY_KEY` |
| `--workspace <id\|name>` | On the gateway host: the workspace the created `CLI chat` key pays from |
| `--model <id>` | Model id (default: the most offered model that can use tools) |
| `--peer <peerId\|any>` | Provider for every turn; `any` lets the gateway pick each turn |
| `--resume <threadId>` | Continue a conversation |
| `--history` | List your conversations and exit |

A chat run with an API key never gets the shell tool.

Next: [Funding and the authorized wallet](/docs/gateway/funding).
