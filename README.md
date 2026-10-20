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
referrers and page usage. Authentication and Telegram also send custom server events
described below. No distinct user IDs or performance tracking are configured.
Analytics does not affect aircraft polling or OpenSky's shared refresh schedule.

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

### Authentication analytics

The auth endpoints send custom events to the same Umami website entry:

| Event | When | Event properties |
| --- | --- | --- |
| `sign_in_started` | A Google login flow is created | `provider` |
| `sign_in_succeeded` | Google identity is verified and a session is created | `provider`, verified full `name`, `email` |
| `sign_in_cancelled` | Google returns `access_denied` | `provider` |
| `sign_in_failed` | Configuration, callback or identity validation fails | `provider`, general `reason` |
| `sign_out_succeeded` | The authenticated sign-out request succeeds | `provider`, verified full `name`, `email` |

All events use `provider: "google"`. Failure reasons are limited to
`not_configured`, `busy`, `invalid_state`, `provider_error`, `invalid_callback`,
`token_exchange`, `token_validation`, and `invalid_identity`. Names and emails
are collected only after verification and remain properties of authenticated
server events; they are not attached to every page view. Umami stores this personal
data alongside the event, independently of the application's sign-in logs.
Session polling and settings requests do not generate auth events.

Compose sets `UMAMI_AUTH_EVENTS_URL=http://umami:3000/api/send`. Together with
the existing `UMAMI_WEBSITE_ID`, this enables events without an API key or
dashboard credentials. For `npm start`, set `UMAMI_AUTH_EVENTS_URL` to the
reachable local Umami collection endpoint, for example
`http://<server-LAN-IP>:3001/api/send`. A missing URL or missing/invalid website
ID disables server events. Only `/api/send` endpoints without query strings or
credentials are accepted. Caddy's public routes do not need changes.

`UMAMI_AUTH_EVENTS_TRUST_PROXY=true` is set by Compose because Caddy is the
controlled ingress and the app has no published port. It uses the forwarded
client IP with the browser's User-Agent for Umami's usual visit attribution.
Leave the flag unset/false for direct Node access. Auth paths are fixed in the
payload: OAuth codes, state, tokens, cookies, CSRF values, callback query
parameters and raw error messages are never sent to Umami.

Server events honor `DNT: 1`. A login started with Do Not Track remains opted
out for its callback and the resulting session's sign-out. Browser blockers
do not suppress these direct server requests. Delivery runs independently of
authentication, with a 1.5-second deadline, at most 32 concurrent sends and no
retries. Failed or excess events are dropped; generic delivery warnings are
limited to one per minute. Sign-in and sign-out continue if Umami is unavailable.

In Umami, open the website's Events view to inspect counts and event properties,
or use its live test console. After deploying, sign in and out once to verify
the success events and their name/email properties. Use a separate development
website entry if you do not want test activity included in production counts.

