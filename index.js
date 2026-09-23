// StonkFun scanner — volume range + rewards threshold + max holder count
// --------------------------------------------------------------------------
// A token qualifies when ALL of these are true:
//   - 24h volume is within [VOLUME_MIN_USD, VOLUME_MAX_USD]   (default $5,000–$10,000)
//   - pending ("to be distributed") rewards are >= REWARD_MIN_USD  (default $46)
//   - the token has at most MAX_HOLDERS on-chain holders        (default 3)
//
// Filters run in this order, cheapest first, so expensive calls only happen
// on tokens that already look promising:
//   1. Volume — read straight off the /tokens list (no extra API call)
//   2. Rewards — one StonkFun API call per surviving candidate
//   3. Holder count — one Solana RPC call per surviving candidate (priciest)
//
// Output: printed to stdout (Railway's log view is your "terminal"), and
// optionally pushed to a Telegram chat/channel for newly-qualifying tokens.
//
// IMPORTANT CAVEATS — read before trusting the numbers:
//
// 1. StonkFun's API doesn't document exact field names for "volume" or
//    "pending rewards". Both are auto-detected by scanning the response for
//    a key that looks right and holds a plausible number. Run once with
//    DEBUG=1 RUN_MODE=once and check the printed raw JSON + [funnel] line
//    against the site. Override with VOLUME_USD_PATH / REWARD_USD_PATH
//    (dot paths) if auto-detection ever picks the wrong field.
//
// 2. "Holder count" is derived from getTokenLargestAccounts, which returns
//    up to the 20 largest token ACCOUNTS for the mint (counting non-zero
//    balances). That's exact for tokens with a handful of holders (which is
//    what MAX_HOLDERS=3 is looking for) — if there are more than 20 holders
//    we just know it's "more than 3" and correctly excludes it, without
//    needing the precise total.
//
// 3. The public Solana RPC (api.mainnet-beta.solana.com) is shared and rate
//    limited. This script only calls it for tokens that already passed the
//    volume + rewards filters, so volume should be small — but if you see
//    repeated RPC 429s/timeouts, set SOLANA_RPC_URL to your own RPC (Helius,
//    QuickNode, Triton, etc.) for reliability.
// --------------------------------------------------------------------------

import { Connection, PublicKey } from '@solana/web3.js';

const API = 'https://www.stonkfun.xyz/api/public/v1';

const VOLUME_MIN_USD = Number(process.env.VOLUME_MIN_USD || 5000);
const VOLUME_MAX_USD = Number(process.env.VOLUME_MAX_USD || 10000);
const REWARD_MIN_USD = Number(process.env.REWARD_MIN_USD || 46);
const MAX_HOLDERS = Number(process.env.MAX_HOLDERS || 3);

const RUN_MODE = (process.env.RUN_MODE || 'loop').toLowerCase(); // 'loop' | 'once'
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 15 * 60 * 1000); // 15 min
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 250); // StonkFun API pacing
const RPC_REQUEST_DELAY_MS = Number(process.env.RPC_REQUEST_DELAY_MS || 500); // Solana RPC pacing
const DEBUG = process.env.DEBUG === '1';
const REWARD_USD_PATH = process.env.REWARD_USD_PATH || null; // e.g. "rewards.pending.usd"
const VOLUME_USD_PATH = process.env.VOLUME_USD_PATH || null; // e.g. "volume.usd" or "volume24h"
const MAX_PAGES = Number(process.env.MAX_PAGES || 500);

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------
// StonkFun API helpers
// --------------------------------------------------------------------------

const API_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 20_000);

async function apiGet(path, maxAttempts = 6) {
  const url = `${API}${path}`;
  let attempt = 0;
  while (true) {
    attempt++;
    let res;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
      res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
    } catch (err) {
      if (attempt >= maxAttempts) throw new Error(`GET ${path} failed: network error (${err.message})`);
      const backoff = Math.min(1000 * 2 ** attempt, 20_000);
      console.warn(`[retrying] ${path} — network error (${err.message}), attempt ${attempt}/${maxAttempts}, waiting ${Math.round(backoff / 1000)}s`);
      await sleep(backoff);
      continue;
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') || 5);
      console.warn(`[rate-limited] ${path} — waiting ${retryAfter}s`);
      await sleep(retryAfter * 1000);
      continue;
    }
    if (!res.ok) {
      let body;
      try { body = await res.json(); } catch { body = null; }
      const msg = body?.error?.message || res.statusText;
      const code = body?.error?.code || res.status;
      if (attempt < maxAttempts && res.status >= 500) {
        const backoff = Math.min(1000 * 2 ** attempt, 20_000);
        console.warn(`[retrying] ${path} (${code}: ${msg}), attempt ${attempt}/${maxAttempts}, waiting ${Math.round(backoff / 1000)}s`);
        await sleep(backoff);
        continue;
      }
      throw new Error(`GET ${path} failed: ${code} ${msg}`);
    }
    const body = await res.json();
    return body.data;
  }
}

