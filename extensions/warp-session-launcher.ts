/**
 * warp-session-launcher: lets the agent open a new, independent interactive Pi
 * session in a new Warp tab, with a chosen model, thinking level, name and prompt.
 *
 * How it works: Warp's `warp://action/new_tab` URI cannot run a command, so we
 * write a single Tab Config (~/.warp/tab_configs/pi_warp_session_launcher.toml,
 * overwritten on every launch) and open it via `warp://tab_config/<name>`.
 * The prompt lives in the OS temp dir and is read with `$(cat …)` so arbitrary
 * text survives shell quoting. Nothing needs cleaning up.
 *
 * Only registers inside Warp on macOS, and never inside pi-subagents children.
 * Not related to the npm `rpiv-warp` package (Warp notifications).
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

const TOOL_NAME = "warp_launch_session";
const TAB_CONFIG_NAME = "pi_warp_session_launcher";
const TAB_CONFIG_PATH = path.join(os.homedir(), ".warp", "tab_configs", `${TAB_CONFIG_NAME}.toml`);
// Warp reads the Tab Config while handling the URI; hold the file this long before another launch may overwrite it.
const TAB_CONFIG_HOLD_MS = 1500;
const PROMPT_PREVIEW_CHARS = 400;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function isInsideWarpOnMac(): boolean {
	return process.platform === "darwin" && process.env.TERM_PROGRAM === "WarpTerminal";
}

function isSubagentChild(): boolean {
	return Boolean(process.env.PI_SUBAGENT_CHILD);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

// JSON string escapes (\" \\ \n \uXXXX) are valid TOML basic-string escapes.
const tomlString = (value: string): string => JSON.stringify(value);

function resolveModelRef({ ctx, model }: { ctx: ExtensionContext; model: string }): string {
	if (/:[a-z]+$/.test(model)) {
		throw new Error(`Pass the thinking level via "thinking", not as a ":level" suffix on the model ("${model}").`);
	}
	const available = ctx.modelRegistry.getAvailable();
	const slash = model.indexOf("/");
	if (slash > 0) {
		const provider = model.slice(0, slash);
		const id = model.slice(slash + 1);
		if (available.some((m) => m.provider === provider && m.id === id)) return model;
	}
	const byId = available.filter((m) => m.id === model);
	if (byId.length === 1) return `${byId[0].provider}/${byId[0].id}`;
	const candidates = (byId.length > 1 ? byId : available).map((m) => `${m.provider}/${m.id}`);
	throw new Error(
		`${byId.length > 1 ? "Ambiguous" : "Unknown or unavailable"} model "${model}". Use one of: ${candidates.join(", ")}`,
	);
}

async function resolveCwd({ ctx, cwd }: { ctx: ExtensionContext; cwd?: string }): Promise<string> {
	const expanded = cwd?.replace(/^~(?=$|\/)/, os.homedir());
	const resolved = path.resolve(ctx.cwd, expanded ?? ".");
	const stat = await fs.stat(resolved).catch(() => undefined);
	if (!stat?.isDirectory()) throw new Error(`Working directory does not exist: ${resolved}`);
	// Real path, because pi groups sessions by its process.cwd() (e.g. /tmp -> /private/tmp).
	return fs.realpath(resolved);
}

// Mirrors pi's session dir naming: drop the leading separator, replace / \ : with -, wrap in --.
const encodeCwdForSessionDir = (cwd: string): string => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

function sessionDirFor({ ctx, cwd }: { ctx: ExtensionContext; cwd: string }): string {
	const parentSessionDir = ctx.sessionManager.getSessionDir();
	const usesPerCwdLayout = path.basename(parentSessionDir) === encodeCwdForSessionDir(ctx.sessionManager.getCwd());
	return usesPerCwdLayout ? path.join(path.dirname(parentSessionDir), encodeCwdForSessionDir(cwd)) : parentSessionDir;
}

function piCommandPrefix(): string[] {
	// `pi` on PATH points into an ephemeral fnm multishell dir, so pin the real node + CLI of this process.
	return [process.execPath, realpathSync(process.argv[1])];
}

function buildPiCommand({
	model,
	thinking,
	name,
	sessionId,
	promptFile,
}: {
	model?: string;
	thinking?: string;
	name: string;
	sessionId: string;
	promptFile: string;
}): string {
	const args = [
		...piCommandPrefix(),
		...(model ? ["--model", model] : []),
		...(thinking ? ["--thinking", thinking] : []),
		"--name",
		name,
		"--session-id",
		sessionId,
	];
	return `${args.map(shellQuote).join(" ")} -- "$(cat ${shellQuote(promptFile)})"`;
}

function buildTabConfig({ cwd, command }: { cwd: string; command: string }): string {
	return [
		`name = ${tomlString("Pi session launcher (last launch)")}`,
		"",
		"[[panes]]",
		`id = "pi"`,
		`type = "terminal"`,
		`directory = ${tomlString(cwd)}`,
		`commands = [${tomlString(command)}]`,
		"",
	].join("\n");
}

let launchQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
	const run = launchQueue.then(task, task);
	launchQueue = run.catch(() => undefined);
	return run;
}

async function openInWarp({ tabConfig }: { tabConfig: string }): Promise<void> {
	await fs.mkdir(path.dirname(TAB_CONFIG_PATH), { recursive: true });
	await fs.writeFile(TAB_CONFIG_PATH, tabConfig, "utf8");
	await execFileAsync("open", [`warp://tab_config/${TAB_CONFIG_NAME}`]);
	await new Promise((resolve) => setTimeout(resolve, TAB_CONFIG_HOLD_MS));
}

function describeLaunch({
	model,
	thinking,
	name,
	cwd,
	prompt,
}: {
	model?: string;
	thinking?: string;
	name: string;
	cwd: string;
	prompt: string;
}): string {
	const preview = prompt.length > PROMPT_PREVIEW_CHARS ? `${prompt.slice(0, PROMPT_PREVIEW_CHARS)}…` : prompt;
	return [
		`Name:     ${name}`,
		`Model:    ${model ?? "(pi default)"}`,
		`Thinking: ${thinking ?? "(pi default)"}`,
		`Cwd:      ${cwd}`,
		"",
		preview,
	].join("\n");
}

const warpLaunchSessionTool = defineTool({
	name: TOOL_NAME,
	label: "Warp: launch Pi session",
	description:
		"Open a NEW, independent, interactive Pi session in a new Warp terminal tab, started with the given prompt. " +
		"The user works with that session directly; its output is NOT returned to you. " +
		"Use it only when the user asks to start/launch/spin off a separate Pi session or tab. " +
		"For delegating work whose result you need, use subagents instead. The user must approve each launch.",
	promptSnippet: "Open a new interactive Pi session in a new Warp tab (user-facing, fire-and-forget)",
	// Pi's extension dialogs share one slot: a parallel call's confirm would replace this one and leave it unresolved forever.
	executionMode: "sequential",
	parameters: Type.Object({
		prompt: Type.String({ description: "Initial prompt sent to the new session." }),
		model: Type.Optional(
			Type.String({ description: 'Model as "provider/id" (e.g. "anthropic/claude-opus-5-5"). Defaults to pi default.' }),
		),
		thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Thinking level. Defaults to pi default." })),
		name: Type.String({
			description: "Short, descriptive session display name (e.g. 'NUM-123 refactor auth'). Always choose one yourself.",
		}),
		cwd: Type.Optional(
			Type.String({ description: "Working directory for the new session. Defaults to the current cwd." }),
		),
	}),

	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		if (!isInsideWarpOnMac()) {
			return {
				content: [{ type: "text", text: "Not running inside Warp on macOS; no session was launched." }],
				details: { launched: false },
			};
		}
		if (!ctx.hasUI) throw new Error("Launching a Warp session requires user approval, but no UI is available.");

		const prompt = params.prompt.trim();
		if (!prompt) throw new Error("prompt must not be empty.");
		const model = params.model ? resolveModelRef({ ctx, model: params.model }) : undefined;
		const name = params.name.trim();
		if (!name) throw new Error("name must not be empty: choose a short, descriptive session name.");
		const cwd = await resolveCwd({ ctx, cwd: params.cwd });
		const { thinking } = params;

		const approved = await ctx.ui.confirm(
			"Launch Pi session in a new Warp tab?",
			describeLaunch({ model, thinking, name, cwd, prompt }),
			{ signal },
		);
		if (signal?.aborted) {
			return {
				content: [{ type: "text", text: "The launch was cancelled before approval. No session was launched." }],
				details: { launched: false },
			};
		}
		if (!approved) {
			return {
				content: [{ type: "text", text: "The user declined the launch. Do not retry unless they ask again." }],
				details: { launched: false },
			};
		}

		const sessionId = randomUUID();
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-warp-session-"));
		const promptFile = path.join(tempDir, "prompt.md");
		await fs.writeFile(promptFile, prompt, "utf8");

		const command = buildPiCommand({ model, thinking, name, sessionId, promptFile });
		const tabConfig = buildTabConfig({ cwd, command });
		await serialized(() => openInWarp({ tabConfig }));
		const sessionFileGlob = `${shellQuote(sessionDirFor({ ctx, cwd }))}/*_${sessionId}.jsonl`;

		return {
			content: [
				{
					type: "text",
					text: [
						`Launched a new Pi session in a Warp tab (session id ${sessionId}).`,
						`Name: ${name} · model: ${model ?? "pi default"} · thinking: ${thinking ?? "pi default"} · cwd: ${cwd}`,
						`Resume later from that cwd with: pi --session ${sessionId}`,
						"",
						`To check on it later, read its live transcript (JSONL, appended per completed message): ${sessionFileGlob}`,
						"Don't cat/read it whole: its first lines hold the full system prompt and tool list. Use e.g.",
						`  tail -n 20 ${sessionFileGlob} | jq -c 'select(.type=="message") | .message | {role, stopReason, content: (.content | if type=="string" then .[:300] else map((.text // .name // .type) | .[:300])[:5] end)}'`,
					].join("\n"),
				},
			],
			details: { launched: true, sessionId, name, model, thinking, cwd, command, sessionFileGlob },
		};
	},
});

export default function (pi: ExtensionAPI) {
	if (!isInsideWarpOnMac() || isSubagentChild()) return;
	pi.registerTool(warpLaunchSessionTool);
}
