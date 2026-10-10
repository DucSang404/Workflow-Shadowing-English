// Turns the Groq completion into one item per sentence, and writes the manifest
// the media scripts read.
//
// Two texts are kept per sentence on purpose:
//   `en`       - verbatim, this is what gets burned into the subtitle
//   `ttsText`  - normalised, this is what edge-tts is asked to say
// Neural TTS mangles digits, symbols and emoji ("$3.50" becomes "dollar three
// point five zero"), so numerals are spelled out and anything unspeakable is
// dropped before synthesis - without disturbing what the learner reads.
const fs = require('fs');
const cfg = $('Prepare Run').first().json;

// ---------- number spelling ----------------------------------------------
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function spellInt(n) {
  if (n < 0) return `minus ${spellInt(-n)}`;
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
  if (n < 1000) {
    return `${ONES[Math.floor(n / 100)]} hundred` + (n % 100 ? ` and ${spellInt(n % 100)}` : '');
  }
  if (n < 1000000) {
    return `${spellInt(Math.floor(n / 1000))} thousand` + (n % 1000 ? ` ${spellInt(n % 1000)}` : '');
  }
  return String(n); // beyond small talk; leave it alone rather than mangle it
}

function normalizeForTts(input) {
  let t = String(input).normalize('NFC');

  // Typographic characters the voice reads as literal noise.
  t = t.replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, ', ')
    .replace(/…/g, '.');

  // Emoji, pictographs, variation selectors and zero-width joiners.
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200B}-\u{200D}]/gu, '');

  // Markdown emphasis leaking out of the model.
  t = t.replace(/[*_`#>]/g, '');

  // Money first: "$3.50" -> "three dollars fifty cents".
  t = t.replace(/\$\s?(\d+)(?:\.(\d{2}))?/g, (_, d, c) => {
    const dollars = `${spellInt(Number(d))} ${Number(d) === 1 ? 'dollar' : 'dollars'}`;
    return c && Number(c) ? `${dollars} ${spellInt(Number(c))} cents` : dollars;
  });

  // Clock times: "3:30" -> "three thirty", "7:00" -> "seven o'clock".
  t = t.replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) => (Number(m) === 0
    ? `${spellInt(Number(h))} o'clock`
    : `${spellInt(Number(h))} ${spellInt(Number(m))}`));

  // "3pm" -> "three p m" (spaced so the voice says the letters).
  t = t.replace(/\b(\d{1,2})\s?(am|pm)\b/gi,
    (_, h, s) => `${spellInt(Number(h))} ${s.toLowerCase().split('').join(' ')}`);

  // Percentages, then any bare integer left over.
  t = t.replace(/\b(\d+)\s?%/g, (_, d) => `${spellInt(Number(d))} percent`);
  t = t.replace(/\b\d+\b/g, (m) => spellInt(Number(m)));

  // Anything remaining that is not speech or punctuation the voice honours.
  t = t.replace(/[^A-Za-z0-9 '.,!?;:-]/g, ' ');

  return t.replace(/\s+/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim();
}

// n8n truncates a Code node's error message at its LAST colon, so anything before
// one never reaches the caller. Hence ` - ` instead of `: ` throughout, and the
// colon-stripping in `brief()` - a raw JSON dump is full of colons and would eat
// the sentence explaining it.
const brief = (v, n) =>
  (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, n).replace(/:/g, '=');

// ---------- pull the payload out of the completion ------------------------
const completion = $input.first().json;
const content = completion?.choices?.[0]?.message?.content;
if (!content) {
  throw new Error(`Groq returned no content - ${brief(completion, 400)}`);
}

let parsed;
try {
  parsed = JSON.parse(content);
} catch (err) {
  // json_object mode is usually clean, but a fenced block still shows up sometimes.
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Groq content is not JSON - ${brief(content, 300)}`);
  parsed = JSON.parse(match[0]);
}

const rows = Array.isArray(parsed.sentences) ? parsed.sentences : [];
if (rows.length < 5) {
  throw new Error(`expected at least 5 sentences, got ${rows.length}`);
}

// Two speakers get two voices. The model is asked to alternate A/B, but a model
// that forgets the field would silently collapse the dialogue back to one voice,
// so an absent or unexpected value falls back to alternating by position.
const VOICES = { A: cfg.voiceA, B: cfg.voiceB };

const sentences = rows.slice(0, cfg.sentenceCount).map((row, i) => {
  const en = String(row.en ?? row.english ?? '').trim();
  const vi = String(row.vi ?? row.vietnamese ?? '').trim();
  if (!en) throw new Error(`sentence ${i + 1} has no English text`);

  const declared = String(row.speaker ?? '').trim().toUpperCase();
  const speaker = VOICES[declared] ? declared : (i % 2 === 0 ? 'A' : 'B');

  // Falls back to the topic so a sentence without a usable query still gets a
  // scene rather than a hole in the video.
  const imageQuery = String(row.imageQuery ?? '').trim().slice(0, 80) || cfg.topic;
  return { idx: i + 1, speaker, en, vi, imageQuery, ttsText: normalizeForTts(en) };
});

// Caption and hashtags for the TikTok post, generated in the same Groq call as
// the dialogue. The model can forget them without the run being wrong, so both
// fall back to something usable rather than throwing.
const caption = String(parsed.caption ?? '').trim().slice(0, 300)
  || `Luyện nói tiếng Anh: ${cfg.topic}`;
// Stock search for the title-card backdrop: the place, with nobody in it.
const coverQuery = String(parsed.coverQuery ?? '').trim().slice(0, 80) || cfg.topic;
const hashtags = (Array.isArray(parsed.hashtags) ? parsed.hashtags : [])
  .map((t) => String(t).trim().replace(/^#+/, '').replace(/\s+/g, ''))
  .filter(Boolean)
  .slice(0, 8);

// The spoken brand line that plays over the title card.
//
// It rides the existing TTS path as an extra item numbered 0, so it needs no new
// node and no new credential, and a failure degrades exactly like a failed
// sentence: no sent_000.mp3, probe_durations reports it missing, and the card
// falls back to silence.
//
// It is deliberately NOT a member of `sentences`. Everything downstream treats
// that array as the dialogue - fetch_scenes.js wants a picture per entry,
// 03_build_srt.js wants a cue per entry - and the brand line is neither.
const introText = cfg.intro && cfg.introLine
  ? cfg.introLine.replace(/\{brand\}/gi, cfg.brand.name).replace(/\{topic\}/gi, cfg.topic).trim()
  : '';
const intro = introText
  ? { idx: 0, en: introText, ttsText: normalizeForTts(introText) }
  : null;

// The manifest is the contract the container/cli/* scripts read: they take a
// directory on argv and nothing else, so anything they need has to be in here.
// fetch_music.js reads `music` the way fetch_scenes.js reads `sentences`.
fs.writeFileSync(
  cfg.manifestPath,
  JSON.stringify({ runId: cfg.runId, topic: cfg.topic, music: cfg.music,
    imageSource: cfg.imageSource, reviewImages: cfg.reviewImages, passScore: cfg.passScore,
    caption, hashtags, coverQuery, intro, sentences }, null, 2),
  'utf8',
);

const items = sentences.map((s) => ({ json: { ...s, voice: VOICES[s.speaker], speed: cfg.speed } }));
if (intro) {
  // Item 0 doubles as the title card's slot in the stock search: its `imageQuery`
  // is the cover search, and 05_collect_stock.js files the results under idx 0.
  items.unshift({
    json: {
      ...intro, isIntro: true, imageQuery: coverQuery,
      voice: VOICES.A, speed: cfg.introSpeed,
    },
  });
}
return items;
