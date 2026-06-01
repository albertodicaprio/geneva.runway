export default async function handler(req, res) {
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
        // Fetch from OpenSky API (server-side, no CORS issues)
        const response = await fetch('https://opensky-network.org/api/states/all', {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
            }
        });

        if (!response.ok) {
            console.error(`OpenSky API error: ${response.status}`);
            res.status(response.status).json({ error: `OpenSky API returned ${response.status}` });
            return;
        }

        const data = await response.json();

        // Cache for 10 seconds (Vercel's default)
        res.setHeader('Cache-Control', 'public, max-age=10');

        res.status(200).json(data);
    } catch (error) {
        console.error('Error fetching from OpenSky API:', error);
        res.status(500).json({ error: 'Failed to fetch aircraft data' });
    }
}
