// IndexedDB storage layer for recordings.
// A recording document:
// {
//   id, title, createdAt, durationSec, language, location,
//   audio: Blob, mime,
//   segments: [{ t, text }],   // t = seconds from start
//   summary: { overview, keyPoints[], actionItems[], topics[] }
// }

const DB_NAME = 'recall-db';
const DB_VERSION = 1;
const STORE = 'recordings';
const META = 'meta';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode) {
  return openDB().then((db) => db.transaction(store, mode).objectStore(store));
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveRecording(rec) {
  const store = await tx(STORE, 'readwrite');
  await reqToPromise(store.put(rec));
  return rec;
}

export async function getRecording(id) {
  const store = await tx(STORE, 'readonly');
  return reqToPromise(store.get(id));
}

export async function deleteRecording(id) {
  const store = await tx(STORE, 'readwrite');
  return reqToPromise(store.delete(id));
}

export async function getAllRecordings() {
  const store = await tx(STORE, 'readonly');
  const all = await reqToPromise(store.getAll());
  // Newest first for display.
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function clearAllRecordings() {
  const store = await tx(STORE, 'readwrite');
  return reqToPromise(store.clear());
}

export async function totalDurationSec() {
  const all = await getAllRecordings();
  return all.reduce((sum, r) => sum + (r.durationSec || 0), 0);
}

// ---- Meta (settings) ----
const DEFAULTS = {
  capHours: 200,
  defaultLang: 'ko-KR',
  apiEndpoint: '',
  apiToken: '',
};

export async function getSetting(key) {
  const store = await tx(META, 'readonly');
  const row = await reqToPromise(store.get(key));
  return row ? row.value : DEFAULTS[key];
}

export async function setSetting(key, value) {
  const store = await tx(META, 'readwrite');
  return reqToPromise(store.put({ key, value }));
}

// Enforce the total-hours cap by deleting the OLDEST recordings first
// until total duration is at or below the limit.
// Returns array of deleted { id, title }.
export async function enforceCap() {
  const capHours = await getSetting('capHours');
  const capSec = capHours * 3600;
  const all = await getAllRecordings(); // newest first
  let total = all.reduce((s, r) => s + (r.durationSec || 0), 0);
  const deleted = [];
  // Delete from the oldest end.
  for (let i = all.length - 1; i >= 0 && total > capSec; i--) {
    const r = all[i];
    await deleteRecording(r.id);
    total -= r.durationSec || 0;
    deleted.push({ id: r.id, title: r.title });
  }
  return deleted;
}
