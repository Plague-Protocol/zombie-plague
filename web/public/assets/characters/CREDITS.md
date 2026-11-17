# Character assets

All CC0. Credit is not required but is given here.

- **Body and skins:** "Animated Characters 3" by Kenney (https://www.kenney.nl), CC0
  (LICENSE-kenney-cc0.txt). Source: https://opengameart.org/content/animated-characters-3.
  The skins are the unmodified 256x256 PNGs from the pack.
- **More survivor skins** (survivorMaleB, survivorFemaleA from "Animated Characters 1"; cyborgFemaleA, criminalMaleA,
  skaterFemaleA, skaterMaleA from "Animated Characters 2"), by Kenney, CC0, unmodified. Sources:
  https://opengameart.org/content/animated-characters-1 and https://opengameart.org/content/animated-characters-2.
  The three packs share one body and UV layout, so any skin fits `character.glb`.
- **Animations:** "Universal Animation Library" and "Universal Animation Library 2" (Standard)
  by Quaternius (https://quaternius.com), CC0 (LICENSE-quaternius-ual-cc0.txt). Sources:
  https://opengameart.org/content/universal-animation-library and
  https://opengameart.org/content/universal-animation-library-2.

`character.glb` and `character.json` are built by `tools/convert-characters.mjs`, which retargets
the Quaternius clips onto the Kenney skeleton and measures each walk/run cycle's ground speed
(so the game can play feet at the speed the character actually moves). Preview every clip with
`npm run dev` and open `/tools/preview.html` (`?clip=Walk&side&paused&t=0.5` and `?skin=zombieMaleA`).
