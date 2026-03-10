/* Copyright (c) 2021-2025 Richard Rodger and other contributors, MIT License */

import { test, describe } from 'node:test'
import { expect } from '@hapi/code'

import { Jsonic } from 'jsonic'
import { Yaml } from '../dist/yaml'


describe('yaml', () => {

  test('happy', () => {
    const j = Jsonic.make().use(Yaml)

    expect(j(`a: 1
b: 2
c:
  d: 3
  e: 4
  f:
  - g
  - h
`)).equal({ a: 1, b: 2, c: { d: 3, e: 4, f: ['g', 'h'] } })

  })

})
