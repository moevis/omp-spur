// spur.ts — deterministic spur channel, independent of the advisor.
//
// Why: the advisor reviews turns with a model, but its non-blocker notes are
// deferred to a final boundary (see omp://advisor-watchdog.md). This extension
// has no model, no review, and no deferral: tool_result `additionalContext` is
// delivered after the batch's results, before the next provider request, with
// developer priority.
//
// Rule: if the run edits >= MIN_NEW_FILES distinct files while running fewer
// than MIN_PARALLEL_AGENTS subagents, spur the agent that independent slices
// should run in parallel. The channel repeats for every COOLDOWN_NEW_FILES
// additional files and is never capped. Never blocks, never throws.
//
// Toggle in-session: `/spur`, `/spur on`, `/spur off`, `/spur status`.

import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const MIN_NEW_FILES = 3;
const COOLDOWN_NEW_FILES = 3;
const MIN_PARALLEL_AGENTS = 2;

// Package-qualified custom entry type. Core reserves its own customType values,
// so the prefix keeps this record opaque to session-context reconstruction.
const STATE_TYPE = "omp-spur.state";

const EDIT_TOOLS: Record<string, true> = {
  edit: true,
  write: true,
  apply_patch: true,
};

function debug(line: string) {
  if (process.env.SPUR_DEBUG !== "1") return;
  try {
    appendFileSync(
      `${process.env.HOME}/.omp/logs/spur.log`,
      `${new Date().toISOString()} ${line}\n`,
    );
  } catch {}
}

// The factory is rebound to every subagent (and advisor) session, so every
// handler fires for their tool calls too. This rule is about main-agent
// scheduling: every handler below checks ctx.agent.kind === "main" first.

function editedPaths(input: unknown): string[] {
  const out: string[] = [];
  if (input === null || typeof input !== "object") return out;

  const push = (value: unknown) => {
    if (typeof value === "string" && value.length > 0) out.push(value);
  };

  if ("path" in input) push(input.path);
  if ("file_path" in input) push(input.file_path);
  if ("dst" in input) push(input.dst);
  if ("paths" in input && Array.isArray(input.paths)) {
    for (const path of input.paths) push(path);
  }
  return out;
}

function spawnedAgentCount(event: { toolName: string; input?: unknown }): number {
  if (event.toolName === "create_agent") return 1;
  if (
    event.input !== null &&
    typeof event.input === "object" &&
    "tasks" in event.input &&
    Array.isArray(event.input.tasks) &&
    event.input.tasks.length > 0
  ) {
    return event.input.tasks.length;
  }
  return 1;
}

