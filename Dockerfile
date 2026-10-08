FROM oven/bun:1.3.14 AS build
WORKDIR /srv/chatspace
COPY . .
RUN bun install --frozen-lockfile
RUN bun run build

FROM oven/bun:1.3.14 AS runtime
WORKDIR /srv/chatspace
COPY --from=build --chown=bun:bun /srv/chatspace/node_modules ./node_modules
COPY --from=build --chown=bun:bun /srv/chatspace/package.json ./package.json
COPY --from=build --chown=bun:bun /srv/chatspace/chat ./chat
COPY --from=build --chown=bun:bun /srv/chatspace/app/package.json ./app/package.json
COPY --from=build --chown=bun:bun /srv/chatspace/app/dist ./app/dist
RUN mkdir -p /data/chatspace && chown bun:bun /data/chatspace
ENV NODE_ENV=production
ENV CHAT_HOST=0.0.0.0
ENV CHATSPACE_LIBRARY_DIR=/data/chatspace
USER bun
EXPOSE 3901
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD bun -e 'const r = await fetch(`http://127.0.0.1:${process.env.CHAT_PORT ?? process.env.PORT ?? 3901}/api/health`); process.exit(r.ok ? 0 : 1)'
CMD ["bun", "run", "--cwd", "chat", "start"]
