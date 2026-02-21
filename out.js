/*
 * =============================================================================
 * out.js - Outbound Traffic Dashboard Logic
 * =============================================================================
 *
 * This file contains ALL the application logic for the Outbound Traffic
 * Dashboard. It fetches log data via a shell script (fetch-logs.sh), parses
 * and deduplicates the results, renders them into the HTML table, and handles
 * sorting, filtering, auto-refresh, and reverse DNS enrichment.
 *
 * Key concepts:
 *   - "target_object" (from the spec) = a traffic record with 7 fields
 *   - "target_list" = state.trafficRecords (the deduplicated list)
 *   - "lambda" = a temporary record created during parsing, then merged
 *   - "greater_than_less_than" = the timestamp comparison logic
 *
 * All functions are intentionally kept at the global/module level (not wrapped
 * in a class or IIFE) to make future extension easier, as requested.
 *
 * =============================================================================
 */


/* =============================================================================
   GLOBAL STATE
   =============================================================================
   A single state object holds all application data and configuration.
   This keeps everything in one place and makes it easy to inspect/debug.    */

var state = {

    // The current time range filter value (passed to journalctl --since)
    timeRange: "24 hours ago",

    // The deduplicated list of traffic records (our "target_list")
    // Each record has: url, address, firstTimestamp, lastTimestamp,
    //                  frequency, category, data, type
    trafficRecords: [],

    // Current sort settings
    sort: {
        column: "lastTimestamp",   // default: sort by most recent activity
        direction: "desc"          // default: newest first
    },

    // Auto-refresh configuration
    refresh: {
        intervalSeconds: 15,       // how often to re-fetch data
        countdownTimerId: null,    // the setInterval id for the countdown
        remainingSeconds: 15       // seconds until next refresh
    },

    // Cache for reverse DNS lookups so we don't re-query the same IP
    reverseDnsCache: {},

    // Set of IPs currently being looked up (prevents duplicate requests)
    pendingDnsLookups: {},

    // Path to the shell script that collects log data.
    // Resolved dynamically so the plugin works for any user.
    scriptPath: null,

    // Whether a data fetch is currently in progress (prevents overlapping fetches)
    isFetching: false,

    // ipinfo enrichment: cached results keyed by IP (prevents repeat lookups)
    ipInfoCache: {},

    // ipinfo enrichment: IPs currently being looked up (prevents duplicates)
    pendingIpInfoLookups: {},

    // ipinfo enrichment: daily request cap (change this when upgrading plans)
    ipInfoDailyLimit: 1000,

    // ipinfo enrichment: today's request count (loaded from file at init)
    ipInfoDailyCount: 0,

    // Path to ipinfo_usage.txt (resolved dynamically like scriptPath)
    ipInfoUsagePath: null,

    // Whether to show reverse-DNS (.in-addr.arpa) artifact rows (hidden by default)
    showReverseDnsQueries: false
};


/* =============================================================================
   INITIALIZATION
   =============================================================================
   When the page finishes loading, we wire up event listeners, kick off the
   first data fetch, and start the auto-refresh countdown.                   */

document.addEventListener("DOMContentLoaded", function () {

    // Resolve the script path dynamically using the current user's home directory.
    // cockpit.user() returns a promise with the logged-in user's info.
    cockpit.user().then(function (userInfo) {
        state.scriptPath = userInfo.home + "/.local/share/cockpit/traffic-monitor/fetch-logs.sh";
        state.ipInfoUsagePath = userInfo.home + "/.local/share/cockpit/traffic-monitor/ipinfo_usage.txt";

        // Wire up all UI event handlers (time filter buttons, sort buttons)
        initializeEventListeners();

        // Set up the visibility change handler so we pause refresh when hidden
        setupVisibilityTracking();

        // Load ipinfo usage count before first fetch, then start
        loadIpInfoUsage().then(function () {
            // Fetch data for the first time
            fetchAndRenderData();

            // Start the auto-refresh countdown timer
            startAutoRefresh();
        });
    });
});


