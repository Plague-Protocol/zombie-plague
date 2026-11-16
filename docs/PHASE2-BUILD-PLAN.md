# Zombie Plague: build plan for multiplayer and staked multiplayer

Written 2026-11-16 for the coding agent that will build it. It is meant to be followed without
exploring the repository first: every file, type, message and check you need is named here. Where
something is a decision, it has been made; where a fact could not be checked from this repo, it is
marked **VERIFY** and you must confirm it before relying on it.

Scope: free multiplayer (work packages W0 to W3) and staked multiplayer (W4, W5).
Out of scope: staked solo (dropped by the owner), G$ rewards (a separate plan; W1 gives it the
verified-run endpoint it needs), new single-player content.

## 1. Ground rules

1. Work on `main`. Never create branches. Commit only when the owner asks.
2. Never modify `../plague-celo`. You may read it for patterns (its backend is Express, socket.io,
   Prisma on Postgres, Redis, viem; its contracts are Foundry, solc 0.8.28, evm `cancun`).
3. Startup JavaScript must stay at or under **240 KB gzip** (`dist/assets/game-*.js`; it is 235.3
   now). Everything multiplayer on the client goes in dynamically imported chunks. Ask the owner
   before exceeding the budget.
4. Dependencies: exact-pinned versions, committed lockfile, `ignore-scripts=true`, and no package
   version younger than 7 days. These are MiniPay listing requirements.
5. `src/core/` stays pure: no DOM, no three.js, no `Date`, no `Math.random`. Time comes from `dt`,
   randomness from `state.rng` and `state.rng2`. The server runs this code unchanged.
6. Stop and ask the owner before: deploying anything, touching mainnet, moving funds, creating
   GitHub resources, adding a paid service, or changing a tuning constant to make a test pass.
7. Code comments say what the code does and why, in plain sentences. No comments about this plan.
8. Each work package ends with `npm test` and `npm run build` passing and its acceptance checks
   shown to hold. Report failures as failures.

## 2. What exists (read these, nothing else)

| File | What it gives you |
|---|---|
| `src/core/state.ts` (2,225 lines) | `GameState`, `createGame(seed, level?, {night, chapter, carry, husk})`, `step(s, input, dt)`, `nextChapter`, `restartChapter`, `interactionFor`, `buy`, `equip`, `solvePuzzle`, `hurtPlayer`, `infection`, `inLight`, `lightOn`, `sightScale`, `fallenBlocks`, `leaveBehind`, `escortGroup` |
| `src/core/types.ts` | `Input` (`dx, dy, action, fire, reload, swap, throw, light`), `Zombie`, `ZombieKind` (walker, runner, screamer, stalker, crawler, lasher), `GameEvent` (the full list of what a step can emit), `Husk` |
| `src/core/replay.ts` | `STEP = 1/60`, `Command`, `command(s, c)`, `quantize(input)`, `Recorder`, `NightLog`, `replay(log)` |
| `src/core/config.ts` | Every tuning number. Add new ones here, never inline |
| `src/core/level.ts`, `map.ts`, `tasks.ts`, `content.ts` | Seeded level generation. `generateLevel(seed, {night, chapter})`. Content is `public/content/tasks.json`, installed with `setContent` |
| `src/seams/session.ts`, `src/seams/progress.ts` | The two places the client is meant to plug into a backend. `RunResult` already carries `replay: NightLog` |
| `src/main.ts` | The client loop: fixed step, `fresh()` builds a chapter and starts its log page, `act()` is the only door for changes outside a step |
| `tests/helpers.ts`, `tests/plague.test.ts` | How tests build a quiet game, place a zombie and run seconds |

Facts about the single-player state that shape the work:

- One player: `s.player` is referenced 94 times in `state.ts`. Per-player data also lives at the
  top level: `s.arsenal` (21 uses), `s.hold` (16), `s.remaining` (14), `s.escort` (10), `s.funds`
  (8), `s.work` (7), `s.safeT` (5), `s.light` (4), `s.kills` (2), plus `coughT`, `speedMul`,
  `storeLatch`, `lockedNotice`, `inFallen`, `killerId`.
- Zombies path to the player with one flow field (`s.flow`, a BFS over a 321 x 321 grid, redone when
  the player changes cell).
