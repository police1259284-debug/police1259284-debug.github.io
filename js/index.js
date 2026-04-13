// CONSTANTS
// URL to the .json of the MapTiler style you want to use
const MAPTILER_STYLE = 'https://api.maptiler.com/maps/dataviz-dark/style.json';

// URL to the GeoJSON dataset of the counties in the US
const COUNTIES_GEOJSON_URL = 'https://raw.githubusercontent.com/BusyBird15/BusyBird15.github.io/refs/heads/main/assets/countymaps/counties-simplified.json';






// Create the MapLibre map
const map = new maplibregl.Map({
    container: 'map',
    style: `https://tgranz.github.io/maps/spark.json`,
    center: [-99.5, 31.5],
    zoom: 7,
    attributionControl: false,
});


// Set and update the time clock
setInterval(() => {
    const now = new Date();
    const padTime = x => String(x).padStart(2, '0');
    document.getElementById('zulu').textContent =  `${padTime(now.getUTCHours())}:${padTime(now.getUTCMinutes())}:${padTime(now.getUTCSeconds())} Z`;
}, 1000);


// Application states
var drawMode = false, drawPts = [];
var countySelectMode = false;
var lineBackPoint = null, isDraggingStart = false;
var currentPolygon = null, currentCounties = [], currentPhenom = 'TOR';
var activeTags = {};
var warnings = [];
var activePopup = null;
var countyData = null;
var selectedCountyFeatures = {};

const labelOverlayLayerIds = [
    'radar',
    'preview-poly-fill',
    'preview-poly-line',
    'warnings-fill',
    'warnings-line',
    'county-hit-fill',
    'county-hit-line',
    'counties-fill',
    'counties-line'
];
// Empty feature collection generator
const emptyFc = () => ({ type: 'FeatureCollection', features: [] });


function getCountyName(props = {}) {
    const raw =
        props.NAME ||
        props.name ||
        props.COUNTY ||
        props.county ||
        props.COUNTYNAME ||
        props.county_name ||
        '';

    return String(raw)
        .replace(/\s+County$/i, '')
        .replace(/\s+Parish$/i, '')
        .trim()
        .toUpperCase();
}

function getCountyId(props = {}) {
    return String(
        props.GEOID ||
        props.geoid ||
        props.FIPS ||
        props.fips ||
        props.COUNTYFP ||
        props.countyfp ||
        getCountyName(props)
    ).trim();
}

function countyIntersections(poly) {
    if (!countyData || !Array.isArray(countyData.features)) {
        return { names: [], features: [] };
    }

    const nameSet = new Set();
    const hitFeatures = [];

    for (const feat of countyData.features) {
        if (!feat || !feat.geometry) continue;

        try {
            if (turf.booleanIntersects(poly, feat)) {
                hitFeatures.push(feat);
                const name = getCountyName(feat.properties);
                if (name) nameSet.add(name);
            }
        } catch (_) {
            // Skip malformed county geometry while preserving the rest.
        }
    }

    return {
        names: Array.from(nameSet).sort(),
        features: hitFeatures
    };
}

function liftLabelsAboveOverlays() {
    const style = map.getStyle();
    if (!style || !Array.isArray(style.layers)) return;

    const labelLayerIds = style.layers
        .filter(layer => layer.type === 'symbol' && layer.layout && layer.layout['text-field'])
        .map(layer => layer.id);

    if (!labelLayerIds.length) return;

    const firstLabelId = labelLayerIds[0];

    // Keep raster/fill/line overlays below base-map labels.
    labelOverlayLayerIds.forEach((layerId) => {
        if (map.getLayer(layerId)) {
            map.moveLayer(layerId, firstLabelId);
        }
    });

    // Keep labels beneath draw aids, but above all warning/area overlays.
    labelLayerIds.forEach((layerId) => {
        if (map.getLayer(layerId) && map.getLayer('draw-line')) {
            map.moveLayer(layerId, 'draw-line');
        }
    });

    if (map.getLayer('draw-line')) map.moveLayer('draw-line');
    if (map.getLayer('draw-pts')) map.moveLayer('draw-pts');
}

