#!/usr/bin/env bash
# playmog-bot installer — Linux (VPS or desktop) and macOS.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/rygroup-dev/playmog-bot/main/install.sh)
#
# It installs the dependencies, clones the repo, asks for your Telegram bot token, creates or imports
# the bot wallet, writes .env, builds, and (on Linux with systemd + root) installs a service.
#
# Non-interactive use (CI, re-installs): set any of these before running and the matching prompt is skipped:
#   TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_IDS, MOG_USERNAME, WALLET_MODE=create|import, WALLET_PRIVATE_KEY,
#   INSTALL_DIR, INSTALL_SERVICE=yes|no, REFERRAL_CODE
set -euo pipefail

REPO="${REPO:-https://github.com/rygroup-dev/playmog-bot.git}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/playmog-bot}"
NODE_MIN=22

c_ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
c_warn() { printf '\033[33m%s\033[0m\n' "$*"; }
c_err()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
step()   { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die()    { c_err "$*"; exit 1; }

# write prompts to the terminal when there is one, otherwise to stdout (so CI and `| bash` both work)
TTY=/dev/tty
{ : > /dev/tty; } 2>/dev/null || TTY=/dev/stdout

# prompts read the terminal directly, so `curl ... | bash` still works
ask() { # ask VAR "question" [default]  — a third argument (even "") makes the answer optional
  local __var=$1 __q=$2 __def=${3:-} __optional=$# __ans=""
  if [ -n "${!__var:-}" ]; then return 0; fi
  if [ "$TTY" = /dev/stdout ]; then
    [ "$__optional" -ge 3 ] || die "$__q — no terminal here, so set $__var before running."
    printf -v "$__var" '%s' "$__def"; return 0
  fi
  printf '%s%s: ' "$__q" "${__def:+ [$__def]}" > "$TTY"
  IFS= read -r __ans < /dev/tty || true
  printf -v "$__var" '%s' "${__ans:-$__def}"
}
ask_secret() { # ask_secret VAR "question"
  local __var=$1 __q=$2 __ans=""
  if [ -n "${!__var:-}" ]; then return 0; fi
  [ "$TTY" = /dev/stdout ] && die "$__q — no terminal here, so set $__var before running."
  printf '%s: ' "$__q" > "$TTY"
  stty -echo < /dev/tty; IFS= read -r __ans < /dev/tty || true; stty echo < /dev/tty; printf '\n' > "$TTY"
  printf -v "$__var" '%s' "$__ans"
}

step "Checking the system"
OS="$(uname -s)"
SUDO=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"
case "$OS" in
  Linux)
    if   command -v apt-get >/dev/null 2>&1; then PM=apt
    elif command -v dnf     >/dev/null 2>&1; then PM=dnf
    elif command -v apk     >/dev/null 2>&1; then PM=apk
    else PM=none; fi ;;
  Darwin) PM=brew ;;
  *) die "Unsupported OS: $OS (Linux or macOS only)" ;;
esac
c_ok "OS $OS, package manager: $PM"

step "Installing dependencies (git, curl, build tools)"
missing=""
for bin in git curl; do command -v "$bin" >/dev/null 2>&1 || missing="$missing $bin"; done
command -v cc >/dev/null 2>&1 || command -v gcc >/dev/null 2>&1 || missing="$missing toolchain"
if [ -z "$missing" ]; then
  c_ok "git, curl and a compiler are already installed"
else
  c_warn "Missing:$missing — installing"
  set +e
  case "$PM" in
    apt) $SUDO apt-get update -qq; $SUDO apt-get install -y -qq git curl ca-certificates python3 build-essential >/dev/null 2>&1 ;;
    dnf) $SUDO dnf install -y -q git curl ca-certificates python3 gcc-c++ make >/dev/null 2>&1 ;;
    apk) $SUDO apk add --no-cache git curl ca-certificates python3 build-base >/dev/null 2>&1 ;;
    brew)
      command -v brew >/dev/null 2>&1 || die "Homebrew is required on macOS: https://brew.sh"
      brew list git >/dev/null 2>&1 || brew install git >/dev/null 2>&1 ;;
    none) c_warn "Unknown package manager — install git, curl and a C++ toolchain yourself." ;;
  esac
  set -e
  for bin in git curl; do command -v "$bin" >/dev/null 2>&1 || die "$bin is still missing — install it and run this again."; done
  c_ok "Dependencies ready"
fi

step "Checking Node.js (needs >= $NODE_MIN)"
node_major() { command -v node >/dev/null 2>&1 && node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt "$NODE_MIN" ]; then
  c_warn "Node $(node -v 2>/dev/null || echo 'not installed') is too old — installing Node 22"
  case "$PM" in
    apt|dnf|apk)
      if [ -n "$SUDO" ] || [ "$(id -u)" -eq 0 ]; then
        curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash - >/dev/null 2>&1 && $SUDO apt-get install -y -qq nodejs >/dev/null 2>&1 || true
      fi ;;
    brew) brew install node@22 >/dev/null && brew link --overwrite --force node@22 >/dev/null || true ;;
  esac
  if [ "$(node_major)" -lt "$NODE_MIN" ]; then   # fall back to nvm, no root needed
    c_warn "Falling back to nvm (per-user Node install)"
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash >/dev/null
    . "$NVM_DIR/nvm.sh"; nvm install 22 >/dev/null; nvm use 22 >/dev/null
  fi
fi
[ "$(node_major)" -ge "$NODE_MIN" ] || die "Could not install Node >= $NODE_MIN. Install it manually and re-run."
c_ok "Node $(node -v), npm $(npm -v)"

step "Fetching the bot into $INSTALL_DIR"
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" pull --ff-only >/dev/null && c_ok "Updated an existing checkout"
else
  git clone -q "$REPO" "$INSTALL_DIR" && c_ok "Cloned $REPO"
