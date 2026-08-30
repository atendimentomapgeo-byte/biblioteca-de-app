/**
 * map.js
 * -----------------------------------------------------------------------
 * Módulo do mapa principal do FieldGIS, construído sobre a biblioteca
 * Leaflet (vendorizada em /vendor/leaflet.js, licença BSD — não depende de
 * nenhum serviço do Google e funciona inteiramente offline quando não há
 * camada online ativa).
 *
 * Responsabilidades:
 *   - Inicializar o mapa e os controles (zoom, escala);
 *   - Gerenciar mapas base (importados offline: GeoTIFF/imagem georreferenciada,
 *     ou online opcional quando houver internet disponível);
 *   - Exibir marcador de posição atual com círculo de precisão e seta de rumo;
 *   - Exibir grade de coordenadas UTM sobreposta;
 *   - Exibir coordenadas do centro/cursor do mapa;
 *   - Gerenciar camadas vetoriais (pontos, trilhas, polígonos) através do
 *     LayerManager (ver layers.js), mantendo referência aos objetos Leaflet.
 *
 * LIMITAÇÃO TÉCNICA DOCUMENTADA — Rotação do mapa:
 *   O Leaflet não suporta nativamente a rotação do "mundo" (tiles/overlays)
 *   sem um plugin pesado que reescreve o motor de eventos do mapa. Para
 *   manter o aplicativo robusto e sem dependências externas via CDN,
 *   implementamos rotação visual do container do mapa via CSS transform
 *   (bom para conferência visual rápida de orientação), mas desativamos o
 *   arraste manual do mapa enquanto a rotação está ativa (o recentraliza-se
 *   automaticamente no GPS), pois os eventos de ponteiro do Leaflet não são
 *   compensados pela rotação CSS. A seta de posição atual (heading) sempre
 *   gira corretamente, independentemente desse modo, o que atende a maior
 *   parte da necessidade de orientação em campo.
 */

