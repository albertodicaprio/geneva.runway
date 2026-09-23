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
   - Result: only airborne aircraft inside the configured Geneva-area search
     bounds whose ADSBdb route ends at GVA are returned. The temporary-file
     cache stores the exact displayed arrival payload and only its ADSBdb
     enrichment, which a restarted server serves immediately. Arrivals are
     altitude-sorted and classified as approach `04`, `22`, or `unknown` from
     heading without randomness.

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

13. Make aircraft refreshes resilient to abusive or slow traffic.
   - Add timeouts to OpenSky token and state requests.
   - Use one shared in-flight refresh for both cold-cache and stale-cache
     requests, so concurrent clients cannot cause duplicate upstream fetches.
   - Apply public API request-rate limits at the Caddy boundary, rather than
     in the Node application. Caddy Defender blocks known automated-cloud
     ranges before they reach the application.

14. Restrict browser access and add response hardening.
   - Removed permissive CORS and preflight handling from the same-origin API.
   - Added a Content Security Policy, `X-Content-Type-Options: nosniff`, a
     restrictive referrer policy, and clickjacking protection on all responses.
   - Added integration coverage for the security headers and API behavior.

15. Validate the public deployment.
   - Confirmed credentials are excluded from Git, Docker build context, and
     app image metadata and layers.
   - Built both deployment images and verified Caddy returns `429` for the
     31st API request in an isolated local proxy test.
   - Confirmed the public HTTPS homepage returns the response-hardening
     headers and `/api/aircraft` returns `200`.

16. Estimate positions between OpenSky refreshes.
   - Each API response projects aircraft position and altitude from the last
     reported coordinates, ground speed, heading, and vertical rate for up to
     60 seconds without changing the cached source data.
   - The UI labels projected values as estimated and keeps the last reported
     timestamp visible, including the number of seconds since the last update.

17. Show arrivals on a calibrated Geneva map.
   - Added the provided Geneva map asset and calibrated its Web Mercator
     projection using airport, Mont Blanc, and Noirmont reference points.
   - Displays in-bounds arrivals as heading-oriented markers with callsigns,
     alongside a fixed Geneva Airport marker, using SVG attributes that remain
     compatible with the restrictive Content Security Policy.

18. Improve refresh timing and cache-status reporting.
   - Commit: `e83411e Adjust aircraft refresh timing`
   - The browser polls the app every two seconds while OpenSky data becomes
     eligible for refresh every 30 seconds. The UI calculates cache age from
     the cache refresh timestamp instead of the upstream epoch timestamp.

19. Add and refine arrival trails on the map.
   - Commits: `991b3a8`, `4722fda`, `38d13aa`, `8cdca5e`, `373abe0`
   - Confirmed arrivals retain a cached, up-to-60-minute OpenSky position
     trail with a vibrant per-arrival color. The final segment reaches the
     estimated position and renders beneath enlarged aircraft markers.
   - When an arrival disappears from the confirmed list, its recorded trail
     remains marker-free for 10 minutes to support approach comparisons.

20. Smooth arrival trail rendering.
   - Commit: `00965dc Smooth arrival trail rendering`
   - Renders recorded map points with Catmull–Rom-derived cubic Bézier curves
     for rounded turns while retaining every sampled point and the final
     estimated-position segment.

21. Broaden Caddy request-rate limiting.
   - Caddy now applies a per-client limit of 24 requests per 15-second sliding
     window to every path, including arbitrary bot probes. This leaves headroom
     for normal two-second browser polling, page assets, and retries while
     limiting short request bursts.
   - Follow-up: rapid navigation could exhaust that shared limit. The site
     limit is now 120 requests per 15 seconds, while `/api/aircraft` keeps a
     separate 24-request limit. The browser honors Caddy's `Retry-After` header.

22. Keep aircraft tracks updating without an open browser.
   - The Node server refreshes aircraft data at the existing 30-second cache
     cadence from startup, independently of API or page requests.
   - When a confirmed arrival disappears from the live list, its marker-free
     recorded path remains on the map for two hours.

23. Pause overnight upstream aircraft refreshes.
   - Automatic and request-triggered OpenSky refreshes pause from 01:00 until
     05:00 Europe/Zurich time to conserve OpenSky tokens. Cached paths remain
     available during the pause and refreshes resume at 05:00.

24. Preserve aircraft details with flight history.
   - Retained trails now include the full last-known arrival record, including
     callsign, route, airline, and aircraft details, in the cache and API.
   - The existing two-hour retention window and marker-free map display remain.
   - Added coverage for detail retention across refreshes, cache serialization,
     position projection, and expiration.

25. Display retained flight history below the live arrivals.
   - Shows aircraft type, registration, estimated landing time in Geneva time,
     and last likely runway / heading, newest first, with missing-data fallbacks.
   - Records disappearance time explicitly; older records use their expiry time
     minus the existing two-hour retention window.
   - Removes expired history and map paths even when polling is interrupted.

26. Add airline to the flight history table.
   - Shows the retained airline name beside the flight, or a dash if unavailable.

