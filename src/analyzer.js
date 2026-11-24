'use strict';

const POU_DECLARATION = /^[\t ]*(FUNCTION_BLOCK|FUNCTION|PROGRAM)\s+([A-Za-z_][A-Za-z0-9_]*)/im;
const VARIABLE_SECTION = /^[\t ]*(VAR(?:_(?:INPUT|OUTPUT|IN_OUT|EXTERNAL|TEMP|CONSTANT|GLOBAL))?(?:[\t ]+(?:CONSTANT|RETAIN|NON_RETAIN))*)[\t ]*;?[\t ]*$/gim;
const END_VARIABLE_SECTION = /^[\t ]*END_VAR\b/gim;
const BODY_BLOCK = /^[\t ]*(ST_BODY|FBD_BODY)\b([\s\S]*?)^[\t ]*END_\1\b/gim;

const IEC_WORDS = new Set((
  'AND OR XOR NOT MOD DIV IF THEN ELSIF ELSE END_IF CASE OF END_CASE FOR TO BY DO END_FOR ' +
  'WHILE END_WHILE REPEAT UNTIL END_REPEAT EXIT RETURN CONTINUE TRUE FALSE CONSTANT RETAIN NON_RETAIN ' +
  'CONFIGURATION END_CONFIGURATION RESOURCE END_RESOURCE TASK WITH ON SINGLE INTERVAL PRIORITY FROM ' +
  'END_TRANSITION INITIAL_STEP STEP END_STEP TRANSITION ACTION END_ACTION END_VAR TYPE END_TYPE STRUCT END_STRUCT ' +
  'FUNCTION FUNCTION_BLOCK PROGRAM END_FUNCTION END_FUNCTION_BLOCK END_PROGRAM FBD_BODY END_FBD_BODY ST_BODY END_ST_BODY ' +
  'VAR VAR_INPUT VAR_OUTPUT VAR_IN_OUT VAR_EXTERNAL VAR_TEMP VAR_CONSTANT VAR_GLOBAL ' +
  'LD LDN ST STN ANDN ORN XORN ADD SUB MUL GT GE EQ NE LE LT JMP JMPC JMPCN CAL CALC CALCN RET RETC RETCN'
).split(/\s+/).map((word) => word.toLowerCase()));

const IEC_TYPES = new Set((
  'BOOL BYTE WORD DWORD LWORD SINT USINT INT UINT DINT UDINT LINT ULINT REAL LREAL TIME LTIME DATE LDATE ' +
  'TIME_OF_DAY TOD DATE_AND_TIME DT STRING WSTRING ARRAY STRUCT POINTER REFERENCE ANY ANY_INT ANY_REAL ANY_NUM ANY_BIT'
).split(/\s+/).map((word) => word.toLowerCase()));

function blankExceptLineBreaks(chars, start, end) {
  for (let index = start; index < end; index += 1) {
    if (chars[index] !== '\r' && chars[index] !== '\n') chars[index] = ' ';
  }
}

function maskCommentsAndStrings(text) {
  const chars = text.split('');
  let inString = false;
  let commentDepth = 0;

  for (let index = 0; index < chars.length;) {
    if (commentDepth > 0) {
      if (text.startsWith('(*', index)) {
        commentDepth += 1;
        blankExceptLineBreaks(chars, index, index + 2);
        index += 2;
      } else if (text.startsWith('*)', index)) {
        commentDepth -= 1;
        blankExceptLineBreaks(chars, index, index + 2);
        index += 2;
      } else {
        blankExceptLineBreaks(chars, index, index + 1);
        index += 1;
      }
      continue;
    }

    if (inString) {
      if (text[index] === "'" && text[index + 1] === "'") {
        blankExceptLineBreaks(chars, index, index + 2);
        index += 2;
      } else if (text[index] === "'") {
        blankExceptLineBreaks(chars, index, index + 1);
        inString = false;
        index += 1;
      } else {
        blankExceptLineBreaks(chars, index, index + 1);
        index += 1;
      }
      continue;
    }

    if (text.startsWith('(*', index)) {
      commentDepth = 1;
      blankExceptLineBreaks(chars, index, index + 2);
      index += 2;
    } else if (text[index] === "'") {
      inString = true;
      blankExceptLineBreaks(chars, index, index + 1);
      index += 1;
    } else {
      index += 1;
    }
  }

  return chars.join('');
}

