import { describe, expect, test } from '@jest/globals';
import {
    extractChatCompletionResponseMetadata,
    hasChatCompletionResponseMetadata,
    mergeChatCompletionResponseMetadata,
} from '../public/scripts/chat-completion-metadata.js';

describe('chat completion response metadata', () => {
    test('extracts usage and x_nanogpt_pricing from a non-stream response', () => {
        const metadata = extractChatCompletionResponseMetadata({
            usage: { prompt_tokens: 12, completion_tokens: 4 },
            x_nanogpt_pricing: { amount: '0.000001', currency: 'USD' },
        });

        expect(metadata).toEqual({
            usage: { prompt_tokens: 12, completion_tokens: 4 },
            providerMetadata: {
                x_nanogpt_pricing: { amount: '0.000001', currency: 'USD' },
            },
        });
        expect(hasChatCompletionResponseMetadata(metadata)).toBe(true);
    });

    test('extracts x_nanogpt_cache', () => {
        const metadata = extractChatCompletionResponseMetadata({
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
            x_nanogpt_cache: { cache_read_tokens: 8, cache_write_tokens: 2 },
        });

        expect(metadata.providerMetadata).toEqual({
            x_nanogpt_cache: { cache_read_tokens: 8, cache_write_tokens: 2 },
        });
    });

    test('ignores non-x response payload such as choices', () => {
        const metadata = extractChatCompletionResponseMetadata({
            choices: [{ message: { content: 'secret response' } }],
            model: 'example-model',
            x_provider: { trace: 'safe' },
        });

        expect(metadata).toEqual({
            usage: null,
            providerMetadata: {
                x_provider: { trace: 'safe' },
            },
        });
    });

    test('sanitizes sensitive provider metadata keys', () => {
        const metadata = extractChatCompletionResponseMetadata({
            x_provider: {
                account_id: 'acct-1',
                api_key: 'key',
                nested: {
                    email: 'user@example.com',
                    kept: true,
                },
                cost: 0.01,
            },
        });

        expect(metadata.providerMetadata).toEqual({
            x_provider: {
                nested: { kept: true },
                cost: 0.01,
            },
        });
    });

    test('truncates long strings and arrays', () => {
        const metadata = extractChatCompletionResponseMetadata({
            x_provider: {
                text: 'x'.repeat(600),
                items: Array.from({ length: 40 }, (_, index) => index),
            },
        });

        expect(metadata.providerMetadata.x_provider.text).toHaveLength(512);
        expect(metadata.providerMetadata.x_provider.items).toHaveLength(32);
    });

    test('merges streaming metadata chunks, keeping latest usage and accumulated provider metadata', () => {
        const first = extractChatCompletionResponseMetadata({
            usage: { prompt_tokens: 10, completion_tokens: 1 },
            x_nanogpt_cache: { cache_read_tokens: 2 },
        });
        const second = extractChatCompletionResponseMetadata({
            usage: { prompt_tokens: 10, completion_tokens: 4 },
            x_nanogpt_pricing: { amount: '0.000004' },
        });

        const merged = mergeChatCompletionResponseMetadata(first, second);

        expect(merged).toEqual({
            usage: { prompt_tokens: 10, completion_tokens: 4 },
            providerMetadata: {
                x_nanogpt_cache: { cache_read_tokens: 2 },
                x_nanogpt_pricing: { amount: '0.000004' },
            },
        });
    });

    test('returns empty metadata for ordinary chunks without usage/provider metadata', () => {
        const metadata = extractChatCompletionResponseMetadata({
            choices: [{ delta: { content: 'hello' } }],
        });

        expect(metadata).toEqual({ usage: null, providerMetadata: {} });
        expect(hasChatCompletionResponseMetadata(metadata)).toBe(false);
    });
});
