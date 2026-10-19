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

12. [x] Let each Aircraft models card switch between type names and ICAO codes.
    - Rank descriptive aircraft types and ICAO type codes separately, with
      independent coverage counts and a toggle inside each card.
    - Validation: all 49 tests pass, including both rankings and the toggle.

13. [x] Add recorded type examples beside ICAO codes in Stats.
    - Show up to three common descriptive types per code, with an ellipsis when
      more are available. Codes without descriptions remain visible alone.
    - Validation: all 50 tests pass, including example selection and rendering.

14. [x] Refine the Aircraft models toggle.
    - Put Group first and select it by default, label the other view Detail,
      and place the control beside the card title.
    - Validation: all 50 tests pass, including default selection and switching.

15. [x] Move map position updates into the browser between snapshots.
    - Fetch aircraft data every 30 seconds and update the map each second using
      the elapsed time, heading, speed, and vertical rate from the last
      snapshot. Keep the existing 60-second position projection limit.
    - Validation: client positions match server projection, polling stays at
      30 seconds, and all 54 tests pass.

16. [x] Deliver completed cache refreshes to waiting browsers.
    - Keep one browser request waiting for a cache version newer than its last
      snapshot. Return when the OpenSky refresh completes, with a 25-second
      timeout below the proxy's 30-second response limit.
    - Continue the one-second local map updates and preserve stale-cache
      fallback when an upstream refresh fails.
    - Validation: all 57 tests pass, including waiting and timeout cases.

17. [x] Improve homepage search visibility and visitor context.
    - Add a descriptive title, search description, sharing metadata and a
      canonical homepage URL at `https://gva-runway.ahpc.ch/`.
    - Introduce the spotting tracker and explain runway estimates, data age
      and altitude ordering in static HTML, with links to the other pages.
    - Replace the next-to-land label with approaching Geneva to reflect the
      altitude-based ordering. Validation: all 59 tests pass, including local
      HTTP checks for the homepage and API.

18. [x] Replace the homepage guide card with a compact Help disclosure.
    - Show a small, collapsed Help bar below the map with concise guidance
      on aircraft details, runway estimates and data freshness.
    - Use native HTML details/summary for mouse and keyboard interaction.

19. [x] Add hourly landing and takeoff statistics.
    - Add a fourth Stats view with 24 hourly groups in Europe/Zurich time,
      totaling first sightings across the selected date range.
    - Show separate landing and takeoff bars with independent checkboxes,
      an expandable counts table and horizontal scrolling on small screens.
    - Explain that sightings do not establish exact landing/takeoff times.
      Validation: all 62 tests pass, including local time and daylight saving
      aggregation, view switching, filters, date reloads and failure states.

20. [x] Move recent landings to the bottom of Arrivals.
    - Remove the separate History page and its shared navigation tab.
    - Keep live arrivals and retained history on the same polling loop;
      redirect old history links to the new section.
    - Validate shared navigation, section placement, combined rendering,
      and redirects through the local Node server.

21. [x] Make recent landing history readable on mobile.
    - Show each retained flight as a card with labeled details below 700px;
      keep the desktop table and live arrivals layout.
    - Allow long history values to wrap and contain the section within the
      page width. Preserve table semantics for assistive technology.
    - Validation: all 63 tests pass; headless Chrome confirms no horizontal
      overflow at 320px and 390px and retains the table layout at 1040px.

22. [x] Add a two-month statistics range picker.
    - Open on the previous and current months, navigate both panes together,
      and select endpoints in either pane with distinct range highlighting.
    - Stack panes and enlarge day buttons on mobile; preserve keyboard focus
      after choosing a date and keep unrecorded/future dates disabled.
    - Validation: all 64 tests pass, including cross-year ranges, reverse
      selection, single-day selection, and navigation preserving ranges.
      Headless Chrome confirms layouts fit 320px, 390px, 700px, 768px,
      and 1040px with one pane per row on mobile and two on desktop.

