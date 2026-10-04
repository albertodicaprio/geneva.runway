# METAR and TAF for Geneva Airport

Researched 4 October 2026. Live API checks around 15:54–16:00 UTC. This is a feasibility note; no application behavior changed.

## Recommendation

Add LSGG METAR as the preferred source for the Weather page's **observed airport conditions and current wind**. Keep Open-Meteo for the five-day outlook. TAF is useful as a separate **next 30 hours at the airport** view, especially for wind changes, fog, visibility and cloud ceiling, but is a more involved second step. Neither product reports the active runway: label any derived direction as a wind-based estimate and show aircraft-based evidence separately.

This recommendation follows the different products' purposes: METAR describes observations; Geneva TAF has a 30-hour validity; Open-Meteo supplies a continuous model forecast, including its model-based “current” conditions. It does not establish that TAF always predicts local wind more accurately than Open-Meteo. A historical comparison would be needed for that claim. [MeteoSwiss aviation guide, December 2025, pp. 2–4](https://www.meteosuisse.admin.ch/dam/jcr%3Ab0033723-538a-431d-a272-55ccf7e1a190/25-10921_Flugwetterinfo_F_Web_RZ.pdf), [Open-Meteo documentation](https://open-meteo.com/en/docs).

## The wind direction is present

In a METAR/TAF wind group, the first three digits give the direction **from which** wind blows, relative to true north. The next digits give speed; `KT` means knots. Examples:

| Group | Meaning |
| --- | --- |
| `03004KT` | From 030°, at 4 kt (about 7.4 km/h) |
| `22012G22KT` | From 220°, at 12 kt, gusting 22 kt |
| `VRB02KT` | Variable direction, at 2 kt; no single usable direction |
| `00000KT` | Calm; direction cannot determine a runway |
| `03003KT 350V050` | Mean from 030° at 3 kt, varying clockwise from 350° through north to 050° |

