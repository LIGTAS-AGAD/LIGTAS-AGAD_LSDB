Chart.register(ChartDataLabels); 

let db = [];
let map, markers, userLocationGroup;
let currentProximityCircle = null;
let currentNearbyCount = 0;
let userGpsCoords = null;
let filterByGpsRadius = false;
let radarSvgOverlay = null;
let charts = {}; 

// --- THEME INITIALIZATION (Supports Standard Teal/Mango, Dark, Neon, Environmental) ---
let savedTheme = localStorage.getItem('theme') || 'standard';
if (savedTheme === 'light') savedTheme = 'standard';
document.documentElement.setAttribute('data-theme', savedTheme);
if(savedTheme === 'neon') Chart.defaults.color = '#00f2fe';
else if(savedTheme === 'environmental') Chart.defaults.color = '#432418';
else if(savedTheme === 'dark') Chart.defaults.color = '#cbd5e1';
else Chart.defaults.color = '#0a5c6d';

// Pagination & Performance State
let currentFilteredData = [];
let currentPage = 1;
const ITEMS_PER_PAGE = 50; 
let allTimeChartsRendered = false; 
let allTimeMetrics = null;

const PH_CENTER = [12.8797, 121.7740];
const API_URL = 'https://sheetlabs.com/LA25/LIGTAS_LSDB_WEB_APIv2'; 

function init() {
    try {
        const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: 'Esri' });
        const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: 'OSM' });

        map = L.map('map', { center: PH_CENTER, zoom: 5, layers: [sat], zoomControl: false });
        L.control.zoom({ position: 'bottomright' }).addTo(map);

        const lyProvinces = L.layerGroup();
        const lyRegions = L.layerGroup();
        const lyFaults = L.layerGroup();
        markers = L.layerGroup().addTo(map);

        const loadGeoJson = (key, layer, color) => {
            const url = `https://raw.githubusercontent.com/Gabzrock/LIGTASAGADEWSV3/refs/heads/main/uRIL_AWS_${key}_Susceptibility.geojson`;
            fetch(url)
                .then(r => { if (!r.ok) throw new Error("Network response was not ok"); return r.json(); })
                .then(data => L.geoJson(data, { style: { color: color, fillOpacity: 0.3 } }).addTo(layer))
                .catch(err => console.warn(`Could not load GeoJSON layer: ${key}`, err));
        };

        loadGeoJson('High', lyProvinces, 'red');
        loadGeoJson('Moderate', lyRegions, 'yellow');
        loadGeoJson('Low', lyFaults, 'green');

        L.control.layers({ "Satellite": sat, "OSM": osm }, { "Markers": markers, "MGB-High": lyProvinces, "MGB-Med": lyRegions, "MGB-Low": lyFaults }).addTo(map);

        map.on('moveend', () => {
            const extToggle = document.getElementById('fExtent');
            if (extToggle && extToggle.checked) filter(); 
        });

        map.on('locationfound', (e) => {
            if (!userLocationGroup) userLocationGroup = L.layerGroup().addTo(map);
            userLocationGroup.clearLayers();
            
            const acc = Math.round(e.accuracy);
            const lat = e.latlng.lat.toFixed(5);
            const lng = e.latlng.lng.toFixed(5);
            
            let accLevel = 'High Precision';
            let accClass = 'acc-high';
            if (acc > 100) {
                accLevel = 'Approximate / Low';
                accClass = 'acc-low';
            } else if (acc > 30) {
                accLevel = 'Moderate Precision';
                accClass = 'acc-med';
            }
            
            const accFormatted = acc >= 1000 ? `${(acc / 1000).toFixed(2)} km` : `${acc} meters`;
            
            // 1. Accuracy Circle (GPS Uncertainty Radius)
            const accCircle = L.circle(e.latlng, {
                radius: e.accuracy,
                color: '#0a5c6d',
                fillColor: '#0a5c6d',
                fillOpacity: 0.12,
                weight: 1.5,
                dashArray: '4, 4'
            }).addTo(userLocationGroup);

            // 2. 3 KM Proximity Zone Boundary
            currentProximityCircle = L.circle(e.latlng, {
                radius: 3000,
                color: '#eab308',
                fillColor: 'rgba(234, 179, 8, 0.04)',
                fillOpacity: 1,
                weight: 2,
                dashArray: '6, 6',
                className: 'radar-perimeter-circle'
            }).addTo(userLocationGroup);

            // 2b. Tactical Animated Radar Sweep, Sonar Waves & Range Grid Overlay
            createRadarSvgOverlay(currentProximityCircle.getBounds());
            
            // 3. User Location Center Pin
            const pinMarker = L.circleMarker(e.latlng, {
                radius: 8,
                fillColor: '#eab308',
                color: '#ffffff',
                weight: 2.5,
                fillOpacity: 1,
                className: 'radar-center-marker'
            }).addTo(userLocationGroup);

            // 4. Calculate landslides in db within 3 km
            let nearbyCount = 0;
            let closestDist = Infinity;
            let closestItem = null;
            const nearbyList = [];

            db.forEach(item => {
                if (item.lat !== null && item.lng !== null && !isNaN(item.lat) && !isNaN(item.lng)) {
                    const d = e.latlng.distanceTo([item.lat, item.lng]); // distance in meters
                    if (d <= 3000) {
                        nearbyCount++;
                        nearbyList.push({ item, d });
                        if (d < closestDist) {
                            closestDist = d;
                            closestItem = item;
                        }
                    }
                }
            });
            nearbyList.sort((a, b) => a.d - b.d);
            currentNearbyCount = nearbyCount;
            userGpsCoords = e.latlng;
            filterByGpsRadius = true;

            let closestText = '';
            if (nearbyCount > 0 && closestItem) {
                const dFormatted = closestDist >= 1000 ? (closestDist / 1000).toFixed(2) + ' km' : Math.round(closestDist) + ' m';
                const locName = [closestItem.MUNICIPALITY, closestItem.PROVINCE].filter(Boolean).join(', ') || 'Unknown Area';
                closestText = `<div class="gps-proximity-closest">Closest: <strong>${dFormatted}</strong> away (${locName})</div>`;
            } else {
                closestText = `<div class="gps-proximity-none">No historical landslides recorded within 3.0 km</div>`;
            }

            // 5. Fit map bounds to show full 3 km proximity buffer
            map.fitBounds(currentProximityCircle.getBounds(), { padding: [25, 25], maxZoom: 14 });

            // 6. ACTIVATE Filter Location by Map Extent
            const extToggle = document.getElementById('fExtent');
            if (extToggle) {
                extToggle.checked = true;
                updateExtentStyle();
            }

            // 7. Update Extent nearby tag in filter carousel
            const extTag = document.getElementById('extentNearbyTag');
            if (extTag) {
                extTag.innerText = `${nearbyCount} in 3km`;
                extTag.style.display = 'inline-flex';
            }
            
            // 8. Popup on Pin Marker
            const popupContent = `
                <div class="gps-accuracy-popup">
                    <div class="gps-popup-header">
                        <svg class="app-icon app-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"></polygon></svg>
                        <span>YOUR GPS LOCATION</span>
                    </div>
                    <div class="gps-popup-coords">${lat}, ${lng}</div>
                    <div class="gps-popup-acc-row" style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
                        <span class="gps-acc-badge ${accClass}">Accuracy: ±${accFormatted}</span>
                        <span class="gps-extent-badge">3km Radius: Active</span>
                    </div>

                    <div class="gps-popup-proximity-section">
                        <div class="gps-prox-badge-large">
                            <span class="gps-prox-large-num">${nearbyCount}</span>
                            <span class="gps-prox-large-lbl">Landslide${nearbyCount === 1 ? '' : 's'} within 3 km</span>
                        </div>
                        ${closestText}
                    </div>

                    <div class="gps-popup-meta">
                        Confidence: ${accLevel}. Showing only historical landslides strictly within 3.0 km radius.
                    </div>
                </div>
            `;
            
            pinMarker.bindPopup(popupContent).openPopup();
            accCircle.bindPopup(popupContent);
            currentProximityCircle.bindTooltip(`3.0 km Proximity Buffer: ${nearbyCount} Landslide${nearbyCount === 1 ? '' : 's'}`, {
                permanent: false,
                direction: 'top',
                className: 'leaflet-proximity-tooltip'
            });

            // 9. Floating Proximity Radar Banner
            const proxBanner = document.getElementById('gpsProximityBanner');
            if (proxBanner) {
                const countNumEl = document.getElementById('gpsProxCountNum');
                const countLblEl = document.getElementById('gpsProxCountLabel');
                const closestTextEl = document.getElementById('gpsProxClosestText');
                const toggleRadiusBtn = document.getElementById('gpsToggleRadiusBtn');
                
                if (countNumEl) countNumEl.innerText = nearbyCount;
                if (countLblEl) countLblEl.innerText = `Landslide${nearbyCount === 1 ? '' : 's'} within 3 km`;
                if (closestTextEl) {
                    if (nearbyCount > 0 && closestItem) {
                        const dFormatted = closestDist >= 1000 ? (closestDist / 1000).toFixed(2) + ' km' : Math.round(closestDist) + ' m';
                        const locName = [closestItem.MUNICIPALITY, closestItem.PROVINCE].filter(Boolean).join(', ') || 'Unknown';
                        closestTextEl.innerText = `Closest: ${dFormatted} (${locName})`;
                    } else {
                        closestTextEl.innerText = 'No historical events within 3.0 km';
                    }
                }
                if (toggleRadiusBtn) {
                    toggleRadiusBtn.innerText = '3km Only: ON';
                    toggleRadiusBtn.classList.remove('is-off');
                }
                proxBanner.style.display = 'flex';
            }
            
            setStatus(`GPS LOCKED (±${acc >= 1000 ? (acc / 1000).toFixed(1) + 'km' : acc + 'm'}) • ${nearbyCount} LANDSLIDES IN 3KM (FILTERED)`, 'online');
            updateActiveFilterBadge();
            filter();
        });

        map.on('locationerror', (e) => {
            setStatus('GPS DENIED', 'error');
            alert(`Location Access Error: ${e.message || 'Unable to retrieve device position. Please ensure location permissions are granted.'}`);
        });

        connectRegistry();
    } catch (error) {
        console.error("Map Initialization Error:", error);
        setStatus('MAP ERROR', 'error');
    }
}

