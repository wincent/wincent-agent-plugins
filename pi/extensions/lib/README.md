Shared modules live in this subdirectory (without an `index.ts`), so Pi's extension loader ignores them (it only loads top-level `*.ts` files and subdirectories that contain an `index.ts` or a `package.json` with a `pi` field).

## Subagent state

`subagent-state.ts` provides opt-in, namespaced JSON snapshots for cooperative extensions. Register `provideSubagentState(pi, 'my-extension', () => value)` in the extension factory. The getter must be synchronous and return a small JSON value, never credentials. The subagent extension calls `collectSubagentState(pi)` at dispatch and passes the result in the child's environment, not its prompt, wrapper, metadata, or bus log. Communication within each Pi process uses `pi.events`, not a module singleton.

Call `takeSubagentState('my-extension')` in the child's `session_start` handler and validate the returned value before using it. Missing or malformed snapshots return `undefined`; each namespace is consumed from the environment once, so a reload or session reset cannot restore it. Unregistered state is not forwarded. Later parent changes affect future children only. Both sandboxed and unsandboxed children use the same transport without changing their inherited OS or proxy capabilities.

This is workflow state, not authenticated authorization. An agent with shell access can forge environment values or bypass extension checks.
