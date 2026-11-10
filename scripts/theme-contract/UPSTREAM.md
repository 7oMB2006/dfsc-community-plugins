# Theme Composition Parser

- Source repository: `7oMB2006/desktop-for-step-code`
- Source commit: `a72e550f3954ea6d957b7f8506f8ef8106b3fa08` (merged main)
- Source file: `Desktop/electron/theme-composition.mjs`
- License: MIT, included in this directory.
- SHA-256 (LF): `b3dbfac0c3ea726289cf121aa9f2d78dd5054a872a42770abdfb78f37cb1dfa2`

`theme-composition.mjs` is an unchanged data parser, not a plugin renderer.
The checker never downloads or executes author code. Updating this copy requires
reviewing a fixed host commit, recording the new hash and rerunning the contract
tests. Hash verification ignores CRLF checkout conversion, not content changes.

The companion checker adds marketplace resource checks. It does not claim to
replace the host's native image decoder, full scene-geometry validation, plugin
permissions, lifecycle or visual/platform acceptance.
