(() => {
    const signIn = document.getElementById('signIn');
    const signOut = document.getElementById('signOut');
    const status = document.getElementById('accountStatus');
    if (!signIn || !signOut || !status) return;
    let csrfToken;
    let pending = false;
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

    function setUser(user) {
        const userId = user ? encodeURIComponent(user.id).replace(/'/g, '%27') : '';
        const changed = document.documentElement.dataset.userId !== userId;
        document.documentElement.dataset.userId = userId;
        signIn.hidden = Boolean(user);
        signOut.hidden = !user;
        signOut.title = user ? `Signed in as ${user.name}` : '';
        if (changed) window.dispatchEvent(new Event('authchange'));
    }

    async function refresh() {
        if (pending) return;
        pending = true;
        try {
            const response = await fetch('/api/auth/session', { cache: 'no-store' });
            if (!response.ok) throw new Error('Session unavailable');
            const session = await response.json();
            csrfToken = session.csrfToken;
            setUser(session.user);
            signIn.setAttribute('aria-disabled', String(!session.enabled));
            signIn.title = session.enabled ? 'Sign in to choose your theme' : 'Google sign-in is not configured yet';
        } catch {
            setUser(null);
            status.textContent = 'Could not check sign-in. Please refresh to try again.';
        } finally {
            pending = false;
        }
    }

    signIn.addEventListener('click', event => {
        if (signIn.getAttribute('aria-disabled') === 'true') {
            event.preventDefault();
            status.textContent = 'Google sign-in is not configured yet.';
        }
    });
    signOut.addEventListener('click', async () => {
        if (pending) return;
        pending = true;
        signOut.disabled = true;
        try {
            const response = await fetch('/auth/logout', {
                method: 'POST', headers: { 'X-CSRF-Token': csrfToken }
            });
            if (!response.ok) throw new Error('Sign-out failed');
            csrfToken = null;
            setUser(null);
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