23. [x] Add live filters to landing, general, and takeoff statistics.
    - Split the summary into equal Flights seen and Filter cards. Typing
      matches airline, airport name/code, registration where shown, and both
      aircraft model views, ignoring case and surrounding whitespace.
    - Recalculate totals and all rankings from matching archived flights;
      retain independent filters across tabs and date changes. Preserve input
      focus and the model view, and debounce archive requests by 150 ms.
    - Validation: all 67 tests pass, covering cross-field aggregation, clearing,
      independent filters, input preservation, stale responses, and the local
      HTTP API. Filtering does not request upstream aircraft data.

24. [x] Summarize all traffic beside the statistics calendars.
    - Show Flights seen, Distinct aircraft, Airlines, and Airports for the
      selected date range, with a landing/general/takeoff split. These totals
      are independent of the individual tab filters.
    - Count each recorded aircraft identity once, group easyJet variants, and
      deduplicate origin/destination airports by known codes and names while
      excluding Geneva. Unknown details do not inflate distinct counts.
    - Keep four mini cards beside the calendars on desktop; place calendars
      below the summary on tablets and phones to preserve readable cards.
    - Validation: all 69 tests pass, including distinct counts, date changes,
      filter independence, empty/failure states, and the HTTP API. Headless
      Chrome confirms four rendered cards without page overflow at 320px,
      390px, 700px, 768px, and 1040px.

25. [x] Rename General statistics to Other traffic.
    - Update the Stats tab, heading, loading text, accessible filter label,
      and selected-period traffic split to describe overflights and flights
      with unknown routes more clearly.

26. [x] Add live text filtering to hourly statistics.
    - Place the Filter card to the right of Show on chart on desktop and below
      it on mobile. Reuse the existing debounced, case-insensitive search.
    - Filter recorded arrivals and departures by airline, registration, model,
      ICAO type, and origin for arrivals or destination for departures before
      recalculating hourly bars and the counts table.
    - Preserve the independent hourly filter across date/tab changes and keep
      checkbox choices. The overall period summary remains unfiltered.
    - Validation: all 71 tests pass, including hourly field matching, clearing,
      checkbox interaction, date/tab persistence, and the HTTP API. Headless
      Chrome confirms placement and no page overflow at 320px, 390px, 700px,
      768px, and 1040px.

27. [x] Make statistics filter controls visually consistent.
    - Put hourly series checkboxes in a matching padded card beside the filter.
      Move Filter above the search box in every Stats tab.
    - Validation: all 71 tests pass. Headless Chrome confirms desktop cards
      and stacked mobile controls fit without page overflow.

28. [x] Add a Weather main tab.
    - Show a five-day Open-Meteo forecast near Geneva Airport, with temperatures,
      precipitation, wind/gusts, prevailing wind direction and daylight times.
    - Fetch through `/api/weather` with a shared 30-minute in-memory cache,
      Geneva-date rollover refresh, one-minute failure backoff and stale fallback.
    - Add responsive cards, loading/error states, manual refresh and attribution.
    - Validation: all 77 tests pass; live Open-Meteo and local API requests return
      five days. Headless Chrome confirms cards fit at 320px, 390px, 700px and
      1040px, and a failed refresh keeps the forecast with an error message.

29. [x] Add current weather and wind-based runway estimates.
    - Prepend Now with current temperature, conditions, precipitation and wind.
      Remove sunrise/sunset and show six cards in a responsive grid, trimming
      any excess or odd final card.
    - Predict likely runway 04/22 facing into the wind, with unknown for missing,
      light or mainly crosswind conditions. Keep daily estimates explicitly
      approximate and preserve forecast caching and stale fallback.
    - Validation: all 79 tests pass, including runway direction/boundaries and
      even card counts. Live API and Chrome confirm current conditions, six
      runway labels, no daylight rows, no overflow at 320/390/700/1040px, and
      retained cards after a failed refresh.

