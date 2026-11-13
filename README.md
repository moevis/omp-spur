# omp-spur

A deterministic OMP plugin that nudges the main agent to parallelize independent work across dsv4 subagents.

`spur` has two layers:

- a static rule injected into every main-agent session;
- a runtime extension that watches file edits and successful subagent spawns, then injects a short reminder when serial work is accumulating without enough parallelism.

No model calls. No blocking. No per-session reminder cap.

## Install

```bash
omp plugin install github:moevis/omp-spur
```

Pin a tag, branch, or commit:

```bash
omp plugin install github:moevis/omp-spur#v0.1.0
omp plugin install github:moevis/omp-spur#main
```

For a private fork, use SSH:

```bash
omp plugin install git@github.com:<user>/omp-spur.git
```

`git` must be on `PATH`. OMP's embedded Bun handles the package install.

Verify:

```bash
omp plugin list
omp plugin doctor
```

Start a new OMP session after installing.

## Usage

```text
/spur          # toggle
/spur on
/spur off
/spur status
```

`SPUR_DISABLE=1` is a hard lock: slash commands cannot enable the channel.

`/spur status` reports the current file count, turn count, reminder count, successful spawn count, and whether the parallel-width gate is satisfied.

## What triggers a reminder

A reminder is injected only when all of these hold:

- the session is the main agent;
- the channel is enabled;
- fewer than **2** subagents have been spawned successfully;
- at least **3 distinct files** have been edited or written;
- at least **3 new files** have appeared since the previous reminder.

So the first reminder can arrive at 3 files, then at 6, 9, 12, and so on. There is no maximum reminder count.

Successful `task` batches count by the number of `tasks[]` items; a flat `task` or `create_agent` counts as one. Failed spawns are ignored. A successful spawn clears the current file window, so a later serial phase must accumulate 3 new files before the next reminder.

The reminder is conditional on the work shape:

> If the remaining work contains 2 or more independent slices, spawn 2 or more parallel subagents on dsv4. If the work is genuinely one coupled slice, ignore this and continue.

## Why track files?

`files` is the deterministic proxy for **serial work volume**. A reminder on one or two files is usually noise; three distinct edited files is enough evidence that multiple work surfaces exist. Repeated edits to the same file count once, so coupled work does not look artificially parallel.

The subagent count is the separate **parallel-width gate**: zero or one spawned subagent still leaves the channel armed; two or more suppress it. The file count answers "is there enough serial work to reconsider?"; the spawn count answers "is the agent already parallel enough?"

`turn` is not used for scheduling. An OMP turn is one assistant model response plus its tool-result batch; a single user prompt can span several turns. Turns are shown in `/spur status` only.

## Rule

`rules/spur.md` is an always-apply, main-agent rule. It states the slice criteria:

- separate files or modules;
- no shared mutable state;
- the interface or contract is already clear;
- each slice is independently verifiable.

The main agent keeps integration and final verification. Multiple subagents must not edit the same file or work against an undefined interface.

## Files

```text
index.ts        runtime extension
rules/spur.md   always-apply main-agent rule
package.json    plugin manifest
```

## Configuration

The runtime thresholds are constants at the top of `index.ts`:

```ts
const MIN_NEW_FILES = 3;
const COOLDOWN_NEW_FILES = 3;
const MIN_PARALLEL_AGENTS = 2;
```

Edit them, then start a new session.

The rule and the reminder both hardcode the dsv4 model id `mp-tob/deepseek-v4.1-flash-tob`. That id is specific to this provider setup; outside this environment, replace it in both `rules/spur.md` and `index.ts` with your own model or role alias (for example `@task`).

## Development

```bash
git clone git@github.com:moevis/omp-spur.git
omp plugin link ./omp-spur
```

Debug logging:

```bash
SPUR_DEBUG=1 omp
tail -f ~/.omp/logs/spur.log
```
