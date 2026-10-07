# Security

Intrica is intended for individual users and trusted small teams. Its owner
access token authorizes the workspace; it does not provide separate member
accounts or tenant isolation. Use HTTPS or SSH on untrusted networks, and
protect the server account, data directory and backups.

Model endpoints receive the context sent to them. Agent instructions and
tool output are untrusted input. Review resource and host permissions before
allowing execution. Without operating-system isolation, commands have the
server account's privileges; a working directory is not a security boundary.
Independent background writes to the same target can conflict; successful
execution alone does not prove that a later write preserved its output.

## Reporting vulnerabilities

Use the repository's **Security → Report a vulnerability** option when it is
available. If it is unavailable, open an issue requesting a private reporting
channel without including vulnerability details. Do not put credentials,
workspace exports or an exploitable proof of concept in a public issue.

Include the affected version and platform, the trust boundary involved,
minimal reproduction steps, expected behavior and observed impact. Test only
systems and data you are authorized to use.

## Maintenance

Security fixes target the current development branch and the next release.
Check release notes before upgrading an existing database. Back up the
complete workspace; a code downgrade does not reverse a schema migration.

Release downloads use GitHub HTTPS and recorded checksums. Checksums detect
changed bytes, not compromise of the release publisher. Current macOS
packages use ad-hoc signing unless Developer ID signing and notarization are
configured. See [updates and recovery](docs/updating.md).
