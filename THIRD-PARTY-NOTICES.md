# Third-party components

The lockfiles identify the exact dependencies. Package licenses must be included or preserved when distributing bundled dependency binaries, rather than replacing their notices with the original project's license.

- React / React DOM — MIT.
- TradingView Lightweight Charts — Apache-2.0. Keep the existing TradingView attribution link/logo and required notices. This project does not redistribute TradingView market data.
- OpenAI Codex CLI — Apache-2.0. Model access is a separate service and requires the user's own authorization.
- TypeScript — Apache-2.0; Vite and vinext — MIT; Cloudflare Wrangler — MIT OR Apache-2.0.
- Python and tzdata — retain the upstream license notices from the installed distributions. The locked requirements specify tzdata. The launcher downloads a pinned Astral python-build-standalone distribution into this copy; it does not replace Python's license or install a system runtime.
- Node.js and pnpm — the launcher downloads fixed upstream distributions into `.tools/`, preserving their packaged license notices. Those binaries are not included in this source archive.

The source archive contains source and dependency locks, not node_modules, dependency binaries or a Python runtime. MIT applies only to the original project code; do not remove upstream notices or apply MIT over third-party code.

Installed transitive metadata also identifies `@img/sharp-win32-x64` as Apache-2.0 AND LGPL-3.0-or-later; `@resvg/resvg-wasm`, `@vercel/og`, `axe-core`, `lightningcss`, `lightningcss-win32-x64-msvc` and `satori` as MPL-2.0; and `caniuse-lite` as CC-BY-4.0. Other installed components include BSD, ISC, CC0, Python-2.0 and BlueOak licenses. Their installed packages carry the upstream license files. Recheck these obligations if distributing compiled bundles, changing dependencies or bundling native binaries.

This metadata inventory is not legal clearance for data, trademarks, or a changed distribution format.

Provider and upstream component names identify integration targets, not affiliation or endorsement. The package does not convey their subscriptions, data licenses or trademarks.
