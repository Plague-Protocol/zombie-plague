# Zombie Plague

A browser horror game: a virus has emptied Port Halden, and you were bitten an hour ago. Three
antiviral doses, three districts between you and the evacuation flight that carries the treatment.
Each dose holds the infection back for a few minutes; when it runs out, you turn. This is now Zombie Plague itself (it was built as "Outbreak"); the social deduction game
that had the name ([Deduce, once plague-celo](../deduce), "Infect the Room") moves to its own subdomain.
That repo is read here, never modified.

## The cold open

The first visit in a session opens on Zombie Plague's splash, ported from plague-celo
(`web/src/ui/splash.ts`, markup and styles in `index.html`): the logo gate over a looping clip, then a
transmission from Port Halden Command typed out in three acts (nine lines; the scream is keyed to
the third, the act changes drive the fades; the commander is infected, and the last fragment after
the "…" is the tell), then the title slams in. It loads in its own chunk while the game loads; the
gate clip waits for the page to load and is never fetched on a slow or data-saving connection.
Skip is always there; `?skipintro` skips it too. The 3D scene does not render underneath it.
Art, clips and sounds come from plague-celo's `web/public/` (`web/public/intro/`); the faces are Eater and
VT323 (SIL Open Font License 1.1, licences in `web/public/intro/fonts/`).

Status: phase 1 slice (one city, single player, no sign-in, no backend, no wallet).
Design: [docs/DESIGN.md](docs/DESIGN.md).

## Layout

One repository, one history. The game's rules are shared code, so the page and the server can never disagree about them.

