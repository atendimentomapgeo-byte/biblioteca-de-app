/**
 * tracks.js
 * -----------------------------------------------------------------------
 * Registro de trilhas (tracks) GPS: iniciar, pausar, continuar, finalizar.
 * Calcula distância, tempo decorrido, velocidade média/máxima e variação
 * de altitude, e desenha a linha da trilha em tempo real sobre o mapa.
 */

(function () {
  let state = 'idle'; // idle | recording | paused
  let currentTrack = null; // { points: [], startedAt, pausedDuration, layerId }
  let polyline = null;
  let unsubscribeGPS = null;
  let pauseStartedAt = null;
  let totalPausedMs = 0;

  function computeStats(points, pausedMs = totalPausedMs) {
    if (points.length < 2) {
      return { distance: 0, avgSpeed: 0, maxSpeed: 0, minAlt: null, maxAlt: null, duration: 0 };
    }
    let distance = 0;
    let maxSpeed = 0;
    let minAlt = Infinity;
    let maxAlt = -Infinity;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.alt != null) {
        minAlt = Math.min(minAlt, p.alt);
        maxAlt = Math.max(maxAlt, p.alt);
      }
      if (p.speed != null) maxSpeed = Math.max(maxSpeed, p.speed);
      if (i > 0) {
        distance += Coordinates.haversineDistance(points[i - 1].lat, points[i - 1].lon, p.lat, p.lon);
      }
    }
    const durationMs = points[points.length - 1].time - points[0].time - pausedMs;
    const avgSpeed = durationMs > 0 ? distance / (durationMs / 1000) : 0;
    return {
      distance,
      avgSpeed,
      maxSpeed,
      minAlt: minAlt === Infinity ? null : minAlt,
      maxAlt: maxAlt === -Infinity ? null : maxAlt,
      duration: Math.max(0, durationMs),
    };
  }

  function formatDuration(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
    const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
    const s = String(totalSec % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  const Tracks = {
    getState() {
      return state;
    },

    /**
     * @param {string} layerId
     * @param {number} minAccuracy Precisão mínima aceitável em metros — só
     *   descarta leituras CLARAMENTE ruins (padrão bem tolerante: 50m). Não
     *   usamos um limite rígido e apertado aqui: isso descartava leituras
     *   normais demais, deixando a trilha com poucos pontos e trechos retos
     *   artificiais em vez de acompanhar o caminho real percorrido.
     */
    start(layerId, minAccuracy = 30) {
      if (state !== 'idle') return;
      currentTrack = { points: [], startedAt: Date.now(), layerId };
      totalPausedMs = 0;
      state = 'recording';
      const map = MapModule.getMap();
      polyline = L.polyline([], { color: '#e53935', weight: 4 }).addTo(map);
      let ultimoPontoAceito = null;

      unsubscribeGPS = GPS.on((event, data) => {
        if (event !== 'position' || state !== 'recording') return;

        // Só descarta leituras claramente ruins — não filtra tudo que não
        // for perfeito.
        if (data.accuracy != null && data.accuracy > minAccuracy) return;

        // Detecta "saltos" implausíveis: o sintoma real de interferência de
        // multipath (telhados metálicos, prédios grandes) é um ponto isolado
        // aparecendo longe demais pro tempo decorrido — velocidade implícita
        // acima de ~200km/h não é plausível em nenhum modo de coleta de
        // campo. Ignora só ESSE ponto específico (a trilha continua sendo
        // gravada normalmente a partir do próximo).
        const agora = data.timestamp || Date.now();
        if (ultimoPontoAceito) {
          const dtSeg = (agora - ultimoPontoAceito.time) / 1000;
          if (dtSeg > 0) {
            const dist = Coordinates.haversineDistance(ultimoPontoAceito.lat, ultimoPontoAceito.lon, data.lat, data.lon);
            if (dist / dtSeg > 55) return; // ~200 km/h
          }
        }

        const ponto = { lat: data.lat, lon: data.lon, alt: data.altitude, acc: data.accuracy, speed: data.speed, time: agora };
        currentTrack.points.push(ponto);
        ultimoPontoAceito = ponto;
        polyline.addLatLng([data.lat, data.lon]);
        Tracks._notify();
      });
      GPS.start();
      Tracks._notify();
    },

    pause() {
      if (state !== 'recording') return;
      state = 'paused';
      pauseStartedAt = Date.now();
      Tracks._notify();
    },

    resume() {
      if (state !== 'paused') return;
      totalPausedMs += Date.now() - pauseStartedAt;
      state = 'recording';
      Tracks._notify();
    },

    async finish(name, projectId) {
      if (state === 'idle' || !currentTrack) return null;
      if (state === 'paused' && pauseStartedAt) {
        totalPausedMs += Date.now() - pauseStartedAt;
        pauseStartedAt = 0;
      }
      if (unsubscribeGPS) unsubscribeGPS();
      state = 'idle';
      const stats = computeStats(currentTrack.points, totalPausedMs);
      const track = {
        projectId,
        layerId: currentTrack.layerId,
        name: name || `Trilha ${new Date().toLocaleString('pt-BR')}`,
        points: currentTrack.points,
        stats,
      };
      const saved = await DB.put('tracks', track);
      currentTrack = null;
      totalPausedMs = 0;
      return saved;
    },

    discard() {
      if (unsubscribeGPS) unsubscribeGPS();
      if (polyline) MapModule.getMap().removeLayer(polyline);
      state = 'idle';
      currentTrack = null;
      polyline = null;
      totalPausedMs = 0;
    },

    getCurrentStats() {
      if (!currentTrack) return null;
      return computeStats(currentTrack.points);
    },

    getCurrentPoints() {
      return currentTrack ? currentTrack.points.slice() : [];
    },

    formatDuration,
    computeStats,

    /** Renderiza uma trilha salva (do banco) como polyline no mapa, dentro de um layerGroup. */
    renderToLayerGroup(track, layerGroup, style = {}) {
      const latlngs = track.points.map((p) => [p.lat, p.lon]);
      const line = L.polyline(latlngs, Object.assign({ color: '#e53935', weight: 3 }, style));
      line.bindPopup(`<b>${track.name}</b><br>Distância: ${(track.stats.distance / 1000).toFixed(2)} km<br>Duração: ${formatDuration(track.stats.duration)}`);
      line.addTo(layerGroup);
      return line;
    },

    _listeners: new Set(),
    on(cb) {
      Tracks._listeners.add(cb);
      return () => Tracks._listeners.delete(cb);
    },
    _notify() {
      Tracks._listeners.forEach((cb) => cb(Tracks.getState(), Tracks.getCurrentStats()));
    },
  };

  window.Tracks = Tracks;
})();
