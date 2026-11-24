'use strict';

const vscode = require('vscode');
const { analyzeCfi, inspectRawLineEndings } = require('./src/analyzer');
const {
  FUNCTION_SEMANTIC_TOKEN_TYPE,
  FUNCTION_BLOCK_DOCUMENT_SELECTOR,
  pushFunctionBlockOutputSemanticTokens
} = require('./src/semantic-tokens');

function isCfiDocument(document) {
  return document.languageId === 'selectron-cfi' || /\.cfi$/i.test(document.uri.path);
}

function makeRange(document, start, end) {
  const textLength = document.getText().length;
  const safeStart = Math.max(0, Math.min(start, textLength));
  const safeEnd = Math.max(safeStart, Math.min(end, textLength));
  return new vscode.Range(document.positionAt(safeStart), document.positionAt(safeEnd));
}

function getLineEndRange(document, lineNumber) {
  const safeLine = Math.max(0, Math.min(lineNumber, document.lineCount - 1));
  const end = document.lineAt(safeLine).range.end;
  return new vscode.Range(end, end);
}

function makeDiagnostic(range, message, severity, code) {
  const result = new vscode.Diagnostic(range, message, severity);
  result.source = 'Selectron CFI';
  result.code = code;
  return result;
}

function activate(context) {
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('selectron-cfi');
  const functionBlockOutputLegend = new vscode.SemanticTokensLegend([FUNCTION_SEMANTIC_TOKEN_TYPE]);
  const functionBlockOutputProvider = vscode.languages.registerDocumentSemanticTokensProvider(
    FUNCTION_BLOCK_DOCUMENT_SELECTOR,
    {
      provideDocumentSemanticTokens(document) {
        const builder = new vscode.SemanticTokensBuilder(functionBlockOutputLegend);
        pushFunctionBlockOutputSemanticTokens(
          vscode,
          builder,
          document,
          analyzeCfi(document.getText()).functionBlockOutputAccesses
        );
        return builder.build();
      }
    },
    functionBlockOutputLegend
  );
  const latestRuns = new Map();
  const savedLineEndingIssues = new Map();
  const decorationsByUri = new Map();
  const errorColor = new vscode.ThemeColor('editorError.foreground');
  const warningColor = new vscode.ThemeColor('editorWarning.foreground');
  const mutedColor = new vscode.ThemeColor('editorHint.foreground');

  const variableDecoration = vscode.window.createTextEditorDecorationType({
    color: errorColor,
    fontWeight: 'bold',
    textDecoration: 'underline wavy'
  });
  const mixedIndentDecoration = vscode.window.createTextEditorDecorationType({
    color: warningColor,
    fontWeight: 'bold',
    textDecoration: 'underline wavy'
  });
  const disabledNetworkDecoration = vscode.window.createTextEditorDecorationType({
    color: mutedColor,
    fontStyle: 'italic'
  });
  const connectorMarkerDecoration = vscode.window.createTextEditorDecorationType({
    color: mutedColor,
    fontStyle: 'normal',
    fontWeight: 'normal'
  });
  const variableSectionDecoration = vscode.window.createTextEditorDecorationType({
    after: {
      color: mutedColor,
      fontStyle: 'italic',
      margin: '0 0 0 1em'
    }
  });
  const fbdCoordinateDecoration = vscode.window.createTextEditorDecorationType({
    color: mutedColor,
    fontStyle: 'normal',
    fontWeight: 'normal'
  });
  const mutedSyntaxDecoration = vscode.window.createTextEditorDecorationType({
    color: mutedColor,
    fontStyle: 'normal',
    fontWeight: 'normal'
  });
  const networkBodyDecoration = vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor('editorInfo.foreground'),
    fontWeight: 'bold'
  });
  const networkHeightDecoration = vscode.window.createTextEditorDecorationType({
    color: mutedColor,
    fontStyle: 'normal',
    fontWeight: 'normal'
  });
  const lineEndingDecoration = vscode.window.createTextEditorDecorationType({
    after: {
      contentText: '  ← NON-CRLF (CAP requires CRLF)',
      color: errorColor,
      fontWeight: 'bold',
      margin: '0 0 0 1em'
    }
  });

  function applyVisibleDecorations() {
    for (const editor of vscode.window.visibleTextEditors) {
      const saved = decorationsByUri.get(editor.document.uri.toString());
      editor.setDecorations(variableDecoration, saved ? saved.variables : []);
      editor.setDecorations(mixedIndentDecoration, saved ? saved.indentation : []);
      editor.setDecorations(disabledNetworkDecoration, saved ? saved.disabledNetworks : []);
      editor.setDecorations(connectorMarkerDecoration, saved ? saved.connectorMarkers : []);
      editor.setDecorations(variableSectionDecoration, saved ? saved.variableSectionLabels : []);
      editor.setDecorations(fbdCoordinateDecoration, saved ? saved.fbdCoordinates : []);
      editor.setDecorations(mutedSyntaxDecoration, saved ? [...saved.fbdRecordBoundaries, ...saved.structuralTags] : []);
      editor.setDecorations(networkBodyDecoration, saved ? [...saved.networkBodyTags, ...saved.variableSectionTags] : []);
      editor.setDecorations(networkHeightDecoration, saved ? saved.networkHeights : []);
      editor.setDecorations(lineEndingDecoration, saved ? saved.lineEndings : []);
    }
  }

  async function readSavedLineEndings(document, key) {
    try {
      const raw = await vscode.workspace.fs.readFile(document.uri);
      const issues = inspectRawLineEndings(raw);
      savedLineEndingIssues.set(key, issues);
      return issues;
    } catch {
      return savedLineEndingIssues.get(key) || [];
    }
  }

  async function refreshDocument(document) {
    if (!isCfiDocument(document)) return;

    const key = document.uri.toString();
    const run = (latestRuns.get(key) || 0) + 1;
    latestRuns.set(key, run);
    const text = document.getText();
    const analysis = analyzeCfi(text);
    let lineEndingIssues;

    if (!document.isDirty) {
      lineEndingIssues = await readSavedLineEndings(document, key);
    } else {
      // VS Code presents one EOL style in the in-memory document. Keep a file-level
      // warning for any malformed saved bytes until the user saves a corrected file.
      const savedIssues = savedLineEndingIssues.get(key) || [];
      if (savedIssues.length > 0) {
        lineEndingIssues = [{ line: 0, kind: 'saved-file-has-invalid-eol' }];
      } else if (document.eol === vscode.EndOfLine.LF) {
        lineEndingIssues = Array.from({ length: Math.max(0, document.lineCount - 1) }, (_, line) => ({ line, kind: 'lf-only' }));
      } else {
        lineEndingIssues = [];
      }
    }

    if (latestRuns.get(key) !== run) return;

    const diagnostics = [];
    const variableDecorations = [];
    const indentationDecorations = [];
    const disabledNetworkDecorations = [];
    const connectorMarkerDecorations = [];
    const variableSectionDecorations = [];
    const variableSectionTagDecorations = [];
    const fbdCoordinateDecorations = [];
    const fbdRecordBoundaryDecorations = [];
    const structuralTagDecorations = [];
    const networkBodyDecorations = [];
    const networkHeightDecorations = [];
    const lineEndingDecorations = [];

    for (const issue of analysis.undeclared) {
      const range = makeRange(document, issue.start, issue.end);
      diagnostics.push(makeDiagnostic(
        range,
        `Variable '${issue.name}' is not declared in this POU's VAR header.`,
        vscode.DiagnosticSeverity.Error,
        'undeclared-variable'
      ));
      variableDecorations.push({ range, hoverMessage: 'Declare this variable in a VAR section of this POU.' });
    }

    for (const issue of analysis.indentation) {
      const range = makeRange(document, issue.start, issue.end);
      diagnostics.push(makeDiagnostic(
        range,
        'Leading indentation mixes tabs and spaces.',
        vscode.DiagnosticSeverity.Warning,
        'mixed-indentation'
      ));
      indentationDecorations.push({ range, hoverMessage: 'Use either tabs or spaces consistently on this line.' });
    }

    for (const issue of analysis.disabledNetworks) {
      const range = makeRange(document, issue.start, issue.end);
      disabledNetworkDecorations.push({
        range,
        hoverMessage: 'Disabled FBD network (NETWORK_DISABLED:=TRUE).'
      });
    }

    for (const issue of analysis.connectorMarkers) {
      connectorMarkerDecorations.push({ range: makeRange(document, issue.start, issue.end) });
    }

    for (const issue of analysis.variableSectionLabels) {
      variableSectionDecorations.push({
        range: makeRange(document, issue.start, issue.end),
        renderOptions: { after: { contentText: `_${issue.label}` } }
      });
    }

    for (const issue of analysis.fbdCoordinates) {
      fbdCoordinateDecorations.push({ range: makeRange(document, issue.start, issue.end) });
    }

    for (const issue of analysis.fbdRecordBoundaries) {
      fbdRecordBoundaryDecorations.push({ range: makeRange(document, issue.start, issue.end) });
    }

    for (const issue of analysis.structuralTags) {
      structuralTagDecorations.push({ range: makeRange(document, issue.start, issue.end) });
    }

    for (const issue of analysis.networkBodyTags) {
      networkBodyDecorations.push({ range: makeRange(document, issue.start, issue.end) });
    }

    for (const issue of analysis.variableSectionTags) {
      variableSectionTagDecorations.push({ range: makeRange(document, issue.start, issue.end) });
    }

    for (const issue of analysis.networkHeights) {
      networkHeightDecorations.push({ range: makeRange(document, issue.start, issue.end) });
    }

    for (const issue of lineEndingIssues) {
      const range = getLineEndRange(document, issue.line);
      const message = issue.kind === 'cr-only'
        ? 'Bare CR line ending is not supported; CAP CFI requires CRLF.'
        : issue.kind === 'saved-file-has-invalid-eol'
          ? 'The saved file contains non-CRLF line endings. Save a corrected CRLF version.'
          : 'LF-only line ending is not supported; CAP CFI requires CRLF.';
      diagnostics.push(makeDiagnostic(range, message, vscode.DiagnosticSeverity.Error, 'invalid-line-ending'));
      lineEndingDecorations.push({ range, hoverMessage: message });
    }

    diagnosticCollection.set(document.uri, diagnostics);
    decorationsByUri.set(key, {
      variables: variableDecorations,
      indentation: indentationDecorations,
      disabledNetworks: disabledNetworkDecorations,
      connectorMarkers: connectorMarkerDecorations,
      variableSectionLabels: variableSectionDecorations,
      variableSectionTags: variableSectionTagDecorations,
      fbdCoordinates: fbdCoordinateDecorations,
      fbdRecordBoundaries: fbdRecordBoundaryDecorations,
      structuralTags: structuralTagDecorations,
      networkBodyTags: networkBodyDecorations,
      networkHeights: networkHeightDecorations,
      lineEndings: lineEndingDecorations
    });
    applyVisibleDecorations();
  }

  context.subscriptions.push(
    diagnosticCollection,
    functionBlockOutputProvider,
    variableDecoration,
    mixedIndentDecoration,
    disabledNetworkDecoration,
    connectorMarkerDecoration,
    variableSectionDecoration,
    fbdCoordinateDecoration,
    mutedSyntaxDecoration,
    networkBodyDecoration,
    networkHeightDecoration,
    lineEndingDecoration,
    vscode.workspace.onDidOpenTextDocument(refreshDocument),
    vscode.workspace.onDidChangeTextDocument((event) => refreshDocument(event.document)),
    vscode.workspace.onDidSaveTextDocument(refreshDocument),
    vscode.workspace.onDidCloseTextDocument((document) => {
      const key = document.uri.toString();
      diagnosticCollection.delete(document.uri);
      decorationsByUri.delete(key);
      savedLineEndingIssues.delete(key);
      latestRuns.delete(key);
      applyVisibleDecorations();
    }),
    vscode.window.onDidChangeActiveTextEditor(applyVisibleDecorations)
  );

  for (const document of vscode.workspace.textDocuments) refreshDocument(document);
}

function deactivate() {}

module.exports = { activate, deactivate };
