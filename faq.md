# Freebuff — Support FAQ

A compiled reference from the Discord support forum. Covers common issues, team contacts, and how-to guides for Freebuff Desktop, Web, and Cloud.

---

## Getting Help — Who to Contact

| Contact | Handles |
|---|---|
| **@V** | Admin/email/subscriptions, refunds/triage, web/cloud |
| **@Harsh** | Web/cloud |
| **@Obada** | Desktop/CLI |
| **@Victor** | Serious issues, outages |
| **@Sam**, **@John Park** | Desktop UI |
| **James** | Not currently taking requests |

**Community helpers** (community-run web/admin support, not core team):
- One helper has basic web/admin access and deep experience with Cloud/Web projects.
- Another has basic web/admin access and can help with the server bot.
- Additional helpers are experienced across Desktop, CLI, and Web setup.

**Discord server issues:** ping the moderator role for rule violations, or the support role for roles/permissions/channel issues.

**Before DMing staff, please have ready:**
- Your GitHub username (for account issues)
- Your project link (for web/cloud issues — see [Getting Your Project URL](#getting-your-project-url))
- Your app version

⚠️ **Do not post your email in public chat.** Always DM it to staff directly.

---

## Network Issues

**Symptoms:** "no internet," timeouts, "can't use Freebuff on this network," proxy traffic errors, dynamic IP blocks.

1. Change your DNS to Google (`8.8.8.8`) or Cloudflare (`1.1.1.1`).
2. Check whether antivirus/firewall is blocking `freebuff.exe` / `bun.exe` — add an exception.
3. Disable any TUN/VPN adapter that might interfere.
4. Try a different network (mobile hotspot, different ISP).
5. If still unresolved, use [Cloudflare WARP](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/download/) — this is explicitly allowed since it doesn't mask your actual location like a VPN does.
6. Use [Portmaster](https://github.com/RichardFlp/portmaster) to detect and kill any shadow-running VPN/proxy process.
7. If your ISP uses dynamic IPs that keep getting flagged, you can contact them to request a static IP.

---

## Freebucks (Currency) & Daily Limits

**Limited access regions:** 25 Freebucks/day.

**Full access regions:**

| Region | Daily Freebucks |
|---|---|
| US | 100 |
| CA, GB, AU, NZ, IE, NO, SE, DK, FI, NL, AT, LU, IS | 70 |
| DE, FR, ES, IT, PT, BE, CH, LI, MT, KR | 40 |

**Plan bonuses:**
- **Starter + limited access:** 105 Freebucks/day + 300 wallet/month
- **Starter + full access:** 150 Freebucks/day + 300 wallet/month
- **Plus plan:** ~250 Freebucks/day + 400 wallet/month
- **Pro plan:** 350 (limited) or 400 (full) Freebucks/day + 800 wallet/month
- **7-day login streak:** +15 Freebucks/day added to your wallet

**Other notes:**
- Daily Freebucks refill at midnight in your reset timezone.
- Unused daily Freebucks do **not** carry over.
- Your daily pool is spent before your wallet balance.
- Buying any paid plan unlocks all available models (subject to change).
- Freebucks amounts depend on ad revenue and may change over time.
- Annual plans can be paid with crypto.

---

## Freebucks Refunds

- **Daily Freebucks:** no manual refunds, except with higher-staff approval.
- **Wallet Freebucks:** refunds are subject to approval.
- **Subscriptions:** refunds are subject to approval.

**To request a refund:** DM @Victor with your email and reason for the refund.

---

## Agent System & Best Practices

The community shares custom agent configurations that others can fork freely — useful for people newer to coding or using Freebuff without heavy customization.

One shared best-practice file, `VOWS.md`, helps prevent agents from getting stuck in long thinking loops or going off-script:

```
### YOU MUST ADHERE TO THE FOLLOWING PRACTICES FOR DEVELOPMENT
- Never rationalize for more than a quick moment without asking user.
- Never attempt shortcuts.
- Never hallucinate, assume, or decide without asking user for consent.
- Never create scaffolds/mock/boilerplates/AI Slop/or underbuild.
- Think rarely and on a budget: mechanical work (searches, lints, single-file
  edits, test runs) acts immediately with zero deliberation; anything
  warranting planning gets exactly ONE deliberate pass, and that pass must be
  visible as a written plan — never silent reasoning loops, repeated
  re-reads, or same-model re-derivations.
- Gather ALL context first, then plan with the best reasoning path available:
  start file-picker + code-searcher in parallel, read every file the change
  touches (symbols, current behavior, conventions, tests), and produce a
  solid build plan (goal → files to touch with why → change list → risks →
  validation) — via a Thinker agent when available, otherwise by planning
  directly with an adversarial review before the plan reaches the user.
- Must ask the user if they approve of the build plan before implementing.
- Docstrings can be NO LONGER than 1 or 2 sentences.

### BUILD PROTOCOL
Mechanical work acts immediately. Anything warranting a plan gets exactly one
deliberate, context-complete planning pass; that plan is shown for approval
before the first edit, then implementation proceeds only on approval, and is
validated and reviewed afterward.
```

**Tip:** Avoid MAX/High reasoning settings if you want faster responses — lower the thinking/reasoning level on models when you don't need deep reasoning.

---

## Using Freebuff Cloud

1. Connect Freebuff to your GitHub account (you may need to install the Freebuff GitHub app) and select the repo you want, granting read/write access.
2. In Freebuff, select your repository and connect to it.
3. Ask your agent (e.g. "Pull from GitHub and align the project for compatibility with your environment").
4. Wait for it to finish syncing, then ask it to verify the live preview.
5. Test your site in the preview panel and iterate as needed.
6. Click **Deploy** when satisfied — Freebuff runs a soft compatibility scan (Vite/React projects are supported). You may need to paste error messages back to your agent to resolve deploy issues.
7. Choose a Freebuff-supplied domain, or bring your own (point your registrar's DNS to Freebuff; propagation can take 24–48 hours).

See also: [Exporting Code & Migrating Your Database](#exporting-code--migrating-your-database) for self-hosting afterward.

---

## Mission Mode

Freebuff's analogue to a `/goal` command. You set a goal, and a separate judge model (same model you picked, different context) monitors your agent's session.

When the agent stops on its own — not due to error or session end, including stopping after saying something like "I've done this so far..." — the judge model can:
- Write the next prompt on your behalf
- Select any loaded skill
- Stop the session if the agent needs you, or if the goal has been archived

You can browse and select from saved mission presets; pressing Enter while typing a mission autosaves it into that list.

⚠️ Mission mode currently has known issues after desktop updates — check the pinned help thread for status.

---

## Bans & False Positives

There have been a number of false-positive bans related to proxy usage.

**If you're affected:**
1. Create a help thread first (don't post your email publicly).
2. Then DM a moderator (Stress, Nicko, V, or Electro) your email — or just your GitHub username if it's synced to your account, so staff can track it properly.

---

## MCP Server Setup (Beta)

Example workflow for connecting a custom MCP server tool (e.g. a Godot MCP server) to Freebuff:

1. Build/obtain your MCP server script.
2. In Freebuff, go to **Settings → Connectors**. You'll see ready-made presets plus a custom option.
3. Paste the MCP config block, using the full path to your server file:

```json
{
  "mcpServers": {
    "godot": {
      "command": "python",
      "args": ["/full/path/to/mcpserver/godot_mcp/server.py"]
    }
  }
}
```

4. The new server will initially show as "not ready" (yellow) until tools are enabled.
5. Enable the specific tools you want the agent to use.
6. Run your server script — note that as of this writing there's no way to edit a custom connector after creation; you'll need to delete and recreate it if changes are needed.
7. Once running, select which tools to expose to the agent.

**Known quirks:**
- Some servers don't launch reliably on a cold start.
- Some MCP servers require an external app to be running first (e.g. Unity, Blender) before they'll connect successfully.

---

## Installation Paths

**Windows — Freebuff Desktop install location:**
```
~\AppData\Local\Programs\@codebufffreebuff-desktop
```
(`~` = your Windows username's home folder)

---

## Cloud Archiving Issues

Cloud projects may occasionally get stuck in an "Archiving" state — this is a known, ongoing issue being worked on with the infrastructure provider (Daytona). If it happens to you, avoid spending model usage retrying on a stuck project; just wait it out, or share your project URL in a help thread for staff visibility.

---

## Opening a Project (Desktop)

The "Open project" button location is covered in a video guide pinned in the general channel — check there if you can't find it in the UI.

---

## About Requesting Models

There's a limit on cache-hit pricing to be aware of — check the pinned reference screenshot before suggesting a new model be added to Freebuff.

---

## Getting Your Project URL

There's no "share" button, so you'll need to copy the URL manually:

1. Open your Freebuff web/cloud project.
2. Copy the address bar URL — it will look like `https://freebuff.com/{web/cloud}/project/{random-words}` or `https://{random-words}.freebuff.com`.
3. Paste it into the chat.

**Tip:** Include your project URL directly in your help ticket when you open one — it saves a round trip.

---

## Exporting Code & Migrating Your Database

**1. Getting your code (frontend + Convex functions):**
Connect GitHub from your project (top right → GitHub). Freebuff pushes your full repo, including the `convex/` folder (schema, queries, mutations, actions). Clone it or download a ZIP from GitHub — that's your complete source.

**2. Migrating your Convex backend to your own account:**
In the project's **Database** tab, click **Migrate to Self-Hosted Convex**. This will:
- Prompt you to log into Convex via OAuth (create a free account at convex.dev first if needed)
- Create a new Convex project under your account
- Copy all your data (dev + prod) to it
- Point your project at the new deployment

⚠️ This is a one-way migration, and your app will pause briefly during the copy. Afterward, your data lives in your own Convex dashboard, not with Freebuff.

**3. Just want a data export?**
In the same Database tab, use **Download backup** and choose Dev or Prod. This produces a standard Convex export zip you can import into any Convex deployment with `npx convex import`.

**Self-hosting the frontend after migrating:**
Clone the repo, set your Convex environment variables (`CONVEX_DEPLOYMENT` / `VITE_CONVEX_URL`, or whatever your `.env.example` names), run `npx convex deploy`, then host the frontend anywhere (Vercel, Netlify, etc).

---

## Crash on Start / Updating

1. Make sure you're on the latest version.
2. Try a manual update (see below).
3. Try the "Older PC" install option from the Freebuff Desktop download page if the standard build won't launch.

**Manual update — Desktop:**
Reinstalling over the previous version usually works without uninstalling first. Download the latest installer (or the "For older PC" variant if you have trouble).

**Manual update — CLI:**
Freebuff usually auto-updates when you run `freebuff`. If not, in order:
```bash
freebuff -v
npm i -g freebuff@latest
```
If that still doesn't resolve it, uninstall first:
```bash
npm uninstall freebuff
npm i -g freebuff@latest
```

If the issue persists after all of this, open a help ticket.

---

## Freebuff Mobile

There's no official iOS/Android app yet. In the meantime, a community-built tool ("Freebuff Gate") lets you remote-control your Desktop instance from your phone using Tailscale.

---

## Session / Context Recovery

Every session is logged locally on your device, so previous conversations are always recoverable even after a crash or restart.

**Log locations:**
- **CLI:** `~/.config/manicode/projects/{PROJECT_FOLDERNAME}/chats/{DATE-TIME}/log.jsonl`
- **Desktop:** `~/.config/freebuff-desktop/projects/<project-slug>/desktop-v2.db`

**For advanced/automated recovery:** a community-shared skill file exists that lets an agent search these local databases directly — including recovering answers to interactive prompts that got interrupted by a crash — instead of asking you to repeat yourself. It documents the database schema, safe (read-only) query patterns, and where crash logs live (`orchestrator-stderr.log`). If you want the full technical file, it's available as a separate reference doc.

---

## Repository Submission Program

- If your submitted repo isn't rewarded on first review, you can improve it and resubmit — each submission gets its own independent review.
- If a repo **has** been rewarded, it can't earn a second reward. Rewards are tracked by GitHub repository ID, so renaming the repo or submitting from a different account doesn't create a "new" repo in the system.
- You can't have two evaluations of the same repo in flight at once — wait for a decision before resubmitting.
- A substantially different project in a new repository counts as a new submission and is eligible independently.
- Please don't create duplicate repos with the same content just to get a second review.

---

## Known Bugs & Status Notes

- **`⚠️ request body over 16777216 bytes`** — Restart the app, then try a manual update. If it persists, open a help ticket. *(Marked fixed as of the latest update.)*
- **Freebuff needs a refill** — occasionally Freebuff runs out of upstream provider usage; this is on the Freebuff side, not your account. Just wait — your project won't be affected.

---

# Official Documentation (codebuff.com/docs)

Freebuff runs on the same underlying engine as **Codebuff**, the company's CLI coding agent — this section pulls in the official docs, which are written from the CLI/developer angle. It's a useful deeper reference alongside the community answers above.

> Not covered below: the full agent-customization docs (Agents Overview, Customizing Agents, Creating New Agents, Agent Reference, Troubleshooting Agent Customization) and the walkthroughs/case studies. Those are aimed at people building their own custom agents rather than day-to-day use — let me know if you'd like those folded in too.

## Quick Start

1. **Install:** `npm install -g codebuff`
2. **Go to your project folder:** `cd /path/to/your-repo`
3. **Run it:** `codebuff`
4. **Optional — initialize your project:** run `/init` inside the CLI to auto-generate a `knowledge.md` file describing your codebase (build commands, structure, conventions). Also the first step if you plan to build custom agents.

**If it won't start:** confirm [Node.js](https://nodejs.org/en/download) is installed, or try deleting the cached binary at `~/.config/manicode/codebuff` and restarting.

## Official FAQ Highlights

- **What's it for?** Writing features, tests, and scripts; running CLI commands; adjusting build configs; reviewing code; and answering questions about your repo.
- **Which models power it?** The orchestrator runs Claude Opus in Default/Max modes, or a lighter GPT model in Lite mode. Subagents are matched to their job — heavier reasoning models for code review and complex reasoning, lightweight fast models for terminal commands, file discovery, and web/docs lookups.
- **Connecting a personal Claude subscription:** this integration is being phased out (removal was announced for March 1st) after reports of at least one user's Anthropic account getting disabled from heavy use through Codebuff. A native Codebuff subscription is the recommended path instead, since it includes its own usage limits without touching an external account.
- **Is it open source?** Yes, under Apache 2.0, on [GitHub](https://github.com/CodebuffAI/codebuff).
- **Full terminal access safety:** if you want isolation rather than giving it direct access to your machine, there's a community-maintained [Dockerfile](https://github.com/CodebuffAI/codebuff-community/tree/main/utils/docker) to run it against a sandboxed copy of your code.
- **Custom instructions:** add a `knowledge.md` file (or `AGENTS.md` / `CLAUDE.md`, checked in that priority order per directory) to describe conventions, constraints, and commands. It'll also read a home-directory version (`~/.knowledge.md`, `~/.AGENTS.md`, or `~/.CLAUDE.md`, case-insensitive) for preferences that should apply across every project.
- **Ignoring files:** it respects `.gitignore` automatically, and you can add a `.codebuffignore` for anything extra. `.codebuffignore` supports the same negation syntax as `.gitignore` (prefix with `!`) if you want it to read something Git itself ignores.
- **How it works, in short:** several specialized models run in parallel — one locates files, one reasons through the problem, one writes the code, one reviews it — and a selector picks the best combined result. Max mode runs multiple competing implementations at once.
- **Vs. Claude Code:** positioned as faster and cheaper per task, with an architecture built to handle large codebases without reading files one at a time.
- **More questions:** support@codebuff.com, or the [Discord](https://codebuff.com/discord).

## Modes

Switch anytime with `Shift+Tab` or a `/mode:` command.

| Mode | Model | Runs Code Review | Notes |
|---|---|---|---|
| **Default** (`/mode:default`) | Claude Opus | Yes | Gathers context via file-picker/code-searcher subagents, edits with a single editor agent, validates with typechecks/tests. |
| **Max** (`/mode:max`) | Claude Opus | Yes | Reads far more files per task, runs several editor agents in parallel with different strategies, and a selector picks the best output. Best for complex features/refactors. |
| **Plan** (`/mode:plan`) | Claude Opus | No | Makes no file changes — gathers context, asks clarifying questions, and outputs a spec/plan you can review before anything is implemented. |
| **Lite** (`/mode:lite`) | A lighter GPT model | Yes | Cheaper and faster, geared at routine coding tasks. |

## Knowledge Files

`knowledge.md` gives the agent context that isn't obvious from the code itself — conventions, architecture rationale, gotchas, build/verification commands.

- **Auto-generate:** run `/init` inside the CLI.
- **Manual:** create `knowledge.md` yourself, or ask the agent to write one for you.
- **Larger projects:** add extra `knowledge.md` files inside relevant subdirectories (e.g. `backend/knowledge.md`, `frontend/knowledge.md`) — keep each one next to the code it documents. A few hundred lines is a reasonable size.
- **Global preferences:** a home-directory file (`~/.knowledge.md` highest priority, then `~/.AGENTS.md`, then `~/.CLAUDE.md`) applies across every project — useful for personal style preferences (e.g. "prefer TypeScript," "keep explanations concise"). Project-level and home-level files are both loaded; the project file can override the home one.
- **Verification commands:** you can list commands you want run after every change (e.g. typecheck, test suite) and the agent will run them automatically post-edit.

## MCP Servers

MCP (Model Context Protocol) lets the agent connect to external tools and data sources — APIs, databases, services like Notion or GitHub.

**Quick setup:** create `.agents/mcp.json` in your project with your server config, set any required environment variables, and restart the CLI. Example for a Notion connector:

```json
{
  "mcpServers": {
    "notionApi": {
      "command": "npx",
      "args": ["-y", "@notionhq/notion-mcp-server"],
      "env": { "NOTION_TOKEN": "$NOTION_TOKEN" }
    }
  }
}
```

**Search order** (later overrides earlier): project `.agents/mcp.json` → parent directory's (useful in monorepos) → global `~/.agents/mcp.json`.

**Server types supported:**
- **stdio** (local process) — needs `command` and `args`, optionally `env`.
- **http** or **sse** (remote) — needs a `url`, optionally `headers` and `params`.

Reference environment variables in config with `$VAR_NAME` syntax. Browse available community servers via the [official MCP registry](https://github.com/modelcontextprotocol/servers) or by searching `mcp-server` on npm.

**Common issues:** invalid JSON in `mcp.json` (check for trailing commas), file in the wrong location, forgetting to restart after editing config, or a missing/typo'd environment variable.

## Skills

Skills are reusable, on-demand instruction sets — each one becomes a `/skill:name` slash command, and the agent can also load one automatically when it decides it's relevant.

**Structure:** each skill lives in its own folder with a `SKILL.md` file containing YAML frontmatter (`name`, `description`, optional `metadata`) followed by the instructions.

**Naming rules:** lowercase letters, numbers, and hyphens only; 1–64 characters; can't start/end with a hyphen or use consecutive hyphens; must match the folder name exactly.

**Where skills are loaded from** (later overrides earlier):
1. `~/.claude/skills/` — global, Claude Code–compatible
2. `~/.agents/skills/` — global
3. `.claude/skills/` — project, Claude Code–compatible
4. `.agents/skills/` — project (highest priority)

**Best practices:** keep each skill narrowly scoped to one purpose rather than one giant catch-all skill, write a specific description (since that's what the agent uses to judge relevance), and use `metadata` fields for extra categorization.

**If a skill isn't showing up:** double check the folder path, confirm the frontmatter `name` matches the directory name exactly, verify the YAML frontmatter is well-formed, and restart the CLI to force a reload.

## What Makes It Different (per the vendor)

Per the official docs, the main differentiators claimed are:

- **Speed:** benchmarked as noticeably faster than Claude Code on comparable tasks, attributed to parallel subagents and reading related files together rather than one at a time.
- **Tree-based file discovery:** the codebase is parsed into a compact symbol tree up front, which a fast model scans to shortlist relevant files before the main agent starts working — instead of exploring the repo interactively.
- **Parallel multi-strategy editing (Max mode):** multiple editor agents attempt the same task differently at once, and a selector agent picks (or blends) the best result, reusing a shared prompt cache to keep the cost down.
- **Automatic code review:** every change gets reviewed (and, in Max mode, reviewed from multiple angles) before it's shown to you.
- **Invisible context management:** long sessions get automatically and non-lossily summarized in the background rather than surfacing a raw "% context used" meter for you to manage yourself.
- **Open agent framework:** agents are composable, can be nested arbitrarily (spawning agents that spawn further agents), and the whole framework is open source.
- **Ad-revenue credits:** optional ads above the input box earn usage credits, toggleable in settings.
- **No confirmation prompts:** it acts on requests directly rather than pausing for "are you sure?" dialogs.

## How It Actually Works

The main orchestrating agent ("Buffy") reads your prompt, gathers context, and delegates to specialized subagents:

- **File Picker** — locates relevant files
- **Code Searcher** — grep-style pattern matching
- **Researcher** — web and documentation lookup
- **Thinker** — works through harder reasoning problems
- **Editor** — writes and modifies code
- **Reviewer** — checks for bugs and style issues
- **Basher** — runs terminal commands

**Pipeline:** the codebase is scanned into a code map → file pickers/searchers find relevant code → thinkers analyze if needed → editors generate changes → reviewers and test-runners check the result. Edits and commands run locally; relevant prompts, code, and repo context are sent to Freebuff and the underlying model providers (see Privacy below).

## Working with Large Codebases

- **Scope the working directory:** run the CLI from the specific subfolder you're working in (`cd backend && codebuff`), or pass `--cwd backend`, to keep context tight.
- **Distribute knowledge files:** for large trees, put a `knowledge.md` in each major subdirectory rather than one giant root file, and use the root file only for cross-cutting notes.
- **Communicate precisely:** point to exact file paths, mention related files up front, and break large changes into smaller requests rather than one sweeping one.
- **Reduce noise:** use `.codebuffignore`/`.gitignore` to keep irrelevant files out of context, and let the agent's own file discovery work rather than pasting long file lists yourself.

## Troubleshooting (Official)

- **No `npm`:** [install Node.js](https://nodejs.org/en/download) first.
- **General weirdness:** delete the cached binary at `~/.config/manicode` and restart — this resolves a lot of one-off issues.
- **Check your version:** `codebuff --version`. It should auto-update; if not, try the fixes below.
- **Install permission errors:** on Mac/Linux, take ownership of the relevant directory (`sudo chown -R $(whoami) <directory>`); on Windows, `takeown /F <directory> /R /D Y`. If that doesn't help, reinstall Node via nvm or fnm and retry.
- **Chat history location:** stored locally at `~/.config/manicode/projects/<project-name>/chats`. Worth attaching when asking for support.
- **Endless auto-update loop:** usually caused by conflicting Node/npm installs (e.g. both Homebrew and nvm present). Run `which node` / `which npm` — if they point to a Homebrew path instead of nvm, uninstall Node from Homebrew (`brew uninstall node`) and let nvm take over.
- **"Command not found":** confirm it installed globally (`npm install -g codebuff`), and that npm's global bin directory is on your `PATH`.
- **`ENOTEMPTY` install error:** delete the stray `.codebuff-<hash>` folder it mentions inside `node_modules` and reinstall.
- **Automating via tmux:** plain `tmux send-keys` drops characters. Wrap the input in bracketed-paste escape sequences (`\e[200~...\e[201~`) so it's delivered as a single paste rather than character-by-character.
- **Still stuck:** open a [GitHub issue](https://github.com/CodebuffAI/codebuff/issues), ask in Discord, or email support@codebuff.com (replies can take a few days).

## SDK & Programmatic Access

For running agents from your own code rather than the CLI, via `@codebuff/sdk`:

- **Install:** `npm install @codebuff/sdk`. Requires an API key from your Codebuff account settings.
- **Basic run:** instantiate a `CodebuffClient` with your API key and working directory, then call `.run()` with an agent ID and a prompt.
- **Continuing a conversation:** pass the prior run's result back in as `previousRun` to keep context across calls.
- **Custom agents & tools:** you can define your own agent (model, tool list, system prompt) and even register custom tool functions (e.g. a tool that hits an external API) for the agent to call.
- **Typical use cases:** CI/CD code review, batch processing across many files, editor/VS Code extensions, and general scripted automation.
- **Key `run()` options:** `agent`, `prompt`, `previousRun`, `projectFiles` (extra file context), `knowledgeFiles`, custom `agentDefinitions`, `customToolDefinitions`, and `maxAgentSteps` (default ~20).
- Full reference and more examples (GitHub Actions review pipelines, test generation, refactor scripts) are in the official SDK docs.

## Privacy

*(This applies company-wide to both Codebuff and Freebuff.)*

- Prompts, messages, agent traces, code, files, and repository data are used to provide the service, and may be analyzed to personalize ads.
- Separately uploaded files or connected repositories are **not** shared with advertising providers.
- Select partners may evaluate connected Cloud repositories under contract, but can't otherwise broadly use, share, or train on them.
- Data is only used to train AI models when a specific model or feature discloses that upfront.
- Full details live in the [Privacy Policy](https://freebuff.com/privacy-policy); privacy questions can go to support@codebuff.com.
