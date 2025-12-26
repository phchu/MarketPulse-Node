const express = require('express');
const axios = require('axios');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
// Serve static files from current directory (node_server/)
app.use(express.static(__dirname));

// --- Configuration ---
const SP500_URL = 'https://www.slickcharts.com/sp500';
const NASDAQ100_URL = 'https://www.slickcharts.com/nasdaq100';

// Sector translation map
const sectorMapping = {
    // Yahoo Finance sector names (from assetProfile)
    'Technology': '科技',
    'Healthcare': '醫療保健',
    'Financial Services': '金融',
    'Consumer Cyclical': '非必需消費品',
    'Communication Services': '通訊服務',
    'Industrials': '工業',
    'Consumer Defensive': '必需消費品',
    'Energy': '能源',
    'Utilities': '公共事業',
    'Real Estate': '房地產',
    'Basic Materials': '基本材料',
    // Legacy/alternative sector names
    'Information Technology': '科技',
    'Health Care': '醫療保健',
    'Financials': '金融',
    'Consumer Discretionary': '非必需消費品',
    'Consumer Staples': '必需消費品',
    'Materials': '基本材料'
};

// Distribution buckets (11 intervals: 1% precision throughout with extremes merged)
const buckets = ['>5%', '3~5%', '2~3%', '1~2%', '0~1%', '0', '0~-1%', '-1~-2%', '-2~-3%', '-3~-5%', '<-5%'];

// --- Data Cache ---
// --- Data Cache ---
let cache = {
    marketData: null, // Will hold { sp500: {...}, nasdaq100: {...} }
    lastUpdated: null,
    lastPriceDate: null, // Actual market data timestamp
    nextUpdate: null, // Next scheduled update timestamp
    isUpdating: false,
    sectorMap: {} // Cache for sector data: { "AAPL": "Technology", ... }
};

// Constituent Lists Cache (24-hour TTL)
let constituentCache = {
    sp500: null,
    nasdaq100: null,
    lastFetched: null,
    TTL: 24 * 60 * 60 * 1000 // 24 hours in milliseconds
};

// --- Helpers ---

// Check if US market (NYSE/NASDAQ) is open (9:30am-4:00pm ET, Mon-Fri)
function isMarketOpen() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'short'
    }).formatToParts(now);
    const hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const minute = parseInt(parts.find(p => p.type === 'minute').value, 10);
    const weekday = parts.find(p => p.type === 'weekday').value; // e.g., "Mon"
    const isWeekday = !['Sat', 'Sun'].includes(weekday);
    const marketOpen = hour > 9 || (hour === 9 && minute >= 30);
    const marketClose = hour < 16; // 16:00 is close
    return isWeekday && marketOpen && marketClose;
}

// Calculate percentage change
function getChange(prices, daysAgo) {
    if (!prices || prices.length < daysAgo + 1) return null;
    const current = prices[prices.length - 1].adjClose;
    const prev = prices[prices.length - (daysAgo + 1)].adjClose;
    
    if (current == null || prev == null || prev === 0) return null;
    return ((current - prev) / prev) * 100;
}

// Calculate percentage change from current price to N days ago (for real-time intraday changes)
function getChangeFromPrice(currentPrice, prices, daysAgo) {
    if (!currentPrice || !prices || prices.length < daysAgo + 1) return null;
    const prev = prices[prices.length - (daysAgo + 1)].adjClose;
    
    if (prev == null || prev === 0) return null;
    return ((currentPrice - prev) / prev) * 100;
}

// Get high/low prices over a period
function getHighLow(prices, days) {
    if (!prices || prices.length === 0) return { high: null, low: null };
    
    const period = prices.slice(Math.max(0, prices.length - days));
    const values = period.map(p => p.adjClose).filter(v => v != null);
    
    if (values.length === 0) return { high: null, low: null };
    
    return {
        high: Math.max(...values),
        low: Math.min(...values)
    };
}

