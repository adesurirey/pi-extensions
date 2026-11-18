/**
 * session-name-tool: lets the agent set the current session's display name,
 * so sessions started from a skill are findable later (e.g. `NUM-8080-plan`).
 *
 * Why: skills can only instruct the agent — pi has no built-in way for the
 * agent itself to rename a session. The human-side commands (`/name`,
 * `/rename`) don't help when the naming should happen automatically at skill
 * start. This registers one tool, `set_session_name`, wrapping
 * pi.setSessionName().
 *
 * Contract with the skills that call it:
 * - Unnamed session → renamed directly.
 * - Already named → the tool refuses and returns the current name; the skill
 *   asks the human and only retries with `force: true` on confirmation.
 *   This keeps the tool dumb (no ledger, no heuristics) while protecting
 *   names the human chose via /name.
 *
 * Warp tab sync: pi core updates the tab title on `session_info_changed`, but
 * @juicesharp/rpiv-warp is ticking the title with a suffix captured at
 * `agent_start` and pops the pre-rename title in its own `agent_end` — both
 * clobber the rename when it happens mid-run (which is exactly when tools
 * run; `/name` works only because the human types it while idle). After a
 * rename we therefore re-assert pi's title on `agent_end`, deferred so it
 * lands after rpiv-warp's pop in the same event dispatch.
 *
 * Never registers inside pi-subagents children: child sessions name
 * themselves out of the parent's control, and the parent's naming flow has
 * no business there.
 */

import { basename } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

/** Keeps names compact in the session picker and /resume search. */
const MAX_NAME_LENGTH = 60;

const SetSessionNameParams = Type.Object({
	name: Type.String({
		description:
			"New session display name, e.g. 'NUM-8080-plan' or 'datadog-p95-alert-investigate'.",
	}),
	force: Type.Optional(
		Type.Boolean({
			description:
				"Set to true to overwrite an existing session name. Only do this after the human confirms.",
		}),
	),
});

/** Set on every successful rename; consumed by the agent_end title sync. */
let pendingTitleSync = false;

/**
 * Mirrors pi core's updateTerminalTitle: `${APP_TITLE} - ${session} - ${repo}`,
 * where APP_TITLE is pkg.piConfig?.name ?? "π". piConfig is not reachable from
 * an installed extension, so a customized pi package name would need updating
 * here — pi core's own later title writes (e.g. /name, restart) self-correct.
 */
function buildTitle(ctx: ExtensionContext, sessionName: string | undefined): string {
	const project = basename(ctx.cwd);
	return sessionName ? `π - ${sessionName} - ${project}` : `π - ${project}`;
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD) {
		return;
	}

	pi.on("agent_end", async (_event, ctx) => {
		if (!pendingTitleSync) return;
		pendingTitleSync = false;
		const sessionName = pi.getSessionName()?.trim();
		// Macrotask: runs after all synchronous agent_end handlers, i.e. after
		// rpiv-warp's title pop, so the re-assert is the last write.
		setTimeout(() => {
			ctx?.ui?.setTitle?.(buildTitle(ctx, sessionName));
		}, 0);
	});

	pi.registerTool({
		name: "set_session_name",
		label: "Set Session Name",
		description:
			"Rename the current session. If the session already has a name, the tool refuses and returns it — ask the human before retrying with force: true.",
		parameters: SetSessionNameParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const requested = params.name.trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LENGTH);

			if (!requested) {
				return {
					content: [{ type: "text", text: "Error: name is empty" }],
					details: { renamed: false, error: "empty name" },
				};
			}

			const current = pi.getSessionName();
			if (current && !params.force) {
				return {
					content: [
						{
							type: "text",
							text: `Session already named "${current}". Ask the human whether to rename it to "${requested}"; only retry with force: true if they confirm.`,
						},
					],
					details: { renamed: false, currentName: current, requested },
				};
			}

			pi.setSessionName(requested);
			pendingTitleSync = true;
			return {
				content: [{ type: "text", text: `Session renamed to "${requested}".` }],
				details: { renamed: true, name: requested },
			};
		},
	});
}