async function getAllRewardTokens() {
  const pageSize = 100;
  let page = 1;
  let consecutiveFailedPages = 0;
  const all = [];
  const skippedPages = [];
  let lastPageReached = 0;

  while (page <= MAX_PAGES) {
    let data;
    try {
      data = await apiGet(`/tokens?mode=reward&pageSize=${pageSize}&page=${page}`);
    } catch (err) {
      consecutiveFailedPages++;
      skippedPages.push(page);
      console.warn(`[skip page] ${page}: ${err.message}`);
      if (consecutiveFailedPages >= 5) {
        console.warn(`[stop paging] 5 consecutive pages failed — using ${all.length} token(s) collected so far`);
        break;
      }
      page++;
      await sleep(REQUEST_DELAY_MS);
      continue;
    }
    consecutiveFailedPages = 0;
    lastPageReached = page;
    const tokens = data.tokens || data.items || data.results || [];
    all.push(...tokens);
    if (DEBUG) console.log(`[debug] page ${page}: ${tokens.length} tokens`);
    if (tokens.length < pageSize) break;
    page++;
    await sleep(REQUEST_DELAY_MS);
  }

  // Dedupe, just in case a retried page's tokens overlap with a prior page.
  const seenMints = new Set();
  const deduped = [];
  for (const t of all) {
    const mint = t.mint || t.address || t.mintAddress;
    const key = mint || JSON.stringify(t);
    if (seenMints.has(key)) continue;
    seenMints.add(key);
    deduped.push(t);
  }

  console.log(
    `[pagination summary] pages fetched=${lastPageReached} skipped=${skippedPages.length}` +
    (skippedPages.length ? ` (page numbers: ${skippedPages.join(', ')})` : '') +
    ` | tokens collected=${all.length} | unique after dedupe=${deduped.length}`
  );
  if (skippedPages.length > 0) {
    console.warn(
      `[warning] ${skippedPages.length} page(s) never loaded — this pass's token list is INCOMPLETE ` +
      `(missing up to ~${skippedPages.length * pageSize} tokens). Consider raising API_TIMEOUT_MS if this happens often.`
    );
  }

  return deduped;
}

// --------------------------------------------------------------------------
// Generic "find a USD-ish number under a key matching a pattern" extractor,
// used for both volume (off the token-list object) and pending rewards
// (off the /rewards payload).
// --------------------------------------------------------------------------

function getByPath(obj, path) {
  return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), obj);
}

function findUsdLeaf(node, seen) {
  if (node == null || typeof node !== 'object' || seen.has(node)) return null;
  seen.add(node);
  let best = null;
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'number' && /usd/i.test(k)) {
      best = best === null ? v : Math.max(best, v);
    } else if (v && typeof v === 'object') {
      const nested = findUsdLeaf(v, seen);
      if (nested !== null) best = best === null ? nested : Math.max(best, nested);
    }
  }
  return best;
}

function findValueByKeyPattern(payload, pattern) {
  let found = null;
  const seen = new Set();

  function walk(node) {
    if (node == null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const [key, value] of Object.entries(node)) {
      if (pattern.test(key)) {
        if (typeof value === 'number') {
          found = found === null ? value : Math.max(found, value);
        } else if (value && typeof value === 'object') {
          const usdLeaf = findUsdLeaf(value, seen);
          if (usdLeaf !== null) found = found === null ? usdLeaf : Math.max(found, usdLeaf);
        }
      }
      if (value && typeof value === 'object') walk(value);
    }
  }

  walk(payload);
  return found;
}

const PENDING_KEY_PATTERN = /pending|unclaimed|accrued|tobedistribut|todistribut|towaitdistribut|nextdistribut|awaiting|outstanding|distributable|undistribut|remaining|unpaid|queued|scheduled/i;
const VOLUME_KEY_PATTERN = /volume/i;

function findPendingUsd(rewardsPayload) {
  if (REWARD_USD_PATH) {
    const forced = getByPath(rewardsPayload, REWARD_USD_PATH);
    return typeof forced === 'number' ? forced : null;
  }
  return findValueByKeyPattern(rewardsPayload, PENDING_KEY_PATTERN);
}