30. [x] Match weather runway badges to arrivals and show the latest arrival.
    - Use the same green text/background for weather runway badges.
    - Show the latest unexpired arrival's inferred runway, aircraft and estimated
      landing time on Now beside the wind prediction. Show unknown for missing
      directions and mark old tracking as stale; explain that touchdown is not
      confirmed by disappearing from tracking.
    - Read only the existing aircraft cache; refresh the visible weather page
      every 30 seconds while retaining the 30-minute provider cache.
    - Validation: all 81 tests pass, covering newest/unknown/expired records,
      legacy timestamps, no upstream requests and tracking failures. Chrome
      confirms the exact badge colors and no overflow at 320/390/700/1040px.

31. [x] Remove the aircraft detail line beneath the Now runway badge.
    - Keep the last-arrival badge and move the estimated landing time and stale
      tracking note into its tooltip, removing the visible aircraft name.
    - Remove the unused detail-line styling and update the rendering checks.

32. [x] Add a separate METAR/TAF page under Weather (retired in step 36).
    - Replace Refresh with METAR/TAF and provide an Open-Meteo link back.
    - Show Now (METAR) and every available TAF interval within five days, with
      observations, wind, visibility, clouds, temperature extrema and raw reports.
      Preserve temporary/probability alternatives and becoming transition windows.
    - Fetch LSGG server-side with independent shared ten-minute caches, retry
      cooldowns, partial availability and explicit stale reports.
    - Apply Geneva's runway 22 preference in calm, fair conditions across both
      sources; preserve unknown for adverse, changing, stale or ambiguous winds.
    - Validation: all 93 tests pass. Live LSGG API and local endpoints work;
      Chrome verifies source switching, calm labels, retained cards after failed
      polling, recovery and no overflow at 320/390/700/1040px.

33. [x] Add a shared night-mode toggle at the top of every app page.
    - Use dark navy panels, readable text and status colors, and a dimmed base
      map with bright aircraft overlays. Theme stats, calendars and both weather
      sources alongside the overview and arrivals list.
    - Cycle through Auto, Night (moon), and Day (sun), saving the
      choice across visits and tabs. Default to Auto: day from 07:00 until
      19:00 Geneva time, night otherwise, with live clock updates. Apply it
      before rendering to avoid a bright flash; keep the toggle usable when
      browser storage is unavailable.
    - Validation: all 93 tests pass. Chrome checks all five pages at
      320/390/700/1040px without overflow, saved choices across navigation,
      Space-key activation and blocked storage. Three-state refinement: all
      93 tests pass; isolated browser-script checks cover summer/winter time
      boundaries, cycling, icons/labels, persistence, clock updates and blocked
      storage across all five pages.
    - Align the compact theme button with the top of the page title and status bubbles with
      the page description; stack status below the description on narrow screens.
      Headless Chrome checks all five headers at 320/390/700/1040px for
      title alignment, matching button/bubble height, overflow, right-aligned
      Arrivals status and the shortened Auto/Night/Day labels.

34. [x] Clarify weather runway uncertainty and distinguish last-arrival evidence.
    - Verified the calm/fair-weather preference is applied to current and daily
      estimates. Now's gusts and Wednesday's rain/gusts exclude that preference
      in the inspected Open-Meteo snapshot; preserve the existing thresholds.
    - Explain gust-related uncertainty separately from unconfirmed fair weather.
    - Give Last arrival badges blue text/background in both day and night themes,
      including the shared METAR Now card.
    - Validation: all 94 tests pass, including a regression for gust explanations
      and calm cutoff boundaries; Chrome confirms distinct badge colors in both themes.

