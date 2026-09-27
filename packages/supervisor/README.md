# Worker supervision

`WorkerSupervisor` runs explicitly approved trusted-local child processes with a
hard deadline, bounded combined output, abort/cancel, and global stop. It uses
`spawn` with `shell: false` and `windowsHide: true`. Cancellation accepts only a
live identity minted by this supervisor (worker, attempt, fencing generation,
nonce, and supervisor start timestamp); there is no arbitrary PID kill API.
The timestamp is a controller record, not an OS process creation attestation.
Caller inputs are copied before dispatch. Output is untrusted data, never a
verification receipt or an authority to change task state.

Windows uses the system `taskkill.exe /PID <owned pid> /T`, escalating to `/F`.
The initial Windows request is best-effort graceful termination, not a promise
that console applications support resumable/cooperative shutdown. Linux creates
a dedicated process group and sends SIGTERM, then SIGKILL. Cancellation waits
up to seven seconds for shutdown; inconclusive shutdown returns `needs_attention`.
The process timeout begins at spawn; shutdown time is additional.

These mechanisms are **not a security sandbox**. A process that escapes its
group, or a Windows root that exits before descendants can be enumerated, may
leave descendants. No Windows Job Object or Linux cgroup is installed. Execution
capabilities therefore report process-tree containment, filesystem isolation,
network isolation, and hostile-code containment as false. Sandbox-required
profiles fail closed. Restrict this API to trusted, user-approved programs.
Persistent reconnection and OS creation-time attestation are not implemented;
controller restart must reconcile uncertain operations and must never kill a
persisted PID or blindly resend a command.

Tests run actual local child processes, including an ordinary grandchild tree,
forced deadline, abort, cancellation, forged identities, global stop, missing
executable, and arbitrary-byte output. Windows was exercised locally; Linux
support needs CI qualification.
