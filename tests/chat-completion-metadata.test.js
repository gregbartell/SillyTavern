import { describe, expect, test } from '@jest/globals';
import { extractOpenRouterResponseMetadata } from '../public/scripts/chat-completion-metadata.js';

describe('OpenRouter response metadata', () => {
    test('exposes actual cost and token counts without response content or private metadata', () => {
        expect(extractOpenRouterResponseMetadata({
            choices: [{ message: { content: 'private chat' } }],
            usage: {
                cost: 0.0012, prompt_tokens: 100, completion_tokens: 20,
                prompt_tokens_details: { cached_tokens: 50, account_id: 'private' },
                completion_tokens_details: { reasoning_tokens: 10 },
                account_id: 'private',
            },
        }, 'openrouter', 'example/model')).toEqual({
            chatCompletionSource: 'openrouter', model: 'example/model', providerMetadata: {},
            usage: {
                cost: 0.0012, prompt_tokens: 100, completion_tokens: 20,
                prompt_tokens_details: { cached_tokens: 50 },
                completion_tokens_details: { reasoning_tokens: 10 },
            },
        });
    });

    test('preserves zero cost and reports absent usage instead of inventing a charge', () => {
        expect(extractOpenRouterResponseMetadata({ usage: { cost: 0 } }, 'openrouter', 'free').usage.cost).toBe(0);
        expect(extractOpenRouterResponseMetadata({}, 'openrouter', 'model').usage).toBeNull();
    });

    test('rejects invalid amounts and leaves other providers alone', () => {
        expect(extractOpenRouterResponseMetadata({ usage: { cost: -1, prompt_tokens: Infinity } }, 'openrouter', 'model').usage).toEqual({});
        expect(extractOpenRouterResponseMetadata({ usage: { cost: 1 } }, 'nanogpt', 'model')).toBeNull();
    });
});
