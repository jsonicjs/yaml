package yaml

import (
	"regexp"
	"strconv"
	"strings"

	jsonic "github.com/jsonicjs/jsonic/go"
)

// Yaml is a jsonic plugin that adds YAML parsing support.
func Yaml(j *jsonic.Jsonic, _ map[string]any) error {
	// Guard against re-entry during SetOptions's plugin re-application.
	// Without this, Grammar()/Rule() calls would be duplicated.
	if j.Decoration("yaml-installed") == true {
		return nil
	}
	j.Decorate("yaml-installed", true)

	TX := j.Token("#TX")
	NR := j.Token("#NR")
	ST := j.Token("#ST")
	VL := j.Token("#VL")
	CL := j.Token("#CL")
	ZZ := j.Token("#ZZ")
	CA := j.Token("#CA")
	CS := j.Token("#CS")
	CB := j.Token("#CB")

	// Register custom tokens.
	IN := j.Token("#IN") // Indent token
	EL := j.Token("#EL") // Element marker (- )

	KEY := []jsonic.Tin{TX, NR, ST, VL}

	// Shared state for the plugin instance.
	anchors := make(map[string]any)
	var pendingAnchors []anchorInfo
	pendingExplicitCL := false
	var pendingTokens []*jsonic.Token
	tagHandles := make(map[string]string)
	// Flag to tell the number matcher to skip, so TextCheck handles the value.
	skipNumberMatch := false

	cfg := j.Config()

	// ===== TextCheck: handles block scalars, !!tags, and plain scalars =====
	textCheck := func(lex *jsonic.Lex) *jsonic.LexCheckResult {
		pnt := lex.Cursor()
		src := lex.Src
		fwd := src[pnt.SI:]
		if len(fwd) == 0 {
			return nil
		}
		ch := fwd[0]

		// Block scalar: | or >
		if ch == '|' || ch == '>' {
			return handleBlockScalar(lex, pnt, src, fwd, ch)
		}

		// !!type tags in text check context
		if ch == '!' && len(fwd) > 1 && fwd[1] == '!' {
			return handleTagInTextCheck(lex, pnt, fwd, tagHandles)
		}

		// Skip special chars that should be handled by other matchers.
		if ch == '{' || ch == '}' || ch == '[' || ch == ']' ||
			ch == ',' || ch == '#' || ch == '\n' || ch == '\r' ||
			ch == '"' || ch == '\'' || ch == '*' || ch == '&' || ch == '!' {
			return nil
		}

		// Colon followed by space/tab/newline/eof is a separator, not text.
		if ch == ':' && (len(fwd) < 2 || fwd[1] == ' ' || fwd[1] == '\t' || fwd[1] == '\n' || fwd[1] == '\r') {
			return nil
		}

		// Plain scalar — scan to end of line, handling multiline continuation.
		return handlePlainScalar(lex, pnt, src, fwd)
	}

	// ===== Custom YAML matcher (priority 500000 — before fixed tokens) =====
	srcCleaned := false

	yamlMatcher := func(lex *jsonic.Lex, _ *jsonic.Rule) *jsonic.Token {
		pnt := lex.Cursor()
		src := lex.Src

		// First call: clean source (strip directives, initial ---).
		if !srcCleaned {
			srcCleaned = true
			cleaned := cleanSource(src, tagHandles)
			if cleaned != src {
				lex.Src = cleaned
				pnt.Len = len(cleaned)
			}
		}

		if pnt.SI >= pnt.Len {
			return nil
		}

		// Emit pending tokens (from explicit key handling).
		if len(pendingTokens) > 0 {
			tkn := pendingTokens[0]
			pendingTokens = pendingTokens[1:]
			return tkn
		}

		// Emit pending explicit CL token.
		if pendingExplicitCL {
			pendingExplicitCL = false
			tkn := lex.Token("#CL", CL, 1, ": ")
			return tkn
		}

		fwd := lex.Src[pnt.SI:]
		if len(fwd) == 0 {
			return nil
		}

		// Process YAML features in a loop to handle chaining.
		for {
			if pnt.SI >= pnt.Len {
				return nil
			}
			fwd = lex.Src[pnt.SI:]
			if len(fwd) == 0 {
				return nil
			}

			// Alias: *name
			if fwd[0] == '*' {
				nameEnd := 1
				for nameEnd < len(fwd) && fwd[nameEnd] != ' ' && fwd[nameEnd] != '\t' &&
					fwd[nameEnd] != '\n' && fwd[nameEnd] != '\r' && fwd[nameEnd] != ',' &&
					fwd[nameEnd] != '{' && fwd[nameEnd] != '}' && fwd[nameEnd] != '[' &&
					fwd[nameEnd] != ']' {
					nameEnd++
				}
				aliasName := fwd[1:nameEnd]
				if val, ok := anchors[aliasName]; ok {
					var tkn *jsonic.Token
					switch v := val.(type) {
					case string:
						tkn = lex.Token("#TX", TX, v, fwd[:nameEnd])
					case float64:
						tkn = lex.Token("#NR", NR, v, fwd[:nameEnd])
					case bool:
						tkn = lex.Token("#VL", VL, v, fwd[:nameEnd])
					case nil:
						tkn = lex.Token("#VL", VL, nil, fwd[:nameEnd])
					default:
						// Complex value — use alias marker for later resolution.
						tkn = lex.Token("#VL", VL, map[string]any{"__yamlAlias": aliasName}, fwd[:nameEnd])
					}
					pnt.SI += nameEnd
					pnt.CI += nameEnd
					return tkn
				}
				// Unknown alias — return as marker.
				tkn := lex.Token("#VL", VL, map[string]any{"__yamlAlias": aliasName}, fwd[:nameEnd])
				pnt.SI += nameEnd
				pnt.CI += nameEnd
				return tkn
			}

			// Anchor: &name
			if fwd[0] == '&' {
				nameEnd := 1
				for nameEnd < len(fwd) && fwd[nameEnd] != ' ' && fwd[nameEnd] != '\t' &&
					fwd[nameEnd] != '\n' && fwd[nameEnd] != '\r' && fwd[nameEnd] != ',' &&
					fwd[nameEnd] != '{' && fwd[nameEnd] != '}' && fwd[nameEnd] != '[' &&
					fwd[nameEnd] != ']' {
					nameEnd++
				}
				anchorName := fwd[1:nameEnd]
				anchorInline := true

				// Check if anchor is standalone (nothing meaningful after it on the line).
				afterAnchor := nameEnd
				for afterAnchor < len(fwd) && (fwd[afterAnchor] == ' ' || fwd[afterAnchor] == '\t') {
					afterAnchor++
				}
				isStandalone := afterAnchor >= len(fwd) || fwd[afterAnchor] == '\n' ||
					fwd[afterAnchor] == '\r' || fwd[afterAnchor] == '#'

				if isStandalone {
					anchorInline = false
				}

				// Try to capture inline scalar value for the anchor.
				if anchorInline && afterAnchor < len(fwd) {
					peek := fwd[afterAnchor:]
					var scalarVal any
					pch := byte(0)
					if len(peek) > 0 {
						pch = peek[0]
					}
					if pch == '"' {
						ei := 1
						for ei < len(peek) && peek[ei] != '"' {
							if peek[ei] == '\\' {
								ei++
							}
							ei++
						}
						raw := peek[1:ei]
						raw = strings.ReplaceAll(raw, "\\n", "\n")
						raw = strings.ReplaceAll(raw, "\\t", "\t")
						raw = strings.ReplaceAll(raw, "\\\\", "\\")
						raw = strings.ReplaceAll(raw, `\"`, `"`)
						scalarVal = raw
					} else if pch == '\'' {
						ei := 1
						for ei < len(peek) && peek[ei] != '\'' {
							if ei+1 < len(peek) && peek[ei] == '\'' && peek[ei+1] == '\'' {
								ei++
							}
							ei++
						}
						raw := peek[1:ei]
						raw = strings.ReplaceAll(raw, "''", "'")
						scalarVal = raw
					} else if pch != 0 && pch != '{' && pch != '[' && pch != '\n' && pch != '\r' {
						ei := 0
						for ei < len(peek) && peek[ei] != '\n' && peek[ei] != '\r' &&
							peek[ei] != ',' && peek[ei] != '}' && peek[ei] != ']' {
							if peek[ei] == ':' && (ei+1 >= len(peek) || peek[ei+1] == ' ' ||
								peek[ei+1] == '\t' || peek[ei+1] == '\n' || peek[ei+1] == '\r') {
								break
							}
							if peek[ei] == ' ' && ei+1 < len(peek) && peek[ei+1] == '#' {
								break
							}
							ei++
						}
						raw := strings.TrimRight(peek[:ei], " \t")
						if len(raw) > 0 {
							scalarVal = raw
						}
					}
					if scalarVal != nil {
						anchors[anchorName] = scalarVal
					}
				}

				pendingAnchors = append(pendingAnchors, anchorInfo{name: anchorName, inline: anchorInline})

				// Consume the anchor name (and trailing spaces, but NOT the newline).
				skip := nameEnd
				for skip < len(fwd) && (fwd[skip] == ' ' || fwd[skip] == '\t') {
					skip++
				}
				// Skip comments after anchor.
				if skip < len(fwd) && fwd[skip] == '#' {
					for skip < len(fwd) && fwd[skip] != '\n' && fwd[skip] != '\r' {
						skip++
					}
				}
				pnt.SI += skip
				pnt.CI += skip

				continue // Re-loop to process what follows the anchor
			}

			// Directive lines (%YAML, %TAG, etc.): skip to ---
			if fwd[0] == '%' {
				pos := 0
				for pos < len(fwd) {
					if isDocMarker(fwd, pos) {
						break
					}
					for pos < len(fwd) && fwd[pos] != '\n' && fwd[pos] != '\r' {
						pos++
					}
					if pos < len(fwd) && fwd[pos] == '\r' {
						pos++
					}
					if pos < len(fwd) && fwd[pos] == '\n' {
						pos++
					}
					pnt.RI++
				}
				pnt.SI += pos
				pnt.CI = 0
				continue
			}

			// Non-specific tag: ! value
			if fwd[0] == '!' && len(fwd) > 1 && fwd[1] != '!' {
				if fwd[1] == ' ' {
					// Non-specific tag: ! value
					valStart := 2
					valEnd := valStart
					for valEnd < len(fwd) && fwd[valEnd] != '\n' && fwd[valEnd] != '\r' {
						valEnd++
					}
					rawVal := trimRight(fwd[valStart:valEnd])
					tkn := lex.Token("#TX", TX, rawVal, fwd[:valEnd])
					pnt.SI += valEnd
					pnt.CI += valEnd
					return tkn
				}
				// Local tag: !name value — skip the tag.
				tagEnd := 1
				for tagEnd < len(fwd) && fwd[tagEnd] != ' ' && fwd[tagEnd] != '\n' && fwd[tagEnd] != '\r' {
					tagEnd++
				}
				if tagEnd < len(fwd) && fwd[tagEnd] == ' ' {
					tagEnd++
				}
				pnt.SI += tagEnd
				pnt.CI += tagEnd
				// If tag is standalone, consume newline + spaces.
				if pnt.SI < pnt.Len && (lex.Src[pnt.SI] == '\n' || lex.Src[pnt.SI] == '\r') {
					tagStandalone := true
					tagLineIndent := 0
					tbi := pnt.SI - tagEnd - 1
					for tbi >= 0 && lex.Src[tbi] != '\n' && lex.Src[tbi] != '\r' {
						if lex.Src[tbi] != ' ' && lex.Src[tbi] != '\t' {
							tagStandalone = false
							break
						}
						tagLineIndent++
						tbi--
					}
					_ = tagLineIndent
					if tagStandalone {
						nl := pnt.SI
						if nl < pnt.Len && lex.Src[nl] == '\r' {
							nl++
						}
						if nl < pnt.Len && lex.Src[nl] == '\n' {
							nl++
						}
						spaces := 0
						for nl+spaces < pnt.Len && lex.Src[nl+spaces] == ' ' {
							spaces++
						}
						pnt.SI = nl + spaces
						pnt.CI = spaces
						pnt.RI++
					}
				}
				continue
			}

			// !!seq, !!map, !!omap, etc. structural tags — skip them.
			structTagRe := regexp.MustCompile(`^!!(seq|map|omap|set|pairs|binary|ordered|python/\S*)`)
			if fwd[0] == '!' && len(fwd) > 1 && fwd[1] == '!' && structTagRe.MatchString(fwd) {
				skip := 2
				for skip < len(fwd) && fwd[skip] != ' ' && fwd[skip] != '\n' {
					skip++
				}
				for skip < len(fwd) && fwd[skip] == ' ' {
					skip++
				}
				// If standalone, consume newline.
				tagIndent := 0
				tbi := pnt.SI - 1
				standalone := true
				for tbi >= 0 && lex.Src[tbi] != '\n' && lex.Src[tbi] != '\r' {
					if lex.Src[tbi] != ' ' && lex.Src[tbi] != '\t' {
						standalone = false
						break
					}
					tagIndent++
					tbi--
				}
				if standalone && skip < len(fwd) && (fwd[skip] == '\n' || fwd[skip] == '\r') {
					nl := skip
					if nl < len(fwd) && fwd[nl] == '\r' {
						nl++
					}
					if nl < len(fwd) && fwd[nl] == '\n' {
						nl++
					}
					spaces := 0
					for nl+spaces < len(fwd) && fwd[nl+spaces] == ' ' {
						spaces++
					}
					if spaces >= tagIndent {
						skip = nl + spaces
						pnt.SI += skip
						pnt.CI = spaces
						pnt.RI++
						continue
					}
				}
				pnt.SI += skip
				pnt.CI += skip
				continue
			}

			// !!type tags (!!str, !!int, !!float, !!bool, !!null).
			if fwd[0] == '!' && len(fwd) > 1 && fwd[1] == '!' {
				return handleTypeTag(lex, pnt, fwd, tagHandles, &pendingAnchors, anchors, TX, NR, VL, ST)
			}

			// Explicit key: ? key
			if fwd[0] == '?' && (len(fwd) < 2 || fwd[1] == ' ' || fwd[1] == '\t' ||
				fwd[1] == '\n' || fwd[1] == '\r') {
				return handleExplicitKey(lex, pnt, fwd, &pendingExplicitCL, &pendingTokens, TX, CL, VL)
			}

			// Document markers: --- and ...
			if isDocMarker(fwd, 0) {
				return handleDocMarker(lex, pnt, fwd, IN, &pendingAnchors, anchors, TX)
			}

			// Re-check patterns after --- fall-through.
			if fwd[0] == '%' {
				pos := 0
				for pos < len(fwd) {
					if isDocMarker(fwd, pos) {
						break
					}
					for pos < len(fwd) && fwd[pos] != '\n' && fwd[pos] != '\r' {
						pos++
					}
					if pos < len(fwd) && fwd[pos] == '\r' {
						pos++
					}
					if pos < len(fwd) && fwd[pos] == '\n' {
						pos++
					}
					pnt.RI++
				}
				pnt.SI += pos
				pnt.CI = 0
				continue
			}

			// Non-specific tag after ---.
			if fwd[0] == '!' && len(fwd) > 1 && fwd[1] == ' ' {
				valStart := 2
				valEnd := valStart
				for valEnd < len(fwd) && fwd[valEnd] != '\n' && fwd[valEnd] != '\r' {
					valEnd++
				}
				rawVal := trimRight(fwd[valStart:valEnd])
				tkn := lex.Token("#TX", TX, rawVal, fwd[:valEnd])
				pnt.SI += valEnd
				pnt.CI += valEnd
				return tkn
			}

			// Anchor after --- fall-through.
			if fwd[0] == '&' {
				continue // Will be handled at top of loop
			}

			// YAML double-quoted string.
			if fwd[0] == '"' {
				return handleDoubleQuotedString(lex, pnt, fwd, ST)
			}

			// YAML single-quoted string.
			if fwd[0] == '\'' {
				return handleSingleQuotedString(lex, pnt, fwd, ST)
			}

			// Plain scalars starting with digits that contain colons (e.g. 20:03:20).
			if fwd[0] >= '0' && fwd[0] <= '9' {
				if tkn := handleNumericColon(lex, pnt, fwd, TX, &skipNumberMatch); tkn != nil {
					return tkn
				}
			}

			// Element marker: - (followed by space/tab/newline/eof)
			if fwd[0] == '-' && (len(fwd) < 2 || fwd[1] == ' ' || fwd[1] == '\t' ||
				fwd[1] == '\n' || fwd[1] == '\r') {
				tkn := lex.Token("#EL", EL, nil, "- ")
				pnt.SI++
				pnt.CI++
				if len(fwd) > 1 && (fwd[1] == ' ' || fwd[1] == '\t') {
					pnt.SI++
					pnt.CI++
				}
				return tkn
			}

			// YAML colon: ": ", ":\t", ":\n", ":" at end.
			isFlowColon := false
			if fwd[0] == ':' && len(fwd) > 1 && fwd[1] != ' ' && fwd[1] != '\t' &&
				fwd[1] != '\n' && fwd[1] != '\r' {
				prevI := pnt.SI - 1
				for prevI >= 0 && (lex.Src[prevI] == ' ' || lex.Src[prevI] == '\t' ||
					lex.Src[prevI] == '\n' || lex.Src[prevI] == '\r') {
					prevI--
				}
				if prevI >= 0 && (lex.Src[prevI] == '"' || lex.Src[prevI] == '\'') {
					isFlowColon = true
				}
			}
			if fwd[0] == ':' && (len(fwd) < 2 || fwd[1] == ' ' || fwd[1] == '\t' ||
				fwd[1] == '\n' || fwd[1] == '\r' || isFlowColon) {
				tkn := lex.Token("#CL", CL, 1, ": ")
				pnt.SI++
				if len(fwd) > 1 && (fwd[1] == ' ' || fwd[1] == '\t') {
					pnt.CI += 2
				} else if len(fwd) > 1 && (fwd[1] == '\n' || fwd[1] == '\r') {
					// Don't consume newline.
				} else {
					pnt.CI++
				}
				return tkn
			}

			// Newline handling — YAML indentation is significant.
			if fwd[0] == '\n' || fwd[0] == '\r' {
				// Check if we're inside a flow collection.
				inFlow := 0
				for fi := 0; fi < pnt.SI; fi++ {
					fc := lex.Src[fi]
					if fc == '{' || fc == '[' {
						inFlow++
					} else if fc == '}' || fc == ']' {
						if inFlow > 0 {
							inFlow--
						}
					} else if fc == '"' {
						fi++
						for fi < pnt.SI && lex.Src[fi] != '"' {
							if lex.Src[fi] == '\\' {
								fi++
							}
							fi++
						}
					} else if fc == '\'' {
						fi++
						for fi < pnt.SI && lex.Src[fi] != '\'' {
							if fi+1 < pnt.SI && lex.Src[fi] == '\'' && lex.Src[fi+1] == '\'' {
								fi++
							}
							fi++
						}
					}
				}
				if inFlow > 0 {
					// Inside flow collection — consume whitespace.
					pos := 0
					for pos < len(fwd) && (fwd[pos] == '\n' || fwd[pos] == '\r' ||
						fwd[pos] == ' ' || fwd[pos] == '\t') {
						pos++
					}
					if pos < len(fwd) && fwd[pos] == '#' {
						for pos < len(fwd) && fwd[pos] != '\n' && fwd[pos] != '\r' {
							pos++
						}
					}
					pnt.SI += pos
					pnt.CI = 0
					continue
				}

				// Block context newline — emit #IN with indent level.
				pos := 0
				spaces := 0
				rows := 0
				for pos < len(fwd) {
					if fwd[pos] == '\r' && pos+1 < len(fwd) && fwd[pos+1] == '\n' {
						pos += 2
						rows++
					} else if fwd[pos] == '\n' {
						pos++
						rows++
					} else {
						break
					}
					spaces = 0
					for pos < len(fwd) && fwd[pos] == ' ' {
						pos++
						spaces++
					}
					// Comment-only line — skip.
					if pos < len(fwd) && fwd[pos] == '#' {
						for pos < len(fwd) && fwd[pos] != '\n' && fwd[pos] != '\r' {
							pos++
						}
						continue
					}
					// Tab-only line — skip.
					if pos < len(fwd) && fwd[pos] == '\t' {
						tp := pos
						for tp < len(fwd) && (fwd[tp] == ' ' || fwd[tp] == '\t') {
							tp++
						}
						if tp >= len(fwd) || fwd[tp] == '\n' || fwd[tp] == '\r' {
							pos = tp
							continue
						}
					}
					// Anchor-only line.
					if pos < len(fwd) && fwd[pos] == '&' {
						ae := pos + 1
						for ae < len(fwd) && fwd[ae] != ' ' && fwd[ae] != '\t' &&
							fwd[ae] != '\n' && fwd[ae] != '\r' {
							ae++
						}
						afterAnchor := ae
						for afterAnchor < len(fwd) && (fwd[afterAnchor] == ' ' || fwd[afterAnchor] == '\t') {
							afterAnchor++
						}
						if afterAnchor >= len(fwd) || fwd[afterAnchor] == '\n' ||
							fwd[afterAnchor] == '\r' || fwd[afterAnchor] == '#' {
							pendingAnchors = append(pendingAnchors, anchorInfo{name: fwd[pos+1 : ae], inline: false})
							for afterAnchor < len(fwd) && fwd[afterAnchor] != '\n' && fwd[afterAnchor] != '\r' {
								afterAnchor++
							}
							pos = afterAnchor
							continue
						}
					}
				}

				// Consumed everything — emit ZZ.
				if pos >= len(fwd) {
					pnt.SI += pos
					pnt.RI += rows
					pnt.CI = spaces + 1
					tkn := lex.Token("#ZZ", ZZ, jsonic.Undefined, "")
					return tkn
				}

				// Emit #IN with indent level.
				tkn := lex.Token("#IN", IN, spaces, fwd[:pos])
				pnt.SI += pos
				pnt.RI += rows
				pnt.CI = spaces + 1
				return tkn
			}

			break // End of yamlMatchLoop
		}

		return nil
	}

	// Register the YAML matcher via SetOptions (must come before cfg mutations
	// below, as SetOptions rebuilds parts of the config).
	j.SetOptions(jsonic.Options{Lex: &jsonic.LexOptions{Match: map[string]*jsonic.MatchSpec{
		"yaml": {Order: 500000, Make: func(_ *jsonic.LexConfig, _ *jsonic.Options) jsonic.LexMatcher {
			return yamlMatcher
		}},
	}}})

	// Remove colon as a fixed token — YAML uses ": " (colon-space).
	delete(cfg.FixedTokens, ":")
	cfg.SortFixedTokens()

	// Add colon as an ender char so text tokens stop at ":".
	if cfg.EnderChars == nil {
		cfg.EnderChars = make(map[rune]bool)
	}
	cfg.EnderChars[':'] = true

	// Skip number matching when the yamlMatcher detected trailing text
	// after a digit-starting value (e.g. "64 characters, hexadecimal.").
	cfg.NumberCheck = func(lex *jsonic.Lex) *jsonic.LexCheckResult {
		if skipNumberMatch {
			skipNumberMatch = false
			return &jsonic.LexCheckResult{Done: true}
		}
		return nil
	}

	cfg.TextCheck = textCheck

	// ===== Grammar rules =====
	configureGrammarRules(j, IN, EL, KEY, CL, ZZ, CA, CS, CB, TX, ST, VL, NR,
		anchors, &pendingAnchors)
	return nil
}

