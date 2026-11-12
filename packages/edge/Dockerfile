FROM node:24-slim
WORKDIR /app
# Build context: the output of `pnpm --filter @nbo/edge deploy --prod <dir>`
# (run `pnpm --filter @nbo/edge build` first so dist/ exists).
COPY . .
USER node
EXPOSE 8080 8443 9444
CMD ["node","dist/main.js"]
