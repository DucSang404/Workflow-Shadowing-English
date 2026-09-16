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

// ---------- pull the payload out of the completion ------------------------
const completion = $input.first().json;
const content = completion?.choices?.[0]?.message?.content;
if (!content) {
  throw new Error(`Groq returned no content: ${JSON.stringify(completion).slice(0, 400)}`);
}

let parsed;
try {
  parsed = JSON.parse(content);
} catch (err) {
  // json_object mode is usually clean, but a fenced block still shows up sometimes.
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Groq content is not JSON: ${content.slice(0, 300)}`);
  parsed = JSON.parse(match[0]);
}

const rows = Array.isArray(parsed.sentences) ? parsed.sentences : [];
if (rows.length < 5) {
  throw new Error(`expected at least 5 sentences, got ${rows.length}`);
}

const sentences = rows.slice(0, cfg.sentenceCount).map((row, i) => {
  const en = String(row.en ?? row.english ?? '').trim();
  const vi = String(row.vi ?? row.vietnamese ?? '').trim();
  if (!en) throw new Error(`sentence ${i + 1} has no English text`);
  return { idx: i + 1, en, vi, ttsText: normalizeForTts(en) };
});

fs.writeFileSync(
  cfg.manifestPath,
  JSON.stringify({ runId: cfg.runId, topic: cfg.topic, sentences }, null, 2),
  'utf8',
);

return sentences.map((s) => ({ json: { ...s, voice: cfg.voice, speed: cfg.speed } }));
