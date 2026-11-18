# pi-extensions

Personal extensions for the [pi coding agent](https://pi.dev), packaged for
installation via the pi CLI:

```sh
pi install git:github.com/adesurirey/pi-extensions
```

Unpinned git sources are fetched and reset to the default branch on every pi
start and `/reload`, so a push here propagates to every laptop on its next
start.

## Extensions

### theme-sync

Follows the macOS system appearance (light/dark) and switches pi's theme
accordingly. Warp doesn't support the CSI ? 2031 dark/light notification
protocol, so pi's built-in "light/dark" auto mode never hears about appearance
changes under Warp — this extension polls macOS directly instead. Reuses the
existing `theme` setting; if it is a single theme name, it hints you to set a
pair like `"light/dark"`.

Commands:

- `/theme-sync` — show status
- `/theme-sync on|off` — enable/disable for this session

### warp-session-launcher

Lets the agent open a new, independent interactive pi session in a new Warp
tab, with a chosen model, thinking level, name and prompt. Warp's
`warp://action/new_tab` URI cannot run a command, so the extension writes a
single tab config (`~/.warp/tab_configs/pi_warp_session_launcher.toml`) and
opens it via `warp://tab_config/<name>`. Only registers inside Warp on macOS,
and never inside pi-subagents children.

### warp-subagent-status

Keeps Warp showing the tab as active while pi-subagents async runs are
outstanding and the parent agent has settled. `@juicesharp/rpiv-warp` drives
Warp's badge/spinner off the agent-loop lifecycle only, so async subagent runs
make Warp emit `stop` + `idle_prompt` while work is still going. This
extension tracks the `subagent:async-started` / `subagent:async-complete`
events and re-emits rpiv-warp's own payload shapes until the last run
completes. Requires `npm:@juicesharp/rpiv-warp` to be installed.

### session-name-tool

Lets the agent rename the current session via a `set_session_name` tool,
wrapping pi's `setSessionName()`. pi has no built-in way for the agent itself
to rename a session, and skills that start from a Jira ticket want the session
named `NUM-8080-plan`-style at start, not LLM-generated.

Contract:

- Unnamed session → renamed directly.
- Already named (e.g. via `/name`) → the tool refuses and returns the current
  name; the agent asks the human and only retries with `force: true` on
  confirmation.

Never registers inside pi-subagents children. The aircall-skills repo's
`investigate`, `implement`, `plan`, `release-microservice` and
`dual-investigate` skills call this tool.
