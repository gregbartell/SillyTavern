const MAX_OBJECT_DEPTH = 4;
const MAX_ARRAY_LENGTH = 32;
const MAX_STRING_LENGTH = 512;
const SENSITIVE_KEY_PATTERN = /(?:account|team|payment|invoice|customer|email|api[_-]?key|secret|credential|wallet|balance|credit|subscription|organization|org_id)/i;
const UNSAFE_PAYLOAD_KEY_PATTERN = /(?:choices|messages?|headers?|request[_-]?body|body)/i;

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEmptyCollection(value) {
    return (isRecord(value) && Object.keys(value).length === 0) || (Array.isArray(value) && value.length === 0);
}

function sanitizeMetadataValue(value, depth = 0) {
    if (value === null || typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'string') {
        return value.slice(0, MAX_STRING_LENGTH);
    }

    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }

    if (typeof value === 'bigint') {
        return value.toString();
    }

    if (typeof value !== 'object') {
        return undefined;
    }

    if (depth >= MAX_OBJECT_DEPTH) {
        return undefined;
    }

    if (Array.isArray(value)) {
        return value
            .slice(0, MAX_ARRAY_LENGTH)
            .map(item => sanitizeMetadataValue(item, depth + 1))
            .filter(item => item !== undefined);
    }

    const result = {};
    for (const [key, item] of Object.entries(value)) {
        if (SENSITIVE_KEY_PATTERN.test(key) || UNSAFE_PAYLOAD_KEY_PATTERN.test(key)) {
            continue;
        }

        const sanitized = sanitizeMetadataValue(item, depth + 1);
        if (sanitized !== undefined && !isEmptyCollection(sanitized)) {
            result[key] = sanitized;
        }
    }

    return result;
}

function extractApiUsage(data, usage = null) {
    return usage
        ?? data?.usage
        ?? data?.usageMetadata
        ?? data?.meta?.tokens
        ?? data?.meta?.billed_units
        ?? null;
}

/**
 * Extracts sanitized extension-facing metadata from a Chat Completion response.
 * @param {object} data Chat Completion response payload
 * @param {object|null} usage Normalized API usage, if already extracted
 * @returns {{ usage: object|null, providerMetadata: Record<string, unknown> }}
 */
export function extractChatCompletionResponseMetadata(data, usage = null) {
    const apiUsage = sanitizeMetadataValue(extractApiUsage(data, usage));
    const providerMetadata = {};

    if (isRecord(data)) {
        for (const [key, value] of Object.entries(data)) {
            if (!key.startsWith('x_') || SENSITIVE_KEY_PATTERN.test(key) || UNSAFE_PAYLOAD_KEY_PATTERN.test(key)) {
                continue;
            }

            const sanitized = sanitizeMetadataValue(value);
            if (sanitized !== undefined && !isEmptyCollection(sanitized)) {
                providerMetadata[key] = sanitized;
            }
        }
    }

    return {
        usage: isRecord(apiUsage) ? apiUsage : null,
        providerMetadata,
    };
}

/**
 * Merges metadata from streaming chunks.
 * @param {{ usage?: object|null, providerMetadata?: Record<string, unknown> }|null} existing Previous metadata
 * @param {{ usage?: object|null, providerMetadata?: Record<string, unknown> }|null} next Next chunk metadata
 * @returns {{ usage: object|null, providerMetadata: Record<string, unknown> }}
 */
export function mergeChatCompletionResponseMetadata(existing, next) {
    return {
        usage: next?.usage ?? existing?.usage ?? null,
        providerMetadata: {
            ...(existing?.providerMetadata ?? {}),
            ...(next?.providerMetadata ?? {}),
        },
    };
}

/**
 * Checks whether extracted metadata contains anything worth emitting.
 * @param {{ usage?: object|null, providerMetadata?: Record<string, unknown> }|null} metadata Metadata object
 * @returns {boolean}
 */
export function hasChatCompletionResponseMetadata(metadata) {
    return !!metadata?.usage || Object.keys(metadata?.providerMetadata ?? {}).length > 0;
}
