
/*
============================================================
 GMGN 4H SECOND CANDLE SNIPER V1
============================================================
 INDEPENDENT / READ ONLY
 Does NOT modify the main Radar.
 Does NOT modify radar-history.json.
 Does NOT modify UI / login / port.

 Listing:
   creation_timestamp || open_timestamp

 Candle 1:
   listing + 0h -> +4h

 Candle 2:
   listing + 4h -> +8h

 Signal:
   evaluated at/after +8h

 Outcomes:
   +5 / +10 / +20 / +50 / +100 %
   measured after Candle 2

 Data:
   GMGN market trending snapshots
============================================================
*/

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = __dirname;

const DATA_FILE =
    path.join(ROOT, "4h-second-candle-sniper-history-v1.json");

const REPORT_FILE =
    path.join(ROOT, "4h-second-candle-sniper-report-v1.json");

const LOG_FILE =
    path.join(ROOT, "4h-second-candle-sniper.log");

const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
const RATE_LIMIT_STATE_FILE = path.join(ROOT, '4h-second-candle-sniper-rate-limit-v1.json');
const RATE_LIMIT_SAFETY_MS = 90 * 1000;
const COMMAND_TIMEOUT_MS = 30000;

const CANDLE1_START_H = 0;
const CANDLE1_END_H = 4;

const CANDLE2_START_H = 4;
const CANDLE2_END_H = 8;

const OUTCOME_END_H = 32;

const TARGETS = [5, 10, 20, 50, 100];

const MIN_SNAPSHOTS_PER_CANDLE = 3;

const MAX_STORED_AGE_H = 40;

function log(...args) {
    const line =
        new Date().toISOString() +
        " " +
        args.map(String).join(" ");

    console.log(line);

    try {
        fs.appendFileSync(LOG_FILE, line + "\n");
    } catch (_) {}
}

function loadJson(file, fallback) {
    try {
        if (!fs.existsSync(file)) {
            return fallback;
        }

        return JSON.parse(
            fs.readFileSync(file, "utf8")
        );
    } catch (e) {
        log("JSON LOAD ERROR", file, e.message);
        return fallback;
    }
}

function saveJson(file, data) {
    const tmp = file + ".tmp";

    fs.writeFileSync(
        tmp,
        JSON.stringify(data, null, 2),
        "utf8"
    );

    fs.renameSync(tmp, file);
}