map.on('load', async () => {
    map.addSource('radar', {
        type: 'raster',
        tiles: [
            'https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q.cgi?service=WMS&request=GetMap&version=1.1.1&layers=nexrad-n0q-900913&styles=&format=image/png&transparent=true&srs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}&cachebust=' + Date.now()
        ],
        tileSize: 256
    });
    map.addLayer({
        id: 'radar',
        type: 'raster',
        source: 'radar',
        paint: { 'raster-opacity': 0.65 }
    });

    // Keep the radar layer updated every minute
    setInterval(() => {
        const source = map.getSource('radar');
        if (source) source.setTiles([
            'https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q.cgi?service=WMS&request=GetMap&version=1.1.1&layers=nexrad-n0q-900913&styles=&format=image/png&transparent=true&srs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}&cachebust=' + Date.now()
        ]);
    }, 60000);

    map.addSource('draw-pts', { type: 'geojson', data: emptyFc() });
    map.addLayer({
        id: 'draw-pts',
        type: 'circle',
        source: 'draw-pts',
        paint: {
            'circle-radius': 6,
            'circle-color': '#00FFFF',
            'circle-stroke-color': '#00FFFF',
            'circle-stroke-width': 2
        }
    });

    map.addSource('draw-line', { type: 'geojson', data: emptyFc() });
    map.addLayer({
        id: 'draw-line',
        type: 'line',
        source: 'draw-line',
        paint: {
            'line-color': '#00FFFF',
            'line-width': 2,
            'line-opacity': 0.6,
            'line-dasharray': [3, 2]
        }
    });

    map.addSource('preview-poly', { type: 'geojson', data: emptyFc() });
    map.addLayer({
        id: 'preview-poly-fill',
        type: 'fill',
        source: 'preview-poly',
        paint: {
            'fill-color': ['coalesce', ['get', 'color'], '#CC0000'],
            'fill-opacity': 0.18
        }
    });
    map.addLayer({
        id: 'preview-poly-line',
        type: 'line',
        source: 'preview-poly',
        paint: {
            'line-color': ['coalesce', ['get', 'color'], '#CC0000'],
            'line-width': 3,
            'line-dasharray': [3, 2]
        }
    });

    map.addSource('warnings', { type: 'geojson', data: emptyFc() });
    map.addLayer({
        id: 'warnings-fill',
        type: 'fill',
        source: 'warnings',
        paint: {
            'fill-color': ['coalesce', ['get', 'color'], '#CC0000'],
            'fill-opacity': 0.22
        }
    });
    map.addLayer({
        id: 'warnings-line',
        type: 'line',
        source: 'warnings',
        paint: {
            'line-color': ['coalesce', ['get', 'color'], '#CC0000'],
            'line-width': 3
        }
    });

    map.addSource('county-hit', { type: 'geojson', data: emptyFc() });
    map.addLayer({
        id: 'county-hit-fill',
        type: 'fill',
        source: 'county-hit',
        paint: {
            'fill-color': '#00FFFF',
            'fill-opacity': 0.1
        }
    });
    map.addLayer({
        id: 'county-hit-line',
        type: 'line',
        source: 'county-hit',
        paint: {
            'line-color': '#00FFFF',
            'line-width': 1.5,
            'line-opacity': 0.9
        }
    });

    try {
        const res = await fetch(COUNTIES_GEOJSON_URL);
        if (!res.ok) throw new Error(`County dataset request failed (${res.status})`);
        countyData = await res.json();

        map.addSource('counties', { type: 'geojson', data: countyData });
        map.addLayer({
            id: 'counties-fill',
            type: 'fill',
            source: 'counties',
            paint: {
                'fill-color': '#1a1a1a',
                'fill-opacity': 0.08
            }
        });
        map.addLayer({
            id: 'counties-line',
            type: 'line',
            source: 'counties',
            paint: {
                'line-color': '#2f2f2f',
                'line-width': 1,
                'line-opacity': 0.9
            }
        });

        map.on('mouseenter', 'counties-fill', () => {
            if (countySelectMode) map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', 'counties-fill', () => {
            if (!drawMode && !countySelectMode && !isDraggingStart) map.getCanvas().style.cursor = '';
        });
        map.on('click', 'counties-fill', (e) => {
            if (!countySelectMode) return;
            const feature = e.features && e.features[0];
            if (!feature) return;
            toggleCountySelection(feature);
        });

        setApplicationStatusText('COUNTY DATA LOADED — READY');
        liftLabelsAboveOverlays();
    } catch (err) {
        console.error(err);
        setApplicationStatusText('COUNTY DATA UNAVAILABLE — GEOMETRY INTERSECTIONS DISABLED');
    }

    liftLabelsAboveOverlays();

    map.on('mouseenter', 'warnings-fill', () => {
        map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'warnings-fill', () => {
        if (!drawMode && !countySelectMode) map.getCanvas().style.cursor = '';
    });

    map.on('click', 'warnings-fill', (e) => {
        const f = e.features && e.features[0];
        if (!f || !f.properties || !f.properties.id) return;
        if (activePopup) activePopup.remove();

        const popHtml = `
      <div class="pop">
        <div class="pop-type" style="color:${f.properties.color}">${f.properties.title}</div>
        <div class="pop-meta">ISSUED: ${f.properties.issued}<br>EXPIRES: ${f.properties.expires}<br>MOTION: ${f.properties.motion}<br>COUNTIES: ${f.properties.counties}</div>
        <div class="pop-btns">
          <button class="pbtn pbtn-d" data-drop-id="${f.properties.id}">DROP</button>
        </div>
      </div>`;

        activePopup = new maplibregl.Popup({ closeButton: true, closeOnClick: true })
            .setLngLat(e.lngLat)
            .setHTML(popHtml)
            .addTo(map);

        const btn = document.querySelector(`[data-drop-id="${f.properties.id}"]`);
        if (btn) {
            btn.addEventListener('click', () => dropAlert(f.properties.id));
        }
    });

    map.on('mouseenter', 'draw-pts', () => {
        if (lineBackPoint && !drawMode) map.getCanvas().style.cursor = 'grab';
    });
    map.on('mouseleave', 'draw-pts', () => {
        if (!drawMode && !isDraggingStart) map.getCanvas().style.cursor = '';
    });
});

// Start-point drag handling
map.on('mousedown', function (e) {
    if (!lineBackPoint || drawMode || drawPts.length < 2) return;
    const px = map.project(drawPts[0]);
    const dx = px.x - e.point.x, dy = px.y - e.point.y;
    if (Math.sqrt(dx * dx + dy * dy) > 12) return;
    isDraggingStart = true;
    map.dragPan.disable();
});

map.on('mousemove', function (e) {
    if (!isDraggingStart) return;
    const line = turf.lineString([lineBackPoint, drawPts[1]]);
    const snapped = turf.nearestPointOnLine(line, turf.point([e.lngLat.lng, e.lngLat.lat]));
    const snappedCoords = snapped.geometry.coordinates;
    const totalLen = turf.length(line, { units: 'miles' });
    const snapDist = turf.distance(turf.point(lineBackPoint), turf.point(snappedCoords), { units: 'miles' });
    if (snapDist <= totalLen * 0.95) {
        drawPts[0] = snappedCoords;
    }
    setGeojson('draw-pts', {
        type: 'FeatureCollection',
        features: drawPts.map(p => ({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: {} }))
    });
    map.getCanvas().style.cursor = 'grabbing';
});

map.on('mouseup', function () {
    if (!isDraggingStart) return;
    isDraggingStart = false;
    map.dragPan.enable();
    map.getCanvas().style.cursor = lineBackPoint ? 'grab' : '';
    buildPolygon();
});

function setGeojson(sourceId, data) {
    const src = map.getSource(sourceId);
    if (src) src.setData(data);
}

function updateDrawLayers() {
    const pointFeatures = drawPts.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: p },
        properties: {}
    }));
    setGeojson('draw-pts', { type: 'FeatureCollection', features: pointFeatures });

    const lineCoords = drawPts.length === 2
        ? (lineBackPoint ? [lineBackPoint, drawPts[1]] : drawPts.slice())
        : null;
    const lineFeatures = lineCoords
        ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: lineCoords }, properties: {} }]
        : [];
    setGeojson('draw-line', { type: 'FeatureCollection', features: lineFeatures });
}

function clearPreviewPolygon() {
    setGeojson('preview-poly', emptyFc());
}

function renderPreviewPolygon(poly, color) {
    const feat = {
        type: 'Feature',
        geometry: poly.geometry,
        properties: { color }
    };
    setGeojson('preview-poly', { type: 'FeatureCollection', features: [feat] });
}

function refreshWarningsLayer() {
    const fc = {
        type: 'FeatureCollection',
        features: warnings.map((w) => ({
            type: 'Feature',
            geometry: w.geometry,
            properties: w.properties
        }))
    };
    setGeojson('warnings', fc);
}

function tab(id) {
    document.getElementById('panel').classList.remove('hidden');
    document.querySelectorAll('.ptab').forEach(t => t.classList.remove('on'));
    document.querySelectorAll('.tc').forEach(t => t.classList.remove('on'));
    document.getElementById('tab-' + id).classList.add('on');
    document.getElementById('tc-' + id).classList.add('on');
}

function phenomChange() {
    const v = document.getElementById('phenom').value;
    currentPhenom = v;
    document.getElementById('tor-sec').style.display = (v === 'TOR' || v === 'TOA') ? '' : 'none';
    document.getElementById('svr-sec').style.display = (v === 'SVR' || v === 'SVA') ? '' : 'none';
    document.getElementById('issueBtn').textContent = (v === 'TOA' || v === 'SVA') ? 'ISSUE WATCH' : 'ISSUE WARNING';
}

