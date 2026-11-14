# Tay's Brain

A private personal feed that ends. Every other day a cloud job sweeps a list of trusted sources and drops about 10 cards. You read them, save the good ones, and hit "You're caught up". There's no infinite scroll.

This repo is only the app shell. It has **no personal data**. Cards, sources and thoughts live in a separate **private** repo and are fetched at runtime with a fine-grained GitHub token that stays in the phone's localStorage.

## Install on iPhone

1. Open the GitHub Pages URL in Safari.
2. Tap Share, then **Add to Home Screen**.
3. Open it from the home screen and follow the setup screen to paste your key.

## The key

Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) with:

- Repository access: **only** the private data repo
- Permissions: **Contents** read-only, **Issues** read and write

The app never stores the key anywhere but the device. **Forget key** in Settings wipes it, along with saved cards and read history.

## Data repo format

```
feed/cards.json    [{ id, field, headline, why, source, url, drop, createdAt }]
feed/sources.json  { "<field id>": [{ name, url, why }] }
issues labeled "thought"   your posted thoughts; replies are issue comments
```

Field ids: `time-freedom`, `future-of-work`, `money`, `sports-business`, `skills`, `thoughts`.
`drop` is a `YYYY-MM-DD` date. The newest drop is the feed, and older drops collapse below it.

## Files

| File | What it is |
| --- | --- |
| `index.html` | App shell, setup screen, templates |
| `styles.css` | Look, layout and motion |
| `app.js` | GitHub API, rendering, gestures (bump `APP_VERSION` on change) |
| `sw.js` | Offline shell cache (bump `CACHE` on change). Never caches API data. |
| `manifest.webmanifest`, `icons/` | Home-screen install |
| `fonts/` | Big Shoulders Display and Figtree (SIL Open Font License) |
