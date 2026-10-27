import { db, doc, getDoc, setDoc, serverTimestamp } from './firebase.js';
import { showToast } from './ui.js';

const PROXY_URL = 'https://album-rating-proxy.duckdns.org/api/proxy';

export async function getLyrics(trackId, trackName, artistName) {
  if (!trackName || !artistName) return null;
  
  const docRef = doc(db, "lyrics", trackId);
  try {
    // 1. Сначала проверяем базу (вдруг админ уже добавил вручную)
    const snap = await getDoc(docRef);
    if (snap.exists()) return snap.data();

    // 2. Если в базе нет, идем на lrclib.net через прокси
    const q = new URLSearchParams({ track_name: trackName, artist_name: artistName });
    const lrclibUrl = `https://lrclib.net/api/get?${q.toString()}`;
    
    // Добавляем таймаут, чтобы не висеть, если прокси тупит
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000); // 6 секунд

    const res = await fetch(`${PROXY_URL}?u=${encodeURIComponent(lrclibUrl)}`, { signal: controller.signal });
    clearTimeout(timeoutId);

    // Если прокси вернул ошибку (503, 500 и т.д.) — просто возвращаем null
    if (!res.ok) {
      console.warn("LRCLIB error status:", res.status);
      return { original: null, error: "not_found" };
    }
    
    const data = await res.json();
    const original = data.plainLyrics || null;
    
    if (!original) return { original: null, error: "not_found" };

    // 3. Сохраняем в Firestore, чтобы больше не дергать API
    const result = {
      trackId,
      trackName,
      artistName,
      original,
      translation: null,
      updatedAt: serverTimestamp()
    };
    
    await setDoc(docRef, result);
    return result;

  } catch (e) {
    // Если упало по таймауту или 503 — не ломаем страницу, просто говорим "нет текста"
    console.warn("Lyrics fetch error (expected if 503):", e.message);
    return { original: null, error: "network" };
  }
}

export async function translateLyrics(trackId, text) {
  if (!text) return null;
  
  // Бьем на куски по 1000 символов (лимит Google)
  const chunks = [];
  let current = "";
  
  text.split('\n').forEach(line => {
    if (current.length + line.length > 1000) {
      chunks.push(current);
      current = "";
    }
    current += line + "\n";
  });
  if (current) chunks.push(current);

  let translatedText = "";

  try {
    for (const chunk of chunks) {
      const q = encodeURIComponent(chunk);
      const targetUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ru&dt=t&q=${q}`;
      const proxyUrl = `${PROXY_URL}?u=${encodeURIComponent(targetUrl)}`;
      
      const res = await fetch(proxyUrl);
      if (!res.ok) throw new Error("Translate error");
      
      const data = await res.json();
      if (data && data[0]) {
        translatedText += data[0].map(item => item[0]).join('');
      }
    }

    // Обновляем перевод в базе
    const docRef = doc(db, "lyrics", trackId);
    await setDoc(docRef, {
      translation: translatedText,
      translatedAt: serverTimestamp()
    }, { merge: true });

    return translatedText;

  } catch (e) {
    console.error("Translation error:", e);
    return null;
  }
}