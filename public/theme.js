(() => {
    const storageKey = 'geneva-night-mode';
    const modes = ['auto', 'night', 'day'];
    const genevaHour = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Zurich', hour: 'numeric', hourCycle: 'h23'
    });
    let preference;
    let toggle;

    function readPreference() {
        try {
            const saved = window.localStorage.getItem(storageKey);
            return modes.includes(saved) ? saved : 'auto';
        } catch {
            return 'auto';
        }
    }

    function applyTheme() {
        const hour = Number(genevaHour.format(new Date()));
        const night = preference === 'auto' ? hour < 7 || hour >= 19 : preference === 'night';
        document.documentElement.dataset.theme = night ? 'night' : 'day';
        if (toggle) {
            const labels = { auto: 'Auto', night: 'Night', day: 'Day' };
            const icons = { auto: '◷', night: '☾', day: '☀' };
            const nextMode = modes[(modes.indexOf(preference) + 1) % modes.length];
            toggle.dataset.mode = preference;
            toggle.querySelector('[data-theme-icon]').textContent = icons[preference];
            toggle.querySelector('[data-theme-label]').textContent = labels[preference];
            toggle.setAttribute('aria-label', `${labels[preference]}. Switch to ${labels[nextMode]}.`);
            toggle.title = preference === 'auto'
                ? 'Automatic: Day 07:00–19:00, Night 19:00–07:00 (Geneva time)'
                : `Switch to ${labels[nextMode]}`;
        }
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
            preference = modes[(modes.indexOf(preference) + 1) % modes.length];
            try {
                window.localStorage.setItem(storageKey, preference);
            } catch {
                // The toggle still works for this page when storage is blocked.
            }
            applyTheme();
        });
    });

    // Recheck the clock while open and immediately after returning to the page.
    window.setInterval(applyTheme, 60_000);
    document.addEventListener('visibilitychange', applyTheme);
    window.addEventListener('pageshow', applyTheme);
    window.addEventListener('storage', event => {
        if (event.key === storageKey || event.key === null) {
            preference = readPreference();
            applyTheme();
        }
    });
})();
