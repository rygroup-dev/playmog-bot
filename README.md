# playmog-bot

Owner-only Telegram autopilot for **Maze of Gains** (playmog.xyz), the dungeon crawler in the Onchain Heroes universe on the **Abstract** chain.

The bot plays runs by itself, claims every free reward, runs a small market-making strategy on the in-game marketplace, and reports everything to a Telegram dashboard. Anything that spends money has a cap, and there is a one-tap kill-switch.

**Links**

| | |
|---|---|
| Play Maze of Gains | https://playmog.xyz |
| Onchain Heroes (the main game) | https://play.onchainheroes.xyz |
| Project site | https://onchainheroes.xyz |
| Docs and whitepaper | https://docs.onchainheroes.xyz |
| Abstract explorer (bot wallet, contracts) | https://abscan.org |
| Abstract portal / bridge | https://portal.abs.xyz |
| This bot | https://github.com/rygroup-dev/playmog-bot |

**Contracts this bot touches, on Abstract (chain 2741)**

| Contract | Address |
|---|---|
| USDC.e | `0x84a71ccd554cc1b02749b35d22f684cc8ec987e1` |
| Arcade key purchase | `0x3ef14148603202C0225eDFFcFdCcF3E68E5F5E03` |
| Claim vault (weekly pool, jackpot) | `0x40018Cbb1926dae72DCb315E89AAB7320A191D02` |
| VALOR vault (deposit, withdraw) | `0x2DDF2129a55cF132E580cc5d69faD1dE3d213BbA` |
| Upvote (weekly free keys) | `0x3B50dE27506f0a8C1f4122A1e6F470009a76ce2A` |

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
- Opens bounty chests. A chest arrives as a pickup that blocks a 3x3 area and takes three hits from beside it; in the bounty arena, opening it is what unlocks the exit gates.
- Reads the weather. Storm lightning marks six tiles one action ahead and is dodged; miasma, heatwave and blizzard each make an enemy hit cost more, so the bot picks its fights accordingly.
- Handles spike traps and arrow-trap lanes, remembers tiles the server refuses to walk onto, drops goals it never gets closer to, and uses the game's teleport when a floor leaves it no way forward.
- Self-heals when the game ships a new client version (`CLIENT_OUTDATED`), and pauses the market cleanly while the game has it disabled.
- Game update watcher: checks the game's deploy every 5 minutes. On a new deploy it re-reads the live client, follows a new client version, diffs the enemy rules against what the AI uses (and switches to the new numbers), then sends a Telegram alert that lists exactly what changed. It also alerts when the game server is paused for maintenance.
- Incoming funds alert, plus an optional one-shot market top-up: `npx tsx scripts/fund-plan.ts 15 3000` deposits the next 15 USDC.e that arrives into VALOR and raises market capital to 3,000 VALOR.

**Marketplace**
- Shows exactly what is listed for sale, at what price, with the net after fees, next to the open buy orders and the stock on hand.
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

