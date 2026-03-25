/* Copyright (c) 2021-2025 Richard Rodger, MIT License */


import {
  Jsonic,
  Rule,
  RuleSpec,
  Plugin,
  Config,
  Options,
  Context,
  Lex,
  Token,
} from 'jsonic'


type YamlOptions = {
}


const Yaml: Plugin = (jsonic: Jsonic, _options: YamlOptions) => {
  let TX = jsonic.token.TX
  let NR = jsonic.token.NR
  let ST = jsonic.token.ST
  let VL = jsonic.token.VL
  let CL = jsonic.token.CL
  let ZZ = jsonic.token.ZZ

  let IN = jsonic.token('#IN')

  // Shared anchor storage for the plugin instance.
  let anchors: Record<string, any> = {}
  let pendingAnchors: { name: string, inline: boolean }[] = []
  let pendingExplicitCL = false
  // Flag to tell the number matcher to skip, so text.check handles the value.
  let skipNumberMatch = false
  // Queue for tokens that need to be emitted across multiple lex calls.
  let pendingTokens: any[] = []
  // TAG directive handle mappings (e.g. %TAG !! tag:example.com/).
  // When !! is redefined, built-in type conversion is skipped.
  let tagHandles: Record<string, string> = {}

  // Preprocess flow collections for YAML-specific features.
  // Transforms flow collection content to be Jsonic-compatible:
  // - Implicit null-valued keys in flow mappings: {a, b: c} → {a: ~, b: c}
  // - Comments between key and colon: {"foo" # comment\n  :bar} → {"foo" :bar}
  // - Multiline quoted scalars in flow context: {"multi\n  line"} → {"multi line"}
  // - Explicit keys (?) inside flow collections
  function preprocessFlowCollections(src: string): string {
    let result = ''
    let i = 0

    while (i < src.length) {
      if (src[i] === '{' || src[i] === '[') {
        // Only treat as flow collection if it's at a value position:
        // after start of string, after newline+indent, after ": ", after "- ",
        // after ",", after "[" or "{", or preceded only by whitespace on its line.
        if (isFlowCollectionStart(src, i)) {
          let processed = processFlowCollection(src, i)
          result += processed.text
          i = processed.end
          continue
        }
      }
      result += src[i]
      i++
    }
    return result
  }

  // Determine if { or [ at position i is a flow collection opener.
  function isFlowCollectionStart(src: string, i: number): boolean {
    if (i === 0) return true
    // Look backward to find the preceding meaningful character.
    let j = i - 1
    while (j >= 0 && (src[j] === ' ' || src[j] === '\t')) j--
    if (j < 0) return true
    let prev = src[j]
    // After newline: it's a flow collection if it's the first thing on the line.
    if (prev === '\n' || prev === '\r') return true
    // After value/element/separator indicators.
    // NOTE: Do NOT treat a preceding "{" or "[" as a flow start signal.
    // That incorrectly classifies plain scalars such as: a{{q}}b
    // as nested flow collections.
    if (prev === ':' || prev === '-' || prev === ',') return true
    return false
  }

  function processFlowCollection(src: string, start: number): { text: string, end: number } {
    let open = src[start]
    let close = open === '{' ? '}' : ']'
    let isMap = open === '{'
    let out = open
    let i = start + 1

    // Track entries in flow mappings to detect implicit null-valued keys.
    let entryHasColon = false
    let entryParts: string[] = []

    while (i < src.length) {
      let ch = src[i]

      // Handle nested flow collections recursively.
      if (ch === '{' || ch === '[') {
        let nested = processFlowCollection(src, i)
        if (isMap) {
          entryParts.push(nested.text)
          entryHasColon = true // nested structures count as values
        } else {
          out += nested.text
        }
        i = nested.end
        continue
      }

      // Handle quoted strings.
      if (ch === '"') {
        let str = '"'
        i++
        while (i < src.length && src[i] !== '"') {
          if (src[i] === '\\') { str += src[i]; i++ }
          // Multiline double-quoted string: fold newlines into space.
          if (src[i] === '\n' || src[i] === '\r') {
            if (src[i] === '\r' && src[i + 1] === '\n') i++
            str += ' '
            i++
            while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++
            continue
          }
          str += src[i]
          i++
        }
        if (i < src.length) { str += '"'; i++ }
        if (isMap) entryParts.push(str)
        else out += str
        continue
      }

      if (ch === "'") {
        let str = "'"
        i++
        while (i < src.length) {
          if (src[i] === "'" && src[i + 1] === "'") { str += "''"; i += 2; continue }
          if (src[i] === "'") break
          // Multiline single-quoted string: fold newlines into space.
          if (src[i] === '\n' || src[i] === '\r') {
            if (src[i] === '\r' && src[i + 1] === '\n') i++
            str += ' '
            i++
            while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++
            continue
          }
          str += src[i]
          i++
        }
        if (i < src.length) { str += "'"; i++ }
        if (isMap) entryParts.push(str)
        else out += str
        continue
      }

      // Handle comments: strip them in flow context.
      if (ch === '#') {
        // Treat as comment if preceded by whitespace or at start of line.
        if (i > 0 && (src[i - 1] === ' ' || src[i - 1] === '\t' ||
            src[i - 1] === '\n' || src[i - 1] === '\r')) {
          while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++
          if (isMap) entryParts.push(' ')
          else out += ' '
          continue
        }
      }

      // Handle newlines in flow context: fold into space.
      if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && src[i + 1] === '\n') i++
        i++
        // Skip leading whitespace on continuation line.
        while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++
        if (isMap) entryParts.push(' ')
        else out += ' '
        continue
      }

      // Handle colon (key-value separator in flow mapping).
      if (isMap && ch === ':' && (src[i + 1] === ' ' || src[i + 1] === '\t' ||
          src[i + 1] === ',' || src[i + 1] === '}' || src[i + 1] === ']' ||
          src[i + 1] === '\n' || src[i + 1] === '\r' || src[i + 1] === undefined)) {
        entryHasColon = true
        entryParts.push(ch)
        i++
        continue
      }

      // Handle adjacent colon (no space after) as key-value separator in flow.
      if (isMap && ch === ':' && i > start + 1) {
        // Check if preceded by a quoted string close in the accumulated parts.
        let accumulated = entryParts.join('').trimEnd()
        if (accumulated.endsWith('"') || accumulated.endsWith("'")) {
          entryHasColon = true
        }
        entryParts.push(ch)
        i++
        continue
      }

      // Handle comma: end of entry.
      if (ch === ',') {
        if (isMap) {
          let entry = entryParts.join('').trim()
          if (!entryHasColon && entry.length > 0) {
            out += entry + ': ~,'
          } else {
            out += entry + ','
          }
          entryParts = []
          entryHasColon = false
        } else {
          out += ch
        }
        i++
        continue
      }

      // Handle closing bracket.
      if (ch === close) {
        if (isMap) {
          let entry = entryParts.join('').trim()
          if (!entryHasColon && entry.length > 0) {
            out += entry + ': ~'
          } else {
            out += entry
          }
        }
        out += close
        i++
        return { text: out, end: i }
      }

      // Handle explicit key indicator in flow context.
      // Only at the start of an entry (after open bracket/brace, comma,
      // or after newline with only whitespace before it).
      if (ch === '?' && (src[i + 1] === ' ' || src[i + 1] === '\t')) {
        let isEntryStart = false
        if (!isMap) {
          // Check if ? is at entry start position in sequence.
          let prevContent = out.trimEnd()
          let lastChar = prevContent[prevContent.length - 1]
          isEntryStart = lastChar === '[' || lastChar === ','
        } else {
          let accumulated = entryParts.join('').trim()
          isEntryStart = accumulated.length === 0
        }
        if (isEntryStart && !isMap) {
          // Convert [? key : val] → [{key: val}]
          out += '{'
          let inner = ''
          i += 2
          while (i < src.length && src[i] !== ',' && src[i] !== close) {
            if (src[i] === '\n' || src[i] === '\r') {
              if (src[i] === '\r' && src[i + 1] === '\n') i++
              inner += ' '
              i++
              while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++
              continue
            }
            if (src[i] === '#') {
              while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++
              continue
            }
            inner += src[i]
            i++
          }
          out += inner.trim() + '}'
          continue
        } else if (isEntryStart && isMap) {
          // In flow mapping, ? is an explicit key indicator — skip it.
          i += 2
          continue
        }
      }

      // Regular character.
      if (isMap) entryParts.push(ch)
      else out += ch
      i++
    }

    // Unclosed collection — return what we have.
    if (isMap) {
      out += entryParts.join('')
    }
    out += close
    return { text: out, end: i }
  }

  jsonic.options({
    fixed: {
      token: {
        // Single colon is not a YAML token, so remove.
        '#CL': null,
      }
    },

    // Colons can still end unquoted text (TX, lexer.textMatcher).
    ender: ':',

    // Remove single quote from string chars — YAML single-quoted strings
    // don't process backslash escapes, so we handle them in yamlMatcher.
    string: {
      chars: '`',
    },

    // Skip number matching when yamlMatcher detected trailing text
    // after a digit-starting value (e.g. "64 characters, hexadecimal.").
    number: {
      check: (_lex: any) => {
        if (skipNumberMatch) {
          skipNumberMatch = false
          return { done: true }
        }
      },
    },

    // Custom text check: consume to end of line (including spaces)
    // for YAML plain scalar values.
    text: {
      check: (lex: any) => {
        let pnt = lex.pnt
        let fwd = lex.src.substring(pnt.sI)

        let ch = fwd[0]
        // Block scalar: | or > (with optional chomping indicator)
        if (ch === '|' || ch === '>') {
          let fold = ch === '>'
          let chomp = 'clip' // default: single trailing newline
          let explicitIndent = 0
          let idx = 1
          // Parse optional chomping and indentation indicators in either order.
          // Valid: |, |+, |-, |2, |+2, |-2, |2+, |2-
          for (let pi = 0; pi < 2; pi++) {
            if (fwd[idx] === '+') { chomp = 'keep'; idx++ }
            else if (fwd[idx] === '-') { chomp = 'strip'; idx++ }
            else if (fwd[idx] >= '1' && fwd[idx] <= '9') { explicitIndent = parseInt(fwd[idx]); idx++ }
          }

          // Must be followed by newline (possibly with trailing spaces/comment)
          while (fwd[idx] === ' ') idx++
          if (fwd[idx] === '#') {
            while (idx < fwd.length && fwd[idx] !== '\n' && fwd[idx] !== '\r') idx++
          }
          if (fwd[idx] !== '\n' && fwd[idx] !== '\r' && fwd[idx] !== undefined) {
            // Not a block scalar — fall through to normal text handling.
          } else {
            // Skip the indicator line.
            if (fwd[idx] === '\r') idx++
            if (fwd[idx] === '\n') idx++

            // Determine block indent from first content line,
            // or use explicit indent indicator if provided.
            let blockIndent = 0
            if (explicitIndent === 0) {
              // Auto-detect: skip blank lines, find first content line.
              let tempIdx = idx
              while (tempIdx < fwd.length) {
                let lineSpaces = 0
                while (tempIdx + lineSpaces < fwd.length && fwd[tempIdx + lineSpaces] === ' ') lineSpaces++
                let afterSpaces = tempIdx + lineSpaces
                if (afterSpaces >= fwd.length || fwd[afterSpaces] === '\n' || fwd[afterSpaces] === '\r') {
                  // Blank line — skip it.
                  tempIdx = afterSpaces
                  if (fwd[tempIdx] === '\r') tempIdx++
                  if (fwd[tempIdx] === '\n') tempIdx++
                  continue
                }
                blockIndent = lineSpaces
                break
              }
            }

            // Determine the indent of the line containing the block indicator.
            // If blockIndent <= that indent, the block is empty (content must
            // be more indented than the containing line). Exception: after ---,
            // the containing indent is effectively -1 so blockIndent 0 is valid.
            let containingIndent = 0
            let isDocStart = false
            {
              let li = pnt.sI - 1
              while (li > 0 && lex.src[li - 1] !== '\n' && lex.src[li - 1] !== '\r') li--
              let lineStart = li
              while (li < pnt.sI && lex.src[li] === ' ') { containingIndent++; li++ }
              // Check if this line starts with --- (document start marker).
              if (lex.src[lineStart] === '-' && lex.src[lineStart+1] === '-' && lex.src[lineStart+2] === '-') {
                isDocStart = true
              }
            }
            // Apply explicit indent relative to containing indent.
            // Per YAML spec, the content indentation = block scalar's indent
            // level + indicator value. The block scalar's indent level is the
            // indent of the containing block (e.g., the mapping key), which
            // may differ from the line's leading spaces (e.g., after "- ").
            if (explicitIndent > 0) {
              // Find the line containing the block indicator.
              let li = pnt.sI - 1
              while (li > 0 && lex.src[li - 1] !== '\n' && lex.src[li - 1] !== '\r') li--
              // li is now at the start of the line. Find the colon position.
              let keyCol = containingIndent
              // Check if there's a colon on the SAME line as the block indicator.
              let hasColonOnLine = false
              for (let ci = li + containingIndent; ci < pnt.sI; ci++) {
                if (lex.src[ci] === ':' && (lex.src[ci+1] === ' ' || lex.src[ci+1] === '\t')) {
                  hasColonOnLine = true
                  break
                }
              }
              if (hasColonOnLine) {
                // Block indicator on same line as colon (e.g., "key: |2").
                // Check for sequence indicators: each "- " adds to the effective indent.
                let scanI = li + containingIndent
                while (scanI < pnt.sI && lex.src[scanI] === '-' &&
                       (lex.src[scanI+1] === ' ' || lex.src[scanI+1] === '\t')) {
                  keyCol += 2
                  scanI += 2
                  while (scanI < pnt.sI && lex.src[scanI] === ' ') { keyCol++; scanI++ }
                }
                blockIndent = keyCol + explicitIndent
              } else {
                // Block indicator on its own line (e.g., after a tag on
                // a separate line). Look backward to find the parent
                // mapping key's indent by scanning previous lines for
                // the colon that started this value context.
                let parentIndent = 0
                let searchI = li - 1
                while (searchI > 0) {
                  // Find start of previous line.
                  if (lex.src[searchI] === '\n') searchI--
                  if (lex.src[searchI] === '\r') searchI--
                  let prevLineEnd = searchI + 1
                  while (searchI > 0 && lex.src[searchI - 1] !== '\n' && lex.src[searchI - 1] !== '\r') searchI--
                  let prevLineStart = searchI
                  // Check if this line has a colon (mapping key).
                  for (let ci = prevLineStart; ci < prevLineEnd; ci++) {
                    if (lex.src[ci] === ':' && (lex.src[ci+1] === ' ' || lex.src[ci+1] === '\t' ||
                        lex.src[ci+1] === '\n' || lex.src[ci+1] === '\r' || ci+1 >= prevLineEnd)) {
                      // Found the parent key line. Get its indent.
                      parentIndent = 0
                      let pi = prevLineStart
                      while (pi < prevLineEnd && lex.src[pi] === ' ') { parentIndent++; pi++ }
                      break
                    }
                  }
                  break  // Only check the immediately preceding non-blank line.
                }
                blockIndent = parentIndent + explicitIndent
                // Update containingIndent to parent's indent so the
                // "blockIndent <= containingIndent" check below works.
                containingIndent = parentIndent
              }
            }
            if (blockIndent <= containingIndent && !isDocStart && idx < fwd.length) {
              // Content is not indented enough — empty block scalar.
              // For keep chomping, count trailing blank lines.
              let val: string
              if (chomp === 'keep') {
                let blankCount = 0
                let bi = idx
                while (bi < fwd.length) {
                  if (fwd[bi] === '\n') { blankCount++; bi++ }
                  else if (fwd[bi] === '\r') { bi++; if (bi < fwd.length && fwd[bi] === '\n') bi++; blankCount++ }
                  else break
                }
                val = '\n'.repeat(blankCount > 0 ? blankCount : 1)
                idx = bi
              } else {
                val = chomp === 'strip' ? '' : ''
              }
              let src = fwd.substring(0, idx)
              let tkn = lex.token('#TX', val, src, pnt)
              pnt.sI += idx
              pnt.rI += 1
              pnt.cI = 0
              return { done: true, token: tkn }
            }

            // Collect indented lines.
            let lines: string[] = []
            let pos = idx
            let rows = 1 // Already consumed one newline
            let lastNewlinePos = idx // Track position before last consumed newline
            while (pos < fwd.length) {
              // Check indent of current line.
              let lineIndent = 0
              while (pos + lineIndent < fwd.length && fwd[pos + lineIndent] === ' ') lineIndent++

              // Blank line (only whitespace before newline or end).
              let afterSpaces = pos + lineIndent
              if (afterSpaces >= fwd.length || fwd[afterSpaces] === '\n' || fwd[afterSpaces] === '\r') {
                // Preserve spaces beyond block indent on blank lines.
                if (lineIndent > blockIndent) {
                  lines.push(fwd.substring(pos + blockIndent, afterSpaces))
                } else {
                  lines.push('')
                }
                lastNewlinePos = afterSpaces
                pos = afterSpaces
                if (fwd[pos] === '\r') pos++
                if (fwd[pos] === '\n') pos++
                rows++
                continue
              }

              // Less indent means end of block.
              if (lineIndent < blockIndent) break

              // Stop at document markers (--- or ...) at indent 0.
              if (lineIndent === 0 &&
                  ((fwd[pos] === '-' && fwd[pos+1] === '-' && fwd[pos+2] === '-' &&
                    (fwd[pos+3] === '\n' || fwd[pos+3] === '\r' || fwd[pos+3] === ' ' || fwd[pos+3] === undefined)) ||
                   (fwd[pos] === '.' && fwd[pos+1] === '.' && fwd[pos+2] === '.' &&
                    (fwd[pos+3] === '\n' || fwd[pos+3] === '\r' || fwd[pos+3] === ' ' || fwd[pos+3] === undefined)))) break

              // Consume the line content (strip block indent).
              let lineStart = pos + blockIndent
              let lineEnd = lineStart
              while (lineEnd < fwd.length && fwd[lineEnd] !== '\n' && fwd[lineEnd] !== '\r') lineEnd++
              lines.push(fwd.substring(lineStart, lineEnd))
              lastNewlinePos = lineEnd
              pos = lineEnd
              if (fwd[pos] === '\r') pos++
              if (fwd[pos] === '\n') pos++
              rows++
            }

            // Build the scalar value.
            let val: string
            if (fold) {
              // Folded: newlines between "normal" lines become spaces.
              // Empty lines and "more indented" lines are preserved literally.
              let result = ''
              let prevWasNormal = false
              let pendingEmptyCount = 0
              for (let li = 0; li < lines.length; li++) {
                let line = lines[li]
                let isMore = line.length > 0 && (line[0] === ' ' || line[0] === '\t')
                let isEmpty = line === ''

                if (isEmpty) {
                  pendingEmptyCount++
                } else if (isMore) {
                  // Flush pending empty lines, with paragraph-close if needed.
                  if (prevWasNormal && result.length > 0) result += '\n'
                  for (let ei = 0; ei < pendingEmptyCount; ei++) result += '\n'
                  pendingEmptyCount = 0
                  // "More indented" — preserve with newlines around it.
                  if (result.length > 0 && result[result.length - 1] !== '\n') {
                    result += '\n'
                  }
                  result += line + '\n'
                  prevWasNormal = false
                } else {
                  // Normal line.
                  if (pendingEmptyCount > 0) {
                    // Empty lines between content: emit them.
                    // The transition normal→empty→normal needs paragraph-close \n
                    // (which counts as the first empty line).
                    if (prevWasNormal && result.length > 0) {
                      // First empty line is the paragraph break.
                      result += '\n'
                      for (let ei = 1; ei < pendingEmptyCount; ei++) result += '\n'
                    } else {
                      for (let ei = 0; ei < pendingEmptyCount; ei++) result += '\n'
                    }
                    pendingEmptyCount = 0
                  }
                  if (prevWasNormal && result.length > 0 && result[result.length - 1] !== '\n') {
                    // Join with space (folding).
                    result += ' '
                  }
                  result += line
                  prevWasNormal = true
                }
              }
              // Flush trailing empty lines.
              for (let ei = 0; ei < pendingEmptyCount; ei++) result += '\n'
              val = result
            } else {
              // Literal: preserve newlines.
              val = lines.join('\n')
            }

            // Apply chomping.
            if (lines.length === 0) {
              // No content lines at all — result is empty string
              // regardless of chomping.
              val = ''
            } else if (chomp === 'strip') {
              val = val.replace(/\n+$/, '')
            } else if (chomp === 'clip') {
              val = val.replace(/\n+$/, '') + '\n'
            } else {
              // keep: preserve all trailing newlines
              val = val + '\n'
            }

            // If block ended because of less indent (more content follows
            // that isn't a doc marker), don't consume the final newline —
            // leave it for the yamlMatcher to emit #IN so the grammar can
            // continue properly.
            let endPos = pos
            let endRows = rows
            if (pos < fwd.length && pos > lastNewlinePos) {
              // Check if the next content is a doc marker (--- or ...).
              let nextLineIndent = 0
              let ni = pos
              while (ni < fwd.length && fwd[ni] === ' ') { nextLineIndent++; ni++ }
              let isDocMarker = nextLineIndent === 0 &&
                ((fwd[ni] === '-' && fwd[ni+1] === '-' && fwd[ni+2] === '-') ||
                 (fwd[ni] === '.' && fwd[ni+1] === '.' && fwd[ni+2] === '.'))
              if (!isDocMarker) {
                // Regular content follows — back up to the newline position.
                endPos = lastNewlinePos
                endRows = rows - 1
              }
            }
            let src = fwd.substring(0, endPos)
            let tkn = lex.token('#TX', val, src, pnt)
            pnt.sI += endPos
            pnt.rI += endRows
            pnt.cI = 0
            return { done: true, token: tkn }
          }
        }

        // YAML tags: !!type value
        if (ch === '!' && fwd[1] === '!') {
          let tagEnd = 2
          while (tagEnd < fwd.length && fwd[tagEnd] !== ' ' && fwd[tagEnd] !== '\n' &&
                 fwd[tagEnd] !== '\r') tagEnd++
          let tag = fwd.substring(2, tagEnd)
          // For !!seq and !!map, these are handled in the yamlMatcher.
          if (tag === 'seq' || tag === 'map') {
            return null  // Don't advance pnt — let yamlMatcher handle it.
          }
          // For value tags, parse the value after the tag.
          let valStart = tagEnd
          if (fwd[valStart] === ' ') valStart++
          // Get the raw value string.
          let rawVal = ''
          let valEnd = valStart
          if (fwd[valStart] === '"' || fwd[valStart] === "'") {
            // Quoted value — find matching close quote.
            let q = fwd[valStart]
            valEnd = valStart + 1
            while (valEnd < fwd.length && fwd[valEnd] !== q) {
              if (fwd[valEnd] === '\\' && q === '"') valEnd++  // Skip escape in double quotes.
              valEnd++
            }
            if (fwd[valEnd] === q) valEnd++
            rawVal = fwd.substring(valStart + 1, valEnd - 1)
          } else {
            // Unquoted value — to end of line, stopping at `: ` and ` #`.
            while (valEnd < fwd.length && fwd[valEnd] !== '\n' && fwd[valEnd] !== '\r') {
              if (fwd[valEnd] === ':' && (fwd[valEnd+1] === ' ' || fwd[valEnd+1] === '\n' ||
                  fwd[valEnd+1] === '\r' || fwd[valEnd+1] === undefined)) break
              if (fwd[valEnd] === ' ' && fwd[valEnd+1] === '#') break
              valEnd++
            }
            rawVal = fwd.substring(valStart, valEnd).replace(/\s+$/, '')
          }
          // Apply tag conversion.
          let result: any
          if (tag === 'str') result = String(rawVal)
          else if (tag === 'int') result = parseInt(rawVal, 10)
          else if (tag === 'float') result = parseFloat(rawVal)
          else if (tag === 'bool') result = rawVal === 'true' || rawVal === 'True' || rawVal === 'TRUE'
          else if (tag === 'null') result = null
          else result = rawVal  // Unknown tag — keep as string.

          let src = fwd.substring(0, valEnd)
          let tknTin = typeof result === 'string' ? '#TX' :
                       typeof result === 'number' ? '#NR' :
                       '#VL'
          let tkn = lex.token(tknTin, result, src, pnt)
          pnt.sI += valEnd
          pnt.cI += valEnd
          return { done: true, token: tkn }
        }

        // Don't apply text check for special chars or flow context.
        // Also skip * and & which are YAML alias/anchor indicators.
        if (ch === '{' || ch === '}' || ch === '[' || ch === ']' ||
            ch === ',' || ch === '#' || ch === '\n' ||
            ch === '\r' || ch === '"' || ch === "'" ||
            ch === '*' || ch === '&' || ch === '!' ||
            ch === undefined) {
          return null
        }
        // Colon only starts a key-value separator if followed by space/tab/newline/eof.
        // Otherwise it can start a plain scalar (e.g. ::vector).
        if (ch === ':' && (fwd[1] === ' ' || fwd[1] === '\t' || fwd[1] === '\n' ||
            fwd[1] === '\r' || fwd[1] === undefined)) {
          return null
        }

        // Match text to end of line, stopping at `: `, `:\n`, ` #`, or newline.
        // This handles YAML plain scalars with multiline continuation.
        // Detect if we're inside a flow collection (brackets/braces).
        let inFlowCtx = false
        {
          let depth = 0
          for (let fi = 0; fi < pnt.sI; fi++) {
            let fc = lex.src[fi]
            if (fc === '{' || fc === '[') depth++
            else if (fc === '}' || fc === ']') { if (depth > 0) depth-- }
            else if (fc === '"') {
              fi++; while (fi < pnt.sI && lex.src[fi] !== '"') { if (lex.src[fi] === '\\') fi++; fi++ }
            }
            else if (fc === "'") {
              fi++; while (fi < pnt.sI && lex.src[fi] !== "'") { if (lex.src[fi] === "'" && lex.src[fi+1] === "'") fi++; fi++ }
            }
          }
          inFlowCtx = depth > 0
        }
        // Find key indent and determine context for multiline scalars.
        let lineStart = pnt.sI
        while (lineStart > 0 && lex.src[lineStart - 1] !== '\n' && lex.src[lineStart - 1] !== '\r') lineStart--

        // Current line indent (indent of the line where text starts).
        let currentLineIndent = 0
        {
          let ci = lineStart
          while (ci < pnt.sI && lex.src[ci] === ' ') { currentLineIndent++; ci++ }
        }

        // Check if text is preceded by ": " on the same line (map value context).
        let isMapValue = false
        {
          let ci = pnt.sI - 1
          // Skip whitespace before text
          while (ci >= lineStart && (lex.src[ci] === ' ' || lex.src[ci] === '\t')) ci--
          if (ci >= lineStart && lex.src[ci] === ':') isMapValue = true
        }

        // For map values: continuation requires indent > key indent (parent line's indent).
        // For standalone scalars: continuation requires indent >= current line indent.
        let keyIndent = 0
        let prevLineStart = lineStart
        if (prevLineStart > 0) {
          let pi = prevLineStart - 1
          if (pi >= 0 && lex.src[pi] === '\n') pi--
          if (pi >= 0 && lex.src[pi] === '\r') pi--
          while (pi > 0 && lex.src[pi - 1] !== '\n' && lex.src[pi - 1] !== '\r') pi--
          while (pi < prevLineStart && lex.src[pi] === ' ') { keyIndent++; pi++ }
        }

        // The minimum indent for continuation lines.
        // For map values, continuation indent is based on the colon's line indent,
        // not the previous line's indent (which may be a key continuation line).
        let minContinuationIndent = isMapValue ? currentLineIndent + 1 : currentLineIndent
        let text = ''
        let i = 0
        let totalConsumed = 0
        let rows = 0
        let scanLine = () => {
          let line = ''
          while (i < fwd.length) {
            let c = fwd[i]
            if (c === '\n' || c === '\r') break
            if (c === ':' && (fwd[i + 1] === ' ' || fwd[i + 1] === '\t' || fwd[i + 1] === '\n' ||
                fwd[i + 1] === '\r' || fwd[i + 1] === undefined)) break
            if ((c === ' ' || c === '\t') && fwd[i + 1] === '#') break
            if (inFlowCtx && (c === ']' || c === '}')) break
            if (c === ',' && inFlowCtx) break
            line += c
            i++
          }
          return line.replace(/\s+$/, '')
        }

        text = scanLine()
        totalConsumed = i

        // Check for continuation lines (multiline plain scalars).
        // Blank lines (whitespace-only) within a scalar become newlines.
        while (i < fwd.length && (fwd[i] === '\n' || fwd[i] === '\r')) {
          let nlPos = i
          // Count blank lines (lines with only whitespace).
          let blankLines = 0
          while (i < fwd.length && (fwd[i] === '\n' || fwd[i] === '\r')) {
            if (fwd[i] === '\r') i++
            if (fwd[i] === '\n') i++
            // Count indent of next line.
            let li = 0
            while (i + li < fwd.length && (fwd[i + li] === ' ' || fwd[i + li] === '\t')) li++
            if (i + li >= fwd.length || fwd[i + li] === '\n' || fwd[i + li] === '\r') {
              // Blank line — count it and skip.
              blankLines++
              i += li
              continue
            }
            break
          }
          // Count indent of the content line after blank lines.
          let lineIndent = 0
          while (i < fwd.length && (fwd[i] === ' ' || fwd[i] === '\t')) { lineIndent++; i++ }
          // In flow context, continuation is allowed regardless of indent
          // (as long as the next line doesn't start a flow indicator or comment).
          // In block context, must be more indented than the key.
          // Check for document markers (--- or ...) at column 0.
          let isDocMarker = lineIndent === 0 &&
            ((fwd[i] === '-' && fwd[i+1] === '-' && fwd[i+2] === '-' &&
              (fwd[i+3] === ' ' || fwd[i+3] === '\t' || fwd[i+3] === '\n' ||
               fwd[i+3] === '\r' || fwd[i+3] === undefined)) ||
             (fwd[i] === '.' && fwd[i+1] === '.' && fwd[i+2] === '.' &&
              (fwd[i+3] === ' ' || fwd[i+3] === '\t' || fwd[i+3] === '\n' ||
               fwd[i+3] === '\r' || fwd[i+3] === undefined)))
          // Check for sequence marker "- ". Only treat as a new sequence
          // entry when the indent matches an enclosing sequence's level.
          // Find the nearest "- " sequence marker preceding the text on
          // the first line to determine the relevant sequence indent.
          let isSeqMarker = false
          if (fwd[i] === '-' &&
              (fwd[i+1] === ' ' || fwd[i+1] === '\t' || fwd[i+1] === '\n' ||
               fwd[i+1] === '\r' || fwd[i+1] === undefined)) {
            // Determine the sequence indent from the first line's context.
            // Look backward from pnt.sI to find "- " markers before the text.
            let seqIndent = -1
            let si = pnt.sI - 1
            while (si >= lineStart) {
              if (lex.src[si] === '-' && (lex.src[si+1] === ' ' || lex.src[si+1] === '\t')) {
                seqIndent = si - lineStart
                break
              }
              si--
            }
            // isSeqMarker if the continuation "- " matches a known sequence
            // indent, or if it's at the current line indent level.
            isSeqMarker = (seqIndent >= 0 && lineIndent === seqIndent) ||
                          (seqIndent < 0 && lineIndent <= currentLineIndent)
          }
          let canContinue = inFlowCtx
            ? (i < fwd.length && fwd[i] !== '\n' && fwd[i] !== '\r' &&
               fwd[i] !== '#' && fwd[i] !== '{' && fwd[i] !== '}' &&
               fwd[i] !== '[' && fwd[i] !== ']')
            : (lineIndent >= minContinuationIndent && i < fwd.length &&
               fwd[i] !== '\n' && fwd[i] !== '\r' && fwd[i] !== '#' &&
               !isDocMarker && !isSeqMarker)
          if (canContinue) {
            // Check if this line is a key-value pair (contains ": ").
            let peekJ = i
            let isKV = false
            while (peekJ < fwd.length && fwd[peekJ] !== '\n' && fwd[peekJ] !== '\r') {
              if (fwd[peekJ] === ':' && (fwd[peekJ + 1] === ' ' || fwd[peekJ + 1] === '\t' ||
                  fwd[peekJ + 1] === '\n' || fwd[peekJ + 1] === '\r' ||
                  fwd[peekJ + 1] === undefined)) {
                isKV = true
                break
              }
              if (fwd[peekJ] === '}' || fwd[peekJ] === ']' || fwd[peekJ] === ',') {
                break
              }
              peekJ++
            }
            if (!isKV || inFlowCtx) {
              let contLine = scanLine()
              if (contLine.length > 0) {
                // Blank lines → newlines; single newline → space (folding).
                if (blankLines > 0) {
                  for (let b = 0; b < blankLines; b++) text += '\n'
                } else {
                  text += ' '
                }
                text += contLine
                totalConsumed = i
                rows++
                continue
              }
            }
          }
          // Not a continuation — revert to newline position.
          i = nlPos
          break
        }

        text = text.replace(/\s+$/, '')

        if (text.length === 0) return null

        // Check if this is a known YAML value.
        let valMap: Record<string, any> = {
          'true': true, 'True': true, 'TRUE': true,
          'false': false, 'False': false, 'FALSE': false,
          'null': null, 'Null': null, 'NULL': null,
          '~': null,
          'yes': true, 'Yes': true, 'YES': true,
          'no': false, 'No': false, 'NO': false,
          'on': true, 'On': true, 'ON': true,
          'off': false, 'Off': false, 'OFF': false,
          '.inf': Infinity, '.Inf': Infinity, '.INF': Infinity,
          '-.inf': -Infinity, '-.Inf': -Infinity, '-.INF': -Infinity,
          '.nan': NaN, '.NaN': NaN, '.NAN': NaN,
        }
        if (text in valMap) {
          let tkn = lex.token('#VL', valMap[text], text, pnt)
          pnt.sI += text.length
          pnt.cI += text.length
          return { done: true, token: tkn }
        }

        // Check if it's a number.
        let num = +text
        if (!isNaN(num) && text !== '') {
          let tkn = lex.token('#NR', num, text, pnt)
          pnt.sI += text.length
          pnt.cI += text.length
          return { done: true, token: tkn }
        }

        // Plain text — consume to end of meaningful content.
        let src = fwd.substring(0, totalConsumed)
        let tkn = lex.token('#TX', text, src, pnt)
        pnt.sI += totalConsumed
        pnt.rI += rows
        pnt.cI += totalConsumed  // approximate
        return { done: true, token: tkn }
      },
    },
  })

  // Register #EL token (not as a fixed token — we match it in yamlMatcher).
  let EL = jsonic.token('#EL')

  // Flow collection tokens.
  let CA = jsonic.token.CA  // comma
  let CS = jsonic.token.CS  // ]
  let CB = jsonic.token.CB  // }
  let OS = jsonic.token.OS  // [
  let OB = jsonic.token.OB  // {

  // All tokens that can start a value.
  let KEY = [TX, NR, ST, VL]

  // Add a custom lex matcher for YAML special cases.
  jsonic.options({
    lex: {
      match: {
        yaml: {
          order: 5e5,
          make: (_cfg: Config, _opts: Options) => {
            let srcCleaned = false
            return function yamlMatcher(lex: Lex) {
              // On first call, strip YAML document markers and directives
              // from lex.src. These must be removed before lexing because
              // jsonic reverts pnt.sI when a lex matcher returns undefined.
              if (!srcCleaned) {
                srcCleaned = true
                let src: string = '' + lex.src
                let hadDirective = false
                // Remove leading directive block: everything before ---
                // when the source starts with a % directive.
                if (src[0] === '%') {
                  let dIdx = src.indexOf('\n---')
                  if (dIdx >= 0) {
                    // Parse %TAG directives before stripping.
                    let dirBlock = src.substring(0, dIdx)
                    let dirLines = dirBlock.split('\n')
                    for (let dl of dirLines) {
                      let tagMatch = dl.match(/^%TAG\s+(\S+)\s+(\S+)/)
                      if (tagMatch) {
                        tagHandles[tagMatch[1]] = tagMatch[2]
                      }
                    }
                    hadDirective = true
                    src = src.substring(dIdx + 1)
                  }
                  // If no --- follows the directive, leave the % lines
                  // for jsonic to error on (invalid YAML).
                }
                // Strip leading comment lines (before ---).
                while (/^[ \t]*#[^\n]*\n/.test(src) && /\n---/.test(src)) {
                  src = src.replace(/^[ \t]*#[^\n]*\n/, '')
                }
                // Handle document start marker (---).
                let docMatch = src.match(/^---(?:([ \t]+)(.+))?(\r?\n|$)/)
                let docStripped = false
                if (docMatch) {
                  let prefix = docMatch[2] || ''
                  let rest = src.substring(docMatch[0].length)
                  let trimmed = prefix.trimStart()
                  // Don't strip --- when followed by block scalar indicators
                  // (> or |) — those need --- context for correct parsing.
                  if (trimmed[0] === '>' || trimmed[0] === '|') {
                    // Leave --- in place, just truncate at next document marker.
                  } else if (prefix && trimmed[0] !== '#') {
                    // If the inline content is a structural tag (!!map, !!seq,
                    // !!omap, etc.), strip the tag along with --- since the
                    // parser handles these structures implicitly.
                    let structTagMatch = trimmed.match(/^!!(seq|map|omap|set|pairs|binary|ordered)\s*$/)
                    if (structTagMatch) {
                      src = rest
                    } else {
                      src = prefix + (docMatch[3] || '') + rest
                    }
                    docStripped = true
                  } else {
                    src = rest
                    docStripped = true
                  }
                }
                // Truncate at the next document marker (---, ..., or %YAML/%TAG at column 0).
                // Use a manual search to skip markers inside quoted strings.
                {
                  let searchPos = 0
                  let truncateAt = -1
                  while (searchPos < src.length) {
                    // Skip quoted strings.
                    if (src[searchPos] === '"') {
                      searchPos++
                      while (searchPos < src.length && src[searchPos] !== '"') {
                        if (src[searchPos] === '\\') searchPos++
                        searchPos++
                      }
                      if (searchPos < src.length) searchPos++ // skip closing quote
                      continue
                    }
                    if (src[searchPos] === "'") {
                      searchPos++
                      while (searchPos < src.length && src[searchPos] !== "'") {
                        if (src[searchPos] === "'" && src[searchPos + 1] === "'") searchPos++
                        searchPos++
                      }
                      if (searchPos < src.length) searchPos++ // skip closing quote
                      continue
                    }
                    // Check for document marker at start of line.
                    if (searchPos > 0 && (src[searchPos - 1] === '\n' || src[searchPos - 1] === '\r')) {
                      let marker = src.substring(searchPos, searchPos + 3)
                      let after = src[searchPos + 3]
                      if ((marker === '---' || marker === '...') &&
                          (after === ' ' || after === '\t' || after === '\n' ||
                           after === '\r' || after === undefined)) {
                        truncateAt = searchPos
                        break
                      }
                    }
                    searchPos++
                  }
                  if (truncateAt > 0) {
                    src = src.substring(0, truncateAt)
                  }
                }
                // After stripping first ---, if remaining is just another ---
                // or ..., the document is empty.
                if (docStripped && /^(---|\.\.\.)(\s|$)/.test(src)) {
                  src = ''
                }
                // Preprocess flow collections for YAML-specific features
                // that Jsonic's core parser doesn't handle natively:
                // - Implicit null-valued keys in flow mappings: {a, b: c}
                // - Comments between key and colon: {"foo" # comment\n  :bar}
                // - Multiline plain/quoted scalars in flow context
                // - Explicit keys (?) inside flow collections
                src = preprocessFlowCollections(src)

                lex.src = src
                lex.pnt.len = src.length
                // If source is empty/whitespace/comments-only after preprocessing,
                // return a VL null token so jsonic resolves to null instead of
                // creating a #BD error. Only do this when source doesn't start
                // with an unprocessed % directive (those should error).
                let stripped = src.replace(/^[ \t]*#[^\n]*(\n|$)/gm, '').trim()
                if (src[0] !== '%' &&
                    (src.trim() === '' || stripped === '' ||
                     /^\.\.\.(?:[ \t]|$)/.test(stripped))) {
                  lex.pnt.len = 0
                  let tkn = lex.token('#VL', null, '', lex.pnt)
                  lex.pnt.sI = 0
                  return tkn
                }
              }
              // Drain any queued tokens first (from multi-token explicit keys).
              if (pendingTokens.length > 0) {
                return pendingTokens.shift()
              }

              let pnt = lex.pnt
              let fwd = lex.src.substring(pnt.sI)

              // Loop to restart matching after consuming flow whitespace.
              yamlMatchLoop: while (true) {

              // Skip blank lines that contain only tabs (and maybe spaces).
              // YAML treats these as blank lines, but jsonic errors on bare tabs.
              if (fwd[0] === '\t' || fwd[0] === ' ') {
                let lineEnd = fwd.indexOf('\n')
                let lineContent = lineEnd >= 0 ? fwd.substring(0, lineEnd) : fwd
                if (lineContent.indexOf('\t') >= 0 && /^[ \t]+$/.test(lineContent)) {
                  let skip = lineEnd >= 0 ? lineEnd + 1 : lineContent.length
                  pnt.sI += skip
                  pnt.rI++
                  pnt.cI = 0
                  fwd = lex.src.substring(pnt.sI)
                  continue yamlMatchLoop
                }
              }

              // Emit pending CL from explicit key — must be before !!type handlers
              // so the CL token appears before the value token.
              if (pendingExplicitCL) {
                pendingExplicitCL = false
                let tkn = lex.token('#CL', 1, ': ', lex.pnt)
                return tkn
              }

              // YAML alias: *name — emit a VL token with alias name.
              // Resolution happens at grammar time (val.ac) since the anchor
              // may not be recorded yet due to lexer pre-fetching.
              if (fwd[0] === '*') {
                let nameEnd = 1
                while (nameEnd < fwd.length && fwd[nameEnd] !== ' ' && fwd[nameEnd] !== '\t' &&
                       fwd[nameEnd] !== '\n' && fwd[nameEnd] !== '\r' && fwd[nameEnd] !== ',' &&
                       fwd[nameEnd] !== '{' && fwd[nameEnd] !== '}' && fwd[nameEnd] !== '[' &&
                       fwd[nameEnd] !== ']') {
                  // Colon terminates only when followed by space/tab (key-value separator).
                  // Otherwise colon is a valid anchor-name character per YAML spec.
                  if (fwd[nameEnd] === ':' &&
                      (fwd[nameEnd+1] === ' ' || fwd[nameEnd+1] === '\t')) break
                  nameEnd++
                }
                let name = fwd.substring(1, nameEnd)
                let src = fwd.substring(0, nameEnd)
                // Check if this alias is used as a map key (followed by ` :` or `:`).
                let afterAlias = nameEnd
                while (afterAlias < fwd.length && (fwd[afterAlias] === ' ' || fwd[afterAlias] === '\t')) afterAlias++
                let isKey = afterAlias < fwd.length && fwd[afterAlias] === ':' &&
                  (fwd[afterAlias+1] === ' ' || fwd[afterAlias+1] === '\t' ||
                   fwd[afterAlias+1] === '\n' || fwd[afterAlias+1] === '\r' ||
                   fwd[afterAlias+1] === undefined)
                if (isKey && anchors[name] !== undefined) {
                  // Resolve alias immediately as a key string.
                  let resolved = String(anchors[name])
                  let tkn = lex.token('#TX', resolved, src, lex.pnt)
                  pnt.sI += nameEnd
                  pnt.cI += nameEnd
                  return tkn
                }
                // Resolve alias immediately if anchor exists, since deferred
                // markers can be lost through Jsonic's rule processing.
                let tkn: any
                if (anchors[name] !== undefined) {
                  let val = anchors[name]
                  if (typeof val === 'object' && val !== null) {
                    val = JSON.parse(JSON.stringify(val))
                  }
                  let tin = typeof val === 'string' ? '#TX' :
                            typeof val === 'number' ? '#NR' : '#VL'
                  tkn = lex.token(tin, val, src, lex.pnt)
                } else {
                  // Anchor not yet seen — store marker for deferred resolution.
                  let marker = { __yamlAlias: name }
                  tkn = lex.token('#VL', marker, src, lex.pnt)
                }
                pnt.sI += nameEnd
                pnt.cI += nameEnd
                return tkn
              }

              // YAML anchor: &name — store value. Skip the anchor marker,
              // let the value be parsed, and record it post-parse via grammar rules.
              if (fwd[0] === '&') {
                let nameEnd = 1
                while (nameEnd < fwd.length && fwd[nameEnd] !== ' ' && fwd[nameEnd] !== '\t' &&
                       fwd[nameEnd] !== '\n' && fwd[nameEnd] !== '\r' && fwd[nameEnd] !== ',' &&
                       fwd[nameEnd] !== '{' && fwd[nameEnd] !== '}' && fwd[nameEnd] !== '[' &&
                       fwd[nameEnd] !== ']') nameEnd++
                let anchorName = fwd.substring(1, nameEnd)
                let skip = nameEnd
                if (fwd[skip] === ' ' || fwd[skip] === '\t') skip++
                // Check if anchor is standalone (first content on its line).
                // Look backward to see if only whitespace precedes & on this line.
                let isStandalone = true
                let anchorIndent = 0
                {
                  let bi = pnt.sI - 1
                  while (bi >= 0 && lex.src[bi] !== '\n' && lex.src[bi] !== '\r') {
                    if (lex.src[bi] !== ' ' && lex.src[bi] !== '\t') {
                      isStandalone = false
                      break
                    }
                    anchorIndent++
                    bi--
                  }
                }
                pnt.sI += skip
                pnt.cI += skip
                // Determine if anchor is inline (content follows on same line)
                // or standalone (only newline follows).
                let anchorInline = !(isStandalone &&
                    (lex.src[pnt.sI] === '\r' || lex.src[pnt.sI] === '\n' ||
                     pnt.sI >= lex.src.length))
                // For inline anchors before scalar values, record the anchor
                // immediately so aliases in later pairs can resolve them.
                if (anchorInline) {
                  let peek = lex.src.substring(pnt.sI)
                  let pch = peek[0]
                  if (pch !== '[' && pch !== '{' && pch !== '>' && pch !== '|' &&
                      pch !== '\n' && pch !== '\r' && pch !== undefined) {
                    let scalarVal: string | undefined
                    if (pch === '"') {
                      let ei = 1
                      while (ei < peek.length && peek[ei] !== '"') {
                        if (peek[ei] === '\\') ei++
                        ei++
                      }
                      scalarVal = peek.substring(1, ei)
                        .replace(/\\n/g, '\n').replace(/\\t/g, '\t')
                        .replace(/\\\\/g, '\\').replace(/\\"/g, '"')
                    } else if (pch === "'") {
                      let ei = 1
                      while (ei < peek.length && peek[ei] !== "'") {
                        if (peek[ei] === "'" && peek[ei+1] === "'") ei++
                        ei++
                      }
                      scalarVal = peek.substring(1, ei).replace(/''/g, "'")
                    } else {
                      let ei = 0
                      while (ei < peek.length && peek[ei] !== '\n' && peek[ei] !== '\r' &&
                             peek[ei] !== ',' && peek[ei] !== '}' && peek[ei] !== ']') {
                        if (peek[ei] === ':' && (peek[ei+1] === ' ' || peek[ei+1] === '\t' ||
                            peek[ei+1] === '\n' || peek[ei+1] === '\r' ||
                            peek[ei+1] === undefined)) break
                        if (peek[ei] === ' ' && peek[ei+1] === '#') break
                        ei++
                      }
                      let raw = peek.substring(0, ei).trim()
                      if (raw.length > 0) scalarVal = raw
                    }
                    if (scalarVal !== undefined) {
                      anchors[anchorName] = scalarVal
                    }
                  }
                }
                // Push pending anchor with inline flag.
                pendingAnchors.push({ name: anchorName, inline: anchorInline })
                // If anchor is standalone on its own line (followed by newline),
                // consume the newline and leading spaces so no extra IN token
                // is emitted. Only consume when next line indent >= anchor indent,
                // otherwise let the normal indent handler manage the transition.
                if (isStandalone &&
                    (lex.src[pnt.sI] === '\r' || lex.src[pnt.sI] === '\n')) {
                  let nl = pnt.sI
                  if (lex.src[nl] === '\r') nl++
                  if (lex.src[nl] === '\n') nl++
                  let spaces = 0
                  while (nl + spaces < lex.src.length && lex.src[nl + spaces] === ' ') spaces++
                  let nextCh = lex.src[nl + spaces]
                  if (nextCh !== undefined && nextCh !== '\n' && nextCh !== '\r' &&
                      spaces >= anchorIndent) {
                    pnt.sI = nl + spaces
                    pnt.cI = spaces
                    pnt.rI++
                  }
                }
                // Update fwd and continue matching.
                fwd = lex.src.substring(pnt.sI)
                continue yamlMatchLoop
              }

              // YAML directive lines (%YAML, %TAG, %FOO): skip everything
              // up to the next --- or ... document marker.
              if (fwd[0] === '%') {
                let pos = 0
                while (pos < fwd.length) {
                  // Check if current line starts with --- or ...
                  if ((fwd[pos] === '-' && fwd[pos+1] === '-' && fwd[pos+2] === '-' &&
                       (fwd[pos+3] === '\n' || fwd[pos+3] === '\r' || fwd[pos+3] === ' ' || fwd[pos+3] === '\t' || fwd[pos+3] === undefined)) ||
                      (fwd[pos] === '.' && fwd[pos+1] === '.' && fwd[pos+2] === '.' &&
                       (fwd[pos+3] === '\n' || fwd[pos+3] === '\r' || fwd[pos+3] === ' ' || fwd[pos+3] === '\t' || fwd[pos+3] === undefined))) {
                    break
                  }
                  // Skip this line.
                  while (pos < fwd.length && fwd[pos] !== '\n' && fwd[pos] !== '\r') pos++
                  if (fwd[pos] === '\r') pos++
                  if (fwd[pos] === '\n') pos++
                  pnt.rI++
                }
                pnt.sI += pos
                pnt.cI = 0
                fwd = lex.src.substring(pnt.sI)
                // Fall through — next thing should be --- or content.
              }

              // YAML non-specific tag (! value) or local tag (!name value):
              // skip the tag and let the value be parsed normally.
              if (fwd[0] === '!' && fwd[1] !== '!' && fwd[1] !== undefined) {
                if (fwd[1] === ' ') {
                  // Non-specific tag: ! value → treat value as string.
                  let valStart = 2
                  let valEnd = valStart
                  while (valEnd < fwd.length && fwd[valEnd] !== '\n' && fwd[valEnd] !== '\r') valEnd++
                  let rawVal = fwd.substring(valStart, valEnd).replace(/\s+$/, '')
                  let src = fwd.substring(0, valEnd)
                  let tkn = lex.token('#TX', rawVal, src, lex.pnt)
                  pnt.sI += valEnd
                  pnt.cI += valEnd
                  return tkn
                }
                // Local tag: !name value → skip the tag, continue with value.
                let tagEnd = 1
                while (tagEnd < fwd.length && fwd[tagEnd] !== ' ' && fwd[tagEnd] !== '\n' &&
                       fwd[tagEnd] !== '\r') tagEnd++
                if (fwd[tagEnd] === ' ') tagEnd++ // skip space after tag
                pnt.sI += tagEnd
                pnt.cI += tagEnd
                // If tag is standalone (followed by newline), consume the
                // newline and leading spaces so no extra #IN is emitted.
                if (pnt.sI < lex.src.length &&
                    (lex.src[pnt.sI] === '\n' || lex.src[pnt.sI] === '\r')) {
                  // Check if tag is standalone on its line.
                  let tagStandalone = true
                  let tagLineIndent = 0
                  let bi = pnt.sI - tagEnd - 1
                  while (bi >= 0 && lex.src[bi] !== '\n' && lex.src[bi] !== '\r') {
                    if (lex.src[bi] !== ' ' && lex.src[bi] !== '\t') {
                      tagStandalone = false
                      break
                    }
                    tagLineIndent++
                    bi--
                  }
                  if (tagStandalone) {
                    let nl = pnt.sI
                    if (lex.src[nl] === '\r') nl++
                    if (lex.src[nl] === '\n') nl++
                    let spaces = 0
                    while (nl + spaces < lex.src.length && lex.src[nl + spaces] === ' ') spaces++
                    pnt.sI = nl + spaces
                    pnt.cI = spaces
                    pnt.rI++
                  }
                }
                fwd = lex.src.substring(pnt.sI)
                // Restart matching to parse the value.
                continue yamlMatchLoop
              }

              // Skip !!seq, !!map, !!omap, !!set, !!binary, etc. tags — just
              // consume and return undefined so the next lex cycle handles the
              // actual structure/value.
              if (fwd[0] === '!' && fwd[1] === '!' &&
                  /^!!(seq|map|omap|set|pairs|binary|ordered|python\/[^\s]*)\b/.test(fwd)) {
                let skip = 2
                while (skip < fwd.length && fwd[skip] !== ' ' && fwd[skip] !== '\n') skip++
                while (skip < fwd.length && fwd[skip] === ' ') skip++
                // Check if tag is standalone on its own line.
                let tagIndent = 0
                {
                  let bi = pnt.sI - 1
                  let standalone = true
                  while (bi >= 0 && lex.src[bi] !== '\n' && lex.src[bi] !== '\r') {
                    if (lex.src[bi] !== ' ' && lex.src[bi] !== '\t') {
                      standalone = false
                      break
                    }
                    tagIndent++
                    bi--
                  }
                  // If standalone and next line is at the same indent, consume
                  // the newline so no extra IN token is emitted.
                  if (standalone && skip < fwd.length &&
                      (fwd[skip] === '\n' || fwd[skip] === '\r')) {
                    let nl = skip
                    if (fwd[nl] === '\r') nl++
                    if (fwd[nl] === '\n') nl++
                    let spaces = 0
                    while (nl + spaces < fwd.length && fwd[nl + spaces] === ' ') spaces++
                    if (spaces >= tagIndent) {
                      skip = nl + spaces
                      pnt.sI += skip
                      pnt.cI = spaces
                      pnt.rI++
                      fwd = lex.src.substring(pnt.sI)
                      continue yamlMatchLoop
                    }
                  }
                }
                pnt.sI += skip
                pnt.cI += skip
                // Don't return a token — let the next lex cycle see the actual value.
                fwd = lex.src.substring(pnt.sI)
                continue yamlMatchLoop
              }

              // Handle other !!type tags (!!str, !!int, !!float, !!bool, !!null).
              // These apply a type to the following value. For !!str, the value
              // is always a string. For others, convert accordingly.
              if (fwd[0] === '!' && fwd[1] === '!') {
                let tagEnd = 2
                while (tagEnd < fwd.length && fwd[tagEnd] !== ' ' && fwd[tagEnd] !== '\n' &&
                       fwd[tagEnd] !== '\r' && fwd[tagEnd] !== ',' &&
                       fwd[tagEnd] !== '}' && fwd[tagEnd] !== ']' &&
                       fwd[tagEnd] !== ':') tagEnd++
                let tag = fwd.substring(2, tagEnd)
                let valStart = tagEnd
                if (fwd[valStart] === ' ') valStart++
                let valEnd = valStart
                // Skip and record anchor (&name) if present before value.
                let tagAnchorName = ''
                if (fwd[valStart] === '&') {
                  let anchorEnd = valStart + 1
                  while (anchorEnd < fwd.length && fwd[anchorEnd] !== ' ' &&
                         fwd[anchorEnd] !== '\n' && fwd[anchorEnd] !== '\r') anchorEnd++
                  tagAnchorName = fwd.substring(valStart + 1, anchorEnd)
                  pendingAnchors.push({ name: tagAnchorName, inline: true })
                  if (fwd[anchorEnd] === ' ') anchorEnd++
                  valStart = anchorEnd
                  valEnd = valStart
                }
                // Check for quoted value.
                if (fwd[valStart] === '"' || fwd[valStart] === "'") {
                  let q = fwd[valStart]
                  valEnd = valStart + 1
                  while (valEnd < fwd.length && fwd[valEnd] !== q) {
                    if (fwd[valEnd] === '\\' && q === '"') valEnd++
                    valEnd++
                  }
                  if (fwd[valEnd] === q) valEnd++
                  let rawVal = fwd.substring(valStart + 1, valEnd - 1)
                  let result: any = rawVal
                  if (!tagHandles['!!']) {
                    if (tag === 'int') result = parseInt(rawVal, 10)
                    else if (tag === 'float') result = parseFloat(rawVal)
                    else if (tag === 'bool') result = rawVal === 'true' || rawVal === 'True' || rawVal === 'TRUE'
                    else if (tag === 'null') result = null
                  }
                  if (tagAnchorName) anchors[tagAnchorName] = result
                  let tknTin = typeof result === 'string' ? '#TX' :
                               typeof result === 'number' ? '#NR' : '#VL'
                  let tkn = lex.token(tknTin, result, fwd.substring(0, valEnd), lex.pnt)
                  pnt.sI += valEnd
                  pnt.cI += valEnd
                  return tkn
                }
                // If value is on next line (tag followed by newline with
                // indented content), skip the tag and let the next lex cycle
                // handle the value. If end-of-source or next line is not
                // indented content, fall through to produce default value.
                if ((fwd[valStart] === '\n' || fwd[valStart] === '\r') &&
                    valStart < fwd.length - 1) {
                  // Tag followed by newline — skip the tag and let the
                  // next lex cycle handle the value on the following line.
                  let nl = valStart
                  if (fwd[nl] === '\r') nl++
                  if (fwd[nl] === '\n') nl++
                  pnt.sI += nl
                  pnt.cI = 0
                  pnt.rI++
                  fwd = lex.src.substring(pnt.sI)
                  continue yamlMatchLoop
                }
                // Unquoted: stop at `: `, ` #`, newline, flow indicators.
                while (valEnd < fwd.length && fwd[valEnd] !== '\n' && fwd[valEnd] !== '\r' &&
                       fwd[valEnd] !== ',' && fwd[valEnd] !== '}' && fwd[valEnd] !== ']') {
                  if (fwd[valEnd] === ':' && (fwd[valEnd+1] === ' ' || fwd[valEnd+1] === '\n' ||
                      fwd[valEnd+1] === '\r' || fwd[valEnd+1] === undefined)) break
                  if (fwd[valEnd] === ' ' && fwd[valEnd+1] === '#') break
                  valEnd++
                }
                let rawVal = fwd.substring(valStart, valEnd).replace(/\s+$/, '')
                let result: any = rawVal
                // Only apply built-in type conversion when !! has not been
                // redefined by a %TAG directive. Custom tag handles mean
                // !!type is a user-defined tag, not a YAML core type.
                if (!tagHandles['!!']) {
                  if (tag === 'str') result = String(rawVal)
                  else if (tag === 'int') result = parseInt(rawVal, 10)
                  else if (tag === 'float') result = parseFloat(rawVal)
                  else if (tag === 'bool') result = rawVal === 'true' || rawVal === 'True' || rawVal === 'TRUE'
                  else if (tag === 'null') result = null
                }
                if (tagAnchorName) anchors[tagAnchorName] = result
                // Use #ST for empty strings (jsonic handles #ST better than
                // empty #TX in flow context), #NR for numbers, #VL for null.
                let tknTin = (typeof result === 'string' && result === '') ? '#ST' :
                             typeof result === 'string' ? '#TX' :
                             typeof result === 'number' ? '#NR' : '#VL'
                let tkn = lex.token(tknTin, result, fwd.substring(0, valEnd), lex.pnt)
                pnt.sI += valEnd
                pnt.cI += valEnd
                return tkn
              }

              // YAML explicit key indicator: ? key\n: value
              // Handles: ? key (with null value if no : follows)
              //          ? key\n: value
              //          ? key\n# comment\n: value
              //          ? key1\n? key2 (consecutive explicit keys with null values)
              if (fwd[0] === '?' && (fwd[1] === ' ' || fwd[1] === '\t' ||
                  fwd[1] === '\n' || fwd[1] === '\r' || fwd[1] === undefined)) {
                let start = (fwd[1] === ' ' || fwd[1] === '\t') ? 2 : 1
                // Collect key text (may be multiline via continuation).
                let keyEnd = start
                let key = ''
                // First line of key.
                while (keyEnd < fwd.length && fwd[keyEnd] !== '\n' && fwd[keyEnd] !== '\r') {
                  if (fwd[keyEnd] === ' ' && fwd[keyEnd+1] === '#') break  // comment
                  keyEnd++
                }
                key = fwd.substring(start, keyEnd).replace(/\s+$/, '')
                // Strip !!type tags from explicit keys and apply conversion.
                let explicitKeyTag = ''
                let tagMatch = key.match(/^!!(\w+)\s+(.*)$/)
                if (tagMatch) {
                  explicitKeyTag = tagMatch[1]
                  key = tagMatch[2]
                }
                let consumed = keyEnd
                // Track position before consuming newline (for !hasValue case).
                let beforeNewline = consumed
                // Skip comment at end of key line.
                while (consumed < fwd.length && fwd[consumed] !== '\n' && fwd[consumed] !== '\r') consumed++
                beforeNewline = consumed
                // Consume newline after key line.
                if (consumed < fwd.length && fwd[consumed] === '\r') consumed++
                if (consumed < fwd.length && fwd[consumed] === '\n') consumed++
                // Check for multiline key (continuation lines indented more than ?).
                let qIndent = 0
                {
                  let li = pnt.sI
                  while (li > 0 && lex.src[li-1] !== '\n' && lex.src[li-1] !== '\r') li--
                  while (li < pnt.sI && lex.src[li] === ' ') { qIndent++; li++ }
                }
                // Count extra rows consumed (for multiline keys).
                let extraRows = 0

                // Handle block scalar keys (| or >).
                let blockScalarMatch = key.match(/^([|>])([+-]?)([0-9]?)$/)
                if (blockScalarMatch) {
                  let isFolded = blockScalarMatch[1] === '>'
                  let chomp = blockScalarMatch[2] || ''
                  let explicitIndent = blockScalarMatch[3] ? parseInt(blockScalarMatch[3]) : 0
                  // Collect block scalar content lines.
                  let blockLines: string[] = []
                  let contentIndent = 0
                  while (consumed < fwd.length) {
                    let lineIndent = 0
                    while (consumed + lineIndent < fwd.length && fwd[consumed + lineIndent] === ' ') lineIndent++
                    let afterSpaces = consumed + lineIndent
                    // Empty line or line with only spaces.
                    if (afterSpaces >= fwd.length || fwd[afterSpaces] === '\n' || fwd[afterSpaces] === '\r') {
                      blockLines.push('')
                      consumed = afterSpaces
                      if (consumed < fwd.length && fwd[consumed] === '\r') consumed++
                      if (consumed < fwd.length && fwd[consumed] === '\n') consumed++
                      extraRows++
                      continue
                    }
                    // Determine content indent from first non-empty line.
                    if (contentIndent === 0) {
                      contentIndent = explicitIndent > 0 ? qIndent + explicitIndent : lineIndent
                    }
                    // Line must be indented more than ? to be content.
                    if (lineIndent < contentIndent) break
                    // Collect line content.
                    let lineEnd = afterSpaces
                    while (lineEnd < fwd.length && fwd[lineEnd] !== '\n' && fwd[lineEnd] !== '\r') lineEnd++
                    blockLines.push(fwd.substring(consumed + contentIndent, lineEnd))
                    consumed = lineEnd
                    if (consumed < fwd.length && fwd[consumed] === '\r') consumed++
                    if (consumed < fwd.length && fwd[consumed] === '\n') consumed++
                    extraRows++
                  }
                  // Apply chomping.
                  // Remove trailing empty lines for non-keep.
                  if (chomp !== '+') {
                    while (blockLines.length > 0 && blockLines[blockLines.length - 1] === '') blockLines.pop()
                  }
                  if (isFolded) {
                    key = blockLines.join(' ') + '\n'
                  } else {
                    key = blockLines.join('\n') + '\n'
                  }
                  if (chomp === '-') {
                    key = key.replace(/\n$/, '')
                  }
                } else {
                // Scan continuation lines for key (plain scalar multiline).
                while (consumed < fwd.length) {
                  // Skip comment lines.
                  let lineIndent = 0
                  while (consumed + lineIndent < fwd.length && fwd[consumed + lineIndent] === ' ') lineIndent++
                  let afterSpaces = consumed + lineIndent
                  if (afterSpaces < fwd.length && fwd[afterSpaces] === '#') {
                    // Comment line — skip it.
                    while (afterSpaces < fwd.length && fwd[afterSpaces] !== '\n' && fwd[afterSpaces] !== '\r') afterSpaces++
                    beforeNewline = afterSpaces
                    if (afterSpaces < fwd.length && fwd[afterSpaces] === '\r') afterSpaces++
                    if (afterSpaces < fwd.length && fwd[afterSpaces] === '\n') afterSpaces++
                    extraRows++
                    consumed = afterSpaces
                    continue
                  }
                  // Check if this is a continuation of the key (indented more than ?).
                  if (lineIndent > qIndent && fwd[afterSpaces] !== ':' &&
                      fwd[afterSpaces] !== '?' && fwd[afterSpaces] !== '-') {
                    // Continuation line for multiline key.
                    let contEnd = afterSpaces
                    while (contEnd < fwd.length && fwd[contEnd] !== '\n' && fwd[contEnd] !== '\r') {
                      if (fwd[contEnd] === ' ' && fwd[contEnd+1] === '#') break
                      contEnd++
                    }
                    let contText = fwd.substring(afterSpaces, contEnd).replace(/\s+$/, '')
                    if (contText.length > 0) {
                      key += ' ' + contText
                    }
                    consumed = contEnd
                    beforeNewline = consumed
                    if (consumed < fwd.length && fwd[consumed] === '\r') consumed++
                    if (consumed < fwd.length && fwd[consumed] === '\n') consumed++
                    extraRows++
                    continue
                  }
                  break
                }
                }
                // Now check if the next non-comment line starts with `:`.
                let hasValue = false
                let valConsumed = consumed
                {
                  let ci = consumed
                  // Skip leading spaces on the next line.
                  while (ci < fwd.length && fwd[ci] === ' ') ci++
                  if (ci < fwd.length && fwd[ci] === ':' &&
                      (fwd[ci+1] === ' ' || fwd[ci+1] === '\t' || fwd[ci+1] === '\n' ||
                       fwd[ci+1] === '\r' || fwd[ci+1] === undefined)) {
                    // Found `: ` — this key has a value.
                    hasValue = true
                    valConsumed = ci + 1
                    if (fwd[valConsumed] === ' ' || fwd[valConsumed] === '\t') valConsumed++
                  }
                }
                let src = fwd.substring(0, hasValue ? consumed : keyEnd)
                if (hasValue) {
                  pnt.sI += valConsumed
                  pnt.rI += 1 + extraRows
                  // Set column to actual position after `: ` on the value line (1-indexed).
                  pnt.cI = valConsumed - consumed + 1
                  // Has `: value` — emit KEY now, CL on next call.
                  pendingExplicitCL = true
                } else {
                  // No `:` follows — don't consume past newline so the
                  // normal newline→#IN handler can emit indent for map continuation.
                  pnt.sI += beforeNewline
                  pnt.cI += beforeNewline
                  // Emit KEY, CL, null as queued tokens.
                  let clTkn = lex.token('#CL', 1, ': ', lex.pnt)
                  let vlTkn = lex.token('#VL', null, '', lex.pnt)
                  pendingTokens.push(clTkn, vlTkn)
                }
                let tkn = lex.token('#TX', key, src, lex.pnt)
                return tkn
              }

              // YAML document markers: --- and ...
              // --- starts a document (skip it), ... ends the document.
              if ((fwd[0] === '-' && fwd[1] === '-' && fwd[2] === '-' &&
                   (fwd[3] === '\n' || fwd[3] === '\r' || fwd[3] === ' ' || fwd[3] === '\t' || fwd[3] === undefined)) ||
                  (fwd[0] === '.' && fwd[1] === '.' && fwd[2] === '.' &&
                   (fwd[3] === '\n' || fwd[3] === '\r' || fwd[3] === ' ' || fwd[3] === '\t' || fwd[3] === undefined))) {
                // Consume the marker and rest of line.
                let pos = 3
                while (pos < fwd.length && fwd[pos] !== '\n' && fwd[pos] !== '\r') pos++
                if (fwd[0] === '.') {
                  // ... terminates: consume and signal end.
                  pnt.sI += pos
                  pnt.cI += pos
                  // Also consume any trailing newlines.
                  while (pnt.sI < lex.src.length &&
                    (lex.src[pnt.sI] === '\n' || lex.src[pnt.sI] === '\r')) {
                    if (lex.src[pnt.sI] === '\r') pnt.sI++
                    if (lex.src[pnt.sI] === '\n') pnt.sI++
                    pnt.rI++
                  }
                  let tkn = lex.token('#ZZ', undefined, '', lex.pnt)
                  pnt.end = tkn
                  return tkn
                } else {
                  // --- handler: check if there's content on the same line.
                  let afterDash = 3
                  while (afterDash < fwd.length && fwd[afterDash] === ' ') afterDash++
                  let restOfLine = fwd.substring(afterDash).split(/[\r\n]/)[0].trim()

                  // Check if there's inline content after ---.
                  // Anchors (&), tags (!), and empty/comment lines go through
                  // the normal --- handler. Everything else is inline content.
                  let dashNextCh = afterDash < fwd.length ? fwd[afterDash] : ''
                  let hasInlineValue = (
                    dashNextCh !== '' && dashNextCh !== '\n' && dashNextCh !== '\r' &&
                    dashNextCh !== '&' && dashNextCh !== '!' && dashNextCh !== '#'
                  )
                  if (hasInlineValue) {
                    // Content after --- (e.g. --- |, --- "foo", --- text)
                    pnt.sI += afterDash
                    pnt.cI = afterDash
                    fwd = lex.src.substring(pnt.sI)
                    // Fall through to continue matching.
                  } else {
                    // Plain --- with nothing (or just a comment) after it.
                    pnt.sI += pos
                    pnt.rI++
                    // Consume newline after ---.
                    if (pnt.sI < lex.src.length && lex.src[pnt.sI] === '\r') pnt.sI++
                    if (pnt.sI < lex.src.length && lex.src[pnt.sI] === '\n') pnt.sI++
                    // Count spaces.
                    let spaces = 0
                    while (pnt.sI + spaces < lex.src.length && lex.src[pnt.sI + spaces] === ' ') spaces++
                    pnt.sI += spaces
                    pnt.cI = spaces
                    // If nothing left after ---, emit #ZZ.
                    if (pnt.sI >= lex.src.length) {
                      let tkn = lex.token('#ZZ', undefined, '', lex.pnt)
                      pnt.end = tkn
                      return tkn
                    }
                    // For flow/scalar indicators, don't emit #IN.
                    let nextCh = lex.src[pnt.sI]
                    if (nextCh === '{' || nextCh === '[' ||
                        nextCh === '"' || nextCh === "'") {
                      fwd = lex.src.substring(pnt.sI)
                      // Fall through to continue matching.
                    } else if (spaces === 0 && nextCh !== '-' && nextCh !== '.' &&
                               nextCh !== '?' && nextCh !== '\n' && nextCh !== '\r') {
                      // For indent 0 with simple content (not list/map),
                      // skip #IN and fall through directly to content.
                      fwd = lex.src.substring(pnt.sI)
                      // Fall through to continue matching.
                    } else {
                      // Emit #IN with the indent level after ---.
                      let src = fwd.substring(0, pos + 1 + spaces)
                      let tkn = lex.token('#IN', spaces, src, lex.pnt)
                      return tkn
                    }
                  }
                }
              }

              // Re-check for patterns that may appear after --- fall-through.
              // Directive lines: skip everything up to --- or content.
              if (fwd[0] === '%') {
                let pos = 0
                while (pos < fwd.length) {
                  if ((fwd[pos] === '-' && fwd[pos+1] === '-' && fwd[pos+2] === '-' &&
                       (fwd[pos+3] === '\n' || fwd[pos+3] === '\r' || fwd[pos+3] === ' ' || fwd[pos+3] === '\t' || fwd[pos+3] === undefined)) ||
                      (fwd[pos] === '.' && fwd[pos+1] === '.' && fwd[pos+2] === '.' &&
                       (fwd[pos+3] === '\n' || fwd[pos+3] === '\r' || fwd[pos+3] === ' ' || fwd[pos+3] === '\t' || fwd[pos+3] === undefined))) {
                    break
                  }
                  while (pos < fwd.length && fwd[pos] !== '\n' && fwd[pos] !== '\r') pos++
                  if (fwd[pos] === '\r') pos++
                  if (fwd[pos] === '\n') pos++
                  pnt.rI++
                }
                pnt.sI += pos
                pnt.cI = 0
                fwd = lex.src.substring(pnt.sI)
              }
              // Non-specific tag.
              if (fwd[0] === '!' && fwd[1] === ' ') {
                let valStart = 2
                let valEnd = valStart
                while (valEnd < fwd.length && fwd[valEnd] !== '\n' && fwd[valEnd] !== '\r') valEnd++
                let rawVal = fwd.substring(valStart, valEnd).replace(/\s+$/, '')
                let src = fwd.substring(0, valEnd)
                let tkn = lex.token('#TX', rawVal, src, lex.pnt)
                pnt.sI += valEnd
                pnt.cI += valEnd
                return tkn
              }
              // Anchor after ---.
              if (fwd[0] === '&') {
                let nameEnd = 1
                while (nameEnd < fwd.length && fwd[nameEnd] !== ' ' && fwd[nameEnd] !== '\t' &&
                       fwd[nameEnd] !== '\n' && fwd[nameEnd] !== '\r' && fwd[nameEnd] !== ',' &&
                       fwd[nameEnd] !== '{' && fwd[nameEnd] !== '}' && fwd[nameEnd] !== '[' &&
                       fwd[nameEnd] !== ']') nameEnd++
                let anchorName = fwd.substring(1, nameEnd)
                let skip = nameEnd
                if (fwd[skip] === ' ') skip++
                pnt.sI += skip
                pnt.cI += skip
                pendingAnchors.push({ name: anchorName, inline: true })
                fwd = lex.src.substring(pnt.sI)
              }

              // YAML double-quoted string: backslash escapes + multiline folding.
              if (fwd[0] === '"') {
                let i = 1
                let val = ''
                let escapedUpTo = 0 // val chars up to this index are from escapes (non-trimmable)
                while (i < fwd.length && fwd[i] !== '"') {
                  if (fwd[i] === '\\') {
                    i++
                    let esc = fwd[i]
                    if (esc === 'n') { val += '\n'; i++; escapedUpTo = val.length }
                    else if (esc === 't') { val += '\t'; i++; escapedUpTo = val.length }
                    else if (esc === 'r') { val += '\r'; i++; escapedUpTo = val.length }
                    else if (esc === '"') { val += '"'; i++; escapedUpTo = val.length }
                    else if (esc === '\\') { val += '\\'; i++; escapedUpTo = val.length }
                    else if (esc === '/') { val += '/'; i++; escapedUpTo = val.length }
                    else if (esc === 'b') { val += '\b'; i++; escapedUpTo = val.length }
                    else if (esc === 'f') { val += '\f'; i++; escapedUpTo = val.length }
                    else if (esc === 'a') { val += '\x07'; i++; escapedUpTo = val.length }
                    else if (esc === 'e') { val += '\x1b'; i++; escapedUpTo = val.length }
                    else if (esc === 'v') { val += '\v'; i++; escapedUpTo = val.length }
                    else if (esc === '0') { val += '\0'; i++; escapedUpTo = val.length }
                    else if (esc === '\t') { val += '\t'; i++; escapedUpTo = val.length }
                    else if (esc === ' ') { val += ' '; i++; escapedUpTo = val.length }
                    else if (esc === '_') { val += '\u00a0'; i++; escapedUpTo = val.length }
                    else if (esc === 'N') { val += '\u0085'; i++; escapedUpTo = val.length }
                    else if (esc === 'L') { val += '\u2028'; i++; escapedUpTo = val.length }
                    else if (esc === 'P') { val += '\u2029'; i++; escapedUpTo = val.length }
                    else if (esc === 'x') {
                      val += String.fromCharCode(parseInt(fwd.substring(i+1, i+3), 16))
                      i += 3; escapedUpTo = val.length
                    }
                    else if (esc === 'u') {
                      val += String.fromCharCode(parseInt(fwd.substring(i+1, i+5), 16))
                      i += 5; escapedUpTo = val.length
                    }
                    else if (esc === 'U') {
                      val += String.fromCodePoint(parseInt(fwd.substring(i+1, i+9), 16))
                      i += 9; escapedUpTo = val.length
                    }
                    else if (esc === '\n' || esc === '\r') {
                      // Escaped newline: line continuation (join directly).
                      if (esc === '\r' && fwd[i+1] === '\n') i++
                      i++
                      // Skip leading whitespace on next line.
                      while (i < fwd.length && (fwd[i] === ' ' || fwd[i] === '\t')) i++
                    }
                    else { val += esc; i++ }
                  } else if (fwd[i] === '\n' || fwd[i] === '\r') {
                    // Flow scalar line folding for double-quoted strings.
                    // Only trim trailing whitespace that was NOT from escape sequences.
                    let trimTo = val.length
                    while (trimTo > escapedUpTo && (val[trimTo - 1] === ' ' || val[trimTo - 1] === '\t')) trimTo--
                    val = val.substring(0, trimTo)
                    let emptyLines = 0
                    while (i < fwd.length && (fwd[i] === '\n' || fwd[i] === '\r')) {
                      if (fwd[i] === '\r') i++
                      if (fwd[i] === '\n') i++
                      emptyLines++
                      while (i < fwd.length && (fwd[i] === ' ' || fwd[i] === '\t')) i++
                    }
                    if (emptyLines > 1) {
                      for (let e = 1; e < emptyLines; e++) val += '\n'
                    } else {
                      val += ' '
                    }
                  } else {
                    val += fwd[i]
                    i++
                  }
                }
                if (fwd[i] === '"') i++
                let src = fwd.substring(0, i)
                let tkn = lex.token('#ST', val, src, lex.pnt)
                pnt.sI += i
                pnt.cI += i
                return tkn
              }

              // YAML single-quoted string: no backslash escape processing.
              // Only escape is '' (two single quotes) → literal single quote.
              // Newlines are folded: single newline → space, empty lines → \n.
              if (fwd[0] === "'") {
                let i = 1
                let val = ''
                while (i < fwd.length) {
                  if (fwd[i] === "'") {
                    if (fwd[i + 1] === "'") {
                      // Escaped single quote.
                      val += "'"
                      i += 2
                    } else {
                      // End of string.
                      i++
                      break
                    }
                  } else if (fwd[i] === '\n' || fwd[i] === '\r') {
                    // Flow scalar line folding.
                    // Trim trailing whitespace from current content.
                    val = val.replace(/[ \t]+$/, '')
                    // Count empty lines (newlines with only whitespace).
                    let emptyLines = 0
                    while (i < fwd.length && (fwd[i] === '\n' || fwd[i] === '\r')) {
                      if (fwd[i] === '\r') i++
                      if (fwd[i] === '\n') i++
                      emptyLines++
                      // Skip leading whitespace on next line.
                      while (i < fwd.length && (fwd[i] === ' ' || fwd[i] === '\t')) i++
                    }
                    if (emptyLines > 1) {
                      // Each extra empty line becomes a \n.
                      for (let e = 1; e < emptyLines; e++) val += '\n'
                    } else {
                      // Single newline → space (folding).
                      val += ' '
                    }
                  } else {
                    val += fwd[i]
                    i++
                  }
                }
                let src = fwd.substring(0, i)
                let tkn = lex.token('#ST', val, src, lex.pnt)
                pnt.sI += i
                pnt.cI += i
                return tkn
              }

              // Plain scalars starting with digits but containing colons (e.g. 20:03:20)
              // or non-numeric text after a space (e.g. "64 characters, hexadecimal.")
              // must be captured before jsonic's number matcher grabs just the digits.
              if (fwd[0] >= '0' && fwd[0] <= '9') {
                let hasEmbeddedColon = false
                let hasTrailingText = false
                let pi = 1
                while (pi < fwd.length && fwd[pi] !== '\n' && fwd[pi] !== '\r') {
                  if (fwd[pi] === ':' && fwd[pi + 1] !== ' ' && fwd[pi + 1] !== '\t' &&
                      fwd[pi + 1] !== '\n' && fwd[pi + 1] !== '\r' && fwd[pi + 1] !== undefined) {
                    hasEmbeddedColon = true
                    break
                  }
                  if (fwd[pi] === ' ' || fwd[pi] === '\t') {
                    // Check if after the space there are non-separator characters,
                    // meaning this is a plain scalar like "64 characters, hexadecimal."
                    // not a standalone number.
                    let si = pi
                    while (si < fwd.length && (fwd[si] === ' ' || fwd[si] === '\t')) si++
                    if (si < fwd.length && fwd[si] !== '\n' && fwd[si] !== '\r' &&
                        fwd[si] !== '#' && fwd[si] !== ':' && fwd[si] !== undefined) {
                      // Check it's not ": " (key-value separator).
                      if (!(fwd[si] === ':' && (fwd[si + 1] === ' ' || fwd[si + 1] === '\t' ||
                            fwd[si + 1] === '\n' || fwd[si + 1] === '\r' || fwd[si + 1] === undefined))) {
                        hasTrailingText = true
                      }
                    }
                    break
                  }
                  pi++
                }
                if (hasEmbeddedColon) {
                  // Scan to end of plain scalar token (space, tab, newline, eof).
                  let end = 0
                  while (end < fwd.length && fwd[end] !== ' ' && fwd[end] !== '\t' &&
                         fwd[end] !== '\n' && fwd[end] !== '\r') end++
                  let text = fwd.substring(0, end)
                  let tkn = lex.token('#TX', text, text, lex.pnt)
                  pnt.sI += end
                  pnt.cI += end
                  return tkn
                }
                if (hasTrailingText) {
                  // Flag that the number matcher should skip this value,
                  // so the text.check handler can process it as a plain
                  // scalar (including multiline continuation support).
                  skipNumberMatch = true
                  return null
                }
              }

              // YAML element marker: "- " or "-\t" or "-\n" or "-" at end.
              if (fwd[0] === '-' && (fwd[1] === ' ' || fwd[1] === '\t' || fwd[1] === '\n' ||
                  fwd[1] === '\r' || fwd[1] === undefined)) {
                let tkn = lex.token('#EL', undefined, '- ', lex.pnt)
                pnt.sI += 1
                pnt.cI += 1
                // Consume the space/tab after dash if present.
                if (fwd[1] === ' ' || fwd[1] === '\t') {
                  pnt.sI += 1
                  pnt.cI += 1
                }
                return tkn
              }

              // Yaml colons are ': ', ':\t', ':<newline>', ':' at end of input,
              // or ':' in flow context (JSON-compatible, e.g. {"key":value}).
              // In flow context, detect by checking if the previous non-whitespace
              // token was a quoted string followed immediately by ':'.
              let isFlowColon = false
              if (fwd[0] === ':' && fwd[1] !== ' ' && fwd[1] !== '\t' &&
                  fwd[1] !== '\n' && fwd[1] !== '\r' && fwd[1] !== undefined) {
                // JSON-compatible flow colon: only when preceded by a quoted string.
                // e.g. {"key":value} — the char before ':' must be '"' or "'".
                // Also skip whitespace/newlines (flow context allows multiline).
                let prevI = pnt.sI - 1
                while (prevI >= 0 && (lex.src[prevI] === ' ' || lex.src[prevI] === '\t' ||
                       lex.src[prevI] === '\n' || lex.src[prevI] === '\r')) prevI--
                if (prevI >= 0 && (lex.src[prevI] === '"' || lex.src[prevI] === "'")) {
                  isFlowColon = true
                }
              }
              if (fwd[0] === ':' && (fwd[1] === ' ' || fwd[1] === '\t' || fwd[1] === '\n' ||
                  fwd[1] === '\r' || fwd[1] === undefined || isFlowColon)) {
                let tkn = lex.token('#CL', 1, ': ', lex.pnt)
                pnt.sI += 1
                if (fwd[1] === ' ' || fwd[1] === '\t') {
                  pnt.cI += 2
                } else if (fwd[1] === '\n' || fwd[1] === '\r') {
                  // Don't consume newline — leave for #IN.
                } else {
                  // End of input after colon.
                  pnt.cI += 1
                }
                return tkn
              }

              // Match any newline — YAML indentation is significant.
              // In flow context, newlines are just whitespace — don't emit #IN.
              // Detect flow context by counting unmatched brackets before current position.
              if (fwd[0] === '\n' || fwd[0] === '\r') {
                let inFlow = 0
                for (let fi = 0; fi < pnt.sI; fi++) {
                  let fc = lex.src[fi]
                  if (fc === '{' || fc === '[') inFlow++
                  else if (fc === '}' || fc === ']') { if (inFlow > 0) inFlow-- }
                  else if (fc === '"') {
                    fi++
                    while (fi < pnt.sI && lex.src[fi] !== '"') {
                      if (lex.src[fi] === '\\') fi++
                      fi++
                    }
                  }
                  else if (fc === "'") {
                    fi++
                    while (fi < pnt.sI && lex.src[fi] !== "'") {
                      if (lex.src[fi] === "'" && lex.src[fi + 1] === "'") fi++
                      fi++
                    }
                  }
                }
                if (inFlow > 0) {
                  // Inside flow collection — consume whitespace, don't emit #IN.
                  let pos = 0
                  while (pos < fwd.length &&
                    (fwd[pos] === '\n' || fwd[pos] === '\r' || fwd[pos] === ' ' || fwd[pos] === '\t')) {
                    pos++
                  }
                  // Also skip comment lines inside flow collections.
                  if (pos < fwd.length && fwd[pos] === '#') {
                    while (pos < fwd.length && fwd[pos] !== '\n' && fwd[pos] !== '\r') pos++
                  }
                  pnt.sI += pos
                  pnt.cI = 0
                  // Re-run yamlMatcher from new position.
                  fwd = lex.src.substring(pnt.sI)
                  continue yamlMatchLoop
                }
              }
              // Must catch all newlines before the default line/space matchers.
              if (fwd[0] === '\n' || fwd[0] === '\r') {
                // Consume all blank lines and comment-only lines,
                // finding the last meaningful indent.
                let pos = 0
                let spaces = 0
                let rows = 0
                while (pos < fwd.length) {
                  // Match \r\n or \n
                  if (fwd[pos] === '\r' && fwd[pos + 1] === '\n') {
                    pos += 2
                    rows++
                  } else if (fwd[pos] === '\n') {
                    pos += 1
                    rows++
                  } else {
                    break
                  }
                  // Count spaces after this newline.
                  spaces = 0
                  while (pos < fwd.length && fwd[pos] === ' ') {
                    pos++
                    spaces++
                  }
                  // If the line is a comment-only line, consume it too.
                  if (fwd[pos] === '#') {
                    while (pos < fwd.length && fwd[pos] !== '\n' && fwd[pos] !== '\r') pos++
                    continue
                  }
                  // If the line is whitespace-only (tabs and/or spaces),
                  // treat it as a blank line and continue.
                  if (fwd[pos] === '\t') {
                    let tp = pos
                    while (tp < fwd.length && (fwd[tp] === ' ' || fwd[tp] === '\t')) tp++
                    if (tp >= fwd.length || fwd[tp] === '\n' || fwd[tp] === '\r') {
                      pos = tp
                      continue
                    }
                  }
                  // If the line is an anchor-only line (&name with nothing after),
                  // consume it (record the anchor) and continue to the next line
                  // so the indent is determined by actual content.
                  if (fwd[pos] === '&') {
                    let ae = pos + 1
                    while (ae < fwd.length && fwd[ae] !== ' ' && fwd[ae] !== '\t' &&
                           fwd[ae] !== '\n' && fwd[ae] !== '\r') ae++
                    let afterAnchor = ae
                    while (afterAnchor < fwd.length &&
                           (fwd[afterAnchor] === ' ' || fwd[afterAnchor] === '\t')) afterAnchor++
                    if (afterAnchor >= fwd.length || fwd[afterAnchor] === '\n' ||
                        fwd[afterAnchor] === '\r' || fwd[afterAnchor] === '#') {
                      pendingAnchors.push({ name: fwd.substring(pos + 1, ae), inline: false })
                      // Skip to end of line (including any comment).
                      while (afterAnchor < fwd.length &&
                             fwd[afterAnchor] !== '\n' && fwd[afterAnchor] !== '\r') afterAnchor++
                      pos = afterAnchor
                      continue
                    }
                  }
                }

                // If we consumed everything (trailing newlines), advance and emit #ZZ.
                if (pos >= fwd.length) {
                  pnt.sI += pos
                  pnt.rI += rows
                  pnt.cI = spaces + 1
                  let tkn = lex.token('#ZZ', undefined, '', lex.pnt)
                  pnt.end = tkn
                  return tkn
                }

                // Emit #IN with val = indent level of the last non-blank line.
                let src = fwd.substring(0, pos)
                let tkn = lex.token('#IN', spaces, src, lex.pnt)
                pnt.sI += pos
                pnt.rI += rows
                pnt.cI = spaces + 1
                return tkn
              }

              break // End of yamlMatchLoop
              } // end while(true) yamlMatchLoop
            }
          }
        }
      }
    }
  })


  // Extract a key value from a token, resolving aliases.
  function extractKey(rule: Rule): any {
    let o0 = rule.o0
    if (VL === o0.tin && o0.val && typeof o0.val === 'object' && o0.val.__yamlAlias) {
      // Alias used as key — resolve to anchor value.
      let name = o0.val.__yamlAlias
      return anchors[name] !== undefined ? anchors[name] : '*' + name
    }
    return ST === o0.tin || TX === o0.tin ? o0.val : o0.src
  }

  // Amend val rule to handle indents and element markers.
  jsonic.rule('val', (rulespec: RuleSpec) => {
    rulespec.open([
      {
        s: [IN],
        c: (rule: Rule, ctx: Context) => {
          // Only push indent if level is strictly greater than enclosing map.
          let parentIn = rule.k.yamlIn
          let listIn = rule.k.yamlListIn
          // Inside a list element, don't push indent at the list's level —
          // that means this value is empty and the next elem follows.
          if (listIn != null && ctx.t0.val <= listIn) return false
          return parentIn == null || ctx.t0.val > parentIn
        },
        p: 'indent',
        a: (rule: Rule) => rule.n.in = rule.o0.val
      },

      // Same indent followed by element marker: list value at map level.
      {
        s: [IN, EL],
        c: (rule: Rule, ctx: Context) => {
          let parentIn = rule.k.yamlIn
          return parentIn != null && ctx.t0.val === parentIn
        },
        p: 'yamlBlockList',
        a: (rule: Rule) => {
          rule.n.in = rule.o0.val
        }
      },

      // End of input means empty value — produce null.
      {
        s: [ZZ],
        b: 1,
        a: (rule: Rule) => { rule.node = null },
      },

      // Same or lesser indent after a colon means empty value — backtrack.
      {
        s: [IN],
        b: 1,
        u: { yamlEmpty: true },
      },


      // This value is a list.
      {
        s: [EL],
        p: 'yamlBlockList',
        a: (rule: Rule) => {
          // Set list indent from the element marker's column (1-based).
          rule.n.in = rule.o0.cI - 1
        }
      }
    ])

    // Claim pending anchors after first token is processed.
    rulespec.ao((rule: Rule) => {
      if (pendingAnchors.length > 0) {
        rule.u.yamlAnchors = [...pendingAnchors]
        rule.u.yamlAnchorOpenNode = rule.node
        // Note: rule.node is undefined at ao time, so we can't record
        // anchor values here. Recording happens in ac.
        pendingAnchors.length = 0
      }
    })

    rulespec.bc((rule: Rule) => {
      if (rule.u.yamlEmpty) {
        rule.node = undefined
      }
    })

    // Close val on indent tokens — prevents Jsonic's implicit list
    // from consuming YAML block continuation tokens.
    rulespec.close([
      { s: [IN], b: 1 },
    ])

    // Record anchors and resolve aliases after val is fully resolved.
    rulespec.ac((rule: Rule) => {
      // Resolve alias markers to actual values.
      if (rule.node && typeof rule.node === 'object' &&
          rule.node.__yamlAlias) {
        let name = rule.node.__yamlAlias
        let val = anchors[name]
        if (typeof val === 'object' && val !== null) {
          rule.node = JSON.parse(JSON.stringify(val))
        } else {
          rule.node = val
        }
      }

      // Record anchors only if this val claimed them.
      if (rule.u.yamlAnchors) {
        for (let anchor of rule.u.yamlAnchors) {
          // For inline anchors that were recorded at open time with a
          // scalar value, don't overwrite with the final compound value.
          if (anchor.inline &&
              rule.u.yamlAnchorOpenNode != null &&
              typeof rule.u.yamlAnchorOpenNode !== 'object' &&
              typeof rule.node === 'object' && rule.node !== null) {
            continue
          }
          let val = rule.node
          if (typeof val === 'object' && val !== null) {
            val = JSON.parse(JSON.stringify(val))
          }
          anchors[anchor.name] = val
        }
      }
    })
  })


  // Add indent rule to handle initial indent.
  jsonic.rule('indent', (rulespec: RuleSpec) => {
    rulespec
      .open([
        // Key pair, so this must be a map.
        {
          s: [KEY, CL],
          p: 'map',
          b: 2,
        },

        // Element, so this must be a list.
        {
          s: [EL],
          p: 'list',
        },

        // A plain value after indent (for nested scalars).
        {
          s: [KEY],
          a: (rule: Rule) => {
            rule.node = ST === rule.o0.tin || TX === rule.o0.tin
              ? rule.o0.val : rule.o0.src
          },
        }
      ])

      // Get the final value of the map or value.
      .bc((rule: Rule) => {
        if (undefined !== rule.child.node) {
          rule.node = rule.child.node
        }
      })
  })


  // YAML block list rule: handles "- " sequences without consuming "[".
  // Uses context key k.yamlBlockArr to share the array across rotations.
  jsonic.rule('yamlBlockList', (rulespec: RuleSpec) => {
    rulespec
      .bo((rule: Rule) => {
        rule.node = []
        rule.k.yamlBlockArr = rule.node
        rule.k.yamlListIn = rule.n.in
      })
      .open([
        // Element value is a key-value map: - key: val
        {
          s: [KEY, CL],
          p: 'yamlElemMap',
          b: 2,
          a: (rule: Rule) => {
            rule.k.yamlMapIn = rule.n.in + 2
          },
        },
        // Default: push to val for the element's value.
        { p: 'val' },
      ])
      .bc((rule: Rule) => {
        let val = rule.child.node !== undefined ? rule.child.node : null
        rule.k.yamlBlockArr.push(val)
      })
      .close([
        // Indent followed by element marker: next element at same level.
        {
          s: [IN, EL],
          c: (rule: Rule, ctx: Context) => {
            return ctx.t0.val === rule.n.in
          },
          r: 'yamlBlockElem',
        },
        // Same indent but no element marker: close list.
        {
          s: [IN],
          c: (rule: Rule, ctx: Context) => {
            return ctx.t0.val <= rule.n.in
          },
          b: 1,
        },
        // Element marker at top level (no preceding newline).
        {
          s: [EL],
          r: 'yamlBlockElem',
        },
        { s: [ZZ], b: 1 },
      ])
  })

  // Subsequent elements in a yamlBlockList (via rotation).
  jsonic.rule('yamlBlockElem', (rulespec: RuleSpec) => {
    rulespec
      .bo((rule: Rule) => {
        // Share the array from the original yamlBlockList via context.
        rule.node = rule.k.yamlBlockArr
      })
      .open([
        // Element value is a key-value map: - key: val
        {
          s: [KEY, CL],
          p: 'yamlElemMap',
          b: 2,
          a: (rule: Rule) => {
            rule.k.yamlMapIn = rule.n.in + 2
          },
        },
        // Default: push to val for the element's value.
        { p: 'val' },
      ])
      .bc((rule: Rule) => {
        let val = rule.child.node !== undefined ? rule.child.node : null
        rule.k.yamlBlockArr.push(val)
      })
      .close([
        // Indent followed by element marker: next element at same level.
        {
          s: [IN, EL],
          c: (rule: Rule, ctx: Context) => {
            return ctx.t0.val === rule.n.in
          },
          r: 'yamlBlockElem',
        },
        // Same or lesser indent: close.
        {
          s: [IN],
          c: (rule: Rule, ctx: Context) => {
            return ctx.t0.val <= rule.n.in
          },
          b: 1,
        },
        // Element marker at top level.
        {
          s: [EL],
          r: 'yamlBlockElem',
        },
        { s: [ZZ], b: 1 },
      ])
  })

  // Amend list rule: close on dedent or same-indent non-element.
  jsonic.rule('list', (rulespec: RuleSpec) => {
    rulespec.bo((rule: Rule) => {
      // Propagate list indent so val can check nesting depth.
      rule.k.yamlListIn = rule.n.in
    })

    rulespec.close([
      // Same or lesser indent: close this list.
      {
        s: [IN],
        c: (rule: Rule, ctx: Context) => {
          return ctx.t0.val <= rule.n.in
        },
        b: 1,
      },
    ])
  })


  // Amend map rule, treating IN like CA.
  jsonic.rule('map', (rulespec: RuleSpec) => {
    rulespec.bo((rule: Rule) => {
      // Set default indent level for top-level implicit maps.
      if (null == rule.n.in) {
        rule.n.in = 0
      }
      // Propagate map indent to children so val can check nesting depth.
      rule.k.yamlIn = rule.n.in
    })

    rulespec.open([
      // Indent at same level continues the map with another pair.
      {
        s: [IN],
        c: (rule: Rule) => rule.o0.val === rule.n.in,
        r: 'pair',
      },
    ])

    // Handle merge keys after all pairs are collected.
    rulespec.ac((rule: Rule) => {
      if (rule.node && typeof rule.node === 'object' && '<<' in rule.node) {
        let mergeVal = rule.node['<<']
        delete rule.node['<<']
        if (Array.isArray(mergeVal)) {
          for (let m of mergeVal) {
            if (typeof m === 'object' && m !== null && !Array.isArray(m)) {
              for (let k of Object.keys(m)) {
                if (!(k in rule.node)) rule.node[k] = m[k]
              }
            }
          }
        } else if (typeof mergeVal === 'object' && mergeVal !== null) {
          for (let k of Object.keys(mergeVal)) {
            if (!(k in rule.node)) rule.node[k] = mergeVal[k]
          }
        }
      }
    })

    rulespec.close([
      // Dedent: indent is smaller than current level => close this map.
      {
        s: [IN],
        c: (rule: Rule, ctx: Context) => {
          return ctx.t0.val < rule.n.in
        },
        b: 1,
      },
    ])
  })


  // Amend pair rule, treating IN like CA after pair.
  jsonic.rule('pair', (rulespec: RuleSpec) => {
    rulespec.open([
      // End of input in pair open: close gracefully.
      { s: [ZZ], b: 1 },
    ])



    rulespec.close([
      // Same indent level: continue with next pair.
      {
        s: [IN],
        c: (rule: Rule, ctx: Context) => {
          return ctx.t0.val === rule.n.in
        },
        r: 'pair',
      },

      // Smaller indent: close this pair (and the map will close too).
      {
        s: [IN],
        c: (rule: Rule, ctx: Context) => {
          return ctx.t0.val < rule.n.in
        },
        b: 1,
      },
    ])
  })


  // Add a custom rule for YAML element-map: handles "- key: val" patterns.
  // This rule is pushed by elem when it detects KEY CL after a dash.
  // It parses key-value pairs and returns the map as elem's child node.
  jsonic.rule('yamlElemMap', (rulespec: RuleSpec) => {
    rulespec
      .bo((rule: Rule) => {
        rule.node = Object.create(null)
      })
      .open([
        {
          s: [KEY, CL],
          p: 'val',
          a: (rule: Rule) => {
            rule.u.key = extractKey(rule)
          },
        },
      ])
      .bc((rule: Rule) => {
        if (rule.u.key != null) {
          rule.node[rule.u.key] = rule.child.node
        }
      })
      .close([
        // Same indent as the key: more pairs in this map.
        {
          s: [IN],
          c: (rule: Rule, ctx: Context) => {
            return ctx.t0.val === rule.k.yamlMapIn
          },
          r: 'yamlElemPair',
        },
        // Different indent or end: close the map.
        {
          s: [IN],
          b: 1,
        },
        // Flow collection: comma or close bracket/brace ends the map.
        { s: [CA], b: 1 },
        { s: [CS], b: 1 },
        { s: [CB], b: 1 },
        { s: [ZZ] },
      ])
  })

  // Additional pairs in a yamlElemMap.
  jsonic.rule('yamlElemPair', (rulespec: RuleSpec) => {
    rulespec
      .open([
        {
          s: [KEY, CL],
          p: 'val',
          a: (rule: Rule) => {
            rule.u.key = extractKey(rule)
          },
        },
      ])
      .bc((rule: Rule) => {
        if (rule.u.key != null) {
          rule.node[rule.u.key] = rule.child.node
        }
      })
      .close([
        // Same indent: more pairs.
        {
          s: [IN],
          c: (rule: Rule, ctx: Context) => {
            return ctx.t0.val === rule.k.yamlMapIn
          },
          r: 'yamlElemPair',
        },
        // Different indent or end: close.
        {
          s: [IN],
          b: 1,
        },
        // Flow collection: comma or close bracket/brace ends the pair.
        { s: [CA], b: 1 },
        { s: [CS], b: 1 },
        { s: [CB], b: 1 },
        { s: [ZZ] },
      ])
  })


  // Amend elem rule for YAML sequences.
  jsonic.rule('elem', (rulespec: RuleSpec) => {
    rulespec.open([
      // Element value is a key-value map: - key: val
      {
        s: [KEY, CL],
        p: 'yamlElemMap',
        b: 2,
        a: (rule: Rule) => {
          // The map's pairs are indented: list indent + 2 (for "- ").
          rule.k.yamlMapIn = rule.n.in + 2
        },
      },
    ])

    rulespec.close([
      // Indent followed by element marker: next element at same level.
      {
        s: [IN, EL],
        c: (rule: Rule, ctx: Context) => {
          return ctx.t0.val === rule.n.in
        },
        r: 'elem',
      },

      // Same indent but no element marker: close list (e.g. map key follows).
      {
        s: [IN],
        c: (rule: Rule, ctx: Context) => {
          return ctx.t0.val === rule.n.in
        },
        b: 1,
      },

      // Dedent: close this list.
      {
        s: [IN],
        c: (rule: Rule, ctx: Context) => {
          return ctx.t0.val < rule.n.in
        },
        b: 1,
      },

      // Element marker at top level (no preceding newline).
      {
        s: [EL],
        r: 'elem',
      },
    ])
  })

}


Yaml.defaults = ({
} as YamlOptions)


export {
  Yaml,
}

export type {
  YamlOptions,
}
