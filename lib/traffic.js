const MAX_POSITION_PROJECTION_SECONDS = 60;
const GENEVA_AIRPORT = { icao: 'LSGG', iata: 'GVA', latitude: 46.2381, longitude: 6.1093 };
const MAX_TRACK_AGE_SECONDS = 60 * 60;
const POST_LANDING_TRAIL_SECONDS = 2 * 60 * 60;
const TRACK_COLOR_VERSION = 3;
const ARRIVAL_TRACK_HUES = [35, 48, 65, 90, 120, 145, 280, 295];
const SEARCH_BOUNDS = { lamin: 45.51, lomin: 5.06, lamax: 46.97, lomax: 7.16 };
const RUNWAYS = [{ direction: '04', heading: 40 }, { direction: '22', heading: 220 }];
const RUNWAY_HEADING_TOLERANCE_DEG = 45;

function distanceInKm(latitude, longitude) {
    const earthRadiusKm = 6371;
    const toRadians = degrees => degrees * Math.PI / 180;
    const latitudeDelta = toRadians(latitude - GENEVA_AIRPORT.latitude);
    const longitudeDelta = toRadians(longitude - GENEVA_AIRPORT.longitude);
    const a = Math.sin(latitudeDelta / 2) ** 2 +
        Math.cos(toRadians(GENEVA_AIRPORT.latitude)) * Math.cos(toRadians(latitude)) * Math.sin(longitudeDelta / 2) ** 2;
    return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isWithinSearchBounds(latitude, longitude) {
    return Number.isFinite(latitude) && Number.isFinite(longitude) &&
        latitude >= SEARCH_BOUNDS.lamin && latitude <= SEARCH_BOUNDS.lamax &&
        longitude >= SEARCH_BOUNDS.lomin && longitude <= SEARCH_BOUNDS.lomax;
}

function projectPosition(latitude, longitude, heading, velocity, elapsedSeconds) {
    if (![latitude, longitude, heading, velocity].every(Number.isFinite) || velocity < 0 || elapsedSeconds <= 0) {
        return { latitude, longitude };
    }

    const earthRadiusMetres = 6_371_000;
    const angularDistance = velocity * elapsedSeconds / earthRadiusMetres;
    const bearing = heading * Math.PI / 180;
    const startLatitude = latitude * Math.PI / 180;
    const startLongitude = longitude * Math.PI / 180;
    const projectedLatitude = Math.asin(
        Math.sin(startLatitude) * Math.cos(angularDistance) +
        Math.cos(startLatitude) * Math.sin(angularDistance) * Math.cos(bearing)
    );
    const projectedLongitude = startLongitude + Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(startLatitude),
        Math.cos(angularDistance) - Math.sin(startLatitude) * Math.sin(projectedLatitude)
    );

    return {
        latitude: projectedLatitude * 180 / Math.PI,
        longitude: ((projectedLongitude * 180 / Math.PI + 540) % 360) - 180
    };
}

function projectAircraftData(data, now = Date.now()) {
    const datasetTimestamp = Number.isFinite(data?.updatedAt) ? data.updatedAt : null;
    const estimatedAt = Math.floor(now / 1000);
    const projectList = aircraftList => (aircraftList || []).map(aircraft => {
        const positionTimestamp = Number.isFinite(aircraft.lastPositionUpdate)
            ? aircraft.lastPositionUpdate
            : datasetTimestamp;
        const elapsedSeconds = positionTimestamp === null
            ? 0
            : Math.min(MAX_POSITION_PROJECTION_SECONDS, Math.max(0, estimatedAt - positionTimestamp));
        const position = projectPosition(aircraft.latitude, aircraft.longitude, aircraft.heading, aircraft.velocity, elapsedSeconds);
        const altitude = Number.isFinite(aircraft.altitude) && Number.isFinite(aircraft.verticalRate)
            ? Math.max(0, aircraft.altitude + aircraft.verticalRate * elapsedSeconds)
            : aircraft.altitude;

        return {
            ...aircraft,
            ...position,
            altitude,
            distanceKm: Number.isFinite(position.latitude) && Number.isFinite(position.longitude)
                ? distanceInKm(position.latitude, position.longitude)
                : aircraft.distanceKm,
            positionEstimated: elapsedSeconds > 0,
            projectionSeconds: elapsedSeconds
        };
    }).sort((first, second) => (first.altitude ?? Infinity) - (second.altitude ?? Infinity));

    const projectedAircraft = projectList(data?.aircraft).map(updateArrivalTrackColor);
    const generalTraffic = projectList(data?.generalTraffic);
    return {
        ...data,
        aircraft: projectedAircraft,
        generalTraffic,
        ...(Array.isArray(data?.recentTracks) ? { recentTracks: data.recentTracks.map(updateArrivalTrackColor) } : {}),
        positionEstimate: {
            isEstimated: [...projectedAircraft, ...generalTraffic].some(aircraft => aircraft.positionEstimated),
            estimatedAt,
            maximumSecondsAhead: MAX_POSITION_PROJECTION_SECONDS
        }
    };
}

