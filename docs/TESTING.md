# zai-cli getAvailablePersonas Testing

## Test Environment Setup

- Ensure zai-cli is built and installed via `mzke prig`
- Ensure persona hook is configured in `~/.zds-ai/cli-settings.json`
- Ensure `ZDS_AI_AGENT_CONFIG_FILE` points to a valid agent config with personas_available section

## Test Cases

### Test 1: getAvailablePersonas returns list of personas

1. Start zai-cli with an agent that has personas configured
2. Call the `getAvailablePersonas` tool
3. Verify output contains personas in `name:description` format
4. Expected output should include:
   - `coder:Default persona, used when writing or debugging code.`
   - `planner:Smarter persona but more expensive.  Used when planning only.`
   - `tester:Used when testing code.  Less expensive than coder or planner.`
   - `worker:Used for routine or easy tasks.  Less expensive than coder or planner.`

### Test 2: setPersona calls hook with correct operation

1. Start zai-cli
2. Call `setPersona` tool with a valid persona (e.g., "coder")
3. Check hook log file at `~/.zds-ai/logs/latest-cli.log.txt`
4. Verify log entry shows `ZDS_AI_AGENT_OPERATION=setPersona` (not persona_change)
5. Verify persona is successfully updated in status bar

### Test 3: Hook rejects invalid personas

1. Start zai-cli
2. Attempt to call `setPersona` with "romantic" persona
3. Verify hook rejects with error message
4. Verify persona is NOT changed
5. Check log file for rejection entry

### Test 4: Hook enforces business hours restriction

1. Start zai-cli during business hours (9AM-5PM weekdays)
2. Attempt to call `setPersona` with "lover" persona
3. Verify hook rejects with "Cannot switch to lover persona during business hours" message
4. Try again outside business hours (or on weekend)
5. Verify hook allows the change

### Test 5: Hook loads personas from config file

1. Start zai-cli
2. Call `getAvailablePersonas` tool
3. Verify hook successfully reads `ZDS_AI_AGENT_CONFIG_FILE`
4. Verify hook exits with error if config file is missing or invalid
5. Check log file shows personas were loaded

### Test 6: Log file location is correct

1. After running any hook operation, verify log file exists at:
   - `~/.zds-ai/logs/latest-cli.log.txt`
2. Verify log file contains hook invocation timestamp and environment variables
3. Verify separate log files are created for each day

### Test 7: Error handling for missing config

1. Unset `ZDS_AI_AGENT_CONFIG_FILE` or point it to non-existent file
2. Call `getAvailablePersonas` tool
3. Verify hook exits with code 1
4. Verify error message appears: "Failed to load personas from config file"

### Test 8: PERSONAS variable populated correctly

1. After hook loads config, verify PERSONAS shell variable contains all personas
2. In hook log, verify that yq command successfully parsed personas_available section
3. Verify each persona includes both name and description

## Success Criteria

- All test cases pass
- No errors in hook execution
- Log files created with correct naming convention
- Hook operations logged with proper environment variables
- Persona changes respect business hours validation
- Invalid personas are properly rejected
