// Initialize the Leaflet noisemap
const map = L.map('map', {
  zoomControl: true,
});

// === Basemaps (Esri streets and Google imagery) ===
const esriStreets = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 18, // above this causes render issues with esri streets
  attribution: 'Tiles &copy; Esri — Source: Esri, HERE, Garmin, FAO, NOAA, USGS, © OpenStreetMap contributors, and the GIS User Community'
}).addTo(map);

const esriImagery = L.tileLayer('https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
  subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
  attribution: 'Google - Contributions: Maxar Technologies, Airbus, CNES, SIO, NOAA, U.S. Navy, NGA, GEBCO',
  maxZoom: 20
});

// Initial view — centered roughly on Trinidad & Tobago
map.setView([10.5, -61.3], 10);

// Scale bar
L.control.scale({ imperial: false }).addTo(map);

// Ensure proper sizing on load/resize
const invalidate = () => map.invalidateSize();
window.addEventListener('load', invalidate);
window.addEventListener('resize', invalidate);

let searchMarker = null;

function clearGeocoderResult(geocoderInputEl) {
  if (searchMarker) {
    map.removeLayer(searchMarker);
    searchMarker = null;
  }
  map.closePopup();

  if (geocoderInputEl) geocoderInputEl.value = '';

  if (geocoder && geocoder._results && geocoder._results.style) {
    geocoder._results.style.display = 'none';
  }
}

// ---- Basemap toggle button ----
let currentBase = 'streets'; // default is esriStreets

function toggleBase(buttonEl) {
  if (currentBase === 'streets') {
    map.removeLayer(esriStreets);
    esriImagery.addTo(map);
    currentBase = 'imagery';
    if (buttonEl) buttonEl.textContent = 'Streets';
  } else {
    map.removeLayer(esriImagery);
    esriStreets.addTo(map);
    currentBase = 'streets';
    if (buttonEl) buttonEl.textContent = 'Satellite';
  }
}

// Custom Leaflet control for switching basemap
const BaseSwitcher = L.Control.extend({
  options: { position: 'topright' },
  onAdd: function () {
    const container = L.DomUtil.create('div', 'leaflet-control basemap-toggle');
    const btn = L.DomUtil.create('button', 'basemap-btn', container);
    btn.type = 'button';
    btn.title = 'Switch base layer: Streets ↔ Satellite';
    btn.setAttribute('aria-label', 'Switch base layer');
    btn.textContent = 'Satellite';

    // Prevent map drag/zoom when clicking the button
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.on(btn, 'click', function (e) {
      L.DomEvent.stop(e);
      toggleBase(btn);
    });

    return container;
  }
});

const SHEET_URLS = [
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTe1IWRLcQKE6U_9VO7SPqdFYbhjiZ8RhsG3eZUYzpnM9xeOK6y7nBK6BAi7q2vkkHALkDoVbXFbmY6/pub?output=csv"
];

const EPSG32620 =
  "+proj=utm +zone=20 +datum=WGS84 +units=m +no_defs +type=crs";

const layerUIControls = {};

function utm32620ToLatLng(easting, northing) {
  const [lng, lat] = proj4(EPSG32620, "EPSG:4326", [easting, northing]);
  return { lat, lng };
}

const clusterLayer = L.markerClusterGroup({});
map.addLayer(clusterLayer);

function renderFeaturesToMap(featureList) {
  clusterLayer.clearLayers();

  featureList.forEach(f => {
    if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) return;

    const marker = makeCircleMarker(f.lat, f.lng, f.determination)
      .bindPopup(popupHtmlForFeature(f));

    marker.featureData = f;

    clusterLayer.addLayer(marker);
  });
}

/****************************************************
 * DATA LOADING AND MERGING FROM GOOGLE SHEETS
 ****************************************************/

let allDataRows = [];

function loadSheet(url) {
  return new Promise((resolve, reject) => {
    Papa.parse(url, {
      download: true,
      header: true,
      dynamicTyping: false,
      complete: function (results) {
        // Filter out totally empty rows
        const rows = results.data.filter(
          r => r["Easting"] && r["Northing"]
        );
        resolve(rows);
      },
      error: function (err) {
        reject(err);
      }
    });
  });
}