- Up to 110 zombies (`ZOMBIE_CAP`); those further than 60 units from the player are not simulated.
- Story moments pause the simulation on the client (`talk.open`). Multiplayer cannot pause.

## 3. Order of work

| Package | Result | Depends on |
|---|---|---|
| W0 | Replays verify across JavaScript engines | none |
| W1 | Backend: accounts, verified runs, progress, last-self | W0 |
| W2 | Core rules for several players in one district | W0 |
| W3 | Real-time server and the multiplayer client | W1, W2 |
| W4 | Stake escrow contract, tested, on Celo Sepolia | none (can run beside W1 to W3) |
| W5 | Staked rooms wired end to end | W3, W4, and the two gates in section 9 |

## 4. W0: deterministic replay

**Why.** `replay()` is exact only inside one engine. The core calls `Math.sin` (18 times),
`Math.cos` (18), `Math.atan2` (19) and `Math.hypot` (37). Their last bit is allowed to differ
between V8 (Chrome, Node) and JavaScriptCore (Safari, every iPhone browser). One differing bit
changes a comparison a few thousand steps later and the server's replay no longer matches an honest
iPhone player.

**Do.**

1. Create `src/core/dmath.ts` exporting `dsin`, `dcos`, `datan2`, `dhypot`. Use only `+ - * /`,
   `Math.sqrt`, `Math.abs`, `Math.floor` (all exactly specified by IEEE 754).
   - `dhypot(x, y) = Math.sqrt(x * x + y * y)`.
   - `dsin`: reduce to [-pi, pi] with `x - 2pi * Math.floor((x + pi) / (2pi))`, fold to
     [-pi/2, pi/2], then a degree-11 odd polynomial in Horner form. `dcos(x) = dsin(x + pi/2)`.
   - `datan2`: octant reduction, then a degree-11 odd polynomial for `atan` on [0, 1].
   - Required accuracy: absolute error under 1e-6 against `Math.*` over 100,000 seeded samples.
2. Replace every `Math.sin/cos/atan2/hypot` in `src/core/*.ts` with these. Do not touch
   `src/render`, `src/audio` or `src/ui`.
3. Add `hashState(s): string` to `src/core/replay.ts`: FNV-1a over, in this order, `phase`,
   `chapter`, `remaining`, `player.pos`, `player.health`, `funds`, `kills`, `rng.s`, `rng2.s`, and
   each zombie's `id`, `pos`, `health`. Numbers are hashed from their Float64 bytes
   (`new Float64Array([v])` viewed as `Uint8Array`), never from decimal strings.
4. Add `tests/fixtures/replay-v1.json`: a `NightLog` produced by the scripted player in
   `tests/plague.test.ts` (`play(seed)`) and the expected `hashState`. Add a test that replays the
   fixture and compares the hash. This vector is what a second engine is checked against.
5. Re-run the bot test. Win counts may shift by one or two. If they fall below the thresholds, stop
   and report; do not retune.

**Accept.** All tests pass. `grep -n "Math\.\(sin\|cos\|atan2\|hypot\)" src/core` prints nothing.
The fixture test passes in Node. If Playwright with WebKit is available, run the fixture page in it
and report the hash; if not, say it was not checked on JavaScriptCore.

## 5. W1: backend foundation

**Layout.** A new `server/` directory with its own `package.json` (`"type": "module"`, Node 22).
It imports the core by relative path (`../src/core/...`), bundled with esbuild for production.
Do not copy core files. Do not make the root a workspace; the client's install must not change.

**Dependencies** (exact-pin, 7 days old or more): `fastify`, `ws`, `@fastify/cors`, `zod`,
`@prisma/client` and `prisma`, `viem`, `jose`; dev: `tsx`, `esbuild`, `vitest`, `typescript`.

**Environment** (`server/.env.example`; compose must name each one explicitly, plague-celo was
bitten by relying on `env_file`): `DATABASE_URL`, `JWT_SECRET`, `ALLOWED_ORIGINS`, `PORT`,
`CELO_RPC`, `CHAIN_ID`, `CONTENT_DIR`.

**Database** (`server/prisma/schema.prisma`, Postgres):