// cleanSource strips YAML directives and initial document markers from source.
func cleanSource(src string, tagHandles map[string]string) string {
	if len(src) == 0 {
		return src
	}

	// Remove leading directive block.
	if src[0] == '%' {
		dIdx := strings.Index(src, "\n---")
		if dIdx >= 0 {
			dirBlock := src[:dIdx]
			for _, dl := range strings.Split(dirBlock, "\n") {
				tagMatch := regexp.MustCompile(`^%TAG\s+(\S+)\s+(\S+)`).FindStringSubmatch(dl)
				if tagMatch != nil {
					tagHandles[tagMatch[1]] = tagMatch[2]
				}
			}
			src = src[dIdx+1:]
		}
	}

	// Strip leading comment lines before ---.
	for {
		commentRe := regexp.MustCompile(`^[ \t]*#[^\n]*\n`)
		if !commentRe.MatchString(src) || !strings.Contains(src, "\n---") {
			break
		}
		src = commentRe.ReplaceAllString(src, "")
	}

	// Handle document start marker (---).
	docRe := regexp.MustCompile(`^---([ \t]+(.+))?(\r?\n|$)`)
	docMatch := docRe.FindStringSubmatch(src)
	if docMatch != nil {
		prefix := ""
		if len(docMatch) > 2 {
			prefix = docMatch[2]
		}
		rest := src[len(docMatch[0]):]
		trimmed := strings.TrimLeft(prefix, " \t")

		if len(trimmed) > 0 && (trimmed[0] == '>' || trimmed[0] == '|') {
			// Leave --- in place for block scalar context.
		} else if prefix != "" && (len(trimmed) == 0 || trimmed[0] != '#') {
			structTagRe := regexp.MustCompile(`^!!(seq|map|omap|set|pairs|binary|ordered)\s*$`)
			if structTagRe.MatchString(trimmed) {
				src = rest
			} else {
				suffix := ""
				if len(docMatch) > 3 {
					suffix = docMatch[3]
				}
				src = prefix + suffix + rest
			}
		} else {
			src = rest
		}
	}

	// Handle document end marker (... at end of source).
	dotRe := regexp.MustCompile(`\n\.\.\.\s*(\r?\n.*)?$`)
	if dotRe.MatchString(src) {
		loc := dotRe.FindStringIndex(src)
		if loc != nil {
			src = src[:loc[0]]
		}
	}

	return src
}

