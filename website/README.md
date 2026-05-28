# Wireless Multicam Studio — landing page

Static [Astro](https://astro.build/) site for **Wireless Multicam Studio**
(the product built from this repo). Lives here so the marketing site and the
app code stay in lockstep — same versioning, same PRs, same review.

The site is deliberately small: a single page (`src/pages/index.astro`)
composed of the components in `src/components/`, with Tailwind CSS v4 via the
`@tailwindcss/vite` plugin. The "Download" button always points at the latest
published Windows installer through GitHub's
`/releases/latest/download/<asset>` redirect — see [`src/config.ts`](src/config.ts)
for the single source of truth on repo + download links.

## Develop

```sh
cd website
npm install
npm run dev        # http://localhost:4321
```

| Command           | Action                                       |
| :---------------- | :------------------------------------------- |
| `npm run dev`     | Dev server with HMR                          |
| `npm run build`   | Production build to `./dist/`                |
| `npm run preview` | Serve the production build locally           |

Node **22.12+** required (see `engines` in `package.json`).

## Deploy

The site is built and hosted on **Vercel**. The Vercel project is configured
with the repo root pointing at `website/` and the **Astro** framework preset,
so deploys are automatic on push to `main` (production) and on every PR
(preview URLs).

No deploy config lives in this directory — Vercel auto-detects Astro and
runs `astro build`. If you ever need to deploy from the CLI:

```sh
npm i -g vercel
cd website
vercel              # preview deploy
vercel --prod       # promote to production
```

## License

Same as the rest of the repo — see [`LICENSE`](../LICENSE) at the root.