/* =============================================================================
   EVENT LISTENERS
   =============================================================================
   We attach click handlers to the time-range filter buttons and the sort
   arrow buttons. These are set up once at initialization.                   */

function initializeEventListeners() {

    // Time range filter buttons: when clicked, switch the active filter
    // and re-fetch data for the new time range
    var filterButtons = document.querySelectorAll(".time-filter-btn");
    for (var i = 0; i < filterButtons.length; i++) {
        filterButtons[i].addEventListener("click", handleTimeFilterChange);
    }

    // Sort buttons: when clicked, change the sort column/direction and
    // re-render the table (no new data fetch needed, just re-sort)
    var sortButtons = document.querySelectorAll(".sort-btn");
    for (var j = 0; j < sortButtons.length; j++) {
        sortButtons[j].addEventListener("click", handleSortChange);
    }

    // Reverse-DNS toggle checkbox
    var reverseDnsCheckbox = document.getElementById("reverse-dns-checkbox");
    if (reverseDnsCheckbox) {
        reverseDnsCheckbox.addEventListener("change", handleReverseDnsToggle);
    }
}


/* Handle a click on one of the time range filter buttons.
   Updates the active button styling, changes the time range, and fetches. */
function handleTimeFilterChange(event) {
    var button = event.target;
    var newRange = button.getAttribute("data-range");

    // Move the "active" class to the clicked button
    var allButtons = document.querySelectorAll(".time-filter-btn");
    for (var i = 0; i < allButtons.length; i++) {
        allButtons[i].classList.remove("active");
    }
    button.classList.add("active");

    // Update state and fetch new data
    state.timeRange = newRange;
    resetAutoRefresh();
    fetchAndRenderData();
}


/* Handle a click on one of the sort arrow buttons.
   Updates the sort state and re-renders the table with the new order. */
function handleSortChange(event) {
    var button = event.target;
    var column = button.getAttribute("data-column");
    var direction = button.getAttribute("data-direction");

    // Update sort state
    state.sort.column = column;
    state.sort.direction = direction;

    // Update visual indicator: remove "active" from all sort buttons,
    // then add it to the one that was clicked
    var allSortBtns = document.querySelectorAll(".sort-btn");
    for (var i = 0; i < allSortBtns.length; i++) {
        allSortBtns[i].classList.remove("active");
    }
    button.classList.add("active");

    // Re-render the table (data is already in memory, just re-sort it)
    renderTable();
}


/* Handle a change on the "Show reverse-DNS" checkbox.
   Toggles visibility of .in-addr.arpa / .ip6.arpa artifact rows. */
function handleReverseDnsToggle(event) {
    state.showReverseDnsQueries = event.target.checked;
    renderTable();
}


/* =============================================================================
   VISIBILITY TRACKING
   =============================================================================
   We use the Page Visibility API to pause auto-refresh when the user switches
   to another tab or minimizes the browser. This saves resources since the
   script only runs when the dashboard is actually being viewed.             */

function setupVisibilityTracking() {
    document.addEventListener("visibilitychange", function () {
        if (document.hidden) {
            // Page is hidden: stop the countdown to save resources
            stopAutoRefresh();
        } else {
            // Page is visible again: fetch fresh data and restart countdown
            fetchAndRenderData();
            startAutoRefresh();
        }
    });
}


/* =============================================================================
   DATA FETCHING
   =============================================================================
   Uses Cockpit's spawn API to execute our shell script (fetch-logs.sh) with
   the current time range. The script does the heavy lifting of filtering
   journalctl output, and we parse its pipe-delimited output here.           */