function toggleTag(id) {
    activeTags[id] = !activeTags[id];
    document.getElementById('tag-' + id).classList.toggle('on', !!activeTags[id]);
}

function initWarn(phenom) {
    currentPhenom = phenom;
    document.getElementById('phenom').value = phenom;
    phenomChange();
    document.getElementById('panel').classList.remove('hidden');
    setApplicationStatusText('PRODUCT SELECTED — CLICK ✛ DRAW OR USE VECTOR TAB TO PLACE POLYGON');
    tab('v');
}

function startDraw() {
    countySelectMode = false;
    cancelDraw();
    selectedCountyFeatures = {};
    setGeojson('county-hit', emptyFc());
    currentPolygon = null;
    currentCounties = [];
    renderChips();
    document.getElementById('issueBtn').disabled = true;
    drawMode = true; drawPts = [];
    map.getCanvas().style.cursor = 'crosshair';
    document.getElementById('helpTooltip').style.display = 'block';
    document.getElementById('helpTooltip').textContent = 'CLICK POINT 1 — STORM ORIGIN  |  ESC TO CANCEL';
    updateDrawLayers();
    setVStep(0);
    setApplicationStatusText('DRAWING MODE — CLICK STORM ORIGIN ON MAP');
}

function startCountySelect() {
    if (!countyData) {
        setApplicationStatusText('COUNTY DATA UNAVAILABLE — CANNOT SELECT COUNTIES');
        return;
    }

    cancelDraw();
    currentPolygon = null;
    currentCounties = [];
    selectedCountyFeatures = {};
    setGeojson('county-hit', emptyFc());
    renderChips();
    document.getElementById('issueBtn').disabled = true;
    countySelectMode = true;
    map.getCanvas().style.cursor = 'pointer';
    document.getElementById('helpTooltip').style.display = 'block';
    document.getElementById('helpTooltip').textContent = 'CLICK COUNTIES TO TOGGLE SELECTION  |  ESC TO STOP';
    setApplicationStatusText('COUNTY MODE — CLICK COUNTIES TO BUILD WATCH AREA');
    tab('p');
}

