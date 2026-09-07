// Turns transcript segments into a structured summary + timeline.
// Works fully offline with a heuristic; if an API endpoint is configured
// it POSTs the transcript and uses the returned JSON instead.

const STOPWORDS = new Set([
  // English
  'the','a','an','and','or','but','so','to','of','in','on','for','with','at','by','from',
  'is','are','was','were','be','been','being','it','this','that','these','those','i','you',
  'he','she','we','they','them','my','your','our','their','as','if','then','than','not','no',
  'do','does','did','have','has','had','will','would','can','could','should','about','just',
  'okay','ok','yeah','um','uh','like','really','very','also','well',
  // Korean particles / fillers
  '그','저','이','것','수','더','좀','그리고','그래서','근데','그런데','하지만','그냥','정말',
  '네','예','음','어','아','저기','있어요','있습니다','합니다','했습니다','입니다','됩니다',
  '없습니다','그렇습니다','거','때','에서','으로','에게',
  '은','는','이','가','을','를','의','도','만','과','와','한','및','또','또한','즉',
]);

// Multi-language cues that a sentence describes a to-do / decision.
const ACTION_CUES = [
  // Korean
  '하기로','해야','하겠','합시다','해주세요','부탁','확인', '준비','정리','전달','공유','일정',
  '까지','예정','담당','액션','결정','합의','follow','다음','계획',
  // English
  'todo','to-do','action item','will ','shall ','need to','needs to','should ','let\'s ',
  'assign','deadline','due ','follow up','follow-up','next step','make sure','ensure',
  'responsible','by monday','by tuesday','by wednesday','by thursday','by friday','decide',
];

function splitSentences(text) {
  return text
    .replace(/([.!?。！？])\s+/g, '$1\n')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

// Light Korean normalization: strip common trailing particles (josa) and
// verb/adjective endings so "예산을", "예산은", "했습니다" collapse toward stems.
const KO_SUFFIXES = [
  '했습니다','습니다','합니다','입니다','하기로','에서는','에서','으로','로는',
  '이라','라고','에게','한테','까지','부터','처럼','보다','마다','조차','밖에',
  '이다','이며','하며','하고','지만','는데','은데',
  '은','는','이','가','을','를','의','에','도','만','과','와','로','들','께','님',
];
function normalizeKo(word) {
  if (!/[가-힣]/.test(word)) return word; // not Hangul
  for (const suf of KO_SUFFIXES) {
    if (word.length > suf.length + 1 && word.endsWith(suf)) {
      return word.slice(0, -suf.length);
    }
  }
  return word;
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map(normalizeKo)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

function wordFrequencies(segments) {
  const freq = new Map();
  for (const seg of segments) {
    for (const w of tokenize(seg.text)) {
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return freq;
}

function topKeywords(freq, n) {
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map((x) => x[0]);
}

function scoreSentence(sentence, freq) {
  const words = tokenize(sentence);
  if (!words.length) return 0;
  let s = 0;
  for (const w of words) s += freq.get(w) || 0;
  return s / Math.sqrt(words.length); // normalize by length
}

function detectActionItems(segments) {
  const items = [];
  for (const seg of segments) {
    const low = seg.text.toLowerCase();
    if (ACTION_CUES.some((cue) => low.includes(cue))) {
      items.push({ t: seg.t, text: seg.text });
    }
  }
  // Deduplicate near-identical lines.
  const seen = new Set();
  return items.filter((it) => {
    const key = it.text.slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
}

// Group segments into timeline blocks by time gaps / fixed windows,
// labeling each block with its most salient keyword.
function buildTimeline(segments, freq) {
  if (!segments.length) return [];
  const blocks = [];
  const WINDOW = 120; // seconds per block target
  let current = null;

  for (const seg of segments) {
    if (!current || seg.t - current.start >= WINDOW) {
      current = { start: seg.t, segs: [] };
      blocks.push(current);
    }
    current.segs.push(seg);
  }

  return blocks.map((b) => {
    const text = b.segs.map((s) => s.text).join(' ');
    // Topic = highest-frequency keyword appearing in this block.
    const blkWords = tokenize(text);
    let topic = '';
    let best = 0;
    const local = new Map();
    for (const w of blkWords) local.set(w, (local.get(w) || 0) + 1);
    for (const [w, c] of local) {
      const score = c * (freq.get(w) || 1);
      if (score > best) { best = score; topic = w; }
    }
    // A short recap = highest scoring sentence in the block.
    const sentences = splitSentences(text);
    let recap = sentences[0] || text.slice(0, 120);
    let recapScore = -1;
    for (const s of sentences) {
      const sc = scoreSentence(s, freq);
      if (sc > recapScore) { recapScore = sc; recap = s; }
    }
    return { t: b.start, topic, recap: recap.slice(0, 200) };
  });
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h > 0) return `${h}:${String(mm).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function localSummarize(segments) {
  if (!segments.length) {
    return { overview: '', keyPoints: [], actionItems: [], topics: [] };
  }
  const freq = wordFrequencies(segments);
  const fullText = segments.map((s) => s.text).join(' ');
  const sentences = splitSentences(fullText);

  // Key points: top scored sentences, kept in original order.
  const scored = sentences.map((s, idx) => ({ s, idx, score: scoreSentence(s, freq) }));
  const topN = Math.min(5, Math.max(2, Math.round(sentences.length * 0.2)));
  const picked = [...scored].sort((a, b) => b.score - a.score).slice(0, topN)
    .sort((a, b) => a.idx - b.idx).map((x) => x.s);

  const keywords = topKeywords(freq, 6);
  const overview = picked.slice(0, 2).join(' ') ||
    fullText.slice(0, 200);

  return {
    overview,
    keyPoints: picked,
    actionItems: detectActionItems(segments),
    topics: buildTimeline(segments, freq),
    keywords,
  };
}

// Public: summarize, using remote API if configured, else local.
export async function summarize(segments, { apiEndpoint, language } = {}) {
  if (apiEndpoint) {
    try {
      const res = await fetch(apiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language,
          transcript: segments.map((s) => ({ t: s.t, text: s.text })),
        }),
      });
      if (res.ok) {
        const data = await res.json();
        // Expect { overview, keyPoints[], actionItems[], topics[] }.
        return { ...localSummarize(segments), ...data, source: 'ai' };
      }
    } catch (_) { /* fall through to local */ }
  }
  return { ...localSummarize(segments), source: 'local' };
}

export { fmtTime };