The payload follows the installed
[Umami 3.4.0 collection endpoint](https://github.com/umami-software/umami/blob/v3.4.0/src/app/api/send/route.ts).

### Telegram analytics and message logs

Telegram reuses `UMAMI_WEBSITE_ID` and `UMAMI_AUTH_EVENTS_URL`; no additional
configuration is needed. Server events use `provider: "telegram"` and
`source: "server"`:

| Event | When |
| --- | --- |
| `telegram_connected` | Telegram confirms a single-use link and the connection is saved |
| `telegram_disconnected` | An existing connection is successfully removed |
| `telegram_test_sent` | Telegram accepts a test message |
| `telegram_runway_change_sent` | Telegram accepts an arrival runway change alert |
| `telegram_busy_arrivals_sent` | Telegram accepts a busy arrival alert |
| `telegram_holding_arrivals_sent` | Telegram accepts a possible holding alert |

Properties identify the website `accountId`, verified Google `name` and `email`,
and the recipient's `telegramName` and `telegramUsername` when available.
Notification events also include `notificationType` (`test`,
`arrivalRunwayChange`, `busyArrivals`, or `holdingArrivals`). Events exclude the full message,
Telegram chat IDs, tokens, links, cookies and request parameters. A sent event
means Telegram accepted the message; it does not confirm the user read it.
Failed or ambiguous sends do not produce sent events. Duplicate linking updates,
conflicting links, cancelled linking attempts and repeated disconnects do not
produce additional connection events. Polling and preference saves emit none.

The connection file privately stores the verified account name/email, browser
User-Agent and Do Not Track choice from linking, updated when the owner opens
the account menu. Existing connections gain these fields on their next menu
check, without reconnecting or generating a historical connection event.
Background events use that browser agent so the collector can accept them, with
no saved client IP. Without saved browser context they are skipped. Do Not
Track from the Google login session or current request suppresses analytics,
including later background events. These events share the existing 1.5-second
deadline and 32-request limit with auth events; failures are dropped without
retries and cannot trigger a Telegram retry.

Each actual notification attempt writes one JSON log line with event
`telegram_notification_sending`, UTC `timestamp`, `accountId`, verified `name`
and `email` when known, `telegramName`, `telegramUsername`, `notificationType`
and the exact `message`. JSON escapes embedded newlines in messages/names.
A following `telegram_notification_sent` or `telegram_notification_failed` line
records the outcome. Failures use only `blocked`, `rate_limited` or `unconfirmed`
reasons, with no raw upstream error or secret. Delivery retries each generate an
attempt log. Logs remain enabled independently of Umami configuration and Do
Not Track; they contain personal details and full notification text.

Local validation added five clearly synthetic Umami records under
Telegram Analytics Check / telegram-check@example.invalid, with Telegram sends
mocked. These records verify the real local collector accepts each event type.

## Optional Google sign-in

The dashboard stays public. Signing in unlocks the Auto/Night/Day theme
control under Profile in the account dropdown on every page. Signed-out visitors always use Auto
(Day 07:00–19:00, Night 19:00–07:00, Geneva time). Theme preferences save
automatically to the account and follow it across browsers and devices.
Signing out restores Auto and preserves the account's preference for next time.
The saved theme loads with each page and refreshes when the window gains focus
or during the once-per-minute session check. Existing browser-only preferences
are imported when an account has no theme saved on the server yet.

Account settings are stored in a JSON file keyed by the verified, lowercase
Google email address, with an object for each user's current and future settings:

```json
{
  "alice@example.com": {
    "theme": "night"
  }
}
```

Docker Compose stores the file at `/app/data/user-settings.json` in the existing
`aircraft_data` volume. Locally it defaults to `data/user-settings.json` (ignored
by Git); set `USER_SETTINGS_FILE` to override the local path. The file is created
when the first preference is saved and should be included in data backups.
Settings survive app restarts, image rebuilds and sign-out. Sessions still clear
on restart, so users must sign in again before their saved theme is restored.
Writes are serialized and replace the JSON file atomically; changing the theme
preserves other users and any future settings fields. This file store is intended
for the current single app instance. Only the signed-in user can update their
own settings; the browser cannot choose a different email key.

Copy the settings from `.env.example` into your existing ignored `.env`:

```dotenv
APP_ORIGIN=https://gva-runway.ahpc.ch
GOOGLE_OAUTH_CLIENT_ID=your-google-web-client-id
GOOGLE_OAUTH_CLIENT_SECRET=your-google-web-client-secret
```

In your existing Google OAuth **Web application** client, add this exact
**Authorized redirect URI**:

```text
https://gva-runway.ahpc.ch/auth/google/callback
```

`APP_ORIGIN` is only the website address (`https://gva-runway.ahpc.ch`); do not
include `/auth/google/callback` there. The full callback URI above belongs in
Google's Authorized redirect URIs. If the Google consent screen
is in Testing, add the Google accounts you want to use as test users. The app
requests only OpenID identity, basic profile and email scopes. It uses Google's
official `google-auth-library` to exchange authorization codes and verify ID
tokens, with state, nonce and PKCE checks. No Google tokens or client secrets
are sent to browser storage, saved to disk, or logged by the application.
See [Google's OpenID Connect documentation](https://developers.google.com/identity/openid-connect/openid-connect).

After deploying the updated image, restart/recreate `app` after changing these
environment values. Compose already loads `.env` into the app. Do not copy
`.env.example` over an existing `.env` containing OpenSky and Umami settings.
Without all three Google settings, the dashboard works and the sign-in button
explains that sign-in is not configured. `APP_ORIGIN` must match the address
used in the browser; production session cookies require HTTPS.

For `npm start` locally, set `APP_ORIGIN=http://127.0.0.1:3000` and register
`http://127.0.0.1:3000/auth/google/callback` in Google. For local Docker Compose,
keep `CADDY_SITE_ADDRESS=http://:80`, run both `app` and `caddy`, use
`APP_ORIGIN=http://127.0.0.1`, and register
`http://127.0.0.1/auth/google/callback`. Use separate local credentials if desired.
Always use the matching browser address when testing sign-in.

Sessions use random opaque IDs in HttpOnly, SameSite=Lax cookies (Secure on
HTTPS). They expire after seven days and are kept in memory: restarting the
app signs everyone out. This fits the current single-instance home deployment.
Sign-out ends the local app session; it does not sign the user out of Google.

Each successful sign-in writes one JSON log entry with `event: "google_sign_in"`,
a UTC timestamp, the user's Google profile name, and their verified email
address. View these entries with
`docker compose logs -f app` (or the terminal running `npm start`). Tokens,
credentials and session IDs are excluded from these entries.

## Run the unit tests

The tests use Node's built-in test runner and do not require OpenSky
credentials or network access. With Node.js 24 LTS installed (`nvm use` if you
use nvm), run:

```sh
npm ci
npm test
```

Authentication tests substitute the Google client, so they need no real Google
credentials or live sign-in. Completing the Google consent flow must also be
checked manually after configuring your client.

## Local development without Docker

The project targets Node.js 24 LTS (`.nvmrc`); Docker uses `node:24-alpine`.
Use the same `.env` file described above, then run:

```sh
npm ci
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

## Optional Telegram integration

Signed-in users can connect a private Telegram account from **Telegram
Integration**, below Profile in the account dropdown on every
page. Click Connect and open the bot link, or scan its QR code with a phone,
then press **Start** in Telegram. Leave the dropdown open to see the connection
appear automatically. Send test message sends a single notification; Disconnect
removes the saved association and invalidates pending links and alerts.
Automatic alerts are off by default and can be enabled under Telegram Integration → Alerts.

Setup:

1. Open the verified [BotFather](https://t.me/BotFather) account in Telegram and
   use `/newbot`. Choose the app's name and a unique username ending in `bot`.
   Disable group joining using `/setjoingroups`; website users connect private
   chats only. No bot commands or Telegram login/domain settings are needed.
2. Copy the Telegram section of `.env.example` into your existing ignored
   `.env`. Set `TELEGRAM_BOT_TOKEN` to BotFather's API token and
   `TELEGRAM_BOT_USERNAME` to the bot username without `@`. Keep both blank
   to disable the integration. Never put credentials in source control,
   browser URLs or screenshots.
3. For local Node development, use `APP_ORIGIN=http://127.0.0.1:3000` and its
   matching Google OAuth redirect URI (see Optional Google sign-in above),
   then run `npm start`. For local Docker, use `APP_ORIGIN=http://127.0.0.1`
   and the matching Google redirect URI, start both `app` and `caddy`, and open
   `http://127.0.0.1/`. Keep the local Caddy setting `CADDY_SITE_ADDRESS=http://:80`.
4. Sign in, connect through the link or QR code, press Start in Telegram,
   then send a test message from the app. No public URL, tunnel, webhook
   secret, registration script or production deployment is needed.

The Node server checks that the token and username identify the same bot and
starts one background [Telegram long-polling loop](https://core.telegram.org/bots/api#getupdates).
Each request waits up to 30 seconds, returning immediately when an update
arrives; its HTTP timeout is 40 seconds. Sending a notification retains its
separate eight-second timeout. This uses outbound HTTPS only, independently
of browser activity and aircraft refreshes. Invalid credentials, mismatched
bot usernames or another receiver using the same bot stop polling with an
explanatory console message. Network/storage failures retry with exponential
backoff up to 30 seconds, honoring longer Telegram rate-limit delays.

Use separate BotFather bots and data files for development and production.
Only one running app instance can receive updates for a bot; do not run local
Node and Compose simultaneously with the same token. Server startup does not
configure or remove webhooks. Polling is cancelled when the app shuts down.

The app accepts the [deep-link](https://core.telegram.org/bots/features#deep-linking)
`/start <token>` event only from a matching private-chat sender. Other messages
and commands receive no reply; the console records only the update ID and a
fixed category (command, message, attachment, other), without text, arguments,
names, chat IDs or attachment content. Processed update cursors are persisted
per bot before acknowledgement, so restarts do not replay processed events.
A failed operation is retried without acknowledging later events.

Connections are one-to-one and keyed by verified Google account ID, independent
of email or Telegram username changes. The saved Telegram name/username reflect
what was provided when linking. Connections survive logout, session expiry,
restart and image rebuilds. Locally they are stored in ignored
`data/telegram-connections.json`; Compose uses
`/app/data/telegram-connections.json` in `aircraft_data`. Include this file in
private backups; do not delete the volume when upgrading. Use
`TELEGRAM_CONNECTIONS_FILE` to override the path. Atomic serialized writes are
intended for one app instance; the bot identity and polling cursor are saved
in the same file. Malformed files are preserved and reported as
unavailable rather than overwritten.

Link tokens and QR codes are generated locally, expire after ten minutes, and
are invalidated by creating a replacement, successful linking, disconnecting,
or restarting the server. Treat them as private. If a Telegram account is
already linked elsewhere, disconnect it from that website account first.
QR generation uses the `qrcode` dependency to avoid sharing tokens with an
external QR service. Account endpoints require a session; mutations also
require same-origin requests and the session's CSRF token.

Test messages and arrival runway changes are providers in `lib/notification-providers.js`.
Providers render text while the Telegram service owns recipient selection and
delivery. Test attempts have a persistent ten-second cooldown, honor Telegram's
rate-limit delay, and time out after eight seconds. They are not retried
automatically because a timed-out request may already have delivered. If the
bot is blocked, unblock it in Telegram, then disconnect and reconnect in the
app. Further notification preferences and airport/aircraft providers are tracked
in `ROADMAP.md`.

### Arrival runway change alerts

After connecting Telegram, open **Telegram Integration → Alerts** in the account
menu and enable **Arrival runway changes**. The switch saves per account,
synchronizes across devices, and defaults off for newly connected accounts.
Existing runway-alert opt-ins are preserved. Disconnecting clears preferences
and pending deliveries; reconnecting starts with alerts off.

A background worker checks the existing aircraft cache once per minute without
needing an open browser. It uses the same retained arrivals behind the weather
page's Last arrival badge and processes every new arrival in chronological
order, including multiple arrivals between checks. It never requests weather
or triggers extra OpenSky refreshes.

Two consecutive distinct arrivals with the same inferred runway establish the
current direction. A notification is sent when a matching pair establishes a
different direction. For example, after runway 22 is established, the sequence
`22, 04, 22, 04, 04` alerts only at the final 04. An opposite or unknown arrival
breaks the candidate pair. Repeated reads and reappearance of the same flight
cannot count twice; the pair must contain different aircraft. All further
arrivals on the established direction remain silent. A newly confirmed reverse
change can alert immediately, without an hour-long cooldown or weather delay.
Delivery normally starts on the next one-minute check after the second arrival
appears in the cache.

Enabling or restarting consumes existing arrival history silently as a baseline.
Stale tracking clears confirmation and cancels pending delivery. Messages name
the two flights, their estimated arrival times in Europe/Zurich, and the previous
and new inferred runway. Disappearance from tracking does not confirm touchdown;
this alert reflects the app's existing arrival classifications.

Detection state and one pending alert per account persist in the Telegram data
file. Delivery makes at most three attempts, honors Telegram rate limits, and
expires 15 minutes after the confirming arrival. A confirmed reverse change
replaces queued delivery; a single noisy opposite arrival cannot cancel a
confirmed alert. Disabling the switch or disconnecting cancels pending alerts,
and preferences are rechecked before delivery. A network timeout may mean
Telegram accepted the message, so a retry can occasionally duplicate it.
Blocked bots stop receiving alerts and show delivery unavailable. Quiet hours
remain future work in `ROADMAP.md`.

### Busy arrival alerts

Under **Telegram Integration → Alerts**, enable **Busy arrivals** after connecting
Telegram. This separate opt-in defaults off. Set **More than** to a whole number
from 1 to 100 (default 10): the default alerts at 11 or more live tracked Geneva
arrivals, rather than counting historical landings or departures. The threshold
is editable only while Busy arrivals is enabled. Type a value and tap **Save**
(or press Enter); leaving the field and using its arrows do not save it.
The Save button shows **Saving…** during saving and becomes disabled once
the value is saved. Background checks preserve unfinished edits. Failed saves retain your draft so
you can retry; saved values continue to synchronize across devices.

A background check runs once per minute without an open browser. It reads the
existing aircraft cache only, counts distinct aircraft with positions less than
two minutes old, and ignores snapshots two minutes old or older. The message
reports the current inbound count; it does not predict when those aircraft will
land. Enabling alerts or changing the threshold can notify on the next check if
the count is already above the threshold.

Each account receives one alert per busy period. The detector re-arms after five
minutes of fresh checks at or below the threshold. A rebound or stale data
interrupts that quiet interval. Detector state survives server restarts, so a
restart does not repeat an already delivered busy-period alert. Long gaps between
checks restart the quiet interval.

Pending messages expire after five minutes and allow at most three attempts.
Retries honor Telegram rate limits and the shared per-account send cooldown.
Stale data, counts at or below the threshold, opt-out, disconnect, or a threshold
change cancel pending delivery. Blocked bots stop receiving alerts. A timed-out
send can occasionally be delivered twice if Telegram accepted the first attempt.
Preferences synchronize across devices; changing one alert preserves the other.

### Possible holding alerts

Under **Telegram Integration → Alerts**, enable **Possible holding**. This
separate opt-in defaults off and covers only live Geneva-bound arrivals in the
app's existing tracked area. Once enabled, a background check runs each minute,
using only cached observations. An aircraft must remain continuously tracked
for **more than 15 minutes** before it qualifies. At the normal check cadence,
the first alert usually follows about 16 minutes of observations. Existing
trail history is not counted when enabling the alert.

The message names the flight and its observed duration, describing **possible
holding**. Time in this area alone cannot confirm a holding pattern or a delay;
the detector does not analyze circles or change arrival/runway classification.
It excludes departures, general traffic, grounded aircraft, and retained history.

Both the snapshot and aircraft position must be less than two minutes old.
Missing aircraft, stale tracking, backward timestamps, or gaps of two minutes
or more between observations/checks reset unfinished timers and cancel queued
messages. Re-reading a cached position does not add observation time.

Each account receives at most one alert event per aircraft/callsign, with
identities retained for two hours after their last observation to prevent
repeats on short disappearances. Timers and deduplication survive restarts;
downtime of two minutes or more resets unfinished timers. Changing this opt-in
resets its detector and preserves the other alert preferences.

Queued delivery expires after five minutes and allows at most three attempts,
honoring Telegram retry delays and the shared account send cooldown. Multiple
qualifying flights queue separately; at most one is attempted per account per
check. Opt-out, disconnect, blocked delivery, or lost fresh tracking cancels
pending sends. A timed-out send can occasionally duplicate if Telegram accepted
it before the timeout. Delivery uses the existing logs and Umami collector,
including Do Not Track behavior.

Connections, polling, test messages, runway alerts, busy arrival alerts, and
possible holding alerts never trigger OpenSky requests.
