# neurion/embedding-worker:0.1.0 — real local embeddings (all-MiniLM-L6-v2), offline.
# node:20-slim (glibc) — onnxruntime-node prebuilds are glibc, not musl/alpine.
FROM node:20-slim
WORKDIR /worker
COPY package.json ./
RUN npm install --omit=dev
COPY dist ./dist
ENV TRANSFORMERS_CACHE=/worker/.models
# Bake the model into the image at build time so the --network none job sandbox
# can load it with no network access.
RUN EMBED_ALLOW_REMOTE=true node -e "import('@xenova/transformers').then(async (m) => { m.env.cacheDir='/worker/.models'; m.env.allowRemoteModels=true; await m.pipeline('feature-extraction','Xenova/all-MiniLM-L6-v2'); console.log('model baked'); }).catch((e) => { console.error(e); process.exit(1); })"
ENTRYPOINT ["node", "dist/run.js"]
