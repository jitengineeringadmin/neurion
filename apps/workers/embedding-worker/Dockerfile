# neurion/embedding-worker:0.1.0
FROM node:20-alpine
WORKDIR /worker
COPY package.json ./
RUN npm install --omit=dev || true
COPY dist ./dist
ENTRYPOINT ["node", "dist/run.js"]
