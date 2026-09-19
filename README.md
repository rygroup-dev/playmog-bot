# playmog-bot

Owner-only Telegram autopilot for **Maze of Gains** (playmog.xyz), the dungeon crawler in the Onchain Heroes universe on the **Abstract** chain.

The bot plays runs by itself, claims every free reward, runs a small market-making strategy on the in-game marketplace, and reports everything to a Telegram dashboard. Anything that spends money has a cap, and there is a one-tap kill-switch.

> **Unofficial.** This project is not affiliated with Onchain Heroes. Automating a game may break its terms of service. Use it at your own risk and only with funds you can afford to lose.

---

## Features

**Gameplay**
- Plays Expedition runs, World's Eve runs (Eve Keys → worldseeds → caches) and, optionally, Arcade runs. Every action goes over the game's authoritative realtime room, the same channel the official client uses.
- Reads each enemy's attack telegraph (charge → attack → rest) from server state and decides per turn whether to hit, dodge, or fight through. Spawners, ranged attackers and multi-enemy clusters have their own rules.
- Chooses goals with a value model measured from real runs: kills, pots and crates, energy orbs and treasure are each scored as value minus the energy cost of walking plus expected damage.
- Handles the Sir Jackalot bounty arena: 3×4 boss footprint, lane and slam telegraphs, the exit gate, and free movement inside the arena.
- Picks talents, uses items (shots, sticky bomb, magnet, midas, shock grenade and more), prays at shrines when the price is right, and buys from the armory when it pays off.
- Safety nets: an anti-loop blacklist, a no-progress watchdog, and it never burns energy standing still.

**Rewards and money**
- Automatically claims daily Expedition Pass keys, the weekly upvote reward, quests, the weekly prize-pool payout and jackpots.
- Moves VALOR to USDC.e automatically above a configurable reserve (initiate, then finalize after the 24 h delay).
- Buying Arcade keys is gated by expected value computed from the bot's *own* measured treasure per key, and capped per day.
- Expedition Pass purchase and renewal reminders.
- World's Eve loop: auto-buys up to N Eve Keys a day (capped price, never from market capital), redeems worldseeds into caches, and sells tradable cache loot on the marketplace. Keeps Eve Keys, Adventurer Mint Passes, and gas when you own a staked hero.
- Enters Golden Corn, Eve Key and Genesis Hero raffle tickets automatically shortly before each draw closes.
- Self-heals when the game ships a new client version (`CLIENT_OUTDATED`), and pauses the market cleanly while the game has it disabled.
- Game update watcher: checks the game's deploy every 5 minutes. On a new deploy it re-reads the live client, follows a new client version, diffs the enemy rules against what the AI uses (and switches to the new numbers), then sends a Telegram alert that lists exactly what changed. It also alerts when the game server is paused for maintenance.
- Incoming funds alert, plus an optional one-shot market top-up: `npx tsx scripts/fund-plan.ts 15 3000` deposits the next 15 USDC.e that arrives into VALOR and raises market capital to 3,000 VALOR.

**Marketplace**
- Market-making pilot: scores every tradable item by net edge after fees, daily volume, buyer count, volatility and price trend, then quotes the best ones (buy at best bid + 1, list at best ask − 1).
- Never sells below break-even except on stop-loss, never undercuts its own listing, and halts completely at a loss limit.
- Watches marketplace availability, with limit orders and instant buys tracked separately, and sends 🔴 closed and 🟢 open alerts. The instant-buy probe is a fill-or-kill order at 1 VALOR, so it can never fill or rest on the book. When instant buys are disabled, item purchases fall back to a limit order at the lowest ask.

**Telegram**
- Private: only configured owners can use the bot. Every spend needs an explicit confirm button, and quotes expire.
- Dashboard, Run, Wallet & Swap, Keys, Claims, Pass, Market, History, Leaderboard, Settings, and a kill-switch.
- Live pages refresh every 10 s, editing only when the data changed.
- Notifications for run results, buys and sells, claims, pass expiry and errors, plus a daily report.
- Relay-powered swap and bridge: ETH ↔ USDC.e on Abstract, and bridge-in from Arbitrum or Robinhood Chain.

The Telegram interface text is in **Bahasa Indonesia**.

---

## How it works

```
Telegram (grammY) ─┐
                   ├─ Autopilot (1-min tick) ──┬─ MoG HTTP API (SIWE session)
SQLite store ──────┘                           ├─ Game room (Colyseus) ── policy / value model
                                               ├─ Marketplace (order book)
                                               └─ Abstract chain (viem) + Relay (bridge/swap)
```

| Path | Purpose |
|---|---|
| `src/mog/api.ts` | SIWE login (EIP-4361) with a plain EOA, cookie session, retries and auto re-login |
| `src/game/room.ts` | Realtime room client: actions, acks, reconnects, state-delta merge |
| `src/game/policy.ts`, `model.ts`, `value.ts`, `items.ts` | Turn-by-turn decision making |
| `src/game/runner.ts` | Plays a run to completion and writes a per-turn JSONL log to `data/runs/` |
| `src/services/autopilot.ts` | Scheduler: claims, runs, Arcade gate, withdrawals, reminders, daily report |
| `src/services/market.ts` | Market-making with order tracking, stop-loss and loss limit |
| `src/services/watch.ts` | Game update watcher (deploy, client version, enemy rules) and funding watcher |
| `src/services/claims.ts` | Weekly and jackpot claims, VALOR deposit and withdraw, pass purchase |
| `src/chain/*` | Abstract, Arbitrum and Robinhood clients, contract calls, Relay bridge and swap |
| `src/telegram/*` | Bot UI, confirmations and live refresh |

