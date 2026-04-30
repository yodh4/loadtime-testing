const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

// ─────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────
const CONFIG = {
    urls: ["https://socialvit.com"],
    runs: 10,
    warmupRuns: 1,
    navigationTimeout: 15000,
    postLoadWait: 2000,
    slowResourceThresholdMs: 500,
    regressionThresholdPct: 10,
    baselineFile: null,
    outputDir: ".",
    retries: 2,
    viewport: { width: 1366, height: 768 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    blockedDomains: [
        "google-analytics.com",
        "googletagmanager.com",
        "doubleclick.net",
        "facebook.net",
        "clarity.ms",
        "mpc2-prod-25-is5qnl632q-wl.a.run.app",
    ]
};

// ─────────────────────────────────────────────
// Statistics Helpers
// ─────────────────────────────────────────────
function median(values) {
    const arr = values.filter((v) => v !== null && v !== undefined && isFinite(v));
    if (arr.length === 0) return null;
    arr.sort((a, b) => a - b);
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 !== 0 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function percentile(values, p) {
    const arr = values.filter((v) => v !== null && v !== undefined && isFinite(v));
    if (arr.length === 0) return null;
    arr.sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * arr.length) - 1;
    return arr[Math.max(0, idx)];
}

function stddev(values) {
    const arr = values.filter((v) => v !== null && v !== undefined && isFinite(v));
    if (arr.length === 0) return null;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / arr.length;
    return Math.sqrt(variance);
}

function summarizeMetric(values) {
    return {
        median: median(values),
        p75: percentile(values, 75),
        p90: percentile(values, 90),
        p99: percentile(values, 99),
        stddev: stddev(values),
        min: Math.min(...values.filter((v) => v !== null && v !== undefined && isFinite(v))),
        max: Math.max(...values.filter((v) => v !== null && v !== undefined && isFinite(v))),
        sampleCount: values.filter((v) => v !== null && v !== undefined && isFinite(v)).length,
    };
}

// ─────────────────────────────────────────────
// Environment Metadata
// ─────────────────────────────────────────────
function getEnvironmentMetadata() {
    let playwrightVersion = "unknown";
    let nodeVersion = process.version;

    try {
        const pkgPath = require.resolve("playwright/package.json");
        playwrightVersion = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
    } catch (_) { }

    return {
        nodeVersion,
        playwrightVersion,
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
        hostname: os.hostname(),
        timestamp: new Date().toISOString(),
    };
}

// ─────────────────────────────────────────────
// Page Setup
// ─────────────────────────────────────────────
async function setupPage(context) {
    const page = await context.newPage();

    // Block unwanted domains
    await page.route("**/*", (route) => {
        const reqUrl = route.request().url();
        let hostname;

        try {
            hostname = new globalThis.URL(reqUrl).hostname;
        } catch (_) {
            return route.continue();
        }

        const shouldBlock = CONFIG.blockedDomains.some(
            (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
        );

        return shouldBlock ? route.abort() : route.continue();
    });

    return page;
}

// ─────────────────────────────────────────────
// Waterfall Collection
// ─────────────────────────────────────────────
function attachWaterfallListener(page) {
    const waterfall = [];
    const redirectChain = [];

    page.on("requestfinished", async (request) => {
        try {
            const timing = request.timing();
            if (!timing || timing.startTime === -1) return;

            let status = null;
            let contentLength = null;
            let contentType = null;

            try {
                const response = await request.response();
                if (response) {
                    status = response.status();
                    const headers = response.headers();
                    contentLength = headers["content-length"]
                        ? parseInt(headers["content-length"], 10)
                        : null;
                    contentType = headers["content-type"] || null;
                }
            } catch (_) { }

            const duration = timing.responseEnd - timing.startTime;
            const isSlow = duration > CONFIG.slowResourceThresholdMs;

            waterfall.push({
                url: request.url(),
                method: request.method(),
                resourceType: request.resourceType(),
                startTime: timing.startTime,
                duration: Math.round(duration),
                status,
                contentLengthBytes: contentLength,
                contentType,
                isSlow,
            });
        } catch (_) { }
    });

    page.on("response", async (response) => {
        try {
            const req = response.request();
            const chain = req.redirectedFrom();
            if (chain) {
                redirectChain.push({
                    from: chain.url(),
                    to: req.url(),
                    status: response.status(),
                });
            }
        } catch (_) { }
    });

    return { waterfall, redirectChain };
}

// ─────────────────────────────────────────────
// In-page Metrics (injected before navigation)
// ─────────────────────────────────────────────
async function injectObservers(page) {
    await page.addInitScript(() => {
        window.__PERF = { lcp: null, longTasks: [] };

        // LCP
        try {
            new PerformanceObserver((list) => {
                const entries = list.getEntries();
                const last = entries[entries.length - 1];
                window.__PERF.lcp = last.startTime;
            }).observe({ type: "largest-contentful-paint", buffered: true });
        } catch (_) { }

        // Long Tasks (approximates TTI gaps)
        try {
            new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    window.__PERF.longTasks.push({
                        start: entry.startTime,
                        duration: entry.duration,
                    });
                }
            }).observe({ type: "longtask", buffered: true });
        } catch (_) { }
    });
}