| Folder | What | Run |
|---|---|---|
| `core/` | The game's rules (pure, deterministic, no dependencies) and the wire protocol. The page plays them; the server replays and runs them unchanged. | tested from `web/` |
| `web/` | The game page (Vite, three.js): rendering, sound, input, UI, lobby, leaderboard, admin page. Deployed to Vercel (`vercel.json` at the root builds `web/`). | below |
| `server/` | Accounts, replay-checked runs, leaderboards, real-time rooms, staked-room settlement, admin API. One Docker image. | [The server](#the-server) |
| `contracts/` | The stake contracts (Foundry). | `forge test` |
| `deploy/`, `docs/` | How to deploy each part ([deploy/README.md](deploy/README.md)); design, plans, deployments. | |

## Run

```sh
cd web
npm install        # scripts are disabled by .npmrc; versions are exact-pinned
npm run dev        # http://localhost:5173 (also on your LAN, for testing on a phone)
npm test           # unit tests (the rules in ../core, and the page)
npm run build      # typecheck + production build into web/dist/
```

URL options: `?server=ws://host:8787` the multiplayer server, `?seed=123` fixed night, `?skipintro`, `?debug` perf overlay, `?dpr=1.5` cap the
pixel ratio, `?lights=0..6` number of real point lights, `?zoom=N` camera span.

## The plague

What makes this Zombie Plague and not another zombie run. Every rule here lives in the pure game
state (`core/state.ts`), so a server can run it unchanged; the renderer and sound only show it.

- **The clock is your infection.** The timer is the dose wearing off (`infection()` = share of the
  clock gone). At zero you turn (TURNED). A bite hurts and also jumps the infection ahead 8 seconds
  (less through gear). Antiviral doses (three lying in each district, in houses the quarantine
  teams fled, $60 at a store's first-aid shelf) hold it back 30 seconds, never past a full clock.
- **It changes what you see and hear.** As it climbs, colour drains from the picture, veins grow in
  from the edges of the screen and beat with your pulse, everything but your own heart goes dull,
  and the groaning starts to sound like whispering. Past 60% you cough, and anything within 8 units
  hears it. Past 50% the infected see less of you (up to 35% less): you are nearly one of them.
- **Sam shows it.** A bandage over the bite from the first frame; his skin loses its colour as the
  infection climbs; hurt or far gone, he limps; a cough doubles him over.
- **You turn, and you stay.** Caught or turned, your last self is waiting in that chapter the next
  time you come through it (kept on the device): your own face, far tougher than a runner, near where
  it happened. Put it down and it drops the weapon you were holding.
- **Real darkness, and a flashlight that is a choice** (LIGHT, or F). The sky gives shapes, not
  detail. Light on, you see what the beam touches and they see you at full range. Light off, they
  have to be twice as close to notice you, and so do you.
- **Quiet, then one sound, then panic.** A director runs each district: a long quiet (38 to 58
  seconds), then the wind drops, the lamps falter and something heavy falls nearby, and five
  seconds later a small pack comes up out of the ground there. It holds off while you work a step,
  drive, or are already being hunted.
- **Three more kinds of infected.**
  - *Screamer* (gaunt, pallid): when it has you in plain view it stops and fills its lungs for 1.4
    seconds, then calls everything within 32 units and brings runners from further off. Hit it
    first and it chokes. Go round it with your light off.
  - *Dormant*: bodies lie in every street, and some of them are not dead. Walk within 3 units, or
    make a noise close by, and it gets up. Aim assist never picks one out and shots pass over them;
    a swing of a baton into a body finds out. Your heartbeat is the one tell: it picks up near
    anything alive.
  - *Stalker* (tall, nearly black): knows where you are from 40 units, comes at you fast through
    the dark, and does not move a muscle while your beam is on it. Look away and it comes on.
- **Half bodies and tentacles.** No new models: the crowd shader pulls a lost part in to the joint it
  was torn off at, which leaves a raw stump.
  - *Crawler*: the top half of one, dragging itself. Slow and low. It does little damage; it gets
    hold of your leg and you move at 55% speed for 2.5 seconds. One gun kill in seven on a walker
    only takes the legs, and the top half keeps coming.
  - *Lasher*: no head, and a knot of tentacles where it was. It strikes from 3.3 units (an arm
    reaches 1.35) after a long wind-up you can hear, and the hit drags you toward it.
  - About one walker in six is missing an arm.
- **Each kind has its own voice** (all synthesised, `web/src/audio/sound.ts`): the screamer's long
  breath in and then a full human scream with its echo; a crawler's drag and rattle; a lasher's wet
  clicking and the whistle and crack of its strike; a stalker's dry chitter in the dark.
- **Hidden bites.** Someone you are bringing in may be bitten and hiding it (30% of groups in the
  first district, 60% in the last). The bitten cough every 7 to 12 seconds; now and then someone
  healthy has a cough too. Stand still beside them and CHECK (2.5 seconds each): clean, or bitten.
  LEAVE the bitten where they stand, or they turn beside the others within about 75 to 115 seconds.
  Take one to the door unnoticed and it ends there (CARRIER). If the last of them is left, you
  bring the news to the door alone.
- **Marks on the doors.** A red X with tape: one of them is inside, always, and so is what the
  quarantine team dropped when it ran (often a dose). A white ring: cleared, never an ambush.
  No mark: nobody got that far (30% as before). The map shows the marks.
- **The outbreak spreads.** Blocks fall one neighbour at a time as your infection climbs (10% of
  the first district at the start, 75% of the last by the end). The map shows them red; in one,
  the air goes sick and full of spores, they see 25% further, and the quiet is shorter.
- **The streets.** Body bags in rows on the pavement, burn sites still glowing, quarantine
  placards, and the loudspeakers still reading out orders nobody is left to follow.

**Replays.** Every night is written down as it is played (`core/replay.ts`): each step's input
(the stick in 64ths, buttons as bits, runs folded together) and everything done between steps
(purchases, weapon swaps, puzzle answers), which all go through one `command()`. `replay(log)`
re-runs it to the same end state; the log goes out with the run result (`RunResult.replay`).
Caveat: exact across the same JavaScript engine only, until the trig calls are made deterministic.

## Multiplayer

Free rooms of 2 to 8 players in one district at once, run by a server. Tap **Multiplayer** on the title
screen, make a room (a five-letter code) or join one, and the host starts it. The steps are shared (anyone
doing one does it for everyone); the exit has seats for half of those who started; the dose of each player
ticks down separately and a player who runs out, or is shot down, **turns** and hunts the rest as one of
them. A bullet or a swing does half damage to a living player (none in the first 20 seconds or near the
exit). Rooms have no vehicles and nobody to escort.

What a browser is told is what its player could see (`core/view.ts`): other players and infected out
of sight, other players' health and clocks, and noises too far to hear never leave the server. Snapshots go
out at 15 a second in a compact form (`core/codec.ts`), 4 to 6 KB/s per player. Your own walking is
predicted so the controls answer at once, and corrected when the server's word comes back; everything else
is drawn a tenth of a second in the past, between two snapshots (`web/src/net/room.ts`, loaded only when you tap
Multiplayer).

Sign in with the wallet the page has (MiniPay, MetaMask) to be known by name, put your nights on the
leaderboard and have your last self follow you from device to device; guests can play free rooms.

## The server

`server/` (Node 22, Fastify, `ws`, Postgres through `pg`). It imports the game's rules from `core`
unchanged, so the rules a browser plays are the rules the server checks.

- **Accounts:** a wallet signs a one-time nonce; the server hands back a token (`server/src/auth.ts`).
- **Runs are checked by replay:** a finished night uploads with its log; the server replays it (the same
  rules, with a last self taken from its own records, not the client's) and believes the claim only if the
  replay ends the way it says (`server/src/runs.ts`). Only replayed wins reach the leaderboard.
- **Rooms:** 30 ticks a second, one `viewFor` per seat, every round logged and its fingerprint kept
  (`server/src/rooms.ts`). Replaying a stored round gives the same end, which is how a dispute is settled.
- **The day's night:** `GET /night/today`: one seed for everyone, from the date.

```sh
cd server && cp .env.example .env     # set JWT_SECRET (32+ characters) at least
npm install && npm run dev            # http and ws on :8787; no DATABASE_URL = in memory
npm test                              # TEST_DATABASE_URL=postgres://... adds the Postgres ones
docker compose -f server/docker-compose.yml --env-file server/.env up --build   # server + Postgres (image build not yet tried: no docker daemon was running)
```

The browser finds the server at `?server=ws://host:port`, `VITE_SERVER_URL`, or the page's host on :8787.

## Replays are exact across engines

The rules use their own sin, cos, atan2 and hypot (`core/dmath.ts`), because the standard ones may
differ in their last bit between V8 and Safari's JavaScriptCore. `web/tests/fixtures/replay-v1.json` holds a
night and a room round with their fingerprints; `web/tools/engine-check.ts` replays them in any engine and was
run in JavaScriptCore (every iPhone browser) and Node with identical results.

## Staked rooms: built and proven on Celo Sepolia, off by default

`contracts/` holds the stake contracts, modelled on plague-celo's staked rooms: players create and join rooms
from their own wallets, stakes sit in a separate custody contract, a 1.5% fee goes to a separate fee
contract, an unstarted room refunds on expiry, and the server settles a finished round by naming the players
who got out. The server seats a player only if the chain shows their stake, starts the round when the chain
says so, and pays the winners with a settlement written down before it is sent. `forge test` (27 tests).

Deployed to **Celo Sepolia** (not mainnet): addresses and the acceptance run, with transaction hashes, are in
[docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md). Staked rooms stay switched off (`STAKED=false`) until the owner
has a legal view and the mainnet admin is a multisig; see [docs/PHASE2-BUILD-PLAN.md](docs/PHASE2-BUILD-PLAN.md)
section 9. The weaker "one person, many wallets" defence (account age, finished nights, no recent failed
replay) slows a farm down and does not stop one person running several.

**Stake tokens:** USDm and USDT, one contract each (USDT has 6 decimals). **Admin:** open the game with `?admin`
signed in as a wallet in `ADMIN_ADDRESSES` or one holding the contracts' admin role: health, players, live rooms,
settlements (retry), failed replays, and per token the fees, escrow and gas, with pause and fee withdrawal sent from
the admin wallet.

## Leaderboard, sign-in, invites

Guests get three minutes of play, then sign in to go on. Multiplayer is for signed-in players. Every night is
tonight's city (the same for everyone on a day). A run's score comes from the server's own replay of it: districts
cleared, getting out and the time left, kills (capped), people helped, optional steps, accuracy, a clean night, less
bites, doses and people you let turn. Boards: tonight, the week, streaks, rooms; each shows your rank, a title, and
how far it is to the next place. Rooms: Quick play into an open public room, or a private room joined by code or an
invite link (`?join=CODE`). Recorded sounds and their licences: `web/public/sfx/CREDITS.md`.

**Sign-in:** an injected wallet (MiniPay, MetaMask), or Google / passkey (thirdweb, set `VITE_THIRDWEB_CLIENT_ID`;
that wallet signs in but cannot stake). Copy `.env.example` (page) and `server/.env.example` (server).

## Playing

- **Chapters:** a night crosses three districts, each a freshly generated part of the city with
  its own clock. Steps come up one at a time (only the current one is on the street and the map);
  the district map is always the last, and it shows the way out: a subway entrance into the next
  district. Weapons, ammo, gear, cash and kills carry over; seconds left on the clock pay $0.50
  each, and you catch your breath (+25 health). Later districts have runners in the crowd and
  bigger waves. The third chapter ends at the helicopter. Each district has its own dose and so its
  own clock; when it runs out you turn (TURNED). A retry restarts the chapter with what you came
  into it with.
- **People you bring in:** some steps hand you someone to protect (Nora, Leo, or the family of
  three, who follow in a line). If one of the infected gets hold of any of them for a second, it is
  over (INFECTED). You are warned when one is on them; shoot it or get between them. They are
  handed over at a real door (a home, the bakery, the shelter): whoever lives there waits in the
  doorway, and everyone goes inside. A bike seats two besides you, a car three or more, a van six;
  more than that and you need a bigger vehicle.
- **Three parts of the city:** each chapter has its own look, layout and light, set in the content
  file (`story.chapters`: theme, exit, light). Chapter one is downtown under cold moonlight;
  chapter two the docks and rail yard (warehouses, containers, freight wagons on the tracks, orange
  sodium lamps, haze); chapter three the edge of town (a few streets, open ground, Halden Woods,
  cold fog, fewer of them but more runners). You leave downtown down the subway stairs, the docks
  through a gate in the army barricade, and the city by helicopter.
- **Leaving a district:** you walk yourself down the subway stairs into the dark before the next
  chapter card. At the end, the helicopter is on the pad with soldiers waiting; walk up and the
  scene plays itself: one checks you over, you all climb in, it lifts off over the city.
- **Guards and the chase:** some objectives come up guarded, a pack milling over the item (or its
  pieces) until it sees or hears you (35% of steps in the first district, 60% in the last). Finding
  the map sets a pack hunting you from all round for 45 seconds: run for the way out. Pieces can be
  grabbed from a car or bike, and nothing is ever parked on top of one. (The route bot, which
  shoots what comes close but never dodges, drives or buys, wins 18/40 first chapters and 6/20 last
  chapters.)
- **The infected:** a crowded town (up to 110, about 20 drawn at once). Walkers lurch at about
  half your running speed, runners nearly match it; some run even in the first district. The dead
  stay where they fall for the rest of the chapter.
- **Move:** drag anywhere (floating stick) or WASD. A light push walks, a full push runs.
- **Fire / swing:** hold FIRE (or Space). Aim assist picks the zombie in front of you. Gunfire
  is loud: everything within earshot comes looking. With a melee weapon the button reads SWING.
- **Use:** the contextual button (or E): start an objective, search a supply crate, enter a
  weapon store, get in or out of a vehicle. **Reload** (R) and **swap weapon** (Q) buttons.
- **Story moments wait for you:** finding something, the radio's next brief, a survivor talking
  and a new chapter open a message panel and the game holds (no clock, no zombies) until you tap
  through it. Its last page says plainly what to do next and how far it is. You then get a moment
  before the zombies come on again.
- **Objectives are safe:** while you work an objective or talk to someone (and for a second
  after), the zombies that were after you hold back and wait. Anything you take (keys, keycard,
  map, supplies) lies where you can see it and is gone once taken.
- **Drive:** about ten vehicles a district, half of them motorbikes. Push the stick where you want
  to go and it steers there; push back against the nose to reverse. Run zombies down. A vehicle is
  not a safe room: the engine calls every zombie within earshot, again and again while it runs.
  Get slow near them and they **grab hold** (up to four), ride along clawing at it and drag its top
  speed down; drive fast to shake them off (a crash throws them). Once a car is beaten below 40%
  the glass is gone and the ones on it reach you. If it dies, you are thrown out among them. On a
  bike nothing grabs the bike: they go for you. You are told this the first time you get in. The
  moment an engine starts, a swarm of runners comes out of the side streets ahead of you, and more
  every 12 seconds while you drive; they run as fast as a car through the streets and for where it
  is going, to get in front of it. Each one you hit slows you.
- **Map:** the minimap (top right) is rotated to match the screen. Tap it or press M for the full
  city map (pauses the game).
- **Weapons:** you start with a pistol and a police baton. Baseball bats, a machete, shotguns and
  an assault rifle lie in the streets, with ammo cans. Melee is quiet and never runs dry: a bat
  can hit three at once, a machete drops a walker in one hit, but you have to be close.
- **Weapon stores:** three per night (Halden Arms and others), lit storefronts with a rooftop
  sign. Walk in through the door (or press ENTER) and the game pauses on the store's page:
  weapons with their stats, upgrades (damage, extended magazine, fast reload; two levels each),
  ammo, medkits. Buy, and equip what you want in hand. Money comes from supply crates, the
  survivor, and kills.
- **Distractions:** THROW (G) lobs a bottle; whatever is near where it smashes goes to look.
  Press ALARM by a parked car (or fire a gun right beside one) and its alarm draws everything
  within a long way for ten seconds. Bottles lie in the streets, in crates and in stores.
- **Houses:** some front doors glint: SEARCH takes two seconds standing still and turns up cash,
  ammo, first aid or bottles. Sometimes one of them was inside.
- **Survivors:** two per night, holed up on the street (green rings on the map). TALK: some want
  their bag fetched from a couple of blocks away, some are cornered and want the infected around
  them cleared. Help them for cash, ammo, a weapon, or where the evac point is.
- **Fuel:** every car has some fuel, rarely much (shown while driving). An empty tank coasts to a
  stop. Jerrycans (in the streets and stores) fill a tank by 60% (REFUEL beside the car); stopping
  at the gas station's pumps fills it.
- **Health:** a lunge hurts and knocks you back; the third kills. Shoot a zombie during its
  wind-up to spoil the lunge. Medkits heal.
- **Protective gear:** a Kevlar vest takes half of every hit, a riot helmet a quarter; each wears
  down by what it takes and shows on the character while it lasts. One lies somewhere in each
  district, houses sometimes have one, and the store's Gear tab sells them (a worn piece is swapped
  for new at the price of the wear). Damage goes through one function, so it will protect against
  other players too when there are any.

## The story

Told the way Eko Lockdown tells its story: a title card, a letterboxed intro, "Speaker|line"
dialogue, radio briefs as each step comes up, radio calls as the night gets worse, and endings
(EVACUATED, TAKEN, TURNED, INFECTED, CARRIER). Each night deals its chapters different steps from the
pool (22 kinds now), never repeating one in a night, and each chapter ends with the map. Setting and names are invented so the game reads anywhere.

## The city

8 x 8 blocks (about 200 m across) generated from the seed: downtown towers, residential streets
of houses and gardens, a park, docklands with warehouses and shipping containers on the harbour,
piers, and desolate outskirts with wrecks, dead trees and an abandoned gas station.

It looks like the night after: pile-ups of crashed cars and an overturned bus choke a few streets
(cars cannot get through), an overrun military checkpoint with sandbags and an army truck, Mercy
Hospital with ambulances at the doors, boarded-up and burned-out houses, gutted towers, shop
windows boarded or smashed, street lights knocked down, dead or flickering, overgrown lots, and
rubble, litter, suitcases and scorch marks in the streets. Zombies rest across the city (denser
downtown); only those near you are simulated, and waves rise from just out of sight as the clock
runs down.

## Deploying

It is a static site: no backend is needed to play. `deploy/` has an nginx config (compression,
long caching of the hashed build) and the steps for a Linux server such as a Lighthouse VPS.
Nothing is deployed until you choose to.

## Layout

- `core/` pure game logic: RNG, city, task chain, state/step (movement, vehicles, weapons,
  zombies), story text. No DOM, no three.js, no wall clock, no `Math.random` (a test enforces this)
  so it can move to a server in phase 2.
- `web/src/render/` three.js view; only reads `GameState`. `city.ts` builds the city in chunks
  (culled when off screen), `props.ts` vehicles, guns, the store, the evac helicopter and effects.
- `web/src/audio/` sound synthesised in code with Web Audio (wind, sirens, groans, gunshots, engine).
- `web/src/input/`, `web/src/ui/` controls, HUD, dialogue, store, minimap and city map (plain DOM/canvas).
- `web/src/seams/` empty interfaces for sign-in (`AuthSession`) and progress (`ProgressStore`).

## Task content (data, not code)

Every step lives in `web/public/content/tasks.json`, which the game fetches at start, along with the story
around them (intro, chapter cards, radio calls, endings). The mechanics are code; a step is an entry
that picks one and supplies everything else:

- `kind`: `hold` (stand at it), `collect` (find `parts.count` pieces nearby, then fit them), `puzzle`
  (a page: `tiles` to turn a torn map the right way up, a `keypad` code, `wires` to match), or `clear`
  (the infected there come for you; done when they are down).
- `effect` when done: `reveal-exit` (the map), `escort-start` / `escort-end` (someone follows you, and
  must be with you at the door), `lure` (draws them to it for a while), `horde` (the noise brings a wave).
- Words: `objective`, `short`, `verb` (the Use button), `brief` and `done` as `"Speaker|line"`, with
  `{code}` filled in per night (door codes, phone numbers); `final` replaces the words in the last chapter.
- Looks: `scene` (a preset in `web/src/render/view.ts`: a pharmacy, a phone booth, a crashed bus...) and
  `item` (from the library in `web/src/render/props.ts`).

A group is one or more steps done in order. `core/content.ts` checks a file before it is used
(unknown kinds, missing lines, a line without a speaker, an escort that starts but never ends). New
steps that reuse the mechanics, scenes and items need no code at all. The file carries a `version`,
so a backend can serve it later and a replayed run can be checked against the same content. Puzzle
answers are checked in the core (`solvePuzzle`), not on the page.

## Characters and animation

Bodies and skins: Kenney "Animated Characters 3" (CC0). Animations: Quaternius "Universal
Animation Library" 1 and 2 (CC0): locomotion, death, hit, pistol aim/shoot/reload, interact,
kneel, two one-handed melee swings, and the zombie idle, shuffle, lunge and rise. `web/tools/convert-characters.mjs` retargets them
onto the Kenney skeleton and measures each walk/run cycle's ground speed so feet never slide. Gun
poses play on the upper body only, over whatever the legs are doing. Credits:
`web/public/assets/characters/CREDITS.md`. Preview clips at `/tools/preview.html` under `npm run dev`.

## Vehicles and weapons

Our own models, drawn in code by `web/tools/build-models.mjs` (side profiles extruded with rounded
edges, turned wheels and bats) into `web/public/assets/models/models.glb`: sedan, pickup, van, a
motorbike, pistol, shotgun, rifle, baton, bat and machete. Each is one
vertex-coloured mesh (one draw call; vehicles add one for their lights). Parts in the marker colour
(magenta) take a **finish** at load: a car's paint, a gun's furniture. That is the hook for personal
assets: same model, the owner's finish (`modelGeometry(name, finish)` in `web/src/render/models.ts`).
Rebuild with `node web/tools/build-models.mjs web/public/assets/models/models.glb`; look at them (with a
colour picker) at `/tools/models.html` under `npm run dev`.

## Performance budget

| | Budget | Measured (worst case: 18 zombies around the player) |
|---|---|---|
| Draw calls | <= 40 | 16 with 24 zombies and 6 bodies on screen: the whole crowd is 2 calls (was one per zombie) |
| Triangles | <= 50,000 | ~34,500-41,700 (the debris of the abandoned city adds a few thousand) |
| Real lights | small | hemisphere + moon + flashlight/headlights + fill + 3 pooled + muzzle flash |
| Zombies drawn | the nearest 70 and 40 bodies (full), 45/24 (phones start here), 28/12 (lightest) | batched: animations baked into a bone texture at load (`web/src/render/crowd.ts`), posed on the GPU, no per-zombie animation work on the CPU |
| JS bundle (gzip) | <= 240 KB (raised from 220 on 2026-11-09) | 222.2 KB at start, in one file (the store 3.0 KB, full map 1.7 KB and puzzle pages 1.9 KB load when first needed; task content is 6 KB of JSON) |
| Character assets (gzip) | <= 450 KB | ~426 KB (GLB 282 KB + 4 skins 144 KB) |
| Vehicle and weapon models (gzip) | <= 150 KB | 132 KB (622 KB raw); ~2,300 triangles a car, 500-1,200 a weapon |

The worst case was measured at a store's door with 18 zombies around, on three nights; the
busiest downtown spot reached 36 calls. Measured with `?debug` (`renderer.info`) in headless desktop Chrome with software rendering, so
the frame rates it shows mean nothing for a phone. **Not yet measured on a real Android phone.**
The levers there: `?lights=0`, `?dpr=1`, `?quality=2`.

Phones get warm because the graphics chip draws the whole 3D scene every frame; a backend cannot
take that away (only video streaming could, at a cost per player and in mobile data). What keeps it
down, all on the device:
- **30 frames a second on phones**, 60 on a computer, with nothing for the player to set (`?fps=60`
  overrides for testing); half the drawing, plenty for this game. A held story moment or the store redraws 20 times a second.
- **Quality that steps itself down:** level 0 (2x pixels on a computer, 1.5x on a phone; 70 zombies
  and 40 bodies drawn), 1 (1.25x; 45 and 24), 2 (1x; 28 and 12). Phones start at 1. If play runs
  below 85% of the target frame rate over four seconds, it drops a level and remembers it.
  `?quality=0..2` fixes it.
- **The crowd is batched:** every zombie and body in two draw calls, posed on the GPU from baked
  animation, so a big horde costs little on the CPU. The minimap redraws 20 times a second.
- Cars are ~2,300 triangles: a street with several in view costs more; re-measure the worst case.
