import { describe, expect, test } from '@jest/globals';
import {
    createNanoGptBillingEntryFromResponse,
    formatNanoGptBillingDisplay,
    mergeNanoGptBillingMetadata,
} from '../public/scripts/nanogpt-billing.js';

function makeResponse({
    provider = 'Auto',
    model = 'moonshotai/kimi-k2.6',
    cost = 0.000001,
    promptTokens = 1234,
    completionTokens = 567,
    pricing = {},
    usage = {},
} = {}) {
    return {
        model,
        x_nanogpt_pricing: {
            provider,
            model,
            cost,
            account_id: 'acct-secret',
            payment_id: 'pay-secret',
            ...pricing,
        },
        usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            team_id: 'team-secret',
            ...usage,
        },
    };
}

describe('NanoGPT billing metadata', () => {
    test('captures exact non-stream metadata and sanitizes identifiers', () => {
        const entry = createNanoGptBillingEntryFromResponse(makeResponse(), 'normal', 1760000000000);

        expect(entry).toMatchObject({
            provider: 'Auto',
            model: 'moonshotai/kimi-k2.6',
            created_at: 1760000000000,
            type: 'normal',
        });
        expect(entry.pricing.account_id).toBeUndefined();
        expect(entry.pricing.payment_id).toBeUndefined();
        expect(entry.usage.team_id).toBeUndefined();

        const display = formatNanoGptBillingDisplay({ requests: [entry] });
        expect(display.line1).toBe('cost: $0.000001 in/out: 1234t/567t');
        expect(display.line2).toBe('provider: Auto model: moonshotai/kimi-k2.6');
    });

    test('captures final stream chunk metadata and ignores partial chunks', () => {
        expect(createNanoGptBillingEntryFromResponse({ choices: [{ delta: { content: 'hi' } }] }, 'normal')).toBeNull();

        const finalChunk = {
            choices: [],
            ...makeResponse({ cost: 0.000002, promptTokens: 10, completionTokens: 5 }),
        };
        const entry = createNanoGptBillingEntryFromResponse(finalChunk, 'normal', 1760000000001);

        expect(formatNanoGptBillingDisplay({ requests: [entry] }).line1).toBe('cost: $0.000002 in/out: 10t/5t');
    });

    test('formats cache read/write, cache cost, and TTL when exact values exist', () => {
        const entry = createNanoGptBillingEntryFromResponse(makeResponse({
            cost: 0.000003,
            pricing: {
                cache_cost: 0.000002,
                cache_ttl_seconds: 300,
            },
            usage: {
                cache_read_tokens: 1000,
                cache_write_tokens: 500,
            },
        }));

        const display = formatNanoGptBillingDisplay({ requests: [entry] });
        expect(display.line1).toBe('cost: $0.000003 in/out: 1234t/567t cache r/w: 1000t/500t cache cost: $0.000002 TTL: 5m');
    });

    test('omits missing, zero, and inexact cache fields', () => {
        const noCache = createNanoGptBillingEntryFromResponse(makeResponse({
            pricing: { cache_cost: 0 },
            usage: { cache_read_tokens: 0, cache_write_tokens: 0 },
        }));
        expect(formatNanoGptBillingDisplay({ requests: [noCache] }).line1).toBe('cost: $0.000001 in/out: 1234t/567t');

        const missingCacheCost = createNanoGptBillingEntryFromResponse(makeResponse({
            usage: { cache_read_tokens: 1000, cache_write_tokens: 500 },
        }));
        const display = formatNanoGptBillingDisplay({ requests: [missingCacheCost] });

        expect(display.line1).toContain('cache r/w: 1000t/500t');
        expect(display.line1).not.toContain('cache cost');
    });

    test('returns no display for missing billing metadata', () => {
        expect(createNanoGptBillingEntryFromResponse({ usage: { prompt_tokens: 1, completion_tokens: 1 } })).toBeNull();
        expect(createNanoGptBillingEntryFromResponse({ x_nanogpt_pricing: { cost: 1 } })).toBeNull();
        expect(formatNanoGptBillingDisplay({ requests: [] })).toBeNull();
    });

    test('incomplete accumulated metadata preserves requests but shows nothing', () => {
        const first = createNanoGptBillingEntryFromResponse(makeResponse());
        const metadata = mergeNanoGptBillingMetadata(undefined, first);
        metadata.incomplete = true;

        expect(metadata.requests).toHaveLength(1);
        expect(formatNanoGptBillingDisplay(metadata)).toBeNull();
    });

    test('append/continue accumulates totals and shows request count with mixed TTL', () => {
        const first = createNanoGptBillingEntryFromResponse(makeResponse({
            cost: 0.000001,
            promptTokens: 100,
            completionTokens: 20,
            pricing: { cache_ttl_seconds: 300 },
        }), 'normal');
        const second = createNanoGptBillingEntryFromResponse(makeResponse({
            provider: 'Other',
            model: 'other/model',
            cost: 0.000002,
            promptTokens: 50,
            completionTokens: 30,
            pricing: { cache_ttl_seconds: 600 },
        }), 'continue');

        let metadata = mergeNanoGptBillingMetadata(undefined, first);
        metadata = mergeNanoGptBillingMetadata(metadata, second, { append: true });

        const display = formatNanoGptBillingDisplay(metadata);
        expect(display.line1).toBe('cost: $0.000003 in/out: 150t/50t TTL: mixed');
        expect(display.line2).toBe('provider: mixed model: mixed requests: 2');
        expect(display.providerTitle).toBe('Auto\nOther');
        expect(display.modelTitle).toBe('moonshotai/kimi-k2.6\nother/model');
    });

    test('selected swipe extra controls the displayed billing metadata', () => {
        const first = mergeNanoGptBillingMetadata(undefined, createNanoGptBillingEntryFromResponse(makeResponse({
            model: 'first/model',
            cost: 0.000001,
        })));
        const second = mergeNanoGptBillingMetadata(undefined, createNanoGptBillingEntryFromResponse(makeResponse({
            model: 'second/model',
            cost: 0.000002,
        })));
        const message = {
            swipe_id: 1,
            swipe_info: [
                { extra: { nanogpt: first } },
                { extra: { nanogpt: second } },
            ],
            extra: structuredClone(second),
        };

        message.extra = structuredClone(message.swipe_info[message.swipe_id].extra);

        const display = formatNanoGptBillingDisplay(message.extra.nanogpt);
        expect(display.line1).toBe('cost: $0.000002 in/out: 1234t/567t');
        expect(display.model).toBe('second/model');
    });
});
