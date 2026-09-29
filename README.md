# freebuff-doctor

[![npm version](https://img.shields.io/npm/v/freebuff-doctor.svg)](https://www.npmjs.com/package/freebuff-doctor)
[![node](https://img.shields.io/node/v/freebuff-doctor.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/freebuff-doctor.svg)](./LICENSE)

https://github.com/user-attachments/assets/b5a77648-8af7-434b-bef5-b1d79967ca56

**Diagnose and fix common Freebuff problems from your terminal** — without waiting on Discord support.

`freebuff-doctor` installs one command, `fbdoc`, which combines:

1. **Thirty automated checks** of your machine, network and Freebuff install.
2. **A searchable, offline FAQ** — fuzzy enough that `cant connect` still finds the Network Issues answer.
3. **A troubleshooting wizard** for when you aren't sure what's wrong.
4. **An on-demand AI assistant** — after a run, ask Groq's `gpt-oss-20b` to explain what the checks found and how to fix it (`fbdoc ask`).
5. **A copy that keeps itself current** — opening the menu checks npm and installs a newer release for you.
6. **A redacted report you can paste into Discord** — or export as a detailed `.md` file for a Freebuff helper, mod or support member.

```console
$ npm install -g freebuff-doctor
$ fbdoc
```

## Demo

```console
$ fbdoc check

Freebuff Doctor 0.6.0
───────────────────────
win32 10.0.26200 (x64) · Node v24.13.0


Needs attention · 4 of 30 checks

⚠️  Freebuff CLI installation ⏱ 374ms
   freebuff 0.0.118 is behind the latest release (0.1.2).
   › Command: ~\AppData\Roaming\npm\freebuff.CMD
   fix  npm i -g freebuff@latest
   faq  Crash on Start / Updating (fbdoc faq "Crash on Start / Updating")
   why  fbdoc explain global-install

⚠️  Shadowed commands and PATH
   Your PATH lists the same 15 directories more than once, which slows down
   every command lookup and hides stale tools.
   › Repeated PATH entry: C:\WINDOWS\system32
   › Repeated PATH entry: C:\Program Files\nodejs
   › … 13 more repeats
   faq  Troubleshooting (Official) (fbdoc faq "Troubleshooting (Official)")
   why  fbdoc explain command-shadowing

⚠️  Cached engine and downloads
   An earlier version of the engine is still cached (237 MB across 2 copies) —
   disk space an interrupted update never reclaimed.
   › Superseded engine copy: ~\.config\manicode\freebuff.exe.old.1788459782441
     (120 MB)
   › The superseded copies are not read by anything; removing them only frees
     space.
   fix  del "~\.config\manicode\*.old.*"
   faq  Crash on Start / Updating (fbdoc faq "Crash on Start / Updating")
   why  fbdoc explain cache-integrity

⚠️  Git availability and config
   git is not set up for long paths, so files nested deeper than 260 characters
   cannot be checked out or committed on Windows.
   › git version 2.52.0.windows.1
   fix  git config --global core.longpaths true
   faq  Troubleshooting (Official) (fbdoc faq "Troubleshooting (Official)")
   why  fbdoc explain git-prereqs

Everything else
• 26 checks passed
  node-runtime  ·  arch-match  ·  binary-integrity  ·  install-paths  ·
  config-health  ·  auth-session  ·  stale-lock  ·  split-state  ·
  session-logs  ·  crash-log  ·  error-triage  ·  state-growth  ·  dns  ·
  network  ·  proxy-trust  ·  tls-chain  ·  hosts-pin  ·  clock-skew  ·
  env-hygiene  ·  node-conflicts  ·  watcher-limits  ·  path-length  ·
  temp-health  ·  port-availability  ·  storage  ·  resource-limits


Freebuff Doctor
30 checks · 26 passed · 4 warnings

Next  Freebuff CLI installation: freebuff 0.0.118 is behind the latest
      release (0.1.2).
Run   npm i -g freebuff@latest
FAQ   Crash on Start / Updating
      fbdoc faq "Crash on Start / Updating"

30 checks in 1.2s on win32 10.0.26200 (x64).

→ Need detail on any check? Run `fbdoc explain <id>`.

→ Paste `fbdoc report` into a Discord help thread if you need a
second opinion.
```

Abridged for readability and privacy: the real run prints every repeated `PATH` entry, and prints your own home directory where a fix command needs it (here collapsed to `~`). Everything that needs attention comes first — in full, with the command that fixes it and the `fbdoc explain <id>` page for it — then healthy checks collapse into the id lists above. On an interactive terminal the summary is drawn in a box instead of the plain form shown here, `--all` expands every result, and `--quiet` prints only the problems.

The main menu (arrow keys, no flags to remember):

```console
$ fbdoc

Freebuff Doctor 0.6.0
win32 10.0.26200 (x64) · Node v24.13.0

? What would you like to do?
❯ Run diagnostics
  Search the FAQ
  Troubleshooting wizard
  Connect Groq API for AI assistance
  Export a report for Freebuff helpers
  Quick report (paste into Discord)
  Quit
```

### Reporting a problem

There are two report sizes, for two different audiences. Both are redacted automatically: tokens, emails, credentials and your home directory never make it into the output.

| | `fbdoc export` | `fbdoc report` |
| --- | --- | --- |
| Audience | Freebuff helpers, mods and support | A Discord `#help` message |
| Result | A `.md` file saved to your **Downloads** folder | Text printed to your terminal |
| Length | As long as it needs to be (~1200 lines) | Aimed at Discord's 2000-character limit, and warns you when it cannot fit |
| Contains | Every check with its raw data, your environment, `PATH` in search order, state directories, the engine log tail, a machine-readable copy of the results, and a section for what you have already tried | The findings, the suggested next step and the last few log lines |

```console
$ fbdoc export

✔ Exported a detailed report
  C:\Users\you\Downloads\freebuff-doctor-report-2026-09-28-153012.md
  41 KB · 1201 lines · 0 failed, 3 warnings
  → Share this file with a Freebuff helper, mod or support member — attach it to a Discord thread or paste it into an issue.
```

Pick "Export a report for Freebuff helpers" in the menu to get the same thing without remembering a flag.

Searching the FAQ from the shell:

```console
$ fbdoc faq "cant connect"

Network Issues
────────────────
Freebuff — Support FAQ

  Symptoms: "no internet," timeouts, "can't use Freebuff on this network," proxy traffic errors, dynamic IP blocks.

  1. Change your DNS to Google (8.8.8.8) or Cloudflare (1.1.1.1).
  2. Check whether antivirus/firewall is blocking freebuff.exe / bun.exe — add an exception.
  ...
```

## AI assistance (optional, Groq)

Everything else here works offline and without an account. When you would rather not wait for a second opinion, `fbdoc` can ask one: it talks to **Groq** — the one provider it supports — using the **`openai/gpt-oss-20b`** model.

```console
$ fbdoc ask "freebuff keeps telling me to update but nothing changes. what should I do?"

What the assistant has been told
──────────────────────────────
30 checks · 22 passed · 3 warnings · 0 failed · 5 skipped

⚠️  Freebuff CLI installation ⏱ 374ms
   freebuff 0.0.118 is behind the latest release (0.1.2).
   fix  npm i -g freebuff@latest
   faq  Crash on Start / Updating (fbdoc faq "Crash on Start / Updating")
   why  fbdoc explain global-install

(…every check that needs attention, in full…)

Using GROQ_API_KEY from your environment (gsk_fake…TEST).

Freebuff assistant
The warning that Freebuff is “behind the latest release” is the most likely reason it keeps prompting you to update. Update the global CLI and clean the old engine cache, then restart your terminal.
```

Abridged: the real run prints every finding the assistant was given, and then the answer. The answer is **styled as it streams** — headings become underlined titles, `**emphasis**` becomes bold, backticks become coloured code, a Markdown table becomes aligned columns with a bold header, and a fenced `cmd` block is indented without its fence markers, so you read a formatted answer rather than raw Markdown. With colour off or output piped, the markers are stripped instead of printed. The answer is about *your* machine — it names the checks, quotes their `fix` commands, and suggests the FAQ section behind each one.

Pick **Connect Groq API for AI assistance** in the menu for an interactive chat instead: same diagnostics, then as many follow-ups as you need, with `exit` to leave.

### Connecting a key

Create a free key at [console.groq.com/keys](https://console.groq.com/keys). `fbdoc` looks for it in this order:

1. `GROQ_API_KEY` in your environment.
2. The saved key at `<config root>/freebuff-doctor/groq.json`.
3. Otherwise the menu asks you to paste one in (hidden as you type) and offers to save it — the only thing `fbdoc` ever writes outside your Downloads folder, created with owner-only permissions.

```console
# For one session, nothing stored:
$ GROQ_API_KEY=gsk_... fbdoc ask "why is my install stale?"

# Or connect it once from the menu and then never think about it again:
$ fbdoc
```

Delete that `groq.json` to forget the key. It is never printed back in full, never written into a report, and the same redactor that scrubs reports catches `gsk_…` values anywhere else they might appear — including text you paste into the chat.

### What the assistant knows

The assistant is not left to guess about Freebuff. Every prompt carries the knowledge this package already ships:

- **The whole FAQ index** — every section of the bundled `faq.md`, so it knows what is covered (and never claims Freebuff is a mystery to it).
- **The sections a question is about, quoted verbatim** — the bundled search picks them, the same one `fbdoc faq` uses, so a question about a project URL gets the *Getting Your Project URL* text and a question about refunds gets *Freebucks Refunds*. Its wording is the FAQ's wording, and it is told the FAQ wins wherever its own idea of how such a tool works disagrees.
- **Every check in the catalogue** — what each one looks at and why it matters, so it can explain any finding and send you to `fbdoc explain <id>` for the rest.

That is also why it declines instead of inventing: when the FAQ does not cover something, it says so and names the closest section rather than describing a button that does not exist — and it only names sections that are really in the index, however plausible an invented title would sound.

An answer that presents a command gets read back against everything the model was given, too. A small model will occasionally reach for a command it half-remembers even with the FAQ in front of it — a real run produced `fb project list` and a `freebuff project url` that never existed — so `fbdoc ask` says which fragments the FAQ does not contain and prints the FAQ's own wording for that question underneath, rather than leaving you to paste instructions that were guessed. The same check catches the opposite failure — an answer that asks you to clarify something, or says it has no information, while the FAQ's answer to it was quoted in the very same turn. Either way the section is printed underneath, so the answer is there even when the model did not use it.

And when the FAQ answers a question outright — a matching section title, not a vague resemblance — that section is printed verbatim under the answer whether the model used it or not, because a 20b model cannot be trusted to relay the facts it was handed. You get the assistant's explanation of *your* machine, and the FAQ's own wording unaltered beside it. Questions the FAQ has nothing on get no block at all, so nothing is padded out. The section it did not quote is always one `fbdoc faq "<title>"` away, and a free Groq key is limited to 8,000 tokens a minute, so a long chat drops its oldest turns rather than failing on the fourth question.

### What leaves your machine

- **Sent to Groq:** your question, plus a redacted digest built from the diagnostics — each finding with its `fix`, its FAQ link and what the check looks at, and the environment snapshot (platform, Node, npm, `PATH` in search order). Alongside it go the bundled FAQ's section index and the sections your question is about, and the check catalogue — all public text from this package, never anything from your disk. Everything is capped in size, so a noisy machine cannot flood the request.
- **Never sent:** log files, chat transcripts, your home directory, or any token. Everything outbound goes through the same redactor the reports use, and your home path is collapsed to `~` on the way out.
- **Your choice:** `fbdoc ask --no-checks "..."` sends the question with no machine context at all, and `--only` narrows what the assistant is told.

`--offline` and the assistant are mutually exclusive — it says so and exits `1` rather than pretending to answer. Under a pipe or in CI nothing ever prompts: with no key configured, `fbdoc ask` prints how to set one and exits `1`.

## Keeping itself up to date

Opening the interactive menu checks npm for a newer release, and installs it when there is one:

```console
$ fbdoc

  freebuff-doctor 0.6.0 is available (you are on 0.5.2) — updating…
  ✔ Updated to 0.6.0. Restart fbdoc to use it.

Freebuff Doctor 0.5.2
win32 10.0.26200 (x64) · Node v24.13.0
…
```

The rules it follows are deliberately narrow:

- **The menu only.** Never `check`, `ask`, `report`, `export` or `diff`, and never when output is piped or `CI` is set — so a script or a pipeline can never trigger a global install.
- **npm only.** The single command that can run is `npm i -g freebuff-doctor@latest`. Nothing else is executed. If it fails, you get the reason and the command to run yourself.
- **Once per version.** The installed version is recorded under the fbdoc config directory, so a copy that lags behind (running from a git checkout, say) reports what is installed instead of reinstalling it on every launch.
- **Silent when there is nothing to say.** A current install, an unreachable registry and `--offline` all print nothing. `--verbose` reports what the check found.
- **`--no-self-update`** turns it off entirely, in either position: `fbdoc --no-self-update` or `fbdoc menu --no-self-update`.

When the copy you are running sits inside a **git checkout**, fbdoc also compares it with `origin/main` and tells you how far behind it is. That part is read-only by design: it never pulls, never stashes and never touches a working tree — and when your checkout has uncommitted changes, it says only that it is leaving it alone. Updates always come from npm.

## Command reference

| Command | What it does |
| --- | --- |
| `fbdoc` | Interactive main menu: run diagnostics, search the FAQ, use the wizard, ask the AI assistant, export a report. Checks npm for a newer release and installs it (`--no-self-update` to skip). |
| `fbdoc check` | Runs every diagnostic and prints pass/warn/fail per check. Supports `--json` and `--only`. |
| `fbdoc faq <query>` | Fuzzy-searches the bundled FAQ and prints the best-matching section. |
| `fbdoc faq --list` | Lists every FAQ section. |
| `fbdoc wizard` | Guided Q&A that narrows the problem down and surfaces the matching FAQ section(s). |
| `fbdoc ask [question]` | Runs the diagnostics, then asks the AI assistant (Groq, `openai/gpt-oss-20b`) about them. With a question it answers once and exits; with no question on a terminal it opens a chat. `--no-checks` skips the diagnostics, `--only` narrows them. |
| `fbdoc export` | Runs every check and writes a detailed, redacted `.md` report to your Downloads folder for Freebuff helpers. `--dir <folder>` writes elsewhere, `--stdout` prints it. |
| `fbdoc report` | Generates a short, redacted Markdown report ready to paste into Discord. `--output <file>` writes it to disk. |
| `fbdoc checks` | Lists every check, grouped by what it covers (`--json` for machines). |
| `fbdoc explain [id]` | Explains one check: what it reads, why it matters, the FAQ section behind it, and how to run it alone. With no id, lists them all. |
| `fbdoc env` | Prints your setup — runtime, `PATH` in search order, and the variables that change behaviour — with secrets redacted. |
| `fbdoc diff <before> <after>` | Compares two saved `fbdoc check --json` reports and reports what was fixed, what regressed, and what is still outstanding. Exits `1` on a regression. |
| `fbdoc --help`, `fbdoc -h` | Help for the top level and for every subcommand. |
| `fbdoc --version`, `fbdoc -v` | Prints the installed version. |

### Options

These work on the top level and on any subcommand, in either position (`fbdoc --verbose check` or `fbdoc check --verbose`):

| Flag | Meaning |
| --- | --- |
| `--verbose` | Show stack traces and extra diagnostic detail. Errors are human-readable by default. |
| `--offline` | Skip every check that needs the network (DNS, reachability, version lookups). |
| `--timeout <ms>` | Per-network-operation timeout, clamped to 1–60 seconds. Default `8000`. |
| `--strict` | Treat warnings as failures, so CI can gate on them. |
| `--no-color` | Disable ANSI colour. `NO_COLOR` and piped output do this automatically. |
| `--json` | (`check`, `faq`, `checks`, `explain`, `env`, `diff`) Emit machine-readable JSON on stdout. |
| `--only <ids>` | (`check`, `report`, `export`, `ask`) Comma-separated check ids, e.g. `--only dns,network`. |
| `--all` | (`check`) Print every result in full, including the ones that passed. |
| `--quiet` | (`check`) Print only the checks that need attention. |
| `--limit <n>` | (`faq`) Maximum number of matches to show. |
| `--output <file>` | (`report`) Write the report to a file instead of stdout. |
| `--dir <folder>` | (`export`) Write the report into this folder instead of Downloads. |
| `--stdout` | (`export`) Print the detailed report instead of saving it. |
| `--no-self-update` | (top level, `menu`) Skip the update check when the menu opens. |
| `--no-checks` | (`ask`) Skip the diagnostics and let the assistant answer from your question alone. |

## What it checks

| Id | Check | What it looks at |
| --- | --- | --- |
| `node-runtime` | Node.js and npm | Runtime version, whether it's an LTS line, npm presence and version. |
| `arch-match` | Runtime and machine architecture | Compares `process.arch` with what the machine really is (`uname -m`, `PROCESSOR_ARCHITECTURE`, Rosetta detection) and flags a 32-bit runtime on a 64-bit machine. |
| `global-install` | Freebuff CLI installation | Global `freebuff`/`codebuff` packages (npm, plus bun/pnpm fallbacks), the installed version vs. the latest on npm, and whether the binary is actually on `PATH`. |
| `command-shadowing` | Shadowed commands and PATH | Every distinct `freebuff`/`codebuff` on `PATH` in search order (more than one means updates hit a copy the shell never runs), plus directories your `PATH` lists twice. |
| `binary-integrity` | Installed binary is runnable | Whether the command is complete: non-empty, executable, not symlinked to a vanished target, not macOS-quarantined, and pointing at a script that still exists. Nothing is executed. |
| `install-paths` | Install and state directories | `~/.config/manicode`, `~/.config/freebuff-desktop`, `~/.config/codebuff`, and the platform desktop install location; readability; whether `projects/` exists. |
| `cache-integrity` | Cached engine and downloads | Interrupted downloads (`*.part`, `*.crdownload`, `*.tmp`) and superseded engine copies (`freebuff.exe.old.<timestamp>`) that an interrupted update left behind — on a long-lived install these add up to hundreds of megabytes. |
| `config-health` | Settings and state files | Parses every settings/state JSON (JSONC tolerated); a file that no longer parses fails with a move-it-aside command, and interrupted-write leftovers warn. |
| `auth-session` | Saved login and credentials | Finds the credential file, checks it parses, holds a token, has not expired, and is not readable by other accounts. Token values are never read out or reported. |
| `stale-lock` | Orphaned locks and processes | Lock and pid files (including Electron's `SingletonLock`) under the state and project directories, checked against live processes and this machine's hostname. |
| `split-state` | Where local history lives | Counts sessions per state directory. CLI and desktop keeping separate stores is expected; sessions stranded in the legacy `codebuff` directory are not, and look exactly like lost history. |
| `session-logs` | Local sessions and chat logs | `manicode/projects/*/chats/*/log.jsonl` and `freebuff-desktop/projects/*/desktop-v2.db`, counts, the newest session, and readability. |
| `crash-log` | Crash logs | Reads the tail of `orchestrator-stderr.log` and only surfaces a **fatal** entry that is recent (within 72 hours). |
| `error-triage` | Recent errors in your logs | Scans the tails of log files for actionable signatures (`ENOSPC`, `EADDRINUSE`, `EACCES`, out-of-memory, TLS failures, `ECONNRESET`) and turns the one you actually hit into a next step. Chat transcripts are never scanned, so pasted code cannot trigger it. |
| `state-growth` | Local session data size | Per-project log and database sizes: names the largest single file (a runaway log past 500 MB warns) and the biggest projects, so you know *what* is using the volume. |
| `dns` | DNS resolution | Resolves `freebuff.com` with your resolver *and* with `8.8.8.8`, then flags hijacks (private/loopback/CGNAT answers) and disagreements. |
| `network` | Network reachability | HTTPS to `freebuff.com` and `registry.npmjs.org`, with timings and proxy-environment detection. |
| `proxy-trust` | Proxy configuration | Reads `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`, opens a TCP connection to the configured proxy, and flags a proxy that is down, a `NO_PROXY` that forgets loopback, and the case where Node will ignore the proxy entirely (env-proxy support is off). Proxy credentials are stripped before anything is printed. |
| `tls-chain` | TLS certificate chain | Completes a real TLS handshake and walks the returned chain. Node ships its own CA list and ignores the OS trust store, so a corporate root your browser trusts can break only Freebuff — the classic interception symptom. |
| `hosts-pin` | Hosts file overrides | Parses the system hosts file for entries naming a Freebuff domain; loopback or private pins fail, stale public pins warn. |
| `clock-skew` | System clock and TLS trust | Compares the local clock with a server `Date` header (warn past 5 minutes, fail past an hour) and audits `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE`. |
| `env-hygiene` | Environment variables | `NODE_OPTIONS` (`--openssl-legacy-provider`, absurd heap caps, missing loaders), `NODE_PATH`, `NPM_CONFIG_PREFIX`, `ELECTRON_RUN_AS_NODE`, and `.npmrc` files that redirect npm or store a token in the project. |
| `node-conflicts` | Conflicting Node.js installs | Groups every `node`/`npm`/`npx` on `PATH` by install manager (nvm, fnm, Volta, Homebrew, Scoop, winget, system) and warns when more than one owns `node` — the known cause of endless update loops. |
| `git-prereqs` | Git availability and config | `git --version`, a global `user.name`/`user.email` (commits fail without them), `core.longpaths` and `core.autocrlf` mismatches, and git's `dubious ownership` refusal. |
| `watcher-limits` | File-watching limits | Linux `fs.inotify.max_user_watches`/`max_user_instances` and macOS `kern.maxfiles`/`kern.maxfilesperproc`. When these are low, watching a large repository silently stops noticing edits. |
| `path-length` | Path length limits | Measures the real paths in your Freebuff directories against Windows' 260-character limit. `git-prereqs` reports whether long-path support is *configured*; this reports whether it *matters*. |
| `temp-health` | Temporary directory | `TMPDIR`/`TEMP` exists, is writable, has room, and is not clogged with stale files. A full or missing temp directory fails updates with errors that never mention the cause. |
| `port-availability` | Local ports and running instances | Finds Freebuff's own processes and which of them hold a listening socket. Two listening instances usually means an earlier session never shut down and still owns the port a new launch wants. |
| `storage` | Disk space and permissions | Free space on the volume holding your Freebuff state, plus write access to it and to npm's global directory. |
| `resource-limits` | Memory, file descriptors and processes | Effective `ulimit -n`, free RAM, and the number of live Node processes — and it ties a recorded out-of-memory crash back to the memory available right now. |

Checks run concurrently. Within each group they are reported in the order above: the group that needs a human comes first, then the healthy ones — collapsed to one line each, or in full with `--all`. Each result carries a one-line explanation, an optional `fix` command, a link to the FAQ section that covers it, and the `fbdoc explain <id>` command that documents it. `fbdoc checks` prints the ids for use with `--only`.

A few of them are deliberately conservative. `clock-skew` still audits your TLS environment under `--offline`, because a stale `NODE_EXTRA_CA_CERTS` is exactly what breaks HTTPS, and `binary-integrity` inspects the install without ever executing the CLI, so running the doctor can never trigger an engine download or a self-update as a side effect. `split-state` treats the CLI and desktop app keeping separate histories as normal, and only complains about sessions stranded in the legacy directory. `error-triage` reads log tails but never chat transcripts, so code you pasted into a conversation cannot raise a false alarm.

The output is built to be read top-down: everything that needs attention is printed in full first, then healthy checks collapse to a single line you can expand with `--all`. `fbdoc diff before.json after.json` answers the follow-up question — *did the fix actually work?*

## FAQ search

`faq.md` ships inside the package and is parsed into sections at runtime (headings become indexable sections, and fenced code is never mistaken for a heading). Searching blends:

- **Direct signals** — whole-word hits on the section title, and a curated keyword list per section.
- **Fuzzy matching** — [Fuse.js](https://www.npmjs.com/package/fuse.js), so `netwrok issue` and `update loup` still land on the right answer.

One confident match is printed straight away; genuinely ambiguous queries (like `project`) show a short numbered list to pick from instead of guessing. The package always loads `faq.md` relative to its own installed location, never your working directory.

## Reports

Both report commands collect the diagnostics, your OS/platform, app versions and the last lines of the engine log, then **redact** anything that looks like a token, email, API key, credential or private key, and replace your home directory with `~`. The footer states exactly what was scrubbed, so you can see it did something.

`fbdoc report` prints clean Markdown for pasting into a Discord `#help` thread. It aims to stay under Discord's 2000-character limit, and tells you when it cannot — the log tail is usually what pushes it over, so write the file instead and attach it:

```console
$ fbdoc report > report.md
$ fbdoc report --output report.md
```

`fbdoc export` writes the long-form version to a `.md` file in your Downloads folder (honouring an XDG download directory if you have one) and names it with the date and time:

```console
$ fbdoc export                       # Downloads/freebuff-doctor-report-<date>-<time>.md
$ fbdoc export --dir ./reports       # somewhere else
$ fbdoc export --stdout              # print it instead of saving a file
```

It is deliberately far more detailed than the Discord one, because it exists to save a round trip: the environment, `PATH` in search order, every state directory, the catalogue's "what this check looks at" text, each problem's raw `data` payload, a 60-line engine log tail, and the whole result set as JSON a helper can diff. Chat transcripts are never included.

## Exit codes and CI

```console
$ fbdoc check --json
```

- `0` — no problems found. Warnings alone still exit `0`.
- `1` — at least one check failed, or the request could not be completed (bad flag, unknown command, no FAQ match).
- Add `--strict` to make warnings exit `1` as well.
- `130` — you cancelled an interactive prompt.

`fbdoc report` and `fbdoc export` always exit `0` when they produce a report, even if checks failed: the report is the product, not the verdict. Only being unable to write the file exits `1`.

`--json` writes nothing else to stdout, so it pipes cleanly:

```console
$ fbdoc check --json --offline | jq '.summary'
{ "total": 30, "pass": 22, "warn": 0, "fail": 0, "skip": 5 }
```

```yaml
# Example CI gate
- run: npx --yes freebuff-doctor check --offline --strict
```

## Requirements

- **Node.js 22.13 or newer** (or 23.5+). That floor comes from the runtime dependencies — `commander` needs ≥22.12 and `@inquirer/prompts` needs ≥22.13 or ≥23.5. The CLI is published as ESM (`type: module`).
- No configuration, no API keys and no network access are required for `fbdoc faq`, `fbdoc report --offline` or `fbdoc export --offline`. The AI assistant is the one optional exception: it needs a free Groq key and a connection, as described in [AI assistance](#ai-assistance-optional-groq).

Colour is disabled automatically when output is piped, in CI, or when `NO_COLOR` is set. Spinners only appear after 300 ms and only on an interactive terminal, so a fast, piped run stays quiet.

## Development

```console
$ npm install
$ npm run build      # tsc → dist/, then ensure dist/cli.js has a shebang and is executable
$ npm test           # vitest: FAQ search, check logic, plus end-to-end CLI tests
$ npm run typecheck
$ npm run dev -- check   # run the TypeScript source directly with tsx
```

The tests cover the FAQ parser and ranking, the pure decision logic behind every check (DNS classification, crash-log classification, Node-manager detection, architecture matching, config parsing, lock parsing, clock skew, environment audit, git config, resource limits, growth thresholds, proxy parsing, TLS chain walking, hosts parsing, credential inspection, log triage, cache artefacts, watcher limits, temp health, path lengths, listening sockets, report comparison, redaction, semver), and the built CLI itself: exit codes, `--json` shape, `NO_COLOR`, `--only`, `explain`, `env`, `diff` and report redaction. Both report builders are tested for their structure, and the export path is tested for its filename stamp, XDG/Downloads resolution and fallbacks. One test asserts that every registered check is documented and that every FAQ link a check can emit points at a section that exists; two others assert that no report, and no JSON payload embedded in one, can leak your home directory in any slash or backslash spelling. The AI layer has its own suite: key-lookup precedence, the saved-key round trip and its permissions, outbound request shaping (including that the key travels in a header and never in the body), SSE fragment reassembly across chunk boundaries, HTTP status mapping, and the guarantee that no prompt, question or key can escape the redactor.

Layout:

```
src/
  ai/               the Groq client, API-key storage, the prompt and the streaming markdown renderer
  selfupdate/       the npm release check, the git checkout comparison and its state file
  cli.ts            commander tree: check, ask, faq, wizard, report, export, explain, env, diff, checks, menu
  checks/           one module per check, plus catalog.ts (categories, summaries, "why" text)
  commands/         one module per command, including the interactive menu and wizard
  faq/              faq.md loader, keyword aliases and the fuzzy search index
  report/           support.ts (Discord-sized) and helper.ts (the detailed export)
  ui/               terminal output, prompts, spinner, colour and width helpers
  util/             redaction, platform paths, environment snapshot, Downloads resolution, filesystem scanning
faq.md              the bundled FAQ, parsed at runtime
scripts/            postbuild step (shebang + executable bit on dist/cli.js)
test/               one suite per area, plus end-to-end tests against the built CLI
```
