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

function topIcaoTypes(flights) {
    const counts = new Map();
    let known = 0;
    for (const flight of flights) {
        const code = flight.aircraftType;
        if (!code) continue;
        known += 1;
        const entry = counts.get(code) || { count: 0, models: new Map() };
        entry.count += 1;
        if (flight.model) entry.models.set(flight.model, (entry.models.get(flight.model) || 0) + 1);
        counts.set(code, entry);
    }
    return {
        known,
        items: [...counts].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
            .map(([name, entry]) => {
                const models = [...entry.models].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
                return { name, count: entry.count, examples: models.slice(0, 3).map(([model]) => model),
                    moreExamples: models.length > 3 };
            })
    };
}

function summarizeGroup(flights) {
    return {
        total: flights.length,
        airlines: topValues(flights, flight => flight.airline && airlineName(flight.airline)),
        origins: topAirports(flights, flight => flight.origin),
        destinations: topAirports(flights, flight => flight.destination),
        registrations: topValues(flights, flight => flight.registration),
        models: topValues(flights, flight => flight.model),
        icaoTypes: topIcaoTypes(flights)
    };
}

function summarizeHourly(flights) {
    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, landings: 0, takeoffs: 0 }));
    const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Zurich', hour: '2-digit', hourCycle: 'h23'
    });
    for (const flight of flights) {
        if (!Number.isFinite(flight.firstSeenAt)) continue;
        const category = flight.category === 'arrival' ? 'landings'
            : flight.category === 'departure' ? 'takeoffs' : null;
        if (category) hours[Number(formatter.format(new Date(flight.firstSeenAt * 1000)))][category] += 1;
    }
    return hours;
}

function summarizeOverview(flights) {
    const normalize = value => value?.trim().toLowerCase();
    const airports = flights.flatMap(flight => [flight.origin, flight.destination]).filter(Boolean);
    const aliases = new Map([['gva', 'lsgg'], ['geneva airport', 'lsgg']]);
    for (const airport of airports) {
        const icao = normalize(airport.icao);
        const iata = normalize(airport.iata);
        if (icao && iata) aliases.set(iata, icao);
    }
    for (const airport of airports) {
        const code = normalize(airport.icao) || aliases.get(normalize(airport.iata)) || normalize(airport.iata);
        if (code && airport.name) aliases.set(normalize(airport.name), code);
    }
    const airportKeys = new Set(airports.map(airport => normalize(airport.icao)
        || aliases.get(normalize(airport.iata)) || normalize(airport.iata)
        || aliases.get(normalize(airport.name)) || normalize(airport.name)).filter(key => key && key !== 'lsgg'));
    const landings = flights.filter(flight => flight.category === 'arrival').length;
    const takeoffs = flights.filter(flight => flight.category === 'departure').length;
    return {
        total: flights.length,
        aircraft: new Set(flights.map(flight => normalize(flight.icao24)).filter(Boolean)).size,
        airlines: new Set(flights.map(flight => flight.airline && normalize(airlineName(flight.airline))).filter(Boolean)).size,
        airports: airportKeys.size,
        landings,
        takeoffs,
        general: flights.length - landings - takeoffs
    };
}

function filterFlights(flights, query, view) {
    const text = String(query || '').trim().toLowerCase();
    if (!text) return flights;
    return flights.filter(flight => {
        const airports = view === 'landing' ? [flight.origin]
            : view === 'takeoffs' ? [flight.destination] : [flight.origin, flight.destination];
        const values = [flight.airline, flight.model, flight.aircraftType,
            ...(view === 'general' ? [] : [flight.registration]),
            ...airports.flatMap(airport => [airport?.name, airport?.iata, airport?.icao])];
        return values.some(value => value && value.toLowerCase().includes(text));
    });
}

function summarizeFlights(flights, days, filters = {}) {
    return {
        days,
        overview: summarizeOverview(flights),
        hourly: summarizeHourly(flights),
        landing: summarizeGroup(filterFlights(flights.filter(flight => flight.category === 'arrival'), filters.landing, 'landing')),
        general: summarizeGroup(filterFlights(flights.filter(flight => flight.category !== 'arrival' && flight.category !== 'departure'), filters.general, 'general')),
        takeoffs: summarizeGroup(filterFlights(flights.filter(flight => flight.category === 'departure'), filters.takeoffs, 'takeoffs'))
    };
}

module.exports = { summarizeFlights };
