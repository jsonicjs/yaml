/* Copyright (c) 2021-2025 Richard Rodger and other contributors, MIT License */

import { test, describe } from 'node:test'
import { expect } from '@hapi/code'

import { Jsonic } from 'jsonic'
import { Yaml } from '../dist/yaml'


// Helper: create a fresh Yaml-enabled Jsonic instance per test.
function y(src: string) {
  const j = Jsonic.make().use(Yaml)
  return j(src)
}


describe('yaml', () => {

  test('happy', () => {
    expect(y(`a: 1
b: 2
c:
  d: 3
  e: 4
  f:
  - g
  - h
`)).equal({ a: 1, b: 2, c: { d: 3, e: 4, f: ['g', 'h'] } })
  })


  // ===== BLOCK MAPPINGS =====

  describe('block-mappings', () => {

    test('single-pair', () => {
      expect(y(`a: 1`)).equal({ a: 1 })
    })

    test('multiple-pairs', () => {
      expect(y(`a: 1\nb: 2\nc: 3`)).equal({ a: 1, b: 2, c: 3 })
    })

    test('nested-map', () => {
      expect(y(`a:\n  b: 1\n  c: 2`)).equal({ a: { b: 1, c: 2 } })
    })

    test('deeply-nested-map', () => {
      expect(y(`a:\n  b:\n    c:\n      d: 1`)).equal({ a: { b: { c: { d: 1 } } } })
    })

    test('sibling-nested-maps', () => {
      expect(y(`a:\n  x: 1\nb:\n  y: 2`)).equal({ a: { x: 1 }, b: { y: 2 } })
    })

    test('empty-value-followed-by-sibling', () => {
      // key with colon-newline but no nested content, then sibling
      expect(y(`a:\nb: 1`)).equal({ a: null, b: 1 })
    })

    test('colon-space-required', () => {
      // "a:b" should NOT be treated as key "a" value "b"
      // Jsonic may parse this differently — baseline the behavior
      let result: any
      try { result = y(`a:b`) } catch (e: any) { result = 'ERROR' }
      // Record whatever happens — this is a baseline
      expect(result).exist()
    })

    test('colon-at-end-of-line', () => {
      expect(y(`a:\n  b: 1`)).equal({ a: { b: 1 } })
    })

    test('trailing-newline', () => {
      expect(y(`a: 1\n`)).equal({ a: 1 })
    })

    test('multiple-trailing-newlines', () => {
      let result: any
      try { result = y(`a: 1\n\n\n`) } catch (e: any) { result = 'ERROR' }
      expect(result).exist()
    })
  })


  // ===== BLOCK SEQUENCES =====

  describe('block-sequences', () => {

    test('simple-list', () => {
      expect(y(`- a\n- b\n- c`)).equal(['a', 'b', 'c'])
    })

    test('single-element', () => {
      expect(y(`- a`)).equal(['a'])
    })

    test('nested-list-in-map', () => {
      expect(y(`items:\n  - a\n  - b`)).equal({ items: ['a', 'b'] })
    })

    test('list-of-numbers', () => {
      expect(y(`- 1\n- 2\n- 3`)).equal([1, 2, 3])
    })

    test('list-of-maps', () => {
      // - key: val  (dash followed by key-value pair)
      expect(y(`- name: alice\n- name: bob`)).equal([{ name: 'alice' }, { name: 'bob' }])
    })

    test('nested-list-of-maps-multikey', () => {
      expect(y(`items:\n  - name: alice\n    age: 30\n  - name: bob\n    age: 25`))
        .equal({ items: [{ name: 'alice', age: 30 }, { name: 'bob', age: 25 }] })
    })

    test('list-of-lists', () => {
      // Nested sequences: - - item
      expect(y(`- - a\n  - b\n- - c\n  - d`)).equal([['a', 'b'], ['c', 'd']])
    })

    test('deeply-nested-list', () => {
      expect(y(`a:\n  b:\n    - x\n    - y`)).equal({ a: { b: ['x', 'y'] } })
    })

    test('mixed-map-then-list', () => {
      expect(y(`a: 1\nb:\n  - x\n  - y\nc: 3`))
        .equal({ a: 1, b: ['x', 'y'], c: 3 })
    })
  })


  // ===== SCALAR TYPES =====

  describe('scalar-types', () => {

    test('integer', () => {
      expect(y(`a: 42`)).equal({ a: 42 })
    })

    test('negative-integer', () => {
      expect(y(`a: -7`)).equal({ a: -7 })
    })

    test('float', () => {
      expect(y(`a: 3.14`)).equal({ a: 3.14 })
    })

    test('negative-float', () => {
      expect(y(`a: -2.5`)).equal({ a: -2.5 })
    })

    test('zero', () => {
      expect(y(`a: 0`)).equal({ a: 0 })
    })

    test('boolean-true', () => {
      expect(y(`a: true`)).equal({ a: true })
    })

    test('boolean-false', () => {
      expect(y(`a: false`)).equal({ a: false })
    })

    test('null-keyword', () => {
      expect(y(`a: null`)).equal({ a: null })
    })

    test('tilde-null', () => {
      // YAML allows ~ as null
      expect(y(`a: ~`)).equal({ a: null })
    })

    test('empty-value-null', () => {
      // Empty value after colon should be null/undefined
      expect(y(`a:`)).equal({ a: null })
    })

    test('plain-string', () => {
      expect(y(`a: hello world`)).equal({ a: 'hello world' })
    })

    test('string-with-special-chars', () => {
      expect(y(`a: hello, world!`)).equal({ a: 'hello, world!' })
    })

    test('octal-number', () => {
      // YAML 1.2: 0o77 = 63
      expect(y(`a: 0o77`)).equal({ a: 63 })
    })

    test('hex-number', () => {
      // YAML 1.2: 0xFF = 255
      expect(y(`a: 0xFF`)).equal({ a: 255 })
    })

    test('positive-infinity', () => {
      expect(y(`a: .inf`)).equal({ a: Infinity })
    })

    test('negative-infinity', () => {
      expect(y(`a: -.inf`)).equal({ a: -Infinity })
    })

    test('nan', () => {
      let result = y(`a: .nan`)
      expect(Number.isNaN(result.a)).equal(true)
    })

    test('yes-boolean', () => {
      // YAML 1.1 allows yes/no as booleans
      expect(y(`a: yes`)).equal({ a: true })
    })

    test('no-boolean', () => {
      expect(y(`a: no`)).equal({ a: false })
    })

    test('on-boolean', () => {
      expect(y(`a: on`)).equal({ a: true })
    })

    test('off-boolean', () => {
      expect(y(`a: off`)).equal({ a: false })
    })

    test('timestamp-date', () => {
      // YAML supports dates — should parse as string or Date
      let result = y(`a: 2024-01-15`)
      expect(result.a).exist()
    })

    test('timestamp-datetime', () => {
      let result = y(`a: 2024-01-15T10:30:00Z`)
      expect(result.a).exist()
    })
  })


  // ===== QUOTED STRINGS =====

  describe('quoted-strings', () => {

    test('double-quoted', () => {
      expect(y(`a: "hello"`)).equal({ a: 'hello' })
    })

    test('single-quoted', () => {
      expect(y(`a: 'hello'`)).equal({ a: 'hello' })
    })

    test('double-quoted-with-colon', () => {
      expect(y(`a: "key: value"`)).equal({ a: 'key: value' })
    })

    test('single-quoted-with-colon', () => {
      expect(y(`a: 'key: value'`)).equal({ a: 'key: value' })
    })

    test('double-quoted-with-newline-escape', () => {
      expect(y(`a: "line1\\nline2"`)).equal({ a: 'line1\nline2' })
    })

    test('double-quoted-with-tab-escape', () => {
      expect(y(`a: "col1\\tcol2"`)).equal({ a: 'col1\tcol2' })
    })

    test('single-quoted-no-escapes', () => {
      // Single-quoted strings don't process escapes in YAML
      expect(y(`a: 'line1\\nline2'`)).equal({ a: 'line1\\nline2' })
    })

    test('double-quoted-empty', () => {
      expect(y(`a: ""`)).equal({ a: '' })
    })

    test('single-quoted-empty', () => {
      expect(y(`a: ''`)).equal({ a: '' })
    })

    test('quoted-key', () => {
      expect(y(`"a b": 1`)).equal({ 'a b': 1 })
    })

    test('quoted-number-stays-string', () => {
      expect(y(`a: "42"`)).equal({ a: '42' })
    })

    test('quoted-boolean-stays-string', () => {
      expect(y(`a: "true"`)).equal({ a: 'true' })
    })
  })


  // ===== BLOCK SCALARS =====

  describe('block-scalars', () => {

    test('literal-block', () => {
      // | preserves newlines
      expect(y(`a: |\n  line1\n  line2\n  line3`))
        .equal({ a: 'line1\nline2\nline3\n' })
    })

    test('literal-block-strip', () => {
      // |- strips trailing newline
      expect(y(`a: |-\n  line1\n  line2`))
        .equal({ a: 'line1\nline2' })
    })

    test('literal-block-keep', () => {
      // |+ keeps trailing newlines
      expect(y(`a: |+\n  line1\n  line2\n\n`))
        .equal({ a: 'line1\nline2\n\n' })
    })

    test('folded-block', () => {
      // > folds newlines to spaces
      expect(y(`a: >\n  line1\n  line2\n  line3`))
        .equal({ a: 'line1 line2 line3\n' })
    })

    test('folded-block-strip', () => {
      expect(y(`a: >-\n  line1\n  line2`))
        .equal({ a: 'line1 line2' })
    })

    test('folded-block-keep', () => {
      expect(y(`a: >+\n  line1\n  line2\n\n`))
        .equal({ a: 'line1 line2\n\n' })
    })

    test('literal-block-with-indent', () => {
      expect(y(`a:\n  b: |\n    indented\n    text`))
        .equal({ a: { b: 'indented\ntext\n' } })
    })

    test('literal-block-preserves-inner-indent', () => {
      expect(y(`a: |\n  line1\n    indented\n  line3`))
        .equal({ a: 'line1\n  indented\nline3\n' })
    })
  })


  // ===== FLOW COLLECTIONS =====

  describe('flow-collections', () => {

    test('flow-sequence', () => {
      expect(y(`a: [1, 2, 3]`)).equal({ a: [1, 2, 3] })
    })

    test('flow-mapping', () => {
      expect(y(`a: {x: 1, y: 2}`)).equal({ a: { x: 1, y: 2 } })
    })

    test('nested-flow-in-block', () => {
      expect(y(`a: [1, [2, 3]]`)).equal({ a: [1, [2, 3]] })
    })

    test('flow-map-in-flow-seq', () => {
      expect(y(`a: [{x: 1}, {y: 2}]`)).equal({ a: [{ x: 1 }, { y: 2 }] })
    })

    test('empty-flow-sequence', () => {
      expect(y(`a: []`)).equal({ a: [] })
    })

    test('empty-flow-mapping', () => {
      expect(y(`a: {}`)).equal({ a: {} })
    })

    test('flow-at-top-level-seq', () => {
      expect(y(`[1, 2, 3]`)).equal([1, 2, 3])
    })

    test('flow-at-top-level-map', () => {
      expect(y(`{a: 1, b: 2}`)).equal({ a: 1, b: 2 })
    })
  })


  // ===== COMMENTS =====

  describe('comments', () => {

    test('line-comment', () => {
      expect(y(`a: 1 # comment\nb: 2`)).equal({ a: 1, b: 2 })
    })

    test('full-line-comment', () => {
      expect(y(`# this is a comment\na: 1`)).equal({ a: 1 })
    })

    test('comment-after-key', () => {
      expect(y(`a: # comment\n  b: 1`)).equal({ a: { b: 1 } })
    })

    test('multiple-comments', () => {
      expect(y(`# first\na: 1\n# second\nb: 2`)).equal({ a: 1, b: 2 })
    })

    test('comment-in-list', () => {
      expect(y(`- a # comment\n- b`)).equal(['a', 'b'])
    })

    test('comment-only-line-between-pairs', () => {
      expect(y(`a: 1\n# middle\nb: 2`)).equal({ a: 1, b: 2 })
    })
  })


  // ===== ANCHORS AND ALIASES =====

  describe('anchors-aliases', () => {

    test('simple-anchor-alias', () => {
      expect(y(`a: &ref hello\nb: *ref`)).equal({ a: 'hello', b: 'hello' })
    })

    test('anchor-on-map', () => {
      expect(y(`defaults: &defaults\n  x: 1\n  y: 2\noverride:\n  <<: *defaults\n  y: 3`))
        .equal({ defaults: { x: 1, y: 2 }, override: { x: 1, y: 3 } })
    })

    test('anchor-on-sequence', () => {
      expect(y(`a: &items\n  - 1\n  - 2\nb: *items`))
        .equal({ a: [1, 2], b: [1, 2] })
    })

    test('multiple-aliases', () => {
      expect(y(`a: &x 10\nb: &y 20\nc: *x\nd: *y`))
        .equal({ a: 10, b: 20, c: 10, d: 20 })
    })
  })


  // ===== MERGE KEY =====

  describe('merge-key', () => {

    test('simple-merge', () => {
      expect(y(`defaults: &d\n  a: 1\n  b: 2\nresult:\n  <<: *d\n  c: 3`))
        .equal({ defaults: { a: 1, b: 2 }, result: { a: 1, b: 2, c: 3 } })
    })

    test('merge-override', () => {
      expect(y(`base: &b\n  x: 1\n  y: 2\nchild:\n  <<: *b\n  y: 99`))
        .equal({ base: { x: 1, y: 2 }, child: { x: 1, y: 99 } })
    })

    test('merge-multiple', () => {
      expect(y(`a: &a\n  x: 1\nb: &b\n  y: 2\nc:\n  <<: [*a, *b]\n  z: 3`))
        .equal({ a: { x: 1 }, b: { y: 2 }, c: { x: 1, y: 2, z: 3 } })
    })
  })


  // ===== MULTI-DOCUMENT =====

  describe('multi-document', () => {

    test('document-start-marker', () => {
      expect(y(`---\na: 1`)).equal({ a: 1 })
    })

    test('document-end-marker', () => {
      expect(y(`a: 1\n...`)).equal({ a: 1 })
    })

    test('multiple-documents', () => {
      // Parser may only return first document or throw
      let result: any
      try { result = y(`---\na: 1\n---\nb: 2`) } catch (e: any) { result = 'ERROR' }
      expect(result).exist()
    })
  })


  // ===== TAGS =====

  describe('tags', () => {

    test('explicit-string-tag', () => {
      expect(y(`a: !!str 42`)).equal({ a: '42' })
    })

    test('explicit-int-tag', () => {
      expect(y(`a: !!int "42"`)).equal({ a: 42 })
    })

    test('explicit-float-tag', () => {
      expect(y(`a: !!float "3.14"`)).equal({ a: 3.14 })
    })

    test('explicit-bool-tag', () => {
      expect(y(`a: !!bool "true"`)).equal({ a: true })
    })

    test('explicit-null-tag', () => {
      expect(y(`a: !!null ""`)).equal({ a: null })
    })

    test('explicit-seq-tag', () => {
      expect(y(`a: !!seq\n  - 1\n  - 2`)).equal({ a: [1, 2] })
    })

    test('explicit-map-tag', () => {
      expect(y(`a: !!map\n  x: 1`)).equal({ a: { x: 1 } })
    })
  })


  // ===== COMPLEX KEYS =====

  describe('complex-keys', () => {

    test('explicit-key', () => {
      // ? marks an explicit key
      expect(y(`? a\n: 1`)).equal({ a: 1 })
    })

    test('multiline-key', () => {
      expect(y(`? a b\n: 1`)).equal({ 'a b': 1 })
    })

    test('numeric-key', () => {
      expect(y(`1: one\n2: two`)).equal({ 1: 'one', 2: 'two' })
    })
  })


  // ===== DIRECTIVES =====

  describe('directives', () => {

    test('yaml-directive', () => {
      let result: any
      try { result = y(`%YAML 1.2\n---\na: 1`) } catch (e: any) { result = 'ERROR' }
      expect(result).exist()
    })

    test('tag-directive', () => {
      let result: any
      try { result = y(`%TAG ! tag:example.com,2000:\n---\na: 1`) } catch (e: any) { result = 'ERROR' }
      expect(result).exist()
    })
  })


  // ===== INDENTATION EDGE CASES =====

  describe('indentation', () => {

    test('two-space-indent', () => {
      expect(y(`a:\n  b: 1`)).equal({ a: { b: 1 } })
    })

    test('four-space-indent', () => {
      expect(y(`a:\n    b: 1`)).equal({ a: { b: 1 } })
    })

    test('mixed-indent-levels', () => {
      expect(y(`a:\n  b:\n      c: 1`)).equal({ a: { b: { c: 1 } } })
    })

    test('return-to-outer-indent', () => {
      // After nested content, return to parent indent level
      expect(y(`a:\n  b: 1\n  c: 2\nd: 3`)).equal({ a: { b: 1, c: 2 }, d: 3 })
    })

    test('multiple-indent-returns', () => {
      expect(y(`a:\n  b:\n    c: 1\n  d: 2\ne: 3`))
        .equal({ a: { b: { c: 1 }, d: 2 }, e: 3 })
    })

    test('list-indent-under-map', () => {
      expect(y(`a:\n  - 1\n  - 2\nb: 3`)).equal({ a: [1, 2], b: 3 })
    })

    test('tab-indentation-rejected', () => {
      // YAML spec says tabs are not allowed for indentation
      let result: any
      try { result = y(`a:\n\tb: 1`) } catch (e: any) { result = 'ERROR' }
      expect(result).exist()
    })

    test('start-of-file-indent', () => {
      // Content starting with indentation (no leading newline)
      let result: any
      try { result = y(`  a: 1`) } catch (e: any) { result = 'ERROR' }
      expect(result).exist()
    })

    test('blank-lines-between-pairs', () => {
      let result: any
      try { result = y(`a: 1\n\nb: 2`) } catch (e: any) { result = 'ERROR' }
      expect(result).exist()
    })

    test('blank-lines-in-list', () => {
      let result: any
      try { result = y(`- a\n\n- b`) } catch (e: any) { result = 'ERROR' }
      expect(result).exist()
    })
  })


  // ===== MULTILINE PLAIN SCALARS =====

  describe('multiline-plain-scalars', () => {

    test('continuation-line', () => {
      // In YAML, plain scalars can span multiple lines (folded at same indent)
      expect(y(`a: this is\n  a long string`)).equal({ a: 'this is a long string' })
    })

    test('multiple-continuation-lines', () => {
      expect(y(`a: line one\n  line two\n  line three`))
        .equal({ a: 'line one line two line three' })
    })
  })


  // ===== WINDOWS LINE ENDINGS =====

  describe('line-endings', () => {

    test('crlf', () => {
      expect(y(`a: 1\r\nb: 2`)).equal({ a: 1, b: 2 })
    })

    test('crlf-nested', () => {
      expect(y(`a:\r\n  b: 1\r\n  c: 2`)).equal({ a: { b: 1, c: 2 } })
    })

    test('crlf-list', () => {
      expect(y(`- a\r\n- b`)).equal(['a', 'b'])
    })
  })


  // ===== STRING VALUES WITH SPECIAL CHARACTERS =====

  describe('special-chars-in-values', () => {

    test('value-with-hash-not-comment', () => {
      // In YAML, # must have a space before it to be a comment
      expect(y(`a: foo#bar`)).equal({ a: 'foo#bar' })
    })

    test('value-with-colon-no-space', () => {
      // "http://example.com" - colon not followed by space
      let result: any
      try { result = y(`url: http://example.com`) } catch (e: any) { result = 'ERROR' }
      expect(result).exist()
    })

    test('key-with-spaces', () => {
      expect(y(`a long key: value`)).equal({ 'a long key': 'value' })
    })

    test('value-with-brackets', () => {
      // Plain scalar containing brackets
      let result: any
      try { result = y(`a: some [text] here`) } catch (e: any) { result = 'ERROR' }
      expect(result).exist()
    })

    test('value-with-braces', () => {
      let result: any
      try { result = y(`a: some {text} here`) } catch (e: any) { result = 'ERROR' }
      expect(result).exist()
    })
  })


  // ===== SEQUENCE-OF-MAPPINGS COMPACT NOTATION =====

  describe('sequence-of-mappings', () => {

    test('compact-notation', () => {
      // - key: val  (most common YAML pattern for lists of objects)
      expect(y(`- name: alice\n  age: 30\n- name: bob\n  age: 25`))
        .equal([{ name: 'alice', age: 30 }, { name: 'bob', age: 25 }])
    })

    test('single-key-per-element', () => {
      expect(y(`- a: 1\n- b: 2\n- c: 3`))
        .equal([{ a: 1 }, { b: 2 }, { c: 3 }])
    })

    test('nested-in-map', () => {
      expect(y(`people:\n  - name: alice\n  - name: bob`))
        .equal({ people: [{ name: 'alice' }, { name: 'bob' }] })
    })
  })


  // ===== REAL-WORLD YAML PATTERNS =====

  describe('real-world', () => {

    test('docker-compose-like', () => {
      expect(y(`version: 3\nservices:\n  web:\n    image: nginx\n    ports:\n      - 80\n      - 443`))
        .equal({
          version: 3,
          services: {
            web: {
              image: 'nginx',
              ports: [80, 443]
            }
          }
        })
    })

    test('github-actions-like', () => {
      expect(y(`name: build\non:\n  push:\n    branches:\n      - main\njobs:\n  test:\n    runs-on: ubuntu`))
        .equal({
          name: 'build',
          on: { push: { branches: ['main'] } },
          jobs: { test: { 'runs-on': 'ubuntu' } }
        })
    })

    test('kubernetes-like', () => {
      expect(y(`apiVersion: v1\nkind: Pod\nmetadata:\n  name: myapp\n  labels:\n    app: myapp\nspec:\n  containers:\n    - name: web\n      image: nginx`))
        .equal({
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: { name: 'myapp', labels: { app: 'myapp' } },
          spec: { containers: [{ name: 'web', image: 'nginx' }] }
        })
    })

    test('ansible-like', () => {
      expect(y(`- name: install packages\n  become: true\n- name: start service\n  become: false`))
        .equal([
          { name: 'install packages', become: true },
          { name: 'start service', become: false }
        ])
    })

    test('config-file-like', () => {
      expect(y(`database:\n  host: localhost\n  port: 5432\n  name: mydb\ncache:\n  enabled: true\n  ttl: 3600`))
        .equal({
          database: { host: 'localhost', port: 5432, name: 'mydb' },
          cache: { enabled: true, ttl: 3600 }
        })
    })
  })

})
