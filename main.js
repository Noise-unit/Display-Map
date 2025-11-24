// Initialize the Leaflet noisemap
const map = L.map('map', {
  zoomControl: true,
});

// === Basemaps (Esri streets and Google imagery) ===
const esriStreets = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
  {
    maxZoom: 18,
    attribution:
      'Tiles &copy; Esri — Source: Esri, HERE, Garmin, FAO, NOAA, USGS, © OpenStreetMap contributors, and the GIS User Community',
  }
).addTo(map);

const esriImagery = L.tileLayer(
  'https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
  {
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
    attribution:
      'Google - Contributions: Maxar Technologies, Airbus, CNES, SIO, NOAA, U.S. Navy, NGA, GEBCO',
    maxZoom: 20,
  }
);

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

// ---- Basemap toggle button (top-right) ----
let currentBase = 'streets';

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

const BaseSwitcher = L.Control.extend({
  options: { position: 'topright' },
  onAdd: function () {
    const container = L.DomUtil.create(
      'div',
      'leaflet-control basemap-toggle'
    );
    const btn = L.DomUtil.create('button', 'basemap-btn', container);
    btn.type = 'button';
    btn.title = 'Switch base layer: Streets ↔ Satellite';
    btn.setAttribute('aria-label', 'Switch base layer');
    btn.textContent = 'Satellite';

    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.on(btn, 'click', function (e) {
      L.DomEvent.stop(e);
      toggleBase(btn);
    });

    return container;
  },
});

map.addControl(new BaseSwitcher());

/****************************************************
 * GOOGLE SHEETS CONFIG & PROJ
 ****************************************************/

const SHEET_URLS = [
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vTe1IWRLcQKE6U_9VO7SPqdFYbhjiZ8RhsG3eZUYzpnM9xeOK6y7nBK6BAi7q2vkkHALkDoVbXFbmY6/pub?output=csv',
];

const EPSG32620 =
  '+proj=utm +zone=20 +datum=WGS84 +units=m +no_defs +type=crs';

const layerUIControls = {};

function utm32620ToLatLng(easting, northing) {
  const [lng, lat] = proj4(EPSG32620, 'EPSG:4326', [easting, northing]);
  return { lat, lng };
}

/****************************************************
 * GOOGLE SHEET POINTS: DATA, CONTROLS, LAYERS
 ****************************************************/

const COMPLAINT_CATEGORY_COLORS = {
  High: '#FF090B', // 7+
  Medium: '#FE9900', // 2–6
  Low: '#06FEEE', // 0–1
};

function complaintsToCategory(n) {
  const value = Number(n) || 0;
  if (value <= 1) return 'Low';
  if (value <= 6) return 'Medium';
  return 'High';
}

let allDataRows = [];
let sheetPoints = [];
let sheetMarkerLayer = null;
let sheetHeatLayer = null;
let sheetPointsVisible = false;
let sheetLabelsOn = false;
let sheetDisplayMode = 'categories'; // 'categories' | 'heatmap'

const sheetControls = {
  container: null,
  pointsCheckbox: null,
  labelsCheckbox: null,
  displayRadios: [],
};

// Load a single sheet URL
function loadSheet(url) {
  return new Promise((resolve, reject) => {
    Papa.parse(url, {
      download: true,
      header: true,
      dynamicTyping: false,
      complete: function (results) {
        const rows = results.data.filter(
          (r) => r['Easting'] && r['Northing']
        );
        resolve(rows);
      },
      error: function (err) {
        reject(err);
      },
    });
  });
}

// Load & merge all sheet URLs
async function loadAllSheets() {
  const promises = SHEET_URLS.map((u) => loadSheet(u));
  const sheetsArrays = await Promise.all(promises);
  allDataRows = sheetsArrays.flat();
  console.log('Loaded rows:', allDataRows.length, allDataRows);
}

// Build sheetPoints array
function buildSheetPoints() {
  if (!allDataRows || !allDataRows.length) return;

  sheetPoints = allDataRows
    .map((row) => {
      const e = parseFloat(row['Easting']);
      const n = parseFloat(row['Northing']);
      if (!Number.isFinite(e) || !Number.isFinite(n)) return null;

      const { lat, lng } = utm32620ToLatLng(e, n);

      const locationName =
        row['Location'] ||
        row['location'] ||
        row['Site'] ||
        row['Name'] ||
        '';

      const complaintsRaw =
        row['Number of Complaints'] ??
        row['Complaints'] ??
        row['No_of_Complaints'] ??
        row['Number_of_Complaints'];

      const complaints = Number(complaintsRaw) || 0;
      const category = complaintsToCategory(complaints);

      return { lat, lng, location: locationName, complaints, category };
    })
    .filter(Boolean);
}

// Initialise circle markers + heatmap from sheetPoints
function initSheetLayers() {
  if (!sheetPoints || !sheetPoints.length) {
    console.warn('No sheet points to render.');
    return;
  }

  // Circle markers
  sheetMarkerLayer = L.layerGroup();
  sheetPoints.forEach((p) => {
    const fillColor = COMPLAINT_CATEGORY_COLORS[p.category] || '#e5e7eb';

    const marker = L.circleMarker([p.lat, p.lng], {
      radius: 6,
      color: '#6b7280',
      weight: 1,
      fillColor,
      fillOpacity: 0.9,
    });

    const popupHtml = `
      <strong>${p.location || 'Location'}</strong><br/>
      Complaints: ${p.complaints}
    `;
    marker.bindPopup(popupHtml.trim());

    marker._locationName = p.location || '';
    marker._complaints = p.complaints;
    marker._complaintCategory = p.category;

    sheetMarkerLayer.addLayer(marker);
  });

  // Heatmap
  const heatData = sheetPoints.map((p) => [
    p.lat,
    p.lng,
    Math.max(p.complaints, 1),
  ]);

  sheetHeatLayer = L.heatLayer(heatData, {
    radius: 25,
    blur: 15,
    maxZoom: 17,
  });

  updateSheetLayerVisibility();
}

