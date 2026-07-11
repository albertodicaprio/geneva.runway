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
   - Result: `npm start` serves `public/` and exposes `/api/aircraft` plus
     `/api/health-opensky`.

4. Load `.env` for local development.
   - Commit: `85a7a43 Load local environment variables`
   - Result: local `.env` values are loaded only when process environment
     variables are not already set. Docker-provided environment variables still
     take precedence.

## Next Steps

5. Refactor API logic out of Vercel handlers.
   - Goal: separate OpenSky fetching/cache logic from HTTP handler adapters.
   - Keep `/api/aircraft` and `/api/health-opensky` behavior unchanged.
   - Run locally with `npm start` and verify both API routes.

6. Add a persistent cache path.
   - Goal: support an app-controlled cache path such as `DATA_DIR=/data`.
   - Keep a sensible local default for development.
   - Verify cache hits survive server restarts when the cache file remains.

7. Add Docker support.
   - Add `Dockerfile` and `.dockerignore`.
   - Add `docker-compose.yml` for local home-network deployment.
   - Use environment variables from the host or Compose, not committed secrets.
   - Bind to `0.0.0.0` in Docker and expose the chosen port.

8. Add backend normalization for aircraft data.
   - Return a smaller app-specific JSON payload instead of the full OpenSky
     `states` array.
   - Preserve conservative upstream caching.
   - Keep the frontend display working after the API shape changes.

9. Improve arrival and runway-direction classification.
   - Replace random runway fallback with an explicit `unknown` state.
   - Model approach direction as `04`, `22`, or `unknown`.
   - Add confidence/reason fields for display and debugging.

10. Add focused tests.
    - Cover distance, bearing, landing candidate filtering, approach direction,
      and sorting.
    - Keep tests runnable without OpenSky credentials.

11. Improve the plane-spotting UI.
    - Show cache age and API health.
    - Show likely approach direction, next arrivals, confidence, and ETA.
    - Keep the interface usable on a phone.

## Current Local Run Command

```sh
npm start
```

Then open:

- `http://127.0.0.1:3000/`
- `http://127.0.0.1:3000/api/health-opensky`