function fetchAndRenderData() {

    // Guard against overlapping fetches (e.g. if the user clicks a filter
    // button while a previous fetch is still running)
    if (state.isFetching) {
        return;
    }
    state.isFetching = true;

    // Show the loading spinner (only on initial load or if table is empty)
    if (state.trafficRecords.length === 0) {
        showLoading();
    }
    hideError();

    // Execute the shell script via Cockpit's process spawning API.
    // "superuser: try" means it will attempt elevated privileges but
    // won't fail if they're unavailable (journalctl may need them for
    // some log sources).
    cockpit.spawn(["/bin/bash", state.scriptPath, state.timeRange], {
        err: "message",
        superuser: "try"
    })
    .then(function (output) {

        // Step 1: Parse the raw pipe-delimited output into log objects
        var rawLogs = parseShellOutput(output);

        // Step 2: Deduplicate and aggregate into unique traffic records
        state.trafficRecords = processLogs(rawLogs);

        // Step 3: Render the table with the processed data
        renderTable();

        // Step 4: Update the status bar (record count, last update time)
        updateStatusBar();

        // Step 5: Kick off async reverse DNS lookups for IP-only records
        enrichWithReverseDns();

        // Step 6: Kick off async ipinfo lookups for Owner/Timezone enrichment
        enrichWithIpInfo();

        // Hide the loading spinner
        hideLoading();
        state.isFetching = false;
    })
    .catch(function (error) {

        // Something went wrong (script not found, permissions, etc.)
        var msg = error.message || error.problem || String(error);
        showError("Failed to fetch traffic data: " + msg);
        hideLoading();
        state.isFetching = false;
    });
}


/* =============================================================================
   PARSING (parse_function from the spec)
   =============================================================================
   Takes the raw text output from fetch-logs.sh and converts each line into
   a structured log object. Each line is pipe-delimited:
     DNS|Feb 14 15:54:10|github.com|A
     HTTPS|Feb 14 15:55:50|160.79.104.10                                     */

function parseShellOutput(output) {
    var logs = [];

    // Handle empty output gracefully
    if (!output || !output.trim()) {
        return logs;
    }

    var lines = output.trim().split("\n");

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();

        // Skip blank lines
        if (!line) {
            continue;
        }

        // Split on the pipe delimiter
        var parts = line.split("|");

        // We need at least 3 parts: TYPE, TIMESTAMP, and one data field
        if (parts.length < 3) {
            continue;
        }

        var type = parts[0];
        var timestamp = parseTimestamp(parts[1]);

        if (type === "DNS") {
            // DNS format: DNS|timestamp|domain|query_type
            logs.push({
                type: "DNS",
                timestamp: timestamp,
                url: parts[2] || "",
                address: ""
            });
        } else if (type === "HTTPS" || type === "HTTP" || type === "PING") {
            // Firewall format: TYPE|timestamp|dest_ip
            logs.push({
                type: type,
                timestamp: timestamp,
                url: "",
                address: parts[2] || ""
            });
        }
    }

    return logs;
}


/* Parse a journalctl timestamp string (e.g. "Feb 14 15:54:10") into a
   JavaScript Date object. Journalctl's default short format omits the year,
   so we append the current year. */
function parseTimestamp(timestampStr) {
    if (!timestampStr || !timestampStr.trim()) {
        return new Date(0);
    }

    // journalctl format: "Feb 14 15:54:10" (month day time)
    // We add the current year to make it a parseable date string
    var currentYear = new Date().getFullYear();
    var dateStr = timestampStr.trim() + " " + currentYear;

    var parsed = new Date(dateStr);

    // If parsing failed, return epoch (will sort to the bottom)
    if (isNaN(parsed.getTime())) {
        return new Date(0);
    }

    return parsed;
}


/* =============================================================================
   DATA PROCESSING (compare_function + greater_than_less_than)
   =============================================================================
   Takes the array of raw log objects and deduplicates them into unique
   traffic records. Many log entries may point to the same URL or IP address;
   we merge them into a single record, tracking the earliest timestamp, the
   latest timestamp, and a frequency count.                                  */