27. Add optional general traffic and independent map layers.
   - Includes other airborne OpenSky traffic using the existing cached refresh,
     with one-hour trails drawn in neon blue at 55% opacity.
   - Separate remembered toggles hide markers and paths for landing traffic
     and general traffic; general traffic starts hidden.
   - General traffic stays out of the arrivals and landing history tables.

28. Add route tooltips and lighten general traffic icons.
   - General traffic uses light navy blue icons; map tooltips show origin and
     destination on their second line, with explicit unknown fallbacks.
   - General traffic routes use cached ADSBdb lookups, including overflights,
     without changing arrival classification or OpenSky refresh frequency.

29. Show aircraft details when a map icon is selected.
   - Clicking or keyboard-selecting a plane expands its model and full airport
     names below the map, with unknown fallbacks and a close control.
   - Selection survives polling and closes when its aircraft is no longer visible.
   - General traffic aircraft models use cached ADSBdb enrichment.

30. Add photos and a bright yellow selection highlight.
   - The selected plane details include its ADSBdb thumbnail beside the model
     and route, with a fallback when no photo is available or loading fails.
   - Selected map icons turn bright yellow for both traffic layers.

31. Filter general traffic to Geneva departures.
   - Adds a remembered departures-only filter using GVA/LSGG route origins.
   - Filters general traffic icons and paths, excluding unknown origins, and
     closes details when a selected aircraft is filtered out.
   - Existing landing traffic remains independently toggleable.

32. Separate Geneva departures into an independent map layer.
   - Departures have bright red trails at 55% opacity and blood red icons.
   - General traffic excludes departures, so enabling both avoids duplicates.
   - Migrates the old departures-only preference; selected icons stay yellow.

33. Add live measurements to selected aircraft details.
   - Shows ground speed in km/h, altitude in metres, and heading in degrees.
   - Updates the values during polling and shows dashes for missing data.
   - Removes aircraft hover tooltips while keeping accessible icon labels.

34. Preserve scroll position during live map updates.
   - Restores focused aircraft icons without scrolling them into view after
     polling redraws the map; closing details also preserves the viewport.
   - Verified with a Chrome reproduction and a focused regression test.

35. Keep landing colors distinct from other traffic layers.
   - Uses stable green, yellow, orange, and purple landing colors without blue
     or red; landing icons match their trails.
   - Migrates cached live and retained trail colors without deleting history.

36. Show the airline in selected aircraft details.
   - Uses the existing route airline name for all map layers, with an explicit
     unavailable fallback when the company is unknown.

37. Match selected aircraft details to landing cards.
   - Shares the landing card layout, padding, thumbnail sizes, and responsive
     sizing, with airline, route, model, and live measurements beside the photo.
   - Keeps long routes compact with the full airport names in a tooltip.

## Refactor tasks (implement in order)

Keep the app framework-free with no build step. Complete, validate, and commit
one task at a time; leave the app runnable between tasks. Preserve the local
Docker deployment, cache fallback, traffic classification, and track retention.

1. [x] Fix the confirmed code-review bugs and add regression coverage.
   - Reject malformed URLs without crashing the server.
   - Keep upstream timeouts active through JSON body consumption.
   - Enforce a refresh-attempt cooldown after failures, including browser polls.
   - Use OpenSky position time (index 3), not last-contact time (index 4), for
     position projection.
   - Replace inline photo error handlers with CSP-compatible listeners.
   - Make full selected-aircraft airport names readable on narrow/touch screens.
   - Validate malformed-request recovery, stalled bodies, sequential retry
     throttling, position timestamps, and photo fallback; run the full suite.
   - Completed: all six fixes are implemented. Refresh attempts share a
     30-second cooldown; JSON bodies remain within the request deadline, and
     unused HTTP error bodies are aborted. Full airport names wrap on mobile.
   - Validation: all 30 tests pass (the four initial regression tests failed
     before the fixes). An isolated local server served the frontend and JSON;
     headless Chrome verified all three photo fallbacks, matching card widths,
     and readable routes at desktop and narrow mobile viewport settings.

2. [x] Extract backend responsibilities and remove global runtime state.
   - Introduce `lib/opensky.js` for authentication and upstream fetching,
     `lib/adsbdb.js` for route/model enrichment and its cache, and
     `lib/traffic.js` for pure normalization, classification, projection, and
     track/history calculations.
   - Keep snapshot ownership, disk persistence, refresh scheduling, cooldown,
     shared in-flight requests, and stale fallback in `lib/aircraft-service.js`.
   - Create a module instance with supplied fetch, clock, and cache storage so
     tests do not replace globals or write to the running app's cache.
   - Preserve response shape and behavior; validate cache, refresh, projection,
     and retention tests before committing.
   - Completed: OpenSky transport/auth, ADSBdb enrichment/cache, and traffic
     calculations now live in their own modules. The aircraft service owns its
     snapshot and refresh state through `createAircraftService`.
   - Validation: backend tests use supplied fetch, clock, and cache storage;
     startup refresh loads the saved snapshot before updating retained tracks.
     All 32 tests and a local frontend/API browser smoke check pass.