// handleBlockScalar processes | and > block scalar indicators.
func handleBlockScalar(lex *jsonic.Lex, pnt *jsonic.Point, src, fwd string, ch byte) *jsonic.LexCheckResult {
	fold := ch == '>'
	chomp := "clip"
	explicitIndent := 0
	idx := 1

	// Parse chomping and indent indicators.
	for pi := 0; pi < 2 && idx < len(fwd); pi++ {
		if fwd[idx] == '+' {
			chomp = "keep"
			idx++
		} else if fwd[idx] == '-' {
			chomp = "strip"
			idx++
		} else if fwd[idx] >= '1' && fwd[idx] <= '9' {
			explicitIndent = int(fwd[idx] - '0')
			idx++
		}
	}

	// Skip trailing spaces and comments.
	for idx < len(fwd) && fwd[idx] == ' ' {
		idx++
	}
	if idx < len(fwd) && fwd[idx] == '#' {
		for idx < len(fwd) && fwd[idx] != '\n' && fwd[idx] != '\r' {
			idx++
		}
	}

	// Must be followed by newline or eof.
	if idx < len(fwd) && fwd[idx] != '\n' && fwd[idx] != '\r' {
		return nil // Not a block scalar.
	}

	// Skip the indicator line's newline.
	if idx < len(fwd) && fwd[idx] == '\r' {
		idx++
	}
	if idx < len(fwd) && fwd[idx] == '\n' {
		idx++
	}

	// Determine block indent.
	blockIndent := 0
	if explicitIndent == 0 {
		// Auto-detect from first content line.
		tempIdx := idx
		for tempIdx < len(fwd) {
			lineSpaces := 0
			for tempIdx+lineSpaces < len(fwd) && fwd[tempIdx+lineSpaces] == ' ' {
				lineSpaces++
			}
			afterSpaces := tempIdx + lineSpaces
			if afterSpaces >= len(fwd) || fwd[afterSpaces] == '\n' || fwd[afterSpaces] == '\r' {
				tempIdx = afterSpaces
				if tempIdx < len(fwd) && fwd[tempIdx] == '\r' {
					tempIdx++
				}
				if tempIdx < len(fwd) && fwd[tempIdx] == '\n' {
					tempIdx++
				}
				continue
			}
			blockIndent = lineSpaces
			break
		}
	}

	// Determine containing indent.
	containingIndent := 0
	isDocStart := false
	li := pnt.SI - 1
	for li > 0 && src[li-1] != '\n' && src[li-1] != '\r' {
		li--
	}
	lineStart := li
	for li < pnt.SI && src[li] == ' ' {
		containingIndent++
		li++
	}
	if lineStart+2 < len(src) && src[lineStart] == '-' && src[lineStart+1] == '-' && src[lineStart+2] == '-' {
		isDocStart = true
	}

	// Apply explicit indent.
	if explicitIndent > 0 {
		hasColonOnLine := false
		for ci := lineStart + containingIndent; ci < pnt.SI; ci++ {
			if src[ci] == ':' && ci+1 < len(src) && (src[ci+1] == ' ' || src[ci+1] == '\t') {
				hasColonOnLine = true
				break
			}
		}
		keyCol := containingIndent
		if hasColonOnLine {
			scanI := lineStart + containingIndent
			for scanI < pnt.SI && src[scanI] == '-' &&
				scanI+1 < len(src) && (src[scanI+1] == ' ' || src[scanI+1] == '\t') {
				keyCol += 2
				scanI += 2
				for scanI < pnt.SI && src[scanI] == ' ' {
					keyCol++
					scanI++
				}
			}
			blockIndent = keyCol + explicitIndent
		} else {
			parentIndent := 0
			searchI := lineStart - 1
			if searchI > 0 {
				if src[searchI] == '\n' {
					searchI--
				}
				if searchI > 0 && src[searchI] == '\r' {
					searchI--
				}
				prevLineEnd := searchI + 1
				for searchI > 0 && src[searchI-1] != '\n' && src[searchI-1] != '\r' {
					searchI--
				}
				prevLineStart := searchI
				for ci := prevLineStart; ci < prevLineEnd; ci++ {
					if src[ci] == ':' && (ci+1 >= prevLineEnd || src[ci+1] == ' ' ||
						src[ci+1] == '\t' || src[ci+1] == '\n' || src[ci+1] == '\r') {
						parentIndent = 0
						pi := prevLineStart
						for pi < prevLineEnd && src[pi] == ' ' {
							parentIndent++
							pi++
						}
						break
					}
				}
			}
			blockIndent = parentIndent + explicitIndent
			containingIndent = parentIndent
		}
	}

	if blockIndent <= containingIndent && !isDocStart && idx < len(fwd) {
		// Content is not indented enough — empty block scalar.
		var val string
		if chomp == "keep" {
			blankCount := 0
			bi := idx
			for bi < len(fwd) {
				if fwd[bi] == '\n' {
					blankCount++
					bi++
				} else if fwd[bi] == '\r' {
					bi++
					if bi < len(fwd) && fwd[bi] == '\n' {
						bi++
					}
					blankCount++
				} else {
					break
				}
			}
			if blankCount > 0 {
				val = strings.Repeat("\n", blankCount)
			} else {
				val = "\n"
			}
			idx = bi
		} else {
			val = ""
		}
		tkn := lex.Token("#TX", jsonic.TinTX, val, fwd[:idx])
		pnt.SI += idx
		pnt.RI++
		pnt.CI = 0
		return &jsonic.LexCheckResult{Done: true, Token: tkn}
	}

	// Collect indented lines.
	var lines []string
	pos := idx
	rows := 1
	lastNewlinePos := idx
	for pos < len(fwd) {
		lineIndent := 0
		for pos+lineIndent < len(fwd) && fwd[pos+lineIndent] == ' ' {
			lineIndent++
		}
		afterSpaces := pos + lineIndent
		if afterSpaces >= len(fwd) || fwd[afterSpaces] == '\n' || fwd[afterSpaces] == '\r' {
			if lineIndent > blockIndent {
				lines = append(lines, fwd[pos+blockIndent:afterSpaces])
			} else {
				lines = append(lines, "")
			}
			lastNewlinePos = afterSpaces
			pos = afterSpaces
			if pos < len(fwd) && fwd[pos] == '\r' {
				pos++
			}
			if pos < len(fwd) && fwd[pos] == '\n' {
				pos++
			}
			rows++
			continue
		}
		if lineIndent < blockIndent {
			break
		}
		if lineIndent == 0 && isDocMarker(fwd, pos) {
			break
		}
		lineStartPos := pos + blockIndent
		lineEnd := lineStartPos
		for lineEnd < len(fwd) && fwd[lineEnd] != '\n' && fwd[lineEnd] != '\r' {
			lineEnd++
		}
		lines = append(lines, fwd[lineStartPos:lineEnd])
		lastNewlinePos = lineEnd
		pos = lineEnd
		if pos < len(fwd) && fwd[pos] == '\r' {
			pos++
		}
		if pos < len(fwd) && fwd[pos] == '\n' {
			pos++
		}
		rows++
	}

	// Build scalar value.
	var val string
	if fold {
		val = foldLines(lines)
	} else {
		val = strings.Join(lines, "\n")
	}

	// Apply chomping.
	if len(lines) == 0 {
		val = ""
	} else if chomp == "strip" {
		val = strings.TrimRight(val, "\n")
	} else if chomp == "clip" {
		val = strings.TrimRight(val, "\n") + "\n"
	} else {
		// keep
		val = val + "\n"
	}

	// Don't consume final newline if more content follows.
	endPos := pos
	endRows := rows
	if pos < len(fwd) && pos > lastNewlinePos {
		ni := pos
		nextLineIndent := 0
		for ni < len(fwd) && fwd[ni] == ' ' {
			nextLineIndent++
			ni++
		}
		isNextDocMarker := nextLineIndent == 0 && isDocMarker(fwd, ni)
		if !isNextDocMarker {
			endPos = lastNewlinePos
			endRows = rows - 1
		}
	}

	tkn := lex.Token("#TX", jsonic.TinTX, val, fwd[:endPos])
	pnt.SI += endPos
	pnt.RI += endRows
	pnt.CI = 0
	return &jsonic.LexCheckResult{Done: true, Token: tkn}
}