(function () {
  let map = null;
  let baseLayers = {}; // name -> L.Layer
  let currentBaseLayerName = null;
  let activeOverlayLayers = {}; // layerId -> L.LayerGroup (pontos/trilhas/polígonos)
  let gridLayer = null;
  let positionMarker = null;
  let accuracyCircle = null;
  let headingMarkerRotation = 0;
  let rotationEnabled = false;
  let mapRotationDeg = 0;
  let settingsCache = null;
  let cursorCoordCallback = null;

  const DEFAULT_CENTER = [-15.7801, -47.9292]; // Brasília, apenas ponto de partida caso não haja GPS/projeto
  const DEFAULT_ZOOM = 5;

  function createPositionIcon() {
    return L.divIcon({
      className: 'fg-position-icon',
      html: `<div class="fg-position-arrow" id="fg-position-arrow">
               <svg width="34" height="34" viewBox="0 0 34 34">
                 <circle cx="17" cy="17" r="8" fill="#1a73e8" stroke="#fff" stroke-width="2"/>
                 <path d="M17 2 L23 15 L17 11.5 L11 15 Z" fill="#1a73e8" stroke="#fff" stroke-width="1"/>
               </svg>
             </div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
  }

  const MapModule = {
    init(containerId, settings) {
      settingsCache = settings || DB.defaultSettings();
      map = L.map(containerId, {
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        zoomControl: false,
        attributionControl: false,
        maxZoom: 22,
      });

      // Controles nativos do Leaflet (zoom +/-, escala, atribuição) removidos
      // de propósito: o app tem zoom por gesto de pinça/duplo toque e sua
      // própria barra de ferramentas, então esses widgets ficavam soltos por
      // cima da interface do app sem necessidade.

      // Mapa base "em branco" (papel quadriculado) — não depende de internet.
      baseLayers['blank'] = L.layerGroup(); // vazio, apenas fundo CSS
      MapModule.setBaseLayer('blank');

      // Mapas base online (só carregam de fato quando há internet; depois de
      // vistos uma vez, os tiles ficam salvos pelo Service Worker e continuam
      // aparecendo offline nas áreas já visitadas — ver service-worker.js).
      baseLayers['osm'] = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
      });
      baseLayers['satellite'] = L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        {
          maxZoom: 19,
          attribution: 'Esri, Maxar, Earthstar Geographics',
        }
      );

      // Restaura o último mapa de fundo usado (ou mantém "blank" se nunca escolheu nenhum).
      const ultimoBase = localStorage.getItem('fieldgis-basemap');
      if (ultimoBase && baseLayers[ultimoBase]) {
        MapModule.setBaseLayer(ultimoBase);
      }

      map.on('mousemove', (e) => {
        if (cursorCoordCallback) cursorCoordCallback(e.latlng);
      });
      map.on('move', () => {
        if (cursorCoordCallback) cursorCoordCallback(map.getCenter(), true);
      });

      positionMarker = L.marker(DEFAULT_CENTER, { icon: createPositionIcon(), zIndexOffset: 1000, interactive: false });
      accuracyCircle = L.circle(DEFAULT_CENTER, { radius: 0, className: 'fg-accuracy-circle', color: '#1a73e8', weight: 1, fillOpacity: 0.12 });

      return map;
    },

    getMap() {
      return map;
    },

    onCursorMove(cb) {
      cursorCoordCallback = cb;
    },

    setBaseLayer(name) {
      if (currentBaseLayerName && baseLayers[currentBaseLayerName]) {
        map.removeLayer(baseLayers[currentBaseLayerName]);
      }
      const layer = baseLayers[name];
      if (layer) {
        layer.addTo(map);
        currentBaseLayerName = name;
        try { localStorage.setItem('fieldgis-basemap', name); } catch (e) { /* ignora se indisponível */ }
      }
    },

    getCurrentBaseLayer() {
      return currentBaseLayerName;
    },

    /** Adiciona um mapa raster offline (GeoTIFF/imagem/PDF georreferenciado) como camada base. */
    addRasterBaseLayer(id, imageUrl, bounds, opts = {}) {
      const layer = L.imageOverlay(imageUrl, bounds, { opacity: opts.opacity ?? 1, className: 'fg-raster-layer' });
      baseLayers[id] = layer;
      return layer;
    },

    removeBaseLayerDef(id) {
      if (baseLayers[id]) {
        if (currentBaseLayerName === id) MapModule.setBaseLayer('blank');
        delete baseLayers[id];
      }
    },

    listBaseLayers() {
      return Object.keys(baseLayers);
    },

    /** Atualiza a posição/precisão do marcador "Minha localização". */
    updatePosition(lat, lon, accuracy, heading) {
      const latlng = [lat, lon];
      positionMarker.setLatLng(latlng);
      if (!map.hasLayer(positionMarker)) positionMarker.addTo(map);
      accuracyCircle.setLatLng(latlng);
      accuracyCircle.setRadius(accuracy || 0);
      if (!map.hasLayer(accuracyCircle)) accuracyCircle.addTo(map);

      if (heading != null && !Number.isNaN(heading)) {
        MapModule.updateHeading(heading);
      }
    },

    /**
     * Gira apenas a seta do marcador de posição, sem tocar em lat/lon/precisão.
     * Usada pela bússola do aparelho (compass.js), que emite leituras com
     * frequência bem maior do que as atualizações de posição do GPS.
     */
    updateHeading(heading) {
      headingMarkerRotation = heading;
      const arrow = document.getElementById('fg-position-arrow');
      if (arrow) arrow.style.transform = `rotate(${heading}deg)`;
    },

    centerOnPosition(lat, lon, zoom) {
      map.setView([lat, lon], zoom || Math.max(map.getZoom(), 17));
    },

    getCenter() {
      return map.getCenter();
    },

    /** Ativa/desativa a rotação visual do mapa (ver limitação documentada no topo do arquivo). */
    setMapRotation(deg) {
      mapRotationDeg = deg;
      const pane = map.getContainer();
      if (rotationEnabled) {
        pane.style.transform = `rotate(${-deg}deg)`;
        pane.style.transformOrigin = 'center center';
      }
    },

    setRotationEnabled(enabled) {
      rotationEnabled = enabled;
      map.dragging[enabled ? 'disable' : 'enable']();
      if (!enabled) {
        map.getContainer().style.transform = '';
      }
    },

    isRotationEnabled() {
      return rotationEnabled;
    },

    /** Desenha/atualiza a grade UTM sobre a área visível do mapa. */
    toggleGrid(show, datum) {
      if (gridLayer) {
        map.removeLayer(gridLayer);
        gridLayer = null;
        map.off('moveend', redrawGrid);
      }
      if (show) {
        gridLayer = L.layerGroup().addTo(map);
        const redraw = () => redrawGrid(datum);
        map.on('moveend', redraw);
        redrawGrid.current = redraw;
        redraw();
      }
    },

    addOverlayLayer(layerId, leafletLayerGroup) {
      activeOverlayLayers[layerId] = leafletLayerGroup;
      leafletLayerGroup.addTo(map);
    },

    getOverlayLayer(layerId) {
      return activeOverlayLayers[layerId];
    },

    removeOverlayLayer(layerId) {
      const l = activeOverlayLayers[layerId];
      if (l) {
        map.removeLayer(l);
        delete activeOverlayLayers[layerId];
      }
    },

    fitBounds(bounds) {
      map.fitBounds(bounds, { padding: [30, 30] });
    },

    invalidateSize() {
      map.invalidateSize();
    },
  };

  function redrawGrid(datum) {
    if (!gridLayer) return;
    gridLayer.clearLayers();
    const bounds = map.getBounds();
    const zoom = map.getZoom();
    // Escolhe um espaçamento de grade (em metros) adequado ao nível de zoom.
    const spacing = zoom >= 16 ? 100 : zoom >= 13 ? 500 : zoom >= 10 ? 2000 : 10000;

    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const centerLat = (sw.lat + ne.lat) / 2;
    const centerLon = (sw.lng + ne.lng) / 2;
    const utmCenter = Coordinates.toUTM(centerLat, centerLon, datum || 'SIRGAS2000');
    const zone = utmCenter.zone;
    const isSouth = centerLat < 0;

    const utmSW = Coordinates.toUTM(sw.lat, sw.lng, datum || 'SIRGAS2000', zone);
    const utmNE = Coordinates.toUTM(ne.lat, ne.lng, datum || 'SIRGAS2000', zone);

    const eStart = Math.floor(utmSW.easting / spacing) * spacing;
    const eEnd = Math.ceil(utmNE.easting / spacing) * spacing;
    const nStart = Math.floor(utmSW.northing / spacing) * spacing;
    const nEnd = Math.ceil(utmNE.northing / spacing) * spacing;

    const style = { color: '#ffb300', weight: 1, opacity: 0.6, interactive: false, dashArray: '4,4' };

    for (let e = eStart; e <= eEnd; e += spacing) {
      const p1 = Coordinates.fromUTM(e, utmSW.northing - spacing, zone, isSouth, datum || 'SIRGAS2000');
      const p2 = Coordinates.fromUTM(e, utmNE.northing + spacing, zone, isSouth, datum || 'SIRGAS2000');
      L.polyline([[p1.lat, p1.lon], [p2.lat, p2.lon]], style).addTo(gridLayer);
      L.marker([p2.lat, p2.lon], { icon: L.divIcon({ className: 'fg-grid-label', html: `${Math.round(e)}mE`, iconSize: [0, 0] }), interactive: false }).addTo(gridLayer);
    }
    for (let n = nStart; n <= nEnd; n += spacing) {
      const p1 = Coordinates.fromUTM(utmSW.easting - spacing, n, zone, isSouth, datum || 'SIRGAS2000');
      const p2 = Coordinates.fromUTM(utmNE.easting + spacing, n, zone, isSouth, datum || 'SIRGAS2000');
      L.polyline([[p1.lat, p1.lon], [p2.lat, p2.lon]], style).addTo(gridLayer);
      L.marker([p1.lat, p1.lon], { icon: L.divIcon({ className: 'fg-grid-label', html: `${Math.round(n)}mN`, iconSize: [0, 0] }), interactive: false }).addTo(gridLayer);
    }
  }

  window.MapModule = MapModule;
})();