function processLogs(rawLogs) {

    // We use a Map (dictionary) keyed by the URL or IP address.
    // This makes lookups O(1) instead of scanning the whole list each time.
    var recordMap = {};

    for (var i = 0; i < rawLogs.length; i++) {
        var log = rawLogs[i];

        // Create a "lambda" object: a fresh temporary record for this log line.
        // Both timestamp fields start with the same value (from this one log entry).
        var lambda = {
            url: log.url,
            address: log.address,
            firstTimestamp: log.timestamp,
            lastTimestamp: log.timestamp,
            frequency: 1,
            category: "",    // placeholder for future use
            data: "",        // placeholder for future use
            type: log.type
        };

        // Determine the unique key for deduplication.
        // DNS records are keyed by URL; firewall records are keyed by IP address.
        var key = lambda.url || lambda.address;

        if (!key) {
            // Skip entries that have neither a URL nor an address
            continue;
        }

        // compare_function: does this key already exist in our records?
        if (recordMap.hasOwnProperty(key)) {
            // Yes: merge the new data into the existing record
            updateExistingRecord(recordMap[key], lambda);
        } else {
            // No: this is a new unique URL/address, add it to the map
            recordMap[key] = lambda;
        }
    }

    // Convert the map into an array (our "target_list")
    var records = [];
    for (var k in recordMap) {
        if (recordMap.hasOwnProperty(k)) {
            records.push(recordMap[k]);
        }
    }

    return records;
}


/* greater_than_less_than: Update an existing record with data from a new
   log entry. This is the core deduplication merge logic:
     - Keep the EARLIEST "firstTimestamp"
     - Keep the LATEST "lastTimestamp"
     - Increment the frequency counter
     - Fill in any blank URL or address fields                               */
function updateExistingRecord(existingRecord, newEntry) {

    // If the new entry's timestamp is earlier, update firstTimestamp
    if (newEntry.firstTimestamp < existingRecord.firstTimestamp) {
        existingRecord.firstTimestamp = newEntry.firstTimestamp;
    }

    // If the new entry's timestamp is later, update lastTimestamp
    if (newEntry.lastTimestamp > existingRecord.lastTimestamp) {
        existingRecord.lastTimestamp = newEntry.lastTimestamp;
    }

    // Increment the frequency counter (one more occurrence found)
    existingRecord.frequency++;

    // If the existing record is missing a URL but the new entry has one,
    // fill it in (this can happen when reverse DNS resolves later)
    if (!existingRecord.url && newEntry.url) {
        existingRecord.url = newEntry.url;
    }

    // Same for IP address
    if (!existingRecord.address && newEntry.address) {
        existingRecord.address = newEntry.address;
    }
}


/* =============================================================================
   REVERSE DNS ENRICHMENT
   =============================================================================
   For records that have an IP address but no URL (i.e. iptables entries), we
   try to resolve the IP to a hostname using the "host" command. This runs
   asynchronously in the background so it doesn't block the initial render.
   Results are cached so we don't repeat lookups.                            */

function enrichWithReverseDns() {

    for (var i = 0; i < state.trafficRecords.length; i++) {
        var record = state.trafficRecords[i];

        // Only look up IPs that don't already have a URL
        if (record.address && !record.url) {
            performReverseDns(record.address, i);
        }
    }
}


/* Perform a single reverse DNS lookup for the given IP address.
   If successful, updates the record at the given index and re-renders. */
