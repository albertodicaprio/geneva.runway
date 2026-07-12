FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

COPY --chown=node:node package.json ./
COPY --chown=node:node server.js ./
COPY --chown=node:node api ./api
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public

USER node

EXPOSE 3000

CMD ["node", "server.js"]