function headingDifference(first, second) {
    return Math.abs(((first - second + 540) % 360) - 180);
}

function classifyApproachDirection(heading) {
    if (!Number.isFinite(heading)) return { direction: 'unknown', confidence: 'none', reason: 'No valid aircraft heading' };
    const nearest = RUNWAYS.map(runway => ({ ...runway, difference: headingDifference(heading, runway.heading) }))
        .sort((first, second) => first.difference - second.difference)[0];
    if (nearest.difference > RUNWAY_HEADING_TOLERANCE_DEG) {
        return { direction: 'unknown', confidence: 'none', reason: `Heading is ${Math.round(nearest.difference)}° from the nearest runway heading` };
    }
    const confidence = nearest.difference <= 15 ? 'high' : nearest.difference <= 30 ? 'medium' : 'low';
    return { direction: nearest.direction, confidence, reason: `Heading is ${Math.round(nearest.difference)}° from runway ${nearest.direction}` };
}

function normalizeOpenSkyData(data, diagnostics = null) {
    const states = Array.isArray(data.states) ? data.states : [];
    const summary = { stateCount: states.length, invalidPositionCount: 0, outsideBoundsCount: 0, inBoundsAircraftCount: 0 };
    const aircraft = states.map(state => {
        if (!Array.isArray(state) || !Number.isFinite(state[6]) || !Number.isFinite(state[5])) {
            summary.invalidPositionCount += 1;
            return null;
        }
        if (!isWithinSearchBounds(state[6], state[5])) {
            summary.outsideBoundsCount += 1;
            return null;
        }
        summary.inBoundsAircraftCount += 1;
        const distanceKm = distanceInKm(state[6], state[5]);
        const approach = classifyApproachDirection(state[10]);
        return {
            icao24: state[0], callsign: state[1]?.trim() || null, country: state[2], timestamp: state[3], lastPositionUpdate: state[3], lastContact: state[4],
            longitude: state[5], latitude: state[6], altitude: state[7], onGround: state[8], velocity: state[9], heading: state[10],
            verticalRate: state[11], geoAltitude: state[13], squawk: state[14], spi: state[15], positionSource: state[16],
            distanceKm, approachDirection: approach.direction, approachConfidence: approach.confidence, approachReason: approach.reason
        };
    }).filter(Boolean);
    if (diagnostics) Object.assign(diagnostics, summary);
    return { updatedAt: data.time || null, airport: GENEVA_AIRPORT, searchBounds: SEARCH_BOUNDS, aircraft };
}

function createTrackColor(icao24) {
    const hash = [...String(icao24).toLowerCase()].reduce((value, character) =>
        (Math.imul(value, 31) + character.charCodeAt(0)) >>> 0, 0);
    return `hsl(${ARRIVAL_TRACK_HUES[hash % ARRIVAL_TRACK_HUES.length]}, 90%, 45%)`;
}

function updateArrivalTrackColor(aircraft) {
    if (!aircraft.track || aircraft.track.colorVersion === TRACK_COLOR_VERSION) return aircraft;
    return {
        ...aircraft,
        track: { ...aircraft.track, color: createTrackColor(aircraft.icao24), colorVersion: TRACK_COLOR_VERSION }
    };
}

