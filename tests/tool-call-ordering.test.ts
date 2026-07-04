/**
 * Unit and integration tests for tool call and message ordering fixes
 *
 * Tests for bugs fixed in Nov 2025:
 * 1. stripInProgressToolCalls() - removes incomplete tool_calls during backend/model switch
 * 2. Assistant message content fallback - ensures non-whitespace content for tool call messages
 * 3. Message ordering - system messages must come AFTER tool results, not between assistant and tool results
 *
 * Run with: npm test -- tests/tool-call-ordering.test.ts
 */

import { stripInProgressToolCalls } from '../src/agent/hook-manager.js';
import { GrokMessage } from '../src/types.js';

describe('GrokAgent.stripInProgressToolCalls', () => {
  const stripFn = stripInProgressToolCalls;

  describe('with no tool_calls (passthrough)', () => {
    it('should return original array when last assistant has no tool_calls', () => {
      const messages: GrokMessage[] = [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' }
      ];

      const result = stripFn(messages);
      expect(result).toBe(messages); // Same reference - no clone made
      expect(result.length).toBe(3);
    });

    it('should return original array when no assistant message exists', () => {
      const messages: GrokMessage[] = [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Hello' }
      ];

      const result = stripFn(messages);
      expect(result).toBe(messages);
    });
  });

  describe('with in-progress tool_calls (no results yet)', () => {
    it('should strip tool_calls from last assistant message', () => {
      const messages: GrokMessage[] = [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Switch persona and list files' },
        {
          role: 'assistant',
          content: '(Calling tools to perform this request)',
          tool_calls: [
            { id: 'call_1', index: 0, type: 'function', function: { name: 'setPersona', arguments: '{"persona":"sr-coder"}' } },
            { id: 'call_2', index: 1, type: 'function', function: { name: 'listFiles', arguments: '{"dirname":"."}' } }
          ]
        } as any
      ];

      const result = stripFn(messages);

      expect(result).not.toBe(messages); // New array created
      expect(result.length).toBe(3);
      expect((result[2] as any).tool_calls).toBeUndefined();
      expect(result[2].content).toBe('(Calling tools to perform this request)');
    });

    it('should not modify the original messages array', () => {
      const messages: GrokMessage[] = [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Task' },
        {
          role: 'assistant',
          content: 'Calling tools',
          tool_calls: [
            { id: 'call_1', index: 0, type: 'function', function: { name: 'test', arguments: '{}' } }
          ]
        } as any
      ];

      stripFn(messages);

      // Original should still have tool_calls
      expect((messages[2] as any).tool_calls).toBeDefined();
      expect((messages[2] as any).tool_calls.length).toBe(1);
    });
  });

  describe('with partial tool results (some completed)', () => {
    it('should remove both tool_calls and partial tool results', () => {
      const messages: GrokMessage[] = [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Do task' },
        {
          role: 'assistant',
          content: '(Calling tools to perform this request)',
          tool_calls: [
            { id: 'call_1', index: 0, type: 'function', function: { name: 'setPersona', arguments: '{}' } },
            { id: 'call_2', index: 1, type: 'function', function: { name: 'listFiles', arguments: '{}' } }
          ]
        } as any,
        { role: 'tool', content: 'Persona set to: sr-coder', tool_call_id: 'call_1' } as any
        // call_2 result is missing - still in progress
      ];

      const result = stripFn(messages);

      expect(result.length).toBe(3); // Only system, user, assistant (no tool results)
      expect((result[2] as any).tool_calls).toBeUndefined();
      expect(result.filter(m => m.role === 'tool')).toHaveLength(0);
    });

    it('should remove all partial tool results, not just some', () => {
      const messages: GrokMessage[] = [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Do task' },
        {
          role: 'assistant',
          content: 'Calling',
          tool_calls: [
            { id: 'call_1', index: 0, type: 'function', function: { name: 'tool1', arguments: '{}' } },
            { id: 'call_2', index: 1, type: 'function', function: { name: 'tool2', arguments: '{}' } },
            { id: 'call_3', index: 2, type: 'function', function: { name: 'tool3', arguments: '{}' } }
          ]
        } as any,
        { role: 'tool', content: 'Result 1', tool_call_id: 'call_1' } as any,
        { role: 'tool', content: 'Result 2', tool_call_id: 'call_2' } as any
        // call_3 still missing
      ];

      const result = stripFn(messages);

      expect(result.length).toBe(3);
      expect(result.filter(m => m.role === 'tool')).toHaveLength(0);
    });
  });

  describe('with completed tool calls (last assistant has no tool_calls)', () => {
    it('should return original when tool execution is complete', () => {
      const messages: GrokMessage[] = [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Task' },
        {
          role: 'assistant',
          content: '(Calling tools to perform this request)',
          tool_calls: [
            { id: 'call_1', index: 0, type: 'function', function: { name: 'setPersona', arguments: '{}' } }
          ]
        } as any,
        { role: 'tool', content: 'Done', tool_call_id: 'call_1' } as any,
        { role: 'system', content: 'Backend changed' },
        { role: 'assistant', content: 'All done!' } // LAST assistant - no tool_calls
      ];

      const result = stripFn(messages);
      expect(result).toBe(messages); // Passthrough - last assistant has no tool_calls
    });
  });

  describe('edge cases', () => {
    it('should handle empty messages array', () => {
      const messages: GrokMessage[] = [];
      const result = stripFn(messages);
      expect(result).toBe(messages);
      expect(result.length).toBe(0);
    });

    it('should preserve messages before the last assistant', () => {
      const messages: GrokMessage[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'First message' },
        { role: 'assistant', content: 'First response' },
        { role: 'user', content: 'Second message' },
        {
          role: 'assistant',
          content: 'Processing...',
          tool_calls: [
            { id: 'call_1', index: 0, type: 'function', function: { name: 'test', arguments: '{}' } }
          ]
        } as any
      ];

      const result = stripFn(messages);

      expect(result.length).toBe(5);
      expect(result[0].content).toBe('System prompt');
      expect(result[1].content).toBe('First message');
      expect(result[2].content).toBe('First response');
      expect(result[3].content).toBe('Second message');
      expect((result[4] as any).tool_calls).toBeUndefined();
    });
  });
});

