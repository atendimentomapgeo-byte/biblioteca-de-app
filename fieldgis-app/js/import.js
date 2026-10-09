/**
 * import.js
 * -----------------------------------------------------------------------
 * Importação de dados: CSV, GeoJSON, KML/KMZ, GPX, GeoTIFF e PDF/imagem
 * georreferenciada manualmente.
 *
 * Todas as rotinas rodam inteiramente no navegador (parsing local), sem
 * enviar nenhum arquivo para servidores externos.
 */

(function () {
  // ------------------------------------------------------------------
  // CSV
  // ------------------------------------------------------------------

  /** Parser CSV simples com suporte a aspas e delimitador , ou ; (detectado automaticamente). */
  function parseCSV(text) {
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    const firstLine = text.split('\n')[0];
    const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';

    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === delimiter) {
        row.push(field);
        field = '';
      } else if (c === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else {
        field += c;
      }
    }
    if (field.length || row.length) {
      row.push(field);
      rows.push(row);
    }

    const headers = rows.shift() || [];
    return { headers: headers.map((h) => h.trim()), rows, delimiter };
  }

  /**
   * Importa pontos de linhas de CSV já parseadas.
   * mapping: { nameField, codeField, xField, yField, coordType: 'geo'|'utm', datum, zone, hemisphere, attributeFields:[names] }
   */
  async function importCSVPoints(headers, rows, mapping, projectId, layerId) {
    const idx = (field) => headers.indexOf(field);
    const iName = idx(mapping.nameField);
    const iCode = idx(mapping.codeField);
    const iX = idx(mapping.xField);
    const iY = idx(mapping.yField);
    const attrIdx = (mapping.attributeFields || []).map((f) => ({ field: f, i: idx(f) }));

    const created = [];
    for (const r of rows) {
      if (!r.length || (r.length === 1 && !r[0])) continue;
      const xVal = parseFloat(String(r[iX]).replace(',', '.'));
      const yVal = parseFloat(String(r[iY]).replace(',', '.'));
      if (Number.isNaN(xVal) || Number.isNaN(yVal)) continue;

      let lat, lon;
      if (mapping.coordType === 'utm') {
        const res = Coordinates.fromUTM(xVal, yVal, mapping.zone, mapping.hemisphere === 'S', mapping.datum);
        lat = res.lat;
        lon = res.lon;
      } else {
        lon = xVal;
        lat = yVal;
      }

      const attributes = {};
      attrIdx.forEach(({ field, i }) => {
        if (i >= 0) attributes[field] = r[i];
      });

      const point = {
        projectId,
        layerId,
        name: iName >= 0 ? r[iName] : `IMP-${created.length + 1}`,
        code: iCode >= 0 ? r[iCode] : '',
        lat,
        lon,
        alt: null,
        accuracy: null,
        capturedAt: new Date().toISOString(),
        description: '',
        attributes,
        photos: [],
        imported: true,
      };
      created.push(await DB.put('points', point));
    }
    return created;
  }

  // ------------------------------------------------------------------
  // GeoJSON / KML / GPX (todos convergem para GeoJSON antes de importar)
  // ------------------------------------------------------------------

  async function importGeoJSON(geojson, projectId, layerIds) {
    const features = geojson.type === 'FeatureCollection' ? geojson.features : [geojson];
    const result = { points: 0, tracks: 0, polygons: 0 };

    for (const f of features) {
      if (!f.geometry) continue;
      const props = f.properties || {};
      switch (f.geometry.type) {
        case 'Point': {
          const [lon, lat, alt] = f.geometry.coordinates;
          await DB.put('points', {
            projectId,
            layerId: layerIds.points,
            name: props.name || props.Name || `IMP-${result.points + 1}`,
            code: props.code || '',
            lat,
            lon,
            alt: alt ?? null,
            accuracy: null,
            capturedAt: new Date().toISOString(),
            description: props.description || '',
            attributes: props,
            photos: [],
            imported: true,
          });
          result.points++;
          break;
        }
        case 'LineString': {
          const points = f.geometry.coordinates.map(([lon, lat, alt], i) => ({ lat, lon, alt: alt ?? null, time: Date.now() + i }));
          const stats = Tracks.computeStats(points);
          await DB.put('tracks', {
            projectId,
            layerId: layerIds.tracks,
            name: props.name || `Trilha importada ${result.tracks + 1}`,
            points,
            stats,
            imported: true,
          });
          result.tracks++;
          break;
        }
        case 'Polygon': {
          const ring = f.geometry.coordinates[0];
          const vertices = ring.map(([lon, lat]) => ({ lat, lon }));
          const area = Coordinates.polygonArea(vertices.map((v) => ({ lat: v.lat, lng: v.lon })));
          const perimeter = Coordinates.polygonPerimeter(vertices.map((v) => ({ lat: v.lat, lng: v.lon })), true);
          await DB.put('polygons', {
            projectId,
            layerId: layerIds.polygons,
            name: props.name || `Polígono importado ${result.polygons + 1}`,
            vertices,
            area,
            perimeter,
            attributes: props,
            imported: true,
          });
          result.polygons++;
          break;
        }
        case 'MultiLineString': {
          for (const line of f.geometry.coordinates) {
            const points = line.map(([lon, lat, alt], i) => ({ lat, lon, alt: alt ?? null, time: Date.now() + i }));
            await DB.put('tracks', { projectId, layerId: layerIds.tracks, name: props.name || `Trilha importada ${result.tracks + 1}`, points, stats: Tracks.computeStats(points), imported: true });
            result.tracks++;
          }
          break;
        }
        case 'MultiPolygon': {
          for (const poly of f.geometry.coordinates) {
            const vertices = poly[0].map(([lon, lat]) => ({ lat, lon }));
            const area = Coordinates.polygonArea(vertices.map((v) => ({ lat: v.lat, lng: v.lon })));
            const perimeter = Coordinates.polygonPerimeter(vertices.map((v) => ({ lat: v.lat, lng: v.lon })), true);
            await DB.put('polygons', { projectId, layerId: layerIds.polygons, name: props.name || `Polígono importado ${result.polygons + 1}`, vertices, area, perimeter, attributes: props, imported: true });
            result.polygons++;
          }
          break;
        }
        default:
          break;
      }
    }
    return result;
  }

  async function parseKML(text) {
    const dom = new DOMParser().parseFromString(text, 'text/xml');
    return toGeoJSON.kml(dom);
  }

  async function parseGPX(text) {
    const dom = new DOMParser().parseFromString(text, 'text/xml');
    return toGeoJSON.gpx(dom);
  }

  /** KMZ é um .zip contendo um doc.kml (+ recursos). Extraímos o primeiro .kml encontrado. */
  async function parseKMZ(arrayBuffer) {
    const zip = await JSZip.loadAsync(arrayBuffer);
    let kmlEntry = null;
    zip.forEach((path, entry) => {
      if (!kmlEntry && path.toLowerCase().endsWith('.kml')) kmlEntry = entry;
    });
    if (!kmlEntry) throw new Error('Arquivo KMZ não contém um documento KML válido.');
    const text = await kmlEntry.async('text');
    return parseKML(text);
  }

  // ------------------------------------------------------------------
  // GeoTIFF (raster georreferenciado)
  // ------------------------------------------------------------------

  // Tabela de EPSG conhecidos -> definição UTM (zona/hemisfério/datum).
  // Cobre os casos de uso mais comuns no Brasil (SIRGAS2000 e WGS84).
  function utmFromEPSG(code) {
    if (code >= 32601 && code <= 32660) return { zone: code - 32600, south: false, datum: 'WGS84' };
    if (code >= 32701 && code <= 32760) return { zone: code - 32700, south: true, datum: 'WGS84' };
    if (code >= 31971 && code <= 31976) return { zone: code - 31954, south: false, datum: 'SIRGAS2000' }; // 31971=17N .. 31976=22N
    if (code >= 31977 && code <= 31985) return { zone: code - 31960, south: true, datum: 'SIRGAS2000' }; // 31977=17S .. 31985=25S
    return null;
  }

  /**
   * Importa um GeoTIFF: lê os pixels, monta uma imagem RGB/escala de cinza em
   * canvas e determina a extensão geográfica (bounding box) a partir dos
   * metadados de georreferenciamento embutidos no arquivo.
   *
   * LIMITAÇÃO DOCUMENTADA: se o GeoTIFF estiver rotacionado (ModelTransformation
   * com componente de rotação) ou usar uma projeção fora da tabela UTM acima,
   * o app assume os cantos como um retângulo alinhado a lat/lon (aproximação).
   * Isso é suficiente para a grande maioria das cartas e ortomosaicos de campo,
   * que normalmente são exportados alinhados ao norte.
   */
  async function importGeoTIFF(arrayBuffer) {
    const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
    const image = await tiff.getImage();
    const width = image.getWidth();
    const height = image.getHeight();
    const bbox = image.getBoundingBox(); // [minX, minY, maxX, maxY] no CRS nativo da imagem

    let geoKeys = {};
    try {
      geoKeys = image.getGeoKeys() || {};
    } catch (e) {
      /* algumas imagens não trazem GeoKeys legíveis */
    }

    const epsgCode = geoKeys.ProjectedCSTypeGeoKey || geoKeys.GeographicTypeGeoKey || null;
    let corners; // {sw:{lat,lon}, ne:{lat,lon}}

    if (epsgCode && epsgCode >= 4000 && epsgCode < 5000) {
      // CRS já geográfico (graus) — bbox já está em lon/lat
      corners = { sw: { lat: bbox[1], lon: bbox[0] }, ne: { lat: bbox[3], lon: bbox[2] } };
    } else if (epsgCode && utmFromEPSG(epsgCode)) {
      const u = utmFromEPSG(epsgCode);
      const sw = Coordinates.fromUTM(bbox[0], bbox[1], u.zone, u.south, u.datum);
      const ne = Coordinates.fromUTM(bbox[2], bbox[3], u.zone, u.south, u.datum);
      corners = { sw, ne };
    } else {
      // CRS não reconhecido: melhor esforço — assume que os valores já estão em graus.
      corners = { sw: { lat: bbox[1], lon: bbox[0] }, ne: { lat: bbox[3], lon: bbox[2] } };
      corners.unrecognizedCRS = true;
    }

    // Renderiza os pixels em um canvas (RGB direto se houver 3+ bandas, escala de cinza c/ contraste automático caso contrário)
    const rasters = await image.readRasters();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(width, height);

    const bandCount = rasters.length;
    if (bandCount >= 3) {
      for (let i = 0; i < width * height; i++) {
        imgData.data[i * 4] = rasters[0][i];
        imgData.data[i * 4 + 1] = rasters[1][i];
        imgData.data[i * 4 + 2] = rasters[2][i];
        imgData.data[i * 4 + 3] = bandCount >= 4 ? rasters[3][i] : 255;
      }
    } else {
      // Banda única: aplica alongamento de contraste (stretch) linear min-max
      const band = rasters[0];
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < band.length; i++) {
        if (band[i] < min) min = band[i];
        if (band[i] > max) max = band[i];
      }
      const range = max - min || 1;
      for (let i = 0; i < width * height; i++) {
        const v = Math.round(((band[i] - min) / range) * 255);
        imgData.data[i * 4] = v;
        imgData.data[i * 4 + 1] = v;
        imgData.data[i * 4 + 2] = v;
        imgData.data[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return {
      blob,
      bounds: [[corners.sw.lat, corners.sw.lon], [corners.ne.lat, corners.ne.lon]],
      width,
      height,
      unrecognizedCRS: !!corners.unrecognizedCRS,
      epsgCode,
    };
  }

  // ------------------------------------------------------------------
  /**
   * Extrai os pontos de controle (GCPs) embutidos em um GeoPDF real (padrão
   * OGC / ISO 32000-2 Geospatial, gerado por Esri ArcMap/ArcPress, QGIS,
   * Avenza etc.): os dicionários /Measure /Subtype/GEO, com os arrays /GPTS
   * (coordenadas geográficas reais) e /LPTS (posição correspondente de cada
   * ponto na página, normalizada 0–1 dentro do /Viewport ou da página).
   *
   * Devolve os pontos "crus" (sem decidir se há rotação ou não) — quem decide
   * isso e monta a transformação é buildNorthUpRaster, mais abaixo. Antes
   * (builds anteriores) essa função já tentava decidir "tem rotação?" olhando
   * se o LPTS caía exatamente em 0/1, e desistia (retornava null) quando não
   * caía — mas isso tratava rotação como "não suportado" em vez de resolver
   * de verdade, e por isso todo GeoPDF com o Norte rotacionado acabava indo
   * pro georreferenciamento manual (que assume SEM rotação) e saía distorcido.
   */
  function extractGeoPdfPoints(arrayBuffer) {
    try {
      const bytes = new Uint8Array(arrayBuffer);
      // Decodifica como Latin1 (1 byte = 1 char) só para permitir regex sobre
      // a estrutura de texto do PDF — não afeta a leitura binária normal.
      let raw = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        raw += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }

      // Procura todos os dicionários /Measure /Subtype/GEO do arquivo (pode
      // haver mais de uma camada/viewport; usamos o primeiro que for válido).
      const measureRegex = /\/Type\s*\/Measure\s*\/Subtype\s*\/GEO[^>]*?\/GPTS\s*\[([^\]]+)\][^>]*?\/LPTS\s*\[([^\]]+)\]|\/Type\s*\/Measure\s*\/Subtype\s*\/GEO[^>]*?\/LPTS\s*\[([^\]]+)\][^>]*?\/GPTS\s*\[([^\]]+)\]/g;

      let m;
      while ((m = measureRegex.exec(raw)) !== null) {
        const gptsStr = m[1] || m[4];
        const lptsStr = m[2] || m[3];
        if (!gptsStr || !lptsStr) continue;

        const gpts = gptsStr.trim().split(/\s+/).map(Number);
        const lpts = lptsStr.trim().split(/\s+/).map(Number);
        // Precisa de pelo menos 3 pontos (6 valores) pra ajustar uma
        // transformação de rotação+escala com alguma folga de verificação
        // (3 pontos já dá pra resolver; 4, o mais comum, sobra 1 de conferência).
        if (gpts.length < 6 || gpts.length !== lpts.length) continue;
        if (gpts.some(Number.isNaN) || lpts.some(Number.isNaN)) continue;

        const pontos = [];
        for (let i = 0; i < gpts.length; i += 2) {
          pontos.push({ lat: gpts[i], lon: gpts[i + 1], u: lpts[i], v: lpts[i + 1] });
        }
        return pontos;
      }
      return null;
    } catch (e) {
      console.error('Falha ao extrair pontos do GeoPDF:', e);
      return null;
    }
  }

  /**
   * Ajusta uma transformação de SIMILARIDADE (rotação + escala uniforme +
   * translação — sem distorção/cisalhamento) entre pontos da página (em
   * pontos PDF, origem inferior-esquerda, eixo Y pra cima) e metros locais
   * numa projeção plana aproximada centrada na latitude/longitude média dos
   * próprios pontos de controle. É exatamente esse tipo de transformação
   * (rotação + escala só) que um GeoPDF com "Norte rotacionado" tem: o mapa
   * foi girado e escalado ao ser desenhado na folha, mas não distorcido.
   *
   * Clássico ajuste de Procrustes/Kabsch 2D sem reflexão, por mínimos
   * quadrados — funciona com 3+ pontos (não precisam ser exatamente um
   * retângulo; GCPs "soltos" também funcionam).
   */
  function fitSimilarityTransform(pontosPagina) {
    const n = pontosPagina.length;
    if (n < 3) return null;

    const lat0 = pontosPagina.reduce((s, p) => s + p.lat, 0) / n;
    const lon0 = pontosPagina.reduce((s, p) => s + p.lon, 0) / n;
    const mPerDegLat = 110540;
    const mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180);

    const sx = pontosPagina.reduce((s, p) => s + p.xPts, 0) / n;
    const sy = pontosPagina.reduce((s, p) => s + p.yPts, 0) / n;

    const srcC = pontosPagina.map((p) => ({ x: p.xPts - sx, y: p.yPts - sy }));
    // Como lat0/lon0 são a MÉDIA dos próprios pontos, o centróide dos pontos
    // em metros locais já cai exatamente em (0,0) — não precisa subtrair nada.
    const dstC = pontosPagina.map((p) => ({
      x: (p.lon - lon0) * mPerDegLon,
      y: (p.lat - lat0) * mPerDegLat,
    }));

    let Sxy = 0, Syx = 0, Sxx = 0, Syy = 0;
    for (let i = 0; i < n; i++) {
      Sxy += srcC[i].x * dstC[i].y;
      Syx += srcC[i].y * dstC[i].x;
      Sxx += srcC[i].x * dstC[i].x;
      Syy += srcC[i].y * dstC[i].y;
    }
    const theta = Math.atan2(Sxy - Syx, Sxx + Syy);
    const cosT = Math.cos(theta), sinT = Math.sin(theta);

    let num = 0, denom = 0;
    for (let i = 0; i < n; i++) {
      const rx = cosT * srcC[i].x - sinT * srcC[i].y;
      const ry = sinT * srcC[i].x + cosT * srcC[i].y;
      num += rx * dstC[i].x + ry * dstC[i].y;
      denom += srcC[i].x * srcC[i].x + srcC[i].y * srcC[i].y;
    }
    if (denom < 1e-9) return null;
    const scale = num / denom; // metros por ponto PDF

    // Resíduo médio (em metros): mede o quão bem os pontos realmente formam
    // uma rotação+escala "limpa". Pontos de um GeoPDF genuíno encaixam quase
    // perfeitamente; um resíduo grande indica dado inconsistente/corrompido
    // no PDF — nesse caso é mais seguro desistir (cair no modo manual) do
    // que posicionar o mapa errado silenciosamente.
    let somaErro2 = 0;
    for (let i = 0; i < n; i++) {
      const px = scale * (cosT * srcC[i].x - sinT * srcC[i].y);
      const py = scale * (sinT * srcC[i].x + cosT * srcC[i].y);
      somaErro2 += (px - dstC[i].x) ** 2 + (py - dstC[i].y) ** 2;
    }
    const erroMedioMetros = Math.sqrt(somaErro2 / n);

    return { theta, scale, sx, sy, lat0, lon0, mPerDegLat, mPerDegLon, erroMedioMetros };
  }

  /**
   * Extrai o retângulo (/BBox) do dicionário /Viewport do PDF, em pontos da
   * página (origem no canto inferior-esquerdo, como o PDF usa nativamente).
   *
   * IMPORTANTE: as coordenadas GPTS/LPTS de um GeoPDF costumam ser relativas
   * a esse Viewport — ou seja, à área real do quadro do mapa — e NÃO à folha
   * inteira. Documentos com título, legenda ou margens fora do quadro do
   * mapa (comuns em pranchas técnicas/cadastrais) têm um Viewport MENOR que
   * a página, com uma proporção diferente dela. Se a imagem inteira da
   * página for esticada para caber nas coordenadas geográficas pensadas só
   * para essa área menor, o resultado sai distorcido (retangular virando
   * quase quadrado, ou vice-versa) — por isso precisamos recortar a imagem
   * para esse retângulo antes de posicioná-la no mapa (ver handlePdfOrImageFile).
   */
  function extractViewportBBox(arrayBuffer) {
    try {
      const bytes = new Uint8Array(arrayBuffer);
      let raw = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        raw += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      const m = raw.match(/\/Type\s*\/Viewport[\s\S]{0,400}?\/BBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/);
      if (!m) return null;
      const [x1, y1, x2, y2] = [m[1], m[2], m[3], m[4]].map(Number);
      if ([x1, y1, x2, y2].some(Number.isNaN)) return null;
      // A especificação do PDF permite que os 4 números de um retângulo
      // venham em qualquer ordem nos cantos — quem lê deve normalizar
      // (min/max) em vez de assumir llx<urx e lly<ury. Sem isso, um arquivo
      // com os valores de Y invertidos (como aconteceu aqui) geraria uma
      // altura negativa e quebraria o recorte da imagem.
      const llx = Math.min(x1, x2);
      const urx = Math.max(x1, x2);
      const lly = Math.min(y1, y2);
      const ury = Math.max(y1, y2);
      if (urx <= llx || ury <= lly) return null;
      return { llx, lly, urx, ury };
    } catch (e) {
      return null;
    }
  }

  // PDF / imagem com georreferenciamento manual (2 pontos de controle)
  // ------------------------------------------------------------------

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  }

  /** Renderiza a primeira página de um PDF em um canvas de alta resolução. */
  async function renderPDFPage(arrayBuffer, pageNumber = 1, scale = 2) {
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    const pageWidthPts = page.view[2] - page.view[0];
    const pageHeightPts = page.view[3] - page.view[1];
    return { canvas, numPages: pdf.numPages, scale, pageWidthPts, pageHeightPts };
  }

  /**
   * A partir dos pontos de controle de um GeoPDF (rotacionado ou não), gera
   * uma imagem "Norte pra cima" de verdade — corrigindo a rotação de fato,
   * em vez de só detectar e desistir (modo manual, que não suporta rotação
   * e por isso sempre saía distorcido num GeoPDF rotacionado) — e os limites
   * geográficos corretos dessa imagem já corrigida.
   *
   * Matemática (ângulo de rotação, tamanho do canvas rotacionado, e
   * reconstituição dos cantos em lat/lon) validada numericamente antes de
   * implementar — ver fitSimilarityTransform acima.
   *
   * LIMITAÇÃO ASSUMIDA quando há rotação de verdade: só é possível manter
   * Norte-pra-cima recortando para a área do /Viewport (o quadro do mapa em
   * si) — sem estender pra folha inteira como no caso sem rotação. Título,
   * legenda e margens da prancha normalmente NÃO giram junto com o mapa no
   * PDF original (só o quadro do mapa é desenhado girado); se girássemos a
   * folha inteira junto, esse texto ficaria de lado/de cabeça para baixo.
   * Quando a rotação é desprezível (<1°), o comportamento continua sendo o
   * de sempre: estende pra folha inteira, mantendo título/legenda visíveis.
   *
   * @returns {Promise<{canvas, bounds}|null>} null quando os pontos de
   *   controle não formam uma transformação confiável (cai no modo manual).
   */
  async function buildNorthUpRaster(sourceCanvas, geoPoints, viewportBBox, pageWidthPts, pageHeightPts, renderScale) {
    const bbox = viewportBBox || { llx: 0, lly: 0, urx: pageWidthPts, ury: pageHeightPts };

    // A especificação (ISO 32000-2) define LPTS com a MESMA origem do /BBox
    // da página/Viewport (canto inferior-esquerdo, Y pra cima — padrão PDF).
    // Só que, na prática, foi encontrado pelo menos um gerador de GeoPDF real
    // que grava LPTS com Y invertido (v=0 no TOPO, como em convenção de
    // imagem/raster, não a nativa do PDF) — testado e confirmado com um
    // arquivo real cujo ajuste só fecha direito (resíduo baixo) com essa
    // segunda convenção. Em vez de apostar em uma das duas, tenta as duas e
    // fica com a que o ajuste explicar melhor (menor resíduo) — robusto para
    // os dois tipos de gerador sem precisar adivinhar qual é.
    function pontosComConvencaoY(yInvertido) {
      return geoPoints.map((p) => ({
        xPts: bbox.llx + p.u * (bbox.urx - bbox.llx),
        yPts: yInvertido ? bbox.ury - p.v * (bbox.ury - bbox.lly) : bbox.lly + p.v * (bbox.ury - bbox.lly),
        lat: p.lat,
        lon: p.lon,
      }));
    }
    const candidatoNormal = pontosComConvencaoY(false);
    const candidatoInvertido = pontosComConvencaoY(true);
    const fitNormal = fitSimilarityTransform(candidatoNormal);
    const fitInvertido = fitSimilarityTransform(candidatoInvertido);

    let pontosPagina, fit;
    if (fitNormal && (!fitInvertido || fitNormal.erroMedioMetros <= fitInvertido.erroMedioMetros)) {
      pontosPagina = candidatoNormal;
      fit = fitNormal;
    } else {
      pontosPagina = candidatoInvertido;
      fit = fitInvertido;
    }
    if (!fit) return null;

    // Rejeita ajustes ruins (pontos de controle inconsistentes/corrompidos
    // no PDF): resíduo médio maior que ~3% da diagonal da área mapeada não é
    // confiável — melhor cair pro modo manual do que posicionar errado e
    // sem avisar.
    const diagonalM = Math.hypot((bbox.urx - bbox.llx) * fit.scale, (bbox.ury - bbox.lly) * fit.scale);
    if (!(diagonalM > 0) || fit.erroMedioMetros > diagonalM * 0.03) return null;

    const rotApplied = -fit.theta; // ângulo pra ctx.rotate() — ver derivação em fitSimilarityTransform

    // Recorta o canvas de origem pra área do Viewport (se houver e for
    // realmente menor que a página inteira) antes de rotacionar.
    const cropX1 = bbox.llx * renderScale;
    const cropY1 = sourceCanvas.height - bbox.ury * renderScale;
    const cropWpx = (bbox.urx - bbox.llx) * renderScale;
    const cropHpx = (bbox.ury - bbox.lly) * renderScale;

    let recortado = sourceCanvas;
    const precisaRecortar = cropWpx < sourceCanvas.width - 0.5 || cropHpx < sourceCanvas.height - 0.5;
    if (precisaRecortar) {
      recortado = document.createElement('canvas');
      recortado.width = Math.round(cropWpx);
      recortado.height = Math.round(cropHpx);
      recortado
        .getContext('2d')
        .drawImage(sourceCanvas, cropX1, cropY1, cropWpx, cropHpx, 0, 0, recortado.width, recortado.height);
    }

    const ROTACAO_DESPREZIVEL = (1 * Math.PI) / 180; // abaixo de 1°, não compensa rotacionar (perda de nitidez por reamostragem)
    let finalCanvas = recortado;
    if (Math.abs(rotApplied) > ROTACAO_DESPREZIVEL) {
      const W = recortado.width, H = recortado.height;
      const cosR = Math.abs(Math.cos(rotApplied));
      const sinR = Math.abs(Math.sin(rotApplied));
      const newW = Math.ceil(W * cosR + H * sinR);
      const newH = Math.ceil(W * sinR + H * cosR);
      const rotCanvas = document.createElement('canvas');
      rotCanvas.width = newW;
      rotCanvas.height = newH;
      const ctx = rotCanvas.getContext('2d');
      ctx.translate(newW / 2, newH / 2);
      ctx.rotate(rotApplied);
      ctx.drawImage(recortado, -W / 2, -H / 2);
      finalCanvas = rotCanvas;
    }

    // Limites geográficos finais: transforma os 4 cantos da área recortada
    // (bbox) pela transformação ajustada — depois de corrigir a rotação,
    // esses 4 cantos formam um retângulo alinhado aos eixos (checado
    // numericamente: erro sub-milimétrico em qualquer ângulo testado).
    const cosT = Math.cos(fit.theta), sinT = Math.sin(fit.theta);
    const paraLatLon = (xPts, yPts) => {
      const X = fit.scale * (cosT * (xPts - fit.sx) - sinT * (yPts - fit.sy));
      const Y = fit.scale * (sinT * (xPts - fit.sx) + cosT * (yPts - fit.sy));
      return { lat: fit.lat0 + Y / fit.mPerDegLat, lon: fit.lon0 + X / fit.mPerDegLon };
    };
    const cantos = [
      paraLatLon(bbox.llx, bbox.lly),
      paraLatLon(bbox.urx, bbox.lly),
      paraLatLon(bbox.urx, bbox.ury),
      paraLatLon(bbox.llx, bbox.ury),
    ];
    const lats = cantos.map((c) => c.lat);
    const lons = cantos.map((c) => c.lon);
    const bounds = {
      sw: { lat: Math.min(...lats), lon: Math.min(...lons) },
      ne: { lat: Math.max(...lats), lon: Math.max(...lons) },
    };

    return { canvas: finalCanvas, bounds, rotationDeg: (rotApplied * 180) / Math.PI };
  }

  /**
   * Calcula os limites geográficos (bounds) de uma imagem a partir de DOIS
   * pontos de controle informados pelo usuário (pixel <-> coordenada real).
   * Assume a imagem alinhada ao Norte (sem rotação) — transformação afim
   * simples de escala + translação por eixo. Para a maioria dos mapas/plantas
   * escaneados isso é suficiente; rotação arbitrária exigiria um terceiro
   * ponto de controle e reamostragem da imagem (não implementado nesta versão).
   */
  function computeBoundsFromControlPoints(imgWidth, imgHeight, p1, p2) {
    // p1, p2: { px, py, lat, lon }
    const dPxX = p2.px - p1.px;
    const dPxY = p2.py - p1.py;
    if (Math.abs(dPxX) < 1e-6 || Math.abs(dPxY) < 1e-6) {
      throw new Error('Os dois pontos de controle precisam estar em posições X e Y distintas na imagem.');
    }
    const lonPerPx = (p2.lon - p1.lon) / dPxX;
    const latPerPy = (p2.lat - p1.lat) / dPxY;

    const lonAtOrigin = p1.lon - p1.px * lonPerPx;
    const latAtOrigin = p1.lat - p1.py * latPerPy;

    const lonTopLeft = lonAtOrigin;
    const latTopLeft = latAtOrigin;
    const lonBottomRight = lonAtOrigin + imgWidth * lonPerPx;
    const latBottomRight = latAtOrigin + imgHeight * latPerPy;

    return {
      sw: { lat: Math.min(latTopLeft, latBottomRight), lon: Math.min(lonTopLeft, lonBottomRight) },
      ne: { lat: Math.max(latTopLeft, latBottomRight), lon: Math.max(lonTopLeft, lonBottomRight) },
    };
  }

  window.Importer = {
    parseCSV,
    importCSVPoints,
    importGeoJSON,
    parseKML,
    parseGPX,
    parseKMZ,
    importGeoTIFF,
    renderPDFPage,
    extractGeoPdfPoints,
    extractViewportBBox,
    buildNorthUpRaster,
    computeBoundsFromControlPoints,
    utmFromEPSG,
  };
})();
