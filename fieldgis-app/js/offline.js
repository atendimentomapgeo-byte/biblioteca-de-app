/**
 * offline.js
 * -----------------------------------------------------------------------
 * Registro do Service Worker e monitoramento do estado de conectividade.
 * Também cuida da recuperação automática do último projeto aberto e de
 * avisos amigáveis relacionados a armazenamento/offline.
 */

(function () {
  const Offline = {
    status: navigator.onLine ? 'online' : 'offline',
    listeners: new Set(),

    init() {
      window.addEventListener('online', () => Offline._set('online'));
      window.addEventListener('offline', () => Offline._set('offline'));

      if ('serviceWorker' in navigator) {
        // Necessário servir via http(s):// (não funciona em file://). Documentado no README.
        navigator.serviceWorker
          .register('service-worker.js')
          .then((reg) => {
            console.log('[offline] Service worker registrado com sucesso.', reg.scope);
          })
          .catch((err) => {
            console.warn('[offline] Não foi possível registrar o service worker (normal se aberto via file://).', err);
          });
      }
    },

    _set(status) {
      Offline.status = status;
      Offline.listeners.forEach((cb) => cb(status));
    },

    on(cb) {
      Offline.listeners.add(cb);
      return () => Offline.listeners.delete(cb);
    },

    isOnline() {
      return navigator.onLine;
    },

    async checkStorageWarning() {
      const estimate = await DB.estimateStorage();
      if (estimate && estimate.quota) {
        const usedPct = (estimate.usage / estimate.quota) * 100;
        if (usedPct > 90) {
          return `Atenção: o armazenamento local está ${usedPct.toFixed(0)}% ocupado. Considere exportar e limpar projetos antigos.`;
        }
      }
      return null;
    },

    /** Solicita armazenamento persistente ao navegador (evita que o sistema apague os dados sob pressão de espaço). */
    async requestPersistentStorage() {
      if (navigator.storage && navigator.storage.persist) {
        return navigator.storage.persist();
      }
      return false;
    },
  };

  window.Offline = Offline;
})();