Variable or calm wind is intentional meteorological information, not a missing API feature. Use the Swiss guide for local encoding rules rather than assuming all U.S. reporting conventions apply. [MeteoSwiss aviation guide, p. 2](https://www.meteosuisse.admin.ch/dam/jcr%3Ab0033723-538a-431d-a272-55ccf7e1a190/25-10921_Flugwetterinfo_F_Web_RZ.pdf), [AWC explanation of METAR and TAF](https://aviationweather.gov/help/data/).

The user's [decoded LSGG page](https://aviationweather.gov/data/metar/?decoded=1&autorefresh=0&ids=LSGG&taf=1) does support wind direction. Its official browser decoder emits a wind row with a compass description and degrees for a numeric wind direction, and “variable” or “calm” for those cases. A TAF change group without its own wind values omits the wind row because that group describes changes to other elements; the prevailing wind continues. This display behavior was checked in the site's deployed JavaScript; the JSON API is the appropriate integration interface.

## Verified public endpoints and responses

Both worked over HTTPS without an account, API key or authorization header:

```text
https://aviationweather.gov/api/data/metar?ids=LSGG&format=json
https://aviationweather.gov/api/data/taf?ids=LSGG&format=json
```

The documented API offers worldwide METAR and TAF coverage. These two successful checks establish that LSGG is actually available, beyond that general coverage claim. The API also documents an optional `taf=true` METAR query parameter, but separate JSON endpoints make each product's shape and cache lifecycle explicit. [AWC API documentation](https://aviationweather.gov/data/api/), [official OpenAPI schema](https://aviationweather.gov/data/schema/openapi.yaml).

The initial METAR response was:

```json
{
  "icaoId": "LSGG",
  "receiptTime": "2026-10-04T15:22:31.169Z",
  "obsTime": 1791127200,
  "reportTime": "2026-10-04T15:20:00.000Z",
  "wdir": 30,
  "wspd": 4,
  "rawOb": "METAR LSGG 041520Z AUTO 03004KT CAVOK 22/13 Q1026 NOSIG"
}
```

Here the wind favors the 04 end geometrically, but a light wind alone is insufficient to conclude Geneva was using 04. The TAF returned at the same time was issued at 14:25 UTC, valid from 4 October 15:00 UTC until 5 October 21:00 UTC, with this prevailing wind:

```json
{
  "issueTime": "2026-10-04T14:25:00.000Z",
  "validTimeFrom": 1791126000,
  "validTimeTo": 1791234000,
  "fcsts": [
    { "timeFrom": 1791126000, "timeTo": 1791234000,
      "fcstChange": null, "wdir": "VRB", "wspd": 2, "wgst": null }
  ]
}
```

This excerpt includes only the initial forecast group. The full response also contained overlapping `TEMPO` and `PROB` groups for showers, mist and fog, with `wdir`, `wspd`, and `wgst` all null. Those nulls mean **no changed wind supplied in that subgroup**, not no wind forecast at the airport. The raw TAF began `TAF LSGG 041425Z 0415/0521 VRB02KT CAVOK`.

JSON already separates `wdir` (number or `"VRB"`), `wspd` (knots), and `wgst` (knots). METAR uses top-level fields; TAF uses `fcsts[]` with interval bounds, `fcstChange`, `timeBec`, and `probability`. Missing properties and nulls need normalization. In the observed LSGG METAR response, the directional variation limits were only in `rawOb`; no separate variation bounds were present. Preserve raw text for explanations, and optionally parse this small group if needed. [Official API schema](https://aviationweather.gov/data/schema/openapi.yaml), [live METAR endpoint](https://aviationweather.gov/api/data/metar?ids=LSGG&format=json), [live TAF endpoint](https://aviationweather.gov/api/data/taf?ids=LSGG&format=json).

**Use observation time for METAR freshness.** The subsequent history query returned `METAR LSGG 041550Z ...` with `obsTime` corresponding to 15:50 UTC, but `reportTime` was 16:00 UTC. Thus `reportTime` should not be assumed to equal the time printed in the METAR. Keep observation, issuance/validity, receipt and local fetch times distinct. [Schema's timestamp definitions](https://aviationweather.gov/data/schema/openapi.yaml), [history query used](https://aviationweather.gov/api/data/metar?ids=LSGG&format=json&hours=3).

## Refresh cadence and deployment feasibility

MeteoSwiss's current guide specifies Swiss METARs at minutes **20 and 50** each hour, and LSGG TAFs on a **three-hour** cycle, covering **30 hours**. The live history contained 13:20, 13:50, 14:20, 14:50, 15:20 and 15:50 UTC observations. The guide's TAF schedule and actual issue timestamps are distinct: the sample was issued 14:25 for the 15:00 validity start. [MeteoSwiss aviation guide, p. 2](https://www.meteosuisse.admin.ch/dam/jcr%3Ab0033723-538a-431d-a272-55ccf7e1a190/25-10921_Flugwetterinfo_F_Web_RZ.pdf).

AWC caps requests at 100/minute and most queries at 400 entries, asks for narrow infrequent requests and a custom User-Agent, and does **not permit CORS**. Fetch on the Node server, not directly in the browser. A shared 5–10 minute refresh for each LSGG product would be conservative, catch reports and amendments, and remain far below the cap regardless of browser count. The full worldwide caches refresh every minute for METAR and every 10 minutes for TAF; those are distribution refreshes, not new Geneva weather reports. Missing data can return HTTP 204; handle that before calling `response.json()`, as well as 403, 429 and transient errors. [AWC API usage/restrictions and cache documentation](https://aviationweather.gov/data/api/).

The single-station JSON responses are small and work from this environment. No extra runtime secret or dependency is necessary. A home-network Node/Docker deployment is suitable. Preserve concurrent-request sharing, separate cached snapshots, last successful data and explicit stale indicators; do not make a TAF outage remove available METAR or Open-Meteo forecasts. API availability and delay must still be treated as fallible; a successful fetch of an old observation is not fresh airport weather.

## What the wind can tell us about 04 versus 22

Geneva Airport explains that runway selection considers winds at the ground and aloft, weather, runway condition and traffic. It prefers **22 in calm weather**, and 22 has the CAT II/III instrument landing capability used in fog. Switching direction requires reorganizing arrivals and departures, so it avoids frequent changes during busy traffic. Therefore a small wind shift need not immediately switch the runway. No exact current numerical tailwind/changeover threshold was verified in authoritative current operational documentation; do not encode a threshold copied from a flight-simulator site. [Geneva Airport's explanation, 4 April 2023](https://gva.blog/sens-de-piste-et-trajectoires-comment-ca-marche/).

METAR/TAF direction is **true**, whereas runway designators describe rounded **magnetic** headings. For a refined headwind/crosswind calculation, use the actual runway threshold coordinates to derive its true bearing rather than treating the designators as exact 040°/220° true bearings. The existing approximate model remains reasonable for a rough label away from borderline crosswind cases, but should not imply operational precision. [MeteoSwiss aviation guide, p. 2](https://www.meteosuisse.admin.ch/dam/jcr%3Ab0033723-538a-431d-a272-55ccf7e1a190/25-10921_Flugwetterinfo_F_Web_RZ.pdf), [Geneva Airport on runway magnetic numbering](https://gva.blog/sens-de-piste-et-trajectoires-comment-ca-marche/).

For the next landings, use METAR to explain which direction wind favors and retain recent arrival/approach evidence as a separate clue to actual use. In variable, calm, mostly crosswind or stale conditions, show uncertainty. If adding a calm-weather preference later, label it “22 usually preferred in calm conditions” rather than presenting it as an observed active runway. Neither METAR runway visual range nor wind-shear runway references should be mistaken for an active-runway declaration. The official Swiss guide lists Geneva ATIS radio/telephone access, but this research found no documented free structured LSGG ATIS endpoint suitable for automatic use. [MeteoSwiss aviation guide, pp. 1–4](https://www.meteosuisse.admin.ch/dam/jcr%3Ab0033723-538a-431d-a272-55ccf7e1a190/25-10921_Flugwetterinfo_F_Web_RZ.pdf).

## Fit with the existing app and a practical sequence

The current `lib/weather-service.js` requests Open-Meteo current conditions and five daily forecasts, using airport coordinates, km/h units and a shared 30-minute memory cache. It predicts runway using approximate 040°/220° bearings, an app-chosen 5 km/h light-wind cutoff and a 15° margin around crosswind. Daily estimates combine maximum daily speed with dominant daily direction, which need not describe the same moment. The README already calls them rough estimates. These are existing product choices, not verified Geneva operating thresholds. [Existing service](../../lib/weather-service.js), [README](../../README.md).

Suggested incremental work, if implemented:

1. Add a cached server-side LSGG METAR provider and show its observation age, measured wind/gusts, temperature, visibility and raw report. Convert knots to km/h before using existing thresholds. Keep missing/variable/calm distinct. Present Open-Meteo model current conditions as a clearly labeled fallback when METAR is unavailable.
2. Keep the five daily Open-Meteo forecast cards. METAR cannot supply the precipitation totals/chances or daily temperature extrema, and the 30-hour TAF cannot replace a five-day outlook. Open-Meteo current conditions are explicitly based on 15-minute model data, so the observed/model provenance should be visible. [Open-Meteo docs](https://open-meteo.com/en/docs).
3. Add a short airport forecast timeline from TAF. Resolve the prevailing base/FM/BECMG wind and expose temporary/probability alternatives without overwriting the base with every overlapping subgroup. Treat a BECMG interval as a transition window rather than a guaranteed switch instant. Keep raw TAF alongside the decoded view. The Swiss guide explains that most change groups include only changed elements, while FM supplies a complete new state. [MeteoSwiss aviation guide, p. 4](https://www.meteosuisse.admin.ch/dam/jcr%3Ab0033723-538a-431d-a272-55ccf7e1a190/25-10921_Flugwetterinfo_F_Web_RZ.pdf).
4. Only then consider combining weather evidence with tracked approaches to improve runway confidence. Test variable/calm/null winds, stale reports, unit conversion, changing/overlapping forecast groups and disagreements between wind and traffic. Backtest predictions against recorded arrivals before claiming a reliability improvement.

For this small application, METAR offers a strong practical benefit at low integration cost. TAF adds meaningful near-term airport detail, with most of its implementation cost in honest interval/uncertainty interpretation rather than in API access.