```prisma
model Account {
  id        String   @id @default(cuid())
  address   String   @unique   // lower-case 0x address (thirdweb in-app wallet or MiniPay)
  name      String?
  verified  Boolean  @default(false) // GoodDollar: set by a server-side check only
  createdAt DateTime @default(now())
  runs      Run[]
}
model Run {
  id         String   @id @default(cuid())
  accountId  String
  account    Account  @relation(fields: [accountId], references: [id])
  night      Int
  content    Int      // task content version the log was recorded against
  chapter    Int      // reached, 0-based
  outcome    String   // won | lost
  lossReason String?
  secondsLeft Float
  kills      Int
  hash       String   // hashState of the replayed end state
  log        Bytes    // gzip of the NightLog JSON
  verified   Boolean  // the server's replay reached the claimed outcome
  createdAt  DateTime @default(now())
  @@index([accountId, createdAt])
  @@index([night, outcome, secondsLeft])
}
model LastSelf {          // where a district took this account, per chapter
  accountId String
  chapter   Int
  x         Float
  y         Float
  weapon    String?
  @@id([accountId, chapter])
}
```

**Auth.** `POST /auth/nonce {address}` returns a random nonce (stored 5 minutes). The client signs
`"Zombie Plague sign-in\nnonce: <nonce>"` with `personal_sign`. `POST /auth/verify {address,
signature}` checks it with viem `verifyMessage` (this handles smart-account signatures through
ERC-1271 and ERC-6492; thirdweb in-app wallets may be either, **VERIFY** by signing in once with
Google) and returns a 7-day JWT (`jose`, HS256, `sub` = account id). Inside MiniPay the same flow
runs with `window.ethereum`; there is no sign-in screen.

**Endpoints** (all JSON, validated with zod, JWT in `Authorization: Bearer`):

| Route | Does |
|---|---|
| `GET /health` | `{ok: true}` |
| `GET /night/today` | `{night, content}`: the day's shared seed (`fnv(UTC date)`) and content version |
| `GET /last-self?chapter=n` | The account's `Husk` for that chapter, or `null` |
| `POST /runs {result: RunResult}` | Verify (below), store, update `LastSelf`, return `{verified, hash}` |
| `GET /leaderboard?night=n` | Top 50 verified wins for that night, by `secondsLeft` |
| `GET /me` | Account, verified flag, best runs |

**Verifying a run** (`server/src/verify.ts`):

1. Reject if the gzip log exceeds 400 KB, if `log.chapters.length > 3`, or if any chapter's step
   count exceeds `ceil(timeLimit / STEP) + 1` (compute `timeLimit` from `generateLevel`).
2. Reject if `log.content` is not a version the server holds in `CONTENT_DIR`. Call `setContent`
   with that version's file before replaying.
3. Replace each chapter's `husk` with the server's own `LastSelf` for that account and chapter. The
   client's value is never trusted (a fabricated last-self could drop a weapon).
4. `replay(log)` in a worker thread with a 5 second limit. A throw or a timeout is `verified:
   false`.
5. Compare the end state's `phase`, `lossReason`, `chapter`, and `remaining` (within 1e-6) with the
   claim. Store `hashState`.
6. If the run ended `lost` with reason `caught` or `time`, upsert `LastSelf`; a later run that
   emits `husk-down` in that chapter deletes it (detect by re-running with an event tap, or add a
   `huskDown: boolean` field to `GameState` set in `killed()`; prefer the field).

**Client.** Implement the two seams, loaded as a separate chunk only when a session exists:
`src/seams/session.ts` gains `{kind: 'account'; address; token}`; `src/seams/progress.ts` gains
`httpProgress(baseUrl)`. `main.ts` keeps `lastSelf()` in localStorage for anonymous play and asks
the server when signed in. Sign-in itself (thirdweb v5 in-app wallet, Google or passkey) is a
lazily imported module behind a button on the title screen; in MiniPay
(`window.ethereum?.isMiniPay`) it is skipped and the provider is wrapped with
`EIP1193.fromProvider({ provider: window.ethereum })`.

**Accept.** Server tests: a recorded honest log verifies; the same log with one input changed does
not match its claim; an oversized log is rejected before replay; a log with a forged `husk` is
replayed with the server's value. `curl` transcript of nonce, verify, post run, leaderboard.

## 6. W2: the core for several players

