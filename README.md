# Soft Matter Lab

A waves, cloth, flow, surface-tension, soft-body, and particle-medium lab for shop class and intro physics — by Virgil Renfroe.

GitHub Pages (same source, once enabled): https://virgilrenfroe.github.io/soft-matter-lab/  
Repo: https://github.com/virgilrenfroe/soft-matter-lab

Single-page three.js exhibit. One shared WebGL context; specimens render via scissor/viewport into DOM regions (three.js multiple-elements pattern).

Railway is the live host. `Dockerfile`, `Caddyfile`, and `railway.toml` are ready to connect (Caddy static, `PORT` 8080). No Railway credentials are required to build the image.

## Specimens

1. **Wave basin** — a crest travels across the tank; colored floats bob on fixed masts. Click to drop a stone.
2. **Cloth** — a pinned sheet shares tension. Drag a point, add wind, or send a gust.
3. **Flow** — ink is carried around a post. The material itself moves.
4. **Centerpiece** — wave and cloth side by side.
5. **Surface tension** — a drop's skin pulls it into a bead, or lets it wet out. Poke the drop and watch the skin pull back.
6. **Soft body** — a block of jelly. Poke it or drop it. The shape changes, neighbors share the dent, and the body stays one piece with roughly the same volume. Reduced motion and `?still=1` hold the resting block. A poke or a drop still runs, because the student started it.

7. **Particle medium** — a pulse travels through a tray of beads. Each bead oscillates near its home mark. Click a bead to poke that site. Reduced motion and `?still=1` hold the tray quiet. A pulse or a poke still runs, because the student started it.

## Local

```bash
python3 -m http.server 8877
```

Open `http://localhost:8877/`. Optional query flags: `?embed=1` (specimens only) and `?still=1` (no autonomous motion).

## Stack

- three.js `0.170.0` (CDN import map)
- Google Fonts: Bricolage Grotesque, Instrument Sans, Space Mono
- No backend, no HDR downloads
- Hosted on Railway (Caddy static) with GitHub Pages as the matching virgilrenfroe path when enabled
