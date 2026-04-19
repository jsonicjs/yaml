package yaml

import (
	"fmt"

	jsonic "github.com/jsonicjs/jsonic/go"
)

// --- BEGIN EMBEDDED yaml-grammar.jsonic ---
const grammarText = `
# YAML Grammar Definition
# Parsed by a standard Jsonic instance and passed to jsonic.grammar()
# Function references (@ prefixed) are resolved against the refs map.
# State handlers (bo/ao/bc/ac) remain wired in code, since they use
# closures over per-parse state (anchors, pendingAnchors, etc.).

{
  # Amend val rule: YAML indent/element-marker handling.
  rule: val: open: {
    alts: [
      # Indent followed by content: push indent rule.
      { s: '#IN' c: '@val-indent-deeper' p: indent a: '@val-set-in-from-o0' g: yaml }
      # Same indent followed by element marker: list value at map level.
      { s: ['#IN' '#EL'] c: '@val-indent-eq-parent' p: yamlBlockList a: '@val-set-in-from-o0' g: yaml }
      # End of input means empty value.
      { s: '#ZZ' b: 1 a: '@val-set-null' g: yaml }
      # Same or lesser indent after a colon means empty value — backtrack.
      { s: '#IN' b: 1 u: { yamlEmpty: true } g: yaml }
      # This value is a list.
      { s: '#EL' p: yamlBlockList a: '@val-set-el-in' g: yaml }
    ]
    inject: { append: false }
  }
  rule: val: close: {
    alts: [
      { s: '#IN' b: 1 g: yaml }
    ]
    inject: { append: false }
  }

  # Indent rule: start for block content at a given indent.
  rule: indent: open: [
    # Key pair => map.
    { s: ['#KEY' '#CL'] p: map b: 2 g: yaml }
    # Element marker => list.
    { s: '#EL' p: list g: yaml }
    # Plain value after indent (for nested scalars).
    { s: '#KEY' a: '@indent-plain-value' g: yaml }
  ]

  # YAML block list: handles "- " sequences without consuming "[".
  rule: yamlBlockList: open: [
    # Element value is a key-value map: - key: val
    { s: ['#KEY' '#CL'] p: yamlElemMap b: 2 a: '@set-map-in' g: yaml }
    # Default: push to val for the element's value.
    { p: val g: yaml }
  ]
  rule: yamlBlockList: close: [
    # Indent followed by element marker: next element at same level.
    { s: ['#IN' '#EL'] c: '@t0-eq-in' r: yamlBlockElem g: yaml }
    # Same or lesser indent: close list.
    { s: '#IN' c: '@t0-le-in' b: 1 g: yaml }
    # Element marker at top level (no preceding newline).
    { s: '#EL' r: yamlBlockElem g: yaml }
    { s: '#ZZ' b: 1 g: yaml }
  ]

  # Subsequent elements in a yamlBlockList (via rotation).
  rule: yamlBlockElem: open: [
    { s: ['#KEY' '#CL'] p: yamlElemMap b: 2 a: '@set-map-in' g: yaml }
    { p: val g: yaml }
  ]
  rule: yamlBlockElem: close: [
    { s: ['#IN' '#EL'] c: '@t0-eq-in' r: yamlBlockElem g: yaml }
    { s: '#IN' c: '@t0-le-in' b: 1 g: yaml }
    { s: '#EL' r: yamlBlockElem g: yaml }
    { s: '#ZZ' b: 1 g: yaml }
  ]

  # Amend list rule: close on dedent or same-indent non-element.
  rule: list: close: {
    alts: [
      { s: '#IN' c: '@t0-le-in' b: 1 g: yaml }
    ]
    inject: { append: false }
  }

  # Amend map rule: same-indent indent continues map with pair.
  rule: map: open: {
    alts: [
      { s: '#IN' c: '@o0-eq-in' r: pair g: yaml }
    ]
    inject: { append: false }
  }
  rule: map: close: {
    alts: [
      { s: '#IN' c: '@t0-lt-in' b: 1 g: yaml }
    ]
    inject: { append: false }
  }

  # Amend pair rule: end of input ends pair; dedent closes, same-indent repeats.
  rule: pair: open: {
    alts: [
      { s: '#ZZ' b: 1 g: yaml }
    ]
    inject: { append: false }
  }
  rule: pair: close: {
    alts: [
      { s: '#IN' c: '@t0-eq-in' r: pair g: yaml }
      { s: '#IN' c: '@t0-lt-in' b: 1 g: yaml }
    ]
    inject: { append: false }
  }

  # yamlElemMap: "- key: val" patterns.
  rule: yamlElemMap: open: [
    { s: ['#KEY' '#CL'] p: val a: '@elem-key' g: yaml }
  ]
  rule: yamlElemMap: close: [
    { s: '#IN' c: '@t0-eq-map-in' r: yamlElemPair g: yaml }
    { s: '#IN' b: 1 g: yaml }
    { s: '#CA' b: 1 g: yaml }
    { s: '#CS' b: 1 g: yaml }
    { s: '#CB' b: 1 g: yaml }
    { s: '#ZZ' g: yaml }
  ]

  # Additional pairs in a yamlElemMap.
  rule: yamlElemPair: open: [
    { s: ['#KEY' '#CL'] p: val a: '@elem-key' g: yaml }
  ]
  rule: yamlElemPair: close: [
    { s: '#IN' c: '@t0-eq-map-in' r: yamlElemPair g: yaml }
    { s: '#IN' b: 1 g: yaml }
    { s: '#CA' b: 1 g: yaml }
    { s: '#CS' b: 1 g: yaml }
    { s: '#CB' b: 1 g: yaml }
    { s: '#ZZ' g: yaml }
  ]

  # Amend elem rule for YAML sequences ("- key: val" at top level of [ ... ]).
  rule: elem: open: {
    alts: [
      { s: ['#KEY' '#CL'] p: yamlElemMap b: 2 a: '@set-map-in' g: yaml }
    ]
    inject: { append: false }
  }
  rule: elem: close: {
    alts: [
      { s: ['#IN' '#EL'] c: '@t0-eq-in' r: elem g: yaml }
      { s: '#IN' c: '@t0-eq-in' b: 1 g: yaml }
      { s: '#IN' c: '@t0-lt-in' b: 1 g: yaml }
      { s: '#EL' r: elem g: yaml }
    ]
    inject: { append: false }
  }
}
`
// --- END EMBEDDED yaml-grammar.jsonic ---