// Map value to distribution bucket (11 intervals with 1% precision)
function getBucket(changeVal) {
    if (changeVal > 5) return '>5%';
    if (changeVal > 3) return '3~5%';
    if (changeVal > 2) return '2~3%';
    if (changeVal > 1) return '1~2%';
    if (changeVal > 0) return '0~1%';
    if (changeVal === 0) return '0';
    if (changeVal >= -1) return '0~-1%';
    if (changeVal >= -2) return '-1~-2%';
    if (changeVal >= -3) return '-2~-3%';
    if (changeVal >= -5) return '-3~-5%';
    return '<-5%';
}

// Fetch S&P 500 List from Slickcharts (with caching)
async function fetchSp500List() {
    try {
        console.log("Fetching S&P 500 from Slickcharts...");
        const response = await axios.get(SP500_URL, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
        });
        const html = response.data;
        // Regex to find symbols in table: <a href="/symbol/AAPL">AAPL</a>
        const regex = /<a href="\/symbol\/([^"]+)">/g;
        const symbols = [];
        let match;
        while ((match = regex.exec(html)) !== null) {
            symbols.push(match[1]);
        }
        // Deduplicate and return (sector will be fetched from Yahoo Finance)
        return [...new Set(symbols)].map(s => ({ symbol: s, sector: null }));
    } catch (error) {
        console.error("Error fetching S&P 500 list:", error.message);
        return [];
    }
}

// Fetch NASDAQ 100 List (with caching)
async function fetchNasdaq100List() {
    try {
        console.log("Fetching NASDAQ 100 from Slickcharts...");
        const response = await axios.get(NASDAQ100_URL, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
        });
        const html = response.data;
        // Regex to find symbols in table: <a href="/symbol/AAPL">AAPL</a>
        const regex = /<a href="\/symbol\/([^"]+)">/g;
        const symbols = [];
        let match;
        while ((match = regex.exec(html)) !== null) {
            symbols.push(match[1]);
        }
        // Deduplicate
        return [...new Set(symbols)].map(s => ({ symbol: s, sector: null }));
    } catch (error) {
        console.error("Error fetching NASDAQ 100 list:", error.message);
        return [];
    }
}

// Get constituent lists with caching (only refetch if cache expired or missing)
async function getConstituentLists() {
    const now = Date.now();
    const cacheExpired = !constituentCache.lastFetched || 
                        (now - constituentCache.lastFetched) > constituentCache.TTL;
    
    if (!cacheExpired && constituentCache.sp500 && constituentCache.nasdaq100) {
        console.log("Using cached constituent lists (last fetched: " + 
                    new Date(constituentCache.lastFetched).toISOString() + ")");
        return {
            sp500: constituentCache.sp500,
            nasdaq100: constituentCache.nasdaq100
        };
    }
    
    console.log("Cache expired or missing, fetching fresh constituent lists...");
    const [sp500Raw, nasdaqRaw] = await Promise.all([
        fetchSp500List(),
        fetchNasdaq100List()
    ]);
    
    // Update cache
    constituentCache.sp500 = sp500Raw;
    constituentCache.nasdaq100 = nasdaqRaw;
    constituentCache.lastFetched = now;
    
    return { sp500: sp500Raw, nasdaq100: nasdaqRaw };
}

// Initialize Stats Structure
function initStats() {
    const dist = {};
    const sectors = {};
    const extremes = {
        monthHigh: [],
        monthLow: [],
        yearHigh: [],
        yearLow: []
    };
    ['daily', 'week', 'month', 'year'].forEach(pd => {
        dist[pd] = {};
        buckets.forEach(b => dist[pd][b] = []);
    });
    return { dist, sectors, extremes, stocks: [] };
}