// ─────────────────────────────────────────────
// Collect All Metrics
// ─────────────────────────────────────────────
async function collectMetrics(page) {
    return await page.evaluate(() => {
        const nav = performance.getEntriesByType("navigation")[0];
        const fcpEntry = performance.getEntriesByName("first-contentful-paint")[0];
        const perf = window.__PERF || {};

        return {
            dns: nav ? nav.domainLookupEnd - nav.domainLookupStart : null,
            tcp: nav ? nav.connectEnd - nav.connectStart : null,
            tls:
                nav && nav.secureConnectionStart > 0
                    ? nav.connectEnd - nav.secureConnectionStart
                    : 0,
            ttfb: nav ? nav.responseStart - nav.requestStart : null,
            download: nav ? nav.responseEnd - nav.responseStart : null,
            domContentLoaded: nav
                ? nav.domContentLoadedEventEnd - nav.startTime
                : null,
            loadEvent: nav ? nav.loadEventEnd - nav.startTime : null,
            fcp: fcpEntry ? fcpEntry.startTime : null,
            lcp: perf.lcp || null,
            longTaskCount: perf.longTasks ? perf.longTasks.length : 0,
        };
    });
}

// ─────────────────────────────────────────────
// Validate a run's metrics
// ─────────────────────────────────────────────
function isValidRun(metrics) {
    // A run is invalid if core navigation metrics are missing
    return (
        metrics &&
        metrics.ttfb !== null &&
        metrics.loadEvent !== null &&
        metrics.fcp !== null
    );
}

// ─────────────────────────────────────────────
// Single Run
// ─────────────────────────────────────────────
async function runSingle(browser, targetUrl, runIndex, isWarmup = false) {
    const wallStart = Date.now();
    let attempt = 0;

    while (attempt <= CONFIG.retries) {
        const context = await browser.newContext({
            userAgent: CONFIG.userAgent,
            viewport: CONFIG.viewport,
            bypassCSP: true,
            ignoreHTTPSErrors: true,
        });

        // Clear cookies between runs
        await context.clearCookies();

        // Clear browser cache via CDP
        try {
            const cdpSession = await context.newCDPSession(await context.newPage());
            await cdpSession.send("Network.clearBrowserCache");
            await cdpSession.detach();
            // Close the temp page used for CDP
            const pages = context.pages();
            if (pages.length > 0) await pages[0].close();
        } catch (_) { }

        const page = await setupPage(context);
        const { waterfall, redirectChain } = attachWaterfallListener(page);
        await injectObservers(page);

        try {
            // Cache-busting query param
            const bustUrl = `${targetUrl}${targetUrl.includes("?") ? "&" : "?"
                }_cb=${Date.now()}`;

            await page.goto(bustUrl, {
                waitUntil: "load",
                timeout: CONFIG.navigationTimeout,
            });

            await page.waitForTimeout(CONFIG.postLoadWait);

            const metrics = await collectMetrics(page);

            if (!isValidRun(metrics)) {
                throw new Error("Invalid metrics — missing core fields");
            }

            const wallDuration = Date.now() - wallStart;

            // Resource summary
            const resourceSummary = waterfall.reduce((acc, r) => {
                acc[r.resourceType] = (acc[r.resourceType] || 0) + 1;
                return acc;
            }, {});

            const slowResources = waterfall
                .filter((r) => r.isSlow)
                .map((r) => ({ url: r.url, duration: r.duration, type: r.resourceType }));

            await context.close();

            return {
                run: runIndex,
                isWarmup,
                metrics,
                waterfall,
                redirectChain,
                resourceSummary,
                slowResources,
                wallDurationMs: wallDuration,
            };
        } catch (err) {
            await context.close();
            attempt++;

            if (attempt > CONFIG.retries) {
                console.error(
                    `  ✗ Run ${runIndex} failed after ${CONFIG.retries} retries: ${err.message}`
                );
                return { run: runIndex, isWarmup, failed: true, error: err.message };
            }

            console.warn(`  ↺ Run ${runIndex} attempt ${attempt} failed, retrying…`);
        }
    }
}

