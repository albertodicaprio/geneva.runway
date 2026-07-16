# ROADMAP.md

## Purpose

This file tracks the incremental plan for turning the Geneva Airport landing
tracker into a locally hosted Docker app. Keep `AGENTS.md` for stable working
rules and use this file for the evolving step-by-step plan.

## Working Rules

- Explain the intended step before implementing it.
- Work one step at a time.
- Run locally after each step so the user can test and understand the change.
- Ask clarification questions when requirements or behavior are ambiguous.
- Commit at the end of each completed step.

## Progress

Completed:

1. Add repository agent guidance.
   - Commit: `2591183 Add agent workflow guidance`

2. Ignore local environment files.
   - Commit: `35b80ad Ignore local environment files`

3. Add a local Node server.
   - Commit: `ae2d110 Add local Node server`
   - Result: `npm start` serves `public/` and exposes `/api/aircraft`.

4. Load `.env` for local development.
   - Commit: `85a7a43 Load local environment variables`
   - Result: local `.env` values are loaded only when process environment
     variables are not already set. Docker-provided environment variables still
     take precedence.

5. Refactor API logic out of deployment-specific handlers.
   - Commit: `eb15afc Refactor OpenSky API services`
   - Result: OpenSky aircraft caching/fetching lives in reusable service
     modules; the route handler is now an HTTP adapter.
     Legacy cloud-deployment configuration and references have been removed.

6. Add Docker support.
   - Commit: `76ba108 Add non-root Docker deployment`
   - Result: Docker runs the app as the unprivileged `node` user, listens on
     `0.0.0.0:3000` inside the container, and uses `.env` without copying it
     into the image. Docker Compose publishes the service on the home network.

7. Add backend normalization for aircraft data.
   - Commit: `4652fbf Normalize Geneva-area aircraft data`
   - Result: `/api/aircraft` returns a normalized app-specific payload instead
     of OpenSky's raw state vectors.

8. Improve arrival and runway-direction classification.
   - Commit: `5376e44 Enrich Geneva arrivals with ADSBdb`
   - Result: only airborne aircraft within 80 km whose ADSBdb route ends at GVA
     are returned. The temporary-file cache stores the exact displayed arrival
     payload and only its ADSBdb enrichment, which a restarted server serves
     immediately. Arrivals are altitude-sorted and classified as approach
     `04`, `22`, or `unknown` from heading without randomness.

9. Add focused tests.
   - Result: `npm test` runs credential-free unit tests for distance, runway
     bearing classification, OpenSky position filtering, GVA arrival filtering,
     and altitude sorting. ADSBdb responses are mocked in the enrichment test.

10. Improve the plane-spotting UI.
   - Commit: `5a67be6 Redesign Geneva arrivals interface`
   - Result: the mobile-friendly interface shows the lowest-altitude confirmed
     arrival first, with ADSBdb origin, airline, aircraft identity, thumbnail
     when available, approach direction, distance, descent, and cache status.
     The browser polls every 10 seconds while the server refreshes OpenSky data
     no more often than once per minute.

11. Remove the public OpenSky diagnostic endpoint.
   - Result: the network-diagnostic route and its implementation have been
     removed. The app exposes no route that discloses runtime or network
     connectivity details or triggers token diagnostics.

12. Deploy behind a Caddy HTTPS reverse proxy.
   - Result: Caddy publishes ports 80 and 443 for
     `gva-runway.duckdns.org`, automatically manages its Let's Encrypt
     certificate, proxies to the un-published Node app service, and emits
     access logs to the container log stream. A development override supports
     HTTP-only operation without certificate issuance.

## Future: Public Internet Exposure Hardening

The current Docker setup is intended for a trusted home network. Complete these
steps, in order, before making the app reachable from the public internet.

Completed:

1. Make aircraft refreshes resilient to abusive or slow traffic.
   - Add timeouts to OpenSky token and state requests.
   - Use one shared in-flight refresh for both cold-cache and stale-cache
     requests, so concurrent clients cannot cause duplicate upstream fetches.
   - Apply public API request-rate limits at the Caddy boundary, rather than
     in the Node application. Known automated-cloud ranges have a stricter
     limit via Caddy Defender.

Remaining:

1. Restrict browser access and add response hardening.
   - Remove permissive CORS where the frontend and API share an origin, or
     allow only the deployed frontend origin.
   - Add a Content Security Policy, `X-Content-Type-Options: nosniff`, a
     restrictive referrer policy, and clickjacking protection.

2. Validate the public deployment.
   - Confirm secrets and access tokens never appear in responses, logs, image
     layers, or browser-visible configuration.
   - Test that unauthenticated clients cannot cause repeated upstream refreshes
     or bypass rate limits.
   - Keep the host, container base image, Node runtime, and reverse proxy
     patched.

## Current Local Run Command

```sh
npm start
```

The app intentionally keeps its cache in the system temporary directory; a
persistent cache path is out of scope.

Then open:

- `http://127.0.0.1:3000/`