function findVolumeUsd(tokenPayload) {
  if (VOLUME_USD_PATH) {
    const forced = getByPath(tokenPayload, VOLUME_USD_PATH);
    return typeof forced === 'number' ? forced : null;
  }
  return findValueByKeyPattern(tokenPayload, VOLUME_KEY_PATTERN);
}

// --------------------------------------------------------------------------
// Solana RPC: holder count (non-zero balances among the top 20 accounts)
// --------------------------------------------------------------------------

async function getHolderCount(mint, maxAttempts = 4) {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const mintPubkey = new PublicKey(mint);
      const largest = await connection.getTokenLargestAccounts(mintPubkey);
      const accounts = largest.value || [];
      const nonZero = accounts.filter((a) => Number(a.uiAmountString ?? a.uiAmount ?? 0) > 0);
      // If all 20 slots are non-zero, there may be more holders beyond what
      // this call can see — report null (unknown, but definitely > 20 > MAX_HOLDERS).
      if (accounts.length === 20 && nonZero.length === 20) return { count: null, atLeast: 20 };
      return { count: nonZero.length, atLeast: nonZero.length };
    } catch (err) {
      if (attempt >= maxAttempts) {
        console.warn(`[rpc-skip] ${mint}: ${err.message}`);
        return { count: null, atLeast: null };
      }
      const backoff = Math.min(1000 * 2 ** attempt, 15_000);
      console.warn(`[rpc-retry] ${mint} — ${err.message}, attempt ${attempt}/${maxAttempts}, waiting ${Math.round(backoff / 1000)}s`);
      await sleep(backoff);
    }
  }
}

// --------------------------------------------------------------------------
// Telegram
// --------------------------------------------------------------------------