// Wire up controls from static HTML
function initSheetControls() {
  const panel = document.querySelector('.sheet-controls');
  if (!panel) {
    console.warn('No .sheet-controls panel found in DOM.');
    return;
  }

  sheetControls.container = panel;
  sheetControls.pointsCheckbox = panel.querySelector('#sheet-toggle-points');
  sheetControls.labelsCheckbox = panel.querySelector('#sheet-toggle-labels');
  sheetControls.displayRadios = panel.querySelectorAll(
    'input[name="sheet-display-mode"]'
  );

  if (sheetControls.pointsCheckbox) {
    sheetControls.pointsCheckbox.addEventListener('change', () => {
      sheetPointsVisible = sheetControls.pointsCheckbox.checked;
      updateSheetLayerVisibility();
    });
  }

  if (sheetControls.labelsCheckbox) {
    sheetControls.labelsCheckbox.addEventListener('change', () => {
      sheetLabelsOn = sheetControls.labelsCheckbox.checked;
      updateSheetLabels();
    });
  }

  sheetControls.displayRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      let mode = radio.value;
      if (mode === 'heat') mode = 'heatmap';
      sheetDisplayMode = mode;
      updateSheetLayerVisibility();
    });
  });
}

function updateSheetLegendCategories() {
  setLegendGroup('complaints', {
    title: 'Complaint Points',
    items: [
      {
        label: 'High (7+ complaints)',
        color: COMPLAINT_CATEGORY_COLORS.High,
      },
      {
        label: 'Medium (2–6 complaints)',
        color: COMPLAINT_CATEGORY_COLORS.Medium,
      },
      {
        label: 'Low (0–1 complaints)',
        color: COMPLAINT_CATEGORY_COLORS.Low,
      },
    ],
  });
}

function updateSheetLegendHeatmap() {
  setLegendGroup('complaints', {
    title: 'Complaints (Heatmap)',
    items: [
      {
        label: 'Low → High intensity',
        color: '#fb923c',
      },
    ],
  });
}

function updateSheetLayerVisibility() {
  if (!sheetMarkerLayer || !sheetHeatLayer) return;

  if (!sheetPointsVisible) {
    if (map.hasLayer(sheetMarkerLayer)) map.removeLayer(sheetMarkerLayer);
    if (map.hasLayer(sheetHeatLayer)) map.removeLayer(sheetHeatLayer);
    setLegendGroup('complaints', null);
    return;
  }

  if (sheetDisplayMode === 'heatmap') {
    if (map.hasLayer(sheetMarkerLayer)) map.removeLayer(sheetMarkerLayer);
    if (!map.hasLayer(sheetHeatLayer)) sheetHeatLayer.addTo(map);
    updateSheetLegendHeatmap();
  } else {
    if (map.hasLayer(sheetHeatLayer)) map.removeLayer(sheetHeatLayer);
    if (!map.hasLayer(sheetMarkerLayer)) sheetMarkerLayer.addTo(map);
    updateSheetLegendCategories();
  }

  updateSheetLabels();
}

function updateSheetLabels() {
  if (!sheetMarkerLayer) return;

  sheetMarkerLayer.eachLayer((marker) => {
    const locName = marker._locationName;
    if (!locName) return;

    if (marker.getTooltip()) {
      marker.closeTooltip();
      marker.unbindTooltip();
    }

    if (sheetPointsVisible && sheetLabelsOn) {
      marker.bindTooltip(locName, {
        permanent: true,
        direction: 'top',
        className: 'sheet-point-label',
      });
      marker.openTooltip();
    }
  });
}

/****************************************************
 * USER UPLOAD: CSV / GeoJSON / Shapefile
 ****************************************************/

// Colour schemes for uploaded layers
const UPLOAD_COLOR_SCHEMES = {
  pastel: ['#bfdbfe', '#a7f3d0', '#fde68a', '#fecaca', '#ddd6fe', '#f9a8d4'],
  vibrant: ['#f97316', '#22c55e', '#3b82f6', '#e11d48', '#a855f7', '#10b981'],
  blue: ['#bfdbfe', '#93c5fd', '#60a5fa', '#3b82f6', '#1d4ed8', '#1e40af'],
};

function reprojectGeoJSONFrom32620ToWgs84(geojson) {
  if (!geojson) return geojson;

  function reprojectCoord(c) {
    const x = c[0];
    const y = c[1];
    const [lng, lat] = proj4(EPSG32620, 'EPSG:4326', [x, y]);
    return [lng, lat];
  }

  function walkCoords(coords) {
    // Single coordinate [x, y]
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      return reprojectCoord(coords);
    }
    // Nested arrays
    return coords.map(walkCoords);
  }

  function reprojectGeometry(geom) {
    if (!geom || !geom.coordinates) return geom;
    return {
      ...geom,
      coordinates: walkCoords(geom.coordinates),
    };
  }

  function reprojectFeature(feature) {
    if (!feature) return feature;
    if (feature.type === 'Feature') {
      return {
        ...feature,
        geometry: reprojectGeometry(feature.geometry),
      };
    }
    return feature;
  }

  if (geojson.type === 'FeatureCollection') {
    return {
      ...geojson,
      features: geojson.features.map(reprojectFeature),
    };
  }

  if (geojson.type === 'Feature') {
    return reprojectFeature(geojson);
  }

  if (geojson.type && geojson.coordinates) {
    return reprojectGeometry(geojson);
  }

  return geojson;
}

let uploadLayerCounter = 0;
const uploadedLayers = [];
let uploadConfigState = null;

function refreshUploadedLayersUI() {
  const listEl = document.getElementById('upload-layers-list');
  const clearAllBtn = document.getElementById('upload-clear-all-btn');
  if (!listEl || !clearAllBtn) return;

  listEl.innerHTML = '';

  if (!uploadedLayers.length) {
    const empty = document.createElement('div');
    empty.className = 'upload-layers-empty';
    empty.textContent = 'No uploaded layers';
    listEl.appendChild(empty);

    clearAllBtn.disabled = true;
    return;
  }

  clearAllBtn.disabled = false;

  uploadedLayers.forEach((info) => {
    const row = document.createElement('div');
    row.className = 'upload-layers-item';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'upload-layer-name';
    nameSpan.textContent = info.name;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'upload-layer-remove-btn';
    removeBtn.textContent = 'Remove';

    removeBtn.addEventListener('click', () => {
      if (map.hasLayer(info.layer)) {
        map.removeLayer(info.layer);
      }
      setLegendGroup(info.id, null);

      const idx = uploadedLayers.findIndex((l) => l.id === info.id);
      if (idx !== -1) {
        uploadedLayers.splice(idx, 1);
      }

      refreshUploadedLayersUI();
    });

    row.appendChild(nameSpan);
    row.appendChild(removeBtn);
    listEl.appendChild(row);
  });
}

