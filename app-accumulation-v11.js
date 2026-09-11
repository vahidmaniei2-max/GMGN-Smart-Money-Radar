const http = require("http");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;

const HISTORY_FILE =
    path.join(__dirname, "radar-history.json");

const ENV_FILE =
    path.join(__dirname, ".env");

const MIN_MC = 30000;
const MAX_MC = 500000;

const MIN_HOLDERS = 300;
const MAX_HOLDERS = 10000;

const MIN_AGE_DAYS = 3;
const WATCHLIST_FILE =
    path.join(__dirname, "radar-watchlist.json");

const SCORE80_FILE =
    path.join(__dirname, "radar-score80.json");

// ===============================
// TELEGRAM SENDER
// ===============================

// ===============================
// TELEGRAM SCORE80 ALERT
// ===============================

function checkTelegramScore80(coin) {

    if (!coin || !coin.address || Number(coin.accumulationScore || 0) < SCORE80_THRESHOLD) {
        return;
    }
    console.log("TELEGRAM SCORE80 TRIGGERED:", coin.symbol || coin.name || coin.address, Number(coin.accumulationScore || 0));
    if (false) {
        return;
    }

    const stateFile = path.join(__dirname, "radar-telegram.json");
    const state = loadJsonFile(stateFile, { sent: {} });

    if (!state.sent) {
        state.sent = {};
    }

    const address = coin.address;

    if (state.sent[address]) {
        return;
    }

    const message =
        "?? GMGN SMART MONEY SIGNAL\n\n" +
        "?? " + (coin.symbol || coin.name || "-") + "\n" +
        "?? Score: " + Number(coin.accumulationScore || 0) + "\n" +
        "?? Status: " + (coin.accumulationStatus || "-") + "\n" +
        "?? Market Cap: $" + Number(coin.marketCap || 0).toLocaleString() + "\n" +
        "?? Holders: " + Number(coin.holders || 0).toLocaleString() + "\n\n" +
        "?? Contract:\n" +
        address;

      state.sent[address] = {
          score: Number(coin.accumulationScore || 0),
          symbol: coin.symbol || coin.name || "-",
          entryPrice: Number(coin.price || 0),
          sentAt: Math.floor(Date.now() / 1000),
          resultFinal: false
      };

    saveJsonFile(stateFile, state);
    sendTelegramMessage(message);
}
function updateTelegramPerformance(history) {

    if (!history || !history.tokens) {
        return;
    }

    const stateFile =
        path.join(__dirname, "radar-telegram.json");

    const performanceFile =
        path.join(__dirname, "radar-telegram-performance.json");

    const state =
        loadJsonFile(stateFile, { sent: {} });

    if (!state.sent) {
        return;
    }

    const performance =
        loadJsonFile(
            performanceFile,
            {
                results: {},
                total: 0,
                winners: 0,
                losers: 0
            }
        );

    Object.keys(state.sent).forEach(address => {

        const signal = state.sent[address];

        if (
            !signal ||
            signal.resultFinal ||
            !signal.entryPrice ||
            !signal.sentAt
        ) {
            return;
        }

        const tokenHistory =
            history.tokens[address];

        if (
            !tokenHistory ||
            !Array.isArray(tokenHistory.snapshots)
        ) {
            return;
        }

        const elapsed =
            Math.floor(Date.now() / 1000) - signal.sentAt;

        if (elapsed < 3600) {
            return;
        }

        let latestPrice = 0;
        let bestPrice = 0;
        let worstPrice = 0;

        tokenHistory.snapshots.forEach(snapshot => {

            if (
                Number(snapshot.time || 0) < signal.sentAt ||
                Number(snapshot.price || 0) <= 0
            ) {
                return;
            }

            const price = Number(snapshot.price);

            latestPrice = price;

            if (!bestPrice || price > bestPrice) {
                bestPrice = price;
            }

            if (!worstPrice || price < worstPrice) {
                worstPrice = price;
            }
        });

        if (!latestPrice) {
            return;
        }

        const entry = Number(signal.entryPrice);

        const finalPercent =
            ((latestPrice - entry) / entry) * 100;

        const bestPercent =
            ((bestPrice - entry) / entry) * 100;

        const worstPercent =
            ((worstPrice - entry) / entry) * 100;

        const result =
            finalPercent >= 0 ? "WIN" : "LOSS";

        signal.resultFinal = true;
        signal.finalPercent =
            Number(finalPercent.toFixed(2));

        signal.bestPercent =
            Number(bestPercent.toFixed(2));

        signal.worstPercent =
            Number(worstPercent.toFixed(2));

        signal.result = result;

        performance.results[address] = {
            symbol: signal.symbol || "-",
            score: Number(signal.score || 0),
            finalPercent: signal.finalPercent,
            bestPercent: signal.bestPercent,
            worstPercent: signal.worstPercent,
            result: result
        };

        performance.total =
            Object.keys(performance.results).length;

        performance.winners =
            Object.values(performance.results)
                .filter(x => x.result === "WIN").length;

        performance.losers =
            Object.values(performance.results)
                .filter(x => x.result === "LOSS").length;

        const winRate =
            performance.total > 0
                ? (performance.winners / performance.total) * 100
                : 0;

        sendTelegramMessage(
            "📊 GMGN SIGNAL RESULT\n\n" +
            "🪙 " + (signal.symbol || "-") + "\n" +
            "🎯 Score: " + Number(signal.score || 0) + "\n" +
            "📈 Final 60m: " + signal.finalPercent + "%\n" +
            "🚀 Best 60m: " + signal.bestPercent + "%\n" +
            "📉 Worst: " + signal.worstPercent + "%\n" +
            "🏁 Result: " + result + "\n\n" +
            "📊 RADAR PERFORMANCE\n" +
            "Signals: " + performance.total + "\n" +
            "Winners: " + performance.winners + "\n" +
            "Losers: " + performance.losers + "\n" +
            "Win Rate: " + winRate.toFixed(1) + "%"
        );
    });

    saveJsonFile(stateFile, state);
    saveJsonFile(performanceFile, performance);
}
function sendTelegramMessage(message) {

    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log("Telegram is not configured");
        return;
    }

    const data = JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message
    });

    const request = require("https").request({
        hostname: "api.telegram.org",
        path: "/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage",
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(data)
        }
    }, response => {

        let body = "";

        response.on("data", chunk => {
            body += chunk;
        });

        response.on("end", () => {
            try {
                const result = JSON.parse(body);
                if (result.ok) {
                    console.log("Telegram message sent");
                } else {
                    console.log("Telegram error:", result.description);
                }
            } catch (error) {
                console.log("Telegram response error");
            }
        });
    });

    request.on("error", error => {
        console.log("Telegram connection error:", error.message);
    });

    request.write(data);
    request.end();
}
const SCORE80_THRESHOLD = 80;
// ===============================
// TELEGRAM
// ===============================

