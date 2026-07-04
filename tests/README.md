# zai-cli Test Suite

This directory contains test scripts for validating zai-cli features.

## Test Scripts

### temperature-feature-test.zsh

**Purpose:** Automated functional testing of temperature configuration feature
**Coverage:** CLI temperature flags, validation, default behavior, persistence

**Usage:**

```sh
cd /path/to/zai-cli
tests/temperature-feature-test.zsh
```

**Test Cases:**
- Valid temperature values (0.0, 0.7, 5.0)
- Invalid temperature rejection (-0.1, 5.1, non-numeric)
- Default temperature behavior (0.7)
- State persistence validation

### test-venice.js

**Purpose:** Validate Venice AI backend connection (bug fix verification)
**Coverage:** Tests that Venice AI no longer receives unsupported 'think' parameter

**Usage:**

```sh
cd /path/to/zai-cli
tests/test-venice.js
```

**Requirements:**
- VENICE_API_KEY environment variable must be set
- Project must be built (`mzke build`)

**Test Cases:**
- Venice AI connection without HTTP 400 errors
- Basic message exchange with Venice backend

### test-duplicate-json.ts

**Purpose:** Unit test for duplicate JSON handling in tool call arguments (bug fix verification)
**Coverage:** Tests that concatenated/duplicated JSON objects are properly handled

**Usage:**

```sh
cd /path/to/zai-cli
tests/test-duplicate-json.ts
```

**Requirements:**
- Project must be built (`mzke build`)

**Test Cases:**
- Exact duplicate objects
- Different duplicate objects
- Triple duplication
- Nested objects duplicated
- Arrays in duplicated objects
- Single valid JSON (regression test)
- Empty object duplicated

### test-slash-commands-headless.zsh

**Purpose:** Automated functional testing of slash commands in headless and no-ink modes (bug fix verification)
**Coverage:** Tests that slash commands work correctly in both `-p` (headless) and `--no-ink` (interactive plain) modes

**Usage:**

```sh
cd /path/to/zai-cli
tests/test-slash-commands-headless.zsh
```

**Requirements:**
- Project must be built (`mzke build`)

**Test Cases:**
- `/help` command in headless mode
- `/introspect` command in headless mode
- `/context` command in headless mode
- `/persona` command in headless mode
- `/mood` command in headless mode
- `/clear` command in headless mode
- `/models` with argument in headless mode
- `/models` without argument (error expected)
- `/context view` in headless mode (error expected)
- `/context edit` in headless mode (error expected)

### test-tool-validation.md

**Purpose:** Documentation of tool argument validation feature (bug fix documentation)
**Coverage:** Explains how tool arguments are validated against schemas to prevent Ollama 400 errors

**Context:**
- When LLMs return duplicate JSON tool arguments, the duplicate-JSON fix extracts the first object
- If the tool was called with wrong parameters (e.g., `getAvailablePersonas` with a `persona` parameter), Ollama rejects with `400 invalid tool call arguments`
- Tool validation catches these errors before sending to Ollama, providing clear feedback to the LLM

**Implementation:**
- `validateToolArguments()` method validates against tool schemas
- Checks for: no-parameter tools with arguments, unknown parameters, missing required parameters
- Returns helpful error messages instead of Ollama 400 errors

## Running Tests

Tests use mock settings to avoid API dependencies and should be executed in the project root directory.

## Test Results

Test output includes pass/fail indicators and a summary of results.

## Adding New Tests

Add new test scripts to this directory with descriptive names following the pattern: `feature-name-test.zsh`
