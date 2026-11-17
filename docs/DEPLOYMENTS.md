# Deployments

## Where things live

| | Repository | Site (Vercel project) | Server |
|---|---|---|---|
| Zombie Plague (this repo) | `Plague-Protocol/zombie-plague` | `zplague.xyz`, `www.zplague.xyz`, `zplague.vercel.app` (project `zplague`) | `api.zplague.xyz` on the Lighthouse box (`/opt/outbreak`, see `deploy/lighthouse/`) |
| Deduce (was plague-celo) | `Plague-Protocol/deduce` (was `plague-evm`) | `deduce.zplague.xyz`, `deduce-zplague.vercel.app` (project `deduce`) | `deduce-api.zplague.xyz` on the same box (`/opt/plague`) |

The old names (`outbreak`, `plague-evm`, `outbreak-zplague.vercel.app`, `z-plague.vercel.app`) still redirect or still answer.

Testnet only. **Nothing is deployed to Celo mainnet.** Mainnet needs, first: the owner's legal view (PHASE2 section 9),
an admin that is a multisig behind a timelock (not a key), and a security review of `PlagueRooms`.

## Stake tokens: one contract per token

The contracts take one stake token each, so USDm and USDT each get their own deploy of the same script (with stake
limits in that token's units: USDm has 18 decimals, USDT 6). The server lists them in `STAKE_STACKS`
(`USDm=0x..,USDT=0x..`), the page in `VITE_STAKE_STACKS` (`USDm:rooms:token:18,USDT:rooms:token:6`). Room numbers are
per contract, so a room is "USDT #4". **Mainnet token addresses to verify before deploying:** USDm (formerly cUSD)
`0x765DE816845861e75A25fCA122bb6898B8B1282a`, USDT `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e`. USDT's issuer can
freeze an address; a payout to a frozen winner does not block the others (the contract records it as owed and the
winner can `claim` later).

## Celo Sepolia (chain 11142220), deployed 2026-11-17

Deployed with `contracts/script/Deploy.s.sol` and then read back from the chain (bytecode present, proxy points at the
implementation, both custody contracts are authorised for the proxy, limits and roles as set).

### The real stack (stake token: Celo Sepolia cUSD)

| | Address |
|---|---|
| PlagueRooms (proxy, the address to use) | `0x81567ba22c6903443c399217e57a3e4e9efdbb5d` |
| PlagueRooms implementation | `0x44ff5f387fd7cb4003f91e11d32302fdb476b5c2` |
| PotEscrow | `0x481908d4b16493897b95a979a4374095a4eef98a` |
| FeeManager | `0x2288dd8e0029862ec7c111814a791dc5a9e6c5fa` |
| Stake token (cUSD) | `0xae10a9e08d979e7d154d3b0212fb7cbf70fa6bb1` |
| Admin and backend (settle) key | `0xb895af9AA23451314601822B403E4e6f7456E950` (plague-celo's testnet key: one key for both is a testnet shortcut only) |

Stake limits 0.01 to 10 cUSD, fee 150 bps, reclaim after 6 h.

### The acceptance stack (a mintable test token, because cUSD cannot be minted)

| | Address |
|---|---|
| MockUSD | `0x6A7Fe8A1b3e7ae33AC0723e7EadaBd79Dc5230f8` |
| PlagueRooms (proxy) | `0xf0b8da4c2bccbde91066e03bee61235749ed09cc` |

### The 6-decimal acceptance stack (stands in for USDT, which has 6 decimals)

| | Address |
|---|---|
| MockUSD6 | `0x01DCDd8E10aBF34F04D740c45C41073D2Cc2e997` |
| PlagueRooms (proxy) | `0x3f757d78ef6e8602850eb09bbe6df873364447ea` |

Stake limits 0.01 to 10 (in 6-decimal units: 10,000 to 10,000,000).

Same contracts, same script. Used by `server/tools/sepolia-acceptance.mts` and `server/tools/sepolia-client-check.mts`.

### Acceptance evidence (staked rooms on a real chain, server code in the middle)

Three wallets stake 0.05 each through the contract; the server seats them from what the chain says (and refuses a
wallet that did not stake); the host starts the room on chain; the server plays the round and settles with the backend key.

| Case | Result | Settlement transaction |
|---|---|---|
| 2 of 3 escape | each winner received exactly 0.073875 (pot 0.15 less the 1.5% fee, 0.00225, split two ways); the other received nothing | `0x7de010a1403813fd58d48b359533b4b0e5655c0a44f54456333763076803bc49` |
| nobody escapes | all three refunded 0.05 in full, no fee | `0x9f13667e82338a345f418f53838a409dae1cceb24ce0237d4f967173067b4d6d` |

The same run on the 6-decimal stack (`SYM=USDT DEC=6`): each winner received exactly 73,875 units (pot 150,000 less the
2,250 fee, split two ways), tx `0x97aa7ff0cbcefc16636163cfd6b1db38a35306b8333708030f26240285240bfe`; nobody out refunded
50,000 each, tx `0x333d7e340719df7c9f28386ca02c2fc8e447adc5dac9b76f6aa669d11ae43d75`. The page's client check passed on it too.

`server/tools/sepolia-admin-check.mts` runs the admin page's wallet acts on the 6-decimal stack: pause, unpause, and
withdrawing all fees (2,250 units) to the admin wallet.

`sepolia-client-check.mts` runs the page's own staking code (`web/src/net/stake.ts`) with a stand-in wallet: it creates a room
(approve + createRoom), a second wallet joins from the room number (stake read from the chain), the server seats both, the
host starts it on chain and the server begins; leaving and cancelling a waiting room each return the whole stake.

**Not exercised on a live chain:** `reclaim` (the shortest reclaim window the contract allows is one hour; it is covered
by the Foundry tests and the 1,200-action campaign), the server being killed mid-round (covered by `server/test/staked.test.ts`
with a fake chain: a failed settlement is written down, retried after a restart and still paid once).

**A real-world note:** Celo's public RPC is a pool, and a read can come from a node a block behind. Both the server's seat
check and the page retry for a few seconds before giving up; do not remove that.
