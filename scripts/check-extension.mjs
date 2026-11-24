import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import textmate from 'vscode-textmate';
import oniguruma from 'vscode-oniguruma';
import analyzer from '../src/analyzer.js';
import semanticTokens from '../src/semantic-tokens.js';

const { Registry, INITIAL } = textmate;
const { createOnigScanner, createOnigString, loadWASM } = oniguruma;
const {
  analyzeCfi,
  inspectRawLineEndings,
  findDisabledNetworkRanges,
  findConnectorMarkerRanges,
  findVariableSectionLabels,
  findVariableSectionTagRanges,
  findFbdCoordinateRanges,
  findFbdRecordBoundaryRanges,
  findStructuralTagRanges,
  findNetworkBodyTagRanges,
  findNetworkHeightRanges
} = analyzer;
const {
  FUNCTION_SEMANTIC_TOKEN_TYPE,
  FUNCTION_BLOCK_DOCUMENT_SELECTOR,
  buildFunctionBlockOutputSemanticTokens,
  pushFunctionBlockOutputSemanticTokens
} = semanticTokens;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), 'utf8'));

const manifest = await readJson('package.json');
const language = await readJson('language-configuration.json');
const grammar = await readJson('syntaxes/selectron-cfi.tmLanguage.json');

assert.equal(manifest.contributes.languages[0].id, 'selectron-cfi');
assert.deepEqual(manifest.contributes.languages[0].extensions, ['.cfi']);
assert.equal(manifest.contributes.grammars[0].scopeName, 'source.selectron-cfi');
assert.equal(grammar.scopeName, 'source.selectron-cfi');
assert.ok(language.comments.blockComment.includes('(*'));
assert.equal(manifest.contributes.configurationDefaults['[selectron-cfi]']['editor.semanticHighlighting.enabled'], true);
assert.equal(manifest.contributes.configurationDefaults['[selectron-cfi]']['files.encoding'], 'iso88591');
assert.equal(manifest.contributes.configurationDefaults['[selectron-cfi]']['files.autoGuessEncoding'], false);
assert.equal(FUNCTION_SEMANTIC_TOKEN_TYPE, 'function', 'use VS Code’s built-in function token and its standard TextMate fallback');
assert.equal(manifest.contributes.semanticTokenScopes, undefined, 'built-in function tokens need no custom scope mapping');
assert.equal(manifest.contributes.semanticTokenTypes, undefined, 'built-in function tokens need no custom token declaration');
assert.ok(FUNCTION_BLOCK_DOCUMENT_SELECTOR.some((filter) => filter.language === 'selectron-cfi'));
assert.ok(FUNCTION_BLOCK_DOCUMENT_SELECTOR.some((filter) => filter.pattern === '**/*.cfi'), 'the provider also matches workspace-associated ST language IDs');

const wasmFile = await readFile(resolve(root, 'node_modules/vscode-oniguruma/release/onig.wasm'));
await loadWASM(wasmFile.buffer.slice(wasmFile.byteOffset, wasmFile.byteOffset + wasmFile.byteLength));

const registry = new Registry({
  onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
  loadGrammar: async (scopeName) => scopeName === grammar.scopeName ? grammar : null
});
const tokenizer = await registry.loadGrammar(grammar.scopeName);
assert.ok(tokenizer, 'TextMate should load the Selectron CFI grammar');

const fixtures = new Map();
const fixtureText = new Map();
const fixtureDirectory = resolve(root, 'test/fixtures');
const fixtureFiles = (await readdir(fixtureDirectory)).filter((filename) => filename.endsWith('.cfi')).sort();
for (const filename of fixtureFiles) {
  const content = await readFile(resolve(fixtureDirectory, filename), 'utf8');
  fixtureText.set(filename, content);
  analyzeCfi(content);
  const lines = content.split(/\r?\n/);
  let ruleStack = INITIAL;
  const tokensByLine = [];
  for (const line of lines) {
    const result = tokenizer.tokenizeLine(line, ruleStack);
    tokensByLine.push(result.tokens);
    ruleStack = result.ruleStack;
  }
  fixtures.set(filename, { lines, tokensByLine });
}

for (const key of ['comments', 'strings', 'body-blocks', 'pou-declarations', 'fbd-records', 'pool-and-config-markers', 'sfc-elements', 'sfc-step-block', 'sfc-transition-block', 'sfc-action-block']) {
  assert.ok(grammar.repository[key], `missing grammar repository entry: ${key}`);
}