**Decision: generalise the existing state, do not write a second simulation.** Single-player
becomes the one-player case of the same rules, so every existing test keeps guarding multiplayer.

### 6.1 State shape

Add to `types.ts`:

```ts
export interface Player {
  id: number;                 // seat, 0-based
  pos: Vec2; vel: Vec2; heading: number;
  health: number; invuln: number; slowT: number;
  vehicleId: number | null;
  arsenal: Arsenal;           // move the interface from state.ts to types.ts
  remaining: number;          // this player's infection clock
  timeLimit: number;
  light: boolean; coughT: number;
  hold: { taskId: TaskId | null; progress: number };
  work: Work | null;
  safeT: number;
  funds: number; kills: number;
  speedMul: number;
  inFallen: boolean;
  storeLatch: number | null;
  /** alive: playing. escaped: out through the exit. turned: now one of them, still playing. dead: out. */
  status: 'alive' | 'escaped' | 'turned' | 'dead';
  /** Checked by another player and found bitten past the threshold (others then see it). */
  exposed: boolean;
}
```

`GameState` gains `players: Player[]` and `mode: 'solo' | 'room'`. Do the migration in three
commits' worth of steps, running the whole test suite after each:

1. **Move, do not rename.** Put the per-player fields listed in section 2 on a `Player` object, and
   keep the old top-level names alive as getters and setters on the state that read and write
   `players[0]` (build the state with `Object.defineProperties` in `createGame`). All 135 tests
   must pass untouched. This proves the move is behaviour-neutral.
2. **Thread the player through.** Change every internal function that reads the player to take a
   `Player` argument (`movePlayer(s, pl, input, dt)`, `updateWeapons`, `interact`,
   `interactionFor(s, pl = s.players[0])`, `hurtPlayer`, `takePickups`, `inLight`, `sightScale`,
   `infection`, `buy`, `equip`, `solvePuzzle`, `updateCough`, ...). `step` becomes
   `step(s, inputs: Input | Input[], dt)`; a single `Input` means `[input]`.
3. **Remove the getters** once nothing in `src/` uses them; update tests to `g.players[0]`.

### 6.2 Rules that change with more than one player

| Rule | Solo (unchanged) | Room |
|---|---|---|
| Who a zombie hunts | The player | The nearest `alive` player it can sense, using that player's `sightScale`. Keep its target for 2 seconds before re-choosing |
| Flow field | One | One per alive player (`flows: Int16Array[]`), each redone when its player changes cell. Add a `Map<cell, Int16Array>` cache keyed by cell for the current step |
| Active radius | 60 units from the player | 60 units from any alive player |
| Director, spread, waves | Timed against the player's clock | Timed against `elapsed` and a room clock `roomLimit`; bursts target a random alive player |
| "Busy" grace (`isBusy`) | Zombies hold back while you work a step | Removed in rooms. Working a step in a room is done under threat |
| Story pauses | Client pauses | None. Lines are subtitles only |
| Escort steps | In the pool | Excluded: build the room's chain from groups with no `escort-start` |
| Objectives | Yours | Shared: a step done by anyone is done for all; each player still has to reach the exit |
| Clock at zero | You lose (`time`) | That player's `status` becomes `turned` |
| Health at zero | You lose (`caught`) | `status` becomes `turned` after 3 seconds lying still |
| Friendly fire | None | Bullets and melee hurt other `alive` players at 50% damage (`PVP_DAMAGE`), through `hurtPlayer` (gear absorbs first). Disabled within `SAFE_RADIUS = 12` of the exit and for the first 20 seconds |
| A turned player | n/a | Plays an infected: runner speed, 100 health, melee only (the zombie lunge, same wind-up and damage), sees all alive players within 30 units, zombies ignore them. Killed again, `status` is `dead` |
| Exit | Walk in when steps are done | Opens when the chain is done. Holds `EXIT_SEATS = max(1, ceil(n / 2))` where `n` is the starting player count. Each alive player who walks in escapes and takes a seat. When the seats are gone, or the room clock ends, the round ends |
| Hidden bites | NPC escorts | Players never receive another player's `remaining`. `CHECK` works on a player standing within 3 units for 2.5 seconds and sets their `exposed` if their infection is over 0.6 |
| Last self | From storage | None in rooms |