function clearAllUploadedLayers() {
  if (!uploadedLayers.length) return;

  uploadedLayers.forEach((info) => {
    if (map.hasLayer(info.layer)) {
      map.removeLayer(info.layer);
    }
    setLegendGroup(info.id, null);
  });

  uploadedLayers.length = 0;
  refreshUploadedLayersUI();
}

function detectGeometryType(features) {
  if (!features || !features.length) return 'point';
  for (const f of features) {
    if (!f || !f.geometry) continue;
    const t = f.geometry.type;
    if (!t) continue;
    if (t.includes('Point')) return 'point';
    if (t.includes('Polygon')) return 'polygon';
    if (t.includes('Line')) return 'line';
  }
  return 'point';
}

function initUploadButtonAndModal() {
  const uploadBtn = document.getElementById('sheet-upload-btn');
  const fileInput = document.getElementById('user-upload-input');
  const modalEl = document.getElementById('upload-config-modal');
  const clearAllBtn = document.getElementById('upload-clear-all-btn');

  if (!uploadBtn || !fileInput || !modalEl) {
    console.warn('Upload button or modal elements not found.');
    return;
  }

  uploadBtn.addEventListener('click', () => {
    fileInput.value = '';
    fileInput.click();
  });

  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', () => {
      clearAllUploadedLayers();
    });
  }

  // Render initial empty state for uploaded layers list
  refreshUploadedLayersUI();

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    handleUserFileSelected(file);
  });

  const closeBtn = document.getElementById('upload-config-close');
  const cancelBtn = document.getElementById('upload-config-cancel');
  const applyBtn = document.getElementById('upload-config-apply');

  if (closeBtn) {
    closeBtn.addEventListener('click', () => closeUploadConfigModal());
  }
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => closeUploadConfigModal());
  }
  if (applyBtn) {
    applyBtn.addEventListener('click', () => applyUploadConfig());
  }

  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) {
      closeUploadConfigModal();
    }
  });
}

function handleUserFileSelected(file) {
  const name = file.name || 'Uploaded layer';
  const ext = name.toLowerCase().split('.').pop();

  if (ext === 'csv') {
    parseUploadedCsv(file);
  } else if (ext === 'geojson' || ext === 'json') {
    parseUploadedGeoJson(file);
  } else if (ext === 'zip') {
    parseUploadedShapefile(file);
  } else if (ext === 'shp') {
    alert(
      'Please upload a zipped shapefile (.zip) containing .shp, .shx, .dbf (and optionally .prj).'
    );
  } else {
    alert('Unsupported file type. Use CSV, GeoJSON, or zipped shapefile (.zip).');
  }
}

// CSV
function parseUploadedCsv(file) {
  Papa.parse(file, {
    header: true,
    dynamicTyping: false,
    complete: (results) => {
      const rows = results.data.filter(
        (r) => r && Object.values(r).some((v) => v !== null && v !== '')
      );
      const headers = results.meta && results.meta.fields
        ? results.meta.fields
        : rows.length
        ? Object.keys(rows[0])
        : [];

      if (!rows.length || !headers.length) {
        alert('No usable rows found in CSV.');
        return;
      }

      uploadConfigState = {
        type: 'csv',
        fileName: file.name,
        rows,
        headers,
        geometryType: 'point',
      };

      openUploadConfigModal();
    },
    error: (err) => {
      console.error('Error parsing CSV:', err);
      alert('Error reading CSV file.');
    },
  });
}

// GeoJSON
function parseUploadedGeoJson(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const text = e.target.result;
      const geojson = JSON.parse(text);
      let featureCollection = null;

      if (geojson.type === 'FeatureCollection') {
        featureCollection = geojson;
      } else if (geojson.type === 'Feature') {
        featureCollection = { type: 'FeatureCollection', features: [geojson] };
      } else if (geojson.type && geojson.coordinates) {
        featureCollection = {
          type: 'FeatureCollection',
          features: [{ type: 'Feature', geometry: geojson, properties: {} }],
        };
      }

      if (!featureCollection || !featureCollection.features.length) {
        alert('No features found in GeoJSON.');
        return;
      }

      const features = featureCollection.features;
      const firstProps = features[0].properties || {};
      const headers = Object.keys(firstProps);
      const geometryType = detectGeometryType(features);

      uploadConfigState = {
        type: 'geojson',
        fileName: file.name,
        featureCollection,
        headers,
        geometryType,
      };

      openUploadConfigModal();
    } catch (err) {
      console.error('Error parsing GeoJSON:', err);
      alert('Error reading GeoJSON file.');
    }
  };
  reader.readAsText(file);
}

// Shapefile (zipped) – requires shpjs loaded in index.html
function parseUploadedShapefile(file) {
  if (typeof shp === 'undefined') {
    alert(
      'Shapefile support requires shpjs. Please include shp.min.js from unpkg in index.html.'
    );
    return;
  }

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const arrayBuffer = e.target.result;
      const geojson = await shp(arrayBuffer);

      let featureCollection = null;

      if (geojson.type === 'FeatureCollection') {
        featureCollection = geojson;
      } else if (typeof geojson === 'object') {
        const firstKey = Object.keys(geojson)[0];
        featureCollection = geojson[firstKey];
      }

      if (!featureCollection || !featureCollection.features.length) {
        alert('No features found in shapefile.');
        return;
      }

      const features = featureCollection.features;
      const firstProps = features[0].properties || {};
      const headers = Object.keys(firstProps);
      const geometryType = detectGeometryType(features);

      uploadConfigState = {
        type: 'geojson',
        fileName: file.name,
        featureCollection,
        headers,
        geometryType,
      };

      openUploadConfigModal();
    } catch (err) {
      console.error('Error reading shapefile:', err);
      alert('Error reading shapefile (.zip).');
    }
  };
  reader.readAsArrayBuffer(file);
}