3. [x] Consolidate aircraft cards and map behavior.
   - Add `public/aircraft-card.js` for shared identity, route, photo fallback,
     and measurement presentation with featured/list/selected layouts.
   - Add `public/aircraft-map.js` to own projection, paths, markers, layer
     preferences, selection, and keyboard interaction behind one update method.
   - Share visible-aircraft calculations and presentation rules, preserving
     responsive dimensions, accessible routes, selection, focus, and scroll.
   - Move browser tests toward module interfaces instead of editing lexical
     globals through `vm`; verify desktop/mobile layouts and keyboard behavior.
   - Completed: shared card presentation now lives in `public/aircraft-card.js`;
     `public/aircraft-map.js` owns projection, paths, markers, layer preferences,
     visible aircraft, selection, and focus restoration behind `update`.
   - Validation: all 32 tests pass. Module tests cover featured/list/selected
     presentation, layer migration, keyboard controls, photo fallback, and
     scroll-preserving focus. Local `npm start` served the page, both modules,
     and JSON; headless Chrome rendered desktop and mobile widths.

4. [x] Simplify browser state and update coordination.
   - Keep one snapshot instead of both `latestData` and `aircraftData`.
   - Make `public/app.js` coordinate fetching and module updates.
   - Consolidate overlapping redraw timers while preserving history expiry
     during failed polling, status updates, and refresh-rate limits.
   - Validate polling success/failure, expiry, layer preferences, selection,
     and focus preservation; run the full suite and a local smoke check.
   - Completed: `public/app.js` keeps one response snapshot and coordinates
     cards, history, status, and map updates through a testable app instance.
     One two-second timer updates time-sensitive views and starts polling;
     failed or rate-limited polls retain the snapshot while history and map
     paths continue to expire.
   - Validation: all 36 tests pass, including new polling, retry, expiry, and
     single-timer tests alongside map layer, selection, and focus tests. Local
     `npm start` served the page and JSON; headless Chrome rendered live
     arrivals, estimated-position status, and aircraft markers.

5. [x] Split the page into overview, arrivals, and history.
   - The overview keeps the lowest reported arrival and map. Arrivals and
     recent landings each have a direct URL and a visible, mobile-sized link
     in the shared navigation.
   - The browser coordinator renders only the sections present on each page;
     all three pages keep the same server-side cache and polling behavior.
   - Validation: all 38 tests pass, including page-specific rendering and
     navigation checks through the local Node server.

6. [x] Archive flights seen in the Geneva search area.
   - Save one compact, enriched record per continuously observed airborne
     flight, including arrivals, departures, overflights, and unknown routes.
   - Start a new record after a one-hour gap and keep flights crossing midnight
     in the Geneva-local day they were first seen. Write daily JSON files in
     the existing Docker data volume without position trails.
   - Validation: archive persistence, enrichment updates, deduplication,
     midnight continuity, and restart behavior are covered by tests.

7. [x] Add a Stats page backed by the daily flight archive.
   - Show totals, traffic categories, and top airlines, origins, destinations,
     and aircraft types for selectable recent periods with simple charts.
   - Periods are today, 7 days, and 30 days. Ranked charts show how many
     archived flights have each detail; unknown values remain in the total.
   - Validation: all 42 tests pass, including archive aggregation, the JSON
     endpoint, and direct navigation to the page.

8. [x] Separate landing and general traffic stats.
   - Confirmed Geneva arrivals and all other airborne traffic have independent
     totals, airline, airport, and aircraft-model rankings and charts.
   - General traffic includes Geneva departures, overflights, and unknown
     routes, with its departure and other counts shown separately.
   - Validation: all 43 tests pass, including separate API summaries and
     independent page charts.

9. [x] Add a three-option Stats navigation bar.
   - Landings, General, and Takeoffs each have their own view and independent
     totals and ranked charts. General now excludes confirmed Geneva
     departures, which appear under Takeoffs.
   - Validation: all 43 tests pass, including API partitioning and a Stats
     navigation interaction test.

10. [x] Expand ranked Stats charts and show useful route-specific fields.
    - Each chart can reveal all ranked values after the first eight through
      its own checkbox. Landing destinations and takeoff origins are replaced
      by registration rankings.
    - Validation: all 45 tests pass, including full rankings, chart-specific
      expansion, and registration placement.

11. [x] Show full airport names in Stats rankings.
    - Group airports by code so records with and without a name count together;
      display a full name when available and fall back to the code otherwise.
    - Validation: all 46 tests pass, including mixed named and code-only
      airport records and rendered full names.

Remaining maintenance:

- Keep the host, container base image, Node runtime, and reverse proxy patched.

## Current Local Run Command

```sh
npm start
```

The app uses the system temporary directory by default for local development.
Docker Compose stores the cache in a named volume, and local development can
set `AIRCRAFT_CACHE_FILE` to use a persistent path.

Then open:

- `http://127.0.0.1:3000/`
