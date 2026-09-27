# freebuff-doctor

[![npm version](https://img.shields.io/npm/v/freebuff-doctor.svg)](https://www.npmjs.com/package/freebuff-doctor)
[![node](https://img.shields.io/node/v/freebuff-doctor.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/freebuff-doctor.svg)](./LICENSE)

https://github.com/user-attachments/assets/b5a77648-8af7-434b-bef5-b1d79967ca56

**Diagnose and fix common Freebuff problems from your terminal** — without waiting on Discord support.

`freebuff-doctor` installs one command, `fbdoc`, which combines:

1. **Nine automated checks** of your machine, network and Freebuff install.
2. **A searchable, offline FAQ** — fuzzy enough that `cant connect` still finds the Network Issues answer.
3. **A troubleshooting wizard** for when you aren't sure what's wrong.
4. **A redacted support report** you can paste straight into a Discord `#help` thread.

```console
$ npm install -g freebuff-doctor
$ fbdoc
```

## Demo

```console
$ fbdoc check

Freebuff Doctor 0.1.1
───────────────────────
win32 10.0.26200 (x64) · Node v24.13.0

✅ Node.js and npm
   Node.js v24.13.0 with npm 11.6.2.

⚠️  Freebuff CLI installation
   freebuff 0.0.118 is behind the latest release (0.1.2).
   › Command: ~\AppData\Roaming\npm\freebuff.CMD
   fix  npm i -g freebuff@latest
   faq  Crash on Start / Updating (fbdoc faq "Crash on Start / Updating")

✅ DNS resolution
   freebuff.com resolves normally.
   › Your resolver returns: 216.24.57.1
   › Public DNS (8.8.8.8) returns: 216.24.57.1

✅ Network reachability
   Reached https://freebuff.com/ in 690 ms and the npm registry is reachable.

✅ Conflicting Node.js installs
   Only one Node.js install was found on PATH (a system installer).

✅ Local sessions and chat logs
   Session history is present and readable (120 file(s)).
   › 109 CLI chat log(s) and 11 desktop database(s).

✅ Crash logs
   No orchestrator-stderr.log found — there are no recorded engine crashes.

✅ Disk space and permissions
   Disk space and permissions look healthy (39 GB free).

╭ Freebuff Doctor ────────────────────────────────────────────────────────────────╮
│ 9 checks · 8 passed · 1 warning                                                 │
│                                                                                 │
│ Next  Freebuff CLI installation: freebuff 0.0.118 is behind the latest release  │
│       (0.1.2).                                                                  │
│ Run   npm i -g freebuff@latest                                                  │
│ FAQ   Crash on Start / Updating                                                 │
│       fbdoc faq "Crash on Start / Updating"                                     │
╰─────────────────────────────────────────────────────────────────────────────────╯
```

The main menu (arrow keys, no flags to remember):

```console
$ fbdoc

Freebuff Doctor 0.1.1
win32 10.0.26200 (x64) · Node v24.13.0

? What would you like to do?
❯ Run diagnostics
  Search the FAQ
  Troubleshooting wizard
  Export a support report
  Quit
```

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

## Command reference

| Command | What it does |
| --- | --- |
| `fbdoc` | Interactive main menu: run diagnostics, search the FAQ, use the wizard, export a report. |
| `fbdoc check` | Runs every diagnostic and prints pass/warn/fail per check. Supports `--json` and `--only`. |
| `fbdoc faq <query>` | Fuzzy-searches the bundled FAQ and prints the best-matching section. |
| `fbdoc faq --list` | Lists every FAQ section. |
| `fbdoc wizard` | Guided Q&A that narrows the problem down and surfaces the matching FAQ section(s). |
| `fbdoc report` | Generates a redacted Markdown support report. `--output <file>` writes it to disk. |
| `fbdoc checks` | Lists every check id (handy for `--only`). |
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
| `--json` | (`check`, `faq`) Emit machine-readable JSON on stdout. |
| `--only <ids>` | (`check`, `report`) Comma-separated check ids, e.g. `--only dns,network`. |
| `--limit <n>` | (`faq`) Maximum number of matches to show. |
| `--output <file>` | (`report`) Write the report to a file instead of stdout. |

## What it checks

| Id | Check | What it looks at |
| --- | --- | --- |
| `node-runtime` | Node.js and npm | Runtime version, whether it's an LTS line, npm presence and version. |
| `arch-match` | Runtime and machine architecture | Compares `process.arch` with what the machine really is (`uname -m`, `PROCESSOR_ARCHITECTURE`, Rosetta detection) and flags a 32-bit runtime on a 64-bit machine. |
| `global-install` | Freebuff CLI installation | Global `freebuff`/`codebuff` packages (npm, plus bun/pnpm fallbacks), the installed version vs. the latest on npm, and whether the binary is actually on `PATH`. |
| `binary-integrity` | Installed binary is runnable | Whether the command is complete: non-empty, executable, not symlinked to a vanished target, not macOS-quarantined, and pointing at a script that still exists. Nothing is executed. |
| `install-paths` | Install and state directories | `~/.config/manicode`, `~/.config/freebuff-desktop`, `~/.config/codebuff`, and the platform desktop install location; readability; whether `projects/` exists. |
| `config-health` | Settings and state files | Parses every settings/state JSON (JSONC tolerated); a file that no longer parses fails with a move-it-aside command, and interrupted-write leftovers warn. |
| `stale-lock` | Orphaned locks and processes | Lock and pid files (including Electron's `SingletonLock`) under the state and project directories, checked against live processes and this machine's hostname. |
| `dns` | DNS resolution | Resolves `freebuff.com` with your resolver *and* with `8.8.8.8`, then flags hijacks (private/loopback/CGNAT answers) and disagreements. |
| `network` | Network reachability | HTTPS to `freebuff.com` and `registry.npmjs.org`, with timings and proxy-environment detection. |
| `clock-skew` | System clock and TLS trust | Compares the local clock with a server `Date` header (warn past 5 minutes, fail past an hour) and audits `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE`. |
| `env-hygiene` | Environment variables | `NODE_OPTIONS` (`--openssl-legacy-provider`, absurd heap caps, missing loaders), `NODE_PATH`, `NPM_CONFIG_PREFIX`, `ELECTRON_RUN_AS_NODE`, and `.npmrc` files that redirect npm or store a token in the project. |
| `node-conflicts` | Conflicting Node.js installs | Groups every `node`/`npm`/`npx` on `PATH` by install manager (nvm, fnm, Volta, Homebrew, Scoop, winget, system) and warns when more than one owns `node` — the known cause of endless update loops. |
| `git-prereqs` | Git availability and config | `git --version`, a global `user.name`/`user.email` (commits fail without them), `core.longpaths` and `core.autocrlf` mismatches, and git's `dubious ownership` refusal. |
| `session-logs` | Local sessions and chat logs | `manicode/projects/*/chats/*/log.jsonl` and `freebuff-desktop/projects/*/desktop-v2.db`, counts, the newest session, and readability. |
| `crash-log` | Crash logs | Reads the tail of `orchestrator-stderr.log` and only surfaces a **fatal** entry that is recent (within 72 hours). |
| `state-growth` | Local session data size | Per-project log and database sizes: names the largest single file (a runaway log past 500 MB warns) and the biggest projects, so you know *what* is using the volume. |
| `storage` | Disk space and permissions | Free space on the volume holding your Freebuff state, plus write access to it and to npm's global directory. |
| `resource-limits` | Memory, file descriptors and processes | Effective `ulimit -n`, free RAM, and the number of live Node processes — and it ties a recorded out-of-memory crash back to the memory available right now. |

Checks run concurrently but are always reported in the order above. Each result carries a one-line explanation, an optional `fix` command, and a link to the FAQ section that covers it. `fbdoc checks` prints the ids for use with `--only`.

Two of them are deliberately conservative. `clock-skew` still audits your TLS environment under `--offline`, because a stale `NODE_EXTRA_CA_CERTS` is exactly what breaks HTTPS, and `binary-integrity` inspects the install without ever executing the CLI, so running the doctor can never trigger an engine download or a self-update as a side effect.

## FAQ search

`faq.md` ships inside the package and is parsed into sections at runtime (headings become indexable sections, and fenced code is never mistaken for a heading). Searching blends:

- **Direct signals** — whole-word hits on the section title, and a curated keyword list per section.
- **Fuzzy matching** — [Fuse.js](https://www.npmjs.com/package/fuse.js), so `netwrok issue` and `update loup` still land on the right answer.

One confident match is printed straight away; genuinely ambiguous queries (like `project`) show a short numbered list to pick from instead of guessing. The package always loads `faq.md` relative to its own installed location, never your working directory.

## Support report

`fbdoc report` collects the diagnostics, your OS/platform, app versions and the last lines of the engine log, then **redacts** anything that looks like a token, email, API key, credential or private key, and replaces your home directory with `~`. Output is clean Markdown for pasting into a Discord `#help` thread:

```console
$ fbdoc report > report.md
$ fbdoc report --output report.md
```

The report's footer states exactly what was scrubbed, so you can see it did something.

## Exit codes and CI

```console
$ fbdoc check --json
```

- `0` — no problems found. Warnings alone still exit `0`.
- `1` — at least one check failed, or the request could not be completed (bad flag, unknown command, no FAQ match).
- Add `--strict` to make warnings exit `1` as well.
- `130` — you cancelled an interactive prompt.

`--json` writes nothing else to stdout, so it pipes cleanly:

```console
$ fbdoc check --json --offline | jq '.summary'
{ "total": 18, "pass": 15, "warn": 0, "fail": 0, "skip": 3 }
```

```yaml
# Example CI gate
- run: npx --yes freebuff-doctor check --offline --strict
```

## Requirements

- **Node.js 22.13 or newer** (or 23.5+). That floor comes from the runtime dependencies — `commander` needs ≥22.12 and `@inquirer/prompts` needs ≥22.13 or ≥23.5. The CLI is published as ESM (`type: module`).
- No configuration, no API keys, and no network access is required for `fbdoc faq` or `fbdoc report --offline`.

Colour is disabled automatically when output is piped, in CI, or when `NO_COLOR` is set. Spinners only appear after 300 ms and only on an interactive terminal, so a fast, piped run stays quiet.

## Development

```console
$ npm install
$ npm run build      # tsc → dist/, then ensure dist/cli.js has a shebang and is executable
$ npm test           # vitest: FAQ search, check logic, plus end-to-end CLI tests
$ npm run typecheck
$ npm run dev -- check   # run the TypeScript source directly with tsx
```

The tests cover the FAQ parser and ranking, the pure decision logic behind every check (DNS classification, crash-log classification, Node-manager detection, architecture matching, config parsing, lock parsing, clock skew, environment audit, git config, resource limits, growth thresholds, redaction, semver), and the built CLI itself: exit codes, `--json` shape, `NO_COLOR`, `--only` and report redaction.

Layout:
