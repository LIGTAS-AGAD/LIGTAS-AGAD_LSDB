 let db = [];
        let map, markers, userMarker;
        let charts = {}; 
        const PH_CENTER = [12.8797, 121.7740];

        // --- CONFIGURATION ---
        // ⚠️ REPLACE THIS URL WITH YOUR SHEETLABS API ⚠️
        const API_URL = 'https://app.sheetlabs.com/LA25/LSDBAPI'; 
        
        const GEO_SOURCES = {
            provinces: 'https://raw.githubusercontent.com/Gabzrock/LIGTASAGADEWSV3/refs/heads/main/uRIL_AWS_High%20Susceptibility.geojson',
            regions: 'https://raw.githubusercontent.com/Gabzrock/LIGTASAGADEWSV3/refs/heads/main/uRIL_AWS_Moderate_Susceptibility.geojson',
            faults: 'https://raw.githubusercontent.com/Gabzrock/LIGTASAGADEWSV3/refs/heads/main/uRIL_AWS_Low_Susceptibility.geojson'
        };

        function setStatus(msg, type) {
            document.getElementById('sys-text').innerText = msg;
            document.getElementById('sys-pulse').className = `pulse ${type}`;
        }

        function init() {
            // 1. Initialize Map
            const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: 'Esri' });
            const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: 'OSM' });

            map = L.map('map', { center: PH_CENTER, zoom: 4, layers: [sat], zoomControl: false });

            // 2. Initialize Layer Groups (Hidden by Default)
            const lyProvinces = L.layerGroup();
            const lyRegions = L.layerGroup();
            const lyFaults = L.layerGroup();
            markers = L.layerGroup().addTo(map);

            // 3. Load GeoJSON Data Asynchronously
            const loadLayer = (url, group, style, name) => {
                fetch(url)
                    .then(r => { if(!r.ok) throw new Error(); return r.json(); })
                    .then(data => {
                        L.geoJson(data, {
                            style: style,
                            onEachFeature: (f, l) => {
                                let html = `<div style="font-size:12px; min-width:150px"><strong>${name}</strong><hr style="margin:4px 0; border:0; border-top:1px solid #ccc">`;
                                if(f.properties) {
                                    for(let k in f.properties) html += `<b>${k}:</b> ${f.properties[k]}<br>`;
                                }
                                l.bindPopup(html + '</div>');
                            }
                        }).addTo(group);
                    })
                    .catch(() => setStatus('LAYER LOAD ERROR', 'warning'));
            };

            loadLayer(GEO_SOURCES.provinces, lyProvinces, { color: 'red',fillOpacity:1.3 }, "MGB-HIGH");
            loadLayer(GEO_SOURCES.regions, lyRegions, { color: 'yellow',fillOpacity:1.3 }, "MGB-MED");
            loadLayer(GEO_SOURCES.faults, lyFaults, {color: 'green',fillOpacity:1.3 }, "MGB-LOW");

            // 4. Layer Control
            L.control.layers(
                { "Satellite View": sat, "Street Map": osm }, 
                { "Landslide Markers": markers, "MGB-HIGH": lyProvinces, "MGB-MED": lyRegions, "MGB-LOW": lyFaults }, 
                { collapsed: true }
            ).addTo(map);

            map.on('moveend', filter);
            connectRegistry();
        }

        async function connectRegistry() {
            setStatus('SYNCING DATA...', 'warning');
            try {
                const res = await fetch(API_URL);
                if(!res.ok) throw new Error("API Unreachable");
                
                let raw = await res.json();
                
                // Process Data: Parse Types & Extract Year
                db = raw.map(i => ({
                    ...i,
                    lat: parseFloat(i.latitude),
                    lng: parseFloat(i.longitude),
                    deaths: parseInt(i.DEATHS) || 0,
                    injured: parseInt(i["NO. OF PEOPLE INJURED"]) || 0,
                    displaced: parseInt(i["NO. OF PEOPLE DISPLACED"]) || 0,
                    year: i["YYYYMMDD"] ? i["YYYYMMDD"].substring(0, 4) : 'Unknown'
                })).sort((a, b) => new Date(b["YYYYMMDD"]) - new Date(a["YYYYMMDD"]));

                setStatus('SYSTEM ONLINE', 'online');
                initFilters();
                filter();
                buildCharts(); 
            } catch (e) {
                setStatus('CONNECTION FAILED', 'error');
                document.getElementById('feed').innerHTML = '<div style="padding:40px; text-align:center; color:#ef4444"><b>Network Error:</b> Could not reach database.</div>';
            }
        }

        // --- FILTER LOGIC ---
        function initFilters() {
            const setup = (id, key, label) => {
                const el = document.getElementById(id);
                // Create unique, sorted list of values
                const items = [...new Set(db.map(i => i[key]))].filter(v => v && v !== 'Unknown').sort();
                
                // Reverse sort for Years (Latest first)
                if(key === 'year') items.reverse();

                el.innerHTML = `<option value="">${label}</option>`;
                items.forEach(v => el.innerHTML += `<option value="${v}">${v}</option>`);
            };

            setup('fY', 'year', 'All Years');
            setup('fR', 'Region', 'All Regions');
            setup('fP', 'Province', 'All Provinces');
            setup('fT', 'LANDSLIDETRIGGERLocalNameInternlName', 'All Triggers');
        }

        function filter() {
            const q = document.getElementById('q').value.toLowerCase();
            const y = document.getElementById('fY').value;
            const r = document.getElementById('fR').value;
            const p = document.getElementById('fP').value;
            const t = document.getElementById('fT').value;
            const bounds = map.getBounds();

            const res = db.filter(i => {
                const textMatch = Object.values(i).join(' ').toLowerCase().includes(q);
                const yearMatch = !y || i.year === y;
                const regMatch = !r || i.Region === r;
                const provMatch = !p || i.Province === p;
                const trigMatch = !t || i['LANDSLIDETRIGGERLocalNameInternlName'] === t;
                const visMatch = (i.lat && i.lng) ? bounds.contains([i.lat, i.lng]) : false;
                
                return textMatch && yearMatch && regMatch && provMatch && trigMatch && visMatch;
            });

            renderList(res);
        }

        function renderList(data) {
            const feed = document.getElementById('feed');
            document.getElementById('rec-count').innerText = `${data.length} RECORDS IN VIEW`;
            markers.clearLayers();

            if(data.length === 0) {
                feed.innerHTML = '<div style="text-align:center; padding:40px; color:#94a3b8;">No records match your filters.</div>';
                return;
            }

            feed.innerHTML = data.map(i => {
                // Add Map Marker
                if(i.lat && i.lng) {
                    L.circleMarker([i.lat, i.lng], { 
                        radius: 8, color: '#fff', weight: 1, 
                        fillColor: i.deaths > 0 ? '#ef4444' : '#f59e0b', 
                        fillOpacity: 0.9 
                    }).addTo(markers).on('click', () => openReport(i));
                }

                // Render List Card
                return `
                    <div class="card ${i.deaths > 0 ? 'high-risk' : ''}" onclick='openReport(${JSON.stringify(i).replace(/'/g, "&apos;")})'>
                        <div class="card-head"><span>${i["LSIDNo"]}</span><span>${i["YYYYMMDD"]}</span></div>
                        <div class="card-title">${i.Municipality}, ${i.Province}</div>
                        <div class="card-meta">${i['LANDSLIDETRIGGERLocalNameInternlName'] || 'Registry Entry'}</div>
                        ${i.deaths > 0 ? `<div class="risk-badge">💀 ${i.deaths} FATALITIES</div>` : ''}
                    </div>
                `;
            }).join('');
        }

       // --- REPORTING SYSTEM ---
        function openReport(i) {
            const b = document.getElementById('m-body');
            const row = (l, v) => `<div class="field-grp"><div class="f-lbl">${l}</div><div class="f-val">${v || '—'}</div></div>`;
            
            b.innerHTML = `
                <div style="background:#f1f5f9; padding:20px; border-radius:8px; margin-bottom:25px; border:1px solid #e2e8f0;">
                    <h2 style="margin:0; color:var(--primary); font-size:22px;">${i.Municipality} Landslide</h2>
                    <div style="font-size:13px; color:#64748b; margin-top:5px;">
                        ${i.Province} | ${i.Region} | ${i["YYYY-MM-DD"]} at ${i["Time Recorded"]} ${i["AM/PM"]}
                    </div>
                </div>

                <div class="sec-title">A. Spatial Geography</div>
                <div class="grid-2">
                    ${row('Coordinates', `${i.lat}, ${i.lng}`)} ${row('Precision', i["EstimatedLocationExactlocationApproximatelocation"])}
                    ${row('Barangay', i.Barangay)} ${row('Sitio', i.Sitio)}
                    ${row('Topography', i["Detailed Location"])}
                </div>

                <div class="sec-title">B. Technical Characteristics</div>
                <div class="grid-2">
                    ${row('Trigger Event', i['LANDSLIDETRIGGERLocalNameInternlName'])} ${row('Classification', i["LANDSLIDECATEGORY"])}
                    ${row('Dimensions (H x L x W)', `${i["HeightTaasm"]}m x ${i["LengthHabam"]}m x ${i["WidthLapadm"]}m`)}
                    ${row('Land Cover', i["LANDCOVERAgricultureBareOpenAreaBuiltupRoadForest"])}
                </div>
                <div style="margin-top:10px;">${row('Landslide Report Information', i["MoreInformationEarthmaterialetc"])}</div>

                <div class="sec-title">C. Casualties & Impact</div>
                <div class="grid-2">
                    ${row('DEATHS', i.deaths)} ${row('NOOFPEOPLEINJURED', i.injured)}
                    ${row('Displaced Families', i.displaced)} ${row('Evacuation Site', i["evacuation site"])}
                </div>

                <div class="sec-title">D. Verification & Sources</div>
                ${row('Source Type', i["GENERALSOURCESExNewsNDRRMSLIGTASFieldworkMGBSocialMedia"])}
                ${row('External Link', i["SOURCELINK"] ? `<a href="${i["SOURCELINK"]}" target="_blank" style="color:var(--accent)">Open Official Source</a>` : '—')}
                <div style="margin-top:10px; padding:12px; background:#fff7ed; border-radius:6px; border:1px solid #ffedd5;">
                    ${row('Analyst Remarks', i["Information Remarks"])}
                </div>

                ${i.IMAGELINK ? `<div class="sec-title">E. Site Imagery</div><img src="${i.IMAGELINK}" style="width:100%; border-radius:8px; border:1px solid #cbd5e1; margin-top:10px;">` : ''}
            `;
            document.getElementById('dataModal').style.display = 'block';
        }

        // --- ANALYTICS ENGINE ---
        function buildCharts() {
            if(charts['year']) charts['year'].destroy();
            if(charts['prov']) charts['prov'].destroy();
            if(charts['trig']) charts['trig'].destroy();

            const counts = { year: {}, prov: {}, trig: {} };
            
            db.forEach(i => {
                if(i.year !== 'Unknown') counts.year[i.year] = (counts.year[i.year] || 0) + 1;
                if(i.Province) counts.prov[i.Province] = (counts.prov[i.Province] || 0) + 1;
                const t = i['LANDSLIDETRIGGERLocalNameInternlName'] || 'Unspecified';
                counts.trig[t] = (counts.trig[t] || 0) + 1;
            });

            const yKeys = Object.keys(counts.year).sort();
            charts['year'] = new Chart(document.getElementById('chartYear'), {
                type: 'bar',
                data: { labels: yKeys, datasets: [{ label: 'Incidents', data: yKeys.map(k=>counts.year[k]), backgroundColor: '#3b82f6', borderRadius: 4 }] },
                options: { responsive: true, plugins: { legend: {display:false} } }
            });

            const pSorted = Object.entries(counts.prov).sort((a,b) => b[1] - a[1]).slice(0, 10);
            charts['prov'] = new Chart(document.getElementById('chartProv'), {
                type: 'bar',
                data: { labels: pSorted.map(x=>x[0]), datasets: [{ label: 'Incidents', data: pSorted.map(x=>x[1]), backgroundColor: '#f59e0b', borderRadius: 4 }] },
                options: { indexAxis: 'y', responsive: true, plugins: { legend: {display:false} } }
            });

            const tSorted = Object.entries(counts.trig).sort((a,b) => b[1] - a[1]);
            charts['trig'] = new Chart(document.getElementById('chartTrig'), {
                type: 'doughnut',
                data: { labels: tSorted.map(x=>x[0]), datasets: [{ data: tSorted.map(x=>x[1]), backgroundColor: ['#ef4444', '#f59e0b', '#3b82f6', '#10b981', '#6366f1'] }] },
                options: { responsive: true, plugins: { legend: {position:'bottom', labels:{font:{size:10}}} } }
            });
        }

        function openCharts() {
            if(db.length === 0) return alert("Data is still loading...");
            document.getElementById('chartModal').style.display = 'block';
        }

        function locateUser() {
            setStatus('SEARCHING GPS...', 'warning');
            map.locate({setView: true, maxZoom: 14});
            map.on('locationfound', (e) => {
                if(userMarker) map.removeLayer(userMarker);
                userMarker = L.circle(e.latlng, { radius: 100, color: '#3b82f6' }).addTo(map);
                setStatus('GPS LOCKED', 'online');
            });
            map.on('locationerror', () => {
                setStatus('GPS DENIED', 'error');
                alert("Please enable location services.");
            });
        }

        function reset() {
            document.getElementById('q').value = '';
            document.getElementById('fY').selectedIndex = 0;
            document.getElementById('fR').selectedIndex = 0;
            document.getElementById('fP').selectedIndex = 0;
            document.getElementById('fT').selectedIndex = 0;
            map.setView(PH_CENTER, 4);
            filter();
        }

