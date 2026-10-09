---
title: "Living Off the Agent Pt 2: obtaining and using the Codex agent identity"
date: 2026-10-09 14:01:52 -0400
tags: [codex, credentials, connectors, mcp, ai-agents]
excerpt: "Stealing the Codex agent identity and using the tools connected behind it."
toc: true
---
Responsible disclosure and intended use: Before publishing this research, I disclosed the security issues discussed here through OpenAI’s formal reporting channels and made repeated attempts over several months to engage on remediation. The accompanying [Pickpocket](https://github.com/ohfog-alt/pickpocket) and [Plugout](https://github.com/ohfog-alt/plugout) tools are proofs of concept, provided as-is for educational and defensive research, not production tooling. I am releasing them so the public can independently understand the risk, examine the evidence, and take informed precautions. Use them only with accounts and systems you own or are explicitly authorized to test.

Hello neighbor, if you read the first post in this series and are back for more, thank you for returning! Again, I hope you find this post helpful and have as much fun reading it as I had researching and writing it.

This time, the thing that got my attention was a little file created by the OpenAI coding agent Codex: their auth file.

```text
~/.codex/auth.json
```

That file is where Codex keeps authentication material in a default setup, and the first time I noticed it my reaction was basically: WTF, is this just sitting on disk?

If you spend enough time around developer laptops, badly scoped dotfiles, and infostealers, you will get a little paranoid about files like that. A browser cookie database is one thing. A plaintext file in a predictable path with an access token, refresh token, and account identifier is just inviting trouble.

So naturally I started digging.

The first thing I learned was that Codex does have a more secure storage mode. You can tell it (by editing config.toml) to use the platform keyring instead of writing auth material to `auth.json`:

```toml
cli_auth_credentials_store = "keyring"
```

On macOS, that means Keychain, which sounded great because Keychain is solid. So change the config, restart, problem solved, nothin to see here... right?

Not so fast.

First of all, if there's a more secure place to store the secrets why doesn't Codex use that by default? And why is this configuration option hidden deep in the docs? 
`¯\_(ツ)_/¯`

If someone wanted to make an infostealer, `~/.codex/auth.json` would be an easy target. Grab the file, parse the token, and now you have whatever that user could do with Codex.

So the obvious next question was:

```text
How much safer is keyring mode really?
```

I switched Codex over to keyring-backed storage and started probing. The first thing I saw looked good: if I tried to read the secret directly with another process, macOS did not just hand it over. Keychain Access showed that the item had an application ACL. On my machine, the trusted application was Codex itself. That is exactly the kind of thing people expect from Keychain; a random process should not be able to walk up and casually dump the secret. And that is where my curiosity changed direction.

The question was no longer:

```text
Can another process read the secret directly?
```

The new question was:

```text
Can another process get Codex to read it and hand it over?
```

That distinction matters a lot because Keychain can protect a secret from random filesystem access and from a lot of direct reads too, but eventually the application that owns the secret still has to use it. If that trusted application exposes a control surface that is willing to hand the secret back, then the storage backend is no longer the interesting boundary... the application is.

This is where I started getting the smell of freshly baked `[cookie_crimes](https://github.com/defaultnamehere/cookie_crimes)` and `[WhiteChocolateMacademiaNut](https://github.com/slyd0g/WhiteChocolateMacademiaNut)`, where the trick is not to smash through the operating system’s protection head-on, the clever move is to start the application that owns the secrets with its debug capability turned on, connect to it and coerce it into doing the protected action for you.

From my initial research (see previous post) I suspected that the remote-control feature might let me, well, control Codex and coerce it into handing over the secret. So I started looking again at the Codex RPCs reachable via remote-control protocol and I found that the local app-server exposes a method called:

```text
getAuthStatus
```

The interesting part is that this method can be asked to include the token:

```json
{
  "method": "getAuthStatus",
  "id": 2,
  "params": {
    "includeToken": true,
    "refreshToken": true
  }
}
```

That was the whole trick. 

If I call `/usr/bin/security` from some unrelated process, Keychain evaluates that other process and potentially prompts for elevation or denies it. But if I momentarily enable Codex remote-control and ask it to call into its own auth state and return the token, the Keychain read happens inside the trusted Codex process. From the operating system's point of view, Codex is just using its own credential.

So I built a small tool I called `pickpocket` with a simple idea:

```text
attacker process
  -> local Codex app-server
  -> getAuthStatus(includeToken:true)
  -> Codex reads its own Keychain entry
  -> auth token comes back
```

And it worked.

The Keychain was doing what it was supposed to do. The secret was not leaking because the Keychain failed. The secret was leaking because Codex itself had at least this one export path. That is an important distinction: file-backed auth is bad because somebody can steal the file, keyring-backed auth is better because somebody cannot just scrape the file anymore, but if a trusted local API is willing to return the raw secret, then an attacker who already has code execution in the user's session can still get what they want.

At that point I had the token, but that created a much more interesting question:

```text
What is the token actually good for?
```

The obvious answer is inference: with the token, you can use the account as the user and talk to an LLM spending their token credits. But that is not the only thing attached to the account anymore. Modern ChatGPT accounts can also have apps, plugins, or connectors attached to them as Tools for agents to use. Such Tools give the ChatGPT and Codex agents access to connected systems like:

- Slack
- Gmail
- Google Drive
- Outlook
- SharePoint
- GitHub
- And whatever else the user or their company connected.

This part of the story started because a friend asked me a simple question:

```text
Do the plugins I have in chatgpt.com also exist in Codex CLI?
```

My memory told me no. I remembered looking into that a few months earlier and thinking Codex did not expose that surface yet.

But I wanted to give a grounded, up to date answer, not a guess, so I checked again. And to my surprise, Codex now had a `/plugins` command. That made me go back to the [source](https://github.com/openai/codex/tree/rust-v0.162.0) again. OpenAI's code helped a lot here because the implementation made the architecture pretty obvious: those plugins are exposed through a hosted MCP server called:

```text
codex_apps
```

OpenAI seems to use the word "connectors" in parts of the code, but from the agent's perspective they behave like hosted Tools attached to the account, and the important part is that they are reachable through the same ChatGPT-authenticated control plane.

At a protocol level, the flow looks like this:

```text
auth material
  -> Authorization: Bearer <access_token>
  -> ChatGPT-Account-ID: <account_id>
  -> POST /backend-api/ps/mcp or /backend-api/wham/apps
  -> initialize
  -> notifications/initialized
  -> tools/list
  -> tools/call
```

That was the moment when the bigger impact became obvious: the auth secret was not just a ticket to AI inference, it was also the agent identity for the OpenAI infrastructure. So I built `plugout`. If `pickpocket` is the tool that steals the agent identity, `plugout` is one tool that helps you figure out what the identity can reach. Its job is to talk directly to the hosted `codex_apps` MCP service, enumerate the available connectors, list their tools, and invoke them without needing to launch Codex itself.

That is where the whole thing kicks into third gear, because once you have that token you are no longer just asking:

```text
Can I run a prompt?
```

You are asking:

```text
Can I access the same tools as the agent?
Can I read Slack messages?
Can I send one?
Can I search Gmail?
Can I fetch a Google Drive file?
Can I read an Outlook email?
Can I pull a SharePoint document?
Can I search GitHub?
```

And depending on what the victim connected to the agent, the answer may be yes. That is what makes this interesting from a security perspective. People tend to think about ChatGPT account compromise in terms of free tokens and chat history. That's already bad, but if the same account can reach connected services through a hosted MCP service, then the blast radius is bigger than "somebody used my model credits".

Now the account can become a side door into company systems: you don't need the corporate VPN if `chatgpt.com` will proxy actions for you, you don't need a local Outlook session if the connector is already there, you don't need the Slack `xoxc-...` token if the tool call already works, you're just living off the agent...

`pickpocket` showed that moving a secret into Keychain does not help much if the trusted application is still willing to hand it back. Then `plugout` showed that the agents' tools are more powerful and exposed than they first appear.

There is a whole new ecosystem being built to make AI agents' lives easier. Nothing says only agents get to use it, and that lesson matters more than the credential-storage bug itself.

The old mental model was:

```text
steal auth token
  -> abuse AI account
```

The more accurate model is:

```text
steal auth token
  -> abuse AI account
  -> enumerate connected tools
  -> reach into other systems
```

For defenders, I think the practical takeaway is that Codex auth material should be treated like a high-value enterprise credential, not just an AI token. At a minimum, I would want visibility into:

- which users still have file-backed `~/.codex/auth.json`
- where Codex app-server listeners are being started
- whether local token-returning APIs like `getAuthStatus` are being invoked
- which users have connectors enabled
- which connectors expose sensitive read or write capabilities into systems like Slack, Google Drive, Outlook, or SharePoint

People keep talking about ChatGPT like it is only where prompts go in and answers come out. Its more than that. Once that em dash factory is wired into Slack, Gmail, Google Drive, Outlook, SharePoint, GitHub, and the rest of your digital life, it becomes a side door, and a skeleton key at the same time. If one token already has paths into five other systems, an attacker does not need five break-ins, they just need the one key that opens the whole hallway. The blast radius is not the agent. The blast radius is the graph of systems behind it.
