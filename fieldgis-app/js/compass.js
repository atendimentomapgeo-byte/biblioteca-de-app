/**
 * compass.js
 * -----------------------------------------------------------------------
 * Leitura da bússola/magnetômetro do aparelho (para onde o CELULAR está
 * fisicamente apontando), usando a DeviceOrientation API do navegador.
 *
 * Isso é DIFERENTE do "heading" que vem da Geolocation API (GPS): aquele só
 * existe quando o usuário está em movimento (é calculado pela variação de
 * posição entre dois pontos consecutivos) e fica indisponível parado. Já a
 * bússola do aparelho funciona mesmo parado, pois lê o magnetômetro físico.
 *
 * Particularidades por plataforma:
 *   - iOS Safari: expõe `event.webkitCompassHeading`, que já é o rumo
 *     magnético verdadeiro (0°=Norte, aumenta no sentido horário), pronto
 *     para uso direto. A partir do iOS 13, é obrigatório pedir permissão
 *     via `DeviceOrientationEvent.requestPermission()`, e essa chamada só
 *     funciona se disparada a partir de um gesto do usuário (toque em botão)
 *     — não é possível conceder essa permissão automaticamente ao abrir o
 *     app, e ela não é lembrada entre recarregamentos de página.
 *   - Android/Chrome: dispara o evento `deviceorientationabsolute` (quando
 *     disponível) com `event.alpha`, que precisa ser convertido para rumo de
 *     bússola (a API não entrega o valor pronto como no iOS). A precisão
 *     depende do magnetômetro do aparelho e pode exigir calibração (o
 *     clássico gesto de "desenhar um 8" com o celular).
 *
 * Por ser leitura de sensor físico, o valor é naturalmente "tremido"
 * (ruidoso) — aplicamos uma suavização circular (média de vetores) para dar
 * uma seta estável na tela.
 */

(function () {
  const listeners = new Set();
  let active = false;
  let activeHandler = null;
  let activeEventName = null;
  let smoothedHeading = null;

  function emit(event, data) {
    listeners.forEach((cb) => cb(event, data));
  }

  /** Suavização circular (evita "pulo" de 359° para 0°) via média de vetores unitários. */
  function smooth(novoValor, fator = 0.25) {
    if (smoothedHeading == null) {
      smoothedHeading = novoValor;
      return smoothedHeading;
    }
    const r1 = (smoothedHeading * Math.PI) / 180;
    const r2 = (novoValor * Math.PI) / 180;
    const x = Math.cos(r1) * (1 - fator) + Math.cos(r2) * fator;
    const y = Math.sin(r1) * (1 - fator) + Math.sin(r2) * fator;
    let deg = (Math.atan2(y, x) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    smoothedHeading = deg;
    return smoothedHeading;
  }

  /** Converte o `alpha` bruto do Android/Chrome em rumo de bússola (0°=Norte, horário). */
  function alphaParaRumo(alpha) {
    let rumo = 360 - alpha;
    const anguloTela = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    rumo = (rumo + anguloTela) % 360;
    if (rumo < 0) rumo += 360;
    return rumo;
  }

  const Compass = {
    isSupported() {
      return typeof DeviceOrientationEvent !== 'undefined';
    },

    /** Indica se é necessário pedir permissão explícita (iOS 13+) antes de usar. */
    needsExplicitPermission() {
      return typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function';
    },

    /**
     * Pede permissão de acesso ao sensor de orientação. DEVE ser chamada a
     * partir de um gesto do usuário (ex.: dentro de um onclick), senão o
     * iOS rejeita silenciosamente.
     */
    async requestPermission() {
      if (!Compass.isSupported()) return false;
      if (Compass.needsExplicitPermission()) {
        try {
          const resultado = await DeviceOrientationEvent.requestPermission();
          return resultado === 'granted';
        } catch (e) {
          return false;
        }
      }
      return true; // Android e navegadores que não exigem permissão explícita
    },

    on(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },

    start() {
      if (active || !Compass.isSupported()) return;
      smoothedHeading = null;

      const handler = (event) => {
        let rumo = null;
        let precisao = null;

        if (typeof event.webkitCompassHeading === 'number' && !Number.isNaN(event.webkitCompassHeading)) {
          // iOS: valor já pronto, é o rumo magnético verdadeiro.
          rumo = event.webkitCompassHeading;
          precisao = event.webkitCompassAccuracy;
        } else if (event.alpha != null && (event.absolute === true || activeEventName === 'deviceorientationabsolute')) {
          rumo = alphaParaRumo(event.alpha);
        } else {
          return; // sem dado utilizável nesta leitura
        }

        emit('heading', { heading: smooth(rumo), rawHeading: rumo, accuracy: precisao });
      };

      // Prefere o evento "absoluto" (Chrome/Android), que já é relativo ao
      // Norte verdadeiro/magnético em vez de a uma orientação inicial
      // arbitrária do aparelho.
      activeEventName = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
      window.addEventListener(activeEventName, handler);
      activeHandler = handler;
      active = true;
      emit('started', {});
    },

    stop() {
      if (active && activeHandler) {
        window.removeEventListener(activeEventName, activeHandler);
      }
      active = false;
      activeHandler = null;
      smoothedHeading = null;
      emit('stopped', {});
    },

    isActive() {
      return active;
    },
  };

  window.Compass = Compass;
})();
