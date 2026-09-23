# StonkFun Scanner — volume + rewards + holder count

Scans every reward-mode token on [StonkFun](https://www.stonkfun.xyz) and lists the ones
where **all three** are true:

- 24h volume is between **$5,000 and $10,000**
- pending ("to be distributed") rewards are **$46+**
- the token has **at most 3 on-chain holders**

Runs forever in a loop and logs to the console; can optionally also post new hits to a
Telegram channel. Contract address (mint) is printed for every match.

## How it works (and why it's cheap to run)

1. **Volume** is read straight off `GET /tokens?mode=reward` — no extra calls, so this
   filter is free and eliminates most tokens immediately.
2. **Rewards** are checked via `GET /tokens/{mint}/rewards`, but only for tokens that
   already passed the volume filter.
3. **Holder count** is checked via Solana RPC (`getTokenLargestAccounts`), but only for
   tokens that passed both filters above — this is the most expensive/rate-limited step,
   so it only runs on a small shortlist.

## ⚠️ Two things to verify before you trust the numbers

**Field names.** StonkFun doesn't publish exact field names for "volume" or "pending
rewards" — this script auto-detects them by scanning the responses for keys that look
right. Before your first real run:

```bash
DEBUG=1 RUN_MODE=once node index.js
```

This prints raw JSON for the first few tokens/rewards responses, plus `[funnel:volume]`
and `[funnel:rewards]` summary lines showing exactly how many tokens got filtered out at
each stage and why. Check the numbers against stonkfun.xyz. If auto-detection ever picks
the wrong field, force it explicitly:

```bash
VOLUME_USD_PATH=volume.usd REWARD_USD_PATH=rewards.pending.usd node index.js
```

(replace with whatever dot-path the debug output shows).

**Holder count.** This uses `getTokenLargestAccounts`, which returns the 20 largest
token *accounts* by balance, not a full holder list. For a "3 or fewer holders" filter
this is exact — if 3 accounts hold everything, the rest are empty, and we can see that.
If a token turns out to have more holders than that, we just know it's "more than what
we checked" and correctly exclude it, without needing the precise total.

## Run locally

```bash
npm install
cp .env.example .env
# edit .env — a real Solana RPC URL is strongly recommended, see below
node index.js
```

## Deploy on Railway

1. Push this folder to a GitHub repo (or `railway up` from this directory with the
   [Railway CLI](https://docs.railway.com/guides/cli)).
2. In Railway: **New Project → Deploy from GitHub repo**. Railway auto-detects Node via
   Nixpacks — no Dockerfile needed.
3. Set environment variables under **Variables** (see `.env.example` for the full list).
4. Strongly recommended: set `SOLANA_RPC_URL` to your own RPC endpoint (Helius,
   QuickNode, Triton, etc. all have free tiers). The public
   `api.mainnet-beta.solana.com` endpoint is shared across everyone using it and gets
   rate-limited hard — fine for testing, not for a persistent 24/7 scanner.
5. Optional — Telegram: set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
6. Deploy. `RUN_MODE=loop` by default runs as a persistent worker, logging to
   **Deployments → view logs** — that's your "terminal".

## Config reference

| Variable              | Default   | Meaning                                                        |
| ---------------------- | --------- | ---------------------------------------------------------------- |
| `VOLUME_MIN_USD`       | `5000`    | Minimum 24h volume                                                |
| `VOLUME_MAX_USD`       | `10000`   | Maximum 24h volume                                                |
| `REWARD_MIN_USD`       | `46`      | Minimum pending rewards                                           |
| `MAX_HOLDERS`          | `3`       | Maximum on-chain holder count                                     |
| `RUN_MODE`             | `loop`    | `loop` = run forever, `once` = single pass then exit              |
| `POLL_INTERVAL_MS`     | `900000`  | Delay between passes in loop mode (15 min)                        |
| `REQUEST_DELAY_MS`     | `250`     | Delay between StonkFun API calls                                  |
| `RPC_REQUEST_DELAY_MS` | `500`     | Delay between Solana RPC calls                                    |
| `SOLANA_RPC_URL`       | public    | Your own RPC endpoint (recommended)                                |
| `DEBUG`                | `0`       | Set `1` to print raw JSON + funnel stats                          |
| `REWARD_USD_PATH`      | —         | Force an exact dot-path to the pending-rewards field               |
| `VOLUME_USD_PATH`      | —         | Force an exact dot-path to the volume field                        |
| `TELEGRAM_BOT_TOKEN`   | —         | Enables Telegram alerts when set alongside `TELEGRAM_CHAT_ID`      |
| `TELEGRAM_CHAT_ID`     | —         | Channel/user to post alerts to                                    |

## Notes

- Telegram only gets pinged for *newly*-qualifying tokens per pass, so a token that
  stays qualifying across multiple loop cycles won't spam the channel every 15 minutes —
  but if it drops out and later re-qualifies, it'll alert again.
- StonkFun's read endpoints allow 300 requests/min per IP; `REQUEST_DELAY_MS=250` keeps
  you safely under that even across hundreds of tokens.
