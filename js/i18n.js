// Supported recognition languages and location→language helpers.

export const LANGUAGES = [
  { code: 'ko-KR', label: '한국어' },
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'ja-JP', label: '日本語' },
  { code: 'zh-CN', label: '中文 (简体)' },
  { code: 'zh-TW', label: '中文 (繁體)' },
  { code: 'es-ES', label: 'Español' },
  { code: 'fr-FR', label: 'Français' },
  { code: 'de-DE', label: 'Deutsch' },
  { code: 'it-IT', label: 'Italiano' },
  { code: 'pt-BR', label: 'Português (BR)' },
  { code: 'ru-RU', label: 'Русский' },
  { code: 'vi-VN', label: 'Tiếng Việt' },
  { code: 'th-TH', label: 'ไทย' },
  { code: 'id-ID', label: 'Bahasa Indonesia' },
  { code: 'hi-IN', label: 'हिन्दी' },
  { code: 'ar-SA', label: 'العربية' },
];

export function langLabel(code) {
  const l = LANGUAGES.find((x) => x.code === code);
  return l ? l.label : code;
}

// Country code (ISO-3166 alpha-2) → best recognition language.
const COUNTRY_LANG = {
  KR: 'ko-KR', US: 'en-US', GB: 'en-GB', AU: 'en-US', CA: 'en-US',
  JP: 'ja-JP', CN: 'zh-CN', TW: 'zh-TW', HK: 'zh-TW',
  ES: 'es-ES', MX: 'es-ES', AR: 'es-ES',
  FR: 'fr-FR', DE: 'de-DE', AT: 'de-DE', CH: 'de-DE',
  IT: 'it-IT', BR: 'pt-BR', PT: 'pt-BR',
  RU: 'ru-RU', VN: 'vi-VN', TH: 'th-TH', ID: 'id-ID',
  IN: 'hi-IN', SA: 'ar-SA', AE: 'ar-SA',
};

// Rough timezone→country fallback (no network needed).
const TZ_COUNTRY = {
  'Asia/Seoul': 'KR', 'Asia/Tokyo': 'JP', 'Asia/Shanghai': 'CN',
  'Asia/Taipei': 'TW', 'Asia/Hong_Kong': 'HK', 'Asia/Ho_Chi_Minh': 'VN',
  'Asia/Bangkok': 'TH', 'Asia/Jakarta': 'ID', 'Asia/Kolkata': 'IN',
  'Asia/Riyadh': 'SA', 'Asia/Dubai': 'AE',
  'Europe/Madrid': 'ES', 'Europe/Paris': 'FR', 'Europe/Berlin': 'DE',
  'Europe/Rome': 'IT', 'Europe/Lisbon': 'PT', 'Europe/Moscow': 'RU',
  'Europe/London': 'GB', 'Europe/Vienna': 'AT', 'Europe/Zurich': 'CH',
  'America/New_York': 'US', 'America/Los_Angeles': 'US', 'America/Chicago': 'US',
  'America/Sao_Paulo': 'BR', 'America/Mexico_City': 'MX', 'America/Toronto': 'CA',
  'Australia/Sydney': 'AU',
};

export function countryToLang(cc) {
  return COUNTRY_LANG[(cc || '').toUpperCase()] || null;
}

// Suggest a recognition language from device signals (no network).
// Priority: timezone → browser locales.
export function suggestLangFromDevice() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const cc = TZ_COUNTRY[tz];
    if (cc && COUNTRY_LANG[cc]) return { lang: COUNTRY_LANG[cc], source: `시간대: ${tz}` };
  } catch (_) { /* ignore */ }

  const locales = navigator.languages || [navigator.language];
  for (const loc of locales) {
    const exact = LANGUAGES.find((l) => l.code.toLowerCase() === loc.toLowerCase());
    if (exact) return { lang: exact.code, source: `브라우저: ${loc}` };
    const base = loc.split('-')[0].toLowerCase();
    const partial = LANGUAGES.find((l) => l.code.toLowerCase().startsWith(base + '-'));
    if (partial) return { lang: partial.code, source: `브라우저: ${loc}` };
  }
  return { lang: 'en-US', source: '기본값' };
}

// Reverse-geocode coordinates → country code using a public API.
// Falls back to null on any failure (offline safe).
export async function suggestLangFromCoords(lat, lon) {
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const cc = data.countryCode;
    const lang = countryToLang(cc);
    if (lang) return { lang, source: `위치: ${data.countryName || cc}` };
  } catch (_) { /* offline / blocked */ }
  return null;
}