function addArrivalTracks(arrivals, previousArrivals = null, now = Date.now()) {
    const previousByIcao = new Map([...(previousArrivals?.generalTraffic || []), ...(previousArrivals?.aircraft || [])]
        .filter(aircraft => aircraft?.icao24)
        .map(aircraft => [aircraft.icao24.toLowerCase(), aircraft]));
    const timestamp = Number.isFinite(arrivals.updatedAt) ? arrivals.updatedAt : Math.floor(now / 1000);
    const oldestTimestamp = timestamp - MAX_TRACK_AGE_SECONDS;
    const activeIcao = new Set(arrivals.aircraft.map(aircraft => aircraft.icao24.toLowerCase()));
    const recentTracks = [
        ...(previousArrivals?.recentTracks || []).filter(track => track.expiresAt > timestamp && !activeIcao.has(track.icao24)),
        ...(previousArrivals?.aircraft || [])
            .filter(aircraft => aircraft?.icao24 && !activeIcao.has(aircraft.icao24.toLowerCase()) && aircraft.track)
            // Keep the last observed arrival, including its enrichment, with its trail.
            .map(aircraft => ({ ...aircraft, icao24: aircraft.icao24.toLowerCase(), disappearedAt: timestamp, expiresAt: timestamp + POST_LANDING_TRAIL_SECONDS }))
    ];

    return {
        ...arrivals,
        recentTracks: recentTracks.map(updateArrivalTrackColor),
        aircraft: arrivals.aircraft.map(aircraft => {
            const previousTrack = previousByIcao.get(aircraft.icao24.toLowerCase())?.track;

            return {
                ...aircraft,
                track: {
                    color: previousTrack?.colorVersion === TRACK_COLOR_VERSION ? previousTrack.color : createTrackColor(aircraft.icao24),
                    colorVersion: TRACK_COLOR_VERSION,
                    points: trackPoints(aircraft, previousTrack, timestamp, oldestTimestamp)
                }
            };
        })
    };
}

function trackPoints(aircraft, previousTrack, timestamp, oldestTimestamp) {
    const points = (previousTrack?.points || [])
        .filter(point => Number.isFinite(point?.latitude) && Number.isFinite(point?.longitude) &&
            Number.isFinite(point?.timestamp) && point.timestamp >= oldestTimestamp);
    const point = { latitude: aircraft.latitude, longitude: aircraft.longitude, timestamp };
    const lastPoint = points.at(-1);

    if (!lastPoint || lastPoint.latitude !== point.latitude || lastPoint.longitude !== point.longitude || lastPoint.timestamp !== point.timestamp) {
        points.push(point);
    }

    return points;
}

function addGeneralTraffic(arrivals, normalizedData, previousData = null, now = Date.now()) {
    const arrivalIds = new Set(arrivals.aircraft.map(aircraft => aircraft.icao24.toLowerCase()));
    const previousByIcao = new Map([
        ...(previousData?.aircraft || []), ...(previousData?.generalTraffic || [])
    ].map(aircraft => [aircraft.icao24.toLowerCase(), aircraft]));
    const timestamp = Number.isFinite(normalizedData.updatedAt) ? normalizedData.updatedAt : Math.floor(now / 1000);
    return {
        ...arrivals,
        generalTraffic: normalizedData.aircraft
            .filter(aircraft => !aircraft.onGround && aircraft.icao24 && !arrivalIds.has(aircraft.icao24.toLowerCase()))
            .map(aircraft => ({
                ...aircraft,
                track: {
                    color: '#00bfff',
                    points: trackPoints(aircraft, previousByIcao.get(aircraft.icao24.toLowerCase())?.track,
                        timestamp, timestamp - MAX_TRACK_AGE_SECONDS)
                }
            }))
    };
}

module.exports = { SEARCH_BOUNDS, addArrivalTracks, addGeneralTraffic, classifyApproachDirection, distanceInKm, isWithinSearchBounds, normalizeOpenSkyData, projectAircraftData };
