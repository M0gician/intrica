# Distribution licenses

Intrica source is licensed under [MIT](../../LICENSE). Dependencies retain
their own licenses. Include Intrica's license in desktop and native server
packages, and preserve upstream license files and notices in bundled
dependencies. The container includes the repository license.

For each target platform, install the locked production dependency graph
and inspect `pnpm licenses list --prod`. Platform-specific optional packages
must be checked on their target platform. This command reports package
metadata; it does not enumerate every library inside a native binary.

In particular, `@img/sharp-libvips-*` contains LGPL-3.0-or-later components
and libraries under other licenses. Its package README lists those
components, and `versions.json` records their versions. Preserve these
notices, provide the applicable license texts and corresponding source as
required by each license, and verify the distribution permits replacement
of the LGPL-covered shared libraries. Upstream build recipes and source
references are in [sharp-libvips](https://github.com/lovell/sharp-libvips).
Intrica's MIT license does not relicense those components.

Native server packaging also includes Node.js and its `NODE-LICENSE` file.
Desktop packages include Electron and Chromium, and the embedded PostgreSQL
runtime has its own notices. Review the actual packaged files before binary
publication; a source license declaration alone does not establish binary
distribution compliance.
