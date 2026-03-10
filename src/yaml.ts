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
  let pendingAnchors: string[] = []
  let pendingExplicitCL = false

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
      chars: '"`',
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
          let idx = 1
          if (fwd[idx] === '+') { chomp = 'keep'; idx++ }
          else if (fwd[idx] === '-') { chomp = 'strip'; idx++ }

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

            // Determine block indent from first content line.
            let blockIndent = 0
            let tempIdx = idx
            while (fwd[tempIdx] === ' ') { blockIndent++; tempIdx++ }

            if (blockIndent === 0) {
              // Empty block scalar.
              let val = chomp === 'strip' ? '' : chomp === 'keep' ? '\n' : ''
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
            while (pos < fwd.length) {
              // Check indent of current line.
              let lineIndent = 0
              while (pos + lineIndent < fwd.length && fwd[pos + lineIndent] === ' ') lineIndent++

              // Blank line (only whitespace before newline or end).
              let afterSpaces = pos + lineIndent
              if (afterSpaces >= fwd.length || fwd[afterSpaces] === '\n' || fwd[afterSpaces] === '\r') {
                lines.push('')
                pos = afterSpaces
                if (fwd[pos] === '\r') pos++
                if (fwd[pos] === '\n') pos++
                rows++
                continue
              }

              // Less indent means end of block.
              if (lineIndent < blockIndent) break

              // Consume the line content (strip block indent).
              let lineStart = pos + blockIndent
              let lineEnd = lineStart
              while (lineEnd < fwd.length && fwd[lineEnd] !== '\n' && fwd[lineEnd] !== '\r') lineEnd++
              lines.push(fwd.substring(lineStart, lineEnd))
              pos = lineEnd
              if (fwd[pos] === '\r') pos++
              if (fwd[pos] === '\n') pos++
              rows++
            }

            // Build the scalar value.
            let val: string
            if (fold) {
              // Folded: replace single newlines with spaces, preserve double newlines.
              let parts: string[] = []
              let current = ''
              for (let li = 0; li < lines.length; li++) {
                if (lines[li] === '') {
                  if (current) { parts.push(current); current = '' }
                  parts.push('')
                } else {
                  current = current ? current + ' ' + lines[li] : lines[li]
                }
              }
              if (current) parts.push(current)
              val = parts.join('\n')
            } else {
              // Literal: preserve newlines.
              val = lines.join('\n')
            }

            // Apply chomping.
            if (chomp === 'strip') {
              val = val.replace(/\n+$/, '')
            } else if (chomp === 'clip') {
              val = val.replace(/\n+$/, '') + '\n'
            } else {
              // keep: preserve all trailing newlines
              val = val + '\n'
            }

            let src = fwd.substring(0, pos)
            let tkn = lex.token('#TX', val, src, pnt)
            pnt.sI += pos
            pnt.rI += rows
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
            // Unquoted value — to end of line.
            while (valEnd < fwd.length && fwd[valEnd] !== '\n' && fwd[valEnd] !== '\r') valEnd++
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
        if (ch === '{' || ch === '}' || ch === '[' || ch === ']' ||
            ch === ',' || ch === ':' || ch === '#' || ch === '\n' ||
            ch === '\r' || ch === '"' || ch === "'" || ch === undefined) {
          return null
        }

        // Match text to end of line, stopping at `: `, `:\n`, ` #`, or newline.
        // This handles YAML plain scalars with multiline continuation.
        // Find key indent by scanning backward to the start of the line.
        let lineStart = pnt.sI
        while (lineStart > 0 && lex.src[lineStart - 1] !== '\n' && lex.src[lineStart - 1] !== '\r') lineStart--
        let keyIndent = 0
        while (lineStart + keyIndent < lex.src.length && lex.src[lineStart + keyIndent] === ' ') keyIndent++
        let text = ''
        let i = 0
        let totalConsumed = 0
        let rows = 0
        let scanLine = () => {
          let line = ''
          while (i < fwd.length) {
            let c = fwd[i]
            if (c === '\n' || c === '\r') break
            if (c === ':' && (fwd[i + 1] === ' ' || fwd[i + 1] === '\n' ||
                fwd[i + 1] === '\r' || fwd[i + 1] === undefined)) break
            if (c === ' ' && fwd[i + 1] === '#') break
            if (c === ']' || c === '}') break
            line += c
            i++
          }
          return line.replace(/\s+$/, '')
        }

        text = scanLine()
        totalConsumed = i

        // Check for continuation lines (multiline plain scalars).
        while (i < fwd.length && (fwd[i] === '\n' || fwd[i] === '\r')) {
          let nlPos = i
          if (fwd[i] === '\r') i++
          if (fwd[i] === '\n') i++
          // Count indent of next line.
          let lineIndent = 0
          while (i < fwd.length && fwd[i] === ' ') { lineIndent++; i++ }
          // If more indented than the key, this is a continuation line.
          // But NOT if the line contains `: ` (which makes it a key-value pair).
          if (lineIndent > keyIndent && i < fwd.length &&
              fwd[i] !== '\n' && fwd[i] !== '\r' && fwd[i] !== '#' &&
              fwd[i] !== '-') {
            // Check if this line is a key-value pair (contains ": ").
            let peekJ = i
            let isKV = false
            while (peekJ < fwd.length && fwd[peekJ] !== '\n' && fwd[peekJ] !== '\r') {
              if (fwd[peekJ] === ':' && (fwd[peekJ + 1] === ' ' || fwd[peekJ + 1] === '\n' ||
                  fwd[peekJ + 1] === '\r' || fwd[peekJ + 1] === undefined)) {
                isKV = true
                break
              }
              peekJ++
            }
            if (!isKV) {
              let contLine = scanLine()
              if (contLine.length > 0) {
                text += ' ' + contLine
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

  // All tokens that can start a value.
  let KEY = [TX, NR, ST, VL]

  // Add a custom lex matcher for YAML special cases.
  jsonic.options({
    lex: {
      match: {
        yaml: {
          order: 5e5,
          make: (_cfg: Config, _opts: Options) => {
            return function yamlMatcher(lex: Lex) {
              let pnt = lex.pnt
              let fwd = lex.src.substring(pnt.sI)

              // YAML alias: *name — emit a VL token with alias name.
              // Resolution happens at grammar time (val.ac) since the anchor
              // may not be recorded yet due to lexer pre-fetching.
              if (fwd[0] === '*') {
                let nameEnd = 1
                while (nameEnd < fwd.length && /[a-zA-Z0-9_-]/.test(fwd[nameEnd])) nameEnd++
                let name = fwd.substring(1, nameEnd)
                let src = fwd.substring(0, nameEnd)
                // Store the alias name as a special marker object.
                let marker = { __yamlAlias: name }
                let tkn = lex.token('#VL', marker, src, lex.pnt)
                pnt.sI += nameEnd
                pnt.cI += nameEnd
                return tkn
              }

              // YAML anchor: &name — store value. Skip the anchor marker,
              // let the value be parsed, and record it post-parse via grammar rules.
              if (fwd[0] === '&') {
                let nameEnd = 1
                while (nameEnd < fwd.length && /[a-zA-Z0-9_-]/.test(fwd[nameEnd])) nameEnd++
                let anchorName = fwd.substring(1, nameEnd)
                let skip = nameEnd
                if (fwd[skip] === ' ') skip++
                pnt.sI += skip
                pnt.cI += skip
                // Push pending anchor name.
                pendingAnchors.push(anchorName)
                // Update fwd and continue matching.
                fwd = lex.src.substring(pnt.sI)
              }

              // Skip !!seq and !!map tags — just consume and return undefined
              // so the next lex cycle handles the actual structure.
              if (fwd[0] === '!' && fwd[1] === '!' &&
                  ((fwd[2] === 's' && fwd[3] === 'e' && fwd[4] === 'q') ||
                   (fwd[2] === 'm' && fwd[3] === 'a' && fwd[4] === 'p'))) {
                let skip = 5
                while (skip < fwd.length && fwd[skip] === ' ') skip++
                pnt.sI += skip
                pnt.cI += skip
                // Don't return a token — let the next lex cycle see the actual value.
                fwd = lex.src.substring(pnt.sI)
                // Fall through to continue matching.
              }

              // Emit pending CL from explicit key.
              if (pendingExplicitCL) {
                pendingExplicitCL = false
                let tkn = lex.token('#CL', 1, ': ', lex.pnt)
                return tkn
              }

              // YAML explicit key indicator: ? key\n: value
              if (fwd[0] === '?' && (fwd[1] === ' ' || fwd[1] === '\n')) {
                let start = fwd[1] === ' ' ? 2 : 1
                let keyEnd = start
                while (keyEnd < fwd.length && fwd[keyEnd] !== '\n' && fwd[keyEnd] !== '\r') keyEnd++
                let key = fwd.substring(start, keyEnd).replace(/\s+$/, '')
                let src = fwd.substring(0, keyEnd)
                // Consume "? key" line.
                pnt.sI += keyEnd
                pnt.cI += keyEnd
                // Consume newline.
                if (pnt.sI < lex.src.length && lex.src[pnt.sI] === '\r') pnt.sI++
                if (pnt.sI < lex.src.length && lex.src[pnt.sI] === '\n') { pnt.sI++; pnt.rI++ }
                // Consume ": " on the next line.
                if (pnt.sI < lex.src.length && lex.src[pnt.sI] === ':') {
                  pnt.sI++
                  if (pnt.sI < lex.src.length && lex.src[pnt.sI] === ' ') pnt.sI++
                }
                pnt.cI = 1
                // Emit KEY token now, CL on next call.
                pendingExplicitCL = true
                let tkn = lex.token('#TX', key, src, lex.pnt)
                return tkn
              }

              // YAML document markers: --- and ...
              // --- starts a document (skip it), ... ends the document.
              if ((fwd[0] === '-' && fwd[1] === '-' && fwd[2] === '-' &&
                   (fwd[3] === '\n' || fwd[3] === '\r' || fwd[3] === ' ' || fwd[3] === undefined)) ||
                  (fwd[0] === '.' && fwd[1] === '.' && fwd[2] === '.' &&
                   (fwd[3] === '\n' || fwd[3] === '\r' || fwd[3] === ' ' || fwd[3] === undefined))) {
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
                  // --- skip it, then consume the newline and emit #IN.
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
                  // Emit #IN with the indent level after ---.
                  let src = fwd.substring(0, pos + 1 + spaces)
                  let tkn = lex.token('#IN', spaces, src, lex.pnt)
                  return tkn
                }
              }

              // YAML single-quoted string: no backslash escape processing.
              // Only escape is '' (two single quotes) → literal single quote.
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

              // YAML element marker: "- " (dash followed by space).
              if (fwd[0] === '-' && fwd[1] === ' ') {
                let tkn = lex.token('#EL', undefined, '- ', lex.pnt)
                pnt.sI += 2
                pnt.cI += 2
                return tkn
              }

              // Yaml colons are ': ', ':<newline>', or ':' at end of input.
              if (fwd[0] === ':' && (fwd[1] === ' ' || fwd[1] === '\n' ||
                  fwd[1] === '\r' || fwd[1] === undefined)) {
                let tkn = lex.token('#CL', 1, ': ', lex.pnt)
                pnt.sI += 1
                if (fwd[1] === ' ') {
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
            }
          }
        }
      }
    }
  })


  // Amend val rule to handle indents and element markers.
  jsonic.rule('val', (rulespec: RuleSpec) => {
    rulespec.open([
      {
        s: [IN],
        c: (rule: Rule, ctx: Context) => {
          // Only push indent if level is strictly greater than enclosing map.
          let parentIn = rule.k.yamlIn
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
        p: 'list',
        a: (rule: Rule) => rule.n.in = rule.o0.val
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
        p: 'list',
        a: (rule: Rule) => {
          // Set list indent from the element marker's column (1-based).
          rule.n.in = rule.o0.cI - 1
        }
      }
    ])

    // Claim pending anchors after first token is processed.
    rulespec.ao((rule: Rule) => {
      if (pendingAnchors.length > 0) {
        rule.u.yamlAnchorNames = [...pendingAnchors]
        pendingAnchors.length = 0
      }
    })

    rulespec.bc((rule: Rule) => {
      if (rule.u.yamlEmpty) {
        rule.node = undefined
      }
    })

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
      if (rule.u.yamlAnchorNames) {
        for (let name of rule.u.yamlAnchorNames) {
          let val = rule.node
          if (typeof val === 'object' && val !== null) {
            val = JSON.parse(JSON.stringify(val))
          }
          anchors[name] = val
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
          b: 1,
        }
      ])

      // Get the final value of the map or value.
      .bc((rule: Rule) => {
        if (undefined !== rule.child.node) {
          rule.node = rule.child.node
        }
      })
  })


  // Amend list rule: close on dedent.
  jsonic.rule('list', (rulespec: RuleSpec) => {
    rulespec.close([
      // Dedent: close this list.
      {
        s: [IN],
        c: (rule: Rule, ctx: Context) => {
          return ctx.t0.val < rule.n.in
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
            let key = ST === rule.o0.tin || TX === rule.o0.tin
              ? rule.o0.val : rule.o0.src
            rule.u.key = key
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
            let key = ST === rule.o0.tin || TX === rule.o0.tin
              ? rule.o0.val : rule.o0.src
            rule.u.key = key
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
