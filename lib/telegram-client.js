class TelegramError extends Error {
    constructor(code, retryAfter = 0) {
        super('Telegram request failed');
        this.code = code;
        this.retryAfter = retryAfter;
    }
}

function createTelegramClient({ token, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
    async function request(method, payload = {}) {
        try {
            const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
                method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
            });
            const data = await response.json();
            if (!response.ok || data.ok !== true) {
                const retry = data.parameters?.retry_after;
                throw new TelegramError(data.error_code || response.status,
                    Number.isSafeInteger(retry) && retry > 0 ? retry : 0);
            }
            return data.result;
        } catch (error) {
            // Fetch errors can include the bot-token URL. Never propagate them.
            if (error instanceof TelegramError) throw error;
            throw new TelegramError('unavailable');
        }
    }
    return { request, sendMessage: (chatId, text) => request('sendMessage', { chat_id: chatId, text }) };
}

module.exports = { createTelegramClient, TelegramError };
