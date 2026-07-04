#!/usr/bin/env zsh

# Test script for slash commands in headless mode
# Tests the fix for bug: no-ink-slash-commands-broken

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test counters
PASSED=0
FAILED=0

# Project root
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI_PATH="$PROJECT_ROOT/dist/index.js"

# Check if built
if [[ ! -f "$CLI_PATH" ]]; then
  echo "${RED}Error: Project not built. Run 'bun run build' first.${NC}"
  exit 1
fi

echo "Testing slash commands in headless mode..."
echo ""

# Test function
test_command() {
  local test_name="$1"
  local command="$2"
  local expected_pattern="$3"
  local expect_success="${4:-true}"

  echo -n "Testing: $test_name... "

  # Run command and capture output
  local output
  local exit_code
  output=$(cd "$PROJECT_ROOT" && node "$CLI_PATH" -p "$command" --auto-approve --fresh 2>&1) || exit_code=$?
  exit_code=${exit_code:-0}

  # Check if output matches expected pattern
  if echo "$output" | grep -q "$expected_pattern"; then
    if [[ "$expect_success" == "true" && $exit_code -eq 0 ]]; then
      echo "${GREEN}PASS${NC}"
      ((PASSED++))
    elif [[ "$expect_success" == "false" ]]; then
      echo "${GREEN}PASS${NC} (expected failure)"
      ((PASSED++))
    else
      echo "${RED}FAIL${NC} (exit code: $exit_code)"
      echo "Output: $output"
      ((FAILED++))
    fi
  else
    echo "${RED}FAIL${NC}"
    echo "Expected pattern: $expected_pattern"
    echo "Actual output: $output"
    ((FAILED++))
  fi
}

# TC-1: /help command
test_command "/help" "/help" "Built-in Commands"

# TC-2: /introspect command
test_command "/introspect" "/introspect" "Introspect available tools"

# TC-3: /context command
test_command "/context" "/context" "tokens"

# TC-4: /persona command
test_command "/persona" "/persona testing blue" "Persona set to: testing"

# TC-5: /mood command
test_command "/mood" "/mood focused green" "Mood set to: focused"

# TC-6: /clear command
test_command "/clear" "/clear" "Chat history cleared"

# TC-7: /models with argument
test_command "/models with arg" "/models grok-code-fast-1" "Switched to model"

# TC-8: /models without argument (should error in headless)
test_command "/models without arg" "/models" "ERROR.*requires interactive mode" false

# TC-9: /context view (should error in headless)
test_command "/context view" "/context view" "ERROR.*requires interactive mode" false

# TC-10: /context edit (should error in headless)
test_command "/context edit" "/context edit" "ERROR.*requires interactive mode" false

# TC-11: Invalid slash command (should send to AI)
# This would actually call the AI, so we skip it in automated tests
# test_command "invalid command" "/invalidcommand" ".*"

# TC-12: Non-slash command (regression - should work normally)
# This would also call the AI, so we skip it
# test_command "regular message" "hello" ".*"

echo ""
echo "========================================="
echo "Test Results:"
echo "  ${GREEN}Passed: $PASSED${NC}"
echo "  ${RED}Failed: $FAILED${NC}"
echo "========================================="

if [[ $FAILED -gt 0 ]]; then
  exit 1
fi

exit 0
