# Portfolio

Static Astro site: work, writing, and film reviews, with an isometric three.js character in the hero.

```sh
npm install
npm run dev      # http://localhost:4321
npm run build    # outputs dist/
```

## Content

- Articles: `src/content/articles/*.mdx`
- Film reviews: `src/content/films/*.md`

Schemas live in `src/content.config.ts`. Set `draft: true` to hide an entry from the build (drafts still show in dev).

## Deploy (Cloudflare Pages)

Build command `npm run build`, output directory `dist`. Set `site` in `astro.config.mjs` to the real domain first.
