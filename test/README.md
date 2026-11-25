# Tests and diagnostics

## Test suite

`npm test` runs `scripts/check-extension.mjs`, a dependency-light Node script. It loads the TextMate grammar with the bundled `vscode-textmate` and `vscode-oniguruma` libraries (the same ones VS Code uses), tokenizes the fixtures in `test/fixtures/` and asserts:

- the exact scope assigned to representative tokens in ST, FBD, SFC, DUT, configuration, task and project files
- the color a theme resolves for those scopes, using the deterministic test theme in `test/theme/cfi-test-theme.json`: call names render with the theme function color, ST and FBD call parameters render with an identical parameter color, plain variables are left untouched
- the spans of the function block instance semantic tokens (only the instance name in a direct output access, never the output member)
- POU variable section parsing, FBD references, mixed indentation and raw line endings on the fixture files

The suite does not validate CAP-specific SFC serialization or compile PLC projects.

## Static diagnostics

The extension reports the following diagnostics in the Problems panel (source `CAP1131 CFI`). Diagnostics never modify the file.

- **Undeclared variable:** occurrences in ST bodies and in the variable/FB-instance fields of serialized FBD records are compared with the declarations in the current POU's `VAR` sections. `VAR_EXTERNAL`, `VAR_INPUT`, `VAR_OUTPUT`, `VAR_IN_OUT`, constants and the function return name count as declarations. No cross-file variable index is used. The check is intentionally conservative: it skips keywords and types, typed literals, structure fields and call names (which may be functions or FB calls). It is a typo/declaration aid, not a full symbol or type resolver. Unresolved names are shown in bold with the theme error color.
- **Line endings:** the saved file bytes are checked directly (VS Code may normalize the text buffer), so mixed files are detected even while open. Any LF without a preceding CR, and any bare CR, is an error; CAP1131 CFI files use CRLF. The check runs on open and on save.
- **Indentation:** only a leading prefix that mixes tabs and spaces is reported, in bold with the theme warning color. Consistently space- or tab-indented lines are accepted.
- **Disabled FBD networks:** the full `NET_WORK` ... `END_NET_WORK` range is dimmed and italicized when it contains `NETWORK_DISABLED:=TRUE`.
- **FBD connector markers:** every `?[A-Z]` marker is dimmed with a shared hint color. In `B_FB` records `?B...` marks an input pin and `?A...` an output pin, and the name keeps its variable-parameter scope. `?C`/`?D` also occur in `B_F` function records.
- **Muted boilerplate:** braced metadata delimiters, `B(` wrappers, trailing `);`, serialized section markers and FBD coordinates use muted scopes, so numeric values and code identifiers stay visually distinct. `END_VAR` carries a muted suffix naming its variable section (`_OUTPUT`, `_EXTERNAL_CONSTANT`, `_CONSTANT`, `_LOCAL`).

## SFC coverage and limits

The SFC token rules follow IEC 61131-3 (2003) section 2.6 and Annex B.1.6 (textual syntax): `INITIAL_STEP ... END_STEP`, `STEP ... END_STEP`, named and prioritized `TRANSITION ... FROM ... TO ... END_TRANSITION`, `ACTION ... END_ACTION`, the action qualifiers (`L`, `S`, `R`, `D`, `SD`, `DS`, `SL`, `P`, `P0`, `P1`, `N`) and common IL instructions in transition and action bodies. SFC can contain ST, FBD or LD bodies; the grammar highlights the available ST/FBD syntax but does not model graphical chart or LD layout and does not validate SFC topology or semantics. Compatibility with CAP1131's proprietary serialization is not yet verified against a CAP-exported SFC sample.
