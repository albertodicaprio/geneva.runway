function topValues(flights, getValue, limit = 8) {
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
            .slice(0, limit).map(([name, count]) => ({ name, count }))
    };
}

function airportLabel(airport) {
    return airport?.iata || airport?.icao || airport?.name || null;
}

function summarizeFlights(flights, days) {
    return {
        days,
        total: flights.length,
        categories: {
            arrivals: flights.filter(flight => flight.category === 'arrival').length,
            departures: flights.filter(flight => flight.category === 'departure').length,
            other: flights.filter(flight => flight.category !== 'arrival' && flight.category !== 'departure').length
        },
        airlines: topValues(flights, flight => flight.airline),
        origins: topValues(flights, flight => airportLabel(flight.origin)),
        destinations: topValues(flights, flight => airportLabel(flight.destination)),
        models: topValues(flights, flight => flight.model || flight.aircraftType)
    };
}

module.exports = { summarizeFlights };