// ─────────────────────────────────────────────
// Build Summary Stats for a URL
// ─────────────────────────────────────────────
function buildSummary(validRuns) {
    const metricKeys = [
        "dns", "tcp", "tls", "ttfb", "download",
        "domContentLoaded", "loadEvent", "fcp", "lcp",
        "longTaskCount",
    ];

    const summary = {};
    for (const key of metricKeys) {
        const vals = validRuns.map((r) => r.metrics[key]);
        summary[key] = summarizeMetric(vals);
    }

    // Resource type aggregation
    const allResourceSummaries = validRuns.map((r) => r.resourceSummary);
    const resourceTypes = [
        ...new Set(allResourceSummaries.flatMap((r) => Object.keys(r))),
    ];
    summary.resourceCounts = {};
    for (const type of resourceTypes) {
        summary.resourceCounts[type] = median(
            allResourceSummaries.map((r) => r[type] || 0)
        );
    }

    return summary;
}

// ─────────────────────────────────────────────
// Regression Check
// ─────────────────────────────────────────────
function checkRegressions(summary, baseline) {
    const regressions = [];
    const improvements = [];
    const coreMetrics = ["ttfb", "fcp", "lcp", "domContentLoaded", "loadEvent"];

    for (const key of coreMetrics) {
        const current = summary[key]?.median;
        const base = baseline[key]?.median ?? baseline[key]; // support old flat format
        if (current == null || base == null) continue;

        const pctChange = ((current - base) / base) * 100;

        if (pctChange > CONFIG.regressionThresholdPct) {
            regressions.push({ metric: key, baseline: base, current, pctChange: pctChange.toFixed(1) });
        } else if (pctChange < -CONFIG.regressionThresholdPct) {
            improvements.push({ metric: key, baseline: base, current, pctChange: pctChange.toFixed(1) });
        }
    }

    return { regressions, improvements };
}



// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────
(async () => {
    const environment = getEnvironmentMetadata();
    const totalWall = Date.now();

    console.log("\n╔══════════════════════════════════════╗");
    console.log("║      Web Performance Benchmark       ║");
    console.log("╚══════════════════════════════════════╝");
    console.log(`Node: ${environment.nodeVersion} · Playwright: v${environment.playwrightVersion}`);
    console.log(`Platform: ${environment.platform}/${environment.arch} · ${environment.cpus} CPUs · ${environment.totalMemoryMb}MB RAM`);
    console.log(`URLs: ${CONFIG.urls.join(", ")}`);
    console.log(`Runs: ${CONFIG.runs} (+${CONFIG.warmupRuns} warmup) · Retries: ${CONFIG.retries}`);
    console.log(`Slow threshold: ${CONFIG.slowResourceThresholdMs}ms\n`);

    // Load baseline if provided
    let baseline = null;
    if (CONFIG.baselineFile) {
        try {
            baseline = JSON.parse(fs.readFileSync(CONFIG.baselineFile, "utf8"));
            console.log(`Baseline loaded from: ${CONFIG.baselineFile}`);
        } catch (e) {
            console.warn(`Could not load baseline: ${e.message}`);
        }
    }

    const browser = await chromium.launch({ headless: true });
    const urlResults = [];

    try {
        for (const targetUrl of CONFIG.urls) {
            console.log(`\n▶ Benchmarking: ${targetUrl}`);
            const allRuns = [];

            // Warmup runs
            for (let i = 1; i <= CONFIG.warmupRuns; i++) {
                console.log(`  [warmup ${i}/${CONFIG.warmupRuns}] …`);
                await runSingle(browser, targetUrl, `W${i}`, true);
            }

            // Recorded runs
            for (let i = 1; i <= CONFIG.runs; i++) {
                process.stdout.write(`  [run ${i}/${CONFIG.runs}] `);
                const result = await runSingle(browser, targetUrl, i, false);

                if (result.failed) {
                    console.log(`✗ failed`);
                } else {
                    const m = result.metrics;
                    console.log(
                        `✓  ttfb=${Math.round(m.ttfb)}ms  fcp=${Math.round(m.fcp)}ms  lcp=${m.lcp ? Math.round(m.lcp) : "—"}ms  wall=${result.wallDurationMs}ms`
                    );
                    allRuns.push(result);
                }
            }

            const validRuns = allRuns.filter((r) => !r.failed);
            const failedCount = allRuns.length - validRuns.length + (CONFIG.runs - allRuns.length);

            if (validRuns.length === 0) {
                console.error("  ✗ All runs failed for this URL.");
                urlResults.push({ url: targetUrl, error: "All runs failed", validRuns: [], summary: {} });
                continue;
            }

            console.log(`\n  Valid: ${validRuns.length}/${CONFIG.runs} runs`);
            if (failedCount > 0) console.log(`  Failed/excluded: ${failedCount}`);

            const summary = buildSummary(validRuns);

            // Regression check
            let regressionCheck = null;
            const baselineForUrl =
                baseline?.urlResults?.find((r) => r.url === targetUrl)?.summary ?? null;
            if (baselineForUrl) {
                regressionCheck = checkRegressions(summary, baselineForUrl);
                const { regressions, improvements } = regressionCheck;
                if (regressions.length > 0) {
                    console.log(`  ⚠ Regressions: ${regressions.map((r) => `${r.metric} +${r.pctChange}%`).join(", ")}`);
                }
                if (improvements.length > 0) {
                    console.log(`  ✓ Improvements: ${improvements.map((r) => `${r.metric} ${r.pctChange}%`).join(", ")}`);
                }
            }

            // Print median summary
            const s = summary;
            console.log("\n  ┌─ Median Results ─────────────────────┐");
            const lines = [
                ["DNS", s.dns?.median],
                ["TCP", s.tcp?.median],
                ["TLS", s.tls?.median],
                ["TTFB", s.ttfb?.median],
                ["Download", s.download?.median],
                ["DCL", s.domContentLoaded?.median],
                ["Load", s.loadEvent?.median],
                ["FCP", s.fcp?.median],
                ["LCP", s.lcp?.median],
                ["Long Tasks", s.longTaskCount?.median],
            ];
            for (const [label, val] of lines) {
                if (label === "Long Tasks") {
                    console.log(`  │  ${label.padEnd(14)} ${val !== null ? val : "—"}`);
                } else if (val !== null && val !== undefined) {
                    console.log(`  │  ${label.padEnd(14)} ${Math.round(val)}ms`);
                }
            }
            console.log("  └──────────────────────────────────────┘");

            urlResults.push({
                url: targetUrl,
                summary,
                validRunCount: validRuns.length,
                failedCount,
                regressionCheck,
            });
        }
    } finally {
        await browser.close();
    }

    const report = {
        timestamp: environment.timestamp,
        config: {
            urls: CONFIG.urls,
            runs: CONFIG.runs,
            warmupRuns: CONFIG.warmupRuns,
            navigationTimeoutMs: CONFIG.navigationTimeout,
            postLoadWaitMs: CONFIG.postLoadWait,
            slowResourceThresholdMs: CONFIG.slowResourceThresholdMs,
            regressionThresholdPct: CONFIG.regressionThresholdPct,
            blockedDomains: CONFIG.blockedDomains,
            viewport: CONFIG.viewport,
            userAgent: CONFIG.userAgent,
        },
        urlResults,
    };

    // Write JSON report
    const jsonOut = path.join(CONFIG.outputDir, "performance-report.json");
    fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
    console.log(`\n✓ JSON report saved → ${jsonOut}`);


    const totalSec = ((Date.now() - totalWall) / 1000).toFixed(1);
    console.log(`\n⏱  Total wall time: ${totalSec}s\n`);
})();