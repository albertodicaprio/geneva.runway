FROM caddy:2-builder-alpine AS builder

RUN xcaddy build \
    --with pkg.jsn.cam/caddy-defender \
    --with github.com/mholt/caddy-ratelimit

FROM caddy:2-alpine

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