// Load ALL sheets, merge, store in allDataRows
async function loadAllSheets() {
  const promises = SHEET_URLS.map(u => loadSheet(u));
  const sheetsArrays = await Promise.all(promises);

  // Flatten the array-of-arrays into one array
  allDataRows = sheetsArrays.flat();

  console.log("Loaded rows:", allDataRows.length, allDataRows);
}


// ---- OpenStreetMap Geocoder (restricted to T&T) ----
const TT_BBOX = [-61.95, 10.0, -60.5, 11.5];
const geocoder = L.Control.geocoder({
  position: 'topright',
  defaultMarkGeocode: false,
  geocoder: L.Control.Geocoder.nominatim({
    geocodingQueryParams: {
      countrycodes: 'tt',
      viewbox: `${TT_BBOX[0]},${TT_BBOX[3]},${TT_BBOX[2]},${TT_BBOX[1]}`,
      bounded: 1
    }
  })
})
  .on('markgeocode', e => {
    const { center, bbox, name } = e.geocode;

    if (searchMarker) {
      map.removeLayer(searchMarker);
    }

    searchMarker = L.marker(center).addTo(map).bindPopup(`<strong>${name}</strong>`).openPopup();

    map.fitBounds(bbox);
  })
  .addTo(map);

const geocoderContainer = geocoder._container;
const geocoderInput = geocoderContainer.querySelector('.leaflet-control-geocoder-form input');

if (geocoderInput) {
  geocoderInput.setAttribute('type', 'search');
  geocoderInput.setAttribute('placeholder', 'Search for a place...');

  geocoderInput.addEventListener('search', () => {
    if (geocoderInput.value === '') {
      clearGeocoderResult(geocoderInput);
    }
  });

  geocoderInput.addEventListener('input', () => {
    if (geocoderInput.value.trim() === '') {
      clearGeocoderResult(geocoderInput);
    }
  });
}

const customClearBtn = document.createElement('button');
customClearBtn.type = 'button';
customClearBtn.className = 'geocoder-clear-btn';
customClearBtn.setAttribute('aria-label', 'Clear search and remove marker');
customClearBtn.textContent = '×';

const formEl = geocoderContainer.querySelector('.leaflet-control-geocoder-form');
if (formEl) {
  formEl.style.position = 'relative';
  formEl.appendChild(customClearBtn);
  customClearBtn.addEventListener('click', (e) => {
    e.preventDefault();
    clearGeocoderResult(geocoderInput);
    geocoderInput.focus();
  });
}

map.addControl(new BaseSwitcher());

/**********************
 * INSET MAP SECTION
 **********************/

// Helper function to ensure location square does not zoom in too much.
function boundsAtZoom(center, zoom) {
  const size = map.getSize();
  const half = size.divideBy(2);
  const centerPx = map.project(center, zoom);
  const sw = map.unproject(centerPx.subtract(half), zoom);
  const ne = map.unproject(centerPx.add(half), zoom);
  return L.latLngBounds(sw, ne);
}

// boundaries when Trinidad is displayed
const BOUNDS_TRINIDAD = L.latLngBounds(
  [9.95, -61.95],
  [10.95, -60.45]
);

// boundaries when Tobago is displayed
const BOUNDS_TOBAGO = L.latLngBounds(
  [11.05, -60.95],
  [11.40, -60.40]
);

// Leaflet control for the inset map
const InsetControl = L.Control.extend({
  options: { position: 'bottomright' },

  onAdd: function () {
    const container = L.DomUtil.create('div', 'inset-container leaflet-bar');
    container.innerHTML = '<div id="insetMap" class="inset-map"></div>';

    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);

    return container;
  },

  onRemove: function () { }
});

map.addControl(new InsetControl());

// Inset map behaviours
const insetMap = L.map('insetMap', {
  attributionControl: false,
  zoomControl: false,
  dragging: false,
  scrollWheelZoom: false,
  touchZoom: false,
  doubleClickZoom: false,
  boxZoom: false,
  keyboard: false,
  zoomSnap: 0,
  inertia: false,
});

// Inset map basemap
const insetTiles = L.tileLayer(
  'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png',
  { subdomains: 'abcd', maxZoom: 19 }
).addTo(insetMap);

// Red square around the map view area
const viewRect = L.rectangle(map.getBounds(), {
  color: 'red',
  weight: 2,
  fill: false,
  className: 'inset-viewport-rect'
}).addTo(insetMap);

// Determine which island is displayed
function islandForCenter(centerLatLng) {
  return BOUNDS_TOBAGO.contains(centerLatLng) ? 'TOBAGO' : 'TRINIDAD';
}