// foldLines implements YAML folded scalar line joining.
func foldLines(lines []string) string {
	var result strings.Builder
	prevWasNormal := false
	pendingEmptyCount := 0

	for _, line := range lines {
		isMore := len(line) > 0 && (line[0] == ' ' || line[0] == '\t')
		isEmpty := line == ""

		if isEmpty {
			pendingEmptyCount++
		} else if isMore {
			if prevWasNormal && result.Len() > 0 {
				result.WriteByte('\n')
			}
			for ei := 0; ei < pendingEmptyCount; ei++ {
				result.WriteByte('\n')
			}
			pendingEmptyCount = 0
			if result.Len() > 0 {
				s := result.String()
				if s[len(s)-1] != '\n' {
					result.WriteByte('\n')
				}
			}
			result.WriteString(line)
			result.WriteByte('\n')
			prevWasNormal = false
		} else {
			if pendingEmptyCount > 0 {
				if prevWasNormal && result.Len() > 0 {
					result.WriteByte('\n')
					for ei := 1; ei < pendingEmptyCount; ei++ {
						result.WriteByte('\n')
					}
				} else {
					for ei := 0; ei < pendingEmptyCount; ei++ {
						result.WriteByte('\n')
					}
				}
				pendingEmptyCount = 0
			}
			if prevWasNormal && result.Len() > 0 {
				s := result.String()
				if s[len(s)-1] != '\n' {
					result.WriteByte(' ')
				}
			}
			result.WriteString(line)
			prevWasNormal = true
		}
	}
	for ei := 0; ei < pendingEmptyCount; ei++ {
		result.WriteByte('\n')
	}
	return result.String()
}

