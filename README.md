# Soft Matter Lab

A waves, cloth, flow, surface-tension, soft-body, and fluids lab for shop class and intro physics — by Virgil Renfroe.

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

**08. Buoyancy** — same-size blocks in one tank. Density decides float or sink. Buoyancy is the upward push from the fluid. Drop the blocks, or switch the tank from water to oil. With reduced motion or `?still=1`, the tank rests at float and sink. Press Drop and the fall still runs.

**09. Viscosity** — two matching balls drop from the same height. The left column stays thin. The right column follows a viscosity slider (or Thin / Syrup / Honey). Gravity is the same push; a thicker liquid resists the fall. With reduced motion or `?still=1`, the columns rest on that comparison. Press Drop and that one fall still runs.

**10. Capillary action** — three wettable glass tubes stand in one dish. The left tube is wide and the right tube is narrow. The middle tube follows a width slider (or Wide / Medium / Narrow). The liquid's skin pulls along the wall, so a narrower opening climbs higher. With reduced motion or `?still=1`, the tubes rest on a finished climb. Press Climb, or change the width, and that one climb still runs.

**11. Diffusion** — a drop of dye in a shallow still dish. The color spreads from a crowded spot into empty water. Nothing carries it. Warm water lets the dye wander faster. Cool water lets it wander more slowly. With reduced motion or `?still=1`, the dish opens on a dye cloud that has already spread, and holds still. Press Drop dye and that one spread still runs.

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
