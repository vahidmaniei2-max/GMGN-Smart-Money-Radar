const http = require("http");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

const PORT = 3000;

const HISTORY_FILE =
    path.join(__dirname, "radar-history.json");

const ENV_FILE =
    path.join(__dirname, ".env");

const MIN_MC = 30000;
const MAX_MC = 500000;

const MIN_HOLDERS = 300;
const MAX_HOLDERS = 10000;

const MIN_AGE_DAYS = 7;
// ===============================
// PUMP + ALARM ENGINE
// ===============================

const WATCH_SCORE = 25;
const PUMP_ALERT_SCORE = 45;
const STRONG_PUMP_SCORE = 65;

function calculatePumpAlarm(coin, previous) {

    let score = 0;
    const reasons = [];

    const price1m =
        Number(coin.price_change_percent1m || 0);

    const price5m =
        Number(coin.price_change_percent5m || 0);

    const holders =
        Number(coin.holder_count || 0);

    const volume =
        Number(coin.volume || 0);

    const buys =
        Number(coin.buys || 0);

    const sells =
        Number(coin.sells || 0);

    const smartDegen =
        Number(coin.smart_degen_count || 0);

    const bundler =
        Number(coin.bundler_rate || 0);

    const rug =
        Number(coin.rug_ratio || 0);

    const botDegen =
        Number(coin.bot_degen_rate || 0);


    // ===============================
    // PRICE MOMENTUM
    // ===============================

    if (price1m >= 3) {
        score += 10;
        reasons.push("1m +" + price1m.toFixed(1) + "%");
    }

    if (price1m >= 7) {
        score += 10;
    }


    if (price5m >= 5) {
        score += 15;
        reasons.push("5m +" + price5m.toFixed(1) + "%");
    }

    if (price5m >= 10) {
        score += 10;
    }


    // ===============================
    // HOLDER GROWTH
    // ===============================

    if (
        previous &&
        Number(previous.holders || 0) > 0
    ) {

        const previousHolders =
            Number(previous.holders);

        const holderGrowth =
            ((holders - previousHolders) /
                previousHolders) * 100;

        if (holderGrowth >= 2) {
            score += 10;

            reasons.push(
                "Holders +" +
                holderGrowth.toFixed(1) +
                "%"
            );
        }
    }


    // ===============================
    // VOLUME GROWTH
    // ===============================

    if (
        previous &&
        Number(previous.volume || 0) > 0
    ) {

        const previousVolume =
            Number(previous.volume);

        const volumeGrowth =
            ((volume - previousVolume) /
                previousVolume) * 100;

        if (volumeGrowth >= 20) {
            score += 5;

            reasons.push(
                "Volume +" +
                volumeGrowth.toFixed(0) +
                "%"
            );
        }

        if (volumeGrowth >= 50) {
            score += 5;
        }
    }


    // ===============================
    // BUY / SELL PRESSURE
    // ===============================

    if (
        buys > sells &&
        buys > 0
    ) {

        const ratio =
            sells > 0
                ? buys / sells
                : buys;

        if (ratio >= 1.5) {
            score += 10;

            reasons.push(
                "Buy/Sell " +
                ratio.toFixed(1) +
                "x"
            );
        }

        if (ratio >= 2) {
            score += 5;
        }
    }


    // ===============================
    // SMART DEGEN
    // ===============================

    if (smartDegen >= 20) {

        score += 5;

        reasons.push(
            "Smart Degen " +
            smartDegen
        );
    }

    if (smartDegen >= 100) {
        score += 5;
    }


    // ===============================
    // RISK PENALTIES
    // ===============================

    if (bundler > 0.05) {

        score -= 8;

        reasons.push("Bundler Risk");
    }

    if (rug > 0.05) {

        score -= 25;

        reasons.push("Rug Risk");
    }

    if (botDegen > 0.60) {

        score -= 8;

        reasons.push("High Bot/Degen");
    }


    // ===============================
    // FINAL ALARM LEVEL
    // ===============================

    let level = "NONE";

    if (score >= STRONG_PUMP_SCORE) {

        level = "STRONG_PUMP";

    }
    else if (score >= PUMP_ALERT_SCORE) {

        level = "PUMP_ALERT";

    }
    else if (score >= WATCH_SCORE) {

        level = "WATCH";
    }


    return {

        level: level,

        score: Math.max(0, score),

        reasons: reasons

    };
}
    
