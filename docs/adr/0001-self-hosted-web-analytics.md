# Self-hosted web analytics

Use self-hosted Umami with its own PostgreSQL database in the existing Docker
Compose deployment on the home-network host. This keeps analytics data under
local control and avoids adding an external analytics service to the app's
deployment.

The first step provides the infrastructure and validates Umami before enabling
website tracking. Publish the Umami dashboard on a dedicated port for access
from home-LAN devices, without a Caddy route; PostgreSQL has no published host
port. Website integration follows after that validation, initially measuring
visits, page views, referrers and page usage. Interaction events are deferred.

Bind the dashboard to the server's configurable LAN address, using host port
3001 by default. Both analytics services start with normal Compose startup;
the app and Caddy do not depend on them. Store PostgreSQL data in a dedicated
Docker named volume. Backup tooling and backup instructions are outside this
step's scope.

After validating the infrastructure, serve the tracker and collection endpoint
through the website's existing Caddy origin. Publish only `GET`/`HEAD /script.js`
and `POST /api/send` to Umami; dashboard and administrative routes stay on the
LAN port. One website entry covers both public domains and local development
addresses, with no tracker domain restriction so dev traffic can be verified
in Umami before deployment to the target host. This enables public collection
without making the dashboard public or expanding the app's browser security
policy.

Configure the website ID at runtime through `UMAMI_WEBSITE_ID` rather than
committing an ID into the pages. Dev and production can point to their own
website entries without changing or rebuilding the source; the server inserts
the configured UUID into the tracker tag. Missing or invalid IDs disable
tracking so analytics configuration cannot prevent the app from running.
