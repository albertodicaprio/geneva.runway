# Geneva Runway

A small, self-hosted Geneva Airport (LSGG/GVA) plane-spotting app. Its overview shows
nearby airborne flights whose ADSBdb route is confirmed to end at Geneva,
along with the likely runway approach direction (`04`, `22`, or `unknown`).
The navigation links to Overview, Arrivals (including recent landings), Stats,
and Weather.

The Weather tab at `/weather.html` shows today and the following four days near
Geneva Airport using [Open-Meteo](https://open-meteo.com/en/docs), preceded by a
Now card with current conditions: daily conditions,
temperature highs/lows (°C), precipitation chance and totals (mm), maximum wind
and gusts (km/h), and prevailing wind direction. The six cards include a
wind-based estimate for likely runway 04 or 22, preferring the direction facing
into the wind using approximate 040°/220° bearings. Fair conditions with wind
below 5 km/h and no reported gusts at or above 5 km/h show `22 (calm conditions)`,
reflecting Geneva's preference for 22. Fair Open-Meteo conditions require a
clear/cloudy weather code and zero precipitation; other light winds, missing
wind data, or wind within 15° of perpendicular to the runway show unknown.
Daily estimates use prevailing direction and maximum wind speed, so they are
a rough guide and do not confirm actual runway use. Current conditions show
their Geneva-local report time. Cards are capped at six; an odd final card is
omitted. Each weather card includes a north-up runway/wind compass with speed,
gusts and wind-source direction below it. The runway uses the published rounded
046°/226° true bearings from the [OurAirports runway dataset](https://github.com/davidmegginson/ourairports-data/blob/main/runways.csv)
(LSGG, runway 04/22, checked 6 October 2026). The orange arrow flows inward from
the direction the wind comes from. Its length represents wind speed and its
width represents gust strength, using independent square-root scales shared
across cards. Light winds have a visible minimum length; at 60 km/h the arrow
spans nearly the whole circle. Drawing dimensions are capped at 60 km/h, while
the readouts retain actual speeds. Missing gusts use the minimum arrow width.
Calm, variable or missing winds have no fixed arrow. Daily readouts retain maximum wind/gusts and dominant direction.
`/api/weather` fetches on demand, shares concurrent requests, and caches results
in memory for 30 minutes (refreshing when the Geneva date changes). Failed
refreshes serve the last forecast with an explicit stale flag and retry after
one minute; without a cached forecast the API returns 503. The browser refreshes
every 30 seconds while visible; weather provider requests still use the shared
30-minute cache. The Now card also shows
the newest unexpired recent arrival's runway, with its estimated landing time
in the badge tooltip, from the existing aircraft cache without triggering an OpenSky
request. Unknown directions remain unknown, and tracking older than ten minutes
is marked stale. These records are inferred from arrivals leaving tracking and
their last headings; they do not confirm touchdown or the active runway. Restarting
the server clears the weather cache. This uses no API key or new dependency and
does not affect OpenSky polling. Weather data is attributed to Open-Meteo under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

The Node server uses `lib/aircraft-service.js` to own the saved snapshot,
refresh schedule, and stale fallback. `lib/opensky.js` fetches OpenSky data,
`lib/adsbdb.js` enriches routes and aircraft, and `lib/traffic.js` normalizes
and projects positions and retains tracks. The browser keeps one request
waiting for the next completed cache refresh and advances displayed map
positions once per second. A waiting request returns the current cache after
25 seconds so it stays within the proxy timeout; the browser then waits again.
Position estimates stop 60 seconds after each aircraft's last report. Tests
create isolated service instances with supplied fetch, clock, and cache
storage, so they do not need live credentials or the app's cache file.

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

# Umami dashboard: the Docker host's LAN IPv4 address (not a client's address).
UMAMI_BIND_ADDRESS=192.168.0.184
UMAMI_PORT=3001
# Optional: website UUID from this deployment's Umami dashboard.
# Leave blank until the website entry has been created.
UMAMI_WEBSITE_ID=
# Generate three different values with: openssl rand -hex 32
UMAMI_DB_PASSWORD=replace-with-first-generated-hex-string
UMAMI_APP_SECRET=replace-with-second-generated-hex-string
UMAMI_TWO_FACTOR_ENCRYPTION_KEY=replace-with-third-generated-hex-string
```

Build and start the app:

```sh
docker compose up --build -d
```

Open `https://gva-runway.duckdns.org` or `https://gva-runway.ahpc.ch`. Caddy publishes the website:
it redirects HTTP to HTTPS, obtains and renews the Let's Encrypt certificate,
and proxies requests to the Node app over Docker's private network. The app's
port 3000 is not reachable from the host network.

Umami also publishes a dashboard on the configured LAN address and port; see
the setup instructions below. All four services start with the normal Compose
command. The app and Caddy do not depend on the analytics services.

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

The Stats page at `/stats.html` has a calendar for choosing a recorded Geneva
day or an inclusive range. Future days and days without archived flights are
disabled; gaps inside a selected range contribute no flights. Its Landings, General, and Takeoffs bar
shows each category separately. General includes overflights and unknown
routes; takeoffs are Geneva departures. Each category has its own total and
airline, airport, and model charts. `/api/stats?available=1` lists selectable
dates, and `/api/stats?from=YYYY-MM-DD&to=YYYY-MM-DD` serves all three
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

### Umami analytics: LAN dashboard

Compose runs Umami `3.4.0` and PostgreSQL `15-alpine` alongside the app and
Caddy. The Umami release is fixed; PostgreSQL stays on major version 15 while
allowing patch updates when the image is pulled. PostgreSQL is on an internal
analytics network with no published host port. Only Umami shares that network
with it. Umami waits for database readiness and applies its schema migrations
automatically on startup. Caddy exposes only the tracker script and page-view
collection endpoint; dashboard access uses the dedicated LAN port.

Set `UMAMI_BIND_ADDRESS` to the Docker host's LAN IPv4 address and reserve that
address in your router's DHCP settings so it remains stable. The example above
uses `192.168.0.184`; use the appropriate address for your host. Set `UMAMI_PORT`
if port 3001 is occupied. The dashboard listens on that specific address, so
`localhost:3001` is not the dashboard URL. Keep this port available only to your
LAN; do not forward it on the router. The dashboard uses HTTP in this step.

Generate a separate value for each of the three analytics secrets:

```sh
openssl rand -hex 32
```

Copy the generated values into the ignored `.env` file. Hexadecimal database
passwords work directly in the database connection URL. The encryption key
must contain exactly 64 hexadecimal characters and prepares Umami for optional
two-factor authentication. Keep these values stable across container rebuilds
and recreation. Changing `UMAMI_DB_PASSWORD` in `.env` does not change the
password of an already initialized PostgreSQL database.

Check configuration and start the services:

```sh
docker compose config --quiet
docker compose up --build -d --wait --wait-timeout 180
docker compose ps
```

Avoid sharing unredacted `docker compose config` output: it contains the
resolved secrets. Open `http://<server-LAN-IP>:3001` from a LAN device, log in
with the initial **admin / umami** credentials, and immediately change the
administrator password in **Settings → Profile**. Verify that the changed
password works before proceeding to website integration.

The PostgreSQL data is stored in the dedicated `umami_db_data` named volume
(prefixed with the Compose project name). It survives container recreation
and `docker compose down`. `docker compose down -v` deletes this volume too.
No backup tooling is configured.

For a manual check before adding a tracker to the website:

1. Confirm both analytics services are healthy with `docker compose ps`.
2. Open `http://<server-LAN-IP>:3001/api/heartbeat`; expect HTTP 200.
3. In Umami, add a temporary test website and copy its website ID from the
   generated tracking code's `data-website-id` attribute. Open
   `http://<server-LAN-IP>:3001/console/<website-id>` while logged in as
   administrator. Send a test page view and confirm it appears in Umami.
   The test console is enabled for this initial check; it requires admin access.
4. Recreate the two analytics containers with
   `docker compose up -d --force-recreate --wait --wait-timeout 180 umami-db umami`.
   Confirm the login, test website and page view remain present.
5. With local `CADDY_SITE_ADDRESS=http://:80`, check `http://127.0.0.1/` and
   `http://127.0.0.1/api/aircraft` still serve the app and JSON respectively.

Umami's own anonymous telemetry is disabled.

Upstream references: [Docker configuration](https://github.com/umami-software/umami/blob/v3.4.0/docker-compose.yml),
[environment settings](https://docs.umami.is/docs/environment-variables),
and [initial login](https://docs.umami.is/docs/login).

### Website analytics

The Overview, Arrivals, Stats and Weather pages load Umami's deferred tracker
from `/script.js`. Caddy forwards only `GET`/`HEAD /script.js` and
`POST /api/send` to Umami. All other paths go to the app, so the Umami dashboard,
login and administrative API are not exposed through the public website.
Tracker requests use the website's own origin, including HTTPS in production,
and work with the app's existing browser security policy. Caddy's existing
request limits apply to analytics too.

Register one website named **Geneva Runway**, with domain
**gva-runway.ahpc.ch**, in the LAN Umami dashboard. Its website ID is public
configuration, not a secret. Copy the ID from its tracking code into `.env`:

```dotenv
UMAMI_WEBSITE_ID=your-website-uuid
```

The Node server inserts the tracker tag into each page using this runtime
setting. When it is blank, tracking is disabled; an invalid UUID disables
tracking and logs a warning without preventing the app from starting. Only the
website ID is inserted; analytics credentials remain on the server.

On a fresh production database, create the website entry there and set its new
ID in production's `.env`. Reusing the existing database preserves the ID.
After changing the value, run `docker compose up -d app` to recreate the app
with the new environment. No image rebuild or Caddy reload is needed for an
ID change. For `npm start`, restart the Node process after editing `.env`.

Tracking runs on whichever hostname serves the app, including localhost, LAN
addresses and both public domains; there is no `data-domains` restriction. All
visits go to the configured website entry in that deployment's Umami database.
Dev and production hosts can use separate Umami databases; configure the
appropriate website ID in each deployment. The tracker respects Do Not Track
and excludes URL query strings and fragments. It records page views, visits,
referrers and page usage; no custom interaction events, user IDs or performance
tracking are configured. It does not affect aircraft polling or OpenSky's
shared refresh schedule.

Rebuild the app and reload Caddy after changing the integration:

```sh
docker compose up -d --build app
docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

Visit a public website page and check its browser Network tab for a successful
`/script.js` load and `POST /api/send`, then check Umami for the visit. A blocker
or Do Not Track can prevent collection. Umami being unavailable does not stop
the app from loading; tracker requests fail independently.

Reference: [Umami tracker configuration](https://docs.umami.is/docs/tracker-configuration).

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