// Open / populate config modal
function openUploadConfigModal() {
  const modalEl = document.getElementById('upload-config-modal');
  if (!modalEl || !uploadConfigState) return;

  const nameInput = document.getElementById('upload-layer-name');
  const labelFieldSel = document.getElementById('upload-label-field');
  const styleFieldSel = document.getElementById('upload-style-field');
  const colorSchemeSel = document.getElementById('upload-color-scheme');
  const geomRowCsv = document.getElementById('upload-geom-row-csv');
  const latFieldSel = document.getElementById('upload-lat-field');
  const lngFieldSel = document.getElementById('upload-lng-field');
  const pointOptions = document.getElementById('upload-point-options');
  const polyOptions = document.getElementById('upload-polygon-options');
  const crsSel = document.getElementById('upload-crs');

  const baseName =
    uploadConfigState.fileName?.replace(/\.[^.]+$/, '') || 'Uploaded layer';
  if (nameInput) nameInput.value = baseName;

  const headers = uploadConfigState.headers || [];

  function fillSelect(selectEl, options, includeEmpty) {
    if (!selectEl) return;
    selectEl.innerHTML = '';
    if (includeEmpty) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'None';
      selectEl.appendChild(opt);
    }
    options.forEach((h) => {
      const opt = document.createElement('option');
      opt.value = h;
      opt.textContent = h;
      selectEl.appendChild(opt);
    });
  }

  if (labelFieldSel) fillSelect(labelFieldSel, headers, false);
  if (styleFieldSel) fillSelect(styleFieldSel, headers, true);

  if (geomRowCsv && latFieldSel && lngFieldSel) {
    if (uploadConfigState.type === 'csv') {
      geomRowCsv.style.display = 'flex';
      fillSelect(latFieldSel, headers, false);
      fillSelect(lngFieldSel, headers, false);

      const latGuess =
        headers.find((h) => /lat/i.test(h)) || headers[0];
      const lngGuess =
        headers.find((h) => /lon|lng|long/i.test(h)) || headers[1] || headers[0];
      latFieldSel.value = latGuess;
      lngFieldSel.value = lngGuess;
    } else {
      geomRowCsv.style.display = 'none';
    }
  }

  if (pointOptions && polyOptions) {
    const gType = uploadConfigState.geometryType || 'point';
    if (gType === 'point') {
      pointOptions.style.display = 'flex';
      polyOptions.style.display = 'none';
    } else {
      pointOptions.style.display = 'none';
      polyOptions.style.display = 'flex';
    }
  }

  if (colorSchemeSel && !colorSchemeSel.value) {
    colorSchemeSel.value = 'pastel';
  }
  if (crsSel && !crsSel.value) {
    // Default to EPSG:32620 because that's what you're using
    crsSel.value = 'epsg32620';
  }

  modalEl.classList.remove('hidden');
}

function closeUploadConfigModal() {
  const modalEl = document.getElementById('upload-config-modal');
  if (!modalEl) return;
  modalEl.classList.add('hidden');
  uploadConfigState = null;
}

// Build colour map for uploaded layer
function buildUploadColorMap(fieldName, records, paletteName) {
  const palette =
    UPLOAD_COLOR_SCHEMES[paletteName] || UPLOAD_COLOR_SCHEMES.pastel;
  const values = [];

  records.forEach((r) => {
    const v = r[fieldName];
    if (v !== null && v !== undefined && String(v).trim() !== '') {
      values.push(String(v));
    }
  });

  const unique = Array.from(new Set(values));
  if (!unique.length) {
    return { defaultColor: palette[0], map: {} };
  }

  const map = {};
  unique.forEach((val, idx) => {
    map[val] = palette[idx % palette.length];
  });

  return { defaultColor: palette[0], map };
}

