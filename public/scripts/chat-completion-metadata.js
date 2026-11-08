/**
 * Copies only the billing fields needed by extensions. Missing usage is retained
 * so consumers can invalidate a price after an interrupted continuation.
 * @param {object} data API response or streaming chunk
 * @param {string} source Source captured when sending the request
 * @param {string} model Requested model
 * @returns {object|null} Metadata in the existing billing extension event format
 */
export function extractOpenRouterResponseMetadata(data, source, model) {
    if (source !== 'openrouter') return null;

    const copyNumbers = (value, keys) => Object.fromEntries(keys
        .filter(key => typeof value?.[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0)
        .map(key => [key, value[key]]));
    const usage = data?.usage && typeof data.usage === 'object' && !Array.isArray(data.usage)
        ? copyNumbers(data.usage, ['cost', 'prompt_tokens', 'completion_tokens', 'total_tokens'])
        : null;
    if (usage) {
        for (const [key, fields] of Object.entries({
            prompt_tokens_details: ['cached_tokens', 'cache_write_tokens'],
            completion_tokens_details: ['reasoning_tokens'],
        })) {
            const details = copyNumbers(data.usage[key], fields);
            if (Object.keys(details).length) usage[key] = details;
        }
    }
    return { chatCompletionSource: source, model, usage, providerMetadata: {} };
}
