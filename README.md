# @jsonic/yaml

A [Jsonic](https://jsonic.senecajs.org) plugin that adds YAML parsing
support. Parse YAML documents into plain JavaScript objects (or Go
values) using Jsonic's extensible grammar engine.

Available for both **TypeScript/JavaScript** (npm) and **Go**.

[![npm version](https://img.shields.io/npm/v/@jsonic/yaml.svg)](https://www.npmjs.com/package/@jsonic/yaml)
[![license](https://img.shields.io/npm/l/@jsonic/yaml.svg)](https://github.com/jsonicjs/yaml/blob/main/LICENSE)


## Features

- Block mappings and sequences (indentation-based)
- Flow collections (`{a: 1, b: 2}`, `[1, 2, 3]`)
- Quoted scalars (single and double), including multiline
- Block scalars (literal `|` and folded `>`) with chomping indicators
- Anchors (`&name`) and aliases (`*name`), including merge keys (`<<`)
- Multi-document streams (`---` / `...`)
- YAML value keywords (`true`/`false`/`yes`/`no`/`on`/`off`, `null`/`~`, `.inf`, `.nan`)
- Comments (`#`)
- Tags and `%TAG` directives
- Hex (`0x`), octal (`0o`), and binary (`0b`) integer literals
- Tested against the official [YAML Test Suite](https://github.com/yaml/yaml-test-suite)


## Install

### Node.js

```bash
npm install @jsonic/yaml jsonic
```

`jsonic` (v2+) is a peer dependency.

### Go

```bash
go get github.com/jsonicjs/yaml/go
```


## Usage

### TypeScript / JavaScript

```js
const { Jsonic } = require('jsonic')
const { Yaml } = require('@jsonic/yaml')

const jsonic = Jsonic.make().use(Yaml)

const result = jsonic(`
name: Alice
items:
  - one
  - two
flags:
  debug: true
`)

// { name: 'Alice', items: ['one', 'two'], flags: { debug: true } }
```

### Go

```go
package main

import (
	"fmt"
	yaml "github.com/jsonicjs/yaml/go"
)

func main() {
	result, err := yaml.Parse(`
name: Alice
items:
  - one
  - two
flags:
  debug: true
`)
	if err != nil {
		panic(err)
	}
	fmt.Println(result)
	// map[flags:map[debug:true] items:[one two] name:Alice]
}
```

You can also use the lower-level API to get a configured Jsonic instance:

```go
j := yaml.MakeJsonic()
result, err := j.Parse(src)
```


## API

### TypeScript / JavaScript

**`Yaml`** — A Jsonic plugin function. Pass it to `jsonic.use()`:

```js
const jsonic = Jsonic.make().use(Yaml)
const data = jsonic(yamlString)
```

### Go

**`yaml.Parse(src string) (any, error)`** — Parse a YAML string directly.

**`yaml.MakeJsonic(opts ...YamlOptions) *jsonic.Jsonic`** — Create a reusable Jsonic instance configured for YAML.

**`yaml.Yaml`** — The raw Jsonic plugin function, for use with `j.Use(yaml.Yaml, nil)`.


## Testing

### Node.js

```bash
npm install
npm run build
npm test
```

Run a subset of tests by pattern:

```bash
npm run test-some --pattern="4MUZ"
```

### Go

```bash
cd go
go test ./...
```

The test suite validates against the official
[YAML Test Suite](https://github.com/yaml/yaml-test-suite) data files
included in `test/yaml-test-suite/`.


## License

[MIT](LICENSE) — Copyright (c) 2021 jsonicjs
