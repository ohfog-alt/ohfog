---
title: "Living Off the Agent Pt1: Repurposing ChatGPT and Codex for Command and Control"
date: 2026-10-09 14:01:51 -0400
tags: [codex, remote-control, command-and-control, ai-agents]
excerpt: "Repurposing Codex remote control and ChatGPT infrastructure as command and control."
toc: true
---
Responsible disclosure and intended use: Before publishing this research, I disclosed the security issues discussed here through OpenAI’s formal reporting channels and made repeated attempts over several months to engage on remediation. The accompanying [ratGPT](https://github.com/ohfog-alt/ratGPT) and [Codex Bridge](https://github.com/ohfog-alt/codex-bridge) tools are proofs of concept, provided as-is for educational and defensive research, not production tooling. I am releasing them so the public can independently understand the risk, examine the evidence, and take informed precautions. Use them only with accounts and systems you own or are explicitly authorized to test.

Hello neighbor, I hope you find this post helpful and have as much fun reading it as I had researching and writing it.

This whole research journey started in a pretty ordinary way: I installed the ChatGPT app on my phone and noticed a tab called `Remote`. That got my attention, so I started poking at the feature to understand what it actually did. The basic idea was easy enough to grasp: leave a machine online somewhere, connect to it from another device with the mobile or desktop app, and keep working against the files, shell, and tools on the original host.

What bothered me was what seemed to be missing. In the Codex TUI, I can use the `!` character to enter Shell mode:

```text
! id
```

That gives me a direct shell escape hatch, but when I tried to enter Shell mode on my phone, I did not see a clear way to do the same thing. I work far more from my laptop than from my phone, so my brain immediately went to a different question: **could I use the Codex CLI on one machine to drive another Codex instance over the Internet?**

The answer was not straightforward. Codex CLI does have a native remote mode, but the obvious path is local-network oriented. You can try the basic version yourself in two terminals: start an app-server websocket listener, then point another Codex client at it.

```
# Terminal 1
codex app-server --listen ws://127.0.0.1:4500

# Terminal 2
codex --remote ws://127.0.0.1:4500
```
 That works on `localhost`, or over a LAN when the listener is exposed on a reachable interface. What it does not provide by itself is the Internet reachability available through the desktop and mobile apps and that did not make sense to me. **Why would OpenAI build one remote-control protocol for local networks and a completely different one for the Internet?** A more plausible explanation was that both experiences used the same Codex app-server protocol underneath, with additional authentication and relay machinery for Internet reachability.

Fortunately, OpenAI publishes the Codex CLI source, so I could move from guessing to reading and experimenting. The source confirmed the important part of my hypothesis: remote control is not a "just a tunnel" for the terminal. A remote session passes through several stages involving management APIs, websockets, delivery envelopes, and app-server JSON-RPC messages.

For those who wan't to follow along at home, leave the listener from the previous example running, install `websockets`, and run:

```
import asyncio
import json

import websockets


async def main():
    async with websockets.connect("ws://127.0.0.1:4500") as ws:
        async def call(request_id, method, params):
            await ws.send(json.dumps({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params,
            }))
            while True:
                message = json.loads(await ws.recv())
                if message.get("id") == request_id:
                    if "error" in message:
                        raise RuntimeError(message["error"])
                    return message["result"]

        await call(1, "initialize", {
            "clientInfo": {
                "name": "local-shell-demo",
                "version": "0.1.0",
            },
            "capabilities": {"experimentalApi": True},
        })
        await ws.send(json.dumps({
            "jsonrpc": "2.0",
            "method": "initialized",
        }))

        thread = (await call(2, "thread/start", {}))["thread"]["id"]

        await ws.send(json.dumps({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "thread/shellCommand",
            "params": {
                "threadId": thread,
                "command": "id",
            },
        }))

        while True:
            message = json.loads(await ws.recv())
            print(json.dumps(message, indent=2))
            if message.get("id") == 3 and "error" in message:
                raise RuntimeError(message["error"])
            if message.get("method") == "turn/completed":
                break


asyncio.run(main())
```

## Peeling Back Remote Control

If I was going to somehow get Codex to remote control another instance of Codex over the Internet, I needed to understand how a command crossed that stack. At a high level, a remote session unfolds in stages: the host and controller authenticate to ChatGPT, enroll in their separate roles, and receive the identities and short-lived tokens they need for remote control. The controller then discovers the enrolled environment, both sides establish outbound websocket connections to the Internet relay, and the controller opens a logical stream by sending an app-server JSON-RPC `initialize` message inside a remote-control envelope. Only after that can commands and results begin moving between them. Following that sequence made it much easier to see what each part of the system contributed.

![Codex Internet remote-control authentication, enrollment, pairing, websocket, stream, and remote-operation sequence](/assets/images/remote-control-sequence-v2.png)

### Authentication

Remote control begins with ordinary Codex account authentication, before anything is enrolled. On a workstation, `codex login` uses an interactive browser OAuth flow. For headless systems, `codex login --device-auth` displays a one-time code that the user approves in a browser while the CLI polls for completion. Codex can also accept supported access-token forms through `--with-access-token` or `CODEX_ACCESS_TOKEN`, but API-key authentication is explicitly rejected by remote control. Once a usable login exists, later Codex processes reuse that local authentication state rather than asking the user to sign in every time.

### Enrollment and Environment Discovery

Both controller and controlled Codex instances arrive with a ChatGPT identity, but the relay gives them different roles. The controlled host enrolls as a server and receives identifiers for a server and an environment, plus a short-lived remote-control token. A controller enrolls separately, proves possession of a device key, and receives its own client identity and websocket session token. The controller can then discover the environments its account is allowed to reach.

The important output looks roughly like this:

```json
{
  "server_id": "srv_example",
  "environment_id": "env_example",
  "remote_control_token": "REDACTED",
  "expires_at": "2026-..."
}
```

This is the control plane. It answers who the host is, who the controller is, and which environment connects them. It does not carry shell commands yet.

### Two WebSockets and a Relay

After enrollment, the host and controller each make an outbound websocket connection to `chatgpt.com`, but they use different endpoints:

```text
controller
  -> wss://chatgpt.com/backend-api/codex/remote/control/client

controlled host
  -> wss://chatgpt.com/backend-api/wham/remote/control/server
```

The relay joins those two connections using the enrolled account, client, server, and environment identities. This design is useful for remote work because the controlled host does not need a public address or inbound firewall rule. The same property is also useful to an attacker: the host reaches outward to a domain where the traffic may already look at home.

This is also where the resemblance to a normal websocket tunnel ends. The relay is not passing a generic byte stream. It is transporting structured remote-control messages.

### Remote-Control Envelopes

Inside the websocket, Codex uses versioned JSON envelopes for routing and delivery. A controller message includes an environment, logical client, stream identifier, and sequence number. Inside that envelope is the actual app-server message:

```json
{
  "type": "client_message",
  "client_id": "cli_example",
  "env_id": "env_example",
  "stream_id": "00000000-0000-0000-0000-000000000001",
  "seq_id": 1,
  "message": {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {}
  }
}
```

The stream starts with `initialize`, and the host creates a corresponding app-server connection. Later envelopes carry RPC requests and responses. Sequence numbers, acknowledgements, cursors, chunking, and heartbeats let the connection survive large messages and temporary network failures. Those details matter when building a reliable client, but the security lesson is simpler: the relay understands enough state to route app-server conversations, while the authority of those conversations comes from the identities established earlier.

### Codex App-Server JSON-RPC

Once the stream is initialized, the remote side reaches the same structured interface that powers Codex itself. Shell mode, activated with `!`, becomes a `thread/shellCommand` request rather than shell bytes written to a terminal. For example `! id` would look like this:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "thread/shellCommand",
  "params": {
    "threadId": "thread_example",
    "command": "id"
  }
}
```

Responses and command output travel back inside `server_message` envelopes. There are other RPCs for running commands, controlling processes, and reading or writing files, including `command/exec`, `process/spawn`, `process/writeStdin`, `fs/readFile`, and `fs/writeFile`. Some lower-level methods depend on feature gates and the current app-server version, but the remote-control transport itself carries the app-server protocol rather than a small set of UI-specific actions.

Put together, the path is:

```text
controller app-server JSON-RPC
  -> remote-control envelope
  -> controller websocket
  -> ChatGPT relay
  -> host websocket
  -> host app-server
  -> local shell, process, or file operation
