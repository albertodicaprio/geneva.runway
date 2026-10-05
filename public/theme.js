(() => {
    const storageKey = 'geneva-night-mode';
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
    let preference = null;
    let toggle;

    function readPreference() {
        try {
            const saved = window.localStorage.getItem(storageKey);
            return saved === 'night' || saved === 'day' ? saved : null;
        } catch {
            return null;
        }
    }

    function applyTheme() {
        const night = preference ? preference === 'night' : systemTheme.matches;
        document.documentElement.dataset.theme = night ? 'night' : 'day';
        if (toggle) toggle.setAttribute('aria-pressed', String(night));
    }

    // Apply before the stylesheet loads to avoid a bright flash on navigation.
    preference = readPreference();
    applyTheme();

    document.addEventListener('DOMContentLoaded', () => {
        toggle = document.getElementById('nightModeToggle');
        if (!toggle) return;
        applyTheme();
        toggle.hidden = false;
        toggle.addEventListener('click', () => {
            preference = document.documentElement.dataset.theme === 'night' ? 'day' : 'night';
            try {
                window.localStorage.setItem(storageKey, preference);
            } catch {
                // The toggle still works for this page when storage is blocked.
            }
            applyTheme();
        });
    });

    systemTheme.addEventListener('change', applyTheme);
    window.addEventListener('storage', event => {
        if (event.key === storageKey || event.key === null) {
            preference = readPreference();
            applyTheme();
        }
    });
})();