// Inset map live updating
function updateInset() {
  const center = map.getCenter();
  const currentZoom = map.getZoom();

  const island = islandForCenter(center);
  const targetBounds = island === 'TOBAGO' ? BOUNDS_TOBAGO : BOUNDS_TRINIDAD;

  insetMap.fitBounds(targetBounds, { animate: false, padding: [0, 0] });

  // Determine the rectangle to draw (more than 14 looks too small)
  let rectBounds;
  if (currentZoom <= 14) {
    rectBounds = map.getBounds();
  } else {
    rectBounds = boundsAtZoom(center, 14);
  }

  viewRect.setBounds(rectBounds);
}

map.whenReady(updateInset);
map.on('moveend zoomend', updateInset);

// === LEGEND STATE & CONTROL ===================================

// Store legend data for each logical layer (keyed by cfg.id or "major_roads")
const legendGroups = {};
let legendBodyEl = null;

const LegendControl = L.Control.extend({
  options: { position: 'topright' },

  onAdd: function () {
    const container = L.DomUtil.create('div', 'legend-container leaflet-bar');
    container.innerHTML = `
      <div class="legend-inner">
        <div class="legend-header">Legend</div>
        <div class="legend-body"></div>
      </div>
    `;

    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);

    legendBodyEl = container.querySelector('.legend-body');
    refreshLegend();

    return container;
  }
});

function refreshLegend() {
  if (!legendBodyEl) return;

  legendBodyEl.innerHTML = '';

  const entries = Object.entries(legendGroups);
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'legend-empty';
    empty.textContent = 'No layers visible';
    legendBodyEl.appendChild(empty);
    return;
  }

  entries.forEach(([layerKey, group]) => {
    if (!group || !group.items || !group.items.length) return;

    const groupEl = document.createElement('div');
    groupEl.className = 'legend-group';

    if (group.title) {
      const titleEl = document.createElement('div');
      titleEl.className = 'legend-group-title';
      titleEl.textContent = group.title;
      groupEl.appendChild(titleEl);
    }

    group.items.forEach(item => {
      const itemEl = document.createElement('div');
      itemEl.className = 'legend-item';

      const swatch = document.createElement('span');
      swatch.className = 'legend-swatch';
      if (item.color) {
        swatch.style.backgroundColor = item.color;
      }

      const labelEl = document.createElement('span');
      labelEl.className = 'legend-label';
      labelEl.textContent = item.label;

      itemEl.appendChild(swatch);
      itemEl.appendChild(labelEl);
      groupEl.appendChild(itemEl);
    });

    legendBodyEl.appendChild(groupEl);
  });
}

function setLegendGroup(key, group) {
  if (group) {
    legendGroups[key] = group;
  } else {
    delete legendGroups[key];
  }
  refreshLegend();
}

// Add legend control (under basemap toggle in top-right)
map.addControl(new LegendControl());