---

## Requirements

- Node.js 22 or newer.
- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- A **dedicated** bot wallet. Do not reuse your main wallet.
- Funds on **Abstract**:
  - A little **ETH** for gas. About $3 covers many transactions.
  - **USDC.e** for Arcade keys, VALOR, passes or market capital.
  - You can also send ETH on Arbitrum or Robinhood Chain and bridge it from the bot.
- An **Expedition Pass**, which is needed to keep Expedition loot. The free Expedition keys come from the pass daily drip and the weekly upvote.

---

## Setup

```bash
git clone https://github.com/rygroup-dev/playmog-bot.git
cd playmog-bot
npm ci

# 1) create the bot wallet (prints only the address; key saved to secrets/wallet.json, mode 600)
npm run new-wallet

# 2) configure
cp .env.example .env
#    edit .env: TELEGRAM_BOT_TOKEN, and optionally TELEGRAM_OWNER_IDS
chmod 600 .env

# 3) build, test, run
npm run build
npm test
npm start
```

**Claiming the bot.** If `TELEGRAM_OWNER_IDS` is empty, send `/start` to your bot. It replies with your chat id. The service log prints a one-time code, and sending `/claim <code>` makes you the owner. After that, open **/menu**.

**First login.** The game requires a username once. Put one in `MOG_USERNAME` and the bot sets it on its first login.

**Run as a service.** See `deploy/playmog-bot.service`.

---

## Telegram commands

| Command | What it does |
|---|---|
| `/menu` | Main menu and status |
| `/dash` | Full dashboard: wallet, VALOR, pass, keys, weekly pool, EV, last 24 h |
| `/run` | Live run status; start or stop a run |
| `/wallet` | Balances on 3 chains, swap and bridge through Relay (quote, then confirm) |
| `/keys` | Arcade keys (buying needs confirmation) and live EV |
| `/claims` | Daily keys, upvote, quests, payouts, jackpot, withdraw VALOR |
| `/pass` | Expedition Pass status and renewal |
| `/market` | Market-making P&L, positions, orders, item scan |
| `/history` | Recent runs, transactions and system log |
| `/lb` | Leaderboards |
| `/settings` | Autopilot switches, Arcade cap, EV threshold, withdraw reserve |
| `/pause` | Kill-switch: pause or resume all automation |

---

## Configuration

Runtime settings live in SQLite and are changed from **⚙️ Settings**. The defaults:

| Setting | Default |
|---|---|
| Auto daily claim / upvote / Expedition | on |
| Auto Arcade | off; when on, capped at $5/day and gated by EV ≥ threshold |
| EV threshold | $1.00 back per $1 key, using the bot's own measured treasure per key |
| Auto VALOR withdraw | on, keeps 1,000 VALOR plus any market capital |
| Special rooms | shrine, armory, bounty arena |
| Market | off until funded and enabled from `/market` |

---

## Operations

- **Logs:** `journalctl -u playmog-bot -f`
- **Per-run logs:** `data/runs/<runId>.jsonl` (every turn: state summary, predicted danger, action, server events).
- **Energy accounting for a run:** `python3 scripts/analyze.py data/runs/<runId>.jsonl`
- **Health monitor** (samples every 2 min, then writes a report): `MON_MINUTES=60 npm run monitor`
- **Play one run in the foreground:** `npm run play -- EXPEDITION 999999 --create`

---

## Referral

When the bot buys an Expedition Pass, it passes a referral code to the game. By default this is the maintainer's code (`TMZA47S8`). The referrer earns a share of the pass price as VALOR, paid by the game at no extra cost to you. It is fully transparent and optional:

- Set `REFERRAL_CODE=` (empty) in `.env` to disable it, or put any other code there.
- The bot never refers itself, and never replaces a referrer the game already recorded for the account.
- Only the **first game account on a machine** is referred. A marker file in `~/.config/playmog-bot/` makes every other account on that machine skip the code, so one person running several accounts refers at most one of them.
- The code is checked with the game's own validation endpoint first. The referrer must hold an active pass for the code to be valid.

Your own code, and how many people used it, is shown in the **🎫 Pass** page.

---

## Security

- The wallet key never leaves `secrets/wallet.json`. The bot refuses to start if that file is readable by others.
- `.env`, `secrets/` and `data/` are git-ignored. Never commit them.
- Every on-chain call is simulated before it is sent, and the sender address is checked against the bot wallet.
- Every spend (keys, pass, swap, bridge, VALOR withdraw, market capital) needs an owner confirmation or a configured cap.

---

## Honest expectations

Paid Arcade runs pay back from a shared weekly pool, and on average that pool returns **less than you spend**. That is why Arcade is off by default and gated by the bot's own measured results. The realistic value comes from the free Expedition keys and the rewards the bot claims automatically. Market-making is experimental, so start small.