// Apply config and add layer
function applyUploadConfig() {
  if (!uploadConfigState) return;

  const nameInput = document.getElementById('upload-layer-name');
  const labelFieldSel = document.getElementById('upload-label-field');
  const styleFieldSel = document.getElementById('upload-style-field');
  const colorSchemeSel = document.getElementById('upload-color-scheme');
  const latFieldSel = document.getElementById('upload-lat-field');
  const lngFieldSel = document.getElementById('upload-lng-field');
  const pointStyleRadios = document.querySelectorAll(
    'input[name="upload-point-style"]'
  );
  const lineWidthSel = document.getElementById('upload-line-width');
  const outlineStyleSel = document.getElementById('upload-outline-style');
  const crsSel = document.getElementById('upload-crs');

  const layerName =
    (nameInput && nameInput.value.trim()) || 'Uploaded layer';
  const labelField = labelFieldSel?.value || '';
  const styleField = styleFieldSel?.value || '';
  const colorScheme = colorSchemeSel?.value || 'pastel';
  const latField = latFieldSel?.value || '';
  const lngField = lngFieldSel?.value || '';
  const dataCRS = crsSel?.value || 'epsg32620';

  let pointStyle = 'circle';
  pointStyleRadios.forEach((r) => {
    if (r.checked) pointStyle = r.value;
  });

  const lineWidth = lineWidthSel ? Number(lineWidthSel.value) || 2 : 2;
  const outlineStyle = outlineStyleSel?.value || 'solid';

  let layer = null;
  let legendItems = [];

  if (uploadConfigState.type === 'csv') {
    const rows = uploadConfigState.rows || [];
    const { defaultColor, map: colorMap } = styleField
      ? buildUploadColorMap(
          styleField,
          rows.map((r) => ({ [styleField]: r[styleField] })),
          colorScheme
        )
      : { defaultColor: UPLOAD_COLOR_SCHEMES[colorScheme][0], map: {} };

    const group = L.layerGroup();
    const legendCategories = new Set();

    rows.forEach((row) => {
      // Interpret chosen fields depending on CRS
      let latLng;

      if (dataCRS === 'epsg32620') {
        // Treat selected fields as UTM (Easting / Northing)
        const easting = parseFloat(row[latField]);   // X (Easting)
        const northing = parseFloat(row[lngField]);  // Y (Northing)
        if (!Number.isFinite(easting) || !Number.isFinite(northing)) return;

        const { lat, lng } = utm32620ToLatLng(easting, northing);
        latLng = [lat, lng];
      } else {
        // Treat selected fields as normal Lat / Lng in degrees
        const lat = parseFloat(row[latField]);
        const lng = parseFloat(row[lngField]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        latLng = [lat, lng];
      }

      const styleVal = styleField ? row[styleField] : null;
      const styleKey =
        styleVal !== null && styleVal !== undefined
          ? String(styleVal)
          : 'default';
      const color = styleField
        ? colorMap[styleKey] || defaultColor
        : defaultColor;

      const labelText = labelField ? row[labelField] : layerName;

      let m;
      if (pointStyle === 'pin') {
        m = L.marker(latLng, { riseOnHover: true });
      } else {
        m = L.circleMarker(latLng, {
          radius: 6,
          color: '#6b7280',
          weight: 1,
          fillColor: color,
          fillOpacity: 0.9,
        });
      }

      m._uploadLabelText = labelText;
      if (labelText) {
        m.bindTooltip(labelText, {
          permanent: true,
          direction: 'top',
          className: 'sheet-point-label',
        });
      }

      const popupHtml =
        `<strong>${labelText}</strong><br/>` +
        (styleField ? `${styleField}: ${styleVal}<br/>` : '') +
        Object.entries(row)
          .map(([k, v]) => `${k}: ${v}`)
          .join('<br/>');

      m.bindPopup(popupHtml);

      group.addLayer(m);

      if (styleField && styleKey !== 'default') {
        legendCategories.add(styleKey);
      }
    });

    if (!group.getLayers().length) {
      alert(
        dataCRS === 'epsg32620'
          ? 'No valid coordinate rows found (check Easting / Northing fields).'
          : 'No valid coordinate rows found (check Lat / Lng columns).'
      );
      return;
    }

    layer = group;

    if (styleField && legendCategories.size) {
      const palette =
        UPLOAD_COLOR_SCHEMES[colorScheme] || UPLOAD_COLOR_SCHEMES.pastel;
      const catsArray = Array.from(legendCategories);
      const tmpColorMap = {};
      catsArray.forEach((cat, idx) => {
        tmpColorMap[cat] = palette[idx % palette.length];
      });
      legendItems = catsArray.map((cat) => ({
        label: `${styleField}: ${cat}`,
        color: tmpColorMap[cat],
      }));
    } else {
      legendItems = [
        {
          label: layerName,
          color: UPLOAD_COLOR_SCHEMES[colorScheme][0],
        },
      ];
    }
  } else if (uploadConfigState.type === 'geojson') {
    let fc = uploadConfigState.featureCollection;

    if (dataCRS === 'epsg32620') {
      fc = reprojectGeoJSONFrom32620ToWgs84(fc);
    }

    const features = (fc && fc.features) || [];
    if (!features.length) {
      alert('No features to display.');
      return;
    }

    const geometryType = uploadConfigState.geometryType || 'point';
    const colorInput = styleField
      ? features.map((f) => ({
          [styleField]: f.properties?.[styleField],
        }))
      : [];

    const { defaultColor, map: colorMap } = styleField
      ? buildUploadColorMap(styleField, colorInput, colorScheme)
      : { defaultColor: UPLOAD_COLOR_SCHEMES[colorScheme][0], map: {} };

    const legendCategories = new Set();

    if (geometryType === 'point') {
      layer = L.geoJSON(fc, {
        pointToLayer: (feature, latlng) => {
          const props = feature.properties || {};
          const styleVal = styleField ? props[styleField] : null;
          const styleKey =
            styleVal !== null && styleVal !== undefined
              ? String(styleVal)
              : 'default';
          const color = styleField
            ? colorMap[styleKey] || defaultColor
            : defaultColor;

          let m;
          if (pointStyle === 'pin') {
            m = L.marker(latlng, { riseOnHover: true });
          } else {
            m = L.circleMarker(latlng, {
              radius: 6,
              color: '#6b7280',
              weight: 1,
              fillColor: color,
              fillOpacity: 0.9,
            });
          }

          if (styleField && styleKey !== 'default') {
            legendCategories.add(styleKey);
          }

          return m;
        },
        onEachFeature: (feature, lyr) => {
          const props = feature.properties || {};
          const labelText = labelField
            ? props[labelField]
            : layerName;

          if (labelText) {
            lyr.bindTooltip(String(labelText), {
              permanent: true,
              direction: 'top',
              className: 'sheet-point-label',
            });
          }

          const popupHtml =
            `<strong>${labelText || layerName}</strong><br/>` +
            Object.entries(props)
              .map(([k, v]) => `${k}: ${v}`)
              .join('<br/>');

          lyr.bindPopup(popupHtml);
        },
      });
    } else {
      layer = L.geoJSON(fc, {
        style: (feature) => {
          const props = feature.properties || {};
          const styleVal = styleField ? props[styleField] : null;
          const styleKey =
            styleVal !== null && styleVal !== undefined
              ? String(styleVal)
              : 'default';
          const color = styleField
            ? colorMap[styleKey] || defaultColor
            : defaultColor;

          if (styleField && styleKey !== 'default') {
            legendCategories.add(styleKey);
          }

          return {
            color,
            weight: lineWidth,
            dashArray: outlineStyle === 'dashed' ? '4 4' : null,
            fillColor: color,
            fillOpacity:
              uploadConfigState.geometryType === 'polygon' ? 0.25 : 0,
          };
        },
        onEachFeature: (feature, lyr) => {
          const props = feature.properties || {};
          const labelText = labelField
            ? props[labelField]
            : layerName;

          if (labelText) {
            lyr.bindTooltip(String(labelText), {
              direction: 'center',
              className: 'sheet-point-label',
            });
          }

          const popupHtml =
            `<strong>${labelText || layerName}</strong><br/>` +
            Object.entries(props)
              .map(([k, v]) => `${k}: ${v}`)
              .join('<br/>');

          lyr.bindPopup(popupHtml);
        },
      });
    }

    if (!layer || !layer.getLayers().length) {
      alert('No features to display from uploaded GeoJSON.');
      return;
    }

    if (styleField && legendCategories.size) {
      const palette =
        UPLOAD_COLOR_SCHEMES[colorScheme] || UPLOAD_COLOR_SCHEMES.pastel;
      const catsArray = Array.from(legendCategories);
      const tmpColorMap = {};
      catsArray.forEach((cat, idx) => {
        tmpColorMap[cat] = palette[idx % palette.length];
      });
      legendItems = catsArray.map((cat) => ({
        label: `${styleField}: ${cat}`,
        color: tmpColorMap[cat],
      }));
    } else {
      legendItems = [
        {
          label: layerName,
          color: defaultColor,
        },
      ];
    }
  }

  if (!layer) return;

  layer.addTo(map);

  if (typeof layer.getBounds === 'function') {
    const b = layer.getBounds();
    if (b && typeof b.isValid === 'function' && b.isValid()) {
      map.fitBounds(b, { padding: [20, 20] });
    }
  }

  const legendKey = `upload_${++uploadLayerCounter}`;
  if (legendItems.length) {
    setLegendGroup(legendKey, {
      title: layerName,
      items: legendItems,
    });
  }

  uploadedLayers.push({
    id: legendKey,
    name: layerName,
    layer,
    type: uploadConfigState.type,
  });

  // Update uploaded-layers UI list
  refreshUploadedLayersUI();

  closeUploadConfigModal();
}

/****************************************************
 * GEOCODER
 ****************************************************/

const TT_BBOX = [-61.95, 10.0, -60.5, 11.5];
let geocoder = null;

if (L.Control && (L.Control.Geocoder || L.Control.geocoder)) {
  // Only create the control if the plugin is actually available
  geocoder = L.Control.geocoder({
    position: 'topright',
    defaultMarkGeocode: false,
    geocoder: L.Control.Geocoder && L.Control.Geocoder.nominatim
      ? L.Control.Geocoder.nominatim({
          geocodingQueryParams: {
            countrycodes: 'tt',
            viewbox: `${TT_BBOX[0]},${TT_BBOX[3]},${TT_BBOX[2]},${TT_BBOX[1]}`,
            bounded: 1,
          },
        })
      : undefined,
  })
    .on('markgeocode', (e) => {
      const { center, bbox, name } = e.geocode;

      if (searchMarker) {
        map.removeLayer(searchMarker);
      }

      searchMarker = L.marker(center)
        .addTo(map)
        .bindPopup(`<strong>${name}</strong>`)
        .openPopup();

      map.fitBounds(bbox);
    })
    .addTo(map);

  // Only wire up the DOM if geocoder exists
  const geocoderContainer = geocoder._container;
  const geocoderInput = geocoderContainer.querySelector(
    '.leaflet-control-geocoder-form input'
  );

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
  customClearBtn.setAttribute(
    'aria-label',
    'Clear search and remove marker'
  );
  customClearBtn.textContent = '×';

  const formEl = geocoderContainer.querySelector(
    '.leaflet-control-geocoder-form'
  );
  if (formEl) {
    formEl.style.position = 'relative';
    formEl.appendChild(customClearBtn);
    customClearBtn.addEventListener('click', (e) => {
      e.preventDefault();
      clearGeocoderResult(geocoderInput);
      geocoderInput && geocoderInput.focus();
    });
  }
} else {
  console.warn(
    'leaflet-control-geocoder plugin not available; search box disabled.'
  );
}

/**********************
 * INSET MAP
 **********************/

function boundsAtZoom(center, zoom) {
  const size = map.getSize();
  const half = size.divideBy(2);
  const centerPx = map.project(center, zoom);
  const sw = map.unproject(centerPx.subtract(half), zoom);
  const ne = map.unproject(centerPx.add(half), zoom);
  return L.latLngBounds(sw, ne);
}

const BOUNDS_TRINIDAD = L.latLngBounds([9.95, -61.95], [10.95, -60.45]);
const BOUNDS_TOBAGO = L.latLngBounds([11.05, -60.95], [11.4, -60.4]);

const InsetControl = L.Control.extend({
  options: { position: 'bottomright' },

  onAdd: function () {
    const container = L.DomUtil.create(
      'div',
      'inset-container leaflet-bar'
    );
    container.innerHTML = '<div id="insetMap" class="inset-map"></div>';

    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);

    return container;
  },

  onRemove: function () {},
});