function calculateAccumulationScore(coin, historyToken) {

    let score = 0;
    const reasons = [];

    const snapshots =
        historyToken &&
        Array.isArray(historyToken.snapshots)
            ? historyToken.snapshots
            : [];

    const currentHolders =
        Number(coin.holder_count || 0);

    const currentMC =
        Number(coin.market_cap || 0);

    const currentVolume =
        Number(coin.volume || 0);

    const currentBuys =
        Number(coin.buys || 0);

    const currentSells =
        Number(coin.sells || 0);

    // ===============================
    // HOLDER GROWTH — 20 POINTS
    // ===============================

    if (snapshots.length >= 2) {

        const old =
            snapshots[0];

        const oldHolders =
            Number(old.holders || 0);

        if (oldHolders > 0) {

            const growth =
                ((currentHolders - oldHolders) /
                    oldHolders) * 100;

            if (growth > 0) {

                const points =
                    Math.min(20, growth * 2);

                score += points;

                reasons.push(
                    "Holder +" +
                    growth.toFixed(1) +
                    "%"
                );
            }
        }
    }

    // ===============================
    // MARKET CAP GROWTH — 15 POINTS
    // ===============================

    if (snapshots.length >= 2) {

        const old =
            snapshots[0];

        const oldMC =
            Number(old.market_cap || 0);

        if (oldMC > 0) {

            const growth =
                ((currentMC - oldMC) /
                    oldMC) * 100;

            if (growth > 0) {

                const points =
                    Math.min(15, growth * 0.75);

                score += points;

                reasons.push(
                    "MC +" +
                    growth.toFixed(1) +
                    "%"
                );
            }
        }
    }

    // ===============================
    // BUY / SELL PRESSURE — 15 POINTS
    // ===============================

    if (currentBuys > 0) {

        const ratio =
            currentSells > 0
                ? currentBuys / currentSells
                : currentBuys;

        if (ratio >= 1.2) {

            const points =
                Math.min(15, (ratio - 1) * 10);

            score += points;

            reasons.push(
                "Buy/Sell " +
                ratio.toFixed(1) +
                "x"
            );
        }
    }

    // ===============================
    // VOLUME GROWTH — 10 POINTS
    // ===============================

    if (snapshots.length >= 2) {

        const old =
            snapshots[0];

        const oldVolume =
            Number(old.volume || 0);

        if (oldVolume > 0) {

            const growth =
                ((currentVolume - oldVolume) /
                    oldVolume) * 100;

            if (growth > 0) {

                const points =
                    Math.min(10, growth * 0.2);

                score += points;

                reasons.push(
                    "Volume +" +
                    growth.toFixed(0) +
                    "%"
                );
            }
        }
    }

    // ===============================
    // SMART DEGEN — 10 POINTS
    // ===============================

    const smartDegen =
        Number(coin.smart_degen_count || 0);

    if (smartDegen > 0) {

        const points =
            Math.min(10, smartDegen / 20);

        score += points;

        reasons.push(
            "Smart Degen " +
            smartDegen
        );
    }

    // ===============================
    // RADAR TIME — 5 POINTS
    // ===============================

    if (
        historyToken &&
        historyToken.firstSeen
    ) {

        const radarHours =
            (Date.now() / 1000 -
                historyToken.firstSeen) / 3600;

        const points =
            Math.min(5, radarHours / 2);

        score += points;

        if (radarHours >= 2) {

            reasons.push(
                "Radar " +
                radarHours.toFixed(1) +
                "h"
            );
        }
    }

    // ===============================
    // RISK PENALTIES
    // ===============================

    const bundler =
        Number(coin.bundler_rate || 0);

    const rug =
        Number(coin.rug_ratio || 0);

    const botDegen =
        Number(coin.bot_degen_rate || 0);

    if (bundler > 0) {

        score -= Math.min(5, bundler / 20);

        reasons.push("Bundler Risk");
    }

    if (rug > 0) {

        score -= Math.min(10, rug / 10);

        reasons.push("Rug Risk");
    }

    if (botDegen > 50) {

        score -= 5;

        reasons.push("High Bot/Degen");
    }

    score =
        Math.max(
            0,
            Math.min(
                100,
                Math.round(score)
            )
        );

    let status = "WEAK";

    if (score >= 80) {
        status = "STRONG";
    } else if (score >= 65) {
        status = "WATCH";
    } else if (score >= 50) {
        status = "EARLY WATCH";
    }

    return {
        score: score,
        status: status,
        reasons: reasons
    };
}
function loadApiKey() {

    try {

        const text =
            fs.readFileSync(ENV_FILE, "utf8");

        const line =
            text
                .split(/\r?\n/)
                .find(x =>
                    x.trim().startsWith("GMGN_API_KEY=")
                );

        if (line) {

            process.env.GMGN_API_KEY =
                line.substring(
                    line.indexOf("=") + 1
                ).trim();

            console.log(
                "GMGN API Key loaded from .env"
            );
        }

    } catch (e) {

        console.log(
            "Could not read .env"
        );
    }
}