// --- HAMBURGER MENU & THEME TOGGLE ---
function toggleMobileMenu() {
    document.getElementById('navMenu').classList.toggle('active');
}

function closeMobileMenu() {
    document.getElementById('navMenu').classList.remove('active');
}

function toggleTheme() {
    const root = document.documentElement;
    let currentTheme = root.getAttribute('data-theme') || 'standard';
    if (currentTheme === 'light') currentTheme = 'standard';
    
    const themes = ['standard', 'dark', 'neon', 'environmental'];
    let currentIndex = themes.indexOf(currentTheme);
    if (currentIndex === -1) currentIndex = 0;
    const newTheme = themes[(currentIndex + 1) % themes.length];
    
    root.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    
    if(newTheme === 'neon') Chart.defaults.color = '#00f2fe';
    else if(newTheme === 'environmental') Chart.defaults.color = '#432418';
    else if(newTheme === 'dark') Chart.defaults.color = '#cbd5e1';
    else Chart.defaults.color = '#0a5c6d';
    
    allTimeChartsRendered = false; 
    ['coords','loc','date','time','completenessTrig','completenessCat'].forEach(id => charts['chart' + id.charAt(0).toUpperCase() + id.slice(1)]?.destroy());
    
    if(currentFilteredData.length > 0) buildCharts(currentFilteredData);
}

// --- DATA SYNC & ERROR HANDLING ---
async function connectRegistry() {
    setStatus('SYNCING DATA...', 'warning');
    const feedEl = document.getElementById('feed');
    
    try {
        const res = await fetch(API_URL);
        
        if (!res.ok) throw new Error(`HTTP Error ${res.status}: The database server refused the connection.`);
        
        let raw = await res.json();
        if (!Array.isArray(raw)) throw new Error("The API returned data, but it is not in the correct Array format.");
        if (raw.length === 0) throw new Error("The API connected successfully, but returned 0 records.");

        db = raw.map(i => {
            const lat = parseFloat(i.Latitude);
            const lng = parseFloat(i.Longitude);
            const yr = i.Year ? String(i.Year).trim() : (i.YYYYMMDD ? String(i.YYYYMMDD).substring(0, 4) : 'Unknown');
            const searchStr = `${i.LSID || ''} ${i.MUNICIPALITY || ''} ${i.PROVINCE || ''} ${i.REGION || ''} ${i.LSTRIGGER || ''} ${i.LSCATEGORY || ''} ${i.GENERALSOURCES || ''} ${i.SPECIFICSOURCE || ''} ${yr}`.toLowerCase();

            return {
                ...i,
                lat: isNaN(lat) ? null : lat,
                lng: isNaN(lng) ? null : lng,
                deaths: parseInt(i.DEATHS) || 0,
                year: yr,
                searchStr: searchStr
            };
        });

        db.sort((a, b) => new Date(b.YYYYMMDD || 0) - new Date(a.YYYYMMDD || 0));
        computeAllTimeMetrics();

        setStatus('SYSTEM ONLINE', 'online');
        initFilters();
        filter();
        
        // Startup Prompt: Ask user if they want to scan landslides based on GPS location
        setTimeout(() => {
            showGpsStartupPrompt();
        }, 500);
        
    } catch (e) {
        console.error("Critical System Failure:", e);
        setStatus('CONNECTION FAILED', 'error');
        
        feedEl.innerHTML = `
            <div style="padding:40px; text-align:center; color:var(--danger); background:var(--card-bg); border-radius:8px; margin:20px; border: 2px solid var(--danger);">
                <h3 style="margin-top:0;">⚠️ System Initialization Failed</h3>
                <p style="font-weight:bold;">Error Details:</p>
                <code style="background:var(--input-bg); padding:10px; border-radius:4px; display:block; text-align:left; color:var(--text);">${e.message}</code>
                <p style="margin-top:20px; font-size:14px; color:var(--text-muted);">Please verify that your API URL is correct and allows public cross-origin (CORS) requests.</p>
            </div>
        `;
    }
}