function assertToken(filename, text, expectedScope, lineHint = text) {
  const fixture = fixtures.get(filename);
  const lineIndex = fixture.lines.findIndex((line) => line.includes(lineHint));
  assert.notEqual(lineIndex, -1, `${filename}: expected fixture text ${JSON.stringify(text)}`);
  const line = fixture.lines[lineIndex];
  const start = line.indexOf(text, line.indexOf('(') + 1) >= 0
    ? line.indexOf(text, line.indexOf('(') + 1)
    : line.indexOf(text);
  const token = fixture.tokensByLine[lineIndex].find((entry) => entry.startIndex <= start && start < entry.endIndex);
  assert.ok(token, `${filename}: no token at ${JSON.stringify(text)}`);
  assert.ok(
    token.scopes.includes(expectedScope),
    `${filename}: ${JSON.stringify(text)} expected ${expectedScope}, received ${token.scopes.join(' ')}`
  );
}

function assertScopeAt(filename, lineHint, needle, offset, expectedScope) {
  const fixture = fixtures.get(filename);
  const lineIndex = fixture.lines.findIndex((line) => line.includes(lineHint));
  assert.notEqual(lineIndex, -1, `${filename}: expected fixture line ${JSON.stringify(lineHint)}`);
  const start = fixture.lines[lineIndex].indexOf(needle) + offset;
  const token = fixture.tokensByLine[lineIndex].find((entry) => entry.startIndex <= start && start < entry.endIndex);
  assert.ok(token, `${filename}: no token at offset ${start}`);
  assert.ok(
    token.scopes.includes(expectedScope),
    `${filename}: ${JSON.stringify(needle)} at offset ${offset} expected ${expectedScope}, received ${token.scopes.join(' ')}`
  );
  return token.scopes;
}