function clearAreaSelection() {
    cancelDraw();
    currentPolygon = null;
    currentCounties = [];
    selectedCountyFeatures = {};
    setGeojson('county-hit', emptyFc());
    renderChips();
    document.getElementById('issueBtn').disabled = true;
    setApplicationStatusText('AREA CLEARED — SELECT POLYGON OR COUNTIES');
}

function selectedCountyList() {
    return Object.values(selectedCountyFeatures);
}

function buildCountySelectionGeometry(features) {
    if (!features.length) return null;
    if (features.length === 1) {
        return turf.feature(features[0].geometry);
    }

    const combined = turf.combine(turf.featureCollection(features));
    if (!combined.features.length) return null;
    return combined.features[0];
}

function refreshCountySelectionState() {
    const selected = selectedCountyList();
    const geomFeature = buildCountySelectionGeometry(selected);
    currentPolygon = geomFeature || null;
    currentCounties = selected
        .map(f => getCountyName(f.properties))
        .filter(Boolean)
        .sort();

    setGeojson('county-hit', {
        type: 'FeatureCollection',
        features: selected
    });

    renderChips();
    document.getElementById('issueBtn').disabled = !currentPolygon;
    if (currentPolygon) {
        setApplicationStatusText(currentCounties.length + ' COUNTIES SELECTED — READY TO ISSUE');
        tab('out');
    } else if (countySelectMode) {
        setApplicationStatusText('COUNTY MODE — CLICK COUNTIES TO BUILD WATCH AREA');
    }
}

function toggleCountySelection(feature) {
    if (!feature || !feature.properties) return;
    const id = getCountyId(feature.properties);
    if (!id) return;

    if (selectedCountyFeatures[id]) {
        delete selectedCountyFeatures[id];
    } else {
        selectedCountyFeatures[id] = feature;
    }

    refreshCountySelectionState();
}

function cancelDraw() {
    drawMode = false; drawPts = [];
    countySelectMode = false;
    lineBackPoint = null; isDraggingStart = false;
    map.dragPan.enable();
    map.getCanvas().style.cursor = '';
    document.getElementById('helpTooltip').style.display = 'none';
    updateDrawLayers();
    clearPreviewPolygon();
    setVStep(-1);
}

map.on('click', function (e) {
    if (!drawMode) return;
    drawPts.push([e.lngLat.lng, e.lngLat.lat]);
    updateDrawLayers();

    if (drawPts.length === 1) {
        document.getElementById('helpTooltip').textContent = 'CLICK POINT 2 — PROJECTED STORM POSITION  |  ESC TO CANCEL';
        setVStep(1);
        setApplicationStatusText('DRAWING MODE — CLICK PROJECTED STORM POSITION');
    } else if (drawPts.length === 2) {
        drawMode = false;
        map.getCanvas().style.cursor = '';
        document.getElementById('helpTooltip').style.display = 'none';
        const _p1 = turf.point(drawPts[0]), _p2 = turf.point(drawPts[1]);
        const _bearing = turf.bearing(_p1, _p2);
        const _dist = turf.distance(_p1, _p2, { units: 'miles' });
        lineBackPoint = turf.destination(_p1, _dist, _bearing + 180, { units: 'miles' }).geometry.coordinates;
        updateDrawLayers();
        buildPolygon();
    }
});

document.addEventListener('keydown', e => { if (e.key === 'Escape') cancelDraw(); });

