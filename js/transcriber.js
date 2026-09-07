// Live speech-to-text via the Web Speech API (SpeechRecognition).
// Produces timestamped final segments and streams interim text.

export function isSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export class Transcriber {
  constructor({ lang, onSegment, onInterim, onError }) {
    this.lang = lang;
    this.onSegment = onSegment || (() => {});
    this.onInterim = onInterim || (() => {});
    this.onError = onError || (() => {});
    this.recognition = null;
    this.running = false;
    this.startedAt = 0;
    this.pausedElapsed = 0;
    this.pauseMark = 0;
  }

  _elapsed() {
    if (!this.startedAt) return 0;
    return (Date.now() - this.startedAt - this.pausedElapsed) / 1000;
  }

  start() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { this.onError('unsupported'); return; }
    this.startedAt = Date.now();
    this.pausedElapsed = 0;
    this.running = true;

    const rec = new SR();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript.trim();
        if (!text) continue;
        if (result.isFinal) {
          this.onSegment({ t: Math.max(0, Math.round(this._elapsed())), text });
        } else {
          interim += text + ' ';
        }
      }
      this.onInterim(interim.trim());
    };

    rec.onerror = (e) => {
      // 'no-speech' and 'aborted' are common and non-fatal; keep going.
      if (e.error && e.error !== 'no-speech' && e.error !== 'aborted') {
        this.onError(e.error);
      }
    };

    rec.onend = () => {
      // Auto-restart while we intend to be running (recognition times out on
      // mobile after each phrase). Debounce the restart: a tight start/stop
      // loop makes the Android speech engine chime repeatedly.
      if (!this.running) return;
      if (this._restartTimer) return;
      this._restartTimer = setTimeout(() => {
        this._restartTimer = null;
        if (this.running) { try { rec.start(); } catch (_) { /* already starting */ } }
      }, 350);
    };

    this.recognition = rec;
    try { rec.start(); } catch (_) { /* ignore double-start */ }
  }

  pause() {
    this.pauseMark = Date.now();
    this.running = false;
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    // abort() halts immediately without emitting a trailing result chime.
    if (this.recognition) try { this.recognition.abort(); } catch (_) {}
  }

  resume() {
    if (this.pauseMark) this.pausedElapsed += Date.now() - this.pauseMark;
    this.pauseMark = 0;
    this.running = true;
    if (this.recognition) try { this.recognition.start(); } catch (_) {}
  }

  stop() {
    this.running = false;
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    if (this.recognition) {
      this.recognition.onend = null;
      this.recognition.onresult = null;
      // Prefer abort() over stop() — it ends instantly and avoids the
      // end-of-recognition chime on mobile.
      try { this.recognition.abort(); }
      catch (_) { try { this.recognition.stop(); } catch (_) {} }
    }
  }
}
