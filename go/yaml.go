package yaml

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"

	jsonic "github.com/jsonicjs/jsonic/go"
)

// YamlOptions configures the YAML parser plugin.
// Currently empty — reserved for future extension.
type YamlOptions struct{}

// Parse parses a YAML string and returns the resulting Go value.
// The returned value can be:
//   - map[string]any for mappings
//   - []any for sequences
//   - float64 for numbers
//   - string for strings
//   - bool for booleans
//   - nil for null or empty input
func Parse(src string) (any, error) {
	j := MakeJsonic()
	return j.Parse(src)
}

// MakeJsonic creates a jsonic instance configured for YAML parsing.
func MakeJsonic(opts ...YamlOptions) *jsonic.Jsonic {
	j := jsonic.Make(jsonic.Options{
		String: &jsonic.StringOptions{
			Chars: "`", // Remove single quote from string chars; we handle YAML strings in yamlMatcher
		},
		Lex: &jsonic.LexOptions{
			EmptyResult: nil,
		},
	})

	j.Use(Yaml, nil)
	return j
}

// yamlValueMap maps YAML value keywords to their Go values.
var yamlValueMap = map[string]any{
	"true": true, "True": true, "TRUE": true,
	"false": false, "False": false, "FALSE": false,
	"null": nil, "Null": nil, "NULL": nil,
	"~": nil,
	"yes": true, "Yes": true, "YES": true,
	"no": false, "No": false, "NO": false,
	"on": true, "On": true, "ON": true,
	"off": false, "Off": false, "OFF": false,
	".inf": math.Inf(1), ".Inf": math.Inf(1), ".INF": math.Inf(1),
	"-.inf": math.Inf(-1), "-.Inf": math.Inf(-1), "-.INF": math.Inf(-1),
	".nan": math.NaN(), ".NaN": math.NaN(), ".NAN": math.NaN(),
}

// isYamlValue checks if text is a YAML value keyword and returns the value.
func isYamlValue(text string) (any, bool) {
	val, ok := yamlValueMap[text]
	return val, ok
}

// parseYamlNumber attempts to parse text as a YAML number.
// Returns the number and true if successful, or 0 and false if not a number.
func parseYamlNumber(text string) (float64, bool) {
	if text == "" {
		return 0, false
	}
	// Try standard float parsing
	num, err := strconv.ParseFloat(text, 64)
	if err == nil {
		return num, true
	}
	// Try integer formats: hex, octal, binary
	if strings.HasPrefix(text, "0x") || strings.HasPrefix(text, "0X") {
		if n, err := strconv.ParseInt(text[2:], 16, 64); err == nil {
			return float64(n), true
		}
	}
	if strings.HasPrefix(text, "0o") || strings.HasPrefix(text, "0O") {
		if n, err := strconv.ParseInt(text[2:], 8, 64); err == nil {
			return float64(n), true
		}
	}
	if strings.HasPrefix(text, "0b") || strings.HasPrefix(text, "0B") {
		if n, err := strconv.ParseInt(text[2:], 2, 64); err == nil {
			return float64(n), true
		}
	}
	// Negative hex/oct/bin
	if len(text) > 1 && text[0] == '-' {
		if num, ok := parseYamlNumber(text[1:]); ok {
			return -num, true
		}
	}
	if len(text) > 1 && text[0] == '+' {
		return parseYamlNumber(text[1:])
	}
	return 0, false
}

// deepCopy performs a JSON-based deep copy of a value.
func deepCopy(v any) any {
	if v == nil {
		return nil
	}
	switch val := v.(type) {
	case map[string]any:
		data, err := json.Marshal(val)
		if err != nil {
			return v
		}
		var result map[string]any
		if err := json.Unmarshal(data, &result); err != nil {
			return v
		}
		return result
	case []any:
		data, err := json.Marshal(val)
		if err != nil {
			return v
		}
		var result []any
		if err := json.Unmarshal(data, &result); err != nil {
			return v
		}
		return result
	default:
		return v
	}
}

// extractKey extracts a key value from a token, resolving aliases.
func extractKey(o0 *jsonic.Token, anchors map[string]any) any {
	if o0.Tin == jsonic.TinVL {
		if m, ok := o0.Val.(map[string]any); ok {
			if alias, ok := m["__yamlAlias"].(string); ok {
				if val, exists := anchors[alias]; exists {
					return val
				}
				return "*" + alias
			}
		}
	}
	if o0.Tin == jsonic.TinST || o0.Tin == jsonic.TinTX {
		if s, ok := o0.Val.(string); ok {
			return s
		}
	}
	return o0.Src
}

// anchorInfo holds anchor metadata during parsing.
type anchorInfo struct {
	name   string
	inline bool
}

// isDocMarker checks if the string at position i starts with --- or ...
// followed by a space, tab, newline, or end of string.
func isDocMarker(s string, i int) bool {
	if i+3 > len(s) {
		return false
	}
	marker := s[i : i+3]
	if marker != "---" && marker != "..." {
		return false
	}
	if i+3 >= len(s) {
		return true
	}
	next := s[i+3]
	return next == '\n' || next == '\r' || next == ' ' || next == '\t'
}

// trimRight removes trailing whitespace from a string.
func trimRight(s string) string {
	return strings.TrimRight(s, " \t")
}

// formatKey converts a value to a string suitable for use as a map key.
func formatKey(v any) string {
	switch k := v.(type) {
	case string:
		return k
	case float64:
		if k == float64(int64(k)) {
			return fmt.Sprintf("%d", int64(k))
		}
		return fmt.Sprintf("%g", k)
	case bool:
		if k {
			return "true"
		}
		return "false"
	case nil:
		return "null"
	default:
		return fmt.Sprintf("%v", v)
	}
}