// NEW: Manual Data Refresh Protocol
async function refreshData() {
    setStatus('FETCHING NEW DATA...', 'warning');
    document.getElementById('feed').innerHTML = '<div style="padding:40px; text-align:center; font-weight:bold; color:var(--text-muted);">Downloading latest database records...</div>';
    
    try {
        const res = await fetch(API_URL);
        if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
        let raw = await res.json();
        if (!Array.isArray(raw) || raw.length === 0) throw new Error("No data returned.");

        db = raw.map(i => {
            const lat = parseFloat(i.Latitude);
            const lng = parseFloat(i.Longitude);
            const yr = i.Year ? String(i.Year).trim() : (i.YYYYMMDD ? String(i.YYYYMMDD).substring(0, 4) : 'Unknown');
            const searchStr = `${i.LSID || ''} ${i.MUNICIPALITY || ''} ${i.PROVINCE || ''} ${i.REGION || ''} ${i.LSTRIGGER || ''} ${i.LSCATEGORY || ''} ${yr}`.toLowerCase();
            return { ...i, lat: isNaN(lat) ? null : lat, lng: isNaN(lng) ? null : lng, deaths: parseInt(i.DEATHS) || 0, year: yr, searchStr: searchStr };
        });

        db.sort((a, b) => new Date(b.YYYYMMDD || 0) - new Date(a.YYYYMMDD || 0));
        computeAllTimeMetrics();
        
        // Destroy all-time donut charts so they rebuild with fresh totals
        allTimeChartsRendered = false; 
        ['coords','loc','date','time','completenessTrig','completenessCat'].forEach(id => charts['chart' + id.charAt(0).toUpperCase() + id.slice(1)]?.destroy());

        updateDropdownOptions();
        filter(); // Rebuilds the UI and list with fresh variables
        setStatus('SYSTEM ONLINE', 'online');
    } catch (e) {
        console.error("Refresh Error:", e);
        setStatus('REFRESH FAILED', 'error');
        alert("Failed to refresh data. Please check your internet connection.");
        filter(); // Restore the view safely with whatever existing data we still have
    }
}

// --- FILTER CAROUSEL ARROWS & CONTROLS ---
function scrollFilters(direction) {
    const fc = document.getElementById('filterControls');
    if (!fc) return;
    const scrollAmount = Math.max(180, Math.floor(fc.clientWidth * 0.75));
    fc.scrollBy({ left: direction * scrollAmount, behavior: 'smooth' });
    setTimeout(updateFilterScrollButtons, 300);
}

function updateFilterScrollButtons() {
    const fc = document.getElementById('filterControls');
    const leftBtn = document.getElementById('filterNavLeft');
    const rightBtn = document.getElementById('filterNavRight');
    if (!fc || !leftBtn || !rightBtn) return;
    
    // Check if controls overflow horizontally
    const canScroll = fc.scrollWidth > (fc.clientWidth + 6);
    if (!canScroll) {
        leftBtn.classList.add('nav-hidden');
        rightBtn.classList.add('nav-hidden');
        return;
    }
    
    leftBtn.classList.remove('nav-hidden');
    rightBtn.classList.remove('nav-hidden');
    
    const isAtStart = fc.scrollLeft <= 5;
    const isAtEnd = Math.ceil(fc.scrollLeft + fc.clientWidth) >= (fc.scrollWidth - 6);
    
    leftBtn.disabled = isAtStart;
    leftBtn.classList.toggle('nav-disabled', isAtStart);
    rightBtn.disabled = isAtEnd;
    rightBtn.classList.toggle('nav-disabled', isAtEnd);
}

function clearSearch() {
    const qEl = document.getElementById('q');
    const clearBtn = document.getElementById('clearSearchBtn');
    if (qEl) qEl.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
    filter();
}

function updateExtentStyle() {
    const extCheckbox = document.getElementById('fExtent');
    const extLabel = document.getElementById('extentToggleLabel');
    const extTag = document.getElementById('extentNearbyTag');
    if (extCheckbox && extLabel) {
        extLabel.classList.toggle('is-active', extCheckbox.checked);
        if (!extCheckbox.checked) {
            filterByGpsRadius = false;
            const toggleRadiusBtn = document.getElementById('gpsToggleRadiusBtn');
            if (toggleRadiusBtn) {
                toggleRadiusBtn.innerText = '3km Only: OFF';
                toggleRadiusBtn.classList.add('is-off');
            }
            if (extTag) extTag.style.display = 'none';
        }
    }
}

function updateActiveFilterBadge() {
    const qVal = document.getElementById('q')?.value?.trim();
    const fYVal = document.getElementById('fY')?.value;
    const fRVal = document.getElementById('fR')?.value;
    const fPVal = document.getElementById('fP')?.value;
    const fTVal = document.getElementById('fT')?.value;
    const fGSVal = document.getElementById('fGS')?.value;
    const fImgVal = document.getElementById('fImg')?.value;
    const fGPSVal = document.getElementById('fGPS')?.value;
    const extVal = document.getElementById('fExtent')?.checked;
    
    let count = 0;
    if (qVal) count++;
    if (fYVal) count++;
    if (fRVal) count++;
    if (fPVal) count++;
    if (fTVal) count++;
    if (fGSVal) count++;
    if (fImgVal) count++;
    if (fGPSVal) count++;
    if (extVal) count++;
    
    const badge = document.getElementById('activeFilterBadge');
    if (badge) {
        if (count > 0) {
            badge.innerText = `${count} ACTIVE`;
            badge.style.display = 'inline-block';
        } else {
            badge.style.display = 'none';
        }
    }
}

// --- FILTER CONTROLS & DEBOUNCING ---
function debounce(func, timeout = 300) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => { func.apply(this, args); }, timeout);
    };
}

function toggleFilters() {
    const fc = document.getElementById('filterControls');
    const btn = document.getElementById('filterToggleBtn');
    const wrapper = document.getElementById('filterCarouselWrapper');
    
    const isHidden = fc.classList.toggle('hidden-view');
    if (wrapper) wrapper.classList.toggle('hidden-view', isHidden);
    if (btn) btn.classList.toggle('is-collapsed', isHidden);
    
    setTimeout(() => {
        map.invalidateSize();
        updateFilterScrollButtons();
    }, 350);
}

function initFilters() {
    const qInput = document.getElementById('q');
    const clearBtn = document.getElementById('clearSearchBtn');
    
    if (qInput) {
        qInput.addEventListener('input', () => {
            if (clearBtn) clearBtn.style.display = qInput.value.trim() ? 'block' : 'none';
        });
        qInput.addEventListener('input', debounce(() => filter(), 300));
    }
    
    ['fY', 'fR'].forEach(id => document.getElementById(id)?.addEventListener('change', () => { 
        updateDropdownOptions(); 
        filter(); 
    }));
    ['fP', 'fT', 'fGS', 'fImg', 'fGPS'].forEach(id => document.getElementById(id)?.addEventListener('change', filter));
    
    window.addEventListener('resize', debounce(updateFilterScrollButtons, 150));
    window.addEventListener('orientationchange', () => setTimeout(updateFilterScrollButtons, 200));
    
    updateDropdownOptions();
    setTimeout(updateFilterScrollButtons, 200);
}

