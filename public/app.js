// Runway Information
const RUNWAYS = {
    '04L/22R': 40,
    '04R/22L': 40
};

// Local API endpoint
const API_ENDPOINT = '/api/aircraft';

// Fetch interval (60 seconds = once per minute to respect OpenSky rate limits)
const FETCH_INTERVAL = 60000;

// State
let aircraftData = {};
let isFetching = false;
let rateLimitResetTime = 0;

/**
 * Fetch aircraft data from the local API
 */
async function fetchAircraftData() {
    // Prevent concurrent requests
    if (isFetching) {
        return;
    }

    // If rate limited, wait before retrying
    if (rateLimitResetTime > Date.now()) {
        console.warn('Rate limited, waiting before next request...');
        return;
    }

    isFetching = true;

    try {
        const response = await fetch(API_ENDPOINT);

        // Handle rate limiting (503 or 429)
        if (response.status === 503 || response.status === 429) {
            const errorData = await response.json().catch(() => ({}));
            const retryAfter = errorData.retryAfter || 120;
            console.warn(`Rate limited. Retry after ${retryAfter} seconds`);
            rateLimitResetTime = Date.now() + (retryAfter * 1000);
            isFetching = false;
            displayError(`OpenSky API rate limited. Retrying in ${retryAfter} seconds...`);
            return;
        }

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        aircraftData = Array.isArray(data.aircraft) ? data.aircraft : [];
        updateUI();
        updateLastUpdated();
        isFetching = false;

    } catch (error) {
        console.error('Error fetching aircraft data:', error);
        displayError('Failed to fetch aircraft data. Please check the console.');
        isFetching = false;
    }
}

function aircraftCategoryLabel(category) {
    const labels = {
        2: 'Light',
        3: 'Small',
        4: 'Large',
        5: 'High vortex large',
        6: 'Heavy',
        7: 'High performance',
        8: 'Rotorcraft',
        9: 'Glider',
        10: 'Lighter-than-air',
        14: 'Unmanned',
        16: 'Emergency vehicle',
        17: 'Service vehicle'
    };

    return labels[category] || 'Unknown category';
}

/**
 * Update UI with aircraft data
 */
function updateUI() {
    updateRunwayCards();
    updateAircraftList();
}

/**
 * Update runway status cards
 */
function updateRunwayCards() {
    const runway04 = aircraftData.filter(a => a.approachDirection === '04');
    const runway22 = aircraftData.filter(a => a.approachDirection === '22');

    // Determine active runway (the one with most incoming aircraft, or first with any)
    let activeRunway, activeAircraft;
    if (runway22.length > 0) {
        activeRunway = '22';
        activeAircraft = runway22[0];
    } else if (runway04.length > 0) {
        activeRunway = '04';
        activeAircraft = runway04[0];
    } else {
        activeRunway = '--';
        activeAircraft = null;
    }

    // Update runway display
    document.getElementById('runwayNumber').textContent = activeRunway;

    const nextPlaneDiv = document.getElementById('nextPlane');
    if (activeAircraft) {
        nextPlaneDiv.innerHTML = `
            <p><strong>${activeAircraft.callsign}</strong></p>
            <p class="altitude">${Math.round(activeAircraft.altitude)}m • ${Math.round(activeAircraft.velocity * 3.6)} km/h</p>
        `;
    } else {
        nextPlaneDiv.innerHTML = '<p class="no-data">No incoming aircraft</p>';
    }
}

/**
 * Update aircraft list
 */
function updateAircraftList() {
    const listDiv = document.getElementById('aircraftList');

    if (aircraftData.length === 0) {
        listDiv.innerHTML = '<div class="no-aircraft">No incoming aircraft detected</div>';
        return;
    }

    // Sort by altitude (ascending = closest to landing)
    const sorted = [...aircraftData];

    listDiv.innerHTML = sorted.map(aircraft => {
        const distance = aircraft.distanceKm;

        const runway = aircraft.approachDirection === 'unknown' ? 'Unknown' : aircraft.approachDirection;
        const isDescending = aircraft.verticalRate && aircraft.verticalRate < 0;
        const verticalRateClass = isDescending ? 'descending' : 'approaching';

        return `
            <div class="aircraft-item">
                <div class="aircraft-header">
                    <span class="aircraft-callsign">${aircraft.callsign}</span>
                    <span class="aircraft-type">${aircraftCategoryLabel(aircraft.category)}</span>
                </div>
                <div class="aircraft-details">
                    <div class="detail">
                        <div class="detail-label">Altitude</div>
                        <div class="detail-value">${aircraft.altitude ? Math.round(aircraft.altitude) + 'm' : 'N/A'}</div>
                    </div>
                    <div class="detail">
                        <div class="detail-label">Distance</div>
                        <div class="detail-value">${distance.toFixed(1)} km</div>
                    </div>
                    <div class="detail">
                        <div class="detail-label">Speed</div>
                        <div class="detail-value">${aircraft.velocity ? Math.round(aircraft.velocity * 3.6) + ' km/h' : 'N/A'}</div>
                    </div>
                    <div class="detail">
                        <div class="detail-label">Vertical Rate</div>
                        <div class="detail-value ${verticalRateClass}">
                            ${aircraft.verticalRate ? Math.round(aircraft.verticalRate * 60) + ' m/min' : 'N/A'}
                        </div>
                    </div>
                    <div class="detail">
                        <div class="detail-label">Heading</div>
                        <div class="detail-value">${aircraft.heading ? Math.round(aircraft.heading) + '°' : 'N/A'}</div>
                    </div>
                    <div class="detail">
                        <div class="detail-label">Approach</div>
                        <div class="detail-value">Runway ${runway}</div>
                    </div>
                    <div class="detail">
                        <div class="detail-label">Country</div>
                        <div class="detail-value">${aircraft.country || 'N/A'}</div>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Update last updated timestamp
 */
function updateLastUpdated() {
    const now = new Date();
    const time = now.toLocaleTimeString();
    document.getElementById('lastUpdated').textContent = time;
}

/**
 * Display error message
 */
function displayError(message) {
    const listDiv = document.getElementById('aircraftList');
    listDiv.innerHTML = `<div class="error">${message}</div>`;
}

/**
 * Initialize app
 */
function init() {
    console.log('Geneva Airport Landing Tracker initialized');
    console.log('The backend provides ADSBdb-confirmed arrivals within 80 km of Geneva.');

    // Fetch immediately
    fetchAircraftData();

    // Set up interval
    setInterval(fetchAircraftData, FETCH_INTERVAL);
}

// Start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