// --- GEOJSON OVERLAY CONFIG ------
const GEOJSON_LAYERS_CONFIG = [
  {
    id: 'municipality',
    name: 'Municipalities',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Municipality.geojson',
    type: 'municipality'
  },
  {
    id: 'aripo',
    name: 'Aripo Savannas',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Aripo%20Savannas.geojson',
    type: 'protected'
  },
  {
    id: 'matura',
    name: 'Matura National Park',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Matura%20National%20Park.geojson',
    type: 'protected'
  },
  {
    id: 'nariva',
    name: 'Nariva Swamp',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Nariva%20Swamp.geojson',
    type: 'protected'
  },
  {
    id: 'caroni',
    name: 'Caroni Swamp',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Caroni%20Swamp.geojson',
    type: 'protected'
  },
  {
    id: 'aripo_buffer',
    name: 'Aripo Savannas Buffer',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Aripo%20Savannas%20Buffer.geojson',
    type: 'protected'
  },
  {
    id: 'matura_buffer',
    name: 'Matura National Park Buffer',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Matura%20National%20Park%20Buffer.geojson',
    type: 'protected'
  },
  {
    id: 'nariva_buffer',
    name: 'Nariva Swamp Buffer',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Nariva%20Swamp%20Buffer.geojson',
    type: 'protected'
  },

  // Major roads
  {
    id: 'major_roads',
    name: 'Major Roads',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Major%20Roads.geojson',
    type: 'roads'
  },

  // Noise zones
  {
    id: 'noise_zones',
    name: 'Noise Zones',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Noise%20Zones.geojson',
    type: 'zone'
  },
  {
    id: 'proposed_noise_zones',
    name: 'Proposed Noise Zones',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Proposed%20Noise%20Zones.geojson',
    type: 'zone'
  },

  // Chaguaramas Event Locations
  {
    id: 'chag_events',
    name: 'Chaguaramas Event Locations',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Chaguaramas%20Event%20Locations.geojson',
    type: 'events'
  },

  // Chaguaramas Nature Reserve
  {
    id: 'chag_nature_reserve',
    name: 'Chaguaramas Nature Reserve',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Chaguaramas.geojson',
    type: 'protected'
  },

  // Trinidad Forest Reserves
  {
    id: 'forest_reserves',
    name: 'Trinidad Forest Reserves',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Forest%20Reserves.geojson',
    type: 'protected'
  },

  // Main Ridge
  {
    id: 'main_ridge',
    name: 'Main Ridge',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/HummingBirds_MainRidge.geojson',
    type: 'protected'
  },

  // Private Medical Facilities
  {
    id: 'private_medical_trinidad',
    name: 'Private Medical Facilities',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/PrivateMedicalFacilities_Trinidad.geojson',
    type: 'poi'
  },

  // Tobago TCPD Policy
  {
    id: 'tobago_tcpd_policy',
    name: 'Tobago TCPD Policy',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Tobago%20TCPD%20Policy.geojson',
    type: 'policy',
    labelField: 'Class_Name'
  },

  // Tobago Watersheds
  {
    id: 'tobago_watersheds',
    name: 'Tobago Watershed',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Tobago%20Watersheds.geojson',
    type: 'watershed',
    labelField: 'WATERSHED'
  },

  // Tobago Hospitals
  {
    id: 'tobago_hospitals',
    name: 'Tobago Hospitals',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/TobagoHospitals.geojson',
    type: 'poi'
  },

  // Trinidad TCPD Policy
  {
    id: 'trinidad_tcpd_policy',
    name: 'Trinidad TCPD Policy',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Trinidad%20TCPD%20Policy.geojson',
    type: 'policy',
    labelField: 'Class_Name'
  },

  // Trinidad Watersheds
  {
    id: 'trinidad_watersheds',
    name: 'Trinidad Watershed',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Trinidad%20Watersheds.geojson',
    type: 'watershed',
    labelField: 'Name'
  },

  // Trinidad Hospitals
  {
    id: 'trinidad_hospitals',
    name: 'Trinidad Hospitals',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/TrinidadHospitals.geojson',
    type: 'poi'
  },

  // Turtle Nesting Sites
  {
    id: 'turtle_nesting_sites',
    name: 'Turtle Nesting Sites',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/TurtleNestingSites.geojson',
    type: 'poi',
    labelField: 'layer'
  }
];

function getPolygonStrokeWidth(zoom) {
  if (zoom >= 15) return 3;
  if (zoom >= 12) return 2;
  return 1;
}

function getRoadLineWidth(zoom) {
  if (zoom >= 17) return 4;
  if (zoom >= 15) return 3;
  if (zoom >= 13) return 2;
  return 1.5;
}

function buildCategoryColorMap(values) {
  const unique = Array.from(new Set(values))
    .filter(v => v !== undefined && v !== null && String(v).trim() !== '');
  const count = unique.length || 1;
  const mapColors = {};

  unique.forEach((val, idx) => {
    const hue = (idx * 360) / count;
    const saturation = 55;
    const lightness = 78;
    mapColors[val] = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  });

  return mapColors;
}

const polygonLayers = [];
let roadsLayer = null;
let roadsData = null;
let roadsVisible = false;

function createLayerToggleRow(layerId, labelText, defaultOpacity = 0.7, defaultVisible = true) {
  const container = document.getElementById('layer-toggle-container');
  if (!container) return null;

  const row = document.createElement('div');
  row.className = 'layer-toggle-row';

  const mainRow = document.createElement('div');
  mainRow.className = 'layer-toggle-row-main';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = `layer-toggle-${layerId}`;
  checkbox.checked = defaultVisible;

  const label = document.createElement('label');
  label.setAttribute('for', checkbox.id);
  label.textContent = labelText;

  mainRow.appendChild(checkbox);
  mainRow.appendChild(label);

  const sliderRow = document.createElement('div');
  sliderRow.className = 'layer-toggle-slider-row';

  const sliderLabel = document.createElement('span');
  sliderLabel.textContent = 'Opacity';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '1';
  slider.step = '0.05';
  slider.value = String(defaultOpacity);

  sliderRow.appendChild(sliderLabel);
  sliderRow.appendChild(slider);

  row.appendChild(mainRow);
  row.appendChild(sliderRow);
  container.appendChild(row);

  return { checkbox, slider };
}

