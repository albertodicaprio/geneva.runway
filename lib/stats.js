function topValues(flights, getValue) {
    const counts = new Map();
    let known = 0;
    for (const flight of flights) {
        const value = getValue(flight);
        if (!value) continue;
        known += 1;
        counts.set(value, (counts.get(value) || 0) + 1);
    }
    return {
        known,
        items: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([name, count]) => ({ name, count }))
    };
}

function airlineName(name) {
    return /^easyjet(?:\s|$)/i.test(name) ? 'easyJet' : name;
}

function topAirports(flights, getAirport) {
    const counts = new Map();
    let known = 0;
    for (const flight of flights) {
        const airport = getAirport(flight);
        const key = airport?.iata?.toUpperCase() || airport?.icao?.toUpperCase() || airport?.name;
        if (!key) continue;
        known += 1;
        const previous = counts.get(key) || { name: key, count: 0 };
        counts.set(key, { name: airport.name || previous.name, count: previous.count + 1 });
    }
    return {
        known,
        items: [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    };
}

function summarizeGroup(flights) {
    return {
        total: flights.length,
        airlines: topValues(flights, flight => flight.airline && airlineName(flight.airline)),
        origins: topAirports(flights, flight => flight.origin),
        destinations: topAirports(flights, flight => flight.destination),
        registrations: topValues(flights, flight => flight.registration),
        models: topValues(flights, flight => flight.model || flight.aircraftType)
    };
}

function summarizeFlights(flights, days) {
    return {
        days,
        landing: summarizeGroup(flights.filter(flight => flight.category === 'arrival')),
        general: summarizeGroup(flights.filter(flight => flight.category !== 'arrival' && flight.category !== 'departure')),
        takeoffs: summarizeGroup(flights.filter(flight => flight.category === 'departure'))
    };
}

module.exports = { summarizeFlights };
