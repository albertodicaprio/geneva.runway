// Geneva Airport Configuration
const GENEVA_AIRPORT = {
    lat: 46.2381,
    lon: 6.1093,
    radius_km: 50,
    icao: 'LSGG',
    iata: 'GVA'
};

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
 * Calculate distance between two coordinates (Haversine formula)
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * Determine if aircraft is landing (descending and approaching)
 */
function isLanding(aircraft) {
    const distance = calculateDistance(
        GENEVA_AIRPORT.lat,
        GENEVA_AIRPORT.lon,
        aircraft.latitude,
        aircraft.longitude
    );

    // Check if aircraft is within range and descending
    if (distance < GENEVA_AIRPORT.radius_km) {
        // Vertical rate < 0 means descending
        const isDescending = aircraft.verticalRate !== null && aircraft.verticalRate < 0;

        // Check if altitude is reasonable for landing (below 3000m)
        const isLowAltitude = aircraft.altitude !== null && aircraft.altitude < 3000;

        // Check if heading is towards airport (within 180 degrees)
        const isHeadingTowardAirport = isHeadingToward(aircraft);

        return isDescending && isLowAltitude && isHeadingTowardAirport;
    }
    return false;
}

/**
 * Check if aircraft heading is towards airport
 */
function isHeadingToward(aircraft) {
    if (aircraft.heading === null) return false;

    // Calculate true heading to airport
    const lat1 = aircraft.latitude * (Math.PI / 180);
    const lon1 = aircraft.longitude * (Math.PI / 180);
    const lat2 = GENEVA_AIRPORT.lat * (Math.PI / 180);
    const lon2 = GENEVA_AIRPORT.lon * (Math.PI / 180);

    const dLon = lon2 - lon1;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) -
        Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    let bearing = Math.atan2(y, x) * (180 / Math.PI);
    bearing = (bearing + 360) % 360;

    // Check if heading is within 90 degrees of bearing to airport
    const heading = aircraft.heading;
    const diff = Math.abs(heading - bearing);
    const minDiff = Math.min(diff, 360 - diff);

    return minDiff < 90;
}

/**
 * Estimate runway based on aircraft heading
 * Runway 04: heading ~40° (0-90°)
 * Runway 22: heading ~220° (180-270°)
 */
function estimateRunway(aircraft) {
    if (aircraft.heading === null) {
        // If no heading, use random runway
        return Math.random() < 0.5 ? '04' : '22';
    }

    const heading = aircraft.heading;

    // Determine if landing on 04 or 22 based on heading
    if ((heading >= 0 && heading < 90) || (heading >= 270 && heading <= 360)) {
        return '04';
    } else {
        return '22';
    }
}

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

        // Process states array
        const landings = [];
        if (data.states) {
            data.states.forEach(state => {
                const aircraft = {
                    icao24: state[0],
                    callsign: (state[1] || '').trim(),
                    country: state[2],
                    timestamp: state[3],
                    lastPositionUpdate: state[4],
                    longitude: state[5],
                    latitude: state[6],
                    altitude: state[7],
                    onGround: state[8],
                    velocity: state[9],
                    heading: state[10],
                    verticalRate: state[11],
                    sensors: state[12],
                    geoAltitude: state[13],
                    squawk: state[14],
                    spi: state[15],
                    positionSource: state[16]
                };

                // Check if aircraft is landing
                if (isLanding(aircraft) && aircraft.callsign) {
                    landings.push(aircraft);
                }
            });
        }

        aircraftData = landings;
        updateUI();
        updateLastUpdated();
        isFetching = false;

    } catch (error) {
        console.error('Error fetching aircraft data:', error);
        displayError('Failed to fetch aircraft data. Please check the console.');
        isFetching = false;
    }
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
    const runway04 = aircraftData.filter(a => estimateRunway(a) === '04');
    const runway22 = aircraftData.filter(a => estimateRunway(a) === '22');

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
    const sorted = [...aircraftData].sort((a, b) =>
        (a.altitude || 999999) - (b.altitude || 999999)
    );

    listDiv.innerHTML = sorted.map(aircraft => {
        const distance = calculateDistance(
            GENEVA_AIRPORT.lat,
            GENEVA_AIRPORT.lon,
            aircraft.latitude,
            aircraft.longitude
        );

        const runway = estimateRunway(aircraft);
        const isDescending = aircraft.verticalRate && aircraft.verticalRate < 0;
        const verticalRateClass = isDescending ? 'descending' : 'approaching';

        return `
            <div class="aircraft-item">
                <div class="aircraft-header">
                    <span class="aircraft-callsign">${aircraft.callsign}</span>
                    <span class="aircraft-type">${runway}</span>
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
    console.log(`Airport coordinates: ${GENEVA_AIRPORT.lat}°N, ${GENEVA_AIRPORT.lon}°E`);
    console.log(`Search radius: ${GENEVA_AIRPORT.radius_km} km`);

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