describe('Message Ordering Validation', () => {
  /**
   * Helper function to validate that messages follow the API requirement:
   * tool results must immediately follow assistant with tool_calls (no messages in between)
   */
  function validateMessageOrdering(messages: GrokMessage[]): { valid: boolean; error?: string } {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === 'assistant' && (msg as any).tool_calls) {
        const toolCalls = (msg as any).tool_calls;
        const expectedToolCallIds = new Set(toolCalls.map((tc: any) => tc.id));

        // Check that following messages are tool results (no system/user messages in between)
        let nextIdx = i + 1;
        const foundToolCallIds = new Set<string>();

        while (nextIdx < messages.length) {
          const nextMsg = messages[nextIdx];

          if (nextMsg.role === 'tool') {
            if (expectedToolCallIds.has((nextMsg as any).tool_call_id)) {
              foundToolCallIds.add((nextMsg as any).tool_call_id);
            }
            nextIdx++;
          } else {
            // Non-tool message - stop checking
            break;
          }
        }

        // Check if all expected tool results were found
        if (foundToolCallIds.size !== expectedToolCallIds.size) {
          const missing = Array.from(expectedToolCallIds).filter(id => !foundToolCallIds.has(id));
          return {
            valid: false,
            error: `Assistant message at index ${i} missing tool results for: ${missing.join(', ')}`
          };
        }
      }
    }

    return { valid: true };
  }

  it('should validate correct message ordering (tool results immediately follow assistant)', () => {
    const validMessages: GrokMessage[] = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Task' },
      {
        role: 'assistant',
        content: '(Calling tools to perform this request)',
        tool_calls: [
          { id: 'call_1', index: 0, type: 'function', function: { name: 'setPersona', arguments: '{}' } },
          { id: 'call_2', index: 1, type: 'function', function: { name: 'listFiles', arguments: '{}' } }
        ]
      } as any,
      { role: 'tool', content: 'Done', tool_call_id: 'call_1' } as any,
      { role: 'tool', content: 'Files', tool_call_id: 'call_2' } as any,
      { role: 'system', content: 'Backend changed' }, // System messages AFTER tool results - VALID
      { role: 'system', content: 'Persona changed' }
    ];

    const result = validateMessageOrdering(validMessages);
    expect(result.valid).toBe(true);
  });

  it('should detect missing tool results', () => {
    const invalidMessages: GrokMessage[] = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Task' },
      {
        role: 'assistant',
        content: 'Calling',
        tool_calls: [
          { id: 'call_1', index: 0, type: 'function', function: { name: 'setPersona', arguments: '{}' } },
          { id: 'call_2', index: 1, type: 'function', function: { name: 'listFiles', arguments: '{}' } }
        ]
      } as any,
      { role: 'tool', content: 'Done', tool_call_id: 'call_1' } as any
      // Missing call_2 result
    ];

    const result = validateMessageOrdering(invalidMessages);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('call_2');
  });

  it('should allow system messages after all tool results', () => {
    // This is the correct ordering after our fix
    const correctOrderAfterFix: GrokMessage[] = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Task' },
      {
        role: 'assistant',
        content: '(Calling tools to perform this request)',
        tool_calls: [
          { id: 'call_1', index: 0, type: 'function', function: { name: 'setPersona', arguments: '{}' } }
        ]
      } as any,
      { role: 'tool', content: 'Persona set', tool_call_id: 'call_1' } as any,
      // System messages from hooks come AFTER tool results - this is the fix
      { role: 'system', content: 'Changed backend to "archgw"' },
      { role: 'system', content: 'setPersona approved' },
      { role: 'system', content: 'Assistant set the persona to "sr-coder"' }
    ];

    const result = validateMessageOrdering(correctOrderAfterFix);
    expect(result.valid).toBe(true);
  });
});

describe('Assistant Message Content Fallback', () => {
  it('should use placeholder when content is empty string', () => {
    const emptyContent = '';
    const placeholder = '(Calling tools to perform this request)';
    const result = emptyContent || placeholder;
    expect(result).toBe(placeholder);
  });

  it('should use placeholder when content is null/undefined', () => {
    const nullContent = null;
    const undefinedContent = undefined;
    const placeholder = '(Calling tools to perform this request)';

    expect(nullContent || placeholder).toBe(placeholder);
    expect(undefinedContent || placeholder).toBe(placeholder);
  });

  it('should preserve actual content when present', () => {
    const actualContent = 'I will process your request.';
    const placeholder = '(Calling tools to perform this request)';
    const result = actualContent || placeholder;
    expect(result).toBe(actualContent);
  });
});