function performReverseDns(ipAddress, recordIndex) {

    // Check the cache first: if we've already looked this up, use the result
    if (state.reverseDnsCache.hasOwnProperty(ipAddress)) {
        var cached = state.reverseDnsCache[ipAddress];
        if (cached && state.trafficRecords[recordIndex]) {
            state.trafficRecords[recordIndex].url = cached;
        }
        return;
    }

    // If a lookup for this IP is already in flight, skip it
    if (state.pendingDnsLookups[ipAddress]) {
        return;
    }

    // Mark this IP as being looked up
    state.pendingDnsLookups[ipAddress] = true;

    // Run the "host" command via Cockpit to do a reverse DNS lookup.
    // "err: ignore" means we won't get an error if the IP has no PTR record.
    cockpit.spawn(["host", ipAddress], { err: "ignore" })
        .then(function (output) {

            // The "host" command outputs something like:
            //   "10.104.79.160.in-addr.arpa domain name pointer cdn.github.com."
            // We extract the hostname after "domain name pointer".
            var match = output.match(/domain name pointer\s+(.+)\.$/m);

            if (match && match[1]) {
                var hostname = match[1];

                // Cache the result for future lookups
                state.reverseDnsCache[ipAddress] = hostname;

                // Find all records with this IP and fill in the hostname
                for (var j = 0; j < state.trafficRecords.length; j++) {
                    if (state.trafficRecords[j].address === ipAddress && !state.trafficRecords[j].url) {
                        state.trafficRecords[j].url = hostname;
                    }
                }

                // Re-render to show the newly resolved hostname
                renderTable();
            } else {
                // No reverse DNS record exists for this IP (common for many hosts)
                state.reverseDnsCache[ipAddress] = null;
            }

            delete state.pendingDnsLookups[ipAddress];
        })
        .catch(function () {
            // Lookup failed (network error, command not found, etc.)
            state.reverseDnsCache[ipAddress] = null;
            delete state.pendingDnsLookups[ipAddress];
        });
}


/* =============================================================================
   IPINFO ENRICHMENT
   =============================================================================
   For records that have an IP address, we look up organization (owner) and
   timezone using the ipinfo CLI tool. Results populate the Owner and Timezone
   columns. A daily usage counter (persisted to disk) enforces the free-tier
   1,000 requests/day limit. Results are cached to avoid repeat lookups.       */

/* Load today's ipinfo usage count from the usage file.
   File format is a single line: "YYYY-MM-DD|COUNT" */
function loadIpInfoUsage() {
    if (!state.ipInfoUsagePath) {
        return Promise.resolve();
    }

    return cockpit.file(state.ipInfoUsagePath).read()
        .then(function (content) {
            if (!content || !content.trim()) {
                state.ipInfoDailyCount = 0;
                return;
            }

            var parts = content.trim().split("|");
            var todayStr = new Date().toISOString().slice(0, 10);

            if (parts.length === 2 && parts[0] === todayStr) {
                state.ipInfoDailyCount = parseInt(parts[1], 10) || 0;
            } else {
                // Different day or bad format — reset
                state.ipInfoDailyCount = 0;
            }
        })
        .catch(function () {
            // File doesn't exist yet — start at zero
            state.ipInfoDailyCount = 0;
        });
}


/* Save today's ipinfo usage count to disk */
function saveIpInfoUsage() {
    if (!state.ipInfoUsagePath) {
        return;
    }

    var todayStr = new Date().toISOString().slice(0, 10);
    var content = todayStr + "|" + state.ipInfoDailyCount;
    cockpit.file(state.ipInfoUsagePath).replace(content);
}


/* Iterate all traffic records and kick off ipinfo lookups for records
   that haven't been enriched yet. Uses IP address when available, falls
   back to domain name (ipinfo accepts both). Cached results are applied
   immediately (synchronously) so they survive auto-refresh rebuilds.
   Only uncached keys get staggered network lookups. */
function enrichWithIpInfo() {

    var hadCachedResults = false;
    var delay = 0;

    for (var i = 0; i < state.trafficRecords.length; i++) {
        var record = state.trafficRecords[i];

        // Prefer IP, fall back to domain name (ipinfo accepts both)
        var lookupKey = record.address || record.url;

        // Only look up records that have an IP or URL and haven't been enriched yet
        if (lookupKey && !record.category) {

            // Apply cached results immediately (no network call needed)
            if (state.ipInfoCache.hasOwnProperty(lookupKey)) {
                var cached = state.ipInfoCache[lookupKey];
                if (cached) {
                    applyIpInfoResult(lookupKey, cached);
                    hadCachedResults = true;
                }
                continue;
            }

            // Stop scheduling new lookups if daily limit reached
            if (state.ipInfoDailyCount >= state.ipInfoDailyLimit) {
                break;
            }

            // Stagger actual network lookups by 100ms each to avoid hammering
            (function (key, idx, d) {
                setTimeout(function () {
                    performIpInfoLookup(key, idx);
                }, d);
            })(lookupKey, i, delay);

            delay += 100;
        }
    }

    // Re-render once if any cached results were applied
    if (hadCachedResults) {
        renderTable();
    }
}