// Update Group Stats Helper
function updateGroupStats(groupName, stockObj, sector, marketCap, groupData) {
    const { sectors, dist, stocks } = groupData;
    
    // Add to all-stocks list (for frontend compatibility)
    stocks.push(stockObj);
    
    if (!sectors[sector]) {
        sectors[sector] = {
            total_market_cap: 0,
            daily_weighted_sum: 0, 
            week_weighted_sum: 0, 
            month_weighted_sum: 0, 
            year_weighted_sum: 0,
            stocks: []
        };
    }
    
    const s = sectors[sector];
    s.total_market_cap += marketCap;
    s.stocks.push(stockObj);
    
    ['daily', 'week', 'month', 'year'].forEach(pd => {
        const val = stockObj[pd];
        if (val !== null && val !== undefined) {
             s[`${pd}_weighted_sum`] += val * marketCap;
             
             const bucket = getBucket(val);
             if (dist[pd][bucket]) {
                 dist[pd][bucket].push(stockObj);
             }
        }
    });
}

// Build Final Results
function buildResults(sectors) {
    const results = [];
    for (const [sec, stats] of Object.entries(sectors)) {
        const totalCap = stats.total_market_cap;
        
        // Market Cap Weighted Average
        const avgD = totalCap > 0 ? stats.daily_weighted_sum / totalCap : 0;
        const avgW = totalCap > 0 ? stats.week_weighted_sum / totalCap : 0;
        const avgM = totalCap > 0 ? stats.month_weighted_sum / totalCap : 0;
        const avgY = totalCap > 0 ? stats.year_weighted_sum / totalCap : 0;
        
        // Sort stocks by daily performance
        stats.stocks.sort((a, b) => b.daily - a.daily);
        
        results.push({
            sector: sec,
            chinese_name: sectorMapping[sec] || sec,
            daily: parseFloat(avgD.toFixed(2)),
            week: parseFloat(avgW.toFixed(2)),
            month: parseFloat(avgM.toFixed(2)),
            year: parseFloat(avgY.toFixed(2)),
            weight: totalCap,
            stocks: stats.stocks
        });
    }
    return results;
}

