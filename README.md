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
OPENSKY_NETWORK_CLIENT_ID=your-client-id
OPENSKY_NETWORK_CLIENT_SECRET=your-client-secret
```

Build and start the app:

```sh
docker compose up --build -d
```

Open `https://gva-runway.duckdns.org/`. Caddy is the only published service:
it redirects HTTP to HTTPS, obtains and renews the Let's Encrypt certificate,
and proxies requests to the Node app over Docker's private network. The app's
port 3000 is not reachable from the host network.

The DuckDNS record and port forwarding must be in place before the first
startup so Let's Encrypt can validate the domain. Keep the named Caddy volumes;
they contain its certificate and renewal state.

Useful commands:

```sh
docker compose logs -f
docker compose down
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
