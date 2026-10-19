(() => {
    const ids = ['telegramStatus', 'telegramAccount', 'telegramConnect', 'telegramDisconnect', 'telegramTest',
        'telegramLinkPanel', 'telegramLink', 'telegramQr', 'telegramExpiry', 'telegramMessage', 'predictedRunwayAlerts', 'busyArrivalAlerts', 'busyArrivalThreshold'];
    const nodes = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
    const menu = document.getElementById('accountMenu');
    if (!menu || ids.some(id => !nodes[id])) return;
    let accountId = '';
    let csrfToken;
    let generation = 0;
    let busy = false;
    let checking = false;
    let enabled = false;
    let connection = null;
    let link = null;
    let alerts = { predictedRunwayChanges: false };

    function clearLink() {
        link = null;
        nodes.telegramLinkPanel.hidden = true;
        nodes.telegramQr.hidden = true;
        nodes.telegramQr.removeAttribute('src');
        nodes.telegramLink.removeAttribute('href');
    }
    function synchronize() {
        const current = document.documentElement.dataset.userId || '';
        if (accountId !== current) {
            accountId = current;
            generation++;
            csrfToken = null;
            enabled = false;
            connection = null;
            alerts = { predictedRunwayChanges: false };
            busy = false;
            checking = false;
            clearLink();
            nodes.telegramMessage.textContent = '';
            render();
        }
    }
    function render() {
        nodes.telegramStatus.textContent = connection ? (connection.blocked ? 'Connected · delivery unavailable' : 'Connected') :
            enabled ? (link ? 'Waiting for Telegram…' : 'Not connected') : 'Telegram integration is not configured yet.';
        nodes.telegramAccount.hidden = !connection;
        nodes.telegramAccount.textContent = connection ? `${connection.name}${connection.username ? ` (@${connection.username})` : ''}` : '';
        nodes.telegramTest.hidden = !connection;
        nodes.telegramTest.disabled = busy || !csrfToken || connection?.blocked;
        nodes.telegramDisconnect.hidden = !connection;
        nodes.telegramDisconnect.disabled = busy || !csrfToken;
        nodes.telegramConnect.hidden = Boolean(connection);
        nodes.telegramConnect.textContent = link ? 'Create new link' : 'Connect';
        nodes.telegramConnect.disabled = busy || !enabled || !csrfToken;
        nodes.predictedRunwayAlerts.checked = alerts.predictedRunwayChanges === true;
        nodes.predictedRunwayAlerts.disabled = busy || checking || !enabled || !csrfToken || !connection || connection.blocked;
        nodes.busyArrivalAlerts.checked = alerts.busyArrivals === true;
        nodes.busyArrivalAlerts.disabled = nodes.predictedRunwayAlerts.disabled;
        nodes.busyArrivalThreshold.value = alerts.busyArrivalThreshold ?? 10;
        nodes.busyArrivalThreshold.disabled = nodes.predictedRunwayAlerts.disabled;
        if (connection) clearLink();
    }
    async function request(path, method = 'GET', body) {
        const response = await fetch(`/api/account/telegram${path}`, {
            method, cache: 'no-store', headers: method === 'POST' ? {
                'X-CSRF-Token': csrfToken, ...(body ? { 'Content-Type': 'application/json' } : {})
            } : {}, ...(body ? { body: JSON.stringify(body) } : {})
        });
        const result = await response.json();
        if (!response.ok) throw new Error(response.status === 401 ? 'Sign in again to manage Telegram.' : result.error || 'Telegram is unavailable. Please try again.');
        return result;
    }
    async function check() {
        synchronize();
        if (!accountId || busy || checking || !menu.open) return;
        checking = true;
        const version = generation;
        try {
            if (!csrfToken) {
                const response = await fetch('/api/auth/session', { cache: 'no-store' });
                if (!response.ok) throw new Error('Could not check your account. Please try again.');
                const session = await response.json();
                if (version !== generation) return;
                if (!session.user || encodeURIComponent(session.user.id).replace(/'/g, '%27') !== accountId) {
                    throw new Error('Sign in again to manage Telegram.');
                }
                csrfToken = session.csrfToken;
            }
            const state = await request('');
            if (version !== generation) return;
            enabled = state.enabled;
            connection = state.connection;
            alerts = state.alerts || { predictedRunwayChanges: false };
            if (state.linkError) {
                clearLink();
                nodes.telegramMessage.textContent = state.linkError;
            } else if (link && (!state.expiresAt || link.expiresAt <= Date.now())) {
                clearLink();
                nodes.telegramMessage.textContent = connection ? '' : 'Connection link expired. Click Connect to try again.';
            }
            render();
        } catch (error) {
            if (version === generation) nodes.telegramMessage.textContent = error.message;
        } finally { if (version === generation) { checking = false; render(); } }
    }
    async function action(path, body) {
        synchronize();
        if (!accountId || !csrfToken || busy || checking) return;
        busy = true;
        let disconnected = false;
        const version = generation;
        const previousAlerts = alerts;
        if (path === '/alerts') alerts = { ...alerts, ...body };
        nodes.telegramMessage.textContent = '';
        render();
        try {
            const result = await request(path, 'POST', body);
            if (version !== generation) return;
            if (path === '/connect') {
                link = result;
                nodes.telegramLink.href = result.url;
                nodes.telegramQr.src = '/api/account/telegram/qr';
                nodes.telegramQr.hidden = false;
                nodes.telegramLinkPanel.hidden = false;
                nodes.telegramExpiry.textContent = 'This private connection link expires in 10 minutes.';
            } else if (path === '/disconnect') {
                connection = null;
                alerts = { predictedRunwayChanges: false };
                clearLink();
                disconnected = true;
                nodes.telegramMessage.textContent = 'Telegram disconnected.';
            } else if (path === '/alerts') {
                alerts = result.alerts;
                nodes.telegramMessage.textContent = Object.hasOwn(body, 'predictedRunwayChanges')
                    ? (alerts.predictedRunwayChanges ? 'Arrival runway alerts enabled. Current arrival history establishes a baseline.' : 'Arrival runway alerts disabled.')
                    : 'Busy arrival alert settings saved.';
            } else nodes.telegramMessage.textContent = 'Test message sent. Check Telegram.';
        } catch (error) {
            if (version === generation) {
                if (path === '/alerts') alerts = previousAlerts;
                nodes.telegramMessage.textContent = error.message;
            }
        } finally {
            if (version === generation) {
                busy = false;
                render();
                if (disconnected) nodes.telegramConnect.focus();
                await check();
            }
        }
    }
    nodes.telegramConnect.addEventListener('click', () => action('/connect'));
    nodes.telegramDisconnect.addEventListener('click', () => action('/disconnect'));
    nodes.telegramTest.addEventListener('click', () => action('/test'));
    nodes.predictedRunwayAlerts.addEventListener('change', () => action('/alerts', {
        predictedRunwayChanges: nodes.predictedRunwayAlerts.checked
    }));
    nodes.busyArrivalAlerts.addEventListener('change', () => action('/alerts', {
        busyArrivals: nodes.busyArrivalAlerts.checked
    }));
    nodes.busyArrivalThreshold.addEventListener('change', () => {
        const threshold = Number(nodes.busyArrivalThreshold.value);
        if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100) {
            nodes.telegramMessage.textContent = 'Choose a whole number from 1 to 100.';
            render();
            return;
        }
        action('/alerts', { busyArrivalThreshold: threshold });
    });
    nodes.telegramQr.addEventListener('error', () => {
        nodes.telegramQr.hidden = true;
        nodes.telegramMessage.textContent = 'Could not load the QR code. Use Open Telegram or create a new link.';
    });
    menu.addEventListener('toggle', check);
    window.addEventListener('authchange', () => { synchronize(); check(); });
    window.addEventListener('focus', check);
    window.setInterval(() => { if (!document.hidden) check(); }, 5000);
    synchronize();
})();