// Core Update Logic
async function updateData() {
    if (cache.isUpdating) {
        console.log("Update already in progress...");
        return;
    }
    cache.isUpdating = true;
    console.log("Starting full data update...");
    console.log("Market is currently:", isMarketOpen() ? "OPEN" : "CLOSED");
    const startTime = Date.now();

    try {
        // Use cached constituent lists (will auto-refresh if expired)
        const { sp500: sp500Raw, nasdaq100: nasdaqRaw } = await getConstituentLists();

        // Combined list for fetching
        const allSymbols = [...new Set([...sp500Raw.map(s => s.symbol), ...nasdaqRaw.map(s => s.symbol)])];
        // Filter out bad symbols (dots) if needed, but YF usually handles both or prefers dashes
        const cleanSymbols = allSymbols.map(s => s.replace('.', '-')); 
        
        console.log(`Total unique symbols to fetch: ${cleanSymbols.length}`);

        // Helper maps
        const symbolToSector = {};
        sp500Raw.forEach(s => symbolToSector[s.symbol.replace('.', '-')] = s.sector);
        
        const sp500Set = new Set(sp500Raw.map(s => s.symbol.replace('.', '-')));
        const nasdaqSet = new Set(nasdaqRaw.map(s => s.symbol.replace('.', '-')));
        
        // Initialize Containers
        const sp500Data = initStats();
        const nasdaqData = initStats();
        
        // Track the latest market data date
        let latestMarketDate = null;

        // Batch Process
        const BATCH_SIZE = 10;
        // Calculate dates
        const twoYearsAgo = new Date();
        twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
        const today = new Date();
        
        const historicalOptions = { 
            period1: twoYearsAgo.toISOString().split('T')[0],
            period2: today.toISOString().split('T')[0],
            interval: '1d'
        };

        for (let i = 0; i < cleanSymbols.length; i += BATCH_SIZE) {
            const batch = cleanSymbols.slice(i, i + BATCH_SIZE);
            if (i % 50 === 0) console.log(`Processing ${i}/${cleanSymbols.length}...`);

            // 1. Fetch Quotes with specific fields (reduces bandwidth and latency)
            let quotes = [];
            try {
                const fields = [
                    'symbol', 'regularMarketPrice', 'regularMarketChangePercent',
                    'marketCap', 'fiftyTwoWeekHigh', 'fiftyTwoWeekLow', 'regularMarketTime'
                ];
                quotes = await yahooFinance.quote(batch, { fields });
            } catch (e) {
                console.warn("Error fetching batch quotes:", e.message);
            }
            // quote() returns single object if 1 symbol, array if multiple. Ensure array.
            if (!Array.isArray(quotes)) quotes = [quotes];

            // 2. Fetch Sector Info (Optimized: Check cache first)
            // Only fetch for symbols not in cache or with missing sector
            const symbolsToFetchProfile = batch.filter(sym => !cache.sectorMap[sym]);
            
            if (symbolsToFetchProfile.length > 0) {
                // console.log(`Fetching sector info for ${symbolsToFetchProfile.length} new symbols...`);
                const profilePromises = symbolsToFetchProfile.map(sym => 
                    yahooFinance.quoteSummary(sym, { modules: ['assetProfile'] })
                        .then(data => ({ symbol: sym, profile: data.assetProfile }))
                        .catch(e => ({ symbol: sym, profile: null }))
                );
                const profiles = await Promise.all(profilePromises);
                
                // Update Cache
                profiles.forEach(p => {
                    if (p.profile && (p.profile.sector || p.profile.industry)) {
                        cache.sectorMap[p.symbol] = p.profile.sector || 'Unknown';
                    }
                });
            }

            // 3. Fetch Historicals (Concurrent)
            const histPromises = batch.map(sym => 
                yahooFinance.historical(sym, historicalOptions).catch(e => null)
            );
            const histories = await Promise.all(histPromises);

            // Process Batch
            let successfulHistoricalFetches = 0;
            for (let j = 0; j < batch.length; j++) {
                const sym = batch[j];
                const quote = quotes.find(q => q && q.symbol === sym);
                const history = histories[j];

                if (!history || history.length === 0) continue;
                successfulHistoricalFetches++;

                // Determine Sector - check multiple sources with Priority:
                // 1. Manually mapped (symbolToSector from generic scraping)
                // 2. Cached Sector found from previous API calls
                // 3. Fallback
                
                let sector = symbolToSector[sym];
                
                if (!sector && cache.sectorMap[sym]) {
                    sector = cache.sectorMap[sym];
                }
                
                // Final fallback
                if (!sector) {
                    sector = 'Information Technology';
                    // console.warn(`No sector found for ${sym}, using fallback: Information Technology`);
                }

                // Determine Market Cap
                const marketCap = (quote && quote.marketCap) ? quote.marketCap : (1 * 1e9); 

                // Get current real-time price (from quote if available, otherwise historical)
                let currentPrice = history[history.length - 1].adjClose;
                let priceDate = history[history.length - 1].date;
                
                if (quote && quote.regularMarketPrice) {
                    currentPrice = quote.regularMarketPrice;
                    
                    // Update price date to current time during market hours
                    if (isMarketOpen()) {
                        priceDate = new Date();
                    }
                }

                // Calculate changes using current real-time price vs historical prices
                // This ensures week/month/year changes reflect intraday movements
                const dailyChange = quote && quote.regularMarketChangePercent !== undefined && quote.regularMarketChangePercent !== null
                    ? quote.regularMarketChangePercent
                    : getChange(history, 1); // Fallback to historical calculation
                
                // Use current price vs N days ago for real-time week/month/year changes
                const weekChange = getChangeFromPrice(currentPrice, history, 5);
                const monthChange = getChangeFromPrice(currentPrice, history, 20);
                const yearChange = getChangeFromPrice(currentPrice, history, 240);
                
                // Calculate monthly high/low from historical data
                const monthHL = getHighLow(history, 20);
                
                // Use Yahoo Finance's built-in 52-week high/low instead of calculating
                // Fallback to calculation only if not available
                let yearHL = { high: null, low: null };
                if (quote && quote.fiftyTwoWeekHigh !== undefined && quote.fiftyTwoWeekLow !== undefined) {
                    yearHL = {
                        high: quote.fiftyTwoWeekHigh,
                        low: quote.fiftyTwoWeekLow
                    };
                } else {
                    // Fallback to manual calculation if quote data unavailable
                    yearHL = getHighLow(history, 240);
                }
                
                // Track latest market date
                if (!latestMarketDate || priceDate > latestMarketDate) {
                    latestMarketDate = priceDate;
                    console.log(`Updated latestMarketDate: ${latestMarketDate} from ${sym}`);
                }


                const stockObj = {
                    symbol: sym,
                    price: parseFloat(currentPrice.toFixed(2)),
                    market_cap: marketCap,
                    daily: dailyChange || 0,
                    week: weekChange || 0,
                    month: monthChange || 0,
                    year: yearChange || 0
                };
                
                // Check if at extremes (within 0.1% tolerance)
                if (monthHL.high && currentPrice >= monthHL.high * 0.999) {
                    if (sp500Set.has(sym)) sp500Data.extremes.monthHigh.push(stockObj);
                    if (nasdaqSet.has(sym)) nasdaqData.extremes.monthHigh.push(stockObj);
                }
                if (monthHL.low && currentPrice <= monthHL.low * 1.001) {
                    if (sp500Set.has(sym)) sp500Data.extremes.monthLow.push(stockObj);
                    if (nasdaqSet.has(sym)) nasdaqData.extremes.monthLow.push(stockObj);
                }
                if (yearHL.high && currentPrice >= yearHL.high * 0.999) {
                    if (sp500Set.has(sym)) sp500Data.extremes.yearHigh.push(stockObj);
                    if (nasdaqSet.has(sym)) nasdaqData.extremes.yearHigh.push(stockObj);
                }
                if (yearHL.low && currentPrice <= yearHL.low * 1.001) {
                    if (sp500Set.has(sym)) sp500Data.extremes.yearLow.push(stockObj);
                    if (nasdaqSet.has(sym)) nasdaqData.extremes.yearLow.push(stockObj);
                }

                // Assign to groups
                if (sp500Set.has(sym)) {
                    updateGroupStats('sp500', stockObj, sector, marketCap, sp500Data);
                }
                if (nasdaqSet.has(sym)) {
                    updateGroupStats('nasdaq100', stockObj, sector, marketCap, nasdaqData);
                }
            }
            
            if (successfulHistoricalFetches > 0 && i % 50 === 0) {
                console.log(`  └─ ${successfulHistoricalFetches} successful historical fetches in this batch`);
            }
            
            // Rate limit protection - longer delay to avoid "Too Many Requests" errors
            await new Promise(r => setTimeout(r, 200));
        }

        // Final Assembly
        cache.marketData = {
            sp500: {
                performance: buildResults(sp500Data.sectors),
                distribution: sp500Data.dist,
                extremes: {
                    monthHigh: sp500Data.extremes.monthHigh,
                    monthLow: sp500Data.extremes.monthLow,
                    yearHigh: sp500Data.extremes.yearHigh,
                    yearLow: sp500Data.extremes.yearLow
                }
            },
            nasdaq100: {
                performance: buildResults(nasdaqData.sectors),
                distribution: nasdaqData.dist,
                extremes: {
                    monthHigh: nasdaqData.extremes.monthHigh,
                    monthLow: nasdaqData.extremes.monthLow,
                    yearHigh: nasdaqData.extremes.yearHigh,
                    yearLow: nasdaqData.extremes.yearLow
                }
            }
        };
        cache.lastUpdated = new Date();
        cache.lastPriceDate = latestMarketDate; // Store actual market data date
        
        console.log(`Update complete in ${(Date.now() - startTime) / 1000}s`);
        console.log(`Market data as of: ${latestMarketDate ? latestMarketDate.toISOString() : 'Unknown'}`);

    } catch (error) {
        console.error("Critical error in updateData:", error);
    } finally {
        cache.isUpdating = false;
    }
}