function updateDropdownOptions() {
    populateDropdown('fY', 'year', 'All Years', db, true);
    const timeFiltered = getFilteredData(true);
    const reg = document.getElementById('fR').value;
    
    populateDropdown('fR', 'REGION', 'All Regions', timeFiltered);
    populateDropdown('fT', 'LSTRIGGER', 'All Triggers', timeFiltered);
    populateDropdown('fP', 'PROVINCE', 'All Provinces', reg ? timeFiltered.filter(i => i.REGION === reg) : timeFiltered);
    populateDropdown('fGS', 'GENERALSOURCES', 'All Sources', timeFiltered);
}

function populateDropdown(id, key, label, data, sortDesc = false) {
    const el = document.getElementById(id);
    if (!el) return;
    const cur = el.value;
    
    let items = [...new Set(data.map(i => i[key]))].filter(v => v && v !== 'Unknown' && String(v).trim() !== '').sort();
    if (sortDesc) items.reverse();
    if (data.some(i => i[key] === 'Unknown')) items.push('Unknown');
    
    el.innerHTML = `<option value="">${label}</option>` + items.map(v => `<option value="${v}">${v}</option>`).join('');
    if (items.includes(cur)) el.value = cur;
}

function getFilteredData(onlyYear = false) {
    const fY = document.getElementById('fY') ? document.getElementById('fY').value : '';
    
    let res = db.filter(i => !fY || i.year === fY);
    if (onlyYear) return res;
    
    const qEl = document.getElementById('q');
    const q = qEl ? qEl.value.toLowerCase().trim() : '';
    
    const fExtent = document.getElementById('fExtent');
    const applyExtent = fExtent ? fExtent.checked : false;
    let bounds = null;
    if (applyExtent) bounds = map.getBounds();

    const fR = document.getElementById('fR') ? document.getElementById('fR').value : '';
    const fP = document.getElementById('fP') ? document.getElementById('fP').value : '';
    const fT = document.getElementById('fT') ? document.getElementById('fT').value : '';
    const fGS = document.getElementById('fGS') ? document.getElementById('fGS').value : '';
    const fImg = document.getElementById('fImg') ? document.getElementById('fImg').value : '';
    const fGPS = document.getElementById('fGPS') ? document.getElementById('fGPS').value : '';

    let filtered = res.filter(i => 
        (!applyExtent || (i.lat !== null && i.lng !== null && bounds.contains([i.lat, i.lng]))) &&
        (!filterByGpsRadius || !userGpsCoords || (i.lat !== null && i.lng !== null && !isNaN(i.lat) && !isNaN(i.lng) && userGpsCoords.distanceTo([i.lat, i.lng]) <= 3000)) &&
        (!q || i.searchStr.includes(q)) && 
        (!fR || i.REGION === fR) &&
        (!fP || i.PROVINCE === fP) &&
        (!fT || i.LSTRIGGER === fT) &&
        (!fGS || i.GENERALSOURCES === fGS) &&
        (!fImg || (fImg === 'yes' ? (i.IMAGELINK && String(i.IMAGELINK).trim() !== '') : (!i.IMAGELINK || String(i.IMAGELINK).trim() === ''))) &&
        (!fGPS || (fGPS === 'yes' ? (i.lat !== null && i.lng !== null) : (i.lat === null || i.lng === null)))
    );

    // If 3km radius filter is active, sort by distance ascending (nearest first)
    if (filterByGpsRadius && userGpsCoords) {
        filtered.sort((a, b) => {
            const da = (a.lat !== null && a.lng !== null) ? userGpsCoords.distanceTo([a.lat, a.lng]) : Infinity;
            const dbDist = (b.lat !== null && b.lng !== null) ? userGpsCoords.distanceTo([b.lat, b.lng]) : Infinity;
            return da - dbDist;
        });
    }

    return filtered;
}