### One-line install (Linux VPS, Linux desktop, macOS)

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/rygroup-dev/playmog-bot/main/install.sh)
```

It installs git, a compiler and Node 22 if they are missing (falling back to a per-user nvm install when
there is no root), clones the repo, installs the packages, then asks you for:

| Question | What it is |
|---|---|
| Telegram bot token | From [@BotFather](https://t.me/BotFather): `/newbot`, then copy the token |
| Telegram user id | Optional. Leave empty and claim the bot later with `/claim` |
| In-game username | Registered on the first login, 3–20 characters |
| Wallet: **create** or **import** | `create` generates a fresh wallet; `import` takes an existing private key (hidden input) |
| systemd service | Linux only: runs the bot on boot and restarts it on failure |

It writes `.env` and `secrets/wallet.json` with mode 600, builds, starts the service and prints the wallet
address to fund. Re-running it updates an existing install and never overwrites a wallet that is already there.

For an unattended install, set the answers as environment variables first:

```bash
TELEGRAM_BOT_TOKEN=123:ABC MOG_USERNAME=myname WALLET_MODE=create INSTALL_SERVICE=yes \
  bash <(curl -fsSL https://raw.githubusercontent.com/rygroup-dev/playmog-bot/main/install.sh)
```

`INSTALL_DIR`, `TELEGRAM_OWNER_IDS`, `WALLET_PRIVATE_KEY` and `REFERRAL_CODE` work the same way.

### Manual install

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
| `/dash` | Dashboard: wallet, pass, weekly pool, market P&L, World's Eve, last 24 h |
| `/run` | Live run status; start or stop a run |
| `/inv` | Inventory: worldseeds, keys, tickets, items, what is sellable and for how much |
| `/wallet` | Balances on three chains, swap, bridge, and USDC.e → VALOR deposits |
| `/keys` | Arcade keys and the live expected value per key |
| `/claims` | Daily keys, upvote, quests, payouts, jackpot, VALOR withdrawal |
| `/pass` | Expedition Pass status, renewal, referral code and stats |
| `/market` | Market-making: P&L, the items currently listed for sale, open buy orders, stock, item scan |
| `/gamble` | Every game of chance in MoG with its real odds, plus the betting switches |
| `/history` | Recent runs, transactions and system log |
| `/lb` | Leaderboards |
| `/settings` | Autopilot switches and caps |
| `/pause` | Kill-switch: pause or resume all automation |

Typed amounts, for when the preset buttons do not fit:

| Command | Meaning |
|---|---|
| `/swap eth 12` | Swap $12 worth of ETH into USDC.e on Abstract |
| `/swap usdc 7` | Swap $7 of USDC.e back into ETH |
| `/valor 12` | Deposit 12 USDC.e into the game as 1,200 VALOR (no fee) |
| `/withdraw 800` | Withdraw 800 VALOR to USDC.e (min 500, 5% fee, 24 h delay) |

---

## Settings

Runtime settings live in SQLite and are changed from **⚙️ Settings** (or **🎲 Judi & Gacha** for the betting switches). Nothing here needs a redeploy. Every setting and its default:

### Free value (safe to leave on)

| Setting | Default | What it does |
|---|---|---|
| Auto daily claim | on | Claims the Expedition Pass daily keys |
| Auto upvote | on | Claims the weekly upvote reward (3/5/8 keys by pass tier); costs a little gas |
| Auto Expedition | on | Plays every Expedition key as it arrives |
| Expedition reserve keys | 0 | Keeps this many keys unplayed, e.g. if you want to play some yourself |
| Play owned Arcade keys | on | Plays Arcade keys you already own (from caches or gifts). Never buys them |
| Notify every run | on | A Telegram message per finished run. Turn off for quiet operation |
| Special rooms | shrine, armory, bounty arena | Which optional rooms the bot enters. It always passes through any room when it is the only way down |

### Spending (read before turning on)

| Setting | Default | What it does |
|---|---|---|
| Auto Arcade | off | Buys Arcade keys at 1 USDC.e each. Only fires when the measured EV clears the threshold below |
| Arcade daily cap | $5 | Hard ceiling on Arcade spending per 24 h |
| Arcade keys per run | 1 | Keys spent per Arcade run |
| EV threshold | $1.00 | Minimum expected return per $1 key, computed from **your own** treasure per key, not from top players |
| Auto World's Eve | off | Buys Eve Keys on the marketplace and plays World's Eve runs |
| World's Eve buys per day | 3 | Hard ceiling on Eve Key purchases per UTC day |
| Eve Key max price | 250 VALOR | Never pays more than this for a key |
| World's Eve USDC.e reserve | $3 | When VALOR is reserved for market capital, Eve Keys are paid from wallet USDC.e, but never below this reserve |

### Loot and rewards

| Setting | Default | What it does |
|---|---|---|
| Redeem caches | on | Turns 500 worldseeds into a World's Eve Cache, **opens it**, and opens any skin boxes |
| Sell loot | on | Lists tradable loot at best ask − 1, repricing every 2 h. Keeps Expedition Keys, Adventurer Mint Passes, Golden Corn, Eve Keys (while World's Eve is on) and gas when you own a staked hero |
| Auto VALOR withdraw | on | Moves VALOR above the reserve to USDC.e (initiate, then finalize after 24 h) |
| Withdraw reserve | 1,000 VALOR | Kept in-game for the next pass. Market capital is always excluded on top of this |

Raffles need no setting: Golden Corn, Eve Key and Genesis Hero tickets are entered automatically about three hours before each draw closes.

### Betting (off by default, and it should stay off)

Every game of chance in MoG pays back less than it takes. The numbers come from the game client itself:

| Game | Rules | Average return |
|---|---|---|
| Ringjak Derby (in-run room) | 4 runners, equal chance; 1st pays 3×, 2nd returns 0.5×; stake up to 10% of treasure | **87.5%** |
| Portal Gambit (in-run room) | Five rows, one wrong portal per row; clear all five to triple the stake | below 100% |
| Ringjak Racing (lobby, VALOR) | 10–100 VALOR in steps of 5; 1st pays 3×, 2nd returns 0.8× | **95%** (disabled server-side: `lobbyDerby=false`) |
| Fortune's Gambit / Treasure Map (Emporium) | Wager worldseeds, double or nothing | disabled server-side for everyone (`fortunesGambit`, `treasureMap`, `emporium` are all false) |

Only the two in-run rooms are live today. The bot places the bet, plays the room (one portal per row in Portal Gambit), and reports the stake, the balance change and the server's raw outcome. Lobby Ringjak Racing is implemented behind a Telegram button and will work the moment the game re-enables it.

| Setting | Default | What it does |
|---|---|---|
| Bet in Ringjak Derby | off | When off, the bot enters the room, stakes **0**, and walks on |
| Bet in Portal Gambit | off | Same, with a zero stake |
| Stake size | 5% | Share of treasure (or worldseeds in World's Eve) to stake when betting is on, capped at the game's own 10% limit |
| Max bets per day | 3 | Hard ceiling. Once it is used up the bot walks through gambling rooms with a zero stake |

Every bet and every result is written to the ledger and sent to Telegram: the stake, the balance change, and the raw outcome the server returned. The **🎲 Judi & Gacha** page shows today's count, the remaining budget, and the last results.

### Market-making

Changed from **📈 Market** with the ± buttons (capital, item count, units per item, loss limit). Off until you fund it and switch it on.

| Setting | Default | What it does |
|---|---|---|
| Capital | 1,500 VALOR | Ceiling on VALOR tied up in buy orders and stock |
| Max assets | 2 | How many items to quote at once |
| Units per asset | 1 | Position size |
| Min edge | 20 VALOR / 5% | Minimum profit after the 1% listing and 4% success fees before quoting |
| Stop-loss | 10% | Sells a position that has dropped this far |
| Loss limit | 300 VALOR | Halts market-making entirely and cancels buy orders |
| Auto-select | on | Rescores every tradable item every 30 min and rotates to the best ones |

The market also parks an item for three hours when another bot keeps outbidding it, and moves that capital to the next-best item.

---

## Operations

- **Logs:** `journalctl -u playmog-bot -f`
- **Per-run logs:** `data/runs/<runId>.jsonl` (every turn: state summary, predicted danger, action, server events).
- **Energy accounting for a run:** `python3 scripts/analyze.py data/runs/<runId>.jsonl`
- **Health monitor** (samples every 2 min, then writes a report): `MON_MINUTES=60 npm run monitor`
- **Play one run in the foreground:** `npm run play -- EXPEDITION 999999 --create`

---

## Referral

When the bot buys an Expedition Pass it passes a referral code to the game. By default this is the project's own code, which is defined in `src/services/referral.ts`. The referrer earns a share of the pass price as VALOR; it costs you nothing extra.

- `REFERRAL_CODE=none` in `.env` turns it off. Any other value uses that code instead; empty or unset keeps the default.
- The bot never refers itself and never replaces a referrer the game already recorded.
- Only the first game account on a machine is referred, so running several accounts refers at most one.

Your own code and its stats are on the **🎫 Pass** page.

---

## Security

- The wallet key never leaves `secrets/wallet.json`. The bot refuses to start if that file is readable by others.
- `.env`, `secrets/` and `data/` are git-ignored. Never commit them.
- Every on-chain call is simulated before it is sent, and the sender address is checked against the bot wallet.
- Every spend (keys, pass, swap, bridge, VALOR withdraw, market capital) needs an owner confirmation or a configured cap.

---

## Honest expectations

Paid Arcade runs pay back from a shared weekly pool, and on average that pool returns **less than you spend**. That is why Arcade is off by default and gated by the bot's own measured results. The realistic value comes from the free Expedition keys and the rewards the bot claims automatically. Market-making is experimental, so start small.
