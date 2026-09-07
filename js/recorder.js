// Captures microphone audio via MediaRecorder and drives a live waveform.

export class AudioRecorder {
  constructor(canvas) {
    this.canvas = canvas;
    this.stream = null;
    this.mediaRecorder = null;
    this.chunks = [];
    this.audioCtx = null;
    this.analyser = null;
    this.rafId = null;
    this.mime = '';
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    // Pick a broadly-supported container.
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
    this.mime = candidates.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';

    this.mediaRecorder = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);
    this.chunks = [];
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.mediaRecorder.start(1000); // gather in 1s slices

    this._startWave();
  }

  pause() {
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.pause();
      cancelAnimationFrame(this.rafId);
    }
  }

  resume() {
    if (this.mediaRecorder && this.mediaRecorder.state === 'paused') {
      this.mediaRecorder.resume();
      this._drawLoop();
    }
  }

  // Resolves with the final Blob.
  stop() {
    return new Promise((resolve) => {
      if (!this.mediaRecorder) return resolve(null);
      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mime || 'audio/webm' });
        this._cleanup();
        resolve(blob);
      };
      if (this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop();
      else { this._cleanup(); resolve(new Blob(this.chunks, { type: this.mime || 'audio/webm' })); }
    });
  }

  cancel() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.onstop = null;
      this.mediaRecorder.stop();
    }
    this._cleanup();
  }

  _cleanup() {
    cancelAnimationFrame(this.rafId);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.audioCtx && this.audioCtx.state !== 'closed') this.audioCtx.close();
    this.stream = null;
    this.audioCtx = null;
    this.analyser = null;
  }

  _startWave() {
    if (!this.canvas) return;
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = this.audioCtx.createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 256;
    src.connect(this.analyser);
    this._drawLoop();
  }

  _drawLoop() {
    const canvas = this.canvas;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
    };
    resize();
    const buf = new Uint8Array(this.analyser.frequencyBinCount);

    // Precompute the gradient once (recreating it per bar per frame is the
    // single biggest cause of main-thread jank / unresponsive taps on phones).
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grad.addColorStop(0, '#7c5cff');
    grad.addColorStop(1, '#5b8cff');
    ctx.fillStyle = grad;

    const bars = 40;
    const step = Math.max(1, Math.floor(buf.length / bars));
    const FRAME_MS = 1000 / 30; // cap at ~30fps to leave the UI thread free
    let last = 0;

    const draw = (now) => {
      this.rafId = requestAnimationFrame(draw);
      if (now - last < FRAME_MS) return;
      last = now;
      this.analyser.getByteFrequencyData(buf);
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      const bw = w / bars;
      ctx.beginPath(); // one path for all bars
      for (let i = 0; i < bars; i++) {
        const v = buf[i * step] / 255;
        const bh = Math.max(4 * dpr, v * h * 0.9);
        const x = i * bw;
        const y = (h - bh) / 2;
        const r = Math.min(bw * 0.3, bh / 2);
        roundRectPath(ctx, x + bw * 0.2, y, bw * 0.6, bh, r);
      }
      ctx.fill(); // single fill for all bars
    };
    this.rafId = requestAnimationFrame(draw);
  }
}

// Appends a rounded-rect subpath (no beginPath, so many can share one path).
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
