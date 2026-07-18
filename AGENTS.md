# AGENTS.md

## Project Overview

This repository contains a small Geneva Airport plane-spotting web app.

The current app shows aircraft that appear to be on approach to Geneva Airport
and estimates whether they are landing toward runway direction `04` or `22`.
It exists to help a local user know which arrivals are next and which runway
direction is active before going plane spotting.

## Current Structure

- `public/index.html` is the static page.
- `public/app.js` contains all browser-side state, OpenSky response parsing,
  landing filtering, runway estimation, sorting, and DOM updates.
- `public/style.css` contains the current visual styling.
- `api/aircraft.js` is an HTTP adapter for the OpenSky aircraft service.

The project uses a minimal Node server with no build step. It includes a
`package.json`, Node's built-in test runner, Docker support, and a README.

## Runtime Constraints

OpenSky access is the key deployment constraint. The project should be designed
to run from a local home-network machine instead of a public cloud host.

Expected runtime secrets:

- `OPENSKY_NETWORK_CLIENT_ID`
- `OPENSKY_NETWORK_CLIENT_SECRET`

Do not put these values in source control. Prefer `.env` for local development
and Docker Compose `env_file` or environment variables for deployment.

## Local Proxy Testing

Local Docker Compose uses the `.env` value `CADDY_SITE_ADDRESS=http://:80`.
When testing the containerized app locally, start both `app` and `caddy` and
use `http://127.0.0.1/` through Caddy. Do not assume HTTPS or use the public
hostname for local checks; HTTPS is only for the public deployment setting.

## Recommended Direction

Use `ROADMAP.md` for the current step-by-step implementation plan and progress.
Keep this file focused on durable project context and working rules.

## Product/Logic Notes

The current browser logic is only a rough heuristic:

- It treats aircraft as landing when they are within 50 km, descending, below
  3000 m, and heading broadly toward the airport.
- It estimates runway direction from aircraft heading.
- It sorts by altitude, not estimated time to runway threshold.
- It randomly assigns a runway if heading is missing. Avoid randomness in
  operational display code; prefer an explicit unknown state.

Geneva has one physical runway direction pair, commonly represented as `04/22`.
Future work should model approach direction and threshold rather than showing
independent runway choices unless there is a specific need for parallel/taxiway
distinctions.

Useful next improvements:

- Move landing classification to the backend and return a smaller app-specific
  JSON payload instead of the full OpenSky `states` array.
- Add approach corridors for runway `04` and `22` and classify candidates by
  track alignment to those corridors.
- Estimate time-to-arrival using distance-to-threshold and ground speed.
- Include confidence and reason fields in the API response so the UI can show
  `likely 22`, `likely 04`, or `unknown`.
- Add a local health page or status indicator for OpenSky cache age and API
  failures.

## Development Guidance

- Keep the app simple. This does not currently need a frontend framework.
- Work incrementally, one step at a time.
- Explain the intended change before implementing it.
- Ask clarification questions when requirements, deployment assumptions, or
  product behavior are ambiguous.
- After each step, make it possible to run the app locally so the user can test
  and understand the change before moving on.
- Commit at the end of each completed step unless the user explicitly asks not
  to commit.
- Prefer server-side normalization of OpenSky data so the browser only renders
  already-classified arrivals.
- Preserve conservative caching and stale-data fallback behavior.
- Avoid adding cloud-only assumptions; this project is intended for a local
  Docker deployment on a home-network host.
- If adding dependencies, keep them minimal and document why they are needed.
- Add focused tests around runway/arrival classification before changing those
  heuristics substantially.

## Validation Checklist

Before considering a deployment-related step complete:

- `npm start` or equivalent runs the app locally.
- `GET /` serves the frontend.
- `GET /api/aircraft` returns JSON without exposing OpenSky secrets.
- Browser polling does not cause multiple OpenSky upstream requests per minute.