Round result: `placements: Array<{seat, status, escapedAt | null, kills}>`. Winners are the
escaped, ordered by `escapedAt`.

New constants go in `config.ts` under a `// ---- rooms` heading: `PVP_DAMAGE = 0.5`,
`SAFE_RADIUS = 12`, `PVP_GRACE = 20`, `EXIT_SEATS_SHARE = 0.5`, `ROOM_PLAYERS_MAX = 8`,
`TARGET_HOLD = 2`, `TURNED_HEALTH = 100`, `TURNED_SIGHT = 30`, `ROOM_SECONDS = 420`.

### 6.3 Room creation and views

```ts
createRoom(seed: number, players: number, opts?: { theme?: Theme }): GameState   // mode 'room'
```

Spawns are street points at least 40 units apart and at least 80 walking units from the exit.
Each player starts with the solo starting kit.

Add `src/core/view.ts`:

```ts
/** What one player is allowed to know this step. The only thing a server may send them. */
export function viewFor(s: GameState, seat: number): PlayerView
export interface PlayerView {
  you: Player;                       // full
  others: Array<{ id, pos, heading, weapon, status, light, exposed, vehicleId }>;  // no health, no clock
  zombies: Array<{ id, kind, pos, heading, action, actionT, staggerT, frozen }>;
  corpses, vehicles, pickups, crates, tasks, houses, fallen: ...   // as the solo client reads them
  events: GameEvent[];               // only those this player perceives
  roomRemaining: number; seatsLeft: number;
}
```

Visibility rule, applied to `others`, `zombies` and positional events: within 34 units **and**
(`lineClear` from the viewer **or** within 6 units), **or** inside the viewer's light cone
(`inLight`), **or** the event is a noise whose radius reaches the viewer (gunshot, scream, alarm,
cough: use the noise radius already in `config.ts`). A stalker outside the viewer's light and
further than 10 units is never sent. This is the fog-of-war that staked play depends on; test it.

**Accept.** New `tests/room.test.ts`:

- Two players, one zombie between them: it hunts the nearer; move the nearer away with its light
  off and it switches.
- A player whose clock ends becomes `turned`, can lunge, and zombies ignore it.
- Friendly fire does 50%, none inside the safe radius, none in the first 20 seconds.
- Four players: the exit holds two; the third to arrive does not escape; the round ends.
- `viewFor` never includes another player's `remaining` or `health` (assert by key), omits a
  zombie behind a wall at 20 units, includes a gunshot event from 25 units away out of sight.
- Determinism: the same seed and the same per-seat input script give the same `hashState` twice.
- The whole existing suite still passes; bot win counts are unchanged from before W2.

## 7. W3: real-time server and client

### 7.1 Server (`server/src/room/`)

- One Node process. A `Room` owns a `GameState`, a map of seat to socket, and an input queue per
  seat. Tick at **30 Hz** with `step(s, inputs, 1/30)` (the core is step-size independent; the
  tests already run it at 1/30). Use a drift-corrected `setTimeout` loop, not `setInterval`.
- Each tick: take the newest unprocessed input per seat (if none arrived, repeat the last movement
  with all edge buttons cleared), `quantize` it, step, then every second tick (15 Hz) send each seat
  `viewFor(s, seat)`.
- Record a `NightLog`-style log per room (inputs per seat per tick) so any round can be re-run in
  a dispute. Store it gzip-compressed beside the result.
- Lifecycle: `lobby` (2 to 8 seats, host starts, or auto-start 20 seconds after the fourth seat
  fills) then `playing` then `ended` (results held 60 seconds, then the room is destroyed).
  A socket that drops keeps its seat for 20 seconds (its player stands still), then the player's
  status becomes `dead`.
- Limits: 8 players per room, 40 rooms per process, 60 inputs per second per socket (drop the
  rest), 2 KB per client message.

### 7.2 Protocol (WebSocket at `/play`, JSON, one object per frame)

Client to server:

```ts
{ t: 'hello', token: string | null, name: string }        // null token: guest, free rooms only
{ t: 'create', verifiedOnly: boolean }                     // -> 'room'
{ t: 'join', code: string }                                // 5-letter room code
{ t: 'start' }                                             // host only
{ t: 'in', seq: number, i: [dx64, dy64, buttons] }         // dx, dy in 64ths; buttons as in replay.ts
{ t: 'cmd', c: Command }                                   // buy, equip (no solve, no grace in rooms)
{ t: 'leave' }
```