function loadHistory() {

    try {

        return JSON.parse(
            fs.readFileSync(
                HISTORY_FILE,
                "utf8"
            )
        );

    } catch (e) {

        return {
            tokens: {}
        };
    }
}

function saveHistory(history) {

    fs.writeFileSync(
        HISTORY_FILE,
        JSON.stringify(
            history,
            null,
            2
        ),
        "utf8"
    );
}

loadApiKey();

console.log(
    "Accumulation test engine loaded"
);const server = http.createServer((req, res) => {

    if (req.url === "/api/history") {

        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*"
        });

        res.end(JSON.stringify({
            success: true,
            data: loadHistory()
        }));

        return;
    }

    if (req.url === "/api/pump") {

        exec(
            'gmgn-cli.cmd market trending --chain sol --interval 5m --limit 100',
            {
                windowsHide: true,
                timeout: 30000,
                env: process.env
            },
            (error, stdout, stderr) => {

                res.writeHead(200, {
                    "Content-Type":
                        "application/json; charset=utf-8",

                    "Access-Control-Allow-Origin": "*"
                });

                if (error) {

                    res.end(JSON.stringify({
                        success: false,
                        error:
                            stderr ||
                            error.message
                    }));

                    return;
                }

                try {

                    const parsed =
                        JSON.parse(stdout);

                    const history =
                        loadHistory();

                    if (
                        parsed.data &&
                        Array.isArray(
                            parsed.data.rank
                        )
                    ) {

                        const now =
                            Math.floor(
                                Date.now() / 1000
                            );

                        parsed.data.rank =
                            parsed.data.rank.filter(
                                coin => {

                                    const marketCap =
                                        Number(
                                            coin.market_cap || 0
                                        );

                                    const holders =
                                        Number(
                                            coin.holder_count || 0
                                        );

                                    const creation =
                                        Number(
                                            coin.creation_timestamp ||
                                            coin.open_timestamp ||
                                            0
                                        );

                                    const ageDays =
                                        creation > 0
                                            ? (now - creation) /
                                              86400
                                            : 0;

                                    return (
                                        ageDays >=
                                            MIN_AGE_DAYS &&

                                        marketCap >=
                                            MIN_MC &&

                                        marketCap <=
                                            MAX_MC &&

                                        holders >=
                                            MIN_HOLDERS &&

                                        holders <=
                                            MAX_HOLDERS
                                    );
                                }
                            );
// ===============================
// PUMP ALARM
// ===============================

parsed.data.rank.forEach(coin => {

    if (!coin.address) {
        return;
    }

    const tokenHistory =
        history.tokens[coin.address];

    let previous = null;

    if (
        tokenHistory &&
        Array.isArray(tokenHistory.snapshots) &&
        tokenHistory.snapshots.length > 0
    ) {
        previous =
            tokenHistory.snapshots[
                tokenHistory.snapshots.length - 1
            ];
    }

    const alarm =
        calculatePumpAlarm(
            coin,
            previous
        );

    coin.pumpAlarm =
        alarm.level;

    coin.pumpScore =
        alarm.score;

    coin.pumpReasons =
        alarm.reasons;

    // ===============================
    // ACCUMULATION SCORE
    // ===============================

    const accumulation =
        calculateAccumulationScore(
            coin,
            tokenHistory
        );

    coin.accumulationScore =
        accumulation.score;

    coin.accumulationStatus =
        accumulation.status;

    coin.accumulationReasons =
        accumulation.reasons;
});
                        saveHistory(history);
                    }

                   const displayHistory = loadHistory();

if (
    parsed.data &&
    Array.isArray(parsed.data.rank)
) {

    parsed.data.rank.forEach(coin => {

        if (!coin.address) {
            return;
        }

        const h =
            displayHistory.tokens[
                coin.address
            ];

        if (!h) {
            return;
        }

        coin.firstSeen =
            h.firstSeen || 0;

        coin.snapshots =
            h.snapshots || [];
coin.snapshotsCount =
    Array.isArray(h.snapshots)
        ? h.snapshots.length
        : 0;
        coin.pumpDetected =
            h.pumpDetected || false;

        coin.pumpPrice =
            h.pumpPrice || 0;

        coin.pumpPercent =
            h.pumpPercent || 0;

        coin.pumpTime =
            h.pumpTime || 0;

        coin.timeToPump =
            h.timeToPump || 0;
    });
}


parsed.data.rank.sort((a, b) => {
    return Number(b.accumulationScore || 0) -
           Number(a.accumulationScore || 0);
});

res.end(
    JSON.stringify({
        success: true,
        data:
            JSON.stringify(parsed)
    })
);

                } catch (e) {

                    res.end(
                        JSON.stringify({
                            success: false,
                            error:
                                e.message
                        })
                    );
                }
            }
        );

        return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(path.join(__dirname, "index-v11.html"), "utf8"));
});server.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            "GMGN Accumulation V11 running on port 3000"
        );

        console.log(
            "Open: http://localhost:3000"
        );
    }
);function takeSnapshot() {
    console.log("Taking automatic GMGN snapshot...");

    exec(
        'gmgn-cli.cmd market trending --chain sol --interval 5m --limit 100',
        {
            windowsHide: true,
            timeout: 30000,
            env: process.env
        },
        (error, stdout, stderr) => {

            if (error) {
                console.log(
                    "Snapshot error:",
                    stderr || error.message
                );
                return;
            }

            try {

                const parsed =
                    JSON.parse(stdout);

                const history =
                    loadHistory();

                if (
                    parsed.data &&
                    Array.isArray(parsed.data.rank)
                ) {

                    const now =
                        Math.floor(Date.now() / 1000);

                    let saved = 0;

                    parsed.data.rank.forEach(coin => {

                        const marketCap =
                            Number(coin.market_cap || 0);

                        const holders =
                            Number(coin.holder_count || 0);

                        const creation =
                            Number(
                                coin.creation_timestamp ||
                                coin.open_timestamp ||
                                0
                            );

                        const ageDays =
                            creation > 0
                                ? (now - creation) / 86400
                                : 0;

                        if (
                            ageDays < MIN_AGE_DAYS ||
                            marketCap < MIN_MC ||
                            marketCap > MAX_MC ||
                            holders < MIN_HOLDERS ||
                            holders > MAX_HOLDERS
                        ) {
                            return;
                        }

                        if (!coin.address) {
                            return;
                        }

                        if (!history.tokens[coin.address]) {
                            history.tokens[coin.address] = {
                                firstSeen: now,
                                snapshots: []
                            };
                        }

                        history.tokens[
                            coin.address
                        ].snapshots.push({

                            time: now,

                            price:
                                Number(
                                    coin.price || 0
                                ),

                            holders: holders,
                            
                            market_cap: marketCap,
                            volume:
                                Number(
                                    coin.volume || 0
                                ),

                            liquidity:
                                Number(
                                    coin.liquidity || 0
                                ),

                            buys:
                                Number(
                                    coin.buys || 0
                                ),

                            sells:
                                Number(
                                    coin.sells || 0
                                )
                        });

                        const snapshots =
                            history.tokens[
                                coin.address
                            ].snapshots;

                    if (snapshots.length > 100) {
    history.tokens[
        coin.address
    ].snapshots =
        snapshots.slice(-100);
}

const firstPrice =
    Number(
        history.tokens[
            coin.address
        ].snapshots[0].price || 0
    );

const currentPrice =
    Number(
        coin.price || 0
    );

if (
    firstPrice > 0 &&
    currentPrice >= firstPrice * 1.5 &&
    !history.tokens[
        coin.address
    ].pumpDetected
) {

    history.tokens[
        coin.address
    ].pumpDetected = true;

    history.tokens[
        coin.address
    ].pumpPrice = currentPrice;

    history.tokens[
        coin.address
    ].pumpPercent =
        ((currentPrice - firstPrice) /
            firstPrice) * 100;

    history.tokens[
        coin.address
    ].pumpTime = now;

    history.tokens[
        coin.address
    ].timeToPump =
        now -
        history.tokens[
            coin.address
        ].firstSeen;

    console.log(
        "PUMP DETECTED:",
        coin.address,
        history.tokens[
            coin.address
        ].pumpPercent.toFixed(2) + "%"
    );
}

saved++;
                    });

                    saveHistory(history);

                    console.log(
                        "Snapshot saved:",
                        saved,
                        "tokens"
                    );
                }

            } catch (e) {console.log(
                    "Snapshot JSON error:",
                    e.message
                );
            }
        }
    );
}

setInterval(
    takeSnapshot,
    5 * 60 * 1000
);

takeSnapshot();





