// handleTagInTextCheck processes !!type tags encountered in the text check callback.
func handleTagInTextCheck(lex *jsonic.Lex, pnt *jsonic.Point, fwd string, tagHandles map[string]string) *jsonic.LexCheckResult {
	tagEnd := 2
	for tagEnd < len(fwd) && fwd[tagEnd] != ' ' && fwd[tagEnd] != '\n' && fwd[tagEnd] != '\r' {
		tagEnd++
	}
	tag := fwd[2:tagEnd]
	if tag == "seq" || tag == "map" {
		return nil // Let yamlMatcher handle.
	}
	valStart := tagEnd
	if valStart < len(fwd) && fwd[valStart] == ' ' {
		valStart++
	}
	rawVal := ""
	valEnd := valStart
	if valStart < len(fwd) && (fwd[valStart] == '"' || fwd[valStart] == '\'') {
		q := fwd[valStart]
		valEnd = valStart + 1
		for valEnd < len(fwd) && fwd[valEnd] != q {
			if fwd[valEnd] == '\\' && q == '"' {
				valEnd++
			}
			valEnd++
		}
		if valEnd < len(fwd) && fwd[valEnd] == q {
			valEnd++
		}
		rawVal = fwd[valStart+1 : valEnd-1]
	} else {
		for valEnd < len(fwd) && fwd[valEnd] != '\n' && fwd[valEnd] != '\r' {
			if fwd[valEnd] == ':' && (valEnd+1 >= len(fwd) || fwd[valEnd+1] == ' ' ||
				fwd[valEnd+1] == '\n' || fwd[valEnd+1] == '\r') {
				break
			}
			if fwd[valEnd] == ' ' && valEnd+1 < len(fwd) && fwd[valEnd+1] == '#' {
				break
			}
			valEnd++
		}
		rawVal = trimRight(fwd[valStart:valEnd])
	}

	result := applyTagConversion(tag, rawVal, tagHandles)
	tknTin := jsonic.TinTX
	switch result.(type) {
	case float64:
		tknTin = jsonic.TinNR
	case bool, nil:
		tknTin = jsonic.TinVL
	}
	if result == nil {
		tknTin = jsonic.TinVL
	}

	tkn := lex.Token(tinToName(tknTin), tknTin, result, fwd[:valEnd])
	pnt.SI += valEnd
	pnt.CI += valEnd
	return &jsonic.LexCheckResult{Done: true, Token: tkn}
}

// handlePlainScalar processes YAML plain scalar values with multiline continuation.
func handlePlainScalar(lex *jsonic.Lex, pnt *jsonic.Point, src, fwd string) *jsonic.LexCheckResult {
	// Detect flow context.
	inFlowCtx := false
	depth := 0
	for fi := 0; fi < pnt.SI; fi++ {
		fc := src[fi]
		if fc == '{' || fc == '[' {
			depth++
		} else if fc == '}' || fc == ']' {
			if depth > 0 {
				depth--
			}
		} else if fc == '"' {
			fi++
			for fi < pnt.SI && src[fi] != '"' {
				if src[fi] == '\\' {
					fi++
				}
				fi++
			}
		} else if fc == '\'' {
			fi++
			for fi < pnt.SI && src[fi] != '\'' {
				if fi+1 < pnt.SI && src[fi] == '\'' && src[fi+1] == '\'' {
					fi++
				}
				fi++
			}
		}
	}
	inFlowCtx = depth > 0

	// Find current line indent.
	lineStartPos := pnt.SI
	for lineStartPos > 0 && src[lineStartPos-1] != '\n' && src[lineStartPos-1] != '\r' {
		lineStartPos--
	}
	currentLineIndent := 0
	ci := lineStartPos
	for ci < pnt.SI && src[ci] == ' ' {
		currentLineIndent++
		ci++
	}

	// Check if text is preceded by ": " on the same line.
	isMapValue := false
	ci = pnt.SI - 1
	for ci >= lineStartPos && (src[ci] == ' ' || src[ci] == '\t') {
		ci--
	}
	if ci >= lineStartPos && src[ci] == ':' {
		isMapValue = true
	}

	minContinuationIndent := currentLineIndent
	if isMapValue {
		minContinuationIndent = currentLineIndent + 1
	}

	// Scan first line.
	text := ""
	i := 0
	totalConsumed := 0
	rows := 0

	scanLine := func() string {
		line := ""
		for i < len(fwd) {
			c := fwd[i]
			if c == '\n' || c == '\r' {
				break
			}
			if c == ':' && (i+1 >= len(fwd) || fwd[i+1] == ' ' || fwd[i+1] == '\t' ||
				fwd[i+1] == '\n' || fwd[i+1] == '\r') {
				break
			}
			if (c == ' ' || c == '\t') && i+1 < len(fwd) && fwd[i+1] == '#' {
				break
			}
			if inFlowCtx && (c == ']' || c == '}') {
				break
			}
			if c == ',' && inFlowCtx {
				break
			}
			line += string(c)
			i++
		}
		return trimRight(line)
	}

	text = scanLine()
	totalConsumed = i

	// Check for continuation lines (multiline plain scalars).
	for i < len(fwd) && (fwd[i] == '\n' || fwd[i] == '\r') {
		nlPos := i
		blankLines := 0
		for i < len(fwd) && (fwd[i] == '\n' || fwd[i] == '\r') {
			if fwd[i] == '\r' {
				i++
			}
			if i < len(fwd) && fwd[i] == '\n' {
				i++
			}
			li := 0
			for i+li < len(fwd) && (fwd[i+li] == ' ' || fwd[i+li] == '\t') {
				li++
			}
			if i+li >= len(fwd) || fwd[i+li] == '\n' || fwd[i+li] == '\r' {
				blankLines++
				i += li
				continue
			}
			break
		}
		lineIndent := 0
		for i < len(fwd) && (fwd[i] == ' ' || fwd[i] == '\t') {
			lineIndent++
			i++
		}

		isNextDocMarker := lineIndent == 0 && i < len(fwd) && isDocMarker(fwd, i)
		isSeqMarker := false
		if i < len(fwd) && fwd[i] == '-' && (i+1 >= len(fwd) || fwd[i+1] == ' ' ||
			fwd[i+1] == '\t' || fwd[i+1] == '\n' || fwd[i+1] == '\r') {
			seqIndent := -1
			si := pnt.SI - 1
			for si >= lineStartPos {
				if src[si] == '-' && (si+1 < len(src) && (src[si+1] == ' ' || src[si+1] == '\t')) {
					seqIndent = si - lineStartPos
					break
				}
				si--
			}
			isSeqMarker = (seqIndent >= 0 && lineIndent == seqIndent) ||
				(seqIndent < 0 && lineIndent <= currentLineIndent)
		}

		canContinue := false
		if inFlowCtx {
			canContinue = i < len(fwd) && fwd[i] != '\n' && fwd[i] != '\r' &&
				fwd[i] != '#' && fwd[i] != '{' && fwd[i] != '}' &&
				fwd[i] != '[' && fwd[i] != ']'
		} else {
			canContinue = lineIndent >= minContinuationIndent && i < len(fwd) &&
				fwd[i] != '\n' && fwd[i] != '\r' && fwd[i] != '#' &&
				!isNextDocMarker && !isSeqMarker
		}

		if canContinue {
			// Check if continuation line is a key-value pair.
			isKV := false
			peekJ := i
			for peekJ < len(fwd) && fwd[peekJ] != '\n' && fwd[peekJ] != '\r' {
				if fwd[peekJ] == ':' && (peekJ+1 >= len(fwd) || fwd[peekJ+1] == ' ' ||
					fwd[peekJ+1] == '\t' || fwd[peekJ+1] == '\n' || fwd[peekJ+1] == '\r') {
					isKV = true
					break
				}
				if fwd[peekJ] == '}' || fwd[peekJ] == ']' || fwd[peekJ] == ',' {
					break
				}
				peekJ++
			}
			if !isKV || inFlowCtx {
				contLine := scanLine()
				if len(contLine) > 0 {
					if blankLines > 0 {
						for b := 0; b < blankLines; b++ {
							text += "\n"
						}
					} else {
						text += " "
					}
					text += contLine
					totalConsumed = i
					rows++
					continue
				}
			}
		}
		i = nlPos
		break
	}

	text = trimRight(text)
	if len(text) == 0 {
		return nil
	}

	// Check if this is a YAML value keyword.
	if val, ok := isYamlValue(text); ok {
		tkn := lex.Token("#VL", jsonic.TinVL, val, text)
		pnt.SI += len(text)
		pnt.CI += len(text)
		return &jsonic.LexCheckResult{Done: true, Token: tkn}
	}

	// Check if it's a number.
	if num, ok := parseYamlNumber(text); ok {
		tkn := lex.Token("#NR", jsonic.TinNR, num, text)
		pnt.SI += len(text)
		pnt.CI += len(text)
		return &jsonic.LexCheckResult{Done: true, Token: tkn}
	}

	// Plain text.
	tkn := lex.Token("#TX", jsonic.TinTX, text, fwd[:totalConsumed])
	pnt.SI += totalConsumed
	pnt.RI += rows
	pnt.CI += totalConsumed
	return &jsonic.LexCheckResult{Done: true, Token: tkn}
}

