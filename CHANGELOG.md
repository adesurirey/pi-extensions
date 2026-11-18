# Changelog

## [1.0.0]

Initial release.

- `theme-sync` — follow macOS light/dark appearance and switch pi's theme
- `warp-session-launcher` — open new pi sessions in new Warp tabs from the agent
- `warp-subagent-status` — keep Warp's active indicator honest while async subagents run

## [1.0.1]

- Fix `warp-subagent-status` to import `@juicesharp/rpiv-warp` by package name and declare it as a dependency, so the package loads from any install location (git cache, npm, local).
