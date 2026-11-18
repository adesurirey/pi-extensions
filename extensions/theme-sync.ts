/**
 * theme-sync: follow the macOS system appearance (light/dark) and switch
 * Pi's theme accordingly.
 *
 * Why: Warp doesn't support the CSI ? 2031 dark/light notification protocol
 * (warpdotdev/Warp#9834 is unmerged), so Pi's built-in "light/dark" auto mode
 * never hears about appearance changes under Warp. Since Warp follows the OS
 * theme, we poll macOS directly instead.
 *
 * Reuses your existing `theme` setting — no new config. If it's already a
 * pair like "light/dark", that pair is used. If it's a single theme name, you
 * get a one-time hint to set a pair.
 *
 * Theme switching uses Theme instances (ctx.ui.setTheme(theme)), so your
 * settings.json is never written.
 *
 * Commands:
 *   /theme-sync          show status
 *   /theme-sync on|off   enable/disable for this session
 */

import { execFile } from "node:child_process";
import * as os from "node:os";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const POLL_MS = 3000;

interface SyncState {
	enabled: boolean | undefined; // undefined = auto (on when theme setting is a pair)
	timer: NodeJS.Timeout | undefined;
	currentAppearance: "light" | "dark" | undefined;
	lightName: string | undefined;
	darkName: string | undefined;
	hinted: boolean;
}

const state: SyncState = {
	enabled: undefined,
	timer: undefined,
	currentAppearance: undefined,
	lightName: undefined,
	darkName: undefined,
	hinted: false,
};

/** Read macOS system appearance. "Dark" means dark; missing key means light. */
function readSystemAppearance(): Promise<"light" | "dark" | undefined> {
	return new Promise((resolve) => {
		execFile(
			"defaults",
			["read", "-g", "AppleInterfaceStyle"],
			{ timeout: 1500 },
			(error, stdout) => {
				if (error) {
					// Key doesn't exist => light mode (default), or a real failure.
					// Distinguish via error code 1 (key missing) vs anything else.
					const code = (error as NodeJS.ErrnoException & { code?: number }).code;
					resolve(code === 1 ? "light" : undefined);
					return;
				}
				resolve(stdout.trim().toLowerCase() === "dark" ? "dark" : "light");
			},
		);
	});
}

function parseThemePair(themeSetting: string | undefined): { light: string; dark: string } | undefined {
	if (!themeSetting || !themeSetting.includes("/")) return undefined;
	const [light, dark] = themeSetting.split("/", 2);
	if (!light || !dark) return undefined;
	return { light, dark };
}

interface UiLike {
	ui: {
		getTheme(name: string): { name?: string } | undefined;
		setTheme(theme: unknown): { success: boolean; error?: string };
		theme: unknown;
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
	hasUI: boolean;
}

async function syncTheme(ctx: UiLike) {
	const appearance = await readSystemAppearance();
	if (!appearance) return;
	state.currentAppearance = appearance;

	const target = appearance === "dark" ? state.darkName : state.lightName;
	if (!target || !ctx.hasUI) return;

	const instance = ctx.ui.getTheme(target);
	if (!instance) {
		if (!state.hinted) {
			state.hinted = true;
			ctx.ui.notify(`theme-sync: theme "${target}" not found`, "warning");
		}
		return;
	}

	const current = ctx.ui.theme as { name?: string } | undefined;
	// Avoid redundant switches.
	if (current?.name === target) return;

	const result = ctx.ui.setTheme(instance);
	if (result && !result.success) {
		ctx.ui.notify(`theme-sync: failed to switch to "${target}"`, "error");
	}
}

function startPolling(ctx: UiLike) {
	if (state.timer) return;
	state.timer = setInterval(() => {
		void syncTheme(ctx);
	}, POLL_MS);
	// Fire once immediately.
	void syncTheme(ctx);
}

function stopPolling() {
	if (state.timer) {
		clearInterval(state.timer);
		state.timer = undefined;
	}
}

export default function themeSyncExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (process.platform !== "darwin") return;

		const pair = parseThemePair(pi.getSettings().theme as string | undefined);
		if (pair) {
			if (pair.light === pair.dark) {
				// Degenerate pair, e.g. "system/system": switching is a no-op.
				if (ctx.hasUI && !state.hinted) {
					state.hinted = true;
					ctx.ui.notify(
						`theme-sync: theme setting is "${pair.light}/${pair.dark}" — both sides are the same, so nothing to switch. Set Theme to two different names in /settings (e.g. light/dark).`,
						"warning",
					);
				}
				return;
			}
			state.lightName = pair.light;
			state.darkName = pair.dark;
			if (state.enabled !== false) startPolling(ctx);
		} else if (!state.hinted) {
			state.hinted = true;
			if (ctx.hasUI) {
				ctx.ui.notify(
					'theme-sync: set Theme to "light/dark" in /settings to enable OS appearance sync',
					"info",
				);
			}
		}
	});

	pi.on("session_shutdown", () => stopPolling());

	pi.registerCommand("theme-sync", {
		description: "Toggle macOS light/dark theme sync (on|off|status)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const arg = args.trim().toLowerCase();

			if (arg === "on" || arg === "off") {
				state.enabled = arg === "on";
				if (state.enabled && state.lightName) startPolling(ctx);
				if (!state.enabled) stopPolling();
			} else if (arg === "status") {
				const enabled = state.enabled !== false && !!state.timer;
				ctx.ui.notify(
					`theme-sync: ${enabled ? "on" : "off"} · ` +
						`appearance: ${state.currentAppearance ?? "unknown"} · ` +
						`light: ${state.lightName ?? "-"} · dark: ${state.darkName ?? "-"} · ` +
						`os: ${process.platform === "darwin" ? "macOS" : os.platform() + " (unsupported)"}`,
					"info",
				);
				return;
			}

			const enabled = state.enabled !== false && !!state.timer;
			ctx.ui.notify(`theme-sync ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});
}