Server to client:

```ts
{ t: 'room', code, seats: Array<{ seat, name, verified, ready }>, you: seat, host: seat, state: 'lobby' | 'playing' | 'ended' }
{ t: 'begin', seed, players: n, content, tick: 0 }         // the client generates the same level from the seed
{ t: 'snap', tick, ack: seq, v: PlayerView }               // 15 Hz
{ t: 'end', placements, logId }
{ t: 'err', code: 'full' | 'no-room' | 'started' | 'verified-only' | 'rate' | 'bad' }
```

The map, tasks, stores and houses are never sent: `begin` carries the seed and the client calls
`generateLevel`. Snapshots carry only what changes.

**Bandwidth budget.** The VPS that hosts plague-celo has a 512 GB per month outbound cap. Measure
bytes per player-second in a 4-player room with 60 zombies near. If it is over **6 KB/s**, change
`snap` to a binary frame before going further: positions as `Int16` in 1/32 units, heading as
`Uint8`, one byte for kind and action, and send zombies as deltas from the last acknowledged
snapshot. Report the measured number either way.

### 7.3 Client (`src/net/`, all dynamically imported)

- `net/client.ts`: socket, reconnect with backoff (1, 2, 4, 8 seconds, then give up), sends `in`
  at 30 Hz from `controls.read()` through `quantize`.
- `net/predict.ts`: the local player only. Keep a ring of unacknowledged inputs. On each `snap`,
  set the local player to `v.you`, then re-apply the inputs after `ack` with the core's own
  `movePlayer` (export it). If the corrected position is within 0.3 units of the predicted one,
  ease to it over 100 ms instead of snapping.
- `net/interp.ts`: everything else is drawn 100 ms in the past, interpolated between the two
  snapshots that bracket that time (position linear, heading by shortest arc). An entity that
  appears in a snapshot fades in over 150 ms; one that vanishes is removed at once (it left sight).
- `net/shadow.ts`: builds a `GameState`-shaped object from the level (from the seed) plus the
  latest interpolated view, so `GameView.render(state, dt)`, `Hud.update`, `Sound.update` and the
  maps keep working unchanged. Fields the view does not carry are filled with harmless values.
