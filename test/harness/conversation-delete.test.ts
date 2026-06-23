import { describe, expect, it } from 'vitest';

import {
  truncateStructuredBeforeUserMessage,
  truncateUiMessagesBeforeUserMessage,
} from '../../src/harness/conversation-delete.js';
import type { UiChatMessage } from '../../src/types/intent-checkpoint.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

describe('conversation-delete', () => {
  const uiMessages: UiChatMessage[] = [
    { role: 'user', id: 'u1', content: 'hello' },
    { role: 'agent', id: 'a1', content: 'hi' },
    { role: 'user', id: 'u2', content: 'image turn', images: ['/api/sessions/x/images/1.png'] },
    { role: 'agent', id: 'a2', content: 'error' },
    { role: 'user', id: 'u3', content: 'retry' },
  ];

  const structuredMessages: UnifiedMessage[] = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'image turn' },
        { type: 'image', imageUrl: 'data:image/png;base64,abc' },
      ],
    },
    { role: 'assistant', content: 'error' },
    { role: 'user', content: 'retry' },
  ];

  it('truncateUiMessagesBeforeUserMessage keeps messages before target', () => {
    expect(truncateUiMessagesBeforeUserMessage(uiMessages, 'u2')).toEqual(uiMessages.slice(0, 2));
    expect(truncateUiMessagesBeforeUserMessage(uiMessages, 'u3')).toEqual(uiMessages.slice(0, 4));
  });

  it('truncateUiMessagesBeforeUserMessage returns null when missing', () => {
    expect(truncateUiMessagesBeforeUserMessage(uiMessages, 'missing')).toBeNull();
  });

  it('truncateStructuredBeforeUserMessage aligns with UI user turns', () => {
    expect(truncateStructuredBeforeUserMessage(structuredMessages, uiMessages, 'u2')).toEqual(
      structuredMessages.slice(0, 2),
    );
    expect(truncateStructuredBeforeUserMessage(structuredMessages, uiMessages, 'u3')).toEqual(
      structuredMessages.slice(0, 4),
    );
  });
});
