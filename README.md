# US Market Real-time Dashboard (美股即時儀表板)

[English](#english) | [繁體中文](#traditional-chinese)

---

<a name="english"></a>
## 🇺🇸 English

### Overview
This project is a real-time partial stock market dashboard for monitoring **S&P 500** and **NASDAQ 100** sectors and individual stocks. It fetches data dynamically and visualizes sector performance using a heatmap and distribution charts.

### Features
*   **Real-time Updates**: Data refreshes every **90 seconds** during market hours (9:30 AM - 4:00 PM ET).
*   **Smart Scheduling**: Server automatically wakes up at market open and switches to hourly updates during off-hours.
*   **Sector Heatmap**: Visualizes sector performance with dynamic market cap weighting.
*   **Efficiency**: Implements server-side caching for sector data and constituent lists to minimize API usage.
*   **High/Low Extremes**: Tracks monthly and yearly high/low statistics.

### Tech Stack
*   **Backend**: Node.js, Express
*   **Data Source**: `yahoo-finance2` (Yahoo Finance API), Slickcharts (for constituents)
*   **Frontend**: Native JS, ECharts

### Installation
1.  Navigate to the project directory:
    ```bash
    cd node_server
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```

### Usage
Start the server:
```bash
node server.js
```
Open your browser and visit: `http://localhost:3000`

---

<a name="traditional-chinese"></a>
## 🇹🇼 繁體中文

### 專案簡介
這是一個美股即時儀表板，專門用於監控 **S&P 500** 和 **NASDAQ 100** 指數的類股與個股表現。系統會動態抓取數據，並透過熱力圖與分佈圖呈現市場狀態。

### 功能特色
*   **即時更新**：美股開盤期間（美東時間 9:30 AM - 4:00 PM），每 **90 秒** 自動更新一次數據。
*   **智慧排程**：Server 會自動判斷開盤時間喚醒更新，收盤後則切換為這小時更新一次以節省資源。
*   **板塊熱力圖**：根據市值加權動態計算並呈現各板塊漲跌幅。
*   **效能優化**：實作 Server 端快取 (Caching) 機制，大幅存儲產業分類與成分股清單，減少 API 呼叫。
*   **極值統計**：自動追蹤個股的月/年新高與新低。

### 技術棧
*   **後端**: Node.js, Express
*   **資料來源**: `yahoo-finance2` (Yahoo Finance API), Slickcharts (成分股清單)
*   **前端**: Native JS, ECharts

### 安裝說明
1.  進入專案資料夾：
    ```bash
    cd node_server
    ```
2.  安裝套件：
    ```bash
    npm install
    ```

### 使用方式
啟動伺服器：
```bash
node server.js
```
開啟瀏覽器並前往：`http://localhost:3000`