// configureGrammarRules installs the YAML grammar (alts from the declarative
// yaml-grammar.jsonic file) and wires state handlers (bo/ao/bc/ac) that need
// closure access to per-parse state.
func configureGrammarRules(j *jsonic.Jsonic, IN, EL jsonic.Tin, KEY []jsonic.Tin,
	CL, ZZ, CA, CS, CB, TX, ST, VL, NR jsonic.Tin,
	anchors map[string]any, pendingAnchors *[]anchorInfo) {

	_ = IN
	_ = EL
	_ = KEY
	_ = CL
	_ = ZZ
	_ = CA
	_ = CS
	_ = CB
	_ = NR
	_ = VL

	// Function refs used by the declarative grammar.
	refs := map[jsonic.FuncRef]any{
		"@val-indent-deeper": jsonic.AltCond(func(r *jsonic.Rule, ctx *jsonic.Context) bool {
			parentIn, hasParentIn := r.K["yamlIn"]
			listIn, hasListIn := r.K["yamlListIn"]
			if hasListIn && listIn != nil {
				if listInVal, ok := toInt(listIn); ok {
					if t0Val, ok := toInt(ctx.T0.Val); ok {
						if t0Val <= listInVal {
							return false
						}
					}
				}
			}
			if !hasParentIn || parentIn == nil {
				return true
			}
			if parentInVal, ok := toInt(parentIn); ok {
				if t0Val, ok := toInt(ctx.T0.Val); ok {
					return t0Val > parentInVal
				}
			}
			return true
		}),
		"@val-indent-eq-parent": jsonic.AltCond(func(r *jsonic.Rule, ctx *jsonic.Context) bool {
			parentIn, hasParentIn := r.K["yamlIn"]
			if !hasParentIn || parentIn == nil {
				return false
			}
			if parentInVal, ok := toInt(parentIn); ok {
				if t0Val, ok := toInt(ctx.T0.Val); ok {
					return t0Val == parentInVal
				}
			}
			return false
		}),
		"@val-set-in-from-o0": jsonic.AltAction(func(r *jsonic.Rule, ctx *jsonic.Context) {
			if v, ok := toInt(r.O0.Val); ok {
				r.N["in"] = v
			}
		}),
		"@val-set-null": jsonic.AltAction(func(r *jsonic.Rule, ctx *jsonic.Context) {
			r.Node = nil
		}),
		"@val-set-el-in": jsonic.AltAction(func(r *jsonic.Rule, ctx *jsonic.Context) {
			r.N["in"] = r.O0.CI - 1
		}),
		"@indent-plain-value": jsonic.AltAction(func(r *jsonic.Rule, ctx *jsonic.Context) {
			if r.O0.Tin == ST || r.O0.Tin == TX {
				r.Node = r.O0.Val
			} else {
				r.Node = r.O0.Src
			}
		}),
		"@set-map-in": jsonic.AltAction(func(r *jsonic.Rule, ctx *jsonic.Context) {
			r.K["yamlMapIn"] = r.N["in"] + 2
		}),
		"@t0-eq-in": jsonic.AltCond(func(r *jsonic.Rule, ctx *jsonic.Context) bool {
			if v, ok := toInt(ctx.T0.Val); ok {
				return v == r.N["in"]
			}
			return false
		}),
		"@t0-le-in": jsonic.AltCond(func(r *jsonic.Rule, ctx *jsonic.Context) bool {
			if v, ok := toInt(ctx.T0.Val); ok {
				return v <= r.N["in"]
			}
			return false
		}),
		"@t0-lt-in": jsonic.AltCond(func(r *jsonic.Rule, ctx *jsonic.Context) bool {
			if v, ok := toInt(ctx.T0.Val); ok {
				return v < r.N["in"]
			}
			return false
		}),
		"@o0-eq-in": jsonic.AltCond(func(r *jsonic.Rule, ctx *jsonic.Context) bool {
			if v, ok := toInt(r.O0.Val); ok {
				return v == r.N["in"]
			}
			return false
		}),
		"@t0-eq-map-in": jsonic.AltCond(func(r *jsonic.Rule, ctx *jsonic.Context) bool {
			if v, ok := toInt(ctx.T0.Val); ok {
				if mapIn, ok := toInt(r.K["yamlMapIn"]); ok {
					return v == mapIn
				}
			}
			return false
		}),
		"@elem-key": jsonic.AltAction(func(r *jsonic.Rule, ctx *jsonic.Context) {
			r.U["key"] = extractKey(r.O0, anchors)
		}),
	}

	// Parse the embedded grammar text and build a GrammarSpec.
	parser := jsonic.Make()
	parsed, err := parser.Parse(grammarText)
	if err != nil {
		panic(fmt.Sprintf("yaml: failed to parse grammar text: %v", err))
	}
	parsedMap, ok := parsed.(map[string]any)
	if !ok {
		panic(fmt.Sprintf("yaml: grammar text did not parse to a map: %T", parsed))
	}
	gs := &jsonic.GrammarSpec{Ref: refs}
	if ruleMap, ok := parsedMap["rule"].(map[string]any); ok {
		gs.Rule = mapToGrammarRules(ruleMap)
	}
	if err := j.Grammar(gs); err != nil {
		panic(fmt.Sprintf("yaml: failed to apply grammar: %v", err))
	}

	// ===== State handlers (bo/ao/bc/ac) — kept in code for closure capture =====

	// val rule: claim pending anchors (ao), handle empty (bc), resolve
	// aliases and record anchors (ac), follow replacement chain (bc).
	j.Rule("val", func(rs *jsonic.RuleSpec) {
		rs.AddAO(func(r *jsonic.Rule, ctx *jsonic.Context) {
			if len(*pendingAnchors) > 0 {
				anchorsCopy := make([]anchorInfo, len(*pendingAnchors))
				copy(anchorsCopy, *pendingAnchors)
				r.U["yamlAnchors"] = anchorsCopy
				r.U["yamlAnchorOpenNode"] = r.Node
				*pendingAnchors = (*pendingAnchors)[:0]
			}
		})
		rs.AddBC(func(r *jsonic.Rule, ctx *jsonic.Context) {
			child := r.Child
			if child != nil && child != jsonic.NoRule {
				final := child
				for final.Next != nil && final.Next != jsonic.NoRule &&
					final.Next.Prev == final {
					final = final.Next
				}
				if final != child && !jsonic.IsUndefined(final.Node) {
					r.Node = final.Node
				}
			}
		})
		rs.AddBC(func(r *jsonic.Rule, ctx *jsonic.Context) {
			if _, ok := r.U["yamlEmpty"]; ok {
				r.Node = jsonic.Undefined
			}
		})
		rs.AddAC(func(r *jsonic.Rule, ctx *jsonic.Context) {
			if m, ok := r.Node.(map[string]any); ok {
				if alias, ok := m["__yamlAlias"].(string); ok {
					val, exists := anchors[alias]
					if exists {
						switch v := val.(type) {
						case map[string]any, []any:
							r.Node = deepCopy(v)
						default:
							r.Node = val
						}
					}
				}
			}
			if anchorList, ok := r.U["yamlAnchors"]; ok {
				anchorsSlice, ok := anchorList.([]anchorInfo)
				if ok {
					for _, anchor := range anchorsSlice {
						if anchor.inline {
							openNode := r.U["yamlAnchorOpenNode"]
							if openNode != nil {
								switch openNode.(type) {
								case map[string]any, []any:
									continue
								}
							}
						}
						val := r.Node
						switch v := val.(type) {
						case map[string]any, []any:
							val = deepCopy(v)
						}
						anchors[anchor.name] = val
					}
				}
			}
		})
	})

	j.Rule("indent", func(rs *jsonic.RuleSpec) {
		rs.AddBC(func(r *jsonic.Rule, ctx *jsonic.Context) {
			if !jsonic.IsUndefined(r.Child.Node) {
				r.Node = r.Child.Node
			}
		})
	})

	j.Rule("yamlBlockList", func(rs *jsonic.RuleSpec) {
		rs.AddBO(func(r *jsonic.Rule, ctx *jsonic.Context) {
			r.Node = make([]any, 0)
			r.K["yamlBlockArr"] = r.Node
			r.K["yamlListIn"] = r.N["in"]
		})
		rs.AddBC(func(r *jsonic.Rule, ctx *jsonic.Context) {
			val := r.Child.Node
			if jsonic.IsUndefined(val) {
				val = nil
			}
			if arr, ok := r.K["yamlBlockArr"].([]any); ok {
				arr = append(arr, val)
				r.K["yamlBlockArr"] = arr
				r.Node = arr
			}
		})
	})

	j.Rule("yamlBlockElem", func(rs *jsonic.RuleSpec) {
		rs.AddBO(func(r *jsonic.Rule, ctx *jsonic.Context) {
			r.Node = r.K["yamlBlockArr"]
		})
		rs.AddBC(func(r *jsonic.Rule, ctx *jsonic.Context) {
			val := r.Child.Node
			if jsonic.IsUndefined(val) {
				val = nil
			}
			if arr, ok := r.K["yamlBlockArr"].([]any); ok {
				arr = append(arr, val)
				r.K["yamlBlockArr"] = arr
				r.Node = arr
			}
		})
	})

	j.Rule("list", func(rs *jsonic.RuleSpec) {
		rs.AddBO(func(r *jsonic.Rule, ctx *jsonic.Context) {
			r.K["yamlListIn"] = r.N["in"]
		})
	})

	j.Rule("map", func(rs *jsonic.RuleSpec) {
		rs.AddBO(func(r *jsonic.Rule, ctx *jsonic.Context) {
			if _, ok := r.N["in"]; !ok {
				r.N["in"] = 0
			}
			r.K["yamlIn"] = r.N["in"]
		})
		rs.AddAC(func(r *jsonic.Rule, ctx *jsonic.Context) {
			m, ok := r.Node.(map[string]any)
			if !ok {
				return
			}
			mergeVal, hasMerge := m["<<"]
			if !hasMerge {
				return
			}
			delete(m, "<<")
			switch mv := mergeVal.(type) {
			case []any:
				for _, item := range mv {
					if mm, ok := item.(map[string]any); ok {
						for k, v := range mm {
							if _, exists := m[k]; !exists {
								m[k] = v
							}
						}
					}
				}
			case map[string]any:
				for k, v := range mv {
					if _, exists := m[k]; !exists {
						m[k] = v
					}
				}
			}
		})
	})

	j.Rule("yamlElemMap", func(rs *jsonic.RuleSpec) {
		rs.AddBO(func(r *jsonic.Rule, ctx *jsonic.Context) {
			r.Node = make(map[string]any)
		})
		rs.AddBC(func(r *jsonic.Rule, ctx *jsonic.Context) {
			if key := r.U["key"]; key != nil {
				if m, ok := r.Node.(map[string]any); ok {
					val := r.Child.Node
					if jsonic.IsUndefined(val) {
						val = nil
					}
					m[formatKey(key)] = val
				}
			}
		})
	})

	j.Rule("yamlElemPair", func(rs *jsonic.RuleSpec) {
		rs.AddBC(func(r *jsonic.Rule, ctx *jsonic.Context) {
			if key := r.U["key"]; key != nil {
				if m, ok := r.Node.(map[string]any); ok {
					val := r.Child.Node
					if jsonic.IsUndefined(val) {
						val = nil
					}
					m[formatKey(key)] = val
				}
			}
		})
	})
}

