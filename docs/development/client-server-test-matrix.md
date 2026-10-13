# Client and server validation

The shared matrix exercises real Web and Electron clients against isolated
built-in and remote servers. Model decisions are scripted; HTTP, workers,
PostgreSQL, permissions, file operations and client requests are real.

## Coverage

- Desktop with its built-in server.
- Browser with server A, then server B and back.
- Desktop with its built-in server, server A and server B.
- Identical canvas IDs across different server identities, isolated drafts
  and rejection of late responses after a connection switch.
- Nested agents, authorized resources, real file and artifact delivery,
  paginated evidence, pending approvals and exactly-once recovery.
- PDF text/images, original media bytes, file navigation and the selected
  server's terminal working directory.
- Offline/reconnect behavior with durable data and approval preservation.

Local server A/B instances simulate independent servers; they do not prove
real remote Linux, SSH or installed-package behavior.

## Run

Build once before running. Do not rebuild or mutate dist concurrently.

```sh
pnpm test:matrix
INTRICA_MATRIX_MODES=web pnpm test:matrix
INTRICA_MATRIX_MODES=desktop pnpm test:matrix
```

Linux Electron requires Xvfb. Use `INTRICA_TEST_EXECUTABLE` for an installed
Desktop executable. Set `INTRICA_MATRIX_REPORT_DIR` to an ignored output
directory when collecting local evidence. Never use a personal workspace.

Installed package, native service, SSH transport, signing and published
upgrade acceptance are separate release checks.

The [RFC acceptance map](rfc-acceptance.md) lists file, input, permission,
recovery and updater checks. Signed installed upgrades are opt-in and start
from the product action; test scripts do not perform the replacement.
