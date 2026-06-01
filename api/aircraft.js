// In-memory cache for Vercel serverless function
let cachedData = null;
let lastFetchTime = 0;
const CACHE_DURATION = 120000; // 120 seconds cache duration
const MAX_STALE_AGE = 600000; // Allow serving stale data up to 10 minutes old

module.exports = async (req, res) => {
    // CORS headers to allow frontend requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // Only allow GET requests
    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    try {
        const timeSinceLastFetch = Date.now() - lastFetchTime;

        // Return cached data if still valid (within 120 seconds)
        if (cachedData && timeSinceLastFetch < CACHE_DURATION) {
            console.log(`Returning fresh cached data (${Math.round(timeSinceLastFetch / 1000)}s old)`);
            res.setHeader('Cache-Control', 'public, max-age=120');
            res.setHeader('X-Cache', 'HIT');
            res.status(200).json(cachedData);
            return;
        }

        // If cache is older than 120s but newer than 10 min, serve stale but try to refresh
        if (cachedData && timeSinceLastFetch < MAX_STALE_AGE) {
            console.log(`Cache is ${Math.round(timeSinceLastFetch / 1000)}s old, attempting refresh...`);

            // Try to fetch fresh data
            try {
                const response = await fetch('https://opensky-network.org/api/states/all', {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' }
                });

                if (response.ok) {
                    const data = await response.json();
                    cachedData = data;
                    lastFetchTime = Date.now();
                    console.log('Successfully refreshed cache from OpenSky');
                    res.setHeader('Cache-Control', 'public, max-age=120');
                    res.setHeader('X-Cache', 'REFRESHED');
                    res.status(200).json(data);
                    return;
                } else if (response.status === 429) {
                    console.warn('OpenSky rate limited, returning stale cached data');
                    res.setHeader('Cache-Control', 'public, max-age=120');
                    res.setHeader('X-Cache', 'STALE-RATE-LIMITED');
                    res.status(200).json(cachedData);
                    return;
                }
            } catch (fetchError) {
                console.warn('Fetch attempt failed, returning stale cached data:', fetchError.message);
                res.setHeader('Cache-Control', 'public, max-age=120');
                res.setHeader('X-Cache', 'STALE-FETCH-ERROR');
                res.status(200).json(cachedData);
                return;
            }
        }

        // No cache available, must fetch fresh
        console.log('No cache available, fetching from OpenSky...');
        const response = await fetch('https://opensky-network.org/api/states/all', {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) {
            console.error(`OpenSky API error: ${response.status}`);
            if (response.status === 429) {
                res.status(503).json({
                    error: 'Service temporarily unavailable - OpenSky API rate limited. Retrying in 2 minutes.',
                    retryAfter: 120
                });
            } else {
                res.status(response.status).json({ error: `OpenSky API returned ${response.status}` });
            }
            return;
        }

        const data = await response.json();
        cachedData = data;
        lastFetchTime = Date.now();

        res.setHeader('Cache-Control', 'public, max-age=120');
        res.setHeader('X-Cache', 'MISS');
        res.status(200).json(data);

    } catch (error) {
        console.error('Error fetching from OpenSky API:', error);
        if (cachedData) {
            console.log('Error occurred, returning stale cached data');
            res.setHeader('Cache-Control', 'public, max-age=120');
            res.setHeader('X-Cache', 'STALE-ERROR');
            res.status(200).json(cachedData);
        } else {
            res.status(500).json({ error: 'Failed to fetch aircraft data' });
        }
    }
};