```

That was the missing piece. Local CLI control and Internet remote control were not separate worlds. They were two ways to reach the same interface.

## Bridging the Missing Controller

Once I understood the stack, I built a helper called `codex-bridge`:

```text
local Codex CLI/TUI
  -> codex-bridge
  -> ChatGPT remote-control relay
  -> remote Codex host
```

From the local CLI side, it looked like I was connecting to a websocket on localhost:

```text
codex --remote ws://127.0.0.1:4747
```

`codex-bridge` took the app-server JSON-RPC messages from the local client, placed them inside the remote-control envelopes, and sent them through the Internet relay to the selected host. It handled the identity, stream, sequence, acknowledgement, and reconnection details that the official desktop controller normally manages.

That worked! One Codex CLI could control another Codex host over the Internet, confirming that the feature was already there; the missing piece was a controller that exposed it to the CLI.

That would have been a satisfying ending, but my red-teamian brain was not done yet.

## When Remote Work Starts Looking Like Remote Access

**I had noticed earlier that remote control worked with a free account**: no credit card and no paid subscription. That led me to a practical question. **If OpenAI charges for model inference, what happens when I send a shell command instead of a prompt?**

So I tested it. A normal prompt generated a token-usage update, while `thread/shellCommand` completed without one. The command output can become part of a later conversation context, so a future model turn may consume tokens while processing it, but the command itself is local execution rather than inference.

That changed the shape of the feature for me. If a remote-control channel can deliver commands over a first-party relay without asking for money, then this is not only remote Codex UX: it starts to look like a command and control channel.

I had seen similar patterns before while turning other developer tools, including [VS Code](https://badoption.eu/blog/2023/01/31/code_c2.html), into command-and-control channels. Once a legitimate remote-development feature combines outbound connectivity, a trusted domain, and a trusted executable, it becomes interesting from a red-team perspective too.

The big hurdle on the controlled side was authentication. A victim-side Codex instance would need to come online under an account that I controlled. As I mentioned before, Codex supports different login paths, but file-backed installations eventually store reusable auth material in:

```text
~/.codex/auth.json
```

That led to my next experiment: **could I prepare the auth material on another machine, place it beside the [standalone Codex package](https://releases.openai.com/codex/install.sh) in an isolated Codex home separate from `~/.codex`, and start a remotely controllable host without an interactive login on that host?**

In my original lab, the answer was yes. Codex 0.140.0 could authenticate and create a remotely controllable host from an isolated Codex home containing only a pre-generated `auth.json`, the Codex executable, and a small startup wrapper. Run that bundle on a host and it made an outbound connection to `chatgpt.com`, using OpenAI software and an account I controlled.

That changed while I was preparing to publish. During my Codex 0.160.0 retest, a freshly enrolled controller could authenticate to the same account, discover the online host, and send an initialize request all the way to its app-server, but the response was `Remote environment is not paired for this client`. Account access was no longer the whole authorization decision. The service now kept the controller and controlled host as separate logical identities and required an explicit relationship between them:

```text
attacker account
├── controller identity: cli_...
└── controlled identity: srv_... / env_...