// --- Routes ---

// Enhanced to support ?index=sp500 or ?index=nasdaq100
app.get('/api/sector-performance', (req, res) => {
    if (!cache.marketData) {
        return res.json({ sp500: { performance: [], distribution: {} }, nasdaq100: { performance: [], distribution: {} } });
    }
    
    const index = req.query.index;
    if (index && cache.marketData[index]) {
        return res.json(cache.marketData[index].performance);
    }
    
    // Default to full object for new frontend compatibility
    res.json(cache.marketData);
});

app.get('/api/distribution', (req, res) => {
    if (!cache.marketData) {
        return res.json({});
    }
    
    const index = req.query.index || 'sp500';
    if (cache.marketData[index]) {
        return res.json(cache.marketData[index].distribution);
    }
    
    res.status(404).json({ message: "Index not found" });
});

app.post('/api/refresh', (req, res) => {
    if (cache.isUpdating) {
        return res.status(429).json({ message: "Update already in progress" });
    }
    updateData();
    res.json({ message: "Update started" });
});

app.get('/api/status', (req, res) => {
    res.json({
        lastUpdated: cache.lastUpdated,
        lastPriceDate: cache.lastPriceDate,
        nextUpdate: cache.nextUpdate,
        isUpdating: cache.isUpdating,
        dataAvailable: !!cache.marketData
    });
});