// mapToGrammarRules converts a parsed rule map into typed GrammarRuleSpec map.
func mapToGrammarRules(ruleMap map[string]any) map[string]*jsonic.GrammarRuleSpec {
	rules := make(map[string]*jsonic.GrammarRuleSpec, len(ruleMap))
	for name, v := range ruleMap {
		rm, ok := v.(map[string]any)
		if !ok {
			continue
		}
		spec := &jsonic.GrammarRuleSpec{}
		if open, ok := rm["open"]; ok {
			spec.Open = parseGrammarAltsOrSpec(open)
		}
		if close, ok := rm["close"]; ok {
			spec.Close = parseGrammarAltsOrSpec(close)
		}
		rules[name] = spec
	}
	return rules
}

// parseGrammarAltsOrSpec converts parsed JSON-like values into either
// []*GrammarAltSpec or *GrammarAltListSpec depending on shape.
func parseGrammarAltsOrSpec(v any) any {
	switch val := v.(type) {
	case []any:
		return mapsToAlts(val)
	case map[string]any:
		alts, _ := val["alts"].([]any)
		spec := &jsonic.GrammarAltListSpec{Alts: mapsToAlts(alts)}
		if inj, ok := val["inject"].(map[string]any); ok {
			spec.Inject = &jsonic.GrammarInjectSpec{}
			if app, ok := inj["append"].(bool); ok {
				spec.Inject.Append = app
			}
			if del, ok := inj["delete"].([]any); ok {
				for _, d := range del {
					if n, ok := toInt(d); ok {
						spec.Inject.Delete = append(spec.Inject.Delete, n)
					}
				}
			}
			if mv, ok := inj["move"].([]any); ok {
				for _, m := range mv {
					if n, ok := toInt(m); ok {
						spec.Inject.Move = append(spec.Inject.Move, n)
					}
				}
			}
		}
		return spec
	}
	return nil
}