const TELEGRAM_BOT_TOKEN =
    (() => {
        try {
            const envText = fs.readFileSync(ENV_FILE, "utf8");
            const line = envText.split(/\r?\n/).find(x => x.trim().startsWith("TELEGRAM_BOT_TOKEN="));
            return line ? line.substring(line.indexOf("=") + 1).trim() : (process.env.TELEGRAM_BOT_TOKEN || "");
        } catch (e) {
            return process.env.TELEGRAM_BOT_TOKEN || "";
        }
    })();

const TELEGRAM_CHAT_ID =
    (() => {
        try {
            const envText = fs.readFileSync(ENV_FILE, "utf8");
            const line = envText.split(/\r?\n/).find(x => x.trim().startsWith("TELEGRAM_CHAT_ID="));
            return line ? line.substring(line.indexOf("=") + 1).trim() : (process.env.TELEGRAM_CHAT_ID || "");
        } catch (e) {
            return process.env.TELEGRAM_CHAT_ID || "";
        }
    })();
const WALLET_FILE =
    path.join(__dirname, "radar-wallets.json");


// ===============================
// WALLET STORAGE
// ===============================

function loadWallets() {

    return loadJsonFile(
        WALLET_FILE,
        { wallets: {} }
    );
}


function saveWallets(data) {

    saveJsonFile(
        WALLET_FILE,
        data
    );
}



// ===============================
// WATCH LIST + SCORE80 STORAGE
// ===============================

function loadJsonFile(file, fallback) {

    try {

        return JSON.parse(
            fs.readFileSync(file, "utf8")
        );

    } catch (e) {

        return fallback;
    }
}


function saveJsonFile(file, data) {

    fs.writeFileSync(
        file,
        JSON.stringify(
            data,
            null,
            2
        ),
        "utf8"
    );
}


function loadWatchList() {

    return loadJsonFile(
        WATCHLIST_FILE,
        { tokens: {} }
    );
}


