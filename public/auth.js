(() => {
    const signIn = document.getElementById('signIn');
    const signOut = document.getElementById('signOut');
    const status = document.getElementById('accountStatus');
    const themeToggle = document.getElementById('nightModeToggle');
    const accountMenu = document.getElementById('accountMenu');
    const accountToggle = document.getElementById('accountToggle');
    const accountName = document.getElementById('accountName');
    const profileName = document.getElementById('profileName');
    const profileEmail = document.getElementById('profileEmail');
    if (!signIn || !signOut || !status || !accountMenu) return;
    accountMenu.hidden = !document.documentElement.dataset.userId;

    function closeMenu(restoreFocus = false) {
        accountMenu.open = false;
        if (restoreFocus) accountToggle.focus();
    }
    document.addEventListener('click', event => {
        if (!accountMenu.contains(event.target)) closeMenu();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && accountMenu.open) {
            event.preventDefault();
            closeMenu(true);
        }
    });
    document.addEventListener('focusin', event => {
        if (!accountMenu.contains(event.target)) closeMenu();
    });
    signIn.hidden = Boolean(document.documentElement.dataset.userId);
    signOut.hidden = !document.documentElement.dataset.userId;
    if (themeToggle) themeToggle.disabled = true;
    let csrfToken;
    let pending = false;
    let saving = false;
    let queuedTheme = null;
    const themes = ['auto', 'night', 'day'];
    signIn.href = `/auth/google?returnTo=${encodeURIComponent(window.location.pathname)}`;

    const url = new URL(window.location.href);
    const messages = {
        cancelled: 'Sign-in cancelled. You can keep browsing.',
        expired: 'Sign-in expired. Please try again.',
        failed: 'Could not sign in with Google. Please try again.'
    };
    if (messages[url.searchParams.get('auth')]) {
        status.textContent = messages[url.searchParams.get('auth')];
        url.searchParams.delete('auth');
        window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    }

    function setUser(user, settings) {
        const userId = user ? encodeURIComponent(user.id).replace(/'/g, '%27') : '';
        const changed = document.documentElement.dataset.userId !== userId;
        const theme = user ? (queuedTheme !== null && !changed ? queuedTheme :
            themes.includes(settings?.theme) ? settings.theme : '') : 'auto';
        const themeChanged = document.documentElement.dataset.themePreference !== theme;
        document.documentElement.dataset.userId = userId;
        document.documentElement.dataset.themePreference = theme;
        signIn.hidden = Boolean(user);
        signOut.hidden = !user;
        signOut.title = user ? `Signed in as ${user.name}` : '';
        accountMenu.hidden = !user;
        accountName.textContent = user?.name || 'Account';
        profileName.textContent = user?.fullName || user?.name || '—';
        profileEmail.textContent = user?.email || '—';
        if (!user || changed) closeMenu();
        if (!user) queuedTheme = null;
        if (themeToggle) themeToggle.disabled = !user || !csrfToken;
        if (changed || themeChanged) window.dispatchEvent(new Event('authchange'));
    }

    async function saveTheme() {
        if (pending || saving || !csrfToken || !document.documentElement.dataset.userId) return;
        saving = true;
        signOut.disabled = true;
        try {
            while (queuedTheme !== null) {
                const theme = queuedTheme;
                queuedTheme = null;
                status.textContent = 'Saving theme…';
                const response = await fetch('/api/account/settings', {
                    method: 'PATCH', keepalive: true,
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
                    body: JSON.stringify({ theme })
                });
                if (response.status === 401) {
                    csrfToken = null;
                    setUser(null);
                    throw new Error('Session expired');
                }
                if (!response.ok) throw new Error('Save failed');
            }
            status.textContent = '';
        } catch {
            queuedTheme = null;
            status.textContent = 'Could not save your theme. Please try changing it again.';
        } finally {
            saving = false;
            signOut.disabled = false;
        }
    }

    window.addEventListener('themechange', () => {
        const theme = document.documentElement.dataset.themePreference;
        if (!themes.includes(theme)) return;
        queuedTheme = theme;
        saveTheme();
    });

    async function refresh() {
        if (pending || saving) return;
        pending = true;
        try {
            const response = await fetch('/api/auth/session', { cache: 'no-store' });
            if (!response.ok) throw new Error('Session unavailable');
            const session = await response.json();
            csrfToken = session.csrfToken;
            setUser(session.user, session.settings);
            if (session.settings?.unavailable) {
                status.textContent = 'Could not load your saved theme. Please try again later.';
            } else if (session.user && session.settings?.theme === null) {
                // Import the existing browser preference only for an account
                // that has never saved settings on the server.
                queuedTheme = document.documentElement.dataset.themePreference;
            }
            signIn.setAttribute('aria-disabled', String(!session.enabled));
            signIn.title = session.enabled ? 'Sign in to choose your theme' : 'Google sign-in is not configured yet';
        } catch {
            status.textContent = 'Could not check sign-in. Please refresh to try again.';
        } finally {
            pending = false;
            if (queuedTheme !== null) saveTheme();
        }
    }

    signIn.addEventListener('click', event => {
        if (signIn.getAttribute('aria-disabled') === 'true') {
            event.preventDefault();
            status.textContent = 'Google sign-in is not configured yet.';
        }
    });
    signOut.addEventListener('click', async () => {
        if (pending || saving) return;
        pending = true;
        signOut.disabled = true;
        try {
            const response = await fetch('/auth/logout', {
                method: 'POST', headers: { 'X-CSRF-Token': csrfToken }
            });
            if (!response.ok) throw new Error('Sign-out failed');
            csrfToken = null;
            setUser(null);
            signIn.focus();
            status.textContent = 'Signed out. Theme set to Auto.';
            try { window.localStorage.setItem('geneva-auth-change', String(Date.now())); } catch { /* Storage is optional. */ }
        } catch {
            status.textContent = 'Could not sign out. Please refresh and try again.';
        } finally {
            pending = false;
            signOut.disabled = false;
        }
    });

    refresh();
    window.addEventListener('pageshow', refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', event => {
        if (event.key === 'geneva-auth-change') refresh();
    });
    window.setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
})();
