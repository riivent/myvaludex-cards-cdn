// src/worker.js
export default {
  async fetch(request, env, ctx) {
    // Statische Dateien aus dem Assets-Bucket ausliefern:
    // z.B. /cards/name/Pikachu.json oder /cards/dex/0032.json
    return env.ASSETS.fetch(request);
  }
};