function buildPolygon() {
    const p1 = turf.point(drawPts[0]), p2 = turf.point(drawPts[1]);
    const bearing = turf.bearing(p1, p2);
    const distMi = turf.distance(p1, p2, { units: 'miles' });
    const wUp = parseFloat(document.getElementById('wUp').value) || 10;
    const wDn = parseFloat(document.getElementById('wDn').value) || 22;

    const p1L = turf.destination(p1, wUp, bearing - 90, { units: 'miles' });
    const p1R = turf.destination(p1, wUp, bearing + 90, { units: 'miles' });
    const p2L = turf.destination(p2, wDn, bearing - 85, { units: 'miles' });
    const p2R = turf.destination(p2, wDn, bearing + 85, { units: 'miles' });

    const poly = turf.polygon([[
        p1L.geometry.coordinates,
        p2L.geometry.coordinates,
        p2R.geometry.coordinates,
        p1R.geometry.coordinates,
        p1L.geometry.coordinates
    ]]);

    const col = (currentPhenom === 'TOR' || currentPhenom === 'TOA')
        ? '#CC0000'
        : (currentPhenom === 'SVR' || currentPhenom === 'SVA')
            ? '#FF8C00'
            : '#00AAFF';
    renderPreviewPolygon(poly, col);

    currentPolygon = poly;

    const countyHits = countyIntersections(poly);
    currentCounties = countyHits.names;
    setGeojson('county-hit', {
        type: 'FeatureCollection',
        features: countyHits.features
    });

    const dir = Math.round(bearing < 0 ? bearing + 360 : bearing);
    const spdMph = Math.round(distMi * 0.87 * 1.15078 / 5) * 5;
    document.getElementById('motDir').value = dir;
    document.getElementById('motSpd').value = spdMph;

    renderChips();
    setVStep(2);
    setApplicationStatusText(currentCounties.length + ' COUNTIES INTERSECTED — READY TO ISSUE');
    document.getElementById('issueBtn').disabled = false;
    tab('out');
}

function renderChips() {
    const el = document.getElementById('countyChips');
    if (!currentCounties.length) { el.innerHTML = '<span class="county-hint">None intersected</span>'; return; }
    el.innerHTML = currentCounties.map(c => `<span class="chip">${c}</span>`).join('');
}

function setVStep(step) {
    const v1 = document.getElementById('v1'), v2 = document.getElementById('v2'), vs = document.getElementById('vstatus');
    v1.className = 'vnum'; v2.className = 'vnum';
    if (step === 0) { v1.className = 'vnum act'; vs.textContent = 'CLICK STORM ORIGIN'; }
    else if (step === 1) { v1.className = 'vnum done'; v2.className = 'vnum act'; vs.textContent = 'CLICK PROJECTED POSITION'; }
    else if (step === 2) { v1.className = 'vnum done'; v2.className = 'vnum done'; vs.textContent = 'VECTOR SET ✓'; }
    else { vs.textContent = 'AWAITING INPUT'; }
}

function setApplicationStatusText(txt) { document.getElementById('sb-status').textContent = txt; }