35. [x] Add a shared runway/wind compass to weather cards.
    - Use a larger north-up SVG diagram, runway 04/22 at published rounded
      046°/226° true bearings, and an inward wind arrow from the reported source.
    - Replace wind rows with speed, gusts and direction readouts below the diagram;
      retain daily maximum/dominant labels and explicit calm/variable/missing states.
    - Use one arrow: length represents wind speed, width represents gusts.
      Low-speed arrows use a slightly shorter minimum and translucent fill.
      Unknown estimates read “Cannot estimate runway” on both weather views.
      Independent square-root scales keep light wind visible and span nearly the
      whole circle at 60 km/h. A legend explains both dimensions; drawing limits
      preserve numeric readouts above the cap, with minimum width for missing gusts.
    - Share rendering between Open-Meteo Now/daily cards and METAR/TAF cards;
      support both themes and narrow cards without new dependencies.
    - Validation: all 95 tests pass, including arrow direction, independent wind/gust
      scaling, drawing limits and unavailable-wind cases. Chrome checks both views in both themes at 320/390/700/1040px,
      confirming diagrams, readouts and no overflow; inspected a rendered preview.

36. [x] Simplify Weather to the Open-Meteo view.
    - Remove the METAR/TAF page, scripts, service, API and unused styling;
      redirect the retired page URL to Weather.
    - Keep one brief forecast introduction; move runway, daily-wind, compass
      and last-arrival explanations into the overview Help dropdown.
    - Preserve calm-weather and gust-cutoff regression coverage in weather tests.
    - Validation: all 86 remaining tests pass, including the retired-page redirect,
      removed API, concise weather copy, Help content and Open-Meteo estimation.
      Chrome checks Weather and expanded overview Help at 320/390/700/1040px
      in both themes, with all six forecast cards and no overflow.

37. [x] Set up self-hosted Umami infrastructure before website tracking.
    - Add Umami and PostgreSQL to normal Docker Compose startup, using a fixed
      Umami release and PostgreSQL major version, database readiness and Umami
      health checks.
    - Publish Umami on a configurable server LAN address, port 3001 by default;
      leave Caddy routing and website tracking unchanged in this step.
    - Keep PostgreSQL inside Docker with no published port, and persist its data
      in a dedicated named volume. Do not add backups or backup instructions.
    - Configure analytics secrets through ignored local environment settings;
      document initial login and changing the default administrator password.
    - Keep app/Caddy startup independent of analytics availability. Document
      startup, dashboard access and validation; commit the completed step.
    - Validate Compose configuration, Umami health/login, database persistence
      across container recreation, and existing frontend/API access through
      local Caddy. Confirm analytics adds no OpenSky requests.
    - After Umami is checked, plan website integration for visits, page views,
      referrers and page usage. Public collection routing is a later decision.
    - Design: [self-hosted web analytics](docs/adr/0001-self-hosted-web-analytics.md).
    - Validation: all 87 tests pass; `npm start` serves the frontend. Normal
      Compose startup runs all four services, with Umami/database healthy and
      local Caddy serving `/` and `/api/aircraft` with HTTP 200. Administrator
      login and a test page view succeed; the test website and event survive
      recreation of both analytics containers, then are removed. Verified LAN
      binding, database isolation, independent app startup and no configured
      secrets in the aircraft JSON. App polling and upstream code are unchanged.

38. [x] Connect public website page views to the LAN Umami instance.
    - Register one Geneva Runway website entry for both public domains and add
      its deferred tracker to Overview, Arrivals, Stats and Weather.
    - Proxy only `GET`/`HEAD /script.js` and `POST /api/send` through Caddy;
      keep the dashboard and administrative API on the LAN port. Use the same
      website origin without expanding the browser security policy.
    - Limit automatic tracking to the two public domains, respect Do Not Track,
      and omit URL query strings and fragments. Keep custom events, user IDs
      and performance tracking outside this step.
    - Validation: all 87 tests pass. Caddy validates and serves the tracker;
      public dashboard/admin/heartbeat paths return 404. Headless Chrome,
      mapping both public hostnames to local HTTP Caddy, confirms one collected
      page view per page and successful collection from both domains. PostgreSQL
      contains those events with query strings omitted. Localhost, Do Not Track
      and failed tracker requests produce no events while pages still render.
      Tagged browser-test visits are removed after validation. Frontend and
      aircraft API still return HTTP 200; aircraft polling code is unchanged.

