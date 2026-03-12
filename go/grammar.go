package yaml

import (
	jsonic "github.com/jsonicjs/jsonic/go"
)

// configureGrammarRules sets up YAML-specific grammar rules.
func configureGrammarRules(j *jsonic.Jsonic, IN, EL jsonic.Tin, KEY []jsonic.Tin,
	CL, ZZ, CA, CS, CB, TX, ST, VL, NR jsonic.Tin,
	anchors map[string]any, pendingAnchors *[]anchorInfo) {

	// ===== val rule =====
	j.Rule("val", func(rs *jsonic.RuleSpec) {
		rs.PrependOpen(
			// Indent followed by content: push indent rule.
			&jsonic.AltSpec{
				S: [][]jsonic.Tin{{IN}},
				C: func(r *jsonic.Rule, ctx *jsonic.Context) bool {
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
				},
				P: "indent",
				A: func(r *jsonic.Rule, ctx *jsonic.Context) {
					if v, ok := toInt(r.O0.Val); ok {
						r.N["in"] = v
					}
				},
			},

			// Same indent followed by element marker: list value at map level.
			&jsonic.AltSpec{
				S: [][]jsonic.Tin{{IN}, {EL}},
				C: func(r *jsonic.Rule, ctx *jsonic.Context) bool {
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
				},
				P: "yamlBlockList",
				A: func(r *jsonic.Rule, ctx *jsonic.Context) {
					if v, ok := toInt(r.O0.Val); ok {
						r.N["in"] = v
					}
				},
			},

			// End of input means empty value.
			&jsonic.AltSpec{
				S: [][]jsonic.Tin{{ZZ}},
				B: 1,
				A: func(r *jsonic.Rule, ctx *jsonic.Context) {
					r.Node = nil
				},
			},

			// Same or lesser indent: empty value — backtrack.
			&jsonic.AltSpec{
				S: [][]jsonic.Tin{{IN}},
				B: 1,
				U: map[string]any{"yamlEmpty": true},
			},

			// This value is a list.
			&jsonic.AltSpec{
				S: [][]jsonic.Tin{{EL}},
				P: "yamlBlockList",
				A: func(r *jsonic.Rule, ctx *jsonic.Context) {
					r.N["in"] = r.O0.CI - 1
				},
			},
		)

		// After open: claim pending anchors.
		rs.AddAO(func(r *jsonic.Rule, ctx *jsonic.Context) {
			if len(*pendingAnchors) > 0 {
				anchorsCopy := make([]anchorInfo, len(*pendingAnchors))
				copy(anchorsCopy, *pendingAnchors)
				r.U["yamlAnchors"] = anchorsCopy
				r.U["yamlAnchorOpenNode"] = r.Node
				*pendingAnchors = (*pendingAnchors)[:0]
			}
		})

		// Before close: follow replacement chain from child to get final node.
		rs.AddBC(func(r *jsonic.Rule, ctx *jsonic.Context) {
			// Follow the replacement chain from the child to find the
			// final sibling's Node (e.g., yamlBlockList → yamlBlockElem chain).
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

		// Before close: handle empty values.
		rs.AddBC(func(r *jsonic.Rule, ctx *jsonic.Context) {
			if _, ok := r.U["yamlEmpty"]; ok {
				r.Node = jsonic.Undefined
			}
		})

		// Close on indent tokens.
		rs.PrependClose(
			&jsonic.AltSpec{S: [][]jsonic.Tin{{IN}}, B: 1},
		)

		// After close: resolve aliases and record anchors.
		rs.AddAC(func(r *jsonic.Rule, ctx *jsonic.Context) {
			// Resolve alias markers.
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

			// Record anchors.
			if anchorList, ok := r.U["yamlAnchors"]; ok {
				anchorsSlice, ok := anchorList.([]anchorInfo)
				if ok {
					for _, anchor := range anchorsSlice {
						if anchor.inline {
							openNode := r.U["yamlAnchorOpenNode"]
							if openNode != nil {
								switch openNode.(type) {
								case map[string]any, []any:
									// Don't overwrite with final compound value.
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

	// ===== indent rule =====
	j.Rule("indent", func(rs *jsonic.RuleSpec) {
		rs.Clear()
		rs.Open = []*jsonic.AltSpec{
			// Key pair → map.
			{S: [][]jsonic.Tin{KEY, {CL}}, P: "map", B: 2},
			// Element → list.
			{S: [][]jsonic.Tin{{EL}}, P: "list"},
			// Plain value after indent.
			{S: [][]jsonic.Tin{KEY},
				A: func(r *jsonic.Rule, ctx *jsonic.Context) {
					if r.O0.Tin == ST || r.O0.Tin == TX {
						r.Node = r.O0.Val
					} else {
						r.Node = r.O0.Src
					}
				},
			},
		}
		rs.AddBC(func(r *jsonic.Rule, ctx *jsonic.Context) {
			if !jsonic.IsUndefined(r.Child.Node) {
				r.Node = r.Child.Node
			}
		})
	})

	// ===== yamlBlockList rule =====
	j.Rule("yamlBlockList", func(rs *jsonic.RuleSpec) {
		rs.Clear()
		rs.AddBO(func(r *jsonic.Rule, ctx *jsonic.Context) {
			r.Node = make([]any, 0)
			r.K["yamlBlockArr"] = r.Node
			r.K["yamlListIn"] = r.N["in"]
		})
		rs.Open = []*jsonic.AltSpec{
			{S: [][]jsonic.Tin{KEY, {CL}}, P: "yamlElemMap", B: 2,
				A: func(r *jsonic.Rule, ctx *jsonic.Context) {
					r.K["yamlMapIn"] = r.N["in"] + 2
				},
			},
			{P: "val"},
		}
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
		rs.Close = []*jsonic.AltSpec{
			{S: [][]jsonic.Tin{{IN}, {EL}},
				C: func(r *jsonic.Rule, ctx *jsonic.Context) bool {
					if v, ok := toInt(ctx.T0.Val); ok {
						return v == r.N["in"]
					}
					return false
				},
				R: "yamlBlockElem",
			},
			{S: [][]jsonic.Tin{{IN}},
				C: func(r *jsonic.Rule, ctx *jsonic.Context) bool {
					if v, ok := toInt(ctx.T0.Val); ok {
						return v <= r.N["in"]
					}
					return false
				},
				B: 1,
			},
			{S: [][]jsonic.Tin{{EL}}, R: "yamlBlockElem"},
			{S: [][]jsonic.Tin{{ZZ}}, B: 1},
		}
	})

	// ===== yamlBlockElem rule =====
	j.Rule("yamlBlockElem", func(rs *jsonic.RuleSpec) {
		rs.Clear()
		rs.AddBO(func(r *jsonic.Rule, ctx *jsonic.Context) {
			r.Node = r.K["yamlBlockArr"]
		})
		rs.Open = []*jsonic.AltSpec{
			{S: [][]jsonic.Tin{KEY, {CL}}, P: "yamlElemMap", B: 2,
				A: func(r *jsonic.Rule, ctx *jsonic.Context) {
					r.K["yamlMapIn"] = r.N["in"] + 2
				},
			},
			{P: "val"},
		}
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
		rs.Close = []*jsonic.AltSpec{
			{S: [][]jsonic.Tin{{IN}, {EL}},
				C: func(r *jsonic.Rule, ctx *jsonic.Context) bool {
					if v, ok := toInt(ctx.T0.Val); ok {
						return v == r.N["in"]
					}
					return false
				},
				R: "yamlBlockElem",
			},
			{S: [][]jsonic.Tin{{IN}},
				C: func(r *jsonic.Rule, ctx *jsonic.Context) bool {
					if v, ok := toInt(ctx.T0.Val); ok {
						return v <= r.N["in"]
					}
					return false
				},
				B: 1,
			},
			{S: [][]jsonic.Tin{{EL}}, R: "yamlBlockElem"},
			{S: [][]jsonic.Tin{{ZZ}}, B: 1},
		}
	})

	// ===== list rule amendments =====
	j.Rule("list", func(rs *jsonic.RuleSpec) {
		rs.AddBO(func(r *jsonic.Rule, ctx *jsonic.Context) {
			r.K["yamlListIn"] = r.N["in"]
		})
		rs.PrependClose(
			&jsonic.AltSpec{
				S: [][]jsonic.Tin{{IN}},
				C: func(r *jsonic.Rule, ctx *jsonic.Context) bool {
					if v, ok := toInt(ctx.T0.Val); ok {
						return v <= r.N["in"]
					}
					return false
				},
				B: 1,
			},
		)
	})

	// ===== map rule amendments =====
	j.Rule("map", func(rs *jsonic.RuleSpec) {
		rs.AddBO(func(r *jsonic.Rule, ctx *jsonic.Context) {
			if _, ok := r.N["in"]; !ok {
				r.N["in"] = 0
			}
			r.K["yamlIn"] = r.N["in"]
		})
		rs.PrependOpen(
			&jsonic.AltSpec{
				S: [][]jsonic.Tin{{IN}},
				C: func(r *jsonic.Rule, ctx *jsonic.Context) bool {
					if v, ok := toInt(r.O0.Val); ok {
						return v == r.N["in"]
					}
					return false
				},
				R: "pair",
			},
		)
		// Handle merge keys.
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
		rs.PrependClose(
			&jsonic.AltSpec{
				S: [][]jsonic.Tin{{IN}},
				C: func(r *jsonic.Rule, ctx *jsonic.Context) bool {
					if v, ok := toInt(ctx.T0.Val); ok {
						return v < r.N["in"]
					}
					return false
				},
				B: 1,
			},
		)
	})

	// ===== pair rule amendments =====
	j.Rule("pair", func(rs *jsonic.RuleSpec) {
		rs.PrependOpen(
			&jsonic.AltSpec{S: [][]jsonic.Tin{{ZZ}}, B: 1},
		)
		rs.PrependClose(
			&jsonic.AltSpec{
				S: [][]jsonic.Tin{{IN}},
				C: func(r *jsonic.Rule, ctx *jsonic.Context) bool {
					if v, ok := toInt(ctx.T0.Val); ok {
						return v == r.N["in"]
					}
					return false
				},
				R: "pair",
			},
			&jsonic.AltSpec{
				S: [][]jsonic.Tin{{IN}},
				C: func(r *jsonic.Rule, ctx *jsonic.Context) bool {
					if v, ok := toInt(ctx.T0.Val); ok {
						return v < r.N["in"]
					}
					return false
				},
				B: 1,
			},
		)
	})

	// ===== yamlElemMap rule =====
	j.Rule("yamlElemMap", func(rs *jsonic.RuleSpec) {
		rs.Clear()
		rs.AddBO(func(r *jsonic.Rule, ctx *jsonic.Context) {
			r.Node = make(map[string]any)
		})
		rs.Open = []*jsonic.AltSpec{
			{S: [][]jsonic.Tin{KEY, {CL}}, P: "val",
				A: func(r *jsonic.Rule, ctx *jsonic.Context) {
					r.U["key"] = extractKey(r.O0, anchors)
				},
			},
		}
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
		rs.Close = []*jsonic.AltSpec{
			{S: [][]jsonic.Tin{{IN}},
				C: func(r *jsonic.Rule, ctx *jsonic.Context) bool {
					if v, ok := toInt(ctx.T0.Val); ok {
						if mapIn, ok := toInt(r.K["yamlMapIn"]); ok {
							return v == mapIn
						}
					}
					return false
				},
				R: "yamlElemPair",
			},
			{S: [][]jsonic.Tin{{IN}}, B: 1},
			{S: [][]jsonic.Tin{{CA}}, B: 1},
			{S: [][]jsonic.Tin{{CS}}, B: 1},
			{S: [][]jsonic.Tin{{CB}}, B: 1},
			{S: [][]jsonic.Tin{{ZZ}}},
		}
	})

	// ===== yamlElemPair rule =====
	j.Rule("yamlElemPair", func(rs *jsonic.RuleSpec) {
		rs.Clear()
		rs.Open = []*jsonic.AltSpec{
			{S: [][]jsonic.Tin{KEY, {CL}}, P: "val",
				A: func(r *jsonic.Rule, ctx *jsonic.Context) {
					r.U["key"] = extractKey(r.O0, anchors)
				},
			},
		}
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
		rs.Close = []*jsonic.AltSpec{
			{S: [][]jsonic.Tin{{IN}},
				C: func(r *jsonic.Rule, ctx *jsonic.Context) bool {
					if v, ok := toInt(ctx.T0.Val); ok {
						if mapIn, ok := toInt(r.K["yamlMapIn"]); ok {
							return v == mapIn
						}
					}
					return false
				},
				R: "yamlElemPair",
			},
			{S: [][]jsonic.Tin{{IN}}, B: 1},
			{S: [][]jsonic.Tin{{CA}}, B: 1},
			{S: [][]jsonic.Tin{{CS}}, B: 1},
			{S: [][]jsonic.Tin{{CB}}, B: 1},
			{S: [][]jsonic.Tin{{ZZ}}},
		}
	})

	// ===== elem rule amendments =====
	j.Rule("elem", func(rs *jsonic.RuleSpec) {
		rs.PrependOpen(
			&jsonic.AltSpec{S: [][]jsonic.Tin{KEY, {CL}}, P: "yamlElemMap", B: 2,
				A: func(r *jsonic.Rule, ctx *jsonic.Context) {
					r.K["yamlMapIn"] = r.N["in"] + 2
				},
			},
		)
		rs.PrependClose(
			&jsonic.AltSpec{
				S: [][]jsonic.Tin{{IN}, {EL}},
				C: func(r *jsonic.Rule, ctx *jsonic.Context) bool {
					if v, ok := toInt(ctx.T0.Val); ok {
						return v == r.N["in"]
					}
					return false
				},
				R: "elem",
			},
			&jsonic.AltSpec{
				S: [][]jsonic.Tin{{IN}},
				C: func(r *jsonic.Rule, ctx *jsonic.Context) bool {
					if v, ok := toInt(ctx.T0.Val); ok {
						return v == r.N["in"]
					}
					return false
				},
				B: 1,
			},
			&jsonic.AltSpec{
				S: [][]jsonic.Tin{{IN}},
				C: func(r *jsonic.Rule, ctx *jsonic.Context) bool {
					if v, ok := toInt(ctx.T0.Val); ok {
						return v < r.N["in"]
					}
					return false
				},
				B: 1,
			},
			&jsonic.AltSpec{S: [][]jsonic.Tin{{EL}}, R: "elem"},
		)
	})
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
