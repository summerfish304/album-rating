import { showToast } from './ui.js';

let audio = null;
let currentBtn = null;
let currentTrackId = null;
let playlist = [];
let playlistIndex = -1;
let onEndCallback = null;

function getAudio() {
  if (!audio) {
    audio = new Audio();
    audio.addEventListener('timeupdate', updateProgress);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('error', () => {
      showToast('Ошибка воспроизведения');
      resetPlayer();
    });
  }
  return audio;
}

function initProgressRing(btn) {
  if (!btn || btn.classList.contains('btn-listen-all')) return;
  if (btn.querySelector('svg')) return;
  
  const r = 13;
  const c = 2 * Math.PI * r;
  
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.style.position = 'absolute';
  svg.style.top = '50%';
  svg.style.left = '50%';
  svg.style.width = '32px';
  svg.style.height = '32px';
  svg.style.transform = 'translate(-50%, -50%) rotate(-90deg)';
  svg.style.pointerEvents = 'none';
  svg.style.zIndex = '1';
  
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '16');
  circle.setAttribute('cy', '16');
  circle.setAttribute('r', r);
  circle.setAttribute('fill', 'transparent');
  circle.setAttribute('stroke', 'var(--accent)');
  circle.setAttribute('stroke-width', '2.5');
  circle.setAttribute('stroke-dasharray', c);
  circle.setAttribute('stroke-dashoffset', c);
  
  svg.appendChild(circle);
  
  const textSpan = btn.querySelector('span:not(.preview-spinner)');
  if (textSpan) {
    textSpan.style.position = 'relative';
    textSpan.style.zIndex = '2';
  }
  
  btn.style.position = 'relative';
  btn.appendChild(svg);
}

function updateProgress() {
  if (!audio || !currentBtn) return;
  const btn = currentBtn;
  if (btn.classList.contains('btn-listen-all')) return;
  
  const circle = btn.querySelector('circle');
  if (!circle) return;
  
  const duration = audio.duration;
  if (!duration || duration === Infinity) return;
  
  const c = parseFloat(circle.getAttribute('stroke-dasharray'));
  const pct = audio.currentTime / duration;
  const offset = c - (pct * c);
  circle.setAttribute('stroke-dashoffset', offset);
}

export async function playPreview(track, btnEl) {
  const a = getAudio();
  const trackId = track.id || track.spotifyId || track.name;

  if (currentTrackId === trackId && a.src) {
    if (a.paused) {
      a.play();
      updateBtn(btnEl, true);
    } else {
      a.pause();
      updateBtn(btnEl, false);
    }
    return;
  }

  a.pause();
  resetPlayer();
  
  currentBtn = btnEl;
  currentTrackId = trackId;
  updateBtn(btnEl, false, true);

  try {
    let url = track.preview_url;
    const artistName = track.artists?.[0]?.name || track.artist || "";
    const trackName = track.name || "";

    // 1. Пробуем iTunes (только для западных)
    if (!url) {
      const isCyrillic = /[а-яА-ЯёЁ]/.test(trackName) || /[а-яА-ЯёЁ]/.test(artistName);
      if (!isCyrillic) {
        url = await fetchItunesPreview(trackName, artistName);
      }
    }
    
    // 2. Если iTunes не справился или трек русский — идем в Deezer
    if (!url) {
      url = await fetchDeezerPreview(trackName, artistName);
    }

    if (!url) {
      updateBtn(btnEl, false, false, true);
      showToast('Отрывок не найден');
      return;
    }

    a.src = url;
    a.play();
    updateBtn(btnEl, true);
  } catch (err) {
    console.error(err);
    updateBtn(btnEl, false, false, true);
    showToast('Не удалось загрузить отрывок');
  }
}

