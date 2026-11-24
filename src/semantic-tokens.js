'use strict';

const FUNCTION_SEMANTIC_TOKEN_TYPE = 'function';
const FUNCTION_BLOCK_DOCUMENT_SELECTOR = [
  { language: 'cap1131-cfi' },
  // Workspaces may associate .cfi files with a generic ST language instead of cap1131-cfi.
  { pattern: '**/*.cfi' }
];

function buildFunctionBlockOutputSemanticTokens(document, accesses) {
  const tokens = [];

  for (const access of accesses) {
    const start = document.positionAt(access.start);
    const end = document.positionAt(access.end);
    if (start.line !== end.line || end.character <= start.character) continue;
    tokens.push({
      line: start.line,
      start: start.character,
      length: end.character - start.character,
      type: FUNCTION_SEMANTIC_TOKEN_TYPE
    });
  }

  return tokens;
}

function pushFunctionBlockOutputSemanticTokens(vscode, builder, document, accesses) {
  for (const token of buildFunctionBlockOutputSemanticTokens(document, accesses)) {
    const range = new vscode.Range(
      new vscode.Position(token.line, token.start),
      new vscode.Position(token.line, token.start + token.length)
    );
    // The Range overload accepts the token type as a string; the numeric-position overload does not.
    builder.push(range, token.type);
  }
}

module.exports = {
  FUNCTION_SEMANTIC_TOKEN_TYPE,
  FUNCTION_BLOCK_DOCUMENT_SELECTOR,
  buildFunctionBlockOutputSemanticTokens,
  pushFunctionBlockOutputSemanticTokens
};