function saveWatchList(data) {

    saveJsonFile(
        WATCHLIST_FILE,
        data
    );
}


function loadScore80() {

    return loadJsonFile(
        SCORE80_FILE,
        { tokens: {} }
    );
}


function saveScore80(data) {

    saveJsonFile(
        SCORE80_FILE,
        data
    );
}


function recordScore80(coin, score, status) {

    if (
        !coin ||
        !coin.address ||
        Number(score || 0) < SCORE80_THRESHOLD
    ) {
        return;
    }

    const score80 =
        loadScore80();

    const address =
        coin.address;

    const now =
        Math.floor(Date.now() / 1000);

    const existing =
        score80.tokens[address] || null;

    score80.tokens[address] = {

        address: address,

        symbol:
            coin.symbol ||
            coin.name ||
            "-",

        name:
            coin.name ||
            coin.symbol ||
            "-",

        firstSaved:
            existing
                ? existing.firstSaved
                : now,

        lastSeen:
            now,

        score:
            Number(score),

        maxScore:
            Math.max(
                Number(existing?.maxScore || 0),
                Number(score)
            ),

        status:
            status || "STRONG"

    };

    saveScore80(score80);
}


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
    // HOLDER GROWTH â€” 20 POINTS
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
    // MARKET CAP GROWTH â€” 15 POINTS
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
    // BUY / SELL PRESSURE â€” 15 POINTS
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
    // VOLUME GROWTH â€” 10 POINTS
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
    // SMART DEGEN â€” 10 POINTS
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
    // RADAR TIME â€” 5 POINTS
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
);
/* ===============================
   AUTHENTICATION / PASSWORD
   =============================== */

const AUTH_FILE =
    path.join(__dirname, "radar-auth.json");

const DEFAULT_USERNAME = "vahid_2026";
const DEFAULT_PASSWORD = "V@8225088m";

function loadAuth() {

    const data = loadJsonFile(
        AUTH_FILE,
        {
            username: DEFAULT_USERNAME,
            password: DEFAULT_PASSWORD
        }
    );

    if (!data.username) {
        data.username = DEFAULT_USERNAME;
    }

    if (!data.password) {
        data.password = DEFAULT_PASSWORD;
    }

    return data;
}

function saveAuth(data) {

    saveJsonFile(
        AUTH_FILE,
        data
    );
}

function readRequestBody(req) {

    return new Promise((resolve) => {

        let body = "";

        req.on("data", chunk => {
            body += chunk;
        });

        req.on("end", () => {

            try {
                resolve(
                    body
                        ? JSON.parse(body)
                        : {}
                );
            }
            catch (e) {
                resolve({});
            }

        });

    });
}

function sendJson(res, statusCode, data) {

    res.writeHead(
        statusCode,
        {
            "Content-Type":
                "application/json; charset=utf-8",

            "Access-Control-Allow-Origin": "*"
        }
    );

    res.end(
        JSON.stringify(data)
    );
}