39. [x] Capture analytics on dev addresses as well as public domains.
    - Remove the optional `data-domains` filter from all four tracker tags so
      the same integration works on localhost, LAN and production addresses.
      Retain Do Not Track and query/fragment exclusion; update the docs.
    - Validation: rebuilt the app and confirmed browser page views from all
      four pages via `127.0.0.1`, plus `localhost` and the server LAN IP. Those
      six verification visits are retained in Umami for dashboard inspection.
      Do Not Track and failed tracker requests still produce no collection
      while the pages render normally.

40. [x] Configure the Umami website ID per deployment at runtime.
    - Replace hardcoded HTML tracker tags with server-rendered tags using
      `UMAMI_WEBSITE_ID` from the runtime environment. Keep the current dev ID
      in ignored `.env`, and pass the setting explicitly through Compose.
    - Disable analytics for a missing or invalid UUID while preserving page
      rendering. Document production website registration and app recreation
      after changing the ID, without an image rebuild or Caddy reload.
    - Validation: all 90 tests pass, including per-deployment IDs on all four
      pages, absent/invalid settings, injection rejection, HEAD responses and
      no analytics credentials in HTML. Rebuilt the local deployment; browser
      checks confirm collection still reaches Umami and Do Not Track and failed
      tracker handling remain intact. Frontend and aircraft API return HTTP 200.

41. [x] Add optional Google sign-in and account theme controls.
    - Keep the dashboard public; replace the guest theme toggle with Sign in
      with Google and show theme controls plus Sign out for signed-in users.
    - Use Auto for guests and remember theme choices per account/browser.
    - Add server-side Google OpenID Connect with state, nonce, PKCE, verified
      ID tokens, expiring opaque sessions, and CSRF-protected sign-out.
    - Document production/local callback URLs and add `.env.example` settings.
      Sessions last seven days and clear on restart; Google tokens are discarded.
    - Add Google's official authentication library and install locked
      dependencies in the Docker image.
    - Upgrade the application to Node.js 24 LTS in Docker, package engines,
      and `.nvmrc`, retaining the current Google authentication library.
    - Validation: 105 tests pass locally and in the Node 24.22.0 container
      using isolated test cache paths. Docker builds without engine warnings;
      homepage and aircraft JSON return HTTP 200 through local Caddy, and the
      guest account controls render correctly at mobile width. Live Google
      consent remains to be checked after credentials and callback registration.

42. [x] Log successful Google sign-ins.
    - Write the user's profile name, verified email and a UTC timestamp as a single JSON
      server log entry after identity verification and session creation.
    - Exclude tokens, credentials and session IDs; escape
      name control characters so one sign-in always occupies one log line.
    - Cover successful, rejected and replayed callbacks in authentication tests.

43. [x] Clarify Google sign-in origin configuration.
    - Explain that APP_ORIGIN takes the website address, while the callback
      path belongs in Google's Authorized redirect URIs. A callback path in
      APP_ORIGIN caused the reported startup failure.
    - Accept an optional trailing slash and normalize it to the URL origin;
      continue rejecting paths, queries, fragments and public HTTP origins.
    - Add regression tests for both the configuration error and trailing slash.

44. [x] Persist account settings and synchronize themes across devices.
    - Store settings in a JSON object keyed by the verified lowercase Google
      email address, beginning with each account's theme. Preserve other users
      and future fields during updates; serialize writes and replace atomically.
    - Save settings in the persistent Docker data volume and ignored local
      data directory, with no new dependency. Exclude local data from builds.
    - Add a session- and CSRF-protected settings endpoint. Render the saved
      theme with each page, refresh it on focus/session checks, and import old
      browser preferences only when no server theme exists yet.
    - Guests continue using Auto; write failures are visible and do not erase
      saved settings. Settings survive restarts while sessions remain temporary.
    - Validation: all 120 tests pass, including disk persistence, concurrent
      updates, account isolation, CSRF, browser migration, rapid theme changes
      and failure handling. Docker builds successfully; local Caddy returns
      HTTP 200 for the homepage and aircraft API and 401 for guest updates.

