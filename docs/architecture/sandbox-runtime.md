# Usable isolated execution

An Agent command uses the same interpreter, environment, filesystem grants and
process guardian whether it launches a compiler, a package manager or a browser.
Host execution is an explicit mode. Browser startup does not silently change the
command to host execution.

## Runtime discovery

list_capabilities returns the running Node interpreter even when it is provided
by Electron. Browser distribution paths are indexed separately from personal
browser profiles. A discovered binary has verification=unverified; this does not
certify that its dependencies, launch or rendering work. defaultExecutionMode
describes the default command path and fullHostAvailable describes authority for
an explicit host command. Registered environments retain versioned interpreter
and directory identity, with access checked again before reuse.

HOME, Cocoa's CFFIXED_USER_HOME, TMPDIR and XDG cache/config/data/runtime locations
point to the Agent workspace. The workspace creates private scratch directories.
Installed browser distributions are mounted or granted read-only. Browser
profiles and generated screenshots use the writable workspace.

## macOS

The Seatbelt policy permits process lifecycle operations within the sandbox,
public runtime libraries and fonts, DNS/TLS services, power notifications and
application registration needed by headless browsers. Browser IPC registration
and lookup use named browser prefixes. The policy does not enable unrestricted
Mach lookup or global preferences access.

Cocoa can use the native Darwin user temp directory independently of TMPDIR.
The policy queries that directory and permits browser-prefixed scratch entries
there. It does not expose the whole host temp directory. Server secrets,
PostgreSQL, configuration, RPC state and executable code retain their existing
protections, including under broad filesystem grants.

The browser regression starts a real browser inside the OS sandbox, loads a
local HTTP page, reads actual WebGL pixels after a click, writes a PNG screenshot,
and checks private files through both Node and browser navigation. The test uses
no renderer, DOM or input stubs.

## Linux

Bubblewrap retains isolated process and IPC namespaces, shared host networking,
public system libraries and certificates, explicit writable roots and private
file masks. An isolated /dev/shm supports browser shared memory. Installed browser
distributions are read-only binds. Native libraries and browser runtime versions
still require a compatible installation on the host.

## Cross-checks

- [Codex Seatbelt base policy](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl) separates process, IPC and public runtime allowances.
- [Codex platform defaults](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/sandboxing/src/seatbelt_read_only_platform_defaults.sbpl) identify macOS loader and system-service dependencies.
- [Codex preference policy](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/sandboxing/src/seatbelt_preferences_policy.sbpl) limits preference IPC to unrestricted-read configurations. Intrica retains scoped reads.
- [Chromium process singleton](https://github.com/chromium/chromium/blob/main/chrome/browser/process_singleton_posix.cc) creates a separate temporary socket directory. A writable profile directory alone does not cover it.
- [Codex app-server steering](https://learn.chatgpt.com/docs/app-server) appends input to an active turn, checks its identity, and separates steering from interruption.
- [Codex send_input](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/core/src/tools/handlers/multi_agents/send_input.rs) uses a flat recipient and separate interrupt choice. Intrica retains request ownership and reply obligations in addition to a flat model-facing address.
- [Responses steering](https://developers.openai.com/api/docs/guides/steering) distinguishes provider acceptance from application of input and preserves already-started tools. Intrica's current adapters use bounded cancel/drain/continue rather than claiming native support.
- [Function calling](https://developers.openai.com/api/docs/guides/function-calling) describes strict schema requirements. Intrica's flat model envelope uses one execution contract and field-level semantic errors across configured providers.
