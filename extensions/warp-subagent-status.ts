/**
 * warp-subagent-status: keeps Warp showing the tab as active while
 * pi-subagents async runs are outstanding and the parent agent has settled.
 *
 * Gap it fills: @juicesharp/rpiv-warp drives Warp's badge/spinner off pi's
 * agent-loop lifecycle only (agent_start → agent_end). The `subagent` tool
 * returns immediately for async runs, the parent loop settles, and rpiv-warp
 * emits `stop` + `idle_prompt` — yet subagents keep running for minutes.
 *
 * pi-subagents publishes the missing signals on the shared event bus
 * (`subagent:async-started` / `subagent:async-complete`). This extension
 * tracks them and, while the parent is idle with jobs outstanding, re-emits
 * rpiv-warp's own payload shapes: `prompt_submit` plus a 15s heartbeat and
 * the tab-title spinner, then a final `stop` when the last run completes.
 *
 * Reuses rpiv-warp's payload builders and OSC transport so emissions are
 * byte-identical to its own. It deliberately does NOT touch the tab-title
 * spinner: pi loads each extension file as a fresh module evaluation
 * (moduleCache: false), so importing rpiv-warp's title-spinner would create
 * a second ticker instance racing the first — duplicated title writes that
 * read as an accelerated spinner. Warp's active/done badge is driven by the
 * OSC 777 payloads alone; during the waiting window there is simply no title
 * animation. Timers fire at 500ms — after rpiv-warp's 300ms idle_prompt —
 * so the working report wins the race it is meant to win.
 *
 * Gated the same way rpiv-warp gates itself: Warp terminal + structured
 * protocol, and never inside pi-subagents children (no controlling terminal
 * of their own).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
// Import via node_modules file paths: rpiv-warp's exports map only exposes the
// package root, and jiti's interop drops named exports from it. These modules
// are stateless (payload builders + OSC writer + env detection), so a copy in
// this package's own node_modules is safe — only title-spinner.ts is stateful
// and deliberately not imported (see header note about ticker races).
import {
	buildPromptSubmitPayload,
	buildStopPayload,
	serializePayload,
} from "../node_modules/@juicesharp/rpiv-warp/payload.ts";
import { detectWarpEnvironment } from "../node_modules/@juicesharp/rpiv-warp/protocol.ts";
import { writeOSC777 } from "../node_modules/@juicesharp/rpiv-warp/warp-notify.ts";

// ---------------------------------------------------------------------------
// Tunables — single definition site
// ---------------------------------------------------------------------------

/** Must exceed rpiv-warp's 300ms idle timer so the working report lands last. */
const WAIT_DELAY_MS = 500;
/** Matches rpiv-warp's default heartbeat; re-announces so Warp doesn't time out mid-wait. */
const HEARTBEAT_MS = 15000;

// ---------------------------------------------------------------------------
// State — one waiting window at a time
// ---------------------------------------------------------------------------

const activeRunIds = new Set<string>();
const agentNames = new Map<string, string>();
let waiting = false;
let waitingCtx: ExtensionContext | undefined;
let waitTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;

function emit(payload: unknown): void {
	writeOSC777("warp://cli-agent", serializePayload(payload as Parameters<typeof serializePayload>[0]));
}

function waitingQuery(): string {
	const names = [...new Set(agentNames.values())];
	if (names.length === 0) return `Waiting for ${activeRunIds.size} subagent${activeRunIds.size === 1 ? "" : "s"}...`;
	const shown = names.slice(0, 3).join(", ");
	const more = names.length > 3 ? ` +${names.length - 3}` : "";
	return `Waiting for ${activeRunIds.size} subagent${activeRunIds.size === 1 ? "" : "s"} (${shown}${more})...`;
}

function stopHeartbeat(): void {
	if (heartbeat === undefined) return;
	clearInterval(heartbeat);
	heartbeat = undefined;
}

function cancelWaitTimer(): void {
	if (waitTimer === undefined) return;
	clearTimeout(waitTimer);
	waitTimer = undefined;
}

function leaveWaiting(): void {
	waiting = false;
	waitingCtx = undefined;
	cancelWaitTimer();
	stopHeartbeat();
}

function beginWaiting(ctx: ExtensionContext): void {
	if (waiting || activeRunIds.size === 0) return;
	waiting = true;
	waitingCtx = ctx;
	emit(buildPromptSubmitPayload(ctx, waitingQuery()));
	stopHeartbeat();
	heartbeat = setInterval(() => {
		if (!waitingCtx) return;
		emit(buildPromptSubmitPayload(waitingCtx, waitingQuery()));
	}, HEARTBEAT_MS);
	heartbeat.unref?.();
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	const warp = detectWarpEnvironment();
	if (!warp.isWarp || !warp.supportsStructured) return;
	if (process.env.PI_SUBAGENT_CHILD) return;

	pi.events.on("subagent:async-started", (data) => {
		const record = data as { id?: unknown; agent?: unknown; agents?: unknown } | undefined;
		if (typeof record?.id !== "string" || record.id.length === 0) return;
		activeRunIds.add(record.id);
		if (typeof record.agent === "string" && record.agent.length > 0) {
			agentNames.set(record.id, record.agent);
		} else if (Array.isArray(record.agents)) {
			const names = record.agents.filter((a): a is string => typeof a === "string" && a.length > 0);
			if (names.length > 0) agentNames.set(record.id, [...new Set(names)].join(", "));
		}
	});

	pi.events.on("subagent:async-complete", (data) => {
		const record = data as { runId?: unknown } | undefined;
		const runId = typeof record?.runId === "string" ? record.runId : undefined;
		if (runId) {
			activeRunIds.delete(runId);
			agentNames.delete(runId);
		}
		// Last run finished while the parent sits idle: close the waiting window
		// with a proper stop so Warp drops back to idle for real.
		if (waiting && activeRunIds.size === 0 && waitingCtx) {
			const ctx = waitingCtx;
			leaveWaiting();
			emit(buildStopPayload(ctx, ctx.sessionManager.getBranch()));
		}
	});

	// A parent run starting means rpiv-warp owns the badge again; our heartbeat
	// must stop.
	pi.on("agent_start", () => {
		if (waiting) leaveWaiting();
		cancelWaitTimer();
	});

	// Final boundary: the loop will not continue on its own. If async runs are
	// still outstanding, schedule the working re-report after rpiv-warp's
	// idle_prompt (300ms) so the tab ends up showing activity, not idle.
	pi.on("agent_settled", (_event, ctx) => {
		if (waiting || activeRunIds.size === 0) return;
		cancelWaitTimer();
		waitTimer = setTimeout(() => {
			waitTimer = undefined;
			beginWaiting(ctx);
		}, WAIT_DELAY_MS);
		waitTimer.unref?.();
	});

	pi.on("session_shutdown", () => {
		leaveWaiting();
		activeRunIds.clear();
		agentNames.clear();
	});
}