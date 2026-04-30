# YAML Parser Benchmarks

Measurement & profiling harness for the TypeScript and Go YAML parsers.

## Layout

```
bench/
  fixtures/
    generate.mjs   # synthetic YAML fixture generator
    *.yaml         # generated fixtures (one per hotspot shape)
  ts/
    bench.mjs      # full fixture sweep benchmark (Node)
    scaling.mjs    # measure per-byte cost as N grows — exposes O(N^k)
go/                # Go benchmarks live in the main package so they can
                   # call the unexported parser internals via Parse()
  bench_test.go    # one Benchmark per fixture
  scaling_test.go  # scaling test (runs under `go test -run TestScaling`)
```

## One-time setup

```bash
npm install && npm run build      # build TS sources to dist/
cd go && go build ./...           # download deps
```

## Regenerate fixtures

```bash
# default sizes (each fixture 2–100KB, whole suite runs in ~30s per language)
node bench/fixtures/generate.mjs
# scale up for stress testing
node bench/fixtures/generate.mjs --scale=5
```

## TypeScript

```bash
# full suite
node --expose-gc bench/ts/bench.mjs

# focus on one fixture, capture Chrome-style CPU profile
node --expose-gc bench/ts/bench.mjs --only=flow_map_large --profile=flow_map_large
# → bench/ts/flow_map_large.cpuprofile   (load in chrome://inspect)

# scaling sweep
node bench/ts/scaling.mjs
```

## Go

```bash
# full suite
(cd go && go test -bench=. -benchmem -benchtime=2s -run=^$ .)

# focus on one fixture with CPU + mem profile
(cd go && go test -bench=BlockMapWide -run=^$ \
    -cpuprofile=../bench/go-blockmap.cpuprof \
    -memprofile=../bench/go-blockmap.memprof .)
go tool pprof -top -cum bench/go-blockmap.cpuprof

# scaling sweep
(cd go && go test -run TestScaling -v .)
```

See [REPORT.md](REPORT.md) for the latest analysis and recommendations.
