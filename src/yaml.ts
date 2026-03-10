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
} from 'jsonic'


type YamlOptions = {
}


const Yaml: Plugin = (jsonic: Jsonic, _options: YamlOptions) => {
  let TX = jsonic.token.TX
  let CL = jsonic.token.CL

  let IN = jsonic.token('#IN')

  jsonic.options({
    fixed: {
      token: {
        // Single colon is not a YAML token, so remove.
        '#CL': null,

        // Element prefix and separator.
        // TODO: should be '- '
        '#EL': '-',
      }
    },

    // Colons can still end unquoted text (TX, lexer.textMatcher).
    ender: ':'
  })

  // Get the Tin (Token id number) for #EL.
  let EL = jsonic.token('#EL')

  // Add a custom lex matcher for YAML special cases.
  // Use a low order number so this matcher runs before the built-in
  // matchers (which start at 1e6), preventing lexer.lineMatcher and
  // lexer.spaceMatcher from incorrectly matching indentation.
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
                // NOTE: Don't consume newline! leave it for #IN,
                // so it can match properly.
                // Even though the match is <:\n> (say), only move
                // point past the ':'. This is unusual - lex matchers
                // normally consume the entire token string.
                // (In the case ': ', the space will just get ignored).
                let tkn = lex.token('#CL', 1, colon[0], lex.pnt)
                pnt.sI += 1

                pnt.rI += ' ' != colon[1] ? 1 : 0
                pnt.cI += ' ' == colon[1] ? 2 : 0
                return tkn
              }

              // Indentation is significant.
              let spaces = fwd.match(/^\r?\n +/)
              if (spaces) {
                let len = spaces[0].length
                let tkn = lex.token('#IN', len, spaces[0], lex.pnt)
                pnt.sI += len
                pnt.rI += 1
                pnt.cI = len
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

        // Set indent counter (`in`) to the size of the indent,
        // which is #IN.val resolved by yamlMatcher by counting
        // the number of spaces after a newline.
        // TODO: fix start of file indent
        a: (rule: Rule) => rule.n.in = rule.o0.val
      },

      // This value is a list.
      {
        s: [EL],
        p: 'list',
      }
    ])
  })


  // Add indent rule to handle initial indent.
  jsonic.rule('indent', (rulespec: RuleSpec) => {
    rulespec
      .open([
        // Key pair, so this must be a map.
        {
          s: [TX, CL],
          p: 'map',
          b: 2,
        },

        // Element, so this must be a list.
        {
          s: [EL],
          p: 'list',
        }
      ])

      // Get the final value of the map or value.
      .bc((rule: Rule) => rule.node = rule.child.node)
  })


  // Amend map rule, treating IN like CA. Indents act like
  // commas in traditional JSON.
  jsonic.rule('map', (rulespec: RuleSpec) => {
    rulespec.open([

      // Indent is a separator like comma, but only valid if
      // same size as current indent level.
      {
        s: [IN],
        c: (rule: Rule) => rule.o0.val === rule.n.in,
        r: 'pair',
      },
    ])
  })


  // Amend pair rule, treating IN like CA after pair.
  jsonic.rule('pair', (rulespec: RuleSpec) => {
    rulespec.close([

      // Indent is a separator like comma, but only valid if
      // same size as current indent level.
      {
        s: [IN],
        c: (rule: Rule, ctx: Context) => {
          return ctx.t0.val === rule.n.in
        },
        r: 'pair',
      },
    ])
  })


  // Amend elem rule, treating IN like CA after element.
  jsonic.rule('elem', (rulespec: RuleSpec) => {
    rulespec.close([

      // Indent followed by element marker is a separator like comma,
      // but only valid if same size as current indent level.
      {
        s: [IN, EL],
        c: (rule: Rule, ctx: Context) => {
          return ctx.t0.val === rule.n.in
        },
        r: 'elem',
      },

      // Element marker at top level.
      {
        s: [EL],
        c: (rule: Rule, _ctx: Context) => {
          return !!rule.n.in  // NOTE: no indent as either 0 or undef
        },
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