// handleTypeTag processes !!type tags (!!str, !!int, !!float, etc.).
func handleTypeTag(lex *jsonic.Lex, pnt *jsonic.Point, fwd string,
	tagHandles map[string]string, pendingAnchors *[]anchorInfo,
	anchors map[string]any, TX, NR, VL, ST jsonic.Tin) *jsonic.Token {

	tagEnd := 2
	for tagEnd < len(fwd) && fwd[tagEnd] != ' ' && fwd[tagEnd] != '\n' &&
		fwd[tagEnd] != '\r' && fwd[tagEnd] != ',' &&
		fwd[tagEnd] != '}' && fwd[tagEnd] != ']' && fwd[tagEnd] != ':' {
		tagEnd++
	}
	tag := fwd[2:tagEnd]
	valStart := tagEnd
	if valStart < len(fwd) && fwd[valStart] == ' ' {
		valStart++
	}
	valEnd := valStart

	// Skip anchor before value.
	tagAnchorName := ""
	if valStart < len(fwd) && fwd[valStart] == '&' {
		anchorEnd := valStart + 1
		for anchorEnd < len(fwd) && fwd[anchorEnd] != ' ' && fwd[anchorEnd] != '\n' && fwd[anchorEnd] != '\r' {
			anchorEnd++
		}
		tagAnchorName = fwd[valStart+1 : anchorEnd]
		*pendingAnchors = append(*pendingAnchors, anchorInfo{name: tagAnchorName, inline: true})
		if anchorEnd < len(fwd) && fwd[anchorEnd] == ' ' {
			anchorEnd++
		}
		valStart = anchorEnd
		valEnd = valStart
	}

	// Check for quoted value.
	if valStart < len(fwd) && (fwd[valStart] == '"' || fwd[valStart] == '\'') {
		q := fwd[valStart]
		valEnd = valStart + 1
		for valEnd < len(fwd) && fwd[valEnd] != q {
			if fwd[valEnd] == '\\' && q == '"' {
				valEnd++
			}
			valEnd++
		}
		if valEnd < len(fwd) && fwd[valEnd] == q {
			valEnd++
		}
		rawVal := fwd[valStart+1 : valEnd-1]
		result := applyTagConversion(tag, rawVal, tagHandles)
		if tagAnchorName != "" {
			anchors[tagAnchorName] = result
		}
		tknTin := TX
		switch result.(type) {
		case float64:
			tknTin = NR
		case bool:
			tknTin = VL
		}
		if result == nil {
			tknTin = VL
		}
		tkn := lex.Token(tinToName(tknTin), tknTin, result, fwd[:valEnd])
		pnt.SI += valEnd
		pnt.CI += valEnd
		return tkn
	}

	// Tag followed by newline — skip and let next cycle handle.
	if valStart < len(fwd) && (fwd[valStart] == '\n' || fwd[valStart] == '\r') && valStart < len(fwd)-1 {
		nl := valStart
		if nl < len(fwd) && fwd[nl] == '\r' {
			nl++
		}
		if nl < len(fwd) && fwd[nl] == '\n' {
			nl++
		}
		pnt.SI += nl
		pnt.CI = 0
		pnt.RI++
		return nil // Will re-enter matcher
	}

	// Unquoted value.
	for valEnd < len(fwd) && fwd[valEnd] != '\n' && fwd[valEnd] != '\r' &&
		fwd[valEnd] != ',' && fwd[valEnd] != '}' && fwd[valEnd] != ']' {
		if fwd[valEnd] == ':' && (valEnd+1 >= len(fwd) || fwd[valEnd+1] == ' ' ||
			fwd[valEnd+1] == '\n' || fwd[valEnd+1] == '\r') {
			break
		}
		if fwd[valEnd] == ' ' && valEnd+1 < len(fwd) && fwd[valEnd+1] == '#' {
			break
		}
		valEnd++
	}
	rawVal := trimRight(fwd[valStart:valEnd])
	result := applyTagConversion(tag, rawVal, tagHandles)
	if tagAnchorName != "" {
		anchors[tagAnchorName] = result
	}
	tknTin := TX
	switch result.(type) {
	case string:
		if result.(string) == "" {
			tknTin = ST
		} else {
			tknTin = TX
		}
	case float64:
		tknTin = NR
	case bool:
		tknTin = VL
	}
	if result == nil {
		tknTin = VL
	}
	tkn := lex.Token(tinToName(tknTin), tknTin, result, fwd[:valEnd])
	pnt.SI += valEnd
	pnt.CI += valEnd
	return tkn
}