function issueProduct() {
    if (!currentPolygon) return;
    const phenom = document.getElementById('phenom').value;
    const cwa = document.getElementById('cwa')?.value || 'EWX';
    const validEl = phenom === 'SVR' ? document.getElementById('valid2') : document.getElementById('valid');
    const validMin = parseInt(validEl ? validEl.value : '60');
    const motDir = document.getElementById('motDir').value || '225';
    const motSpd = document.getElementById('motSpd').value || '35';

    const now = new Date();
    const p = x => String(x).padStart(2, '0');
    const zulu = p(now.getUTCHours()) + p(now.getUTCMinutes()) + 'Z';
    const exp = new Date(now.getTime() + validMin * 60000);
    const exZ = p(exp.getUTCHours()) + p(exp.getUTCMinutes()) + 'Z';
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const dateStr = p(now.getUTCDate()) + ' ' + months[now.getUTCMonth()] + ' ' + now.getUTCFullYear();
    // Local 12-hour time display
    const localH = now.getHours(), localM = now.getMinutes();
    const ampm = localH >= 12 ? 'PM' : 'AM';
    const h12 = localH % 12 || 12;
    const localDisp = h12 + ':' + p(localM) + ' ' + ampm + ' Central';
    // Speed field now stores MPH directly, round to nearest 5
    const motSpdMph = Math.round(parseFloat(motSpd) / 5) * 5 || 5;

    const labels = {
        TOR: 'TORNADO WARNING',
        SVR: 'SEVERE THUNDERSTORM WARNING',
        TOA: 'TORNADO WATCH',
        SVA: 'SEVERE THUNDERSTORM WATCH',
        FFW: 'FLASH FLOOD WARNING',
        SQW: 'SNOW SQUALL WARNING'
    };
    const wmos = {
        TOR: 'WFUS54',
        SVR: 'WFUS52',
        TOA: 'WOUS64',
        SVA: 'WOUS64',
        FFW: 'WGUS64',
        SQW: 'WWUS40'
    };
    const pils = {
        TOR: 'TOR',
        SVR: 'SVR',
        TOA: 'TOA',
        SVA: 'SVA',
        FFW: 'FFW',
        SQW: 'SQW'
    };
    const label = labels[phenom];
    const isWatch = phenom === 'TOA' || phenom === 'SVA';

    const isSvr = phenom === 'SVR';
    const isPDS = activeTags['pds'] || (isSvr && activeTags['svr-pds']);
    const isEmer = activeTags['emer'];
    const isConsid = activeTags['consid'] || (isSvr && activeTags['svr-consid']);
    const isCatast = activeTags['catast'];
    const isDestr = isSvr && activeTags['destr'];
    const isTorPoss = isSvr && activeTags['torposs'];
    const isObs = activeTags['obs'];

    const col = (phenom === 'TOR' || phenom === 'TOA')
        ? (isPDS ? '#FFD700' : isEmer ? '#cc00cc' : '#CC0000')
        : (phenom === 'SVR' || phenom === 'SVA')
            ? '#FF8C00'
            : '#00AAFF';

    const clist = currentCounties.slice(0, 5).join(', ') + (currentCounties.length > 5 ? '...' : '');

    const warningTitle = `${isPDS ? 'PDS ' : ''}${isEmer ? 'EMER - ' : ''}${isConsid && isSvr ? 'CONSIDERABLE ' : ''}${label}`;
    const warningId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    warnings.push({
        id: warningId,
        geometry: currentPolygon.geometry,
        properties: {
            id: warningId,
            color: col,
            title: warningTitle,
            issued: `${localDisp} ${dateStr}`,
            expires: exZ,
            motion: isWatch ? 'AREA WATCH' : `${motDir} DEG AT ${motSpdMph} MPH`,
            counties: clist || 'NONE'
        }
    });
    refreshWarningsLayer();
    clearPreviewPolygon();

    let tagLines = [];
    if (isPDS) tagLines.push('...PARTICULARLY DANGEROUS SITUATION...');
    if (isEmer && !isWatch) tagLines.push('...TORNADO EMERGENCY...');
    if (isConsid) tagLines.push('...CONSIDERABLE DAMAGE THREAT...');
    if (isCatast) tagLines.push('...CATASTROPHIC DAMAGE THREAT...');
    if (isDestr) tagLines.push('...THIS IS A DESTRUCTIVE STORM...');
    if (isTorPoss) tagLines.push('...TORNADO POSSIBLE...');

    const torSrc = document.getElementById('torSource')?.value || 'RADAR INDICATED';
    const wind = document.getElementById('wind')?.value || '';
    const hailV = document.getElementById('hail')?.value || '';

    let hazard = '';
    if (phenom === 'TOR' || phenom === 'TOA') {
        hazard = `* TORNADO...${torSrc}\n* HAIL...POSSIBLE\n* WIND...POSSIBLE`;
    } else if (phenom === 'SVR' || phenom === 'SVA') {
        hazard = `* WIND...${wind} EXPECTED\n* HAIL...${hailV}${isTorPoss ? '\n* TORNADO...POSSIBLE' : ''}`;
    } else if (phenom === 'FFW') {
        hazard = `* FLASH FLOODING...LIFE THREATENING\n* RAINFALL...EXCESSIVE`;
    } else {
        hazard = `* SNOW SQUALL...SUDDEN WHITEOUT CONDITIONS\n* WIND GUSTS...UP TO 45 MPH`;
    }

    const action = phenom === 'TOR'
        ? ''
    : phenom === 'SVR'
        ? 'MOVE INSIDE A STURDY BUILDING. LARGE HAIL AND DAMAGING WINDS CAN SHATTER WINDOWS.'
    : phenom === 'TOA'
        ? 'BE READY TO TAKE COVER QUICKLY IF A WARNING IS ISSUED. REVIEW YOUR SAFE ROOM PLAN NOW.'
    : phenom === 'SVA'
        ? 'PREPARE FOR SEVERE WEATHER ACROSS THE WATCH AREA. SECURE LOOSE OUTDOOR OBJECTS AND MONITOR WARNINGS.'
    : phenom === 'FFW'
        ? 'MOVE TO HIGHER GROUND NOW. DO NOT ATTEMPT TO CROSS FLOODED ROADS.'
        : 'PULL OFF THE ROAD IF VISIBILITY DROPS. STAY IN YOUR VEHICLE.';

    const countyLine = currentCounties.map(c => c + ' TX').join('...') || 'NO COUNTIES DETECTED';

    const watchActionLine = phenom === 'TOA'
        ? '* THIS IS A TORNADO WATCH. CONDITIONS ARE FAVORABLE FOR TORNADOES.'
        : phenom === 'SVA'
            ? '* THIS IS A SEVERE THUNDERSTORM WATCH. CONDITIONS ARE FAVORABLE FOR DAMAGING WINDS AND LARGE HAIL.'
            : '';

    const watchLead = isWatch
        ? `${countyLine}\n\n${watchActionLine}\n\n* VALID UNTIL ${exZ}.`
        : `${countyLine}\n\n* AT ${localDisp}, ${isObs ? 'A TRAINED SPOTTER REPORTED' : 'DOPPLER RADAR INDICATED'} A ${label.replace('WARNING', '')} NEAR THE WARNING AREA, MOVING ${motDir} DEG AT ${motSpdMph} MPH.`;

    const product =
        `${wmos[phenom]} K${cwa} ${zulu}
${pils[phenom]}${cwa}

BULLETIN - INITIAL BULLETIN
${label}
NATIONAL WEATHER SERVICE ${cwa} TX
${localDisp} ${dateStr}
${tagLines.length ? '\n' + tagLines.join('\n') + '\n' : ''}
...${label} ISSUED...

${watchLead}

* HAZARD...
${hazard}

* IMPACT...LIFE THREATENING CONDITIONS. IMMEDIATE PROTECTIVE ACTION REQUIRED.

PRECAUTIONARY/PREPAREDNESS ACTIONS...

${action}

&&

${pils[phenom]}...${cwa}

$$`;

    document.getElementById('productOut').textContent = product;
    setApplicationStatusText('PRODUCT ISSUED — ' + label);
}

function editAlert(id) {
    tab('out');
}

function dropAlert(id) {
    warnings = warnings.filter((w) => w.id !== id);
    refreshWarningsLayer();
    if (activePopup) {
        activePopup.remove();
        activePopup = null;
    }
}

function clearAll() {
    warnings = [];
    refreshWarningsLayer();
    cancelDraw();
    currentPolygon = null; currentCounties = []; activeTags = {};
    selectedCountyFeatures = {};
    setGeojson('county-hit', emptyFc());
    document.querySelectorAll('.tag').forEach(t => t.classList.remove('on'));
    document.getElementById('countyChips').innerHTML = '<span class="county-hint">Draw polygon or click counties to populate...</span>';
    document.getElementById('issueBtn').disabled = true;
    document.getElementById('productOut').textContent = 'TEXAS ALERT SERVICE — WARNGEN\nAWAITING PRODUCT...';
    setApplicationStatusText('READY');
    document.getElementById('panel').classList.add('hidden');
}

phenomChange();