- `render/view.ts`: draw `others` with `Actor` (the player's own class), a name above each, the
  light cone of those whose `light` is true (reuse the spot light pool, nearest two only), and a
  turned player with the husk's tint.
- UI (`ui/lobby.ts`, lazily loaded): title screen gets a `Multiplayer` button; a lobby page with
  create, join by code, the seat list, verified badges, start; an end page with placements.
- The talk panel is never opened in a room; `convo` lines are sent to `dialogue.say`.

**Accept.**

- A scripted test (`server/test/room.e2e.test.ts`) starts the server, connects three headless
  clients that walk seeded paths for 30 seconds, and asserts: all three receive `begin` with the
  same seed, every client's last `snap.v.you.pos` equals the server's position for that seat, no
  client ever received a zombie that `viewFor` would exclude for it.
- With 150 ms of injected latency and 2% packet delay jitter, the local player's correction is
  under 0.5 units for 95% of snapshots (log and report the distribution).
- Startup JS is still at or under 240 KB gzip; report the size of each new chunk.
- Bandwidth per player-second, measured and reported.

## 8. W4: the stake escrow contract

**Layout.** `contracts/` at the repo root: Foundry, `solc 0.8.28`, `evm_version = "cancun"`,
optimizer 200 runs, OpenZeppelin Contracts Upgradeable v5 (as a git submodule under
`contracts/lib`, pinned to a release tag).

**One contract, `StakeEscrow`, behind a UUPS proxy.** It holds stakes and pays out on a signed
result. It contains no game logic, so game changes never need an upgrade.

```solidity
// Roles: DEFAULT_ADMIN_ROLE (upgrade, set fee, set roles), OPERATOR_ROLE (open, start, settle,
// cancel), SIGNER_ROLE (its key signs results), PAUSER_ROLE.
struct Room { address token; uint96 stake; uint8 seats; uint8 joined; uint40 openedAt; uint40 startedAt; RoomState state; }
enum RoomState { None, Open, Started, Settled, Cancelled }

function openRoom(bytes32 roomId, address token, uint96 stake, uint8 seats) external;      // OPERATOR
function join(bytes32 roomId) external;                                                    // player; pulls `stake`
function leave(bytes32 roomId) external;                                                   // player; only while Open; refunds in full
function start(bytes32 roomId) external;                                                   // OPERATOR; needs joined >= 2
function settle(bytes32 roomId, address[] calldata winners, uint256[] calldata amounts, bytes calldata sig) external; // OPERATOR
function cancel(bytes32 roomId) external;                                                  // OPERATOR; credits every player their stake
function reclaim(bytes32 roomId) external;                                                 // player; if Started and not Settled after RECLAIM_AFTER
function withdraw(address token) external;                                                 // anyone; pays out their credited balance
```

Rules the code must enforce:

- `token` must be on an admin-managed allowlist. Start with USDm (cUSD) on Celo mainnet,
  `0x765DE816845861e75A25fCA122bb6898B8B1282a`, 18 decimals (from plague-celo's deployment notes).
- `stake` is bounded: `MIN_STAKE <= stake <= maxStake[token]` (admin-set; start at the equivalent
  of 2 USDm).
- `settle` verifies an EIP-712 signature by a `SIGNER_ROLE` address over
  `Result(bytes32 roomId, address[] winners, uint256[] amounts, bytes32 logHash)`, with the chain
  id and the proxy address in the domain. `logHash` is the keccak256 of the stored round log; emit
  it in the event so a round can be audited.
- Every winner must have joined that room. `sum(amounts) + fee == stake * joined`, where
  `fee = pot * feeBps / 10_000` and `feeBps <= 500`. The fee is credited to `feeRecipient`.
- If `winners` is empty (nobody escaped), every player is credited their full stake and no fee is
  taken.
- Payouts are **credited, then pulled** with `withdraw`. `settle` never transfers to players, so
  one reverting recipient cannot block a room.
- `reclaim` is the player's protection against a dead operator: `RECLAIM_AFTER = 24 hours` after
  `startedAt` with no settlement, any player can take their stake back.
- `ReentrancyGuard` on every function that moves tokens; `SafeERC20`; checks-effects-interactions.
- Storage: append-only layout, a `uint256[50] __gap`, no constructor logic (`_disableInitializers`
  in the constructor, `initialize(admin, feeRecipient)`).
- Keep the implementation well under 24,576 bytes; report the size.

Player-facing selectors are `join(bytes32)`, `leave(bytes32)`, `reclaim(bytes32)`,
`withdraw(address)` plus the token's `approve`. **These are the MiniPay allowlist surface. Do not
rename or re-type them after they are submitted.** (**VERIFY** the current allowlist process with
the owner; plague-celo went through it once.)

**Tests** (`contracts/test/StakeEscrow.t.sol`), at least these:

1. Happy path: open, three joins, start, settle with two winners, both withdraw; balances and fee
   exact to the wei.
2. A signature from a non-signer, a signature for a different room, a different chain id, and a
   replayed settle all revert.
3. A winner who never joined reverts. Amounts that do not sum reverts. `feeBps` over 500 cannot be
   set.
4. Nobody escaped: full refunds, zero fee.
5. `leave` while open refunds; `leave` after start reverts.
6. `reclaim` before 24 hours reverts; after, it pays once; then `settle` reverts.
7. A token that reverts on transfer to one recipient does not block the others (pull pattern).
8. Upgrade: deploy V1, join a room, upgrade to a V2 that adds a variable, the room is intact; a
   non-admin cannot upgrade.
9. Fuzz: for any stake and 2 to 8 players and any valid split, `sum(credits) == pot`.
10. Invariant: the contract's token balance always equals the sum of open stakes and unwithdrawn
    credits.

**Deploy.** Script `contracts/script/Deploy.s.sol`. Celo Sepolia (chain 11142220) first, verified
on Blockscout. Check the result with `cast code <address>`; plague-celo's `broadcast/` folder once
recorded a mainnet address with no bytecode, so never trust a broadcast file alone. Mainnet only
on the owner's explicit instruction, with `DEFAULT_ADMIN_ROLE` held by a multisig behind a
timelock (48 hours), not by a single key.

**Accept.** `forge test` output with all tests passing, `forge build --sizes` showing the size,
the Sepolia proxy and implementation addresses with verified links, and a `cast` transcript of one
full room on Sepolia.

## 9. W5: staked rooms

**Two gates. Do not start W5 until the owner confirms both.**

1. A legal view that real-money skill and PvP games may be offered where the owner intends to, and
   that it does not conflict with MiniPay's listing rules.
2. One account per person: staked rooms require `Account.verified`. Verification is a server-side
   read of GoodDollar's identity contract on Celo (`getWhitelistedRoot(address) != address(0)`;
   **VERIFY** the function name, the contract address and the SDK against GoodDollar's current
   documentation before writing code). Never accept a "verified" flag from the client.

**Flow.**

1. `POST /stake/rooms {stake, seats}` (verified accounts only): the server picks
   `roomId = keccak256(randomBytes(32))`, calls `openRoom`, waits for one confirmation, returns
   `{roomId, code}`.
2. The client approves the token and calls `join(roomId)` from the player's own wallet. In MiniPay
   pay fees in the stable token with `feeCurrency`; outside it the in-app wallet has no CELO, so
   staked rooms need sponsored gas (**decision for the owner**: thirdweb gas sponsorship, or
   MiniPay only at launch; default to MiniPay only).
3. The server watches `Joined` with viem and seats a socket only when the address in its JWT has a
   confirmed join for that room. Seating never trusts a client message.
4. When the seats are filled (or the host starts with at least two), the server calls `start`,
   waits one confirmation, then sends `begin`.
5. At `end` the server computes the split (below), signs the EIP-712 `Result` with the signer key,
   calls `settle`, and sends the transaction hash in `{t: 'end'}`.
6. A room that never starts is `cancel`led after 10 minutes.

**Split.** Pot minus fee, shared equally among the escaped. Nobody escaped: full refunds.
Disconnected players count as `dead`.

**Keys.** `OPERATOR` and `SIGNER` are two different keys in two different environment variables;
the operator pays gas in native CELO and holds nothing else. Add a balance check to `/health` that
reports when the operator has under 0.5 CELO. Every on-chain call is idempotent on `roomId` and
recorded in a `ChainTx` table (`roomId`, `kind`, `hash`, `status`) so a restart resumes instead of
repeating.

**Fair play in staked rooms** (already provided by W2 and W3; verify, do not rebuild):

- The server is authoritative and sends only `viewFor`. Confirm with a modified client that
  requests nothing extra can be learned: log every field received and diff it against `viewFor`.
- Aim assist runs on the server (`aimTarget`), so an aimbot gains nothing.
- The round log is stored and its hash is in the settlement event.
- Collusion (two accounts feeding one) is limited by one account per person and by the exit having
  fewer seats than players; it is not eliminated. Say so in the owner-facing notes.
- Rate limits: one staked room per account at a time; `maxStake` enforced on-chain.

**Accept.** On Celo Sepolia, with test tokens: three verified test accounts stake, play a scripted
round, two escape, `settle` lands, both withdraw the right amounts, the fee recipient has the fee;
a second round where nobody escapes refunds all three; a third where the server is killed after
`start` and each player recovers their stake with `reclaim` after the timeout (use `vm.warp` in a
fork test, since 24 hours cannot be waited out). Transaction hashes for each.

## 10. Hosting

- The game stays a static site (Vercel, `vercel.json`).
- The server is one Docker image configured only by environment variables, so it runs on the
  Lighthouse VPS (set `mem_limit` and `cpus`; it shares the box and its 512 GB monthly egress with
  plague-celo) or on Railway unchanged. Put it behind Caddy for TLS and WebSocket upgrade, as
  plague-celo's `deploy/` does.
- State that must survive a restart before W5 ships: accounts, runs, `ChainTx`, and for each
  started staked room enough to settle or cancel it. A room's live simulation may be lost; its
  players are protected by `cancel` and `reclaim`.

## 11. What to report at the end of each package

1. What was built, by file.
2. The acceptance checks, each with its evidence (test output, measured number, transaction hash).
3. Anything marked VERIFY that you confirmed, and how; anything you could not confirm.
4. Anything that differs from this plan, and why.
5. Bundle size, and the bot win counts if the core changed.
