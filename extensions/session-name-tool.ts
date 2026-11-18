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
 * Never registers inside pi-subagents children: child sessions name
 * themselves out of the parent's control, and the parent's naming flow has
 * no business there.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD) {
		return;
	}

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
			return {
				content: [{ type: "text", text: `Session renamed to "${requested}".` }],
				details: { renamed: true, name: requested },
			};
		},
	});
}