/* Perform a single ipinfo lookup for the given key (IP address or domain name).
   On success, populates Owner (category) and Timezone (data) for all
   matching records, and optionally fills in the URL from hostname or the
   address from the resolved IP. */
function performIpInfoLookup(lookupKey, recordIndex) {

    // Check cache first
    if (state.ipInfoCache.hasOwnProperty(lookupKey)) {
        var cached = state.ipInfoCache[lookupKey];
        if (cached) {
            applyIpInfoResult(lookupKey, cached);
        }
        return;
    }

    // Skip if already in flight
    if (state.pendingIpInfoLookups[lookupKey]) {
        return;
    }

    // Skip if daily limit reached
    if (state.ipInfoDailyCount >= state.ipInfoDailyLimit) {
        return;
    }

    // Mark as in flight
    state.pendingIpInfoLookups[lookupKey] = true;

    cockpit.spawn(["ipinfo", lookupKey, "--json"], { err: "ignore" })
        .then(function (output) {
            var info = null;
            try {
                info = JSON.parse(output);
            } catch (e) {
                // Bad JSON — treat as failed lookup
                state.ipInfoCache[lookupKey] = null;
                delete state.pendingIpInfoLookups[lookupKey];
                return;
            }

            var result = {
                ip: info.ip || "",
                hostname: info.hostname || "",
                org: info.org || "",
                timezone: info.timezone || ""
            };

            // Cache and apply
            state.ipInfoCache[lookupKey] = result;
            applyIpInfoResult(lookupKey, result);

            // Track usage
            state.ipInfoDailyCount++;
            saveIpInfoUsage();

            delete state.pendingIpInfoLookups[lookupKey];

            // Re-render to show updated data
            renderTable();
        })
        .catch(function () {
            state.ipInfoCache[lookupKey] = null;
            delete state.pendingIpInfoLookups[lookupKey];
        });
}


/* Apply an ipinfo result to all records matching the given lookup key
   (which may be an IP address or a domain name) */
function applyIpInfoResult(lookupKey, result) {
    for (var j = 0; j < state.trafficRecords.length; j++) {
        var rec = state.trafficRecords[j];
        if (rec.address === lookupKey || rec.url === lookupKey) {
            // Fill hostname into URL only if still empty (won't overwrite reverse DNS)
            if (!rec.url && result.hostname) {
                rec.url = result.hostname;
            }
            // Fill resolved IP into address if still empty (domain-only records)
            if (!rec.address && result.ip) {
                rec.address = result.ip;
            }
            // Owner column
            if (!rec.category && result.org) {
                rec.category = result.org;
            }
            // Timezone column
            if (!rec.data && result.timezone) {
                rec.data = result.timezone;
            }
        }
    }
}


/* =============================================================================
   SORTING
   =============================================================================
   Sorts the traffic records based on the current sort column and direction.
   Handles three data types: dates (timestamps), numbers (frequency), and
   strings (everything else). Empty values always sort to the bottom.        */