// --- 3-WAY LAYOUT TOGGLE LOGIC ---
function toggleView(viewType) {
    const mapDiv = document.getElementById('map');
    const feedDiv = document.getElementById('feed');
    const btn = document.getElementById('toggleViewBtn');

    if (viewType === 'map') {
        // STATE 1: Full Map (Hide List)
        mapDiv.classList.remove('hidden-view');
        mapDiv.classList.add('full-map');
        feedDiv.classList.add('hidden-view');
        
        btn.innerText = 'Expand List';
        btn.style.background = '#64748b'; // Dim color
        btn.onclick = () => toggleView('list');

    } else if (viewType === 'list') {
        // STATE 2: Full List (Hide Map)
        mapDiv.classList.add('hidden-view');
        mapDiv.classList.remove('full-map');
        feedDiv.classList.remove('hidden-view');
        
        btn.innerText = 'Show Split View';
        btn.style.background = '#10b981'; // Green color for list
        btn.onclick = () => toggleView('split');

    } else {
        // STATE 3: Default Split View
        mapDiv.classList.remove('hidden-view', 'full-map');
        feedDiv.classList.remove('hidden-view');
        
        btn.innerText = 'Expand Map';
        btn.style.background = 'var(--accent)'; // Original orange
        btn.onclick = () => toggleView('map');
    }

    // CRITICAL: Force Leaflet to redraw the map if it's currently visible
    if (!mapDiv.classList.contains('hidden-view')) {
        setTimeout(() => map.invalidateSize(), 300);
    }
}

        function closeModal() { document.getElementById('dataModal').style.display = 'none'; }
        function closeCharts() { document.getElementById('chartModal').style.display = 'none'; }

        window.onload = init;