// handleExplicitKey processes ? key\n: value patterns.
func handleExplicitKey(lex *jsonic.Lex, pnt *jsonic.Point, fwd string,
	pendingExplicitCL *bool, pendingTokens *[]*jsonic.Token,
	TX, CL, VL jsonic.Tin) *jsonic.Token {

	start := 1
	if len(fwd) > 1 && (fwd[1] == ' ' || fwd[1] == '\t') {
		start = 2
	}

	// Collect key text.
	keyEnd := start
	for keyEnd < len(fwd) && fwd[keyEnd] != '\n' && fwd[keyEnd] != '\r' {
		if fwd[keyEnd] == ' ' && keyEnd+1 < len(fwd) && fwd[keyEnd+1] == '#' {
			break
		}
		keyEnd++
	}
	key := trimRight(fwd[start:keyEnd])
	consumed := keyEnd

	// Skip comment at end of key line.
	for consumed < len(fwd) && fwd[consumed] != '\n' && fwd[consumed] != '\r' {
		consumed++
	}
	beforeNewline := consumed

	// Consume newline.
	if consumed < len(fwd) && fwd[consumed] == '\r' {
		consumed++
	}
	if consumed < len(fwd) && fwd[consumed] == '\n' {
		consumed++
	}

	// Check for continuation lines.
	qIndent := 0
	li := pnt.SI
	for li > 0 && lex.Src[li-1] != '\n' && lex.Src[li-1] != '\r' {
		li--
	}
	for li < pnt.SI && lex.Src[li] == ' ' {
		qIndent++
		li++
	}

	// Scan continuation lines (plain scalar multiline key).
	for consumed < len(fwd) {
		lineIndent := 0
		for consumed+lineIndent < len(fwd) && fwd[consumed+lineIndent] == ' ' {
			lineIndent++
		}
		afterSpaces := consumed + lineIndent
		if afterSpaces < len(fwd) && fwd[afterSpaces] == '#' {
			for afterSpaces < len(fwd) && fwd[afterSpaces] != '\n' && fwd[afterSpaces] != '\r' {
				afterSpaces++
			}
			beforeNewline = afterSpaces
			if afterSpaces < len(fwd) && fwd[afterSpaces] == '\r' {
				afterSpaces++
			}
			if afterSpaces < len(fwd) && fwd[afterSpaces] == '\n' {
				afterSpaces++
			}
			consumed = afterSpaces
			continue
		}
		if lineIndent > qIndent && afterSpaces < len(fwd) &&
			fwd[afterSpaces] != ':' && fwd[afterSpaces] != '?' && fwd[afterSpaces] != '-' {
			contEnd := afterSpaces
			for contEnd < len(fwd) && fwd[contEnd] != '\n' && fwd[contEnd] != '\r' {
				if fwd[contEnd] == ' ' && contEnd+1 < len(fwd) && fwd[contEnd+1] == '#' {
					break
				}
				contEnd++
			}
			contText := trimRight(fwd[afterSpaces:contEnd])
			if len(contText) > 0 {
				key += " " + contText
			}
			consumed = contEnd
			beforeNewline = consumed
			if consumed < len(fwd) && fwd[consumed] == '\r' {
				consumed++
			}
			if consumed < len(fwd) && fwd[consumed] == '\n' {
				consumed++
			}
			continue
		}
		break
	}

	// Check if next line starts with ":".
	hasValue := false
	valConsumed := consumed
	ci := consumed
	for ci < len(fwd) && fwd[ci] == ' ' {
		ci++
	}
	if ci < len(fwd) && fwd[ci] == ':' &&
		(ci+1 >= len(fwd) || fwd[ci+1] == ' ' || fwd[ci+1] == '\t' ||
			fwd[ci+1] == '\n' || fwd[ci+1] == '\r') {
		hasValue = true
		valConsumed = ci + 1
		if valConsumed < len(fwd) && (fwd[valConsumed] == ' ' || fwd[valConsumed] == '\t') {
			valConsumed++
		}
	}

	if hasValue {
		pnt.SI += valConsumed
		pnt.RI++
		pnt.CI = valConsumed - consumed + 1
		*pendingExplicitCL = true
	} else {
		pnt.SI += beforeNewline
		pnt.CI += beforeNewline
		clTkn := lex.Token("#CL", CL, 1, ": ")
		vlTkn := lex.Token("#VL", VL, nil, "")
		*pendingTokens = append(*pendingTokens, clTkn, vlTkn)
	}

	tkn := lex.Token("#TX", TX, key, fwd[:keyEnd])
	return tkn
}

// handleDocMarker processes --- and ... document markers.
func handleDocMarker(lex *jsonic.Lex, pnt *jsonic.Point, fwd string,
	IN jsonic.Tin, pendingAnchors *[]anchorInfo, anchors map[string]any,
	TX jsonic.Tin) *jsonic.Token {

	pos := 3
	for pos < len(fwd) && fwd[pos] != '\n' && fwd[pos] != '\r' {
		pos++
	}

	if fwd[0] == '.' {
		// ... terminates document.
		pnt.SI += pos
		pnt.CI += pos
		for pnt.SI < pnt.Len && (lex.Src[pnt.SI] == '\n' || lex.Src[pnt.SI] == '\r') {
			if lex.Src[pnt.SI] == '\r' {
				pnt.SI++
			}
			if pnt.SI < pnt.Len && lex.Src[pnt.SI] == '\n' {
				pnt.SI++
			}
			pnt.RI++
		}
		return lex.Token("#ZZ", jsonic.TinZZ, jsonic.Undefined, "")
	}

	// --- handler.
	afterDash := 3
	for afterDash < len(fwd) && fwd[afterDash] == ' ' {
		afterDash++
	}
	dashNextCh := byte(0)
	if afterDash < len(fwd) {
		dashNextCh = fwd[afterDash]
	}
	hasInlineValue := dashNextCh != 0 && dashNextCh != '\n' && dashNextCh != '\r' &&
		dashNextCh != '&' && dashNextCh != '!' && dashNextCh != '#'

	if hasInlineValue {
		pnt.SI += afterDash
		pnt.CI = afterDash
		return nil // Fall through to continue matching.
	}

	// Plain --- with nothing after it.
	pnt.SI += pos
	pnt.RI++
	if pnt.SI < pnt.Len && lex.Src[pnt.SI] == '\r' {
		pnt.SI++
	}
	if pnt.SI < pnt.Len && lex.Src[pnt.SI] == '\n' {
		pnt.SI++
	}
	spaces := 0
	for pnt.SI+spaces < pnt.Len && lex.Src[pnt.SI+spaces] == ' ' {
		spaces++
	}
	pnt.SI += spaces
	pnt.CI = spaces

	if pnt.SI >= pnt.Len {
		return lex.Token("#ZZ", jsonic.TinZZ, jsonic.Undefined, "")
	}

	nextCh := lex.Src[pnt.SI]
	if nextCh == '{' || nextCh == '[' || nextCh == '"' || nextCh == '\'' {
		return nil // Fall through.
	}
	if spaces == 0 && nextCh != '-' && nextCh != '.' && nextCh != '?' &&
		nextCh != '\n' && nextCh != '\r' {
		return nil // Fall through.
	}

	// Emit #IN with indent level.
	return lex.Token("#IN", IN, spaces, fwd[:pos+1+spaces])
}