// --- DATA EXPORTS (CSV & GeoJSON) ---
function downloadCSV() {
    if (!currentFilteredData || currentFilteredData.length === 0) {
        alert("No data available to download based on your current filters.");
        return;
    }
    
    const excludedKeys = ['searchStr', 'lat', 'lng', 'year']; 
    const headers = Object.keys(currentFilteredData[0]).filter(k => !excludedKeys.includes(k));

    let csvContent = headers.join(",") + "\n";

    currentFilteredData.forEach(row => {
        let rowData = headers.map(header => {
            let val = row[header] === null || row[header] === undefined ? "" : String(row[header]);
            val = val.replace(/"/g, '""');
            if (val.search(/("|,|\n)/g) >= 0) val = `"${val}"`;
            return val;
        });
        csvContent += rowData.join(",") + "\n";
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", "LIGTAS_Filtered_Database.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function downloadGeoJSON() {
    if (!currentFilteredData || currentFilteredData.length === 0) {
        alert("No data available to export to GeoJSON.");
        return;
    }

    const features = currentFilteredData.map(row => {
        let props = { ...row };
        delete props.searchStr;
        
        let geometry = null;
        if (row.lat !== null && row.lng !== null && !isNaN(row.lat) && !isNaN(row.lng)) {
            geometry = {
                "type": "Point",
                "coordinates": [row.lng, row.lat]
            };
        }

        return {
            "type": "Feature",
            "geometry": geometry,
            "properties": props
        };
    });

    const geojson = {
        "type": "FeatureCollection",
        "features": features
    };

    const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/geo+json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", "LIGTAS_Filtered_Database.geojson");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// --- PAGINATION & LIST RENDERER ---
function filter() {
    if (!db || db.length === 0) return; 
    currentFilteredData = getFilteredData();
    const countText = (filterByGpsRadius && userGpsCoords) 
        ? `${currentFilteredData.length} LANDSLIDES WITHIN 3KM` 
        : `${currentFilteredData.length} RECORDS MATCHED`;
    document.getElementById('rec-count').innerText = countText;
    
    updateActiveFilterBadge();
    updateExtentStyle();
    
    currentPage = 1; 
    renderPaginatedList();
    buildCharts(currentFilteredData);
    updateFilterScrollButtons();
}

function changePage(direction) {
    currentPage += direction;
    const feed = document.getElementById('feed');
    if (feed) feed.scrollTop = 0;
    renderPaginatedList();
}

function renderPaginatedList() {
    markers.clearLayers();
    const feedEl = document.getElementById('feed');
    const paginationEl = document.getElementById('paginationControls');

    if (currentFilteredData.length === 0) {
        if (filterByGpsRadius && userGpsCoords) {
            feedEl.innerHTML = `
                <div style="padding:40px; text-align:center; color:var(--text-muted); width:100%;">
                    <div style="margin-bottom:12px; color:var(--accent);">
                        <svg class="app-icon app-icon-lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle><line x1="12" y1="12" x2="19" y2="5"></line></svg>
                    </div>
                    <div style="font-size:16px; font-weight:800; color:var(--text); margin-bottom:6px;">No Landslides Within 3 km Radius</div>
                    <div style="font-size:13px; max-width:440px; margin:0 auto; line-height:1.5;">There are no historical landslide events recorded within 3.0 km of your GPS location. Click "3km Only: OFF" or pan the map to explore surrounding areas.</div>
                </div>
            `;
        } else {
            feedEl.innerHTML = '<div style="padding:40px; text-align:center; font-size:18px; font-weight:bold; color:var(--text-muted); width:100%;">No records found. Adjust your filters or map.</div>';
        }
        paginationEl.innerHTML = '';
        return;
    }

    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const pageData = currentFilteredData.slice(startIndex, endIndex);
    const totalPages = Math.ceil(currentFilteredData.length / ITEMS_PER_PAGE);

    // When 3km filter is active, plot all 3km points on the map so none are omitted
    const mapMarkersData = filterByGpsRadius ? currentFilteredData : pageData;
    mapMarkersData.forEach(i => {
        if(i.lat && i.lng) {
            const isRadarBlip = filterByGpsRadius && userGpsCoords && userGpsCoords.distanceTo([i.lat, i.lng]) <= 3000;
            L.circleMarker([i.lat, i.lng], {
                radius: isRadarBlip ? 9 : 8,
                fillColor: i.deaths > 0 ? '#ef4444' : '#f59e0b',
                color: '#ffffff',
                weight: isRadarBlip ? 2.5 : 1,
                fillOpacity: 0.95,
                className: isRadarBlip ? 'radar-blip-marker' : ''
            }).addTo(markers).on('click', () => openReport(i));
        }
    });

    feedEl.innerHTML = pageData.map(i => {
        const safeStringify = encodeURIComponent(JSON.stringify(i)).replace(/'/g, "%27");
        
        const hasGPS = (i.lat !== null && i.lng !== null);
        const gpsBadge = hasGPS 
            ? `<span class="lr-status-badge badge-gps"><svg class="app-icon app-icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>GPS</span>`
            : `<span class="lr-status-badge badge-nogps"><svg class="app-icon app-icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path></svg>NO GPS</span>`;

        const hasImg = (i.IMAGELINK && String(i.IMAGELINK).trim() !== '');
        const imgBadge = hasImg 
            ? `<span class="lr-status-badge badge-img"><svg class="app-icon app-icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>IMAGE</span>`
            : `<span class="lr-status-badge badge-noimg"><svg class="app-icon app-icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>NO IMG</span>`;

        let distBadge = '';
        if (filterByGpsRadius && userGpsCoords && hasGPS) {
            const d = userGpsCoords.distanceTo([i.lat, i.lng]);
            const dStr = d >= 1000 ? (d / 1000).toFixed(2) + ' km' : Math.round(d) + ' m';
            distBadge = `<span class="lr-status-badge badge-dist" title="${Math.round(d)} meters from your GPS location"><svg class="app-icon app-icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>${dStr}</span>`;
        }

        return `
            <div class="list-row ${i.deaths > 0 ? 'high-risk' : ''}" onclick="openReport(JSON.parse(decodeURIComponent('${safeStringify}')))">
                <div class="lr-id">${i.LSID || 'N/A'}</div>
                <div class="lr-date">${i.YYYYMMDD || 'Unknown'}</div>
                <div class="lr-col lr-loc">
                    ${i.MUNICIPALITY || 'Unknown'}, ${i.PROVINCE || 'Unknown'}
                    <div style="margin-top:6px; display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
                        ${distBadge} ${gpsBadge} ${imgBadge}
                    </div>
                </div>
                <div class="lr-col"><span class="lr-trig">${i.LSTRIGGER || 'Registry Entry'}</span></div>
                ${i.deaths > 0 ? `<div class="lr-badge"><svg class="app-icon app-icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>${i.deaths} FATALITIES</div>` : ''}
            </div>
        `;
    }).join('');

    paginationEl.innerHTML = `
        <button class="btn btn-sec btn-sm" ${currentPage === 1 ? 'disabled' : ''} onclick="changePage(-1)" style="width: auto;">
            <svg class="app-icon app-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
            Prev
        </button>
        <span style="font-weight: 800; color: var(--primary);">Page ${currentPage} of ${totalPages}</span>
        <button class="btn btn-sec btn-sm" ${currentPage === totalPages ? 'disabled' : ''} onclick="changePage(1)" style="width: auto;">
            Next
            <svg class="app-icon app-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </button>
    `;
}

// --- UX LOGIC & ANIMATIONS ---
function flyToLocation(i) {
    if (i.lat !== null && i.lng !== null) {
        closeModal();
        const mapDiv = document.getElementById('map');
        if (mapDiv.classList.contains('hidden-view')) toggleView('split');
        
        map.flyTo([i.lat, i.lng], 14, { animate: true, duration: 1.5 });
        const ping = L.circleMarker([i.lat, i.lng], { radius: 30, color: '#10b981', fillColor: '#10b981', fillOpacity: 0.3, weight: 3 }).addTo(map);
        setTimeout(() => { if (map.hasLayer(ping)) map.removeLayer(ping); }, 3000);
    } else {
        alert("Cannot locate: This record does not have valid GPS coordinates.");
    }
}

function setViewMode(viewType) {
    const mapDiv = document.getElementById('map');
    const feedDiv = document.getElementById('feed');
    const pagDiv = document.getElementById('paginationControls');

    ['viewBtnMap', 'viewBtnSplit', 'viewBtnList'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.classList.remove('active');
    });

    if (viewType === 'map') {
        mapDiv.classList.remove('hidden-view'); 
        mapDiv.classList.add('full-map'); 
        feedDiv.classList.add('hidden-view'); 
        pagDiv.classList.add('hidden-view');
        document.getElementById('viewBtnMap')?.classList.add('active');
    } else if (viewType === 'list') {
        mapDiv.classList.add('hidden-view'); 
        mapDiv.classList.remove('full-map'); 
        feedDiv.classList.remove('hidden-view'); 
        pagDiv.classList.remove('hidden-view');
        document.getElementById('viewBtnList')?.classList.add('active');
    } else { // split
        mapDiv.classList.remove('hidden-view', 'full-map'); 
        feedDiv.classList.remove('hidden-view'); 
        pagDiv.classList.remove('hidden-view');
        document.getElementById('viewBtnSplit')?.classList.add('active');
    }
    
    if (!mapDiv.classList.contains('hidden-view')) {
        setTimeout(() => map.invalidateSize(), 300);
    }
}

function toggleView(viewType) {
    setViewMode(viewType);
}

// --- MODALS ---
function openCharts() { document.getElementById('chartModal').style.display = 'flex'; }
function closeCharts() { document.getElementById('chartModal').style.display = 'none'; }
function closeModal() { document.getElementById('dataModal').style.display = 'none'; }
function openAbout() { document.getElementById('aboutModal').style.display = 'flex'; }
function closeAbout() { document.getElementById('aboutModal').style.display = 'none'; }

// --- STARTUP GPS PROMPT MODAL ---
function showGpsStartupPrompt() {
    const modal = document.getElementById('gpsStartupPromptModal');
    if (modal) modal.style.display = 'flex';
}

function dismissGpsPrompt() {
    const modal = document.getElementById('gpsStartupPromptModal');
    if (modal) modal.style.display = 'none';
}

function confirmGpsScan() {
    dismissGpsPrompt();
    locateUser();
}

function openReport(i) {
    if(!i) return;
    const b = document.getElementById('m-body');
    const row = (l, v) => `<div class="field-grp"><div class="f-lbl">${l}</div><div class="f-val">${v || '—'}</div></div>`;
    
    const safeStringify = encodeURIComponent(JSON.stringify(i)).replace(/'/g, "%27");
    
    b.innerHTML = `
        <div class="report-header">
            <div>
                <div style="font-size:12px; font-weight:900; color:var(--accent); letter-spacing: 1px; margin-bottom:5px;">LSID: ${i.LSID || 'N/A'}</div>
                <h2>${i.MUNICIPALITY || 'Unknown Area'} Landslide</h2>
                <div class="report-meta">
                    ${i.PROVINCE || '—'} | ${i.REGION || '—'} | Date: ${i.YYYYMMDD || 'Unknown'} at ${i['12HOURFO'] || '—'} ${i.AMPM || ''}
                </div>
            </div>
            ${(i.lat !== null && i.lng !== null) ? 
                `<div style="display:flex; gap:8px; flex-wrap:wrap;">
                    <button class="btn btn-main no-print btn-sm" style="white-space:nowrap; width:auto;" onclick="flyToLocation(JSON.parse(decodeURIComponent('${safeStringify}')))">
                        <svg class="app-icon app-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
                        Locate Map
                    </button>
                    <button class="btn btn-sec no-print btn-sm" style="white-space:nowrap; width:auto;" onclick="window.open('https://www.google.com/maps?q=${i.lat},${i.lng}', '_blank')">
                        <svg class="app-icon app-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"></polygon><line x1="8" y1="2" x2="8" y2="18"></line><line x1="16" y1="6" x2="16" y2="22"></line></svg>
                        Google Maps
                    </button>
                 </div>` 
                : '<span class="no-gps-badge no-print">NO GPS DATA</span>'}
        </div>

        <div class="sec-title">A. Spatial Geography</div>
        <div class="grid-2">
            ${row('Coordinates', (i.lat !== null && i.lng !== null) ? `${i.lat}, ${i.lng}` : 'Unmapped')} ${row('Precision', i.LATLONGR)}
            ${row('Barangay', i.BARANGAY)} ${row('Sitio', i.SITIO)}
            ${row('Elevation', i.ELEVATION)} ${row('Accessibility', i.ACCESIBILITY)}
            ${row('Topography/Location Details', i.LSLOCDETAILS)}
        </div>

        <div class="sec-title">B. Technical Characteristics</div>
        <div class="grid-2">
            ${row('Trigger Event (LSTRIGGER)', i.LSTRIGGER)} ${row('Category (LSCATEGORY)', i.LSCATEGORY)}
            ${row('Dimensions (H x L x W)', `${i.HeightTaas || 0}m x ${i.LengthHaba || 0}m x ${i.WidthLapad || 0}m`)}
            ${row('Land Cover', i.LANDCOVER)}
            ${row('AWS Data Link', i.AWSDATA)} ${row('Other Land Features', i.OTHERLAND)}
        </div>
        <div style="margin-top:15px;">${row('Additional Information', i.OTHERINFO)}</div>

        <div class="sec-title">C. Casualties & Impact</div>
        <div class="grid-2">
            ${row('DEATHS', i.deaths)} ${row('INJURED', i.injured)}
            ${row('Displaced Persons', i.displaced)} ${row('Evacuation Site', i.EVACUATIONSITE)}
        </div>

        <div class="sec-title">D. Verification & Sources</div>
        <div class="grid-2">
            ${row('General Source', i.GENERALSOURCES)} ${row('Specific Source', i.SPECIFICSOURCE)}
            ${row('External Link', i.SOURCELINK ? `<a href="${i.SOURCELINK}" target="_blank" style="color:var(--accent); text-decoration:underline;">Open Official Source</a>` : '—')}
            ${row('Date/Time Recorded', i.DATETIMERECORDED)}
        </div>
        
        <div class="report-remarks">
            ${row('Analyst/Encoder Remarks', i.DATETIMEREMARKS)}
            <div class="encoder-meta">Encoded by: ${i.ENCODERNAME || 'N/A'} | Timestamp: ${i.TIMESTAMP || 'N/A'}</div>
        </div>

        ${i.IMAGELINK ? `<div class="sec-title">E. Site Imagery</div><img src="${i.IMAGELINK}" class="report-img">` : ''}
        
        <div class="print-only">
            This report is gathered by project LIGTAS-AGAD (Funded by DOST monitored by PCIEERD | Implemented by UPLB-SESAM).
        </div>
    `;
    
    document.getElementById('dataModal').style.display = 'flex';
}

// --- DYNAMIC ANALYTICS ENGINE ---
function computeAllTimeMetrics() {
    allTimeMetrics = { 
        coords:{'Has GPS':0,'No GPS':0}, loc:{'Has Location':0,'No Location':0}, 
        date:{'Has Date':0,'Unknown Date':0}, time:{'Has Time':0,'No Time':0},
        trigger:{'Has Data':0,'No Data':0}, category:{'Has Data':0,'No Data':0}
    };
    db.forEach(i => {
        i.lat ? allTimeMetrics.coords['Has GPS']++ : allTimeMetrics.coords['No GPS']++;
        (i.PROVINCE||i.MUNICIPALITY) ? allTimeMetrics.loc['Has Location']++ : allTimeMetrics.loc['No Location']++;
        (i.YYYYMMDD && i.year !== 'Unknown') ? allTimeMetrics.date['Has Date']++ : allTimeMetrics.date['Unknown Date']++;
        (i['12HOURFO']) ? allTimeMetrics.time['Has Time']++ : allTimeMetrics.time['No Time']++;
        (i.LSTRIGGER && String(i.LSTRIGGER).trim() !== '' && i.LSTRIGGER !== 'Unspecified') ? allTimeMetrics.trigger['Has Data']++ : allTimeMetrics.trigger['No Data']++;
        (i.LSCATEGORY && String(i.LSCATEGORY).trim() !== '' && i.LSCATEGORY !== 'Unspecified') ? allTimeMetrics.category['Has Data']++ : allTimeMetrics.category['No Data']++;
    });
}

function buildCharts(data) {
    if (!data) return;
    const totalEl = document.getElementById('totalReportCount');
    if(totalEl) totalEl.innerText = `ANALYZING ${data.length} MATCHING RECORDS`;
    
    ['year','prov','trig','genSrc','specSrc'].forEach(id => charts['chart'+id.charAt(0).toUpperCase()+id.slice(1)]?.destroy());

    const c = { year:{}, prov:{}, trig:{}, genSrc:{}, specSrc:{} };
    data.forEach(i => {
        if(i.year !== 'Unknown') c.year[i.year] = (c.year[i.year]||0)+1;
        if(i.PROVINCE) c.prov[i.PROVINCE] = (c.prov[i.PROVINCE]||0)+1;
        c.trig[i.LSTRIGGER||'Unspecified'] = (c.trig[i.LSTRIGGER||'Unspecified']||0)+1;
        c.genSrc[i.GENERALSOURCES||'N/A'] = (c.genSrc[i.GENERALSOURCES||'N/A']||0)+1;
        c.specSrc[i.SPECIFICSOURCE||'N/A'] = (c.specSrc[i.SPECIFICSOURCE||'N/A']||0)+1;
    });

    const currentTheme = document.documentElement.getAttribute('data-theme') || 'standard';
    let labelColor;
    if(currentTheme === 'neon') labelColor = '#00f2fe';
    else if(currentTheme === 'environmental') labelColor = '#432418';
    else if(currentTheme === 'dark') labelColor = '#cbd5e1';
    else labelColor = '#0a5c6d';
    
    let borderColor = currentTheme === 'dark' || currentTheme === 'neon' ? '#1e293b' : '#ffffff';

    const createScrollableBar = (id, obj, color) => {
        let ent = Object.entries(obj).sort((a,b)=>b[1]-a[1]);
        const el = document.getElementById(id);
        const wrapper = document.getElementById('wrap-' + id);
        if(!el || !wrapper) return;
        wrapper.style.height = Math.max(300, ent.length * 35) + 'px';
        charts[id] = new Chart(el, { 
            type:'bar', data: { labels: ent.map(x=>x[0]), datasets: [{data: ent.map(x=>x[1]), backgroundColor: color, borderRadius: 4}] }, 
            options: { maintainAspectRatio: false, indexAxis:'y', plugins: { legend: {display:false}, datalabels: {color: labelColor, anchor:'end', align:'right', font: {weight:'bold', size:12}, formatter: v => v>0?v:''} }, layout: {padding: {right: 40}}, scales: { y: { ticks: { font: {weight:'bold'} } } } } 
        });
    };

    const createDonut = (id, obj, colors, hide) => {
        const el = document.getElementById(id);
        if(!el) return;
        charts[id] = new Chart(el, { 
            type:'doughnut', data: { labels: Object.keys(obj), datasets: [{ data: Object.values(obj), backgroundColor: colors, borderColor: borderColor }] }, 
            options: { maintainAspectRatio: false, plugins: { legend: hide?{display:false}:{position:'bottom', labels: {font: {size:12, weight:'bold'}}}, datalabels: hide?{display:false}:{color:'#fff', font: {weight:'bold', size:12}, textAlign:'center', formatter:(v,c)=>{if(v===0)return''; let s=0; c.chart.data.datasets[0].data.map(d=>s+=d); return `${v}\n(${(v*100/s).toFixed(1)}%)`}} } } 
        });
    };

    const elYear = document.getElementById('chartYear');
    if(elYear) charts['chartYear'] = new Chart(elYear, { type:'bar', data: { labels: Object.keys(c.year).sort(), datasets: [{data: Object.values(c.year), backgroundColor: '#0a5c6d', borderRadius: 4}] }, options: { maintainAspectRatio: false, plugins: {legend:{display:false}, datalabels: {color: labelColor, anchor:'end', align:'top', font:{weight:'bold', size:13}, formatter:v=>v>0?v:''}}, layout:{padding:{top:25}}, scales: { x: { ticks: { font: {weight:'bold'} } } } } });
    
    createScrollableBar('chartProv', c.prov, '#eab308');
    createScrollableBar('chartGenSrc', c.genSrc, '#0e7490');
    createScrollableBar('chartSpecSrc', c.specSrc, '#ea580c');
    
    let trigsSorted = Object.entries(c.trig).sort((a,b)=>b[1]-a[1]);
    let sortedTrigObj = {}; trigsSorted.forEach(item => sortedTrigObj[item[0]] = item[1]);
    const trigPalette = ['#0a5c6d','#eab308','#0284c7','#10b981','#6366f1','#8b5cf6','#ec4899','#14b8a6','#f43f5e', '#64748b', '#06b6d4'];
    
    createDonut('chartTrig', sortedTrigObj, trigPalette, true);

    const tBody = document.getElementById('tableTrig');
    if(tBody) {
        let tot = Object.values(c.trig).reduce((a, b) => a + b, 0);
        tBody.innerHTML = `<div class="table-responsive"><table class="stats-table"><thead><tr><th style="padding:10px;">Trigger Event (LSTRIGGER)</th><th style="padding:10px; text-align:center;">Count</th><th style="padding:10px; text-align:center;">Share</th></tr></thead><tbody>` + 
        trigsSorted.map((item, i) => `<tr><td style="display:flex; align-items:center; gap:8px;"><span style="width:12px; height:12px; background:${trigPalette[i%trigPalette.length]}; border-radius:50%; display:inline-block; flex-shrink:0;"></span><span style="line-height:1.3;">${item[0]}</span></td><td style="text-align:center; font-weight:900; color:#fef08a; font-size:14px;">${item[1]}</td><td style="text-align:center; color:var(--text-muted);">${tot>0?((item[1]/tot)*100).toFixed(1)+'%':'0%'}</td></tr>`).join('') + `</tbody></table></div>`;
    }

    if (!allTimeChartsRendered && allTimeMetrics) {
        createDonut('chartCoords', allTimeMetrics.coords, ['#0a5c6d','#eab308']);
        createDonut('chartLoc', allTimeMetrics.loc, ['#0a5c6d','#eab308']);
        createDonut('chartDate', allTimeMetrics.date, ['#0a5c6d','#eab308']);
        createDonut('chartTime', allTimeMetrics.time, ['#0a5c6d','#eab308']);
        createDonut('chartCompletenessTrig', allTimeMetrics.trigger, ['#0a5c6d','#eab308']);
        createDonut('chartCompletenessCat', allTimeMetrics.category, ['#0a5c6d','#eab308']);
        allTimeChartsRendered = true;
    }
}

// --- UTILITIES ---
function downloadChart(id, name) {
    const canvas = document.getElementById(id), temp = document.createElement('canvas');
    if(!canvas) return;
    temp.width = canvas.width; temp.height = canvas.height;
    const ctx = temp.getContext('2d'); 
    ctx.fillStyle = document.documentElement.getAttribute('data-theme') === 'dark' ? '#1e293b' : '#ffffff'; 
    ctx.fillRect(0,0,temp.width,temp.height); ctx.drawImage(canvas,0,0);
    const link = document.createElement('a'); link.download = name+'.png'; link.href = temp.toDataURL('image/png'); link.click();
}

function setStatus(msg, type) { 
    const txt = document.getElementById('sys-text');
    const pulse = document.getElementById('sys-pulse');
    if (txt) txt.innerText = msg; 
    if (pulse) pulse.className = `pulse ${type}`; 
}

function locateUser() {
    setStatus('SEARCHING GPS...', 'warning');
    const mapDiv = document.getElementById('map');
    if (mapDiv && mapDiv.classList.contains('hidden-view')) {
        setViewMode('split');
    }
    // Activate Map Extent and 3km Radius filter immediately when GPS is triggered
    filterByGpsRadius = true;
    const extToggle = document.getElementById('fExtent');
    if (extToggle) {
        extToggle.checked = true;
        updateExtentStyle();
        updateActiveFilterBadge();
    }
    map.locate({setView: false, maxZoom: 15, enableHighAccuracy: true});
}

function createRadarSvgOverlay(bounds) {
    if (radarSvgOverlay && map && map.hasLayer(radarSvgOverlay)) {
        map.removeLayer(radarSvgOverlay);
        radarSvgOverlay = null;
    }

    const svgEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svgEl.setAttribute('xmlns', "http://www.w3.org/2000/svg");
    svgEl.setAttribute('viewBox', "0 0 400 400");
    svgEl.setAttribute('class', "radar-map-overlay");
    svgEl.style.pointerEvents = 'none';

    svgEl.innerHTML = `
        <defs>
            <clipPath id="radarSweepClip">
                <circle cx="200" cy="200" r="196" />
            </clipPath>
            <radialGradient id="radarSweepGrad" cx="100%" cy="50%" r="100%">
                <stop offset="0%" stop-color="#eab308" stop-opacity="0.55" />
                <stop offset="50%" stop-color="#eab308" stop-opacity="0.2" />
                <stop offset="100%" stop-color="#eab308" stop-opacity="0.0" />
            </radialGradient>
        </defs>

        <!-- Shaded radar background tint -->
        <circle cx="200" cy="200" r="196" fill="rgba(10, 92, 109, 0.08)" />

        <!-- 1 KM & 2 KM Range Rings -->
        <circle cx="200" cy="200" r="65.3" fill="none" stroke="rgba(234, 179, 8, 0.45)" stroke-width="1.2" stroke-dasharray="3, 4" />
        <circle cx="200" cy="200" r="130.6" fill="none" stroke="rgba(234, 179, 8, 0.5)" stroke-width="1.2" stroke-dasharray="4, 5" />

        <!-- Crosshair Axes -->
        <line x1="200" y1="4" x2="200" y2="396" stroke="rgba(234, 179, 8, 0.35)" stroke-width="1.2" stroke-dasharray="4, 4" />
        <line x1="4" y1="200" x2="396" y2="200" stroke="rgba(234, 179, 8, 0.35)" stroke-width="1.2" stroke-dasharray="4, 4" />

        <!-- Range Labels -->
        <text x="204" y="262" fill="#eab308" font-size="8.5" font-weight="900" letter-spacing="0.5" opacity="0.9">1 KM</text>
        <text x="204" y="327" fill="#eab308" font-size="8.5" font-weight="900" letter-spacing="0.5" opacity="0.9">2 KM</text>
        <text x="204" y="392" fill="#eab308" font-size="8.5" font-weight="900" letter-spacing="0.5" opacity="0.95">3 KM</text>
        <text x="200" y="16" fill="#eab308" font-size="10" font-weight="900" text-anchor="middle" opacity="0.95">N</text>

        <!-- Pulsating Radar Sonar Wave Rings -->
        <g clip-path="url(#radarSweepClip)">
            <circle cx="200" cy="200" r="0" fill="none" stroke="#eab308" stroke-width="2" opacity="0.8">
                <animate attributeName="r" from="0" to="196" dur="3s" repeatCount="indefinite" />
                <animate attributeName="opacity" from="0.9" to="0" dur="3s" repeatCount="indefinite" />
            </circle>
            <circle cx="200" cy="200" r="0" fill="none" stroke="#eab308" stroke-width="1.5" opacity="0.8">
                <animate attributeName="r" from="0" to="196" begin="1.5s" dur="3s" repeatCount="indefinite" />
                <animate attributeName="opacity" from="0.9" to="0" dur="3s" repeatCount="indefinite" />
            </circle>

            <!-- Rotating Radar Sweep Beam -->
            <g>
                <animateTransform attributeName="transform" type="rotate" from="0 200 200" to="360 200 200" dur="3.5s" repeatCount="indefinite" />
                <!-- 50-degree trailing gradient sector -->
                <path d="M 200 200 L 396 200 A 196 196 0 0 0 326 50 Z" fill="url(#radarSweepGrad)" />
                <!-- Leading bright scanner line -->
                <line x1="200" y1="200" x2="396" y2="200" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" />
            </g>
        </g>

        <!-- Outer Marching-Ants Radar Range Perimeter -->
        <circle cx="200" cy="200" r="196" fill="none" stroke="#eab308" stroke-width="2.5" stroke-dasharray="6, 6">
            <animate attributeName="stroke-dashoffset" from="0" to="-24" dur="2s" repeatCount="indefinite" />
        </circle>
    `;

    radarSvgOverlay = L.svgOverlay(svgEl, bounds, {
        opacity: 0.95,
        interactive: false
    }).addTo(userLocationGroup);
}

function focusProximityZone() {
    if (currentProximityCircle) {
        map.fitBounds(currentProximityCircle.getBounds(), { padding: [25, 25], maxZoom: 14 });
    }
}

function toggleGpsRadiusFilter() {
    filterByGpsRadius = !filterByGpsRadius;
    const btn = document.getElementById('gpsToggleRadiusBtn');
    if (btn) {
        btn.innerText = filterByGpsRadius ? '3km Only: ON' : '3km Only: OFF';
        btn.classList.toggle('is-off', !filterByGpsRadius);
    }
    const extTag = document.getElementById('extentNearbyTag');
    if (extTag) {
        extTag.innerText = filterByGpsRadius ? `${currentNearbyCount} in 3km` : 'Extent';
    }
    if (radarSvgOverlay) {
        const el = radarSvgOverlay.getElement();
        if (el) el.style.display = filterByGpsRadius ? 'block' : 'none';
    }
    filter();
}

function closeProximityBanner() {
    const banner = document.getElementById('gpsProximityBanner');
    if (banner) banner.style.display = 'none';
}

function reset() {
    const qEl = document.getElementById('q');
    if (qEl) qEl.value = '';
    const clearBtn = document.getElementById('clearSearchBtn');
    if (clearBtn) clearBtn.style.display = 'none';

    ['fY', 'fR', 'fP', 'fT', 'fGS', 'fImg', 'fGPS'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    
    const extToggle = document.getElementById('fExtent');
    if (extToggle) extToggle.checked = false;
    
    closeProximityBanner();
    currentProximityCircle = null;
    currentNearbyCount = 0;
    userGpsCoords = null;
    filterByGpsRadius = false;
    radarSvgOverlay = null;

    const btn = document.getElementById('gpsToggleRadiusBtn');
    if (btn) {
        btn.innerText = '3km Only: ON';
        btn.classList.remove('is-off');
    }
    
    if (userLocationGroup) userLocationGroup.clearLayers();
    updateExtentStyle();
    map.setView(PH_CENTER, 5);
    updateDropdownOptions(); 
    filter(); 
}

window.onload = init;
