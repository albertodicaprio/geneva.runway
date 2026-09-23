const fs = require('fs/promises');
const path = require('path');

const VERSION = 1;
const SESSION_GAP_SECONDS = 60 * 60;
const TIME_ZONE = 'Europe/Zurich';

function genevaDate(timestampMs) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date(timestampMs)).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function previousDate(date) {
    return new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}

function airport(airportData) {
    if (!airportData) return null;
    return {
        iata: airportData.iata_code || null,
        icao: airportData.icao_code || null,
        name: airportData.name || null,
        country: airportData.country_name || null
    };
}

function flightDetails(aircraft, category) {
    return {
        icao24: aircraft.icao24.toLowerCase(),
        callsign: aircraft.callsign || null,
        registration: aircraft.aircraftDetails?.registration || null,
        model: aircraft.aircraftDetails?.type || null,
        aircraftType: aircraft.aircraftDetails?.icao_type || null,
        airline: aircraft.route?.airline?.name || null,
        origin: airport(aircraft.route?.origin),
        destination: airport(aircraft.route?.destination),
        country: aircraft.country || null,
        category
    };
}

function isGenevaDeparture(aircraft) {
    const origin = aircraft.route?.origin;
    return origin?.iata_code?.toUpperCase() === 'GVA' || origin?.icao_code?.toUpperCase() === 'LSGG';
}

function mergeDetails(existing, incoming) {
    const merged = { ...existing };
    for (const [key, value] of Object.entries(incoming)) {
        if (key === 'category') {
            if (value === 'arrival' || (existing.category === 'other' && value === 'departure')) merged.category = value;
        } else if ((key === 'origin' || key === 'destination') && value) {
            merged[key] = { ...value };
            for (const [field, oldValue] of Object.entries(existing[key] || {})) {
                if (merged[key][field] == null && oldValue != null) merged[key][field] = oldValue;
            }
        } else if (value !== null && value !== undefined) {
            merged[key] = value;
        }
    }
    return merged;
}

function createFlightHistory({ directory, storage = fs } = {}) {
    if (!directory) throw new Error('Flight history directory is required');
    const loaded = new Map();

    async function load(date) {
        if (loaded.has(date)) return loaded.get(date);
        let document;
        try {
            document = JSON.parse(await storage.readFile(path.join(directory, `${date}.json`), 'utf8'));
            if (document.version !== VERSION || document.date !== date || !Array.isArray(document.flights)) {
                throw new Error(`Invalid flight history for ${date}`);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            document = { version: VERSION, date, flights: [] };
        }
        loaded.set(date, document);
        return document;
    }

    async function write(document) {
        await storage.mkdir(directory, { recursive: true });
        const destination = path.join(directory, `${document.date}.json`);
        const temporary = `${destination}.${process.pid}.tmp`;
        await storage.writeFile(temporary, JSON.stringify(document));
        await storage.rename(temporary, destination);
    }

    async function recordSnapshot(snapshot) {
        const seenAt = Number.isFinite(snapshot?.updatedAt) ? snapshot.updatedAt : Math.floor(Date.now() / 1000);
        const date = genevaDate(seenAt * 1000);
        const documents = [await load(previousDate(date)), await load(date)];
        const changed = new Set();
        const arrivals = (snapshot.aircraft || []).map(aircraft => [aircraft, 'arrival']);
        const general = (snapshot.generalTraffic || []).map(aircraft =>
            [aircraft, isGenevaDeparture(aircraft) ? 'departure' : 'other']);

        for (const [aircraft, category] of [...arrivals, ...general]) {
            if (!aircraft?.icao24 || aircraft.onGround) continue;
            const details = flightDetails(aircraft, category);
            const candidates = documents.flatMap(document => document.flights
                .filter(flight => flight.icao24 === details.icao24 &&
                    (flight.callsign === details.callsign || !flight.callsign || !details.callsign) &&
                    seenAt >= flight.lastSeenAt && seenAt - flight.lastSeenAt <= SESSION_GAP_SECONDS)
                .map(flight => ({ document, flight })));
            const match = candidates.sort((a, b) => b.flight.lastSeenAt - a.flight.lastSeenAt)[0];
            if (match) {
                Object.assign(match.flight, mergeDetails(match.flight, details), { lastSeenAt: seenAt });
                changed.add(match.document);
            } else {
                documents[1].flights.push({ ...details, firstSeenAt: seenAt, lastSeenAt: seenAt });
                changed.add(documents[1]);
            }
        }
        for (const document of changed) await write(document);
        for (const key of loaded.keys()) {
            if (key !== date && key !== previousDate(date)) loaded.delete(key);
        }
    }

    async function readDays(days, now = Date.now()) {
        const today = genevaDate(now);
        const result = [];
        for (let offset = 0; offset < days; offset++) {
            const date = new Date(Date.parse(`${today}T00:00:00Z`) - offset * 86400000).toISOString().slice(0, 10);
            result.push(...(await load(date)).flights);
        }
        return result;
    }

    return { recordSnapshot, readDays };
}

module.exports = { createFlightHistory, genevaDate };
