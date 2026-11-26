# CAP1131 CFI for VS Code

Syntax highlighting and language support for CAP1131 IDE `.cfi` project files (IEC 61131-3).

## Features

- TextMate syntax highlighting for `.cfi` files:
  - Structured Text: declarations, control flow, types, literals, `(* ... *)` comments
  - IEC 61131-3 textual SFC: steps, transitions, actions, action qualifiers, time literals
  - FBD exports: FB and function records, variables, comments, connectors
  - DUT `TYPE ... STRUCT` declarations
  - Object and configuration records, task/resource configuration, project settings sections
- Semantic tokens for function block instances: in `Timer.Q` the instance name `Timer` is highlighted, the output member is not
- Static diagnostics in the Problems panel: mixed line endings (CAP1131 uses CRLF), mixed tab/space indentation, undeclared variable names in ST and FBD sections; disabled FBD networks are dimmed
- ISO 8859-1 encoding defaults for `.cfi` documents

The extension does not format source, compile PLC code or replace CAP1131 project validation. The details of the diagnostics and the test coverage are documented in `test/README.md`.

## Installation

**VS Code Marketplace:** search for **CAP1131 CFI for VS Code** and install `htotheb.vscode-cap1131-cfi`.

**GitHub release:** each tagged version gets a release with a `.vsix` file, the standard VS Code extension package. Download `cap1131-cfi-<version>.vsix` from the [Releases](https://github.com/HtoTheB/vscode-cap1131-cfi/releases) page, then either:

- in VS Code: Extensions view → **Manage** menu (`...`) → **Install from File...**, and select the downloaded file, or
- in a terminal: `code --install-extension cap1131-cfi-<version>.vsix`

Installing from a file needs no Marketplace account and works for versions that are not published to the Marketplace yet.

## Development

1. Open this folder in VS Code and press **F5** to launch an Extension Development Host.
2. Open a `.cfi` file there; if the file is shown as another language, use **Change Language Mode → cap1131-cfi**.
3. Run `npm test` to tokenize the fixtures in `test/fixtures/` with the bundled TextMate/Oniguruma libraries and assert scopes, resolved theme colors and the static checks.

## AI in development

Large language models (LLMs) were used in the development process of this extension — for design, implementation, review and documentation. Commits created with AI assistance are recorded with an `Assisted-by: LLM` trailer. The design decisions and the review of the result are the maintainer's.

## License

BSD 3-Clause, see [LICENSE](LICENSE).
