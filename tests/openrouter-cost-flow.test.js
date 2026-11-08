import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { extractOpenRouterResponseMetadata } from '../public/scripts/chat-completion-metadata.js';

// Exercise the actual request reader and stream lifecycle without booting the
// application's DOM, tokenizer workers, or making paid provider requests.
const openai = readFileSync(new URL('../public/scripts/openai.js', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const requestCode = openai.slice(openai.indexOf('async function sendOpenAIRequest('), openai.indexOf('\n/**\n * Extracts the reply'));
const lifecycleCode = script.slice(script.indexOf('async function emitChatCompletionResponseMetadata('), script.indexOf('\n/**\n * Constructs a prompt'));
const saveStart = script.indexOf('export async function saveReply(');
const saveCode = script.slice(saveStart, script.indexOf('\n}\n', saveStart) + 2).replace('export ', '');

function harness({ stream = true, chunks = [], data = {}, source = 'openrouter' } = {}) {
    const events = [];
    const settings = { chat_completion_source: source, model: 'original/model' };
    const context = {
        AbortController, structuredClone, extractOpenRouterResponseMetadata,
        oai_settings: settings, main_api: 'openai',
        getChatCompletionModel: settings => settings.model,
        createGenerationParameters: async () => ({ generate_data: {}, stream, canMultiSwipe: false }),
        eventSource: { emit: async (name, payload) => events.push({ name, payload }) },
        event_types: { CHAT_COMPLETION_RESPONSE_METADATA: 'metadata', MESSAGE_RECEIVED: 'received', CHARACTER_MESSAGE_RENDERED: 'rendered' },
        getRequestHeaders: () => ({}),
        fetch: async () => ({ ok: true, body: { pipeThrough() {} }, json: async () => data }),
        getEventSourceStream: () => ({ readable: { getReader: () => ({
            async read() {
                if (!chunks.length) return { done: true };
                const chunk = chunks.shift();
                if (chunk instanceof Error) throw chunk;
                return { value: { data: typeof chunk === 'string' ? chunk : JSON.stringify(chunk) } };
            },
        }) } }),
        tryParseStreamingError() {}, checkQuotaError() {}, checkModerationError() {},
        getStreamingReply: data => data.choices?.[0]?.delta?.content ?? '',
        ToolManager: { parseToolCalls() {} }, parseChatCompletionLogprobs: () => null,
        chat: [{ extra: {}, swipe_id: 1, swipe_info: [{ extra: {} }, { extra: {} }] }],
        document: { querySelector: () => null },
        ReasoningHandler: class { async finish() {} updateReasoning() {} },
        chatElement: { find: () => ({}) }, addCopyToCodeBlocks() {},
        syncMesToSwipe() {}, saveLogprobsForActiveMessage() {}, updateSwipeCounter() {},
        power_user: {}, saveChatConditional: async () => events.push({ name: 'save' }),
        playMessageSound() {}, getStoppingStrings: () => [],
        Stopwatch: class { async tick(fn) { await fn(); } },
        console: { warn() {}, error() {}, debug() {} },
        generation_started: new Date(), name2: 'Assistant', selected_group: null,
        getGeneratingApi: () => source, getGeneratingModel: () => settings.model,
        getMessageTimeStamp: () => 'now', processImageAttachment: async () => {},
        addOneMessage() {}, statMesProcess() {}, characters: [], this_chid: 0,
    };
    vm.createContext(context);
    const request = vm.runInContext(`${requestCode}\nsendOpenAIRequest`, context);
    const Processor = vm.runInContext(`${lifecycleCode}\nStreamingProcessor`, context);
    const saveReply = vm.runInContext(`${saveCode}\nsaveReply`, context);
    const processor = new Processor('continue', false, new Date(), '', {});
    processor.messageId = 0;
    processor.onProgressStreaming = async () => {};
    processor.markUIGenStopped = () => {};
    return { request, processor, context, settings, events, saveReply };
}

describe('OpenRouter billing handoff', () => {
    test('terminal SSE usage reaches the saved swipe before saving, with the original request model', async () => {
        const h = harness({ chunks: [
            { choices: [{ delta: { content: 'hello' } }] },
            { choices: [], usage: { cost: 0.003, prompt_tokens: 20, completion_tokens: 2 } },
            '[DONE]',
        ] });
        h.processor.generator = await h.request('continue', [], null);
        h.settings.model = 'different/model';
        await h.processor.generate();
        await h.processor.onFinishStreaming(0, 'hello');
        const metadata = h.events.find(event => event.name === 'metadata').payload;
        expect(metadata).toMatchObject({ messageId: 0, swipeId: 1, originalType: 'continue', fromStreaming: true, model: 'original/model', usage: { cost: 0.003 } });
        expect(h.events.findIndex(event => event.name === 'metadata')).toBeLessThan(h.events.findIndex(event => event.name === 'save'));
        await h.processor.finalizeIntermediaryMessage(0, 'hello', { unlockUI: false });
        expect(h.events.filter(event => event.name === 'metadata')).toHaveLength(1);
    });

    test('stream failure emits missing usage for the saved message', async () => {
        const h = harness({ chunks: [{ choices: [{ delta: { content: 'partial' } }] }, new Error('connection lost')] });
        h.processor.generator = await h.request('continue', [], null);
        await h.processor.generate();
        expect(h.events.find(event => event.name === 'metadata').payload.usage).toBeNull();
    });

    test('a stopped response without any chunks still invalidates the old price', async () => {
        const h = harness();
        h.processor.onStopStreaming();
        await h.processor.onFinishStreaming(0, 'partial');
        expect(h.events.find(event => event.name === 'metadata').payload.usage).toBeNull();
    });

    test('non-streaming responses carry zero cost and the event preserves continuation type', async () => {
        const h = harness({ stream: false, data: { choices: [], usage: { cost: 0, prompt_tokens: 5, completion_tokens: 1 } } });
        const data = await h.request('quiet', [], null);
        const emit = vm.runInContext('emitChatCompletionResponseMetadata', h.context);
        await emit(0, 'appendFinal', 'continue', false, data.responseMetadata);
        expect(h.events.find(event => event.name === 'metadata').payload).toMatchObject({ usage: { cost: 0 }, originalType: 'continue', fromStreaming: false });
    });

    test('other providers signal an unpriced response but impersonation emits nothing', async () => {
        const h = harness({ source: 'openai' });
        await h.processor.onFinishStreaming(0, 'text');
        const emit = vm.runInContext('emitChatCompletionResponseMetadata', h.context);
        await emit(0, 'impersonate', 'impersonate', true, { usage: { cost: 1 } });
        expect(h.events.filter(event => event.name === 'metadata')).toHaveLength(1);
        expect(h.events.find(event => event.name === 'metadata').payload).toMatchObject({ usage: null, chatCompletionSource: null });
    });

    test('priced and unpriced continuations publish billing before Quick Reply callbacks', async () => {
        const results = await Promise.all([null, { usage: { cost: 0.003 }, chatCompletionSource: 'openrouter' }].map(async metadata => {
            const h = harness();
            let renderedBilling;
            h.context.chat[0].swipes = ['original', 'selected'];
            h.context.eventSource.emit = async (name, payload) => {
                h.events.push({ name, payload });
                if (name === 'metadata') h.context.chat[payload.messageId].extra.billing = payload.usage;
                if (name === 'rendered') {
                    // A nested quiet request returns data but saves no chat message.
                    const quiet = harness({ stream: false });
                    await quiet.request('quiet', [], null);
                    renderedBilling = h.context.chat[0].extra.billing;
                }
            };
            await h.saveReply({ type: 'appendFinal', originalType: 'continue', getMessage: 'continued', responseMetadata: metadata });
            return { renderedBilling, stored: h.context.chat[0].swipe_info[1].extra.billing, events: h.events.map(event => event.name) };
        }));
        expect(results).toEqual([
            { renderedBilling: null, stored: null, events: ['metadata', 'received', 'rendered'] },
            { renderedBilling: { cost: 0.003 }, stored: { cost: 0.003 }, events: ['metadata', 'received', 'rendered'] },
        ]);
    });

    test('a saved unpriced continuation is notified before the next automatic swipe', async () => {
        const h = harness();
        h.context.chat[0].swipes = ['original', 'selected'];
        await h.saveReply({ type: 'appendFinal', originalType: 'continue', getMessage: 'filtered continuation', responseMetadata: null });
        h.context.chat[0].swipe_id = 2;
        await h.saveReply({ type: 'swipe', getMessage: 'retry', responseMetadata: { usage: { cost: 0.01 } } });
        const messages = h.events.filter(event => event.name === 'metadata');
        expect(messages.map(event => [event.payload.swipeId, event.payload.usage])).toEqual([[1, null], [2, { cost: 0.01 }]]);
    });

    test('extra streaming swipe candidates cannot inherit an old OpenRouter price', async () => {
        const h = harness({ source: 'openai' });
        h.context.chat[0].extra.billing = 0.01;
        h.context.chat[0].swipes = ['original', 'selected'];
        h.processor.type = 'swipe';
        h.processor.swipes = ['extra candidate'];
        h.context.parseReasoningInSwipes = () => {};
        const listeners = { metadata: payload => { h.context.chat[payload.messageId].extra.billing = payload.usage; } };
        h.context.eventSource.emit = async (name, payload) => listeners[name]?.(payload);
        await h.processor.onFinishStreaming(0, 'selected');
        expect(h.context.chat[0].swipe_info.at(-1).extra.billing).toBeNull();
    });
});
