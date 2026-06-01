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

// OpenSky API endpoint
const OPENSKY_API = 'https://opensky-network.org/api/states/all';

// Fetch interval (5 seconds)
const FETCH_INTERVAL = 5000;

// State
let aircraftData = {};

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
 * Estimate runway based on aircraft altitude and heading
 */
function estimateRunway(aircraft) {
    // Simple estimation: alternate between runways
    // In reality, this would depend on wind direction
    const runways = Object.keys(RUNWAYS);
    const index = Math.abs(aircraft.longitude.toString().charCodeAt(0)) % runways.length;
    return runways[index];
}

/**
 * Fetch aircraft data from OpenSky API
 */
async function fetchAircraftData() {
    try {
        const response = await fetch(OPENSKY_API);
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

    } catch (error) {
        console.error('Error fetching aircraft data:', error);
        displayError('Failed to fetch aircraft data. Please check the console.');
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
    const runway04L = aircraftData.filter(a => {
        const runway = estimateRunway(a);
        return runway === '04L/22R';
    });

    const runway04R = aircraftData.filter(a => {
        const runway = estimateRunway(a);
        return runway === '04R/22L';
    });

    // Update runway 04L/22R
    document.getElementById('runway04LCount').textContent =
        `${runway04L.length} incoming`;

    const runway04LAircraftDiv = document.getElementById('runway04LAircraft');
    if (runway04L.length > 0) {
        runway04LAircraftDiv.innerHTML = runway04L
            .slice(0, 2)
            .map(a => `<p><strong>${a.callsign}</strong> • ${Math.round(a.altitude)}m</p>`)
            .join('');
    } else {
        runway04LAircraftDiv.innerHTML = '<p class="no-data">--</p>';
    }

    // Update runway 04R/22L
    document.getElementById('runway04RCount').textContent =
        `${runway04R.length} incoming`;

    const runway04RAircraftDiv = document.getElementById('runway04RAircraft');
    if (runway04R.length > 0) {
        runway04RAircraftDiv.innerHTML = runway04R
            .slice(0, 2)
            .map(a => `<p><strong>${a.callsign}</strong> • ${Math.round(a.altitude)}m</p>`)
            .join('');
    } else {
        runway04RAircraftDiv.innerHTML = '<p class="no-data">--</p>';
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