fi
cd "$INSTALL_DIR"

step "Installing npm packages (this takes a minute)"
npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null
c_ok "Packages installed"

step "Telegram"
cat > "$TTY" <<'TXT'
  Open @BotFather in Telegram -> /newbot -> copy the token it gives you.
  The bot is private: only the Telegram accounts you list may control it.
TXT
ask TELEGRAM_BOT_TOKEN "  Telegram bot token"
[[ "$TELEGRAM_BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]] || die "That does not look like a BotFather token."
ask TELEGRAM_OWNER_IDS "  Your Telegram user id (empty = claim later with /claim)" ""
ask MOG_USERNAME "  In-game username to register on first login (3-20 chars)" ""

step "Bot wallet"
WALLET_PATH_REL="secrets/wallet.json"
if [ -f "$WALLET_PATH_REL" ]; then
  c_warn "A wallet already exists at $WALLET_PATH_REL — keeping it."
else
  cat > "$TTY" <<'TXT'
  Use a DEDICATED wallet, never your main one.
    create  - generate a fresh wallet here (recommended)
    import  - paste an existing private key (0x + 64 hex)
TXT
  ask WALLET_MODE "  create or import" "create"
  mkdir -p secrets && chmod 700 secrets
  case "$WALLET_MODE" in
    create)
      WALLET_PATH="$WALLET_PATH_REL" node --input-type=module -e '
        import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
        import { writeFileSync } from "node:fs";
        const privateKey = generatePrivateKey();
        const { address } = privateKeyToAccount(privateKey);
        writeFileSync(process.env.WALLET_PATH, JSON.stringify({ address, privateKey, createdAt: new Date().toISOString() }), { mode: 0o600 });
        console.log(address);
      ' > .wallet.addr ;;
    import)
      ask_secret WALLET_PRIVATE_KEY "  Private key (hidden, 0x + 64 hex)"
      [[ "$WALLET_PRIVATE_KEY" =~ ^0x[0-9a-fA-F]{64}$ ]] || die "Private key must be 0x followed by 64 hex characters."
      WALLET_PATH="$WALLET_PATH_REL" PK="$WALLET_PRIVATE_KEY" node --input-type=module -e '
        import { privateKeyToAccount } from "viem/accounts";
        import { writeFileSync } from "node:fs";
        const privateKey = process.env.PK;
        const { address } = privateKeyToAccount(privateKey);
        writeFileSync(process.env.WALLET_PATH, JSON.stringify({ address, privateKey, importedAt: new Date().toISOString() }), { mode: 0o600 });
        console.log(address);
      ' > .wallet.addr
      unset WALLET_PRIVATE_KEY PK ;;
    *) die "Answer 'create' or 'import'." ;;
  esac
  chmod 600 "$WALLET_PATH_REL"
fi
WALLET_ADDRESS="$(node -p "JSON.parse(require('fs').readFileSync('$WALLET_PATH_REL','utf8')).address")"
rm -f .wallet.addr
c_ok "Wallet: $WALLET_ADDRESS"

step "Writing .env"
if [ -f .env ]; then
  cp .env ".env.backup.$(date +%s)"
  c_warn "Existing .env backed up"
fi
cat > .env <<ENV
TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
TELEGRAM_OWNER_IDS=$TELEGRAM_OWNER_IDS
WALLET_PATH=$WALLET_PATH_REL
DB_PATH=data/bot.db
MOG_USERNAME=$MOG_USERNAME
REFERRAL_CODE=${REFERRAL_CODE:-}
MOG_APP_VERSION=24
LOG_LEVEL=info
ENV
chmod 600 .env
c_ok ".env written (mode 600)"

step "Building"
npm run build >/dev/null
c_ok "Build OK"

step "Service"
INSTALL_SERVICE="${INSTALL_SERVICE:-}"
if [ "$OS" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
  [ -z "$INSTALL_SERVICE" ] && ask INSTALL_SERVICE "  Install a systemd service so it runs on boot? (yes/no)" "yes"
else
  INSTALL_SERVICE="no"
fi
if [ "$INSTALL_SERVICE" = "yes" ]; then
  UNIT=/etc/systemd/system/playmog-bot.service
  $SUDO tee "$UNIT" >/dev/null <<UNITFILE
[Unit]
Description=Maze of Gains Telegram autopilot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$INSTALL_DIR
ExecStart=$(command -v node) $INSTALL_DIR/dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
UMask=0077

[Install]
WantedBy=multi-user.target
UNITFILE
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now playmog-bot >/dev/null 2>&1 || $SUDO systemctl restart playmog-bot
  sleep 3
  if systemctl is-active --quiet playmog-bot; then c_ok "Service running: systemctl status playmog-bot"
  else c_warn "Service did not start — check: journalctl -u playmog-bot -n 50"; fi
else
  c_ok "Skipped the service. Start it yourself with:  cd $INSTALL_DIR && npm start"
fi

cat > "$TTY" <<TXT

$(c_ok "Done.")

  Folder        $INSTALL_DIR
  Wallet        $WALLET_ADDRESS
  Logs          $([ "$INSTALL_SERVICE" = yes ] && echo "journalctl -u playmog-bot -f" || echo "npm start")

  Next:
  1. Fund the wallet on the Abstract chain:
       ~\$3 of ETH for gas, plus USDC.e for keys, the pass or market capital.
       Bridge from Arbitrum or Robinhood Chain inside the bot (menu: Wallet & Swap).
  2. Open your bot in Telegram and send /start$([ -z "$TELEGRAM_OWNER_IDS" ] && echo ", then /claim CODE with the code from the log")
  3. Send /menu, then go to Settings and turn on what you want.
       Everything that spends money is off or capped by default.

TXT
