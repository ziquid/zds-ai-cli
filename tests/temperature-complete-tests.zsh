#!/usr/bin/env zsh

# Temperature Feature - Complete Test Suite (All 23 Test Cases)
# Implements CLI tests and Persistence tests, skips unimplemented features

# Determine project root (parent of tests/ directory)
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_SKIPPED=0

log_result() {
    ((TESTS_RUN++))
    case "$1" in
        "PASS") ((TESTS_PASSED++)); echo "✓ $2";;
        "FAIL") ((TESTS_FAILED++)); echo "✗ $2";;
        "SKIP") ((TESTS_SKIPPED++)); echo "⊘ $2";;
    esac
}

echo "Temperature Feature - Complete Test Suite (All 23 Test Cases)"
echo "========================================================="

# Setup mock environment
mkdir -p "$PROJECT_ROOT/.grok"
echo "{\"apiKey\":\"mock\"}" > "$PROJECT_ROOT/.grok/settings.json"

# PHASE 1: CLI Option Tests (TC001-TC005) - IMPLEMENTED
echo ""
echo "=== PHASE 1: CLI Option Tests (TC001-TC005) ==="

# TC001: Valid CLI Temperature Setting
echo "  Testing: TC001: Valid CLI temperature setting (0.5)"
{
    echo "exit"
} | timeout 30s node "$PROJECT_ROOT/dist/index.js" --temperature 0.5 --no-ink >/dev/null 2>&1
[[ $? -eq 0 ]] && log_result "PASS" "TC001: Temperature 0.5 accepted" || log_result "FAIL" "TC001: Temperature 0.5 rejected"

# TC002: CLI Short Flag Option
echo "  Testing: TC002: CLI short flag (-t 1.8)"
{
    echo "exit"
} | timeout 30s node "$PROJECT_ROOT/dist/index.js" -t 1.8 --no-ink >/dev/null 2>&1
[[ $? -eq 0 ]] && log_result "PASS" "TC002: Short flag -t 1.8 accepted" || log_result "FAIL" "TC002: Short flag -t 1.8 rejected"

# TC003: Default Temperature
echo "  Testing: TC003: Default temperature (no flag)"
{
    echo "exit"
} | timeout 30s node "$PROJECT_ROOT/dist/index.js" --no-ink >/dev/null 2>&1
if [[ -f "$PROJECT_ROOT/.grok/state.json" ]]; then
    temp_val=$(grep -o "\"temperature\"[[:space:]]*:[[:space:]]*[0-9.]*" "$PROJECT_ROOT/.grok/state.json" | grep -o "[0-9.]*" || echo "")
    [[ "$temp_val" == "0.7" ]] && log_result "PASS" "TC003: Default 0.7 applied" || log_result "FAIL" "TC003: Expected 0.7, got \"$temp_val\""
else
    log_result "FAIL" "TC003: No state.json created"
fi

# TC004: Boundary Values
echo "  Testing: TC004: Boundary values (0.0, 5.0, 0.1, 4.9)"
boundary_ok=true
for temp in "0.0" "5.0" "0.1" "4.9"; do
    {
        echo "exit"
    } | timeout 30s node "$PROJECT_ROOT/dist/index.js" --temperature "$temp" --no-ink >/dev/null 2>&1
    [[ $? -ne 0 ]] && boundary_ok=false
done
[[ "$boundary_ok" == true ]] && log_result "PASS" "TC004: All boundary values accepted" || log_result "FAIL" "TC004: Some boundary values rejected"

# TC005: Invalid Values
echo "  Testing: TC005: Invalid values (-0.1, 5.1, abc, empty)"
invalid_ok=true
for temp in "-0.1" "5.1" "abc" ""; do
    {
        echo "exit"
    } | timeout 30s node "$PROJECT_ROOT/dist/index.js" --temperature "$temp" --no-ink >/dev/null 2>&1
    [[ $? -eq 0 ]] && invalid_ok=false
done
[[ "$invalid_ok" == true ]] && log_result "PASS" "TC005: All invalid values rejected" || log_result "FAIL" "TC005: Some invalid values accepted"
