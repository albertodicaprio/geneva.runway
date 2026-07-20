# Geneva Runway

A small, self-hosted Geneva Airport (LSGG/GVA) plane-spotting app. It shows
nearby airborne flights whose ADSBdb route is confirmed to end at Geneva,
along with the likely runway approach direction (`04`, `22`, or `unknown`).

The app is intended to run on a home-network machine, rather than a public
cloud host. It obtains live position data from OpenSky and route and aircraft
details from ADSBdb.

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

# How to expose the site via Caddy. Use https://gva-runway.duckdns.org in prod.
CADDY_SITE_ADDRESS=http://:80
```

Build and start the app:

```sh
docker compose up --build -d
```

Open `https://gva-runway.duckdns.org`. Caddy is the only published service:
it redirects HTTP to HTTPS, obtains and renews the Let's Encrypt certificate,
and proxies requests to the Node app over Docker's private network. The app's
port 3000 is not reachable from the host network.

The DuckDNS record and port forwarding must be in place before the first
startup so Let's Encrypt can validate the domain. Keep the named Caddy volumes;
they contain its certificate and renewal state.

### Caddy reverse proxy

Docker Compose runs Caddy as the public-facing service. It is the only
container that publishes ports 80 and 443; it forwards traffic to the internal
Node app, manages the production TLS certificate, and writes request logs to
its container log stream. It is built locally with Caddy Defender and
`caddy-ratelimit`; every path is limited to 24 requests per 15-second sliding
window per client IP (IPv6 addresses are grouped by `/64`), including arbitrary
bot probes. Defender applies a stricter policy to known automated-cloud ranges
by blocking them with `403`. Caddy returns `429` and `Retry-After` when the
limit is reached. The allowance accommodates the browser's 2-second aircraft
polling cadence plus page loads and retries while limiting short request bursts.

`CADDY_SITE_ADDRESS` configures Caddy's site address:
- In dev we use `http://`
- In prod we use `https://gva-runway.duckdns.org`

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