assertToken('structured-text.cfi', 'FUNCTION', 'keyword.declaration.selectron-cfi');
assertToken('structured-text.cfi', 'BOOL', 'support.type.selectron-cfi');
assertToken('structured-text.cfi', 'callTimer', 'entity.name.function.selectron-cfi', 'callTimer(IN := TRUE');
assertToken('structured-text.cfi', 'BmsReceiver', 'entity.name.function.selectron-cfi', 'BmsReceiver(v_BmsStatusInfo := c_externalDirection)');
assertToken('structured-text.cfi', 'GroupPath', 'support.type.property-name.selectron-cfi', '{GroupPath=');
assertToken('structured-text.cfi', 'POUs.Test', 'string.unquoted.metadata-value.selectron-cfi', '{GroupPath=');
assertToken('structured-text.cfi', 'UserVersion', 'support.type.property-name.selectron-cfi', '{UserVersion=');
assertToken('structured-text.cfi', 'DevOps #1018', 'string.unquoted.metadata-value.selectron-cfi', '{UserVersion=');
assertToken('structured-text.cfi', '=', 'keyword.operator.assignment.selectron-cfi', '{GroupPath=');
assertToken('structured-text.cfi', 'SaveVersion', 'support.type.property-name.selectron-cfi', 'SaveVersion=2');
assertToken('structured-text.cfi', '=', 'keyword.operator.assignment.selectron-cfi', 'SaveVersion=2');
assertToken('structured-text.cfi', 'VAR', 'storage.type.section.selectron-cfi', 'VAR CONSTANT');
assertToken('structured-text.cfi', 'CONSTANT', 'storage.type.section.selectron-cfi', 'VAR CONSTANT');
assertToken('structured-text.cfi', 'CONSTANT', 'storage.type.section.selectron-cfi', 'VAR_EXTERNAL CONSTANT');
assertToken('structured-text.cfi', 'VAR_CONSTANT', 'storage.type.section.selectron-cfi');
assertScopeAt('structured-text.cfi', '{GroupPath=POUs.Test}', '{GroupPath=POUs.Test}', 0, 'comment.block.punctuation.definition.metadata.begin.selectron-cfi');
assertScopeAt('structured-text.cfi', '{GroupPath=POUs.Test}', '{GroupPath=POUs.Test}', '{GroupPath=POUs.Test}'.length - 1, 'comment.block.punctuation.definition.metadata.end.selectron-cfi');
assertToken('fbd.cfi', 'F', 'support.type.fbd-record.selectron-cfi', 'B(B_F,@AND-2');
assertToken('fbd.cfi', '@AND-2', 'entity.name.function.selectron-cfi', 'B(B_F,@AND-2');
assertToken('fbd.cfi', 'min-2', 'entity.name.function.selectron-cfi', 'B(B_F,min-2');
assertToken('fbd.cfi', '@MUL-4', 'entity.name.function.selectron-cfi', 'B(B_F,@MUL-4');
assertScopeAt('fbd.cfi', 'B(B_F,@AND-2', 'B_F', 2, 'support.type.fbd-record.selectron-cfi');
assertToken('fbd.cfi', 'VARIN', 'support.type.fbd-record.selectron-cfi', 'B(B_VARIN');
assertToken('fbd.cfi', 'NB_DoorControlCommon', 'entity.name.function.selectron-cfi', 'B(B_FB,NB_DoorControlCommon');
assertToken('fbd.cfi', 'GC01_CabManager', 'entity.name.function.selectron-cfi', 'B(B_FB,GC01_CabManager');
assertToken('fbd.cfi', 'FB', 'support.type.fbd-record.selectron-cfi', 'B(B_FB,NB_DoorControlCommon');
assertToken('fbd.cfi', 'anySimple', 'support.type.selectron-cfi', 'B(B_F,min-2,,13,1,20,5');
assert.deepEqual(
  assertScopeAt('fbd.cfi', 'B(B_F,min-2,,12,2,17,5', 'min-2', 0, 'entity.name.function.selectron-cfi'),
  assertScopeAt('fbd.cfi', 'B(B_F,@MUL-4', '@MUL-4', 0, 'entity.name.function.selectron-cfi'),
  'FBD function names with and without @ must receive identical scopes'
);
assert.deepEqual(
  assertScopeAt('fbd.cfi', 'B(B_F,min-2,,12,2,17,5', 'min-2', 0, 'entity.name.function.selectron-cfi'),
  assertScopeAt('fbd.cfi', 'B(B_FB,GC01_CabManager', 'GC01_CabManager', 0, 'entity.name.function.selectron-cfi'),
  'FBD function and function-block type names must receive identical scopes'
);
assertToken('fbd.cfi', 'END_FUNCTION_BLOCK', 'keyword.control.section.selectron-cfi');
assertToken('fbd.cfi', 'ready$nwhen all conditions pass', 'comment.block.fbd-comment-text.selectron-cfi', 'B(B_COMMENT');
assertToken('fbd.cfi', 'ordinary string stays a string', 'string.quoted.single.selectron-cfi');
assertToken('fbd.cfi', 'x_activated', 'variable.parameter.input.fbd.selectron-cfi', 'B(B_FB,NB_DoorControlCommon');
assertToken('fbd.cfi', 'v_feedback', 'variable.parameter.output.fbd.selectron-cfi', 'B(B_FB,NB_DoorControlCommon');
assertScopeAt('fbd.cfi', 'B(B_FB,NB_DoorControlCommon', '?Bx_activated', 0, 'punctuation.separator.fbd-parameter.selectron-cfi');
assertScopeAt('fbd.cfi', 'B(B_FB,NB_DoorControlCommon', '?Bx_activated', 1, 'storage.modifier.fbd-parameter-direction.selectron-cfi');
assertScopeAt('fbd.cfi', 'B(B_FB,NB_DoorControlCommon', '?Bx_activated', 2, 'variable.parameter.input.fbd.selectron-cfi');
assertScopeAt('fbd.cfi', 'B(B_F,@AND-2', '?D?D?C', 0, 'punctuation.separator.fbd-connector-marker.selectron-cfi');
assertScopeAt('fbd.cfi', 'B(B_F,@AND-2', '?D?D?C', 4, 'punctuation.separator.fbd-connector-marker.selectron-cfi');
assertToken('fbd.cfi', '$n', 'comment.block.fbd-comment-text.selectron-cfi', 'B(B_COMMENT');
assertToken('config.cfi', 'BEGIN_OBJECT', 'keyword.control.section.selectron-cfi');
assertToken('project.cfi', '[Param]', 'meta.section.project-settings.selectron-cfi');
assertToken('project.cfi', 'BASE', 'support.type.property-name.selectron-cfi');
assertToken('task.cfi', 'CONFIGURATION', 'keyword.declaration.selectron-cfi');
assertToken('task.cfi', 'TASK', 'keyword.declaration.selectron-cfi');
assertToken('sfc.cfi', 'INITIAL_STEP', 'keyword.control.step.selectron-cfi');
assertToken('sfc.cfi', 'Idle', 'entity.name.label.sfc-step.selectron-cfi');
assertToken('sfc.cfi', 'TRANSITION', 'keyword.control.transition.selectron-cfi');
assertToken('sfc.cfi', 'StartOpening', 'entity.name.label.sfc-transition.selectron-cfi');
assertToken('sfc.cfi', 'PRIORITY', 'keyword.other.priority.selectron-cfi');
assertToken('sfc.cfi', 'ACTION', 'keyword.control.action.selectron-cfi');
assertToken('sfc.cfi', 'OpenValve(N)', 'meta.sfc.action-association.selectron-cfi');
assertToken('sfc.cfi', 'N', 'storage.modifier.action-qualifier.selectron-cfi', 'OpenValve(N)');
assertToken('sfc.cfi', 'L', 'storage.modifier.action-qualifier.selectron-cfi', 'KeepValveOpen(L,T#10s,DN1)');
assertToken('sfc.cfi', 'R', 'storage.modifier.action-qualifier.selectron-cfi', 'ResetValve(R)');
assertToken('sfc.cfi', 'S', 'storage.modifier.action-qualifier.selectron-cfi', 'SetValve(S)');
assertToken('sfc.cfi', 'P', 'storage.modifier.action-qualifier.selectron-cfi', 'PulseValve(P)');
assertToken('sfc.cfi', 'P1', 'storage.modifier.action-qualifier.selectron-cfi', 'PulseRising(P1)');
assertToken('sfc.cfi', 'P0', 'storage.modifier.action-qualifier.selectron-cfi', 'PulseFalling(P0)');
assertToken('sfc.cfi', 'D', 'storage.modifier.action-qualifier.selectron-cfi', 'DelayValve(D,T#2s)');
assertToken('sfc.cfi', 'SD', 'storage.modifier.action-qualifier.selectron-cfi', 'StoredDelayValve(SD,T#3s)');
assertToken('sfc.cfi', 'DS', 'storage.modifier.action-qualifier.selectron-cfi', 'DelayedStoredValve(DS,T#4s)');
assertToken('sfc.cfi', 'SL', 'storage.modifier.action-qualifier.selectron-cfi', 'StoredLimitedValve(SL,T#5s)');
assertToken('sfc.cfi', 'T#10s', 'constant.numeric.time.selectron-cfi');
assertToken('sfc.cfi', 'LD', 'support.function.instruction-list.selectron-cfi');

