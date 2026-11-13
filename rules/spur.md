---
name: spur
description: Prefer 2+ parallel dsv4 subagents for independent slices; the main agent keeps integration and final verification.
alwaysApply: true
agents: main
---

# Spur: parallel-work check

Before starting a multi-file change, split the work into slices and ask: are two or more slices independent?

Use **2 or more** parallel `task` subagents on **dsv4** (`mp-tob/deepseek-v4.1-flash-tob`) when all of these hold:

- the slices touch separate files or modules;
- there is no shared mutable state;
- the shared interface or contract is already clear;
- each slice can be verified independently.

One subagent is not enough parallelism. If you already spawned one and another independent slice remains, spawn the second; if only one slice is genuinely independent, do not invent a second just to satisfy the threshold.

The main agent keeps integration and final verification. Do not let multiple subagents edit the same file or work against an undefined interface. Each slice should hand back a change with its acceptance check.

Do not parallelize a single-file or tightly coupled change, steps with real dependencies, or work the user explicitly asked to run serially.

When delegating, name each slice, its acceptance check, and the shared contract. Keep one integration owner.