export default function spur(pi: ExtensionAPI) {
  debug("factory loaded");

  let enabled = process.env.SPUR_DISABLE !== "1";
  let files = new Set<string>();
  let turns = 0;
  let lastSpurFileCount = 0;
  let spurCount = 0;
  let spawnCount = 0;

  const reset = () => {
    files = new Set();
    turns = 0;
    lastSpurFileCount = 0;
    spurCount = 0;
    spawnCount = 0;
  };

  // Only the main agent is a subject here: subagent and advisor sessions get
  // their own factory instance, and this channel must never spend their context
  // on scheduling advice. The fire count persists per session file; the
  // on/off switch is deliberately process-scoped and is not replayed.
  const rehydrate = (ctx) => {
    if (ctx?.agent?.kind !== "main") return;
    reset();
    if (process.env.SPUR_DISABLE === "1") return;
    let branch;
    try {
      branch = ctx?.sessionManager?.getBranch?.() ?? [];
    } catch {
      return;
    }
    let fires = 0;
    let agents = 0;
    for (const entry of branch) {
      if (entry?.type !== "custom" || entry.customType !== STATE_TYPE) continue;
      if (entry.data?.ev === "fire") {
        fires += 1;
      } else if (entry.data?.ev === "spawn") {
        const count = entry.data?.n;
        if (typeof count === "number" && count > 0) agents += count;
      }
    }
    spurCount = fires;
    spawnCount = agents;
  };

  pi.on("session_start", (_event, ctx) => rehydrate(ctx));
  pi.on("session_switch", (_event, ctx) => rehydrate(ctx));
  pi.on("session_branch", (_event, ctx) => rehydrate(ctx));
  pi.on("session_tree", (_event, ctx) => rehydrate(ctx));

  pi.on("turn_end", (_event, ctx) => {
    if (!enabled || ctx?.agent?.kind !== "main") return;
    turns += 1;
  });

  pi.on("tool_result", (event, ctx) => {
    if (!enabled || ctx?.agent?.kind !== "main") return;
    if (event.isError) return;
    if (event.toolName === "task" || event.toolName === "create_agent") {
      const count = spawnedAgentCount(event);
      spawnCount += count;
      files = new Set();
      lastSpurFileCount = 0;
      pi.appendEntry(STATE_TYPE, { ev: "spawn", n: count, turns });
      debug(`SPAWN n=${count} total=${spawnCount} turns=${turns}`);
      return;
    }

    if (EDIT_TOOLS[event.toolName] === true) {
      for (const path of editedPaths(event.input)) files.add(path);
    }

    if (spawnCount >= MIN_PARALLEL_AGENTS) return;
    if (files.size < MIN_NEW_FILES) return;
    if (files.size - lastSpurFileCount < COOLDOWN_NEW_FILES) return;

    spurCount += 1;
    lastSpurFileCount = files.size;
    pi.appendEntry(STATE_TYPE, { ev: "fire", files: files.size, turns, n: spurCount });
    debug(`SPUR #${spurCount} files=${files.size} turns=${turns}`);

    return {
      additionalContext:
        `<spur kind="parallelism" files="${files.size}">\n` +
        `This run has edited ${files.size} distinct files while running fewer than 2 subagents. ` +
        `If the remaining work contains 2 or more independent slices (separate files or modules, ` +
        `no shared mutable state, interface already clear), stop working serially: spawn them as ` +
        `2 or more parallel subagents on the dsv4 profile (mp-tob/deepseek-v4.1-flash-tob) with full slice ` +
        `requirements, and keep integration plus final verification yourself. ` +
        `If the work is genuinely one coupled slice, ignore this and continue.\n` +
        `</spur>`,
    };
  });

  pi.registerCommand("spur", {
    description: "Toggle the deterministic spur channel (on|off|status)",
    handler: async (args, ctx) => {
      const arg = String(args ?? "").trim().toLowerCase();
      // The channel only ever acts on the main agent; say so instead of
      // mutating a subagent session's private copy of the state.
      if (ctx?.agent?.kind !== "main") {
        ctx.ui.notify("spur: main agent only", "warning");
        return;
      }
      if (arg !== "" && arg !== "on" && arg !== "off" && arg !== "status") {
        ctx.ui.notify("Usage: /spur [on|off|status]", "warning");
        return;
      }
      // SPUR_DISABLE=1 is a hard lock, not just the initial default: the
      // process owner disabled the channel, so slashes cannot enable it.
      if (process.env.SPUR_DISABLE === "1" && arg !== "off" && arg !== "status") {
        ctx.ui.notify("spur: off (SPUR_DISABLE=1 locks it off)", "info");
        return;
      }
      // The switch gates delivery only. It never touches the fire count: the
      // count is derived from this session's entries, so a process-local reset
      // here would silently roll back on resume.
      if (arg === "on") {
        enabled = true;
      } else if (arg === "off") {
        enabled = false;
      } else if (arg === "") {
        enabled = !enabled;
      }

      if (arg === "status") {
        ctx.ui.notify(
          `spur: ${enabled ? "on" : "off"} · files=${files.size} turns=${turns} ` +
            `spurs=${spurCount} agents=${spawnCount} ` +
            `parallel=${spawnCount >= MIN_PARALLEL_AGENTS ? "yes" : "no"} ` +
            `(count: this session; switch: this process)`,
          "info",
        );
        return;
      }
      ctx.ui.notify(`spur: ${enabled ? "on" : "off"}`, "info");
    },
  });
}