function sortRecords(records) {
    var column = state.sort.column;
    var direction = state.sort.direction;

    records.sort(function (a, b) {
        var aVal = a[column];
        var bVal = b[column];

        // Push empty/null/undefined values to the bottom regardless of direction
        var aEmpty = (aVal === "" || aVal === null || aVal === undefined);
        var bEmpty = (bVal === "" || bVal === null || bVal === undefined);
        if (aEmpty && bEmpty) return 0;
        if (aEmpty) return 1;
        if (bEmpty) return -1;

        var result = 0;

        // Timestamp columns: compare as milliseconds since epoch
        if (column === "firstTimestamp" || column === "lastTimestamp") {
            var aTime = aVal instanceof Date ? aVal.getTime() : 0;
            var bTime = bVal instanceof Date ? bVal.getTime() : 0;
            result = aTime - bTime;

        // Frequency column: compare as numbers
        } else if (column === "frequency") {
            result = Number(aVal) - Number(bVal);

        // Everything else (URL, address, category, data): compare as strings
        } else {
            var aStr = String(aVal).toLowerCase();
            var bStr = String(bVal).toLowerCase();
            if (aStr < bStr) result = -1;
            else if (aStr > bStr) result = 1;
            else result = 0;
        }

        // Flip the sign for descending order
        return direction === "asc" ? result : -result;
    });

    return records;
}


/* Returns true if the URL is a reverse-DNS PTR artifact (.in-addr.arpa or .ip6.arpa) */
function isReverseDnsQuery(url) {
    if (!url) return false;
    var lower = url.toLowerCase();
    return lower.indexOf(".in-addr.arpa") !== -1 || lower.indexOf(".ip6.arpa") !== -1;
}


/* =============================================================================
   TABLE RENDERING
   =============================================================================
   Clears the table body and rebuilds it from the current traffic records.
   Called after every data fetch, sort change, or reverse DNS update.         */

function renderTable() {
    var tbody = document.getElementById("traffic-table-body");

    // Clear all existing rows
    tbody.innerHTML = "";

    // If there's no data, show the empty state message
    if (state.trafficRecords.length === 0) {
        var emptyRow = document.createElement("tr");
        emptyRow.className = "empty-state";
        var emptyCell = document.createElement("td");
        emptyCell.setAttribute("colspan", "7");
        emptyCell.textContent = "No traffic data available for the selected time range";
        emptyRow.appendChild(emptyCell);
        tbody.appendChild(emptyRow);
        return;
    }

    // Sort a copy of the records (we don't want to mutate the original order)
    var sorted = sortRecords(state.trafficRecords.slice());

    // Build a table row for each record, filtering reverse-DNS artifacts
    for (var i = 0; i < sorted.length; i++) {
        if (!state.showReverseDnsQueries && isReverseDnsQuery(sorted[i].url)) {
            continue;
        }
        var row = createTableRow(sorted[i]);
        tbody.appendChild(row);
    }

    // Update the record count in the status bar
    updateStatusBar();
}


/* Create a single <tr> element for a traffic record.
   Each cell gets a CSS class for column-specific styling. */
function createTableRow(record) {
    var row = document.createElement("tr");

    // Add a type-based class (e.g. "traffic-type-dns") for potential styling
    row.className = "traffic-type-" + record.type.toLowerCase();

    // Column 1: URL
    var urlCell = document.createElement("td");
    urlCell.className = "url-cell";
    urlCell.textContent = record.url || "\u2014";      // em dash if empty
    urlCell.title = record.url || "";                   // tooltip with full text
    row.appendChild(urlCell);

    // Column 2: Address (IP)
    var addrCell = document.createElement("td");
    addrCell.className = "address-cell";
    addrCell.textContent = record.address || "\u2014";
    row.appendChild(addrCell);

    // Column 3: First Timestamp
    var firstTsCell = document.createElement("td");
    firstTsCell.className = "timestamp-cell";
    firstTsCell.textContent = formatTimestamp(record.firstTimestamp);
    row.appendChild(firstTsCell);

    // Column 4: Last Timestamp
    var lastTsCell = document.createElement("td");
    lastTsCell.className = "timestamp-cell";
    lastTsCell.textContent = formatTimestamp(record.lastTimestamp);
    row.appendChild(lastTsCell);

    // Column 5: Frequency
    var freqCell = document.createElement("td");
    freqCell.className = "frequency-cell";
    freqCell.textContent = record.frequency;
    row.appendChild(freqCell);

    // Column 6: Owner (Organization from ipinfo)
    var catCell = document.createElement("td");
    catCell.className = "category-cell";
    catCell.textContent = record.category || "\u2014";
    row.appendChild(catCell);

    // Column 7: Timezone (from ipinfo)
    var dataCell = document.createElement("td");
    dataCell.className = "data-cell";
    dataCell.textContent = record.data || "\u2014";
    row.appendChild(dataCell);

    return row;
}


