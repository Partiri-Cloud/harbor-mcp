# Stage 1: Build MCP server
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Run only with production deps
FROM node:22-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

ENV MCP_TRANSPORT=http
ENV MCP_DATA_DIR=/app/data
EXPOSE 3000

CMD ["node", "dist/index.mjs"]
