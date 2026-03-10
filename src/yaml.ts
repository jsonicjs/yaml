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

  jsonic.options({
    fixed: {
      token: {
        // Single colon is not a YAML token, so remove.
        '#CL': null,

        // Element prefix and separator.
        '#EL': '-',
      }
    },

    // Colons can still end unquoted text (TX, lexer.textMatcher).
    ender: ':',

    // Disable implicit lists from space/comma separation at top level.
    value: {
      map: { extend: true },
    },
  })

  // Get the Tin (Token id number) for #EL.
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

              // Yaml colons are ': ' and ':<newline>'.
              let colon = fwd.match(/^:( |\r?\n)/)
              if (colon) {
                let tkn = lex.token('#CL', 1, colon[0], lex.pnt)
                pnt.sI += 1
                pnt.rI += ' ' != colon[1] ? 1 : 0
                pnt.cI += ' ' == colon[1] ? 2 : 0
                return tkn
              }

              // Match any newline — YAML indentation is significant.
              // Must catch all newlines before the default line/space matchers.
              if (fwd[0] === '\n' || fwd[0] === '\r') {
                // Consume all blank lines, finding the last meaningful indent.
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
                }

                // If we consumed everything (trailing newlines), advance and emit #ZZ.
                if (pos >= fwd.length) {
                  pnt.sI += pos
                  pnt.rI += rows
                  pnt.cI = spaces
                  let tkn = lex.token('#ZZ', undefined, '', lex.pnt)
                  pnt.end = tkn
                  return tkn
                }

                // Emit #IN with val = indent level of the last non-blank line.
                let src = fwd.substring(0, pos)
                let tkn = lex.token('#IN', spaces, src, lex.pnt)
                pnt.sI += pos
                pnt.rI += rows
                pnt.cI = spaces
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
        p: 'indent',
        a: (rule: Rule) => rule.n.in = rule.o0.val
      },

      // This value is a list.
      {
        s: [EL],
        p: 'list',
        a: (rule: Rule) => {
          // Track that this list starts at indent 0 if not set.
          if (null == rule.n.in) {
            rule.n.in = 0
          }
        }
      }
    ])
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
    })

    rulespec.open([
      // Indent at same level continues the map with another pair.
      {
        s: [IN],
        c: (rule: Rule) => rule.o0.val === rule.n.in,
        r: 'pair',
      },
    ])

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
