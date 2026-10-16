// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';

// https://astro.build/config
export default defineConfig({
	// ponytail: placeholder until the Cloudflare domain exists; RSS and canonical URLs read it
	site: 'https://example.com',
	integrations: [mdx()],
	// three.js + GLTFLoader is one ~600 kB chunk, lazy-loaded by the hero only
	vite: { build: { chunkSizeWarningLimit: 700 } },
});