cli_... --allowed-to-control--> srv_... / env_...
```

That relationship is created when:

1. The controlled server requests a short-lived pairing code using its server credential.
2. The controller submits that code together with its own `client_id`.
3. The backend records the pairing.
4. Future app-server streams from that controller to that environment are admitted.

This is a real authorization boundary, it is not, however, a machine-bound identity. I could create and pair the controlled identity while building the payload, then bundle its `installation_id` and persisted `state_5.sqlite` enrollment alongside `auth.json` and Codex. When that bundle ran somewhere else, it refreshed the server connection as the already-authorized host. No code had to come back from the controlled machine and no short-lived remote-control token had to be stored in the payload.

That is what led me to build `ratGPT`.

## ratGPT

At first, `ratGPT` was a way to make the expensive path harder to get wrong manually. I wanted an attacker-side tool that treated everything as a command and never risked sending a prompt because I forgot the `!` character.

As I continued exploring app-server, I realized that the one-shot shell RPC was only the beginning. There were other RPCs available too:

```text
command/exec
process/spawn
process/writeStdin
fs/readFile
fs/writeFile
```

Process and file operations make a much more capable controller possible. Once I could start processes, keep stdin attached, and move files, I was no longer simulating a shell escape hatch; I got myself a real C2 framework.

`ratGPT` became a proof of concept for using Codex as a Remote Access Trojan. It can prepare controlled-host bundles, track enrolled hosts, issue commands, control processes, and perform file operations through capabilities Codex already exposes.

![ratGPT payload preparation, pre-authorization, deployment, relay rendezvous, and controlled-host workflow](/assets/images/ratgpt-workflow-v2.png)

The uncomfortable part is how ordinary it can look on the wire:

```text
attacker/controller --outbound--> chatgpt.com remote-control relay <--outbound-- controlled host
```

There is no inbound SSH listener, the traffic is outbound to `chatgpt.com`, the executable is legitimate OpenAI software, the remote-control feature is behaving as designed. Those are not bugs by themselves, but combined with free accounts they make a compelling Remote Access Trojan possible.

This is living off the land, specifically living off the agent.

## One more thing

I still had one question: was this risk really Codex-specific? **What if custom software replaced Codex on both ends and used only the relay?**

I tested that too. I wrote minimal clients that used the authenticated remote-control path but carried custom messages instead of app-server RPC. They exchanged data successfully. The remote-control relay could serve as a rendezvous channel for arbitrary software, even when neither endpoint was running Codex.

That experiment put the earlier stages in a different light. The app-server protocol made Codex a capable implant, but the authenticated relay was independently useful transport.

## The Harder Question for Defenders

What do you do when legitimate developer infrastructure can also be reused as remote-access infrastructure?

Blocking all of `chatgpt.com` is a blunt instrument because many organizations use ChatGPT and Codex for legitimate work. Looking only for unknown destinations, inbound listeners, or obviously malicious executables also falls short. The controlled host connects outward; the process may be a legitimate Codex binary; the protocol is real product behavior.

That leaves defenders with some difficult visibility questions:

- Which hosts have Codex remote control enabled right now?
- Which accounts enrolled them?
- Which controllers connected to them?
- Which sessions invoked shell, process, or file RPCs?

Defenders should inventory where Codex is installed and where remote use is appropriate. On hosts where interactive Codex activity is unusual, consider scrutinizing:

- secondary Codex installations or executables in unexpected locations
- isolated Codex homes or unexpected `auth.json` files
- `codex remote-control start` or app-server processes launched with `--remote-control`
- long-lived websocket connections to the two remote-control paths described above
- unusually frequent shell, process, or file operations without nearby model activity, where local telemetry makes that distinction possible

The product boundary could also be easier to govern: 
- Separate relay hostnames would let customers restrict remote control without blocking normal ChatGPT access. 
- Stronger installation or device binding would raise the cost of carrying prepared identity material to another host. 
- Dedicated audit events for enrollment, controller connections, and sensitive remote RPCs would give both customers and the platform owner something firmer than inference from fragmented endpoint and network evidence.

The broader lesson is not that the Codex agent is bad. It is that remote-control systems deserve the same scrutiny as any other access layer, especially when they arrive as signed binaries and communicate through trusted SaaS infrastructure. Give people a trusted executable, a trusted domain, and a shell over the Internet, and somebody is going to call it C2.
