# Geneva Runway

A small, self-hosted Geneva Airport (LSGG/GVA) plane-spotting app. Its overview shows
nearby airborne flights whose ADSBdb route is confirmed to end at Geneva,
along with the likely runway approach direction (`04`, `22`, or `unknown`).
The navigation links directly to separate Arrivals and Recent landings pages.

The Node server uses `lib/aircraft-service.js` to own the saved snapshot,
refresh schedule, and stale fallback. `lib/opensky.js` fetches OpenSky data,
`lib/adsbdb.js` enriches routes and aircraft, and `lib/traffic.js` normalizes
and projects positions and retains tracks. The browser fetches a snapshot every
30 seconds and advances displayed map positions once per second, stopping at
60 seconds from each aircraft's last position report. Tests create isolated
service instances with supplied fetch, clock, and cache storage, so they do
not need live credentials or the app's cache file.

The app is intended to run on a home-network machine, rather than a public
cloud host. It obtains live position data from OpenSky and route and aircraft
details from ADSBdb.

When an arrival leaves the live list, its recorded track and full last-known
details (including callsign, route, airline, registration, and aircraft type)
remain together in the cache and the API's `recentTracks` for two hours. These
are last observed values; leaving the list does not confirm touchdown. The map
continues to show the retained trail without an aircraft marker. Older cached
trails that already lost their details remain usable but cannot recover them.
The Recent landings page lists unexpired flights, newest
first, with aircraft type, registration, estimated landing time in Geneva time,
and the last likely runway and heading. Unavailable details are shown as unknown.

The map has independent toggles for landing traffic (including retained paths),
general traffic, and Geneva departures. Landing traffic starts visible; general traffic starts hidden,
and the browser remembers the layer choices. General traffic includes other airborne
OpenSky aircraft in the area, including flights with unknown destinations and
high-altitude overflights. Its aircraft icons are light navy blue. Its trails are neon blue at 55% opacity, accumulate
up to one hour of positions, and disappear when the aircraft leaves the live
data. All layers share the existing upstream refresh and cache. Click a plane icon
to expand its photo, model, full origin/destination airport names, ground speed
(km/h), altitude (metres), and heading (degrees) below the map. Aircraft hover
tooltips are disabled; missing measurements appear as a dash.
Landing icons match their trails, using a stable green/yellow/orange/purple
palette that avoids the blue and red of other layers. Existing landing trails
receive the updated palette without losing recorded positions.
The selected icon turns bright yellow; unavailable photos show a placeholder.
Click it again, use Close, or press Escape to dismiss the details. Aircraft
models for general traffic use cached ADSBdb lookups. Geneva departures has its
own independent toggle for airborne flights whose reported origin is GVA/LSGG,
with bright red trails at 55% opacity and blood red icons. These flights are
excluded from general traffic to avoid duplicates. Unknown origins stay in
general traffic. All three layer choices are remembered.

## Run with Docker Compose

### Prerequisites

- Docker Engine with Docker Compose v2 (`docker compose`)
- OpenSky Network API credentials
- A DuckDNS record for `gva-runway.duckdns.org` pointing to the home-network
  public IP address
- Router port-forwarding for TCP ports 80 and 443 to this Docker host

Create a `.env` file in the project root. It is ignored by Git and must not be
committed:

```dotenv
# OpenSky auth
OPENSKY_NETWORK_CLIENT_ID=your-client-id
OPENSKY_NETWORK_CLIENT_SECRET=your-client-secret

# How to expose the site via Caddy. Use both public domains in production.
CADDY_SITE_ADDRESS=http://:80
```

Build and start the app:

```sh
docker compose up --build -d
```

Open `https://gva-runway.duckdns.org` or `https://gva-runway.ahpc.ch`. Caddy is the only published service:
it redirects HTTP to HTTPS, obtains and renews the Let's Encrypt certificate,
and proxies requests to the Node app over Docker's private network. The app's
port 3000 is not reachable from the host network.

Both public DNS records and port forwarding must be in place before the first
startup so Let's Encrypt can validate each domain. Keep the named Caddy volumes;
they contain Caddy's certificate and renewal state.

