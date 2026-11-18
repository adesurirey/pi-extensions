# Changelog

## [1.1.1]

- `session-name-tool` — re-assert pi's tab title on `agent_end` after a rename, so the Warp tab reflects it despite rpiv-warp's spinner suffix (captured at `agent_start`) and title pop clobbering mid-run renames.

## [1.1.0]

- `session-name-tool` — let the agent rename the current session (`set_session_name` tool); refuses on an existing name so the agent asks the human first.

## [1.0.0]

Initial release.

- `theme-sync` — follow macOS light/dark appearance and switch pi's theme
- `warp-session-launcher` — open new pi sessions in new Warp tabs from the agent
- `warp-subagent-status` — keep Warp's active indicator honest while async subagents run

## [1.0.4]

- Reference rpiv-warp helpers through `node_modules` file paths — package-root imports lose named exports under jiti.

## [1.0.3]

- Import rpiv-warp helpers from the package root — its exports map blocks subpath imports like `@juicesharp/rpiv-warp/payload.ts`.

## [1.0.2]

- Also convert the `payload.ts` import to the package specifier (missed in 1.0.1).

## [1.0.1]

- Fix `warp-subagent-status` to import `@juicesharp/rpiv-warp` by package name and declare it as a dependency, so the package loads from any install location (git cache, npm, local).
