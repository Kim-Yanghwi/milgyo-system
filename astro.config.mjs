import { defineConfig, passthroughImageService } from 'astro/config';

export default defineConfig({
  site: 'https://system.milgyo.org',
  // Public seal/logo files are served unchanged; do not invoke native image codecs.
  // Mitigation only: the known Astro/Sharp dependency update remains a release gate.
  image: { service: passthroughImageService() },
});