async function syncSupabase(db, now) {
    const base = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
    const key = process.env.SUPABASE_SECRET_KEY || "";
    if (!base || !key) {
        log("SUPABASE SKIP", "missing server environment variables");
        return;
    }

    const tokens = Object.values(db.tokens || {}).filter(token => token && (token.address || token.mint || token.tokenAddress));
    const batchSize = 20;
    for (let i = 0; i < tokens.length; i += batchSize) {
        const rows = tokens.slice(i, i + batchSize).map(token => ({
            address: String(token.address || token.mint || token.tokenAddress).trim(),
            token_data: token,
            updated_at: new Date(now * 1000).toISOString()
        }));

        const response = await fetch(base + "/rest/v1/sniper_history?on_conflict=address", {
            method: "POST",
            headers: {
                "apikey": key,
                "Authorization": "Bearer " + key,
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates,return=minimal"
            },
            body: JSON.stringify(rows),
            signal: AbortSignal.timeout(30000)
        });

        if (!response.ok) {
            const detail = (await response.text()).slice(0, 500);
            throw new Error("HTTP " + response.status + ": " + detail);
        }
    }
    log("SUPABASE SYNC OK", "tokens=" + tokens.length);
}
function emptyDatabase() {
    return {
        version: "1.0",
        createdAt: Math.floor(Date.now() / 1000),
        tokens: {}
    };
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function pct(a, b) {
    if (!Number.isFinite(a) ||
        !Number.isFinite(b) ||
        a === 0) {
        return 0;
    }

    return ((b - a) / a) * 100;
}

function ratio(a, b) {
    if (b <= 0) {
        return a > 0 ? a : 0;
    }

    return a / b;
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function getListingTimestamp(coin) {
    const creation = num(coin.creation_timestamp);
    const open = num(coin.open_timestamp);

    return creation > 0
        ? creation
        : open > 0
            ? open
            : 0;
}

function normalizeCoin(coin, now) {
    const listingTime =
        getListingTimestamp(coin);

    if (!coin || !coin.address) {
        return null;
    }

    if (listingTime <= 0) {
        return null;
    }

    return {
        time: now,

        price: num(coin.price),

        market_cap:
            num(coin.market_cap),

        volume:
            num(coin.volume),

        liquidity:
            num(coin.liquidity),

        holders:
            num(coin.holder_count),

        buys:
            num(coin.buys),

        sells:
            num(coin.sells),

        price_change_percent1m:
            num(coin.price_change_percent1m),

        price_change_percent5m:
            num(coin.price_change_percent5m)
    };
}

function ensureDatabase(db) {
    if (!db || typeof db !== "object") {
        return emptyDatabase();
    }

    if (!db.tokens ||
        typeof db.tokens !== "object") {
        db.tokens = {};
    }

    return db;
}

function getAgeHours(token, now) {
    return (now - token.listingTime) / 3600;
}

function addSnapshot(db, coin, now) {
    const listingTime =
        getListingTimestamp(coin);

    if (listingTime <= 0) {
        return false;
    }

    const ageH =
        (now - listingTime) / 3600;

    /*
      We intentionally ignore old tokens.
      Sniper keeps enough history for the full 32h outcome window.
    */
    if (ageH < -0.25 || ageH > MAX_STORED_AGE_H) {
        return false;
    }

    const address = coin.address;

    if (!db.tokens[address]) {
        db.tokens[address] = {
            address,

            symbol:
                coin.symbol ||
                coin.name ||
                "-",

            listingTime,

            creation_timestamp:
                num(coin.creation_timestamp),

            open_timestamp:
                num(coin.open_timestamp),

            firstCapturedAt: now,

            snapshots: [],

            signal: null,

            liveSecondCandleSignal: null,

            outcomes: null
        };

        log(
            "NEW TOKEN",
            address,
            "symbol=" + db.tokens[address].symbol,
            "listing=" +
                new Date(listingTime * 1000).toISOString()
        );
    }

    const token =
        db.tokens[address];

    /*
      If GMGN later exposes a better listing timestamp,
      do not move it backwards/forwards casually.
      First valid timestamp remains canonical.
    */

    if (!token.listingTime) {
        token.listingTime = listingTime;
    }

    const snapshot =
        normalizeCoin(coin, now);

    if (!snapshot) {
        return false;
    }

    /*
      Avoid duplicate snapshots from repeated polling.
    */
    const last =
        token.snapshots[
            token.snapshots.length - 1
        ];

    if (last &&
        Math.abs(last.time - now) < 20) {
        return false;
    }

    token.snapshots.push(snapshot);

    /*
      Keep enough history for the complete 32h outcome.
      This is deliberately NOT the main Radar's 100-snapshot limit.
    */
    if (token.snapshots.length > 2000) {
        token.snapshots =
            token.snapshots.slice(-2000);
    }

    return true;
}

function snapshotsInWindow(token, startH, endH) {
    return token.snapshots.filter(s => {
        const age =
            (s.time - token.listingTime) / 3600;

        return age >= startH &&
               age < endH;
    });
}

function firstLast(arr) {
    if (!arr.length) {
        return {
            first: null,
            last: null
        };
    }

    return {
        first: arr[0],
        last: arr[arr.length - 1]
    };
}

function candleStats(token, startH, endH) {
    const arr =
        snapshotsInWindow(
            token,
            startH,
            endH
        );

    if (arr.length < MIN_SNAPSHOTS_PER_CANDLE) {
        return null;
    }

    const fl = firstLast(arr);

    const first = fl.first;
    const last = fl.last;

    const prices =
        arr
            .map(x => x.price)
            .filter(x => x > 0);

    if (!prices.length) {
        return null;
    }

    const open = first.price;
    const close = last.price;

    const high =
        Math.max(...prices);

    const low =
        Math.min(...prices);

    const rangePct =
        low > 0
            ? ((high - low) / low) * 100
            : 0;

    const bodyPct =
        open > 0
            ? ((close - open) / open) * 100
            : 0;

    const upperWickPct =
        open > 0
            ? ((high - Math.max(open, close)) / open) * 100
            : 0;

    const lowerWickPct =
        open > 0
            ? ((Math.min(open, close) - low) / open) * 100
            : 0;

    const avgVolume =
        arr.reduce(
            (sum, x) => sum + x.volume,
            0
        ) / arr.length;

    const avgLiquidity =
        arr.reduce(
            (sum, x) => sum + x.liquidity,
            0
        ) / arr.length;

    const avgHolders =
        arr.reduce(
            (sum, x) => sum + x.holders,
            0
        ) / arr.length;

    const avgBuys =
        arr.reduce(
            (sum, x) => sum + x.buys,
            0
        ) / arr.length;

    const avgSells =
        arr.reduce(
            (sum, x) => sum + x.sells,
            0
        ) / arr.length;

    const buySellRatio =
        avgSells > 0
            ? avgBuys / avgSells
            : avgBuys > 0
                ? avgBuys
                : 0;

    return {
        startH,
        endH,

        snapshots:
            arr.length,

        open,
        high,
        low,
        close,

        bodyPct,
        rangePct,
        upperWickPct,
        lowerWickPct,

        volumeFirst:
            first.volume,

        volumeLast:
            last.volume,

        volumeChangePct:
            pct(
                first.volume,
                last.volume
            ),

        avgVolume,

        liquidityFirst:
            first.liquidity,

        liquidityLast:
            last.liquidity,

        liquidityChangePct:
            pct(
                first.liquidity,
                last.liquidity
            ),

        holdersFirst:
            first.holders,

        holdersLast:
            last.holders,

        holdersChangePct:
            pct(
                first.holders,
                last.holders
            ),

        buysFirst:
            first.buys,

        buysLast:
            last.buys,

        sellsFirst:
            first.sells,

        sellsLast:
            last.sells,

        avgBuys,
        avgSells,

        buySellRatio,

        mcFirst:
            first.market_cap,

        mcLast:
            last.market_cap,

        mcChangePct:
            pct(
                first.market_cap,
                last.market_cap
            )
    };
}

function classifyPattern(c1, c2) {
    const patterns = [];

    if (!c1 || !c2) {
        return patterns;
    }

    /*
      1. Volume expansion
    */
    if (
        c2.avgVolume >
        c1.avgVolume * 1.5
    ) {
        patterns.push(
            "VOLUME_EXPANSION"
        );
    }

    /*
      2. Liquidity expansion
    */
    if (
        c2.liquidityChangePct >= 10
    ) {
        patterns.push(
            "LIQUIDITY_GROWTH"
        );
    }

    /*
      3. Holder acceleration
    */
    if (
        c2.holdersChangePct >
        c1.holdersChangePct + 5
    ) {
        patterns.push(
            "HOLDER_ACCELERATION"
        );
    }

    /*
      4. Buy pressure
    */
    if (
        c2.buySellRatio >= 1.5 &&
        c2.buySellRatio >
        c1.buySellRatio * 1.15
    ) {
        patterns.push(
            "BUY_PRESSURE_EXPANSION"
        );
    }

    /*
      5. Flat price + rising activity
    */
    if (
        Math.abs(c2.bodyPct) <= 12 &&
        c2.avgVolume >
        c1.avgVolume * 1.5 &&
        c2.liquidityChangePct >= 5
    ) {
        patterns.push(
            "FLAT_PRICE_ACTIVITY_EXPANSION"
        );
    }

    /*
      6. Accumulation style
    */
    if (
        c2.holdersChangePct >= 5 &&
        c2.liquidityChangePct >= 5 &&
        c2.buySellRatio >= 1.25
    ) {
        patterns.push(
            "ACCUMULATION_EXPANSION"
        );
    }

    /*
      7. Price / volume divergence
    */
    if (
        Math.abs(c2.bodyPct) <= 10 &&
        c2.avgVolume >
        c1.avgVolume * 1.75
    ) {
        patterns.push(
            "PRICE_VOLUME_DIVERGENCE"
        );
    }

    /*
      8. Strong second-candle momentum
    */
    if (
        c2.bodyPct >= 15 &&
        c2.buySellRatio >= 1.25
    ) {
        patterns.push(
            "SECOND_CANDLE_MOMENTUM"
        );
    }

    /*
      9. Multi-factor expansion
    */
    let factors = 0;

    if (
        c2.avgVolume >
        c1.avgVolume * 1.5
    ) factors++;

    if (
        c2.liquidityChangePct >= 5
    ) factors++;

    if (
        c2.holdersChangePct >= 5
    ) factors++;

    if (
        c2.buySellRatio >= 1.25
    ) factors++;

    if (
        c2.bodyPct >= 5
    ) factors++;

    if (factors >= 4) {
        patterns.push(
            "MULTI_FACTOR_EXPANSION"
        );
    }

    return patterns;
}

function calculateMfeMae(
    token,
    entryPrice,
    fromH,
    toH
) {
    if (entryPrice <= 0) {
        return {
            mfePct: 0,
            maePct: 0,
            maxPrice: 0,
            minPrice: 0
        };
    }

    const arr =
        snapshotsInWindow(
            token,
            fromH,
            toH
        );

    if (!arr.length) {
        return {
            mfePct: 0,
            maePct: 0,
            maxPrice: 0,
            minPrice: 0
        };
    }

    let maxPrice = 0;
    let minPrice = 0;

    for (const s of arr) {
        if (s.price <= 0) {
            continue;
        }

        if (!maxPrice ||
            s.price > maxPrice) {
            maxPrice = s.price;
        }

        if (!minPrice ||
            s.price < minPrice) {
            minPrice = s.price;
        }
    }

    return {
        mfePct:
            maxPrice > 0
                ? ((maxPrice - entryPrice) /
                    entryPrice) * 100
                : 0,

        maePct:
            minPrice > 0
                ? ((minPrice - entryPrice) /
                    entryPrice) * 100
                : 0,

        maxPrice,
        minPrice
    };
}

function calculateOutcomes(token, signal) {
    if (!signal ||
        !signal.entryPrice ||
        signal.entryPrice <= 0) {
        return null;
    }

    const signalH = 8;

    const available =
        snapshotsInWindow(
            token,
            signalH,
            OUTCOME_END_H
        );

    if (!available.length) {
        return null;
    }

    const result = {
        entryPrice:
            signal.entryPrice,

        signalTime:
            signal.signalTime,

        targets: {},

        mfeMae:
            calculateMfeMae(
                token,
                signal.entryPrice,
                signalH,
                OUTCOME_END_H
            )
    };

    for (const target of TARGETS) {
        const targetPrice =
            signal.entryPrice *
            (1 + target / 100);

        let hit = null;

        for (const s of available) {
            if (
                s.price >= targetPrice
            ) {
                hit = {
                    hit: true,

                    time:
                        s.time,

                    timeToTargetMinutes:
                        (s.time -
                            signal.signalTime) / 60,

                    price:
                        s.price
                };

                break;
            }
        }

        result.targets[
            "+" + target
        ] = hit || {
            hit: false,

            timeToTargetMinutes:
                null,

            price:
                available[
                    available.length - 1
                ].price
        };
    }

    return result;
}

function evaluateToken(token, now) {
    const ageH =
        getAgeHours(token, now);

    /*
      LIVE SECOND-CANDLE SNIPER
      Active only during token age 4h -> 8h.

      Signal conditions:
      1) We have at least two snapshots.
      2) Holders increased versus the previous snapshot.
      3) Buy pressure is positive (buys > sells).

      No arbitrary volume/liquidity threshold is used.
    */
    if (ageH >= CANDLE2_START_H && ageH < CANDLE2_END_H) {

        const snaps = token.snapshots || [];

        if (snaps.length >= 2) {

            const current =
                snaps[snaps.length - 1];

            const previous =
                snaps[snaps.length - 2];

            const holderDelta =
                num(current.holders) -
                num(previous.holders);

            const buySellDelta =
                num(current.buys) -
                num(current.sells);

            const holderIncrease =
                holderDelta > 0;

            const positiveFlow =
                buySellDelta > 0;

            if (
                holderIncrease &&
                positiveFlow &&
                num(current.price) > 0
            ) {

                token.liveSecondCandleSignal = {
                    createdAt: now,

                    signalTime: now,

                    signalAgeHours: ageH,

                    price:
                        num(current.price),

                    market_cap:
                        num(current.market_cap),

                    holders:
                        num(current.holders),

                    previousHolders:
                        num(previous.holders),

                    holderDelta,

                    volume:
                        num(current.volume),

                    previousVolume:
                        num(previous.volume),

                    volumeDelta:
                        num(current.volume) -
                        num(previous.volume),

                    liquidity:
                        num(current.liquidity),

                    previousLiquidity:
                        num(previous.liquidity),

                    liquidityDelta:
                        num(current.liquidity) -
                        num(previous.liquidity),

                    buys:
                        num(current.buys),

                    sells:
                        num(current.sells),

                    buySellDelta,

                    priceChange1m:
                        num(current.price_change_percent1m),

                    priceChange5m:
                        num(current.price_change_percent5m)
                };

                log(
                    "LIVE 4H SIGNAL",
                    token.address,
                    "holders+=" + holderDelta,
                    "buys-sells=" + buySellDelta,
                    "age=" + ageH.toFixed(2) + "h"
                );
            }
        }
    }

    /*
      Once Candle 2 ends, the live signal is no longer active.
      Keep historical outcome analysis untouched.
    */
    // Keep the live signal in history after Candle 2 ends.
    // The API will decide whether it is still a valid live Candle-2 signal.

    /*
      Original historical 32h outcome engine.
      This remains intentionally unchanged in behavior.
    */
    if (
        ageH >= CANDLE2_END_H &&
        !token.signal
    ) {

        const c1 =
            candleStats(
                token,
                CANDLE1_START_H,
                CANDLE1_END_H
            );

        const c2 =
            candleStats(
                token,
                CANDLE2_START_H,
                CANDLE2_END_H
            );

        if (c1 && c2) {

            const patterns =
                classifyPattern(
                    c1,
                    c2
                );

            const entry =
                c2.close;

            if (entry > 0) {

                token.signal = {
                    createdAt: now,

                    signalTime:
                        token.listingTime +
                        CANDLE2_END_H * 3600,

                    signalAgeHours:
                        CANDLE2_END_H,

                    entryPrice:
                        entry,

                    entryMarketCap:
                        c2.mcLast,

                    candle1: c1,

                    candle2: c2,

                    patterns
                };

                log(
                    "SNIPER SIGNAL",
                    token.address,
                    "patterns=" +
                        patterns.join(",")
                );
            }
        }
    }

    /*
      Original outcome analysis remains intact.
    */
    if (
        token.signal &&
        ageH >= OUTCOME_END_H &&
        !token.outcomes
    ) {

        token.outcomes =
            calculateOutcomes(
                token,
                token.signal
            );

        if (token.outcomes) {
            log(
                "OUTCOME COMPLETE",
                token.address
            );
        }
    }
}

function buildReport(db) {
    const tokens =
        Object.values(db.tokens);

    const signals =
        tokens.filter(
            t => t.signal
        );

    const completed =
        signals.filter(
            t => t.outcomes
        );

    const patternStats = {};

    for (const token of completed) {
        const patterns =
            token.signal.patterns || [];

        for (const pattern of patterns) {
            if (!patternStats[pattern]) {
                patternStats[pattern] = {
                    pattern,

                    signals: 0,

                    completed: 0,

                    hit5: 0,
                    hit10: 0,
                    hit20: 0,
                    hit50: 0,
                    hit100: 0,

                    mfeSum: 0,
                    maeSum: 0,

                    time5Sum: 0,
                    time10Sum: 0,
                    time20Sum: 0,
                    time50Sum: 0,
                    time100Sum: 0
                };
            }

            const p =
                patternStats[pattern];

            p.signals++;
            p.completed++;

            const out =
                token.outcomes;

            for (const n of TARGETS) {
                const key = "+" + n;
                const x = out.targets[key];

                if (x && x.hit) {
                    p[
                        "hit" +
                        n
                    ]++;

                    p[
                        "time" +
                        n +
                        "Sum"
                    ] +=
                        num(
                            x.timeToTargetMinutes
                        );
                }
            }

            p.mfeSum +=
                num(
                    out.mfeMae.mfePct
                );

            p.maeSum +=
                num(
                    out.mfeMae.maePct
                );
        }
    }

    for (const key of Object.keys(patternStats)) {
        const p = patternStats[key];

        if (p.completed > 0) {
            p.hitRate5 =
                p.hit5 /
                p.completed;

            p.hitRate10 =
                p.hit10 /
                p.completed;

            p.hitRate20 =
                p.hit20 /
                p.completed;

            p.hitRate50 =
                p.hit50 /
                p.completed;

            p.hitRate100 =
                p.hit100 /
                p.completed;

            p.avgMFE =
                p.mfeSum /
                p.completed;

            p.avgMAE =
                p.maeSum /
                p.completed;

            p.avgTimeTo5 =
                p.hit5 > 0
                    ? p.time5Sum /
                        p.hit5
                    : null;

            p.avgTimeTo10 =
                p.hit10 > 0
                    ? p.time10Sum /
                        p.hit10
                    : null;

            p.avgTimeTo20 =
                p.hit20 > 0
                    ? p.time20Sum /
                        p.hit20
                    : null;

            p.avgTimeTo50 =
                p.hit50 > 0
                    ? p.time50Sum /
                        p.hit50
                    : null;

            p.avgTimeTo100 =
                p.hit100 > 0
                    ? p.time100Sum /
                        p.hit100
                    : null;
        }
    }

    return {
        version: "1.0",

        generatedAt:
            new Date().toISOString(),

        totalTokens:
            tokens.length,

        totalSignals:
            signals.length,

        completedSignals:
            completed.length,

        patternStats
    };
}

function getRateLimitUntil() {
    try {
        if (!fs.existsSync(RATE_LIMIT_STATE_FILE)) return 0;
        const x = JSON.parse(fs.readFileSync(RATE_LIMIT_STATE_FILE, 'utf8'));
        return Number(x.cooldownUntil || 0);
    } catch (_) { return 0; }
}

function setRateLimitUntil(until, reason) {
    try {
        fs.writeFileSync(RATE_LIMIT_STATE_FILE, JSON.stringify({ cooldownUntil: until, reason: reason || '429', updatedAt: new Date().toISOString() }, null, 2));
    } catch (_) {}
}

function parseRateLimitReset(text) {
    const m = String(text || '').match(/Rate limit resets at ([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}) GMT([+-][0-9]{2}:[0-9]{2})/i);
    if (!m) return 0;
    const t = Date.parse(m[1].replace(' ', 'T') + m[2]);
    return Number.isFinite(t) ? t + RATE_LIMIT_SAFETY_MS : 0;
}

function fetchGMGN(callback) {
    const cachePath = require('path').join(ROOT, '4h-gmgn-rank-cache.json');
    const CACHE_MAX_AGE_MS = 3 * 60 * 1000;

    try {
        if (!require('fs').existsSync(cachePath)) {
            log('GMGN SHARED CACHE NOT FOUND â€” waiting for Main Radar');
            callback(new Error('GMGN_SHARED_CACHE_NOT_FOUND'));
            return;
        }

        const raw = require('fs').readFileSync(cachePath, 'utf8');
        const parsed = JSON.parse(raw);
        const updatedAt = Number(parsed && parsed.updatedAt || 0);
        const rank = parsed && Array.isArray(parsed.rank) ? parsed.rank : [];

        if (!updatedAt || (Date.now() - updatedAt) > CACHE_MAX_AGE_MS) {
            log(
                'GMGN SHARED CACHE STALE',
                'age=' + Math.max(0, Math.floor((Date.now() - updatedAt) / 1000)) + 's'
            );
            callback(new Error('GMGN_SHARED_CACHE_STALE'));
            return;
        }

        log('GMGN SHARED CACHE OK', 'rank=' + rank.length);
        callback(null, rank);

    } catch (e) {
        log('GMGN SHARED CACHE READ ERROR', e.message);
        callback(new Error('GMGN_SHARED_CACHE_READ_ERROR: ' + e.message));
    }
}
function cleanup(db, now) {
    const cutoff =
        now -
        MAX_STORED_AGE_H * 3600;

    for (const address of Object.keys(db.tokens)) {
        const token =
            db.tokens[address];

        /*
          Keep completed tokens for report,
          but remove very old unfinished captures.
        */
        if (
            token.listingTime &&
            token.listingTime < cutoff &&
            !token.outcomes
        ) {
            delete db.tokens[address];
        }
    }
}

function runCycle() {
    const now =
        Math.floor(Date.now() / 1000);

    log("SNAPSHOT START");

    fetchGMGN(
        (error, coins) => {
            if (error) {
                log(
                    "GMGN ERROR",
                    error.message
                );

                return;
            }

            const db =
                ensureDatabase(
                    loadJson(
                        DATA_FILE,
                        emptyDatabase()
                    )
                );

            let saved = 0;

            for (const coin of coins) {
                try {
                    if (
                        addSnapshot(
                            db,
                            coin,
                            now
                        )
                    ) {
                        saved++;
                    }
                } catch (e) {
                    log(
                        "TOKEN ERROR",
                        coin.address ||
                            "-",
                        e.message
                    );
                }
            }

            for (const token of Object.values(db.tokens)) {
                try {
                    evaluateToken(
                        token,
                        now
                    );
                } catch (e) {
                    log(
                        "EVALUATE ERROR",
                        token.address,
                        e.message
                    );
                }
            }

            cleanup(
                db,
                now
            );

            saveJson(
                DATA_FILE,
                db
            );

            const report =
                buildReport(db);

            saveJson(
                REPORT_FILE,
                report
            );

            syncSupabase(db, now).catch(e => log("SUPABASE SYNC ERROR", e.message, e.cause ? String(e.cause) : "", e.stack ? e.stack.split("\n").slice(0,3).join(" | ") : ""));

            log(
                "SNAPSHOT END",
                "GMGN=" + coins.length,
                "saved=" + saved,
                "tokens=" +
                    Object.keys(db.tokens).length,
                "signals=" +
                    report.totalSignals,
                "completed=" +
                    report.completedSignals
            );
        }
    );
}

function printSummary() {
    const db =
        ensureDatabase(
            loadJson(
                DATA_FILE,
                emptyDatabase()
            )
        );

    const report =
        buildReport(db);

    console.log("");
    console.log(
        "============================================================"
    );
    console.log(
        " GMGN 4H SECOND CANDLE SNIPER V1"
    );
    console.log(
        "============================================================"
    );

    console.log(
        "TOKENS:",
        report.totalTokens
    );

    console.log(
        "SIGNALS:",
        report.totalSignals
    );

    console.log(
        "COMPLETED:",
        report.completedSignals
    );

    console.log(
        "------------------------------------------------------------"
    );

    const stats =
        Object.values(
            report.patternStats
        )
        .sort(
            (a, b) =>
                b.completed -
                a.completed
        );

    for (const p of stats) {
        console.log(
            p.pattern +
            " | N=" +
            p.completed +
            " | +20=" +
            (p.hitRate20 * 100).toFixed(1) +
            "% | +50=" +
            (p.hitRate50 * 100).toFixed(1) +
            "% | +100=" +
            (p.hitRate100 * 100).toFixed(1) +
            "% | MFE=" +
            p.avgMFE.toFixed(1) +
            "%"
        );
    }

    console.log(
        "============================================================"
    );
}


function selfTest() {
    const listingTime = 1000000000;
    const token = {
        address: "SELF_TEST",
        listingTime,
        snapshots: []
    };

    function add(t, price, volume, liquidity, holders, buys, sells, mc) {
        token.snapshots.push({
            time: listingTime + t * 3600,
            price, volume, liquidity, holders, buys, sells, market_cap: mc
        });
    }

    add(0.5, 1.00, 100, 1000, 100, 10, 10, 10000);
    add(2.0, 1.02, 110, 1010, 102, 11, 10, 10200);
    add(3.5, 1.03, 120, 1020, 104, 12, 10, 10300);
    add(4.5, 1.04, 250, 1100, 110, 18, 10, 10400);
    add(6.0, 1.06, 300, 1150, 115, 20, 10, 10600);
    add(7.5, 1.10, 350, 1200, 120, 22, 10, 11000);
    add(8.5, 1.16, 400, 1250, 122, 25, 10, 11600);
    add(9.0, 1.08, 420, 1270, 123, 26, 10, 10800);
    add(10.0, 1.25, 450, 1300, 125, 28, 10, 12500);
    add(16.0, 1.32, 500, 1350, 130, 30, 10, 13200);

    const c1 = candleStats(token, 0, 4);
    const c2 = candleStats(token, 4, 8);
    if (!c1 || !c2) throw new Error('SELF-TEST candleStats failed');

    const patterns = classifyPattern(c1, c2);
    if (!patterns.includes('VOLUME_EXPANSION')) throw new Error('SELF-TEST pattern failed');

    const signal = {
        signalTime: listingTime + 8 * 3600,
        entryPrice: 1.10
    };
    const out = calculateOutcomes(token, signal);
    if (!out || !out.targets['+5'].hit || !out.targets['+10'].hit) {
        throw new Error('SELF-TEST outcomes failed');
    }
    if (!(out.mfeMae.mfePct > 0) || !(out.mfeMae.maePct <= 0)) {
        throw new Error('SELF-TEST MFE/MAE failed');
    }

    console.log('SELF-TEST = PASS');
    console.log('PATTERNS =', patterns.join(','));
    console.log('TARGET +5 = PASS');
    console.log('TARGET +10 = PASS');
    console.log('MFE/MAE = PASS');
}

function main() {
    const arg =
        process.argv[2];

    if (arg === "--summary") {
        printSummary();
        return;
    }

    if (arg === "--self-test") {
        selfTest();
        return;
    }

    log(
        "STARTING 4H SECOND CANDLE SNIPER V1.1 RATE-SAFE"
    );

    /*
      Immediate capture, then every 60 seconds.
    */
    runCycle();

    setInterval(
        runCycle,
        SNAPSHOT_INTERVAL_MS
    );
}

main();