const variableAnalysis = analyzeCfi(`FUNCTION_BLOCK LocalPOU
VAR_INPUT
    declaredInput: BOOL;
END_VAR
VAR_EXTERNAL
    externalRef: BOOL;
END_VAR
VAR
    localBlock: TON;
    dwAddress: UDINT;
END_VAR
ST_BODY
declaredInput := missingName;
dwAddress := 16#C0A80196;
externalRef := localBlock.Q;
localBlock(IN := declaredInput, PT := T#1s);
CallAFunction(missingArgument := declaredInput);
memberRoot.member := declaredInput;
(* hiddenCommentName *)
s := 'hiddenStringName';
END_ST_BODY
END_FUNCTION_BLOCK`);
const unresolvedNames = new Set(variableAnalysis.undeclared.map((entry) => entry.name));
assert.deepEqual([...unresolvedNames].sort(), ['memberRoot', 'missingName', 's']);
assert.ok(variableAnalysis.declarations.includes('externalref'), 'VAR_EXTERNAL names count as POU declarations');

const fbdAnalysis = analyzeCfi(`FUNCTION_BLOCK FbdPOU
VAR_OUTPUT
    result: BOOL;
END_VAR
VAR
    timer: TON;
END_VAR
FBD_BODY
    B(B_VARIN,,missingInput,1,1,2,2,);
    B(B_VAROUT,,result,3,1,4,2,);
    B(B_FB,TON,timer,1,1,2,2,);
    B(B_FB,TON,missingTimer,4,1,5,2,);
END_FBD_BODY
END_FUNCTION_BLOCK`);
assert.deepEqual(fbdAnalysis.undeclared.map((entry) => entry.name), ['missingInput', 'missingTimer']);

