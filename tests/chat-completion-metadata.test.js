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

    test('extracts OpenRouter usage and routing metadata', () => {
        const metadata = extractChatCompletionResponseMetadata({
            usage: {
                prompt_tokens: 12,
                completion_tokens: 4,
                cost: 0.00042,
                cost_details: { upstream_inference_cost: 0.0004 },
            },
            openrouter_metadata: {
                requested: 'openai/gpt-4o-mini',
                strategy: 'direct',
                region: 'iad',
                endpoints: {
                    total: 1,
                    available: [{ provider: 'OpenAI', model: 'openai/gpt-4o-mini', selected: true }],
                },
            },
        });

        expect(metadata).toEqual({
            usage: {
                prompt_tokens: 12,
                completion_tokens: 4,
                cost: 0.00042,
                cost_details: { upstream_inference_cost: 0.0004 },
            },
            providerMetadata: {
                openrouter_metadata: {
                    requested: 'openai/gpt-4o-mini',
                    strategy: 'direct',
                    region: 'iad',
                    endpoints: {
                        total: 1,
                        available: [{ provider: 'OpenAI', model: 'openai/gpt-4o-mini', selected: true }],
                    },
                },
            },
        });
    });

    test('keeps OpenRouter usage when routing metadata is absent', () => {
        const metadata = extractChatCompletionResponseMetadata({
            usage: { prompt_tokens: 12, completion_tokens: 4, cost: 0.00042 },
        });

        expect(metadata).toEqual({
            usage: { prompt_tokens: 12, completion_tokens: 4, cost: 0.00042 },
            providerMetadata: {},
        });
        expect(hasChatCompletionResponseMetadata(metadata)).toBe(true);
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

    test('merges OpenRouter metadata from the terminal streaming chunk', () => {
        const initial = extractChatCompletionResponseMetadata({
            choices: [{ delta: { content: 'hello' } }],
        });
        const terminal = extractChatCompletionResponseMetadata({
            usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0002 },
            openrouter_metadata: {
                strategy: 'fallback',
                attempt: 2,
                attempts: [
                    { provider: 'Provider A', model: 'example/model', status: 429 },
                    { provider: 'Provider B', model: 'example/model', status: 200 },
                ],
            },
        });

        expect(mergeChatCompletionResponseMetadata(initial, terminal)).toEqual({
            usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0002 },
            providerMetadata: {
                openrouter_metadata: {
                    strategy: 'fallback',
                    attempt: 2,
                    attempts: [
                        { provider: 'Provider A', model: 'example/model', status: 429 },
                        { provider: 'Provider B', model: 'example/model', status: 200 },
                    ],
                },
            },
        });
    });

    test('sanitizes sensitive fields inside OpenRouter metadata', () => {
        const metadata = extractChatCompletionResponseMetadata({
            openrouter_metadata: {
                strategy: 'direct',
                account_id: 'acct-1',
                pipeline: [{
                    type: 'guardrail',
                    data: {
                        email: 'user@example.com',
                        blocked: false,
                    },
                }],
            },
        });

        expect(metadata.providerMetadata).toEqual({
            openrouter_metadata: {
                strategy: 'direct',
                pipeline: [{
                    type: 'guardrail',
                    data: { blocked: false },
                }],
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