// mapsToAlts converts an []any of parsed alt maps into []*GrammarAltSpec.
func mapsToAlts(list []any) []*jsonic.GrammarAltSpec {
	out := make([]*jsonic.GrammarAltSpec, 0, len(list))
	for _, item := range list {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		a := &jsonic.GrammarAltSpec{}
		if s, ok := m["s"]; ok {
			a.S = normalizeS(s)
		}
		if p, ok := m["p"].(string); ok {
			a.P = p
		}
		if r, ok := m["r"].(string); ok {
			a.R = r
		}
		if b, ok := toInt(m["b"]); ok {
			a.B = b
		}
		if c, ok := m["c"].(string); ok {
			a.C = c
		}
		if a2, ok := m["a"].(string); ok {
			a.A = a2
		}
		if g, ok := m["g"].(string); ok {
			a.G = g
		}
		if u, ok := m["u"].(map[string]any); ok {
			a.U = u
		}
		if k, ok := m["k"].(map[string]any); ok {
			a.K = k
		}
		if n, ok := m["n"].(map[string]any); ok {
			a.N = make(map[string]int, len(n))
			for nk, nv := range n {
				if ni, ok := toInt(nv); ok {
					a.N[nk] = ni
				}
			}
		}
		out = append(out, a)
	}
	return out
}

// normalizeS converts a parsed S field to a form accepted by resolveTokenField
// (string or []string). Parsed YAML-ish text yields []any for arrays; convert
// those into []string so token-name resolution runs.
func normalizeS(s any) any {
	switch v := s.(type) {
	case string:
		return v
	case []string:
		return v
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if str, ok := item.(string); ok {
				out = append(out, str)
			}
		}
		return out
	}
	return s
}

// toInt converts an any value to int.
func toInt(v any) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, true
	case float64:
		return int(n), true
	case int64:
		return int(n), true
	default:
		return 0, false
	}
}