const disabledNetworkAnalysis = analyzeCfi(`FUNCTION_BLOCK DisabledFbdPOU
FBD_BODY
    NET_WORK
        NETWORK_DISABLED:=TRUE;
        NETWORK_BODY
            B(B_VARIN,,mustNotReport,1,1,2,2,);
        END_NETWORK_BODY
    END_NET_WORK
    NET_WORK
        NETWORK_BODY
            B(B_VARIN,,mustReport,1,1,2,2,);
        END_NETWORK_BODY
    END_NET_WORK
END_FBD_BODY
END_FUNCTION_BLOCK`);
assert.deepEqual(disabledNetworkAnalysis.undeclared.map((entry) => entry.name), ['mustReport']);
const disabledRangeSource = `NET_WORK
    NETWORK_DISABLED:=TRUE;
    NETWORK_BODY
        B(B_VARIN,,oldSignal,1,1,2,2,);
    END_NETWORK_BODY
END_NET_WORK
NET_WORK
    (* NETWORK_DISABLED:=TRUE; *)
    NETWORK_BODY
        B(B_VARIN,,activeSignal,1,1,2,2,);
    END_NETWORK_BODY
END_NET_WORK`;
const disabledRanges = findDisabledNetworkRanges(disabledRangeSource);
assert.equal(disabledRanges.length, 1);
assert.equal(disabledRangeSource.slice(disabledRanges[0].start, disabledRanges[0].end).includes('oldSignal'), true);

const connectorSource = 'B(B_FB,Example,instance,1,1,2,2,,?Bx_input?Aoutput); B(B_F,@NE,,1,1,2,2,,?D?D?C); (* ?X *)';
const connectorRanges = findConnectorMarkerRanges(connectorSource);
assert.deepEqual(connectorRanges.map((range) => connectorSource.slice(range.start, range.end)), ['?B', '?A', '?D', '?D', '?C']);

const coordinateSource = 'B(B_VARIN,,0.001,18,4,20,6,); B(B_FB,Timer,tmr,2,3,4,5,,?Bx_input);';
const coordinateRanges = findFbdCoordinateRanges(coordinateSource);
assert.deepEqual(coordinateRanges.map((range) => coordinateSource.slice(range.start, range.end)), [
  '18,4,20,6,', '2,3,4,5'
]);
const fbdBoundaryRanges = findFbdRecordBoundaryRanges(coordinateSource);
assert.deepEqual(fbdBoundaryRanges.slice(0, 3).map((range) => coordinateSource.slice(range.start, range.end)), [
  'B(', 'B_', ');'
]);
const structuralTagsSource = 'NET_WORK\nEND_NET_WORK\nFBD_BODY\nEND_FBD_BODY\nST_BODY\nEND_ST_BODY\nEND_VAR\nEND_FUNCTION_BLOCK';
assert.deepEqual(findStructuralTagRanges(structuralTagsSource).map((range) => structuralTagsSource.slice(range.start, range.end)), [
  'NET_WORK', 'END_NET_WORK',
  'FBD_BODY', 'END_FBD_BODY',
  'ST_BODY', 'END_ST_BODY',
  'END_FUNCTION_BLOCK'
]);
const variableSectionTagsSource = `VAR_INPUT\nEND_VAR\nVAR CONSTANT\nEND_VAR\nVAR\nCONSTANT\nEND_VAR\n(* VAR\nEND_VAR *)`;
assert.deepEqual(findVariableSectionTagRanges(variableSectionTagsSource).map((range) => variableSectionTagsSource.slice(range.start, range.end)), [
  'VAR_INPUT', 'END_VAR', 'VAR', 'CONSTANT', 'END_VAR', 'VAR', 'CONSTANT', 'END_VAR'
]);
const networkTagsSource = 'NETWORK_BODY\nEND_NETWORK_BODY\n(* NETWORK_BODY *)';
assert.deepEqual(findNetworkBodyTagRanges(networkTagsSource).map((range) => networkTagsSource.slice(range.start, range.end)), [
  'NETWORK_BODY', 'END_NETWORK_BODY'
]);
const networkHeightSource = 'NETWORK_HEIGHT:=9; (* NETWORK_HEIGHT:=99; *)';
assert.deepEqual(findNetworkHeightRanges(networkHeightSource).map((range) => networkHeightSource.slice(range.start, range.end)), [
  'NETWORK_HEIGHT:=9;'
]);

