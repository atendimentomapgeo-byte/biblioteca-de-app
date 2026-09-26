/**
 * edgecolor.js
 * -----------------------------------------------------------------------
 * Amostra, em tempo real, a cor do próprio mapa exatamente na borda
 * inferior da tela e aplica essa cor na faixa que o iOS reserva pro Home
 * Indicator em apps instalados via Tela de Início (ver comentário no
 * `#app` de css/style.css sobre essa reserva — é uma limitação do sistema,
 * não um bug de CSS). Em vez de uma cor fixa do tema do app, a faixa
 * reservada passa a "puxar" a cor de cima, ficando bem mais disfarçada na
 * maioria das situações — embora nunca deixe de existir de fato (isso o
 * iOS não permite).
 *
 * LIMITAÇÃO HONESTA (leia antes de mexer aqui):
 *   1) Só é possível ler o pixel de verdade quando o servidor do tile
 *      permite leitura entre origens (CORS, header Access-Control-Allow-
 *      Origin). O OpenStreetMap público normalmente NÃO manda esse
 *      header — nesse caso a amostragem falha (esperado, não é bug) e cai
 *      automaticamente para uma cor fixa aproximada por camada, definida
 *      em FALLBACK_POR_CAMADA. O Esri World Imagery (satélite) costuma
 *      permitir CORS, então nele a cor real geralmente funciona de fato.
 *   2) A amostragem só olha o mapa BASE (tiles) — não considera
 *      marcadores/pontos/trilhas/polígonos ou a grade UTM que porventura
 *      estejam bem em cima da borda inferior.
 *   3) Só reamostra em 'moveend'/'zoomend'/troca de mapa base — não a cada
 *      grau de rotação da bússola (isso seria uma amostragem de rede a
 *      cada atualização do sensor, computacionalmente cara demais). Em
 *      modo bússola ativo a cor pode ficar levemente desatualizada até o
 *      próximo pan/zoom.
 *   4) Depende de `fetch(url + '&fgsample=1', {mode:'cors'})` — o
 *      service-worker.js reconhece esse marcador e faz uma busca CORS de
 *      verdade só para essa sonda, sem tocar no cache normal dos tiles
 *      (ver service-worker.js). O carregamento normal do mapa não muda em
 *      nada — se este arquivo falhar ou não carregar, o pior caso é a
 *      faixa ficar na cor fixa do tema (o mesmo de antes desta função
 *      existir).
 */
(function () {
  // Cores fixas aproximadas, usadas sempre que a amostragem real não for
  // possível (CORS bloqueado, offline, camada sem tiles, etc.).
  const FALLBACK_POR_CAMADA = {
    osm: '#dcd7c9', // tom claro típico do OpenStreetMap
    satellite: '#3a3a2e', // tom escuro-esverdeado típico de imagem de satélite
    blank: '#10161d', // igual ao tema do app (mapa "em branco")
  };

  let map = null;
  let canvas = null;
  let amostragemEmAndamento = false;
  let amostragemPendente = false;
  const falhouCors = {}; // por nome de camada — evita insistir numa causa perdida a cada movimento

  function aplicarCor(corCss) {
    document.documentElement.style.setProperty('--fg-edge-color', corCss);
  }

  function aplicarFallback(nomeCamada) {
    aplicarCor(FALLBACK_POR_CAMADA[nomeCamada] || FALLBACK_POR_CAMADA.blank);
  }

  /** Descobre qual tile (e qual pixel dentro dele) cai exatamente na borda inferior central da tela. */
  function calcularAlvoDeAmostra() {
    const size = map.getSize();
    if (!size || size.y < 2 || size.x < 2) return null;
    const pontoBase = L.point(Math.round(size.x / 2), size.y - 1);
    const latlng = map.containerPointToLatLng(pontoBase);
    const zoom = Math.round(map.getZoom());
    const tileSize = 256; // ambas as camadas online usam o padrão (nenhuma define tileSize customizado)
    const worldPoint = map.project(latlng, zoom);
    const tileX = Math.floor(worldPoint.x / tileSize);
    const tileY = Math.floor(worldPoint.y / tileSize);
    return {
      zoom,
      tileX,
      tileY,
      pxX: Math.min(tileSize - 1, Math.max(0, Math.floor(worldPoint.x - tileX * tileSize))),
      pxY: Math.min(tileSize - 1, Math.max(0, Math.floor(worldPoint.y - tileY * tileSize))),
    };
  }

  async function amostrar() {
    if (!map) return;
    if (amostragemEmAndamento) {
      amostragemPendente = true;
      return;
    }
    amostragemEmAndamento = true;
    amostragemPendente = false;

    const nomeCamada = MapModule.getCurrentBaseLayer();
    try {
      const layer = MapModule.getBaseLayerObject(nomeCamada);
      if (!layer || typeof layer.getTileUrl !== 'function' || falhouCors[nomeCamada]) {
        aplicarFallback(nomeCamada);
        return;
      }

      const alvo = calcularAlvoDeAmostra();
      if (!alvo) return;

      let url = layer.getTileUrl({ x: alvo.tileX, y: alvo.tileY, z: alvo.zoom });
      url += (url.includes('?') ? '&' : '?') + 'fgsample=1';

      const resp = await fetch(url, { mode: 'cors' });
      if (!resp.ok) throw new Error('http ' + resp.status);
      const blob = await resp.blob();
      const bitmap = await createImageBitmap(blob);

      if (!canvas) canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, alvo.pxX, alvo.pxY, 1, 1, 0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data; // lança SecurityError aqui se a imagem ficou "tainted" (sem CORS de verdade)
      aplicarCor(`rgb(${r}, ${g}, ${b})`);
    } catch (err) {
      // CORS bloqueado, offline, tile inexistente, etc. — comportamento
      // esperado em vários provedores (ver comentário no topo do arquivo),
      // não um bug. Marca a camada e usa a cor fixa aproximada dela.
      falhouCors[nomeCamada] = true;
      aplicarFallback(nomeCamada);
    } finally {
      amostragemEmAndamento = false;
      if (amostragemPendente) amostrar();
    }
  }

  const EdgeColor = {
    init() {
      map = MapModule.getMap();
      if (!map) return;
      aplicarFallback(MapModule.getCurrentBaseLayer());
      map.on('moveend', amostrar);
      map.on('zoomend', amostrar);
      amostrar();
    },
    /** Força uma nova amostragem (chamado ao trocar de mapa base). */
    refresh() {
      amostrar();
    },
  };

  window.EdgeColor = EdgeColor;
})();
