# Снимки DevContour для H3

Сняты read-only в `devcontour-dedup` на `6a597286a1d59b107fa0365c9a0f01765696af90`
(`src/application/agent.ts` и входы каталога побайтово те же на `d3e2d10`):

```sh
node --import tsx -e "import('./src/application/agent.ts').then(m=>process.stdout.write(JSON.stringify(m.capabilities())))" > devcontour-capabilities.json
(cd packs/profiles && shasum -a 256 *.json)   # → devcontour-builtin-profiles.json
```

- `devcontour-capabilities.json` — 61382 байт, SHA-256 `862305bac2a606004d67a709234f7bbcd08c666e8bcd1b243a0d75e303770f1e`
  (= `catalogDigest` DevContour: sha256 `JSON.stringify(capabilities())`).
- `devcontour-builtin-profiles.json` — SHA-256 девяти встроенных профилей DevContour.