// handleDoubleQuotedString processes YAML double-quoted strings.
func handleDoubleQuotedString(lex *jsonic.Lex, pnt *jsonic.Point, fwd string, ST jsonic.Tin) *jsonic.Token {
	i := 1
	val := ""
	escapedUpTo := 0

	for i < len(fwd) && fwd[i] != '"' {
		if fwd[i] == '\\' {
			i++
			if i >= len(fwd) {
				break
			}
			esc := fwd[i]
			switch esc {
			case 'n':
				val += "\n"
				i++
				escapedUpTo = len(val)
			case 't':
				val += "\t"
				i++
				escapedUpTo = len(val)
			case 'r':
				val += "\r"
				i++
				escapedUpTo = len(val)
			case '"':
				val += "\""
				i++
				escapedUpTo = len(val)
			case '\\':
				val += "\\"
				i++
				escapedUpTo = len(val)
			case '/':
				val += "/"
				i++
				escapedUpTo = len(val)
			case 'b':
				val += "\b"
				i++
				escapedUpTo = len(val)
			case 'f':
				val += "\f"
				i++
				escapedUpTo = len(val)
			case 'a':
				val += "\x07"
				i++
				escapedUpTo = len(val)
			case 'e':
				val += "\x1b"
				i++
				escapedUpTo = len(val)
			case 'v':
				val += "\v"
				i++
				escapedUpTo = len(val)
			case '0':
				val += "\x00"
				i++
				escapedUpTo = len(val)
			case ' ':
				val += " "
				i++
				escapedUpTo = len(val)
			case '_':
				val += "\u00a0"
				i++
				escapedUpTo = len(val)
			case 'N':
				val += "\u0085"
				i++
				escapedUpTo = len(val)
			case 'L':
				val += "\u2028"
				i++
				escapedUpTo = len(val)
			case 'P':
				val += "\u2029"
				i++
				escapedUpTo = len(val)
			case 'x':
				if i+3 <= len(fwd) {
					n, err := strconv.ParseInt(fwd[i+1:i+3], 16, 32)
					if err == nil {
						val += string(rune(n))
						i += 3
						escapedUpTo = len(val)
					} else {
						val += string(esc)
						i++
					}
				} else {
					val += string(esc)
					i++
				}
			case 'u':
				if i+5 <= len(fwd) {
					n, err := strconv.ParseInt(fwd[i+1:i+5], 16, 32)
					if err == nil {
						val += string(rune(n))
						i += 5
						escapedUpTo = len(val)
					} else {
						val += string(esc)
						i++
					}
				} else {
					val += string(esc)
					i++
				}
			case 'U':
				if i+9 <= len(fwd) {
					n, err := strconv.ParseInt(fwd[i+1:i+9], 16, 32)
					if err == nil {
						val += string(rune(n))
						i += 9
						escapedUpTo = len(val)
					} else {
						val += string(esc)
						i++
					}
				} else {
					val += string(esc)
					i++
				}
			case '\n', '\r':
				// Escaped newline: line continuation.
				if esc == '\r' && i+1 < len(fwd) && fwd[i+1] == '\n' {
					i++
				}
				i++
				for i < len(fwd) && (fwd[i] == ' ' || fwd[i] == '\t') {
					i++
				}
			default:
				val += string(esc)
				i++
			}
		} else if fwd[i] == '\n' || fwd[i] == '\r' {
			// Flow scalar line folding.
			trimTo := len(val)
			for trimTo > escapedUpTo && (val[trimTo-1] == ' ' || val[trimTo-1] == '\t') {
				trimTo--
			}
			val = val[:trimTo]
			emptyLines := 0
			for i < len(fwd) && (fwd[i] == '\n' || fwd[i] == '\r') {
				if fwd[i] == '\r' {
					i++
				}
				if i < len(fwd) && fwd[i] == '\n' {
					i++
				}
				emptyLines++
				for i < len(fwd) && (fwd[i] == ' ' || fwd[i] == '\t') {
					i++
				}
			}
			if emptyLines > 1 {
				for e := 1; e < emptyLines; e++ {
					val += "\n"
				}
			} else {
				val += " "
			}
		} else {
			val += string(fwd[i])
			i++
		}
	}
	if i < len(fwd) && fwd[i] == '"' {
		i++
	}
	tkn := lex.Token("#ST", ST, val, fwd[:i])
	pnt.SI += i
	pnt.CI += i
	return tkn
}

// handleSingleQuotedString processes YAML single-quoted strings.
func handleSingleQuotedString(lex *jsonic.Lex, pnt *jsonic.Point, fwd string, ST jsonic.Tin) *jsonic.Token {
	i := 1
	val := ""
	for i < len(fwd) {
		if fwd[i] == '\'' {
			if i+1 < len(fwd) && fwd[i+1] == '\'' {
				val += "'"
				i += 2
			} else {
				i++
				break
			}
		} else if fwd[i] == '\n' || fwd[i] == '\r' {
			// Flow scalar line folding.
			val = strings.TrimRight(val, " \t")
			emptyLines := 0
			for i < len(fwd) && (fwd[i] == '\n' || fwd[i] == '\r') {
				if fwd[i] == '\r' {
					i++
				}
				if i < len(fwd) && fwd[i] == '\n' {
					i++
				}
				emptyLines++
				for i < len(fwd) && (fwd[i] == ' ' || fwd[i] == '\t') {
					i++
				}
			}
			if emptyLines > 1 {
				for e := 1; e < emptyLines; e++ {
					val += "\n"
				}
			} else {
				val += " "
			}
		} else {
			val += string(fwd[i])
			i++
		}
	}
	tkn := lex.Token("#ST", ST, val, fwd[:i])
	pnt.SI += i
	pnt.CI += i
	return tkn
}

// handleNumericColon handles plain scalars starting with digits that contain
// colons (e.g. 20:03:20) or trailing text after a space (e.g. "64 characters, hexadecimal.").
// The skipNumberMatch parameter is set to true when trailing text is detected,
// so the NumberCheck callback can skip the number matcher and let TextCheck handle it.
func handleNumericColon(lex *jsonic.Lex, pnt *jsonic.Point, fwd string, TX jsonic.Tin, skipNumberMatch *bool) *jsonic.Token {
	hasEmbeddedColon := false
	hasTrailingText := false
	pi := 1
	for pi < len(fwd) && fwd[pi] != '\n' && fwd[pi] != '\r' {
		if fwd[pi] == ':' && pi+1 < len(fwd) && fwd[pi+1] != ' ' && fwd[pi+1] != '\t' &&
			fwd[pi+1] != '\n' && fwd[pi+1] != '\r' {
			hasEmbeddedColon = true
			break
		}
		if fwd[pi] == ' ' || fwd[pi] == '\t' {
			// Check if after the space there are non-separator characters,
			// meaning this is a plain scalar like "64 characters, hexadecimal."
			si := pi
			for si < len(fwd) && (fwd[si] == ' ' || fwd[si] == '\t') {
				si++
			}
			if si < len(fwd) && fwd[si] != '\n' && fwd[si] != '\r' &&
				fwd[si] != '#' && fwd[si] != ':' {
				hasTrailingText = true
			}
			break
		}
		pi++
	}
	if hasTrailingText {
		// Check if we're in a flow context — if so, the number is standalone.
		inFlow := false
		src := lex.Src
		flowDepth := 0
		for fi := 0; fi < pnt.SI; fi++ {
			c := src[fi]
			if c == '{' || c == '[' {
				flowDepth++
			} else if c == '}' || c == ']' {
				if flowDepth > 0 {
					flowDepth--
				}
			} else if c == '"' {
				fi++
				for fi < pnt.SI && src[fi] != '"' {
					if src[fi] == '\\' {
						fi++
					}
					fi++
				}
			} else if c == '\'' {
				fi++
				for fi < pnt.SI && src[fi] != '\'' {
					if fi+1 < pnt.SI && src[fi] == '\'' && src[fi+1] == '\'' {
						fi++
					}
					fi++
				}
			}
		}
		inFlow = flowDepth > 0
		if !inFlow {
			*skipNumberMatch = true
			return nil
		}
	}
	if !hasEmbeddedColon {
		return nil
	}
	end := 0
	for end < len(fwd) && fwd[end] != ' ' && fwd[end] != '\t' &&
		fwd[end] != '\n' && fwd[end] != '\r' {
		end++
	}
	text := fwd[:end]
	tkn := lex.Token("#TX", TX, text, text)
	pnt.SI += end
	pnt.CI += end
	return tkn
}

// applyTagConversion applies !!type tag conversion to a raw value.
func applyTagConversion(tag, rawVal string, tagHandles map[string]string) any {
	if _, ok := tagHandles["!!"]; ok {
		return rawVal // Custom tag handle — don't apply built-in conversion.
	}
	switch tag {
	case "str":
		return rawVal
	case "int":
		n, err := strconv.ParseInt(rawVal, 10, 64)
		if err == nil {
			return float64(n)
		}
		return rawVal
	case "float":
		n, err := strconv.ParseFloat(rawVal, 64)
		if err == nil {
			return n
		}
		return rawVal
	case "bool":
		return rawVal == "true" || rawVal == "True" || rawVal == "TRUE"
	case "null":
		return nil
	default:
		return rawVal
	}
}

// tinToName converts a Tin to its name string.
func tinToName(tin jsonic.Tin) string {
	switch tin {
	case jsonic.TinTX:
		return "#TX"
	case jsonic.TinNR:
		return "#NR"
	case jsonic.TinST:
		return "#ST"
	case jsonic.TinVL:
		return "#VL"
	case jsonic.TinOB:
		return "#OB"
	case jsonic.TinCB:
		return "#CB"
	case jsonic.TinOS:
		return "#OS"
	case jsonic.TinCS:
		return "#CS"
	case jsonic.TinCL:
		return "#CL"
	case jsonic.TinCA:
		return "#CA"
	case jsonic.TinZZ:
		return "#ZZ"
	default:
		return "#UK"
	}
}