map.addControl(new InsetControl());

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

const insetTiles = L.tileLayer(
  'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png',
  { subdomains: 'abcd', maxZoom: 19 }
).addTo(insetMap);

const viewRect = L.rectangle(map.getBounds(), {
  color: 'red',
  weight: 2,
  fill: false,
  className: 'inset-viewport-rect',
}).addTo(insetMap);

function islandForCenter(centerLatLng) {
  return BOUNDS_TOBAGO.contains(centerLatLng) ? 'TOBAGO' : 'TRINIDAD';
}

function updateInset() {
  const center = map.getCenter();
  const currentZoom = map.getZoom();

  const island = islandForCenter(center);
  const targetBounds =
    island === 'TOBAGO' ? BOUNDS_TOBAGO : BOUNDS_TRINIDAD;

  insetMap.fitBounds(targetBounds, { animate: false, padding: [0, 0] });

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

/**********************
 * LEGEND
 **********************/

const legendGroups = {};
let legendBodyEl = null;

const LegendControl = L.Control.extend({
  options: { position: 'topright' },

  onAdd: function () {
    const container = L.DomUtil.create(
      'div',
      'legend-container leaflet-bar'
    );
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
  },
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

    group.items.forEach((item) => {
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

map.addControl(new LegendControl());

/**********************
 * PREDEFINED OVERLAY LAYERS
 **********************/

function createLayerToggleRow(
  layerId,
  labelText,
  defaultOpacity = 0.7,
  defaultVisible = true
) {
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

  mainRow.appendChild(label);
  mainRow.appendChild(checkbox);
  row.appendChild(mainRow);

  const sliderRow = document.createElement('div');
  sliderRow.className = 'layer-toggle-slider-row';

  const sliderLabel = document.createElement('span');
  sliderLabel.textContent = 'Opacity';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = 0;
  slider.max = 1;
  slider.step = 0.05;
  slider.value = defaultOpacity;

  sliderRow.appendChild(sliderLabel);
  sliderRow.appendChild(slider);
  row.appendChild(sliderRow);

  container.appendChild(row);

  return {
    checkbox,
    slider,
  };
}

/**********************
 * SIDEBAR TOGGLE & COLLAPSIBLE SECTIONS
 **********************/

function initSidebarToggle() {
  const appEl = document.querySelector('.app');
  const sidebarToggleBtn = document.getElementById('sidebar-toggle');
  if (!appEl || !sidebarToggleBtn) return;

  sidebarToggleBtn.addEventListener('click', () => {
    const isCollapsed = appEl.classList.toggle('sidebar-collapsed');

    // Update arrow and aria label/state
    if (isCollapsed) {
      sidebarToggleBtn.innerHTML = '&raquo;';
      sidebarToggleBtn.setAttribute('aria-label', 'Show sidebar');
      sidebarToggleBtn.setAttribute('aria-expanded', 'false');
    } else {
      sidebarToggleBtn.innerHTML = '&laquo;';
      sidebarToggleBtn.setAttribute('aria-label', 'Hide sidebar');
      sidebarToggleBtn.setAttribute('aria-expanded', 'true');
    }

    // Resize map so it fills the available space
    if (typeof map !== 'undefined' && map.invalidateSize) {
      setTimeout(() => map.invalidateSize(), 200);
    }
  });
}

function initCollapsibleSections() {
  const sections = document.querySelectorAll('.collapsible-section');

  sections.forEach((section) => {
    const header = section.querySelector('.section-header');
    const body = section.querySelector('.section-body');
    if (!header || !body) return;

    // Ensure we have a chevron span for rotation styling
    let chevron = header.querySelector('.section-chevron');
    if (!chevron) {
      chevron = document.createElement('span');
      chevron.className = 'section-chevron';
      chevron.textContent = '▾';
      header.appendChild(chevron);
    }

    header.addEventListener('click', () => {
      const nowCollapsed = section.classList.toggle('collapsed');
      header.setAttribute('aria-expanded', String(!nowCollapsed));
      // CSS already handles .collapsible-section.collapsed .section-body
    });

    // Initialise ARIA state as expanded
    header.setAttribute('aria-expanded', 'true');
  });
}

/**********************
 * GEOJSON OVERLAYS
 **********************/

const GEOJSON_LAYERS_CONFIG = [
  {
    id: 'municipality',
    name: 'Municipalities',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Municipality.geojson',
    type: 'municipality',
  },
  {
    id: 'aripo',
    name: 'Aripo Savannas',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Aripo%20Savannas.geojson',
    type: 'protected',
  },
  {
    id: 'matura',
    name: 'Matura National Park',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Matura%20National%20Park.geojson',
    type: 'protected',
  },
  {
    id: 'nariva',
    name: 'Nariva Swamp',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Nariva%20Swamp.geojson',
    type: 'protected',
  },
  {
    id: 'caroni',
    name: 'Caroni Swamp',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Caroni%20Swamp.geojson',
    type: 'protected',
  },
  {
    id: 'aripo_buffer',
    name: 'Aripo Savannas Buffer',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Aripo%20Savannas%20Buffer.geojson',
    type: 'protected',
  },
  {
    id: 'matura_buffer',
    name: 'Matura National Park Buffer',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Matura%20National%20Park%20Buffer.geojson',
    type: 'protected',
  },
  {
    id: 'nariva_buffer',
    name: 'Nariva Swamp Buffer',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Nariva%20Swamp%20Buffer.geojson',
    type: 'protected',
  },
  // Major roads
  {
    id: 'major_roads',
    name: 'Major Roads',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Major%20Roads.geojson',
    type: 'roads',
  },
  // Noise zones
  {
    id: 'noise_zones',
    name: 'Noise Zones',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Noise%20Zones.geojson',
    type: 'zone',
  },
  {
    id: 'proposed_noise_zones',
    name: 'Proposed Noise Zones',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Proposed%20Noise%20Zones.geojson',
    type: 'zone',
  },
  // Chaguaramas Event Locations
  {
    id: 'chag_events',
    name: 'Chaguaramas Event Locations',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Chaguaramas%20Event%20Locations.geojson',
    type: 'events',
  },
  // Chaguaramas Nature Reserve
  {
    id: 'chag_nature_reserve',
    name: 'Chaguaramas Nature Reserve',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Chaguaramas.geojson',
    type: 'protected',
  },
  // Trinidad Forest Reserves
  {
    id: 'forest_reserves',
    name: 'Trinidad Forest Reserves',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Forest%20Reserves.geojson',
    type: 'protected',
  },
  // Main Ridge
  {
    id: 'main_ridge',
    name: 'Main Ridge',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/HummingBirds_MainRidge.geojson',
    type: 'protected',
  },
  // Private Medical Facilities
  {
    id: 'private_medical_trinidad',
    name: 'Private Medical Facilities',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/PrivateMedicalFacilities_Trinidad.geojson',
    type: 'poi',
  },
  // Tobago TCPD Policy
  {
    id: 'tobago_tcpd_policy',
    name: 'Tobago TCPD Policy',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Tobago%20TCPD%20Policy.geojson',
    type: 'policy',
    labelField: 'Class_Name',
  },
  // Tobago Watersheds
  {
    id: 'tobago_watersheds',
    name: 'Tobago Watershed',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Tobago%20Watersheds.geojson',
    type: 'watershed',
    labelField: 'WATERSHED',
  },
  // Tobago Hospitals
  {
    id: 'tobago_hospitals',
    name: 'Tobago Hospitals',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/TobagoHospitals.geojson',
    type: 'poi',
  },
  // Trinidad TCPD Policy
  {
    id: 'trinidad_tcpd_policy',
    name: 'Trinidad TCPD Policy',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Trinidad%20TCPD%20Policy.geojson',
    type: 'policy',
    labelField: 'Class_Name',
  },
  // Trinidad Watersheds
  {
    id: 'trinidad_watersheds',
    name: 'Trinidad Watershed',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/Trinidad%20Watersheds.geojson',
    type: 'watershed',
    labelField: 'Name',
  },
  // Trinidad Hospitals
  {
    id: 'trinidad_hospitals',
    name: 'Trinidad Hospitals',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/TrinidadHospitals.geojson',
    type: 'poi',
  },
  // Turtle Nesting Sites
  {
    id: 'turtle_nesting_sites',
    name: 'Turtle Nesting Sites',
    url: 'https://raw.githubusercontent.com/Noise-unit/GeojsonLayers/refs/heads/main/TurtleNestingSites.geojson',
    type: 'poi',
    labelField: 'layer',
  },
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
  const unique = Array.from(new Set(values)).filter(
    (v) =>
      v !== undefined && v !== null && String(v).trim() !== ''
  );
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

function createLayerToggleRow(
  layerId,
  labelText,
  defaultOpacity = 0.7,
  defaultVisible = true
) {
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

  GEOJSON_LAYERS_CONFIG.forEach((cfg) => {
    // skip roads from generic toggle (handled separately)
    if (cfg.type === 'roads') return;

    const controls = createLayerToggleRow(
      cfg.id,
      cfg.name,
      0.7,
      false
    );
    if (controls) {
      layerUIControls[cfg.id] = controls;
    }
  });
}

function guessLabelProperty(features) {
  if (!features || !features.length) return null;

  const props = features[0].properties || {};
  const candidateKeys = [
    'zone',
    'ZONE',
    'name',
    'Name',
    'NAME',
    'label',
    'Label',
    'LABEL',
    'category',
    'Category',
    'CATEGORY',
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
    (cfg.type === 'municipality'
      ? 'NAME_1'
      : cfg.type === 'zone'
      ? 'zone'
      : null) ||
    guessLabelProperty(features);

  const valuesForColors = labelField
    ? features.map((f) => f.properties?.[labelField])
    : [cfg.name];

  const colorMap = buildCategoryColorMap(
    valuesForColors.length ? valuesForColors : [cfg.name]
  );

  const labelClass =
    cfg.type === 'municipality'
      ? 'municipality-label'
      : cfg.type === 'zone'
      ? 'zone-label'
      : 'protected-label';

  const layer = L.geoJSON(data, {
    style: (feature) => {
      const key = labelField
        ? feature.properties?.[labelField]
        : cfg.name;
      const fillColor =
        colorMap[key] ||
        Object.values(colorMap)[0] ||
        '#e5e7eb';

      return {
        color: '#6b7280', // medium grey
        weight: getPolygonStrokeWidth(map.getZoom()),
        fillColor,
        fillOpacity: 0.0,
      };
    },
    onEachFeature: (feature, lyr) => {
      const labelText = labelField
        ? feature.properties?.[labelField]
        : cfg.name;

      if (labelText) {
        lyr.bindTooltip(labelText, {
          direction: 'center',
          className: labelClass,
        });
      }
    },
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
            color,
          });
        });
      } else {
        const firstColor =
          Object.values(colorMap)[0] || '#e5e7eb';
        items.push({
          label: cfg.name,
          color: firstColor,
        });
      }

      if (items.length) {
        setLegendGroup(cfg.id, {
          title: cfg.name,
          items,
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
  GEOJSON_LAYERS_CONFIG.forEach((cfg) => {
    fetch(cfg.url)
      .then((resp) => resp.json())
      .then((data) => {
        if (cfg.type === 'roads') {
          initRoadsLayer(data);
          setupRoadsToggleButton();
          updateRoadsVisibility();
        } else {
          createPolygonOverlay(cfg, data);
        }

        updatePolygonStyles();
      })
      .catch((err) => {
        console.error('Error loading layer', cfg.id, err);
      });
  });
}

function updatePolygonStyles() {
  const z = map.getZoom();
  const w = getPolygonStrokeWidth(z);
  polygonLayers.forEach((layer) => {
    layer.setStyle({ weight: w });
  });
}

function featureIntersectsBounds(feature, bounds) {
  const geom = feature.geometry;
  if (!geom) return false;

  const coords = geom.coordinates;
  const type = geom.type;

  if (!coords || !type) return false;

  let minLat = Infinity,
    minLng = Infinity,
    maxLat = -Infinity,
    maxLng = -Infinity;

  function addCoord(c) {
    const lng = c[0];
    const lat = c[1];
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }

  function walkCoords(c) {
    if (
      typeof c[0] === 'number' &&
      typeof c[1] === 'number'
    ) {
      addCoord(c);
    } else {
      c.forEach(walkCoords);
    }
  }

  walkCoords(coords);
  const fBounds = L.latLngBounds(
    [[minLat, minLng],
    [maxLat, maxLng]]
  );
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
      interactive: false,
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
          className: 'road-label',
        });
      }

      layer.options.interactive = false;
    },
  });
}

function updateRoadsLegend() {
  if (roadsVisible) {
    setLegendGroup('major_roads', {
      title: 'Major Roads',
      items: [
        {
          label: 'Major Roads',
          color: '#e5e7eb',
        },
      ],
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
    btn.textContent = roadsVisible
      ? 'Major Roads: On'
      : 'Major Roads: Off';
    btn.classList.toggle('active', roadsVisible);
    updateRoadsLegend();
    updateRoadsVisibility();
  });
}

function updateRoadsVisibility() {
  if (!roadsLayer || !roadsData) return;

  const zoom = map.getZoom();
  const bounds = map.getBounds();

  const showLines = roadsVisible && zoom >= 16;
  const showLabels = roadsVisible && zoom >= 18;

  roadsLayer.clearLayers();

  if (showLines) {
    (roadsData.features || []).forEach((feature) => {
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
      opacity: 0.6,
    });
  } else {
    if (map.hasLayer(roadsLayer)) {
      map.removeLayer(roadsLayer);
    }
  }

  roadsLayer.eachLayer((layer) => {
    if (!layer.getTooltip()) return;
    if (showLabels) {
      layer.openTooltip();
    } else {
      layer.closeTooltip();
    }
  });
}

/**********************
 * INIT SEQUENCE & EVENTS
 **********************/

initLayerTogglePanel();
initSheetControls();
initUploadButtonAndModal();
loadOverlayLayers();

loadAllSheets()
  .then(() => {
    buildSheetPoints();
    initSheetLayers();
  })
  .catch((err) => {
    console.error('Error loading sheet data', err);
  });

map.on('zoomend', () => {
  updatePolygonStyles();
  updateRoadsVisibility();
});

map.on('moveend', () => {
  updateRoadsVisibility();
});

// Sidebar collapse / expand toggle
(function () {
  const appEl = document.querySelector('.app');
  const toggleBtn = document.getElementById('sidebar-toggle');

  if (!appEl || !toggleBtn) return;

  toggleBtn.addEventListener('click', () => {
    const isCollapsed = appEl.classList.toggle('sidebar-collapsed');

    toggleBtn.setAttribute(
      'aria-expanded',
      (!isCollapsed).toString()
    );
    toggleBtn.setAttribute(
      'aria-label',
      isCollapsed ? 'Show sidebar' : 'Hide sidebar'
    );
    toggleBtn.innerHTML = isCollapsed ? '&raquo;' : '&laquo;';

    // Invalidate map size so Leaflet redraws correctly
    setTimeout(() => {
      map.invalidateSize();
      insetMap.invalidateSize();
    }, 310);
  });
})();
