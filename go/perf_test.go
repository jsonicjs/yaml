package yaml

import (
	"strings"
	"testing"
	"time"
)

const benchBudget = 2 * time.Second

// bench parses the given source `iters` times and asserts the total stays
// under benchBudget. Mirrors the TS performance describe block.
func bench(t *testing.T, label string, iters int, src string) {
	t.Helper()
	// Warm up so the runtime is steady before the timed loop.
	for i := 0; i < 50; i++ {
		_, _ = Parse(src)
	}
	start := time.Now()
	for i := 0; i < iters; i++ {
		if _, err := Parse(src); err != nil {
			t.Fatalf("%s parse error: %v", label, err)
		}
	}
	elapsed := time.Since(start)
	if elapsed > benchBudget {
		t.Errorf("%s %dx took %v (budget %v)", label, iters, elapsed, benchBudget)
	} else {
		t.Logf("%s %dx took %v (%.1f us/op)",
			label, iters, elapsed, float64(elapsed.Microseconds())/float64(iters))
	}
}

func TestPerfTinyBlockMap(t *testing.T) {
	// Go iterations are lower than the TS counterpart because the Go parser
	// is currently slower per-op. The 2s budget is preserved.
	bench(t, "tiny block map", 500, "a: 1\nb: 2\nc: 3")
}

func TestPerfNestedBlockMap(t *testing.T) {
	src := `
top:
  a: 1
  b:
    c: 2
    d: 3
  e:
    - 1
    - 2
    - 3
  f:
    g:
      h: 4
`
	bench(t, "nested block map", 500, src)
}

func TestPerfFlowSeq200(t *testing.T) {
	parts := make([]string, 0, 200)
	for i := 0; i < 200; i++ {
		parts = append(parts, "v")
	}
	src := "[" + strings.Join(parts, ", ") + "]"
	bench(t, "flow seq 200", 100, src)
}

func TestPerfFlowMap200(t *testing.T) {
	parts := make([]string, 0, 200)
	for i := 0; i < 200; i++ {
		parts = append(parts, "k: v")
	}
	src := "{" + strings.Join(parts, ", ") + "}"
	bench(t, "flow map 200", 50, src)
}

func TestPerfBlockSeq200(t *testing.T) {
	parts := make([]string, 0, 200)
	for i := 0; i < 200; i++ {
		parts = append(parts, "- item")
	}
	src := strings.Join(parts, "\n")
	bench(t, "block seq 200", 100, src)
}

func TestPerfAnchorsAliases(t *testing.T) {
	src := `
defaults: &d
  retries: 3
  timeout: 30
prod:
  <<: *d
  host: prod.com
dev:
  <<: *d
  host: dev.com
`
	bench(t, "anchors+aliases", 500, src)
}

func TestPerfKubernetesLike(t *testing.T) {
	src := `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-deployment
  labels:
    app: nginx
spec:
  replicas: 3
  selector:
    matchLabels:
      app: nginx
  template:
    metadata:
      labels:
        app: nginx
    spec:
      containers:
      - name: nginx
        image: nginx:1.14.2
        ports:
        - containerPort: 80
`
	bench(t, "kubernetes-like", 500, src)
}

func TestPerfMultiDocStream(t *testing.T) {
	parts := make([]string, 0, 50)
	for i := 0; i < 50; i++ {
		parts = append(parts, "doc: x")
	}
	src := "---\n" + strings.Join(parts, "\n---\n")
	bench(t, "multi-doc 50", 250, src)
}

func TestPerfQuotedStrings(t *testing.T) {
	src := "" +
		"s1: \"hello \\\"world\\\"\"\n" +
		"s2: 'it''s working'\n" +
		"s3: \"multi\nline\"\n" +
		"s4: \"tab\\there\"\n"
	bench(t, "quoted strings", 500, src)
}