async function fetchItunesPreview(trackName, artistName) {
  if (!trackName) return null;
  const cacheKey = `itunes_v3_${artistName}_${trackName}`.replace(/\s+/g, '_').toLowerCase();
  const cached = localStorage.getItem(cacheKey);
  
  if (cached) {
    if (cached === 'null') return null;
    return cached;
  }

  // Добавляем attribute=artistTerm для точного поиска
  const q = encodeURIComponent(`${artistName} ${trackName}`);
  const url = `https://itunes.apple.com/search?term=${q}&media=music&entity=song&attribute=artistTerm&limit=5`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    
    let previewUrl = null;
    if (data.results && data.results.length > 0) {
      // Ищем совпадение по артисту (без учета регистра)
      const searchArtist = artistName.toLowerCase().trim();
      const match = data.results.find(r => {
        const rArtist = (r.artistName || "").toLowerCase();
        // Проверяем, что имя артиста не пустое и содержит наш запрос (или наоборот)
        return rArtist.length > 0 && (rArtist.includes(searchArtist) || searchArtist.includes(rArtist));
      });
      
      if (match && match.previewUrl) {
        previewUrl = match.previewUrl;
      }
    }
    
    localStorage.setItem(cacheKey, previewUrl || 'null');
    return previewUrl;
  } catch (e) {
    console.warn('iTunes error', e);
    return null;
  }
}

async function fetchDeezerPreview(trackName, artistName) {
  if (!trackName) return null;
  const cacheKey = `deezer_v3_${artistName}_${trackName}`.replace(/\s+/g, '_').toLowerCase();
  const cached = localStorage.getItem(cacheKey);
  
  if (cached) {
    if (cached === 'null') return null;
    return cached;
  }

  const q = encodeURIComponent(`${artistName} ${trackName}`);
  const targetUrl = `https://api.deezer.com/search?q=${q}&limit=5`;
  const proxyUrl = `https://album-rating-proxy.duckdns.org/api/proxy?u=${encodeURIComponent(targetUrl)}`;

  try {
    const res = await fetch(proxyUrl);
    if (!res.ok) throw new Error("Proxy error");
    const data = await res.json();
    
    let previewUrl = null;
    if (data.data && data.data.length > 0) {
      const searchArtist = artistName.toLowerCase().trim();
      const match = data.data.find(r => {
        const rArtist = (r.artist?.name || "").toLowerCase();
        return rArtist.length > 0 && (rArtist.includes(searchArtist) || searchArtist.includes(rArtist));
      });
      
      if (match && match.preview) {
        previewUrl = match.preview;
      }
    }
    
    localStorage.setItem(cacheKey, previewUrl || 'null');
    return previewUrl;
  } catch (e) {
    console.warn("Deezer fetch error:", e);
    return null;
  }
}

export function setQueue(tracks, startIndex = 0, onEnd = null) {
  playlist = tracks;
  playlistIndex = startIndex;
  onEndCallback = onEnd;
}

export function playNext() {
  if (playlistIndex < playlist.length - 1) {
    playlistIndex++;
    const nextTrack = playlist[playlistIndex];
    const btn = document.getElementById(`play-btn-${nextTrack.id || nextTrack.spotifyId}`);
    playPreview(nextTrack, btn);
  } else {
    resetPlayer();
    if (onEndCallback) onEndCallback();
  }
}

function handleEnded() {
  if (playlist.length > 0 && playlistIndex !== -1) {
    playNext();
  } else {
    resetPlayer();
  }
}

export function stopPreview() {
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
    audio.src = '';
  }
  resetPlayer();
}

function resetPlayer() {
  if (currentBtn) updateBtn(currentBtn, false);
  currentBtn = null;
  currentTrackId = null;
  playlist = [];
  playlistIndex = -1;
}

function updateBtn(btn, isPlaying, isLoading = false, isDisabled = false) {
  if (!btn) return;
  const isBigBtn = btn.classList.contains('btn-listen-all');
  
  if (isLoading) {
    btn.innerHTML = '<span class="preview-spinner"></span>';
    btn.disabled = true;
    return;
  }
  if (isDisabled) {
    btn.innerHTML = '▶';
    btn.disabled = true;
    btn.classList.add('preview-disabled');
    return;
  }
  
  btn.classList.remove('preview-disabled');
  
  if (isBigBtn) {
    btn.innerHTML = isPlaying ? '⏸ Пауза' : '▶ Слушать отрывки';
  } else {
    btn.innerHTML = isPlaying ? '<span>⏸</span>' : '<span>▶</span>';
    if (isPlaying) {
      initProgressRing(btn);
    } else {
      const circle = btn.querySelector('circle');
      if (circle) {
        circle.setAttribute('stroke-dashoffset', circle.getAttribute('stroke-dasharray'));
      }
    }
  }
  
  btn.classList.toggle('is-playing', isPlaying);
  btn.disabled = false;
}