/**
 * database.js
 * -----------------------------------------------------------------------
 * Camada de acesso ao banco de dados local (IndexedDB) do FieldGIS.
 *
 * Todas as informações do aplicativo (projetos, mapas, camadas, pontos,
 * trilhas, polígonos, fotografias, formulários e configurações) são
 * armazenadas inteiramente no dispositivo do usuário, sem depender de
 * nenhum servidor remoto. Isso é o que garante o funcionamento 100% offline.
 *
 * Estrutura (object stores):
 *   - projects  { id, name, description, createdAt, updatedAt }
 *   - maps      { id, projectId, name, type, bounds, crs, meta, blobKey, createdAt, updatedAt }
 *   - layers    { id, projectId, name, kind, visible, opacity, color, weight, order, style, createdAt, updatedAt }
 *   - points    { id, projectId, layerId, name, code, lat, lon, alt, accuracy, attributes, photos, createdAt, updatedAt }
 *   - tracks    { id, projectId, layerId, name, points:[{lat,lon,alt,acc,speed,time}], stats, createdAt, updatedAt }
 *   - polygons  { id, projectId, layerId, name, vertices:[{lat,lon}], area, perimeter, attributes, createdAt, updatedAt }
 *   - photos    { id, projectId, pointId, blob, lat, lon, alt, takenAt, createdAt }
 *   - forms     { id, projectId, name, fields:[{key,label,type,options}], createdAt, updatedAt }
 *   - settings  { id: 'app', ...settings }
 *   - blobs     { id, kind, blob, meta }  -- armazenamento genérico de arquivos binários (mapas raster, etc.)
 *
 * Todos os registros usam UUID v4 como identificador (função uuid()).
 */

const DB_NAME = 'fieldgis-db';
const DB_VERSION = 1;

const STORES = ['projects', 'maps', 'layers', 'points', 'tracks', 'polygons', 'photos', 'forms', 'settings', 'blobs'];

let dbPromise = null;