function initLayerTogglePanel() {
  const container = document.getElementById('layer-toggle-container');
  if (!container) return;

  container.innerHTML = '';

  GEOJSON_LAYERS_CONFIG.forEach(cfg => {
    // Only skip roads; contours are gone
    if (cfg.type === 'roads') return;

    const controls = createLayerToggleRow(cfg.id, cfg.name, 0.7, false);
    if (controls) {
      layerUIControls[cfg.id] = controls;
    }
  });
}

function guessLabelProperty(features) {
  if (!features || !features.length) return null;

  const props = features[0].properties || {};
  const candidateKeys = [
    'zone', 'ZONE',
    'name', 'Name', 'NAME',
    'label', 'Label', 'LABEL',
    'category', 'Category', 'CATEGORY'
  ];

  for (const key of candidateKeys) {
    if (key in props) return key;
  }

  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'string' && value.trim() !== '') {
      return key;
    }
  }

  return null;
}

function createPolygonOverlay(cfg, data) {
  const features = (data && data.features) || [];

  const labelField =
    cfg.labelField ||
    (cfg.type === 'municipality' ? 'NAME_1' :
     cfg.type === 'zone' ? 'zone' :
     null) ||
    guessLabelProperty(features);

  const valuesForColors = labelField
    ? features.map(f => f.properties?.[labelField])
    : [cfg.name];

  const colorMap = buildCategoryColorMap(
    valuesForColors.length ? valuesForColors : [cfg.name]
  );

  const labelClass =
    cfg.type === 'municipality' ? 'municipality-label' :
    cfg.type === 'zone' ? 'zone-label' :
    'protected-label';

  const layer = L.geoJSON(data, {
    style: feature => {
      const key = labelField ? feature.properties?.[labelField] : cfg.name;
      const fillColor =
        colorMap[key] ||
        Object.values(colorMap)[0] ||
        '#e5e7eb';

      return {
        color: '#6b7280', // medium grey
        weight: getPolygonStrokeWidth(map.getZoom()),
        fillColor,
        fillOpacity: 0.0
      };
    },
    onEachFeature: (feature, lyr) => {
      const labelText = labelField
        ? feature.properties?.[labelField]
        : cfg.name;

      if (labelText) {
        lyr.bindTooltip(labelText, {
          direction: 'center',
          className: labelClass
        });
      }
    }
  });

  polygonLayers.push(layer);

  const controls = layerUIControls[cfg.id];
  if (controls) {
    const { checkbox, slider } = controls;

    const rebuildLegend = () => {
      if (!checkbox.checked) {
        setLegendGroup(cfg.id, null);
        return;
      }

      const items = [];

      if (labelField) {
        Object.entries(colorMap).forEach(([value, color]) => {
          if (!value) return;
          items.push({
            label: value,
            color
          });
        });
      } else {
        const firstColor = Object.values(colorMap)[0] || '#e5e7eb';
        items.push({
          label: cfg.name,
          color: firstColor
        });
      }

      if (items.length) {
        setLegendGroup(cfg.id, {
          title: cfg.name,
          items
        });
      } else {
        setLegendGroup(cfg.id, null);
      }
    };

    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        layer.addTo(map);
        const val = parseFloat(slider.value);
        layer.setStyle({ fillOpacity: val });
        rebuildLegend();
      } else {
        map.removeLayer(layer);
        setLegendGroup(cfg.id, null);
      }
    });

    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      layer.setStyle({ fillOpacity: val });
    });
  }
}

function loadOverlayLayers() {
  GEOJSON_LAYERS_CONFIG.forEach(cfg => {
    fetch(cfg.url)
      .then(resp => resp.json())
      .then(data => {
        if (cfg.type === 'roads') {
          initRoadsLayer(data);
          setupRoadsToggleButton();
          updateRoadsVisibility();
        } else {
          createPolygonOverlay(cfg, data);
        }

        updatePolygonStyles();
      })
      .catch(err => {
        console.error('Error loading layer', cfg.id, err);
      });
  });
}