45. [x] Send auth endpoint events to Umami.
    - Capture login starts, successful sign-ins, cancellations, categorized
      failures and successful sign-outs. Attach verified full name and email
      to success/sign-out events; other outcomes remain anonymous.
    - Reuse the deployment website ID and send to the local Umami collector
      through Docker's private network. Forward client IP only when explicitly
      behind Caddy; retain browser User-Agent for normal Umami attribution.
    - Honor Do Not Track across the login flow/session. Keep tokens, cookies,
      callback parameters and raw errors out of payloads. Do not send events
      for session polling or account settings requests.
    - Bound asynchronous delivery with a timeout and concurrency cap, without
      retries or authentication delays. Document event fields and configuration.
    - Validation: all 132 tests pass and the app image builds. Local Umami
      accepted six synthetic auth events, including verified sample name/email
      on sign-in and sign-out; a Do Not Track login emitted no additional
      events. Synthetic records use Auth Analytics Check / auth-check@example.invalid.

46. [x] Move account details and settings into a profile dropdown.
    - Show the Carbon user icon with Login for guests and the Google first
      name for signed-in users on all four pages.
    - Include Profile with Google's full name and verified email, Settings
      with the existing saved theme control, and a Log out button.
    - Close the dropdown on outside clicks, focus leaving, Escape, logout,
      and session expiration; return keyboard focus after Escape and logout.
    - Style the panel for Day/Night and mobile widths. Include Carbon icon
      attribution and its Apache 2.0 license without adding dependencies.
    - Validation: all 134 tests pass, including profile fields, dropdown
      dismissal, logout and expired sessions. Headless Chrome checks pass at
      mobile and desktop widths with mocked Google profile data. The local
      app starts and serves the homepage and guest session JSON; the aircraft
      endpoint returns its expected 503 JSON with OpenSky credentials disabled.
      Live Google consent was not repeated for this UI change.

47. [x] Simplify the guest account control.
    - Remove the Login tooltip and clear the account status after successful
      logout. Keep actionable authentication and settings errors visible.
    - Validation: all 12 account UI tests pass; diff whitespace checks pass.

48. [x] Remove per-aircraft route lookup logs.
    - Remove the Route lookup log loop and its unused formatting helpers.
      Keep arrival filtering summaries and upstream failure warnings.
    - Validation: all 15 aircraft service and general traffic tests pass.

## Telegram integration (next feature)

Implement, validate locally, and commit one step at a time. Telegram is an
outbound notification channel; notification configuration belongs in the app.

1. [x] Connect a signed-in account to Telegram.
   - Add a Telegram Integration section between Profile and Settings in the
     account dropdown on all pages. Show connection status, connected account,
     Connect/Disconnect, and Send test message only when connected.
   - Offer a bot deep link and a locally generated QR code for the same
     short-lived, single-use connection token. Associate private Telegram chat
     IDs with verified Google account IDs; enforce one-to-one connections.
   - One server-side long-polling loop receives Telegram's `/start <token>`
     linking event using outbound HTTPS. It starts automatically after checking
     the bot identity; real local linking needs only a bot token and username.
     Other messages/commands are logged as bounded metadata and ignored.
   - Persist connections in the Docker data volume, protect account changes
     with session/CSRF checks, and document BotFather and environment setup in
     `.env.example` and README. Keep secrets and linking tokens out of logs.
   - Introduce a small notification-provider interface with a test-message
     provider; test delivery is initiated only from the account dropdown.
   - Validate link expiry/replacement/replay, private sender identity,
     one-to-one ownership, real account sessions and CSRF, persistence and disk
     failures, send cooldown/rate limits, blocked bots, and late browser
     responses after logout. Polling persists its cursor per bot, retries
     failures without acknowledging later updates, respects Telegram retry
     delays, stops on conflicting receivers/invalid credentials, and cancels
     on shutdown. All 163 tests pass, including localhost Node startup and
     SIGTERM with a simulated Telegram service.
   - Headless Chrome checks pass in Day/Night at 320/390/700/1040px: QR renders,
     connection state updates, menu fits without horizontal overflow, and
     Disconnect returns focus to Connect. Docker builds; local Caddy serves
     homepage and aircraft JSON (200) and rejects guest account requests (401).
     The old webhook route, secret, registration script, and Caddy log filter
     have been removed; no migration tooling is needed.
   - Real Telegram linking/delivery awaits BotFather credentials and can be
     tested locally over HTTP. Use a separate bot for each environment and
     one running receiver per bot. No public URL or production deploy needed.