The app stores its aircraft snapshot and ADSBdb enrichment in the named
`aircraft_data` volume at `/app/data/aircraft-cache.json`. It survives container
restarts, rebuilds, and `docker compose down`. Do not use `docker compose down -v`
if you want to keep this data. An existing snapshot in a previous container's
`/tmp` is not moved automatically; the app will fetch a new snapshot after
the update.

The same volume stores daily flight records in `/app/data/flight-history/`.
Each file is named for the Geneva local date when a flight was first seen.
Records include first/last seen times, aircraft identity, model, airline, and
known airports, but no positions or trails. The archive starts with new
successful OpenSky refreshes; earlier cache data is not backfilled. Files are
retained until manually removed.

The Stats page at `/stats.html` summarizes today's, the last seven days', or
the last 30 days' archived flights. Its Landings, General, and Takeoffs bar
shows each category separately. General includes overflights and unknown
routes; takeoffs are Geneva departures. Each category has its own total and
airline, airport, and model charts. `/api/stats?days=7` serves all three
summaries without making an OpenSky request. Arrival and departure
identification relies on ADSBdb route data; the charts show their known-data
coverage. Each chart initially shows up to eight ranked values; a checkbox
reveals the full list when more are available. Landings rank registrations in
place of destinations, and Takeoffs rank registrations in place of origins.
Airport charts show full names when ADSBdb provides them, falling back to
airport codes for entries without names.

### Caddy reverse proxy

Docker Compose runs Caddy as the public-facing service. It is the only
container that publishes ports 80 and 443; it forwards traffic to the internal
Node app, manages the production TLS certificate, and writes request logs to
its container log stream. It is built locally with Caddy Defender and
`caddy-ratelimit`; every path is limited to 120 requests per 15-second sliding
window per client IP, while `/api/aircraft` also has a separate 24-request limit
over the same window. IPv6 addresses are grouped by `/64`. The broader site
limit covers rapid page navigation and assets while still limiting arbitrary
bot probes. Defender blocks known automated-cloud ranges with `403`. Caddy
returns `429` and `Retry-After` when a limit is reached; the browser uses that
header to resume polling after the window clears.

`CADDY_SITE_ADDRESS` configures Caddy's site address:
- In dev we use `http://`
- In prod the default serves both `https://gva-runway.duckdns.org` and
  `https://gva-runway.ahpc.ch`.

Useful commands:

```sh
docker compose logs -f
docker compose down
```

The first `docker compose up --build` also downloads and compiles the two
Caddy plugins, so it takes longer than rebuilding the Node app alone.

### Development VM: HTTP only

The production default uses HTTPS. To run Caddy on a development VM without
requesting a Let's Encrypt certificate, set the HTTP-only catch-all site
address in the VM's `.env` file:

```dotenv
CADDY_SITE_ADDRESS=http://:80
```

Then start it normally with `docker compose up --build -d`. Open the VM over
HTTP on port 80. The `http://` prefix disables Caddy's automatic HTTPS and
certificate management. Do not use this setting for the public deployment.
Caddy access logs are written to its container stdout; view them with:

```sh
docker compose logs -f caddy
```

## Run the unit tests

The tests use Node's built-in test runner and do not require OpenSky
credentials or network access. With Node.js 20 or newer installed, run:

```sh
npm test
```

There are no npm package dependencies to install for the current test suite.

## Local development without Docker

Use the same `.env` file described above, then run:

```sh
npm start
```

The app listens on `http://127.0.0.1:3000/` by default.
Without extra configuration, its cache remains in the system temporary
directory. To keep local development data in the project across restarts, add
this line to `.env`:

```dotenv
AIRCRAFT_CACHE_FILE=./data/aircraft-cache.json
```

The app creates the directory on its first successful cache write. Daily flight
files are placed in `data/flight-history/` by default; set
`AIRCRAFT_HISTORY_DIR` to use another directory. `data/` is
ignored by Git. Docker Compose sets its own cache path, so this local setting
does not change where container data is stored.