function updatePolygonStyles() {
  const z = map.getZoom();
  const w = getPolygonStrokeWidth(z);
  polygonLayers.forEach(layer => {
    layer.setStyle({ weight: w });
  });
}

function featureIntersectsBounds(feature, bounds) {
  const geom = feature.geometry;
  if (!geom) return false;

  const coords = geom.coordinates;
  const type = geom.type;

  if (!coords || !type) return false;

  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;

  function addCoord(c) {
    const lng = c[0];
    const lat = c[1];
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }

  function walkCoords(c) {
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      addCoord(c);
    } else {
      c.forEach(walkCoords);
    }
  }

  walkCoords(coords);
  const fBounds = L.latLngBounds([[minLat, minLng], [maxLat, maxLng]]);
  return bounds.intersects(fBounds);
}

function initRoadsLayer(data) {
  roadsData = data;

  roadsLayer = L.geoJSON(null, {
    interactive: false,
    bubblingMouseEvents: false,
    style: () => ({
      color: '#ffffff',
      weight: getRoadLineWidth(map.getZoom()),
      opacity: 0.6,
      interactive: false
    }),
    onEachFeature: (feature, layer) => {
      const name =
        feature.properties?.name ||
        feature.properties?.NAME ||
        feature.properties?.Name;

      if (name) {
        layer.bindTooltip(name, {
          permanent: false,
          direction: 'center',
          className: 'road-label'
        });
      }

      layer.options.interactive = false;
    }
  });
}

function updateRoadsLegend() {
  if (roadsVisible) {
    setLegendGroup('major_roads', {
      title: 'Major Roads',
      items: [
        {
          label: 'Major Roads',
          color: '#e5e7eb'
        }
      ]
    });
  } else {
    setLegendGroup('major_roads', null);
  }
}

function setupRoadsToggleButton() {
  const btn = document.getElementById('toggle-roads-btn');
  if (!btn) return;

  btn.addEventListener('click', () => {
    roadsVisible = !roadsVisible;
    btn.textContent = roadsVisible ? 'Major Roads: On' : 'Major Roads: Off';
    btn.classList.toggle('active', roadsVisible);
    updateRoadsLegend();
    updateRoadsVisibility();
  });
}

function updateRoadsVisibility() {
  const zoom = map.getZoom();
  const bounds = map.getBounds();

  const showLines = roadsVisible && zoom >= 16;
  const showLabels = roadsVisible && zoom >= 18;

  if (roadsLayer && roadsData) {
    roadsLayer.clearLayers();

    if (showLines) {
      (roadsData.features || []).forEach(feature => {
        if (featureIntersectsBounds(feature, bounds)) {
          roadsLayer.addData(feature);
        }
      });

      if (!map.hasLayer(roadsLayer)) {
        roadsLayer.addTo(map);
      }

      roadsLayer.setStyle({
        weight: getRoadLineWidth(zoom),
        color: '#ffffff',
        opacity: 0.6
      });
    } else {
      if (map.hasLayer(roadsLayer)) {
        map.removeLayer(roadsLayer);
      }
    }

    roadsLayer.eachLayer(layer => {
      if (!layer.getTooltip()) return;
      if (showLabels) {
        layer.openTooltip();
      } else {
        layer.closeTooltip();
      }
    });
  }
}

initLayerTogglePanel();
loadOverlayLayers();

map.on('zoomend', () => {
  updatePolygonStyles();
  updateRoadsVisibility();
});

map.on('moveend', () => {
  updateRoadsVisibility();
});

// --- Sidebar collapse / expand toggle --------------------------
(function () {
  const appEl = document.querySelector('.app');
  const toggleBtn = document.getElementById('sidebar-toggle');

  if (!appEl || !toggleBtn) return;

  toggleBtn.addEventListener('click', () => {
    const isCollapsed = appEl.classList.toggle('sidebar-collapsed');

    toggleBtn.setAttribute('aria-expanded', (!isCollapsed).toString());
    toggleBtn.setAttribute('aria-label', isCollapsed ? 'Show sidebar' : 'Hide sidebar');
    toggleBtn.innerHTML = isCollapsed ? '&raquo;' : '&laquo;';
  });
})();