2. [x] Add opt-in arrival runway change alerts.
   - Add a saved per-account switch under Settings → Telegram alerts on every
     page. Default off, disable until connected, synchronize across devices,
     protect saves with session/CSRF validation and restore failed saves.
   - Read retained arrivals from the aircraft service's cache-only accessor
     once per minute, independently of browser activity. Process the complete
     arrival sequence so multiple arrivals between checks are not missed.
   - Require two consecutive distinct arrivals with matching inferred 04/22
     directions to establish or change the runway. A single opposite or
     unknown breaks the pair; duplicate reads/reappearing flights do not count.
     Remove weather confirmation and the hour-long cooldown. Existing opt-ins
     carry over; old weather detector state is replaced silently.
   - Consume startup history silently; persist processed flight identities,
     confirmed direction and pending delivery. Retain bounded retry/rate-limit
     handling, 15-minute expiry and cancellation on disconnect, opt-out, stale
     tracking or a confirmed reversal. Messages identify the two flights and
     clarify that tracking disappearance does not confirm touchdown.
   - Validation: all 180 tests pass, including the user's 22/04/22/04/04
     sequence, duplicate/reappearing aircraft, unknown directions, multiple
     arrivals per snapshot, quick reverse changes, legacy preference/state
     compatibility, cache-only reads, delivery retry/expiry, and existing
     preference security/browser behavior. No weather or additional OpenSky
     requests are made by this alert.

3. [ ] Extend notification preferences and delivery.
   - Add quiet hours in Europe/Zurich and per-provider fields as needed.
   - Extend the existing bounded delivery and cancellation behavior for future
     alert types; keep background evaluation independent of browser requests.

4. [ ] Add other notification providers individually from IDEAS.md.
   - [x] Busy arrival periods: a separate saved opt-in on every page with a
     per-account threshold from 1 to 100 (default more than 10 live arrivals).
     Cache-only background checks run once per minute and count unique aircraft
     with positions under two minutes old. Stale snapshots cannot alert.
     Send once per busy period; re-arm after five minutes of fresh quiet checks.
     Persist deduplication across restarts; cancel pending delivery on quiet or
     stale data, threshold changes, opt-out or disconnect. Bound delivery to
     three attempts and five minutes with the shared send cooldown and Telegram
     retry delays. Existing runway preferences and detector state are preserved.
     Validation: 190 tests pass, including cache-only counting, reset/dedup,
     retry/cancellation, preference persistence/isolation/CSRF, threshold
     validation and browser rollback/sync. Headless Chrome verifies Day/Night
     layout at 320/390/700/1040px and saves both alert types independently.
     An isolated local server serves the homepage and repeated aircraft JSON
     requests (200), and rejects guest Telegram requests (401), with credentials
     disabled and synthetic cached data.
   - Possible go-arounds and aircraft observed in the area over 15 minutes,
     after defining and validating conservative detection rules.
   - Define freshness, confirmation, cooldown, and deduplication rules for each
     provider; distinguish predictions and possible events from confirmed ones.

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