const sfcAnalysis = analyzeCfi(fixtureText.get('sfc.cfi'));
assert.deepEqual(sfcAnalysis.undeclared, [], 'SFC steps, transitions, action names, qualifiers and local variables are recognized');

const fbOutputSource = `FUNCTION_BLOCK MemberAccessExample
VAR
    timer: TON;
    dut: ExampleDut;
    outputValue: BOOL;
END_VAR
ST_BODY
    timer(IN := TRUE);
    outputValue := timer.Q;
    outputValue := dut.Q;
    (* timer.HiddenOutput := TRUE; *)
END_ST_BODY
END_FUNCTION_BLOCK`;
const fbOutputAnalysis = analyzeCfi(fbOutputSource);
assert.deepEqual(fbOutputAnalysis.functionBlockOutputAccesses.map(({ start, end }) => fbOutputSource.slice(start, end)), ['timer'],
  'only the called FB instance is highlighted; neither its Q member nor the DUT member is highlighted');
const lineStarts = [0];
for (let index = 0; index < fbOutputSource.length; index += 1) {
  if (fbOutputSource[index] === '\n') lineStarts.push(index + 1);
}
const testDocument = {
  positionAt(offset) {
    let line = 0;
    while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) line += 1;
    return { line, character: offset - lineStarts[line] };
  }
};
assert.deepEqual(
  buildFunctionBlockOutputSemanticTokens(testDocument, fbOutputAnalysis.functionBlockOutputAccesses),
  [
    { line: 8, start: 19, length: 5, type: FUNCTION_SEMANTIC_TOKEN_TYPE }
  ]
);
class FakePosition {
  constructor(line, character) { this.line = line; this.character = character; }
}
class FakeRange {
  constructor(start, end) { this.start = start; this.end = end; }
}
const emittedTokens = [];
const fakeBuilder = {
  push(...args) {
    assert.equal(args.length, 2, 'use VS Code SemanticTokensBuilder.push(Range, tokenType) overload');
    assert.ok(args[0] instanceof FakeRange, 'the string token type overload requires a Range');
    assert.equal(typeof args[1], 'string');
    emittedTokens.push({ range: args[0], type: args[1] });
  }
};
pushFunctionBlockOutputSemanticTokens(
  { Position: FakePosition, Range: FakeRange },
  fakeBuilder,
  testDocument,
  fbOutputAnalysis.functionBlockOutputAccesses
);
assert.deepEqual(emittedTokens.map(({ range, type }) => ({
  start: [range.start.line, range.start.character],
  end: [range.end.line, range.end.character],
  type
})), [
  { start: [8, 19], end: [8, 24], type: 'function' }
]);

const whitespaceAnalysis = analyzeCfi('\t  mixedIndent := TRUE;\r\n    spacesOnly := TRUE;\r\n\ttabsOnly := TRUE;\r\n');
assert.deepEqual(whitespaceAnalysis.indentation.map((entry) => entry.line), [0]);
assert.deepEqual(inspectRawLineEndings(Buffer.from('A\r\nB\r\n', 'ascii')), []);
assert.deepEqual(inspectRawLineEndings(Buffer.from('A\r\nB\nC\r', 'ascii')), [
  { line: 1, kind: 'lf-only' },
  { line: 2, kind: 'cr-only' }
]);

const variableSectionSource = `FUNCTION_BLOCK VariableSections
VAR_OUTPUT
    outputValue: BOOL;
END_VAR
VAR_EXTERNAL CONSTANT
    externalConstant: BOOL;
END_VAR
VAR CONSTANT
    localConstant: BOOL;
END_VAR
VAR
    localValue: BOOL;
END_VAR
END_FUNCTION_BLOCK`;
assert.deepEqual(findVariableSectionLabels(variableSectionSource).map((item) => item.label), [
  'OUTPUT',
  'EXTERNAL_CONSTANT',
  'CONSTANT',
  'LOCAL'
]);

console.log('TextMate grammar tokenized all representative fixtures and passed scope assertions.');
console.log('ST FB output spans and built-in function semantic-token encoding passed.');
console.log('POU variable, FBD reference, mixed-indentation and raw line-ending checks passed.');
console.log('Tests do not validate CAP-specific SFC serialization or compile PLC projects.');