async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[telegram] send failed: ${res.status} ${body}`);
  }
}

function formatUsd(n) {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// --------------------------------------------------------------------------
// One full scan pass
// --------------------------------------------------------------------------

const notifiedMints = new Set();

async function runScan() {
  const startedAt = new Date().toISOString();
  console.log(`\n=== StonkFun scan — ${startedAt} ===`);
  console.log(
    `Filters: volume ${formatUsd(VOLUME_MIN_USD)}\u2013${formatUsd(VOLUME_MAX_USD)} AND rewards >= ${formatUsd(REWARD_MIN_USD)} AND holders <= ${MAX_HOLDERS}`
  );

  const tokens = await getAllRewardTokens();
  console.log(`Found ${tokens.length} reward-mode token(s). Filtering by volume first (no extra calls needed)...`);

  // --- Stage 1: volume, straight off the list we already have ---------------
  const stats = {
    total: tokens.length,
    noVolumeField: 0,
    volumeOutOfRange: 0,
    volumeInRange: 0,
    rewardsFetchFailed: 0,
    standardMode: 0,
    nullRewards: 0,
    noPendingField: 0,
    rewardsBelowMin: 0,
    rewardsOk: 0,
  };

  let debugPrinted = 0;
  const debugSampleSize = DEBUG ? 5 : 0;

  const inVolumeRange = [];
  for (const token of tokens) {
    const mint = token.mint || token.address || token.mintAddress;
    if (!mint) continue;

    if (debugPrinted < debugSampleSize) {
      console.log(`[debug] raw token-list entry for ${token.symbol || mint}:`);
      console.log(JSON.stringify(token, null, 2));
      debugPrinted++;
    }

    const volumeUsd = findVolumeUsd(token);
    if (volumeUsd === null) {
      stats.noVolumeField++;
      continue;
    }
    if (volumeUsd < VOLUME_MIN_USD || volumeUsd > VOLUME_MAX_USD) {
      stats.volumeOutOfRange++;
      continue;
    }
    stats.volumeInRange++;
    inVolumeRange.push({ mint, symbol: token.symbol || token.ticker || '?', volumeUsd });
  }

  console.log(
    `[funnel:volume] total=${stats.total} noVolumeField=${stats.noVolumeField} outOfRange=${stats.volumeOutOfRange} inRange=${stats.volumeInRange}`
  );

  // --- Stage 2: pending rewards, only for volume-range survivors -----------
  console.log(`Checking pending rewards for ${inVolumeRange.length} candidate(s)...`);
  let rewardsDebugPrinted = 0;
  const rewardsOk = [];

  for (const t of inVolumeRange) {
    let rewardsData;
    try {
      rewardsData = await apiGet(`/tokens/${t.mint}/rewards`);
    } catch (err) {
      stats.rewardsFetchFailed++;
      console.warn(`[skip] ${t.mint}: ${err.message}`);
      await sleep(REQUEST_DELAY_MS);
      continue;
    }

    if (rewardsDebugPrinted < debugSampleSize) {
      console.log(`[debug] raw /rewards payload for ${t.symbol}:`);
      console.log(JSON.stringify(rewardsData, null, 2));
      rewardsDebugPrinted++;
    }

    if (rewardsData?.mode === 'standard') {
      stats.standardMode++;
      await sleep(REQUEST_DELAY_MS);
      continue;
    }
    if (rewardsData?.rewards == null) {
      stats.nullRewards++;
      await sleep(REQUEST_DELAY_MS);
      continue;
    }

    const pendingUsd = findPendingUsd(rewardsData);
    if (pendingUsd === null) {
      stats.noPendingField++;
    } else if (pendingUsd < REWARD_MIN_USD) {
      stats.rewardsBelowMin++;
    } else {
      stats.rewardsOk++;
      rewardsOk.push({ ...t, pendingUsd });
    }

    await sleep(REQUEST_DELAY_MS);
  }

  console.log(
    `[funnel:rewards] fetchFailed=${stats.rewardsFetchFailed} standardMode=${stats.standardMode} ` +
    `nullRewards=${stats.nullRewards} noPendingFieldFound=${stats.noPendingField} belowMin=${stats.rewardsBelowMin} ok=${stats.rewardsOk}`
  );

  // --- Stage 3: holder count via RPC, only for rewards survivors -----------
  console.log(`Checking holder count for ${rewardsOk.length} candidate(s) via Solana RPC...`);
  const qualifying = [];

  for (const t of rewardsOk) {
    const { count, atLeast } = await getHolderCount(t.mint);
    const holdersOk = count !== null && count <= MAX_HOLDERS;
    if (holdersOk) {
      qualifying.push({ ...t, holders: count });
    } else if (DEBUG) {
      console.log(`[debug] ${t.symbol} (${t.mint}) holders: ${count === null ? `>=${atLeast} (unknown exact)` : count} — excluded`);
    }
    await sleep(RPC_REQUEST_DELAY_MS);
  }

  qualifying.sort((a, b) => b.pendingUsd - a.pendingUsd);

  console.log(
    `\n[scan summary] tokens scanned=${stats.total} \u2192 volume match=${stats.volumeInRange} ` +
    `\u2192 rewards match=${stats.rewardsOk} \u2192 final match=${qualifying.length}`
  );

  console.log(`\n--- ${qualifying.length} token(s) matching all three filters ---`);
  if (qualifying.length === 0) {
    console.log('(none this pass)');
  } else {
    for (const t of qualifying) {
      console.log(
        `rewards ${formatUsd(t.pendingUsd).padEnd(12)} volume ${formatUsd(t.volumeUsd).padEnd(12)} holders ${String(t.holders).padStart(2)}  ${t.symbol.padEnd(10)} ${t.mint}`
      );
    }
  }

  const currentMints = new Set(qualifying.map((t) => t.mint));
  const fresh = qualifying.filter((t) => !notifiedMints.has(t.mint));

  if (fresh.length > 0 && TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    const lines = fresh.map(
      (t) =>
        `💰 <b>${t.symbol}</b> — rewards ${formatUsd(t.pendingUsd)}, volume ${formatUsd(t.volumeUsd)}, holders ${t.holders}\n<code>${t.mint}</code>`
    );
    await sendTelegramMessage(
      `<b>StonkFun match: volume ${formatUsd(VOLUME_MIN_USD)}\u2013${formatUsd(VOLUME_MAX_USD)}, rewards \u2265 ${formatUsd(REWARD_MIN_USD)}, holders \u2264 ${MAX_HOLDERS}</b>\n\n${lines.join('\n\n')}`
    );
    console.log(`[telegram] sent ${fresh.length} new token(s)`);
  }

  notifiedMints.clear();
  for (const m of currentMints) notifiedMints.add(m);

  return qualifying;
}

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------

async function main() {
  console.log('StonkFun scanner starting.');
  console.log(
    `Volume: ${formatUsd(VOLUME_MIN_USD)}\u2013${formatUsd(VOLUME_MAX_USD)} | Rewards: >= ${formatUsd(REWARD_MIN_USD)} | Max holders: ${MAX_HOLDERS} | ` +
    `Mode: ${RUN_MODE} | Telegram: ${TELEGRAM_BOT_TOKEN ? 'on' : 'off'} | RPC: ${SOLANA_RPC_URL}`
  );

  if (RUN_MODE === 'once') {
    await runScan();
    return;
  }

  while (true) {
    try {
      await runScan();
    } catch (err) {
      console.error('[scan error]', err);
    }
    console.log(`Sleeping ${Math.round(POLL_INTERVAL_MS / 1000)}s until next pass...`);
    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