/* Format a Date object into a human-readable timestamp string.
   Output example: "Feb 14, 3:54:10 PM"                                     */
function formatTimestamp(date) {
    if (!date || !(date instanceof Date) || isNaN(date.getTime()) || date.getTime() === 0) {
        return "\u2014";   // em dash for invalid/missing timestamps
    }

    // Use the browser's locale-aware formatting
    return date.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit"
    });
}


/* =============================================================================
   UI HELPERS
   =============================================================================
   Simple functions to show/hide the loading spinner, error banner, and to
   update the status bar at the bottom of the page.                          */

function showLoading() {
    document.getElementById("loading-spinner").classList.remove("hidden");
}

function hideLoading() {
    document.getElementById("loading-spinner").classList.add("hidden");
}

function showError(message) {
    var el = document.getElementById("error-container");
    el.textContent = message;
    el.classList.remove("hidden");
}

function hideError() {
    document.getElementById("error-container").classList.add("hidden");
}

/* Update the status bar with the current record count and last update time */
function updateStatusBar() {
    var total = state.trafficRecords.length;
    var tbody = document.getElementById("traffic-table-body");
    var displayed = tbody ? tbody.querySelectorAll("tr:not(.empty-state)").length : total;

    var countEl = document.getElementById("record-count");
    if (displayed < total) {
        countEl.textContent = displayed + " of " + total + " records (reverse-DNS hidden)";
    } else {
        countEl.textContent = total + " record" + (total !== 1 ? "s" : "");
    }

    var updateEl = document.getElementById("last-update");
    updateEl.textContent = "Last updated: " + new Date().toLocaleTimeString();
}


/* =============================================================================
   AUTO-REFRESH
   =============================================================================
   Refreshes the data every 15 seconds using a countdown timer. The timer
   pauses when the page is hidden (user switched tabs) and resumes when the
   page becomes visible again. This ensures we only run the shell script
   when someone is actually looking at the dashboard.                        */

function startAutoRefresh() {
    // Clear any existing timer first
    stopAutoRefresh();

    // Reset the countdown
    state.refresh.remainingSeconds = state.refresh.intervalSeconds;
    updateRefreshCountdown();

    // Tick every second: decrement counter, and fetch when it hits zero
    state.refresh.countdownTimerId = setInterval(function () {
        state.refresh.remainingSeconds--;
        updateRefreshCountdown();

        if (state.refresh.remainingSeconds <= 0) {
            // Time to refresh: fetch new data and reset the countdown
            fetchAndRenderData();
            state.refresh.remainingSeconds = state.refresh.intervalSeconds;
        }
    }, 1000);
}

function stopAutoRefresh() {
    if (state.refresh.countdownTimerId) {
        clearInterval(state.refresh.countdownTimerId);
        state.refresh.countdownTimerId = null;
    }
}

/* Reset the timer (called when user changes time range filter, so the
   countdown restarts from 15 instead of continuing from wherever it was) */
function resetAutoRefresh() {
    stopAutoRefresh();
    startAutoRefresh();
}

/* Update the countdown number displayed in the header */
function updateRefreshCountdown() {
    var el = document.getElementById("refresh-countdown");
    if (el) {
        el.textContent = state.refresh.remainingSeconds;
    }
}


/* =============================================================================
   CLEANUP
   =============================================================================
   Stop the auto-refresh timer when the page is unloaded to prevent any
   lingering timers or orphaned processes.                                   */

window.addEventListener("beforeunload", function () {
    stopAutoRefresh();
});