function addDeclaredNames(sectionText, declaredNames) {
  for (const declaration of sectionText.split(';')) {
    const colonIndex = declaration.indexOf(':');
    if (colonIndex < 0) continue;

    let nameList = declaration.slice(0, colonIndex);
    const atIndex = nameList.search(/\bAT\b/i);
    if (atIndex >= 0) nameList = nameList.slice(0, atIndex);
    if (!/^\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*\s*$/.test(nameList)) continue;

    for (const name of nameList.split(',')) declaredNames.add(name.trim().toLowerCase());
  }
}

function collectDeclaredNames(maskedText, bodyStart, pouMatch) {
  const declaredNames = new Set();
  if (pouMatch) declaredNames.add(pouMatch[2].toLowerCase());

  const header = maskedText.slice(0, bodyStart);
  VARIABLE_SECTION.lastIndex = 0;
  let sectionMatch;
  while ((sectionMatch = VARIABLE_SECTION.exec(header)) !== null) {
    END_VARIABLE_SECTION.lastIndex = VARIABLE_SECTION.lastIndex;
    const endMatch = END_VARIABLE_SECTION.exec(header);
    if (!endMatch) break;
    addDeclaredNames(header.slice(VARIABLE_SECTION.lastIndex, endMatch.index), declaredNames);
    VARIABLE_SECTION.lastIndex = END_VARIABLE_SECTION.lastIndex;
  }

  return declaredNames;
}

