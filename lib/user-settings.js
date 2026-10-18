const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const THEMES = new Set(['auto', 'night', 'day']);

function createUserSettings({
    filePath = process.env.USER_SETTINGS_FILE || path.join(__dirname, '..', 'data', 'user-settings.json'),
    storage = fs
} = {}) {
    let pendingWrite = Promise.resolve();

    async function readUsers() {
        let contents;
        try {
            contents = await storage.readFile(filePath, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') return {};
            throw error;
        }
        const users = JSON.parse(contents);
        if (!users || typeof users !== 'object' || Array.isArray(users)) {
            throw new Error('Invalid user settings file');
        }
        return users;
    }

    function account(users, email) {
        const saved = Object.hasOwn(users, email) ? users[email] : null;
        if (saved !== null && (!saved || typeof saved !== 'object' || Array.isArray(saved))) {
            throw new Error('Invalid account settings');
        }
        return saved || {};
    }

    async function get(email) {
        await pendingWrite;
        const saved = account(await readUsers(), email);
        return { ...saved, theme: THEMES.has(saved.theme) ? saved.theme : null };
    }

    function setTheme(email, theme) {
        if (!THEMES.has(theme)) return Promise.reject(new Error('Invalid theme'));
        const write = pendingWrite.then(async () => {
            const users = await readUsers();
            const settings = { ...account(users, email), theme };
            const updated = { ...users, [email]: settings };
            await storage.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
            const temporary = `${filePath}.${randomBytes(8).toString('hex')}.tmp`;
            try {
                await storage.writeFile(temporary, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 });
                await storage.rename(temporary, filePath);
            } finally {
                await storage.unlink(temporary).catch(() => {});
            }
            return { theme: settings.theme };
        });
        // A failed write must not block later attempts. Never replace the old file
        // until a complete new document exists, and preserve future settings.
        pendingWrite = write.catch(() => {});
        return write;
    }

    return { get, setTheme };
}

module.exports = { createUserSettings };
