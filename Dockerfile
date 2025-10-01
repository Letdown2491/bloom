# syntax=docker/dockerfile:1

ARG PNPM_VERSION=9.7.1

FROM node:20-alpine AS deps
WORKDIR /app
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install

FROM node:20-alpine AS build
WORKDIR /app
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
ARG VITE_PRIVATE_LINK_SERVICE_HOST="http://localhost:8787"
ARG VITE_PRIVATE_LINK_SERVICE_PUBKEY="CHANGE_THIS_BEFORE_BUILDING"
ENV VITE_PRIVATE_LINK_SERVICE_HOST=${VITE_PRIVATE_LINK_SERVICE_HOST}
ENV VITE_PRIVATE_LINK_SERVICE_PUBKEY=${VITE_PRIVATE_LINK_SERVICE_PUBKEY}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM node:20-alpine AS proxy-deps
WORKDIR /app
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY services/private-link-proxy/package.json services/private-link-proxy/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:20-alpine AS private-link-proxy
WORKDIR /app
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
ARG RELAY_URLS="https://relay.primal.net"
ARG PRIVATE_LINK_SERVICE_SECRET="CHANGE_THIS_BEFORE_BUILDING"
ENV RELAY_URLS=$RELAY_URLS
ENV PRIVATE_LINK_SERVICE_SECRET=$PRIVATE_LINK_SERVICE_SECRET
ENV NODE_ENV=production
COPY --from=proxy-deps /app/node_modules ./node_modules
COPY services/private-link-proxy/ ./
RUN pnpm build
EXPOSE 8787
CMD ["node", "build/server.js"]

FROM nginx:1.27-alpine AS runner
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