function findFunctionBlockOutputAccesses(bodyText, bodyOffset, declaredNames, pouName = '') {
  const masked = maskCommentsAndStrings(bodyText);
  const calledInstances = new Set();
  const callPattern = /\b([A-Za-z_][A-Za-z0-9_]*)[\t ]*\(/g;
  const normalizedPouName = pouName.toLowerCase();
  let callMatch;

  while ((callMatch = callPattern.exec(masked)) !== null) {
    const instanceName = callMatch[1];
    const normalizedName = instanceName.toLowerCase();
    if (declaredNames.has(normalizedName) && normalizedName !== normalizedPouName) {
      calledInstances.add(instanceName);
    }
  }

  const accesses = [];
  for (const instanceName of calledInstances) {
    const escapedName = instanceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const memberPattern = new RegExp(`\\b${escapedName}[\\t ]*\\.[\\t ]*([A-Za-z_][A-Za-z0-9_]*)\\b`, 'gi');
    let memberMatch;

    while ((memberMatch = memberPattern.exec(masked)) !== null) {
      const instanceOffset = memberMatch.index;
      const memberOffset = memberMatch.index + memberMatch[0].lastIndexOf(memberMatch[1]);
      accesses.push({
        start: bodyOffset + instanceOffset,
        end: bodyOffset + instanceOffset + instanceName.length,
        kind: 'function-block-instance-reference'
      });
      accesses.push({
        start: bodyOffset + memberOffset,
        end: bodyOffset + memberOffset + memberMatch[1].length,
        kind: 'function-block-output-reference'
      });
    }
  }

  return accesses.sort((left, right) => left.start - right.start);
}

function findVariableSectionLabels(text) {
  const masked = maskCommentsAndStrings(text);
  const variableSectionPattern = new RegExp(VARIABLE_SECTION.source, VARIABLE_SECTION.flags);
  const endVariablePattern = new RegExp(END_VARIABLE_SECTION.source, END_VARIABLE_SECTION.flags);
  const labels = [];
  let sectionMatch;

  while ((sectionMatch = variableSectionPattern.exec(masked)) !== null) {
    endVariablePattern.lastIndex = variableSectionPattern.lastIndex;
    const endMatch = endVariablePattern.exec(masked);
    if (!endMatch) break;

    const normalized = sectionMatch[1].trim().replace(/[\t ]+/g, '_').toUpperCase();
    let label = normalized.replace(/^VAR_?/, '') || 'LOCAL';
    if (label === 'RETAIN' || label === 'NON_RETAIN') label = `LOCAL_${label}`;
    const position = endMatch.index + endMatch[0].length;
    labels.push({ start: position, end: position, label, kind: 'variable-section-label' });
    variableSectionPattern.lastIndex = endVariablePattern.lastIndex;
  }

  return labels;
}

function findVariableSectionTagRanges(text) {
  const masked = maskCommentsAndStrings(text);
  const headerPattern = new RegExp(VARIABLE_SECTION.source, VARIABLE_SECTION.flags);
  const constantLinePattern = /^[\t ]*(CONSTANT)[\t ]*;?[\t ]*$/gim;
  const endPattern = new RegExp(END_VARIABLE_SECTION.source, END_VARIABLE_SECTION.flags);
  const tags = [];
  const markerPattern = /\b(?:VAR(?:_(?:INPUT|OUTPUT|IN_OUT|EXTERNAL|TEMP|CONSTANT|GLOBAL))?|CONSTANT|RETAIN|NON_RETAIN)\b/gi;
  let headerMatch;

  while ((headerMatch = headerPattern.exec(masked)) !== null) {
    const header = headerMatch[1];
    const headerStart = headerMatch.index + headerMatch[0].indexOf(header);
    let markerMatch;
    while ((markerMatch = markerPattern.exec(header)) !== null) {
      tags.push({
        start: headerStart + markerMatch.index,
        end: headerStart + markerMatch.index + markerMatch[0].length,
        kind: 'variable-section-tag'
      });
    }
  }

  let constantMatch;
  while ((constantMatch = constantLinePattern.exec(masked)) !== null) {
    const start = constantMatch.index + constantMatch[0].indexOf(constantMatch[1]);
    tags.push({ start, end: start + constantMatch[1].length, kind: 'variable-section-tag' });
  }

  let endMatch;
  while ((endMatch = endPattern.exec(masked)) !== null) {
    const start = endMatch.index + endMatch[0].indexOf('END_VAR');
    tags.push({ start, end: start + 'END_VAR'.length, kind: 'variable-section-tag' });
  }

  return tags.sort((left, right) => left.start - right.start);
}

function findFbdCoordinateRanges(text) {
  const masked = maskCommentsAndStrings(text);
  const recordPattern = /\bB\s*\(\s*B_(?:FB|VARIN|VAROUT|F|COMMENT)\b/gi;
  const coordinates = [];
  let recordMatch;

  while ((recordMatch = recordPattern.exec(masked)) !== null) {
    const open = masked.indexOf('(', recordMatch.index);
    if (open < 0) continue;

    let depth = 1;
    let close = -1;
    for (let index = open + 1; index < masked.length; index += 1) {
      if (masked[index] === '(') depth += 1;
      else if (masked[index] === ')') {
        depth -= 1;
        if (depth === 0) {
          close = index;
          break;
        }
      }
    }
    if (close < 0) continue;

    const fields = [];
    let fieldStart = open + 1;
    let fieldDepth = 0;
    for (let index = fieldStart; index <= close; index += 1) {
      const character = masked[index];
      if (character === '(') fieldDepth += 1;
      else if (character === ')') fieldDepth -= 1;
      if ((character === ',' && fieldDepth === 0) || index === close) {
        fields.push({ start: fieldStart, end: index });
        fieldStart = index + 1;
      }
    }

    // All supported B_* graphic records place x1,y1,x2,y2 in fields 3-6.
    const coordinateFields = [];
    for (let fieldIndex = 3; fieldIndex <= 6; fieldIndex += 1) {
      const field = fields[fieldIndex];
      if (!field) {
        coordinateFields.push(null);
        continue;
      }
      const raw = masked.slice(field.start, field.end);
      const leadingWhitespace = /^\s*/.exec(raw)[0].length;
      const value = raw.trim();
      if (!/^[+-]?\d+(?:\.\d+)?$/.test(value)) {
        coordinateFields.push(null);
        continue;
      }
      const start = field.start + leadingWhitespace;
      coordinateFields.push({ start, end: start + value.length });
    }

    if (coordinateFields.every(Boolean)) {
      let coordinateEnd = coordinateFields[coordinateFields.length - 1].end;
      const trailingFields = fields.slice(7);
      if (trailingFields.length > 0 && trailingFields.every((field) => masked.slice(field.start, field.end).trim() === '')) {
        const trailingBoilerplate = masked.slice(coordinateEnd, close);
        if (/^[\t ,]*$/.test(trailingBoilerplate)) coordinateEnd = close;
      }
      coordinates.push({
        start: coordinateFields[0].start,
        end: coordinateEnd,
        kind: 'fbd-coordinate'
      });
    } else {
      for (const field of coordinateFields) {
        if (field) coordinates.push({ ...field, kind: 'fbd-coordinate' });
      }
    }

    recordPattern.lastIndex = close + 1;
  }

  return coordinates;
}

function findFbdRecordBoundaryRanges(text) {
  const masked = maskCommentsAndStrings(text);
  const recordPattern = /\bB\s*\(\s*B_(?:FB|VARIN|VAROUT|F|COMMENT)\b/gi;
  const boundaries = [];
  let recordMatch;

  while ((recordMatch = recordPattern.exec(masked)) !== null) {
    const open = masked.indexOf('(', recordMatch.index);
    if (open < 0) continue;
    let depth = 1;
    let close = -1;

    for (let index = open + 1; index < masked.length; index += 1) {
      if (masked[index] === '(') depth += 1;
      else if (masked[index] === ')') {
        depth -= 1;
        if (depth === 0) {
          close = index;
          break;
        }
      }
    }
    if (close < 0) continue;

    const openRelative = recordMatch[0].indexOf('(');
    const typePrefixRelative = recordMatch[0].indexOf('B_', openRelative + 1);
    boundaries.push({ start: recordMatch.index, end: recordMatch.index + openRelative + 1, kind: 'fbd-call-prefix' });
    if (typePrefixRelative >= 0) {
      boundaries.push({
        start: recordMatch.index + typePrefixRelative,
        end: recordMatch.index + typePrefixRelative + 2,
        kind: 'fbd-record-prefix'
      });
    }

    let suffixEnd = close + 1;
    let semicolonIndex = suffixEnd;
    while (semicolonIndex < masked.length && /[\t ]/.test(masked[semicolonIndex])) semicolonIndex += 1;
    if (masked[semicolonIndex] === ';') suffixEnd = semicolonIndex + 1;
    boundaries.push({ start: close, end: suffixEnd, kind: 'fbd-record-suffix' });
    recordPattern.lastIndex = close + 1;
  }

  return boundaries;
}

function findStructuralTagRanges(text) {
  const masked = maskCommentsAndStrings(text);
  const tagPattern = /\b(?:(?:BEGIN|END)_(?:ATTRIBUTES|OBJECT|PROPERTIES|DECLARATION|PLC_CONFIG|CONFIGURATION|RESOURCE|NET_WORK|FBD_BODY|ST_BODY|STRUCT|VAR|FUNCTION_BLOCK|FUNCTION|PROGRAM|TYPE)|NET_WORK|FBD_BODY|ST_BODY)\b/gi;
  const tags = [];
  let match;

  while ((match = tagPattern.exec(masked)) !== null) {
    if (/^END_VAR$/i.test(match[0])) continue;
    tags.push({ start: match.index, end: match.index + match[0].length, kind: 'structural-tag' });
  }

  return tags;
}

function findNetworkBodyTagRanges(text) {
  const masked = maskCommentsAndStrings(text);
  const tagPattern = /\b(?:NETWORK_BODY|END_NETWORK_BODY)\b/gi;
  const tags = [];
  let match;

  while ((match = tagPattern.exec(masked)) !== null) {
    tags.push({ start: match.index, end: match.index + match[0].length, kind: 'network-body-tag' });
  }

  return tags;
}

function findNetworkHeightRanges(text) {
  const masked = maskCommentsAndStrings(text);
  const heightPattern = /\bNETWORK_HEIGHT\s*:=\s*[+-]?\d+\s*;?/gi;
  const ranges = [];
  let match;

  while ((match = heightPattern.exec(masked)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length, kind: 'network-height' });
  }

  return ranges;
}

function collectSfcNames(bodyText, names) {
  const stepPattern = /\b(?:INITIAL_STEP|STEP)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/gi;
  const actionPattern = /\bACTION\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/gi;
  const transitionPattern = /\bTRANSITION\b\s+(?:\(\s*PRIORITY\s*:=\s*[0-9]+\s*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)/gi;

  for (const pattern of [stepPattern, actionPattern]) {
    let match;
    while ((match = pattern.exec(bodyText)) !== null) names.add(match[1].toLowerCase());
  }

  let transitionMatch;
  while ((transitionMatch = transitionPattern.exec(bodyText)) !== null) {
    const name = transitionMatch[1];
    if (!/^(?:FROM|PRIORITY)$/i.test(name)) names.add(name.toLowerCase());
  }
}

function isCallArgument(text, position) {
  const stack = [];
  for (let index = 0; index < position; index += 1) {
    if (text[index] === '(') {
      let previous = index - 1;
      while (previous >= 0 && /\s/.test(text[previous])) previous -= 1;
      stack.push(previous >= 0 && /[A-Za-z0-9_\])]/.test(text[previous]));
    } else if (text[index] === ')') {
      stack.pop();
    }
  }
  return stack.includes(true);
}

function isIgnoredIdentifier(text, start, end, declaredNames) {
  const name = text.slice(start, end);
  const lowerName = name.toLowerCase();
  if (declaredNames.has(lowerName) || IEC_WORDS.has(lowerName) || IEC_TYPES.has(lowerName)) return true;

  let previous = start - 1;
  while (previous >= 0 && /\s/.test(text[previous])) previous -= 1;
  let next = end;
  while (next < text.length && /\s/.test(text[next])) next += 1;

  if (previous >= 0 && (text[previous] === '.' || text[previous] === '%' || text[previous] === '#')) return true;
  if (next < text.length && text[next] === '#') return true; // IEC typed literal, e.g. T#10s or EnumType#Value
  if (next < text.length && text[next] === '(') return true; // Function/action call name, not a variable use
  if (text.slice(next, next + 2) === ':=' && isCallArgument(text, start)) return true; // Named FB/function input
  if (next < text.length && text[next] === ':' && text[next + 1] !== '=') return true; // ST label

  if (/^(?:d|h|m|s|ms|us|ns)$/i.test(name) && previous >= 0 && /[0-9]/.test(text[previous])) return true;
  if (/^e$/i.test(name) && previous >= 0 && /[0-9]/.test(text[previous])) return true; // Numeric exponent
  return false;
}

function findUndeclaredInStBody(bodyText, bodyOffset, declaredNames, errors) {
  const typedLiteralsMasked = bodyText.replace(/[A-Za-z_][A-Za-z0-9_]*#[A-Za-z0-9_.:+-]+/g, (literal) => ' '.repeat(literal.length));
  const qualifierStarts = new Set();
  const ilInstructionStarts = new Set();
  const qualifierPattern = /\b[A-Za-z_][A-Za-z0-9_]*\s*\(\s*(P0|P1|SD|DS|SL|N|R|S|P|L|D)\b(?=\s*(?:,|\)))/gi;
  const ilInstructionPattern = /^[\t ]*(LDN?|STN?|S1?|R1?|ANDN?|ORN?|XORN?|NOT|ADD|SUB|MUL|DIV|MOD|GT|GE|EQ|NE|LE|LT|JMP|JMPCN?|CAL(?:CN?)?|RET(?:C|CN)?)\b(?![\t ]*:=)/gim;
  let qualifierMatch;
  while ((qualifierMatch = qualifierPattern.exec(typedLiteralsMasked)) !== null) {
    qualifierStarts.add(qualifierMatch.index + qualifierMatch[0].lastIndexOf(qualifierMatch[1]));
  }
  let ilInstructionMatch;
  while ((ilInstructionMatch = ilInstructionPattern.exec(typedLiteralsMasked)) !== null) {
    ilInstructionStarts.add(ilInstructionMatch.index + ilInstructionMatch[0].lastIndexOf(ilInstructionMatch[1]));
  }

  const identifierPattern = /[A-Za-z_][A-Za-z0-9_]*/g;
  let match;
  while ((match = identifierPattern.exec(typedLiteralsMasked)) !== null) {
    if (qualifierStarts.has(match.index) || ilInstructionStarts.has(match.index)) continue;
    if (isIgnoredIdentifier(typedLiteralsMasked, match.index, identifierPattern.lastIndex, declaredNames)) continue;
    errors.push({
      name: match[0],
      start: bodyOffset + match.index,
      end: bodyOffset + identifierPattern.lastIndex,
      kind: 'undeclared-variable'
    });
  }
}

function findUndeclaredInFbdRegion(bodyText, bodyOffset, declaredNames, errors) {
  const inputOutputPattern = /\bB\s*\(\s*B_VAR(?:IN|OUT)\s*,[^,]*,\s*([A-Za-z_][A-Za-z0-9_]*)/gi;
  const fbInstancePattern = /\bB\s*\(\s*B_FB\s*,\s*[A-Za-z_][A-Za-z0-9_]*\s*,\s*([A-Za-z_][A-Za-z0-9_]*)/gi;

  for (const pattern of [inputOutputPattern, fbInstancePattern]) {
    let match;
    while ((match = pattern.exec(bodyText)) !== null) {
      const name = match[1];
      const start = match.index + match[0].lastIndexOf(name);
      if (isIgnoredIdentifier(bodyText, start, start + name.length, declaredNames)) continue;
      errors.push({ name, start: bodyOffset + start, end: bodyOffset + start + name.length, kind: 'undeclared-variable' });
    }
  }
}

function findUndeclaredInFbdBody(bodyText, bodyOffset, declaredNames, errors) {
  const networkPattern = /\bNET_WORK\b[\s\S]*?\bEND_NET_WORK\b/gi;
  let networkMatch;
  let foundNetworks = false;

  while ((networkMatch = networkPattern.exec(bodyText)) !== null) {
    foundNetworks = true;
    if (/\bNETWORK_DISABLED\s*:=\s*TRUE\b/i.test(networkMatch[0])) continue;
    findUndeclaredInFbdRegion(networkMatch[0], bodyOffset + networkMatch.index, declaredNames, errors);
  }

  // Keep support for compact/synthetic FBD snippets that omit NET_WORK wrappers.
  if (!foundNetworks) findUndeclaredInFbdRegion(bodyText, bodyOffset, declaredNames, errors);
}

function findMixedIndentation(text) {
  const issues = [];
  const linePattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let line = 0;
  let match;
  while ((match = linePattern.exec(text)) !== null) {
    const content = match[1];
    const prefixMatch = /^[\t ]+/.exec(content);
    if (prefixMatch && /\t/.test(prefixMatch[0]) && / /.test(prefixMatch[0]) && content.trim().length > 0) {
      issues.push({
        start: match.index,
        end: match.index + prefixMatch[0].length,
        line,
        kind: 'mixed-indentation'
      });
    }
    if (match[0].length === 0) break;
    line += match[2].length > 0 ? 1 : 0;
  }
  return issues;
}

function findDisabledNetworkRanges(text) {
  const masked = maskCommentsAndStrings(text);
  const networkPattern = /\bNET_WORK\b[\s\S]*?\bEND_NET_WORK\b/gi;
  const disabledRanges = [];
  let match;

  while ((match = networkPattern.exec(masked)) !== null) {
    if (/\bNETWORK_DISABLED\s*:=\s*TRUE\b/i.test(match[0])) {
      disabledRanges.push({ start: match.index, end: match.index + match[0].length, kind: 'disabled-network' });
    }
  }

  return disabledRanges;
}

function findConnectorMarkerRanges(text) {
  const masked = maskCommentsAndStrings(text);
  const markerPattern = /\?[A-Z]/g;
  const markers = [];
  let match;

  while ((match = markerPattern.exec(masked)) !== null) {
    markers.push({ start: match.index, end: match.index + match[0].length, kind: 'connector-marker' });
  }

  return markers;
}

function analyzeCfi(text) {
  if (text.includes('\0')) {
    return {
      undeclared: [],
      indentation: [],
      disabledNetworks: [],
      connectorMarkers: [],
      variableSectionLabels: [],
      variableSectionTags: [],
      functionBlockOutputAccesses: [],
      fbdCoordinates: [],
      fbdRecordBoundaries: [],
      structuralTags: [],
      networkBodyTags: [],
      networkHeights: [],
      declarations: []
    };
  }
  const masked = maskCommentsAndStrings(text);
  const pouMatch = POU_DECLARATION.exec(masked);
  BODY_BLOCK.lastIndex = 0;
  const bodyMatches = [...masked.matchAll(BODY_BLOCK)].map((match) => ({
    index: match.index,
    marker: match[1],
    markerOffset: match[0].indexOf(match[1]),
    text: match[2]
  }));

  // IEC textual SFC elements can form a POU body without an ST_BODY/FBD_BODY wrapper.
  if (bodyMatches.length === 0 && pouMatch) {
    const sfcStart = /^[\t ]*(?:INITIAL_STEP|STEP)\s+[A-Za-z_][A-Za-z0-9_]*\s*:/im.exec(masked);
    if (sfcStart) {
      const pouEndPattern = /^[\t ]*END_(?:FUNCTION_BLOCK|FUNCTION|PROGRAM)\b/gim;
      pouEndPattern.lastIndex = sfcStart.index;
      const pouEnd = pouEndPattern.exec(masked);
      const bodyEnd = pouEnd ? pouEnd.index : masked.length;
      bodyMatches.push({ index: sfcStart.index, marker: 'SFC_BODY', markerOffset: 0, text: masked.slice(sfcStart.index, bodyEnd) });
    }
  }

  const firstBodyStart = bodyMatches.length > 0 ? bodyMatches[0].index : masked.length;
  const declared = collectDeclaredNames(masked, firstBodyStart, pouMatch);
  const sfcNames = new Set(declared);
  for (const bodyMatch of bodyMatches) collectSfcNames(bodyMatch.text, sfcNames);

  const undeclared = [];
  const functionBlockOutputAccesses = [];
  for (const bodyMatch of bodyMatches) {
    const bodyOffset = bodyMatch.marker === 'SFC_BODY'
      ? bodyMatch.index
      : bodyMatch.index + bodyMatch.markerOffset + bodyMatch.marker.length;
    const bodyText = bodyMatch.text;
    if (bodyMatch.marker.toUpperCase() === 'ST_BODY' || bodyMatch.marker.toUpperCase() === 'SFC_BODY') {
      findUndeclaredInStBody(bodyText, bodyOffset, sfcNames, undeclared);
      functionBlockOutputAccesses.push(...findFunctionBlockOutputAccesses(
        bodyText,
        bodyOffset,
        declared,
        pouMatch ? pouMatch[2] : ''
      ));
      findUndeclaredInFbdBody(bodyText, bodyOffset, sfcNames, undeclared);
    } else {
      findUndeclaredInFbdBody(bodyText, bodyOffset, sfcNames, undeclared);
    }
  }

  return {
    undeclared,
    indentation: findMixedIndentation(text),
    disabledNetworks: findDisabledNetworkRanges(masked),
    connectorMarkers: findConnectorMarkerRanges(text),
    variableSectionLabels: findVariableSectionLabels(text),
    variableSectionTags: findVariableSectionTagRanges(text),
    functionBlockOutputAccesses,
    fbdCoordinates: findFbdCoordinateRanges(text),
    fbdRecordBoundaries: findFbdRecordBoundaryRanges(text),
    structuralTags: findStructuralTagRanges(text),
    networkBodyTags: findNetworkBodyTagRanges(text),
    networkHeights: findNetworkHeightRanges(text),
    declarations: [...declared]
  };
}

function inspectRawLineEndings(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.includes(0)) return [];

  const issues = [];
  let line = 0;
  for (let index = 0; index < view.length; index += 1) {
    if (view[index] === 0x0a) {
      if (index === 0 || view[index - 1] !== 0x0d) issues.push({ line, kind: 'lf-only' });
      line += 1;
    } else if (view[index] === 0x0d && (index + 1 >= view.length || view[index + 1] !== 0x0a)) {
      issues.push({ line, kind: 'cr-only' });
      line += 1;
    }
  }
  return issues;
}

module.exports = {
  analyzeCfi,
  inspectRawLineEndings,
  findDisabledNetworkRanges,
  findConnectorMarkerRanges,
  findVariableSectionLabels,
  findVariableSectionTagRanges,
  findFunctionBlockOutputAccesses,
  findFbdCoordinateRanges,
  findFbdRecordBoundaryRanges,
  findStructuralTagRanges,
  findNetworkBodyTagRanges,
  findNetworkHeightRanges,
  maskCommentsAndStrings
};