// Stock List Page Endpoint
app.get('/stock-list', (req, res) => {
    const { index = 'sp500', period = 'daily', type, name } = req.query;
    
    if (!cache.marketData || !cache.marketData[index]) {
        return res.status(404).send('<h1>Data not available</h1>');
    }
    
    let stocks = [];
    let title = '';
    
    if (type === 'sector') {
        // Find sector in performance data
        const sectorData = cache.marketData[index].performance.find(
            s => s.chinese_name === name || s.sector === name
        );
        if (sectorData && sectorData.stocks) {
            stocks = sectorData.stocks;
            title = name;
        }
    } else if (type === 'distribution') {
        // Get stocks from distribution bucket
        const distData = cache.marketData[index].distribution[period];
        if (distData && distData[name]) {
            stocks = distData[name];
            title = `Distribution: ${name}`;
        }
    } else if (type === 'monthly-high') {
        stocks = cache.marketData[index].extremes.monthHigh || [];
        title = '近月新高';
    } else if (type === 'monthly-low') {
        stocks = cache.marketData[index].extremes.monthLow || [];
        title = '近月新低';
    } else if (type === 'yearly-high') {
        stocks = cache.marketData[index].extremes.yearHigh || [];
        title = '近年新高';
    } else if (type === 'yearly-low') {
        stocks = cache.marketData[index].extremes.yearLow || [];
        title = '近年新低';
    }
    
    // Sort stocks
    stocks = [...stocks].sort((a, b) => b[period] - a[period]);
    
    const indexName = index === 'sp500' ? 'S&P 500' : 'NASDAQ 100';
    
    const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        * { box-sizing: border-box; }
        body {
            background-color: #1a1a1a;
            color: #e0e0e0;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
            margin: 0;
            padding: 20px;
        }
        h1 {
            color: #fff;
            text-align: center;
            font-size: 20px;
            margin-bottom: 10px;
        }
        .subtitle {
            text-align: center;
            color: #aaa;
            font-size: 14px;
            margin-bottom: 20px;
        }
        table {
            width: 100%;
            max-width: 800px;
            margin: 0 auto;
            border-collapse: collapse;
        }
        th, td {
            text-align: left;
            padding: 12px;
            border-bottom: 1px solid #424242;
        }
        th {
            background-color: #333;
            color: #fff;
            position: sticky;
            top: 0;
            z-index: 10;
        }
        .stock-link {
            color: #64B5F6;
            text-decoration: none;
            font-weight: 500;
        }
        .stock-link:hover {
            text-decoration: underline;
            color: #90CAF9;
        }
        .up { color: #fe4343; }
        .down { color: #00e676; }
        .flat { color: #bdbdbd; }
        @media (max-width: 768px) {
            body { padding: 10px; }
            h1 { font-size: 18px; }
            table { font-size: 14px; }
            th, td { padding: 8px 4px; }
        }
    </style>
</head>
<body>
    <h1>${title}</h1>
    <div class="subtitle">${indexName} - ${stocks.length} stocks - ${period.toUpperCase()}</div>
    <table>
        <thead>
            <tr>
                <th>Symbol</th>
                <th>Price</th>
                <th>Change %</th>
            </tr>
        </thead>
        <tbody>
${stocks.map(stock => {
    const val = stock[period];
    const colorClass = val > 0 ? 'up' : val < 0 ? 'down' : 'flat';
    const formattedVal = val.toFixed(2);
    return `            <tr>
                <td><a href="https://finance.yahoo.com/quote/${stock.symbol}/" target="_blank" class="stock-link">${stock.symbol}</a></td>
                <td>${stock.price}</td>
                <td class="${colorClass}">${val > 0 ? '+' : ''}${formattedVal}%</td>
            </tr>`;
}).join('\n')}
        </tbody>
    </table>
</body>
</html>`;
    
    res.send(html);
});

// --- Start ---

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    updateData();
    
    // Smart refresh strategy to avoid API rate limiting
    // - Market hours (Mon-Fri 9:30-16:00 ET): refresh every 60 seconds
    // - Off-hours: refresh every 60 minutes (to get updated historical data)
    
    function scheduleNextUpdate() {
        const marketOpen = isMarketOpen();
        
        let interval;
        if (marketOpen) {
            // Market is open: update every 90 seconds (1.5 minutes)
            interval = 90 * 1000;
        } else {
            // Market is closed: default to hourly updates
            interval = 60 * 60 * 1000; 
            
            // Check if market opens soon (within this hour) to wake up exactly at open
            try {
                const now = new Date();
                const etParts = new Intl.DateTimeFormat('en-US', {
                    timeZone: 'America/New_York',
                    hour12: false,
                    hour: '2-digit', minute: '2-digit', weekday: 'short'
                }).formatToParts(now);
                
                const hour = parseInt(etParts.find(p => p.type === 'hour').value, 10);
                const minute = parseInt(etParts.find(p => p.type === 'minute').value, 10);
                const weekday = etParts.find(p => p.type === 'weekday').value;
                const isWeekday = !['Sat', 'Sun'].includes(weekday);
                
                // If it's a weekday morning before 9:30 AM
                if (isWeekday && hour < 9 || (hour === 9 && minute < 30)) {
                    // Calculate time until 9:30 AM ET
                    const marketOpenTime = new Date(now);
                    
                    // We need to construct the 9:30 AM ET time carefully
                    // Simplest way: calculate minutes until 9:30
                    const currentMinutes = hour * 60 + minute;
                    const targetMinutes = 9 * 60 + 30; // 570 minutes
                    let diffMinutes = targetMinutes - currentMinutes;
                    
                    if (diffMinutes > 0 && diffMinutes <= 60) {
                        // Market opens within an hour! Schedule wake up then.
                        // Add 10s buffer to be safe
                        interval = (diffMinutes * 60 * 1000) + 10000;
                        console.log(`Market opens in ${diffMinutes} minutes. Adjusting schedule to wake up at open.`);
                    }
                }
            } catch (e) {
                console.warn("Error calculating time to market open:", e);
                // Fallback to default 60 min interval
            }
        }

        const nextUpdateTime = new Date(Date.now() + interval);
        
        // Store next update time in cache for frontend sync
        cache.nextUpdate = nextUpdateTime;
        
        console.log(`Next update scheduled in ${(interval / 1000).toFixed(0)}s (${marketOpen ? 'market open' : 'market closed'}) at ${nextUpdateTime.toLocaleString('en-US', {timeZone: 'America/New_York'})} ET`);
        
        setTimeout(() => {
            if (!cache.isUpdating) {
                console.log(marketOpen ? 'Scheduled market data refresh (market open)' : 'Scheduled market data refresh (market closed - hourly update)');
                updateData();
            }
            scheduleNextUpdate(); // Reschedule next update
        }, interval);
    }
    
    scheduleNextUpdate();
});