const server = http.createServer(async (req, res) => {
    
    /* ===============================
       AUTH API
       =============================== */

    if (
        req.url === "/api/login" &&
        req.method === "POST"
    ) {
        const body = await readRequestBody(req);
        const auth = loadAuth();

        const username = String(body.username || "").trim();
        const password = String(body.password || "");

        if (username === auth.username && password === auth.password) {
            sendJson(res, 200, { success: true });
        } else {
            sendJson(res, 401, {
                success: false,
                error: "Username ?? Password ?????? ???"
            });
        }

        return;
    }

    if (
        req.url === "/api/change-password" &&
        req.method === "POST"
    ) {
        const body = await readRequestBody(req);
        const auth = loadAuth();

        const currentPassword = String(body.currentPassword || "");
        const newPassword = String(body.newPassword || "");
        const confirmPassword = String(body.confirmPassword || "");

        if (currentPassword !== auth.password) {
            sendJson(res, 401, {
                success: false,
                error: "??? ???? ?????? ???"
            });
            return;
        }

        if (newPassword.length < 8) {
            sendJson(res, 400, {
                success: false,
                error: "??? ???? ???? ????? ? ??????? ????"
            });
            return;
        }

        if (newPassword !== confirmPassword) {
            sendJson(res, 400, {
                success: false,
                error: "????? ??? ???? ?? ??? ???? ????? ????"
            });
            return;
        }

        if (newPassword === currentPassword) {
            sendJson(res, 400, {
                success: false,
                error: "??? ???? ???? ?? ??? ???? ?????? ????"
            });
            return;
        }

        auth.password = newPassword;
        saveAuth(auth);

        sendJson(res, 200, {
            success: true,
            message: "??? ???? ?? ?????? ????? ???"
        });

        return;
    }


    // ===============================
    function watchListResponse(res, watchlist) {

        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*"
        });

        res.end(JSON.stringify({
            success: true,
            data: watchlist
        }));

    }

    // WATCH LIST
    // ===============================

    if (req.url === "/api/watchlist" && req.method === "GET") {

        const watchlist =
            loadWatchList();

        watchListResponse(
            res,
            watchlist
        );

        return;
    }

    if (
        req.url === "/api/watchlist/toggle" &&
        req.method === "POST"
    ) {

        const body =
            await readRequestBody(req);

        const address =
            String(body.address || "").trim();

        if (!address) {

            res.writeHead(400, {
                "Content-Type": "application/json; charset=utf-8",
                "Access-Control-Allow-Origin": "*"
            });

            res.end(JSON.stringify({
                success: false,
                error: "Contract address is required"
            }));

            return;
        }

        const watchlist =
            loadWatchList();

        if (!watchlist.tokens) {
            watchlist.tokens = {};
        }

        if (watchlist.tokens[address]) {

            delete watchlist.tokens[address];

            saveWatchList(
                watchlist
            );

            watchListResponse(
                res,
                watchlist
            );

            return;
        }

        const now =
            Math.floor(
                Date.now() / 1000
            );

        watchlist.tokens[address] = {

            address: address,

            symbol:
                body.symbol ||
                body.name ||
                "-",

            name:
                body.name ||
                body.symbol ||
                "-",

            addedAt: now

        };

        saveWatchList(
            watchlist
        );

        watchListResponse(
            res,
            watchlist
        );

        return;
    }
    // ===============================
    // WALLET API
    // ===============================

    if (req.url === "/api/wallets" && req.method === "GET") {

        const wallets =
            loadWallets();

        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*"
        });

        res.end(JSON.stringify({
            success: true,
            data: wallets
        }));

        return;
    }


    if (
        req.url === "/api/wallets/toggle" &&
        req.method === "POST"
    ) {

        const body =
            await readRequestBody(req);

        const address =
            String(body.address || "").trim();

        if (!address) {

            res.writeHead(400, {
                "Content-Type": "application/json; charset=utf-8",
                "Access-Control-Allow-Origin": "*"
            });

            res.end(JSON.stringify({
                success: false,
                error: "Wallet address is required"
            }));

            return;
        }

        const wallets =
            loadWallets();

        if (!wallets.wallets) {
            wallets.wallets = {};
        }

        if (wallets.wallets[address]) {

            delete wallets.wallets[address];

        } else {

            const now =
                Math.floor(
                    Date.now() / 1000
                );

            wallets.wallets[address] = {

                address: address,

                name:
                    String(body.name || "").trim() ||
                    "Wallet",

                enabled: true,

                addedAt: now

            };
        }

        saveWallets(
            wallets
        );

        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*"
        });

        res.end(JSON.stringify({
            success: true,
            data: wallets
        }));

        return;
    }

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

        execFile("node", ["node_modules/gmgn-cli/dist/index.js", "market", "trending", "--chain", "sol", "--interval", "5m", "--limit", "100"], { timeout: 30000, env: { ...process.env, GMGN_API_KEY: process.env.GMGN_API_KEY } },
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

    console.log("DEBUG SCORE:", coin.symbol || coin.name || coin.address, Number(coin.accumulationScore || 0)); recordScore80(coin, coin.accumulationScore, coin.accumulationStatus); checkTelegramScore80(coin);
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
            "GMGN Accumulation V11 running on port " + PORT
        );

        console.log(
            "Open: http://localhost:" + PORT
        );
    }
);function takeSnapshot() {
    console.log("Taking automatic GMGN snapshot...");

    execFile("node", ["node_modules/gmgn-cli/dist/index.js", "market", "trending", "--chain", "sol", "--interval", "5m", "--limit", "100"], { timeout: 30000, env: { ...process.env, GMGN_API_KEY: process.env.GMGN_API_KEY } },
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

                      updateTelegramPerformance(history);

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
    1 * 60 * 1000
);

takeSnapshot();



















