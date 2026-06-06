FROM node:20-alpine AS BUILD

WORKDIR /app

COPY  package*.json ./

RUN npm ci

COPY  . .

RUN npm run build



FROM node:20-alpine

WORKDIR /app

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY package*.json ./

RUN npm ci --omit=dev

COPY  --from=BUILD --chown=appuser:appgroup /app/dist ./dist

RUN mkdir -p /app/uploads && chown -R appuser:appgroup /app/uploads

USER appuser

EXPOSE 5000

CMD [ "node", "dist/index.js" ]