/** Gera um UUID v4 (RFC4122) usando crypto.getRandomValues quando disponível. */
function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  // Fallback manual (navegadores muito antigos)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Abre (ou cria/atualiza) o banco IndexedDB. Retorna uma Promise<IDBDatabase>. */
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('Este navegador não suporta armazenamento local (IndexedDB). Não será possível salvar dados.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('maps')) {
        const s = db.createObjectStore('maps', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId', { unique: false });
      }
      if (!db.objectStoreNames.contains('layers')) {
        const s = db.createObjectStore('layers', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId', { unique: false });
      }
      if (!db.objectStoreNames.contains('points')) {
        const s = db.createObjectStore('points', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId', { unique: false });
        s.createIndex('layerId', 'layerId', { unique: false });
      }
      if (!db.objectStoreNames.contains('tracks')) {
        const s = db.createObjectStore('tracks', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId', { unique: false });
        s.createIndex('layerId', 'layerId', { unique: false });
      }
      if (!db.objectStoreNames.contains('polygons')) {
        const s = db.createObjectStore('polygons', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId', { unique: false });
        s.createIndex('layerId', 'layerId', { unique: false });
      }
      if (!db.objectStoreNames.contains('photos')) {
        const s = db.createObjectStore('photos', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId', { unique: false });
        s.createIndex('pointId', 'pointId', { unique: false });
      }
      if (!db.objectStoreNames.contains('forms')) {
        const s = db.createObjectStore('forms', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId', { unique: false });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('blobs')) {
        const s = db.createObjectStore('blobs', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId', { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => console.warn('[database] Atualização do banco bloqueada por outra aba aberta.');
  });
  return dbPromise;
}

function tx(storeName, mode = 'readonly') {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const DB = {
  uuid,

  /** Insere ou atualiza um registro, preenchendo createdAt/updatedAt automaticamente. */
  async put(store, obj) {
    const now = new Date().toISOString();
    if (!obj.id) obj.id = uuid();
    if (!obj.createdAt) obj.createdAt = now;
    obj.updatedAt = now;
    const os = await tx(store, 'readwrite');
    await reqToPromise(os.put(obj));
    return obj;
  },

  /** Insere/atualiza vários registros em uma única transação. */
  async bulkPut(store, items) {
    if (!Array.isArray(items) || !items.length) return [];
    const now = new Date().toISOString();
    const prepared = items.map((obj) => {
      if (!obj.id) obj.id = uuid();
      if (!obj.createdAt) obj.createdAt = now;
      obj.updatedAt = now;
      return obj;
    });
    const os = await tx(store, 'readwrite');
    await Promise.all(prepared.map((obj) => reqToPromise(os.put(obj))));
    return prepared;
  },

  async get(store, id) {
    const os = await tx(store);
    return reqToPromise(os.get(id));
  },

  async delete(store, id) {
    const os = await tx(store, 'readwrite');
    return reqToPromise(os.delete(id));
  },

  async all(store) {
    const os = await tx(store);
    return reqToPromise(os.getAll());
  },

  /** Retorna todos os registros de um store filtrados por projectId (usa índice quando existir). */
  async byProject(store, projectId) {
    const os = await tx(store);
    if (os.indexNames.contains('projectId')) {
      const idx = os.index('projectId');
      return reqToPromise(idx.getAll(projectId));
    }
    const arr = await reqToPromise(os.getAll());
    return arr.filter((r) => r.projectId === projectId);
  },

  async byIndex(store, indexName, value) {
    const os = await tx(store);
    const idx = os.index(indexName);
    return reqToPromise(idx.getAll(value));
  },

  /** Remove em cascata todos os dados de um projeto em uma única transação. */
  async deleteProjectCascade(projectId) {
    const stores = ['maps', 'layers', 'points', 'tracks', 'polygons', 'photos', 'forms', 'blobs', 'projects'];
    const [maps, layers, points, tracks, polygons, photos, forms, blobs] = await Promise.all([
      DB.byProject('maps', projectId),
      DB.byProject('layers', projectId),
      DB.byProject('points', projectId),
      DB.byProject('tracks', projectId),
      DB.byProject('polygons', projectId),
      DB.byProject('photos', projectId),
      DB.byProject('forms', projectId),
      DB.byProject('blobs', projectId),
    ]);
    const db = await openDB();
    const transaction = db.transaction(stores, 'readwrite');
    const idsByStore = {
      maps, layers, points, tracks, polygons, photos, forms, blobs,
    };
    for (const store of Object.keys(idsByStore)) {
      const os = transaction.objectStore(store);
      for (const item of idsByStore[store]) os.delete(item.id);
    }
    transaction.objectStore('projects').delete(projectId);
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Transação de exclusão abortada.'));
    });
  },

  /** Exclui uma camada e seus dados relacionados em uma única transação. */
  async deleteLayerCascade(layerId) {
    const layer = await DB.get('layers', layerId);
    if (!layer) return false;

    const [points, tracks, polygons, maps] = await Promise.all([
      DB.byIndex('points', 'layerId', layerId).catch(() => []),
      DB.byIndex('tracks', 'layerId', layerId).catch(() => []),
      DB.byIndex('polygons', 'layerId', layerId).catch(() => []),
      DB.byProject('maps', layer.projectId),
    ]);
    const layerMaps = maps.filter((m) => m.layerId === layerId);
    const pointIds = new Set(points.map((p) => p.id));
    const photos = pointIds.size ? (await DB.byProject('photos', layer.projectId)).filter((p) => pointIds.has(p.pointId)) : [];
    const allBlobs = await DB.byProject('blobs', layer.projectId);
    const referencedBlobKeys = new Set(maps.filter((m) => !layerMaps.includes(m)).map((m) => m.blobKey).filter(Boolean));
    const blobs = allBlobs.filter((b) => layerMaps.some((m) => m.blobKey === b.id) && !referencedBlobKeys.has(b.id));

    const stores = ['points', 'tracks', 'polygons', 'photos', 'maps', 'blobs', 'layers'];
    const db = await openDB();
    const transaction = db.transaction(stores, 'readwrite');
    const deleteMany = (store, items) => {
      const os = transaction.objectStore(store);
      for (const item of items) os.delete(item.id);
    };
    deleteMany('points', points);
    deleteMany('tracks', tracks);
    deleteMany('polygons', polygons);
    deleteMany('photos', photos);
    deleteMany('maps', layerMaps);
    deleteMany('blobs', blobs);
    transaction.objectStore('layers').delete(layerId);
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Transação de exclusão abortada.'));
    });
    return true;
  },

  async getSettings() {
    const s = await DB.get('settings', 'app');
    return s || DB.defaultSettings();
  },

  async saveSettings(partial) {
    const current = await DB.getSettings();
    const merged = Object.assign({}, current, partial, { id: 'app' });
    return DB.put('settings', merged);
  },

  defaultSettings() {
    return {
      id: 'app',
      gps: { minAccuracy: 30, minInterval: 2000, minDistance: 3, autoUpdate: true, useCompass: false },
      coords: { datum: 'SIRGAS2000', format: 'dms', showUTM: true, epsg: null },
      map: { showGrid: false, showScale: true, showNorth: true },
      units: { distance: 'm', area: 'ha' },
      fieldMode: false,
      watermark: true,
    };
  },

  /** Estimativa de uso de armazenamento (quando suportado pelo navegador). */
  async estimateStorage() {
    if (navigator.storage && navigator.storage.estimate) {
      return navigator.storage.estimate();
    }
    return null;
  },
};

window.DB = DB;
