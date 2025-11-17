const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { execFile, spawn } = require('child_process');

// Load environment variables from .env
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const ARTICLES_DIR = path.join(__dirname, 'articles');

const SITES = [
  process.env.FORK1,
  process.env.FORK2
];

// Pexels API key (from .env)
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const crypto = require('crypto');

async function parseClick2Houston(listingUrl) {
  const listingHtml = await fetchHtml(listingUrl);
  const $ = cheerio.load(listingHtml);

  // find the marquee container
  const marquee = $('div.dist__Box-sc-1fnzlkn-0.dist__StackBase-sc-1fnzlkn-7.ecGWWE.iQviKm.marqueeNext').first();
  if (!marquee) return null;

  // find the very first article inside the marquee with the given class
  const articleEl = marquee.find('article.dist__Box-sc-1fnzlkn-0.dist__StackBase-sc-1fnzlkn-7.ecGWWE.hTYOfq').first();
  if (!articleEl) return null;

  // under that article, find the span.storyImage then the anchor inside it
  const span = articleEl.find('span.dist__Box-sc-1fnzlkn-0.dist__LinkBase-sc-1fnzlkn-9.rbfmb.storyImage').first();
  if (!span) return null;
  const a = span.find('a').first();
  if (!a) return null;

  // Prefer the image src from the listing card (avoid taking the anchor href as the image)
  let imgUrl = null;
  // common places: figure > img, .imageWrapper img, or an img inside the anchor
  const figureImg = articleEl.find('figure img').first();
  if (figureImg && figureImg.attr('src')) {
    imgUrl = figureImg.attr('src');
  }

  if (!imgUrl) {
    const imgWrap = articleEl.find('div.dist__Box-sc-1fnzlkn-0.khZRPB.imageWrapper').first();
    if (imgWrap && imgWrap.length) {
      const img = imgWrap.find('img').first();
      if (img && img.attr('src')) imgUrl = img.attr('src');
    }
  }

  if (!imgUrl) {
    const anchorImg = a.find('img').first();
    if (anchorImg && anchorImg.attr('src')) imgUrl = anchorImg.attr('src');
  }

  // still fallback to href for article navigation
  let href = a.attr('href');
  if (!href) return null;
  if (!href.startsWith('http')) href = new URL(href, listingUrl).toString();

  // fetch article page
  const articleHtml = await fetchHtml(href);
  const $$ = cheerio.load(articleHtml);

  // find #main-content
  const main = $$('#main-content').first();
  const title = main.find('h1.dist__Box-sc-1fnzlkn-0.dist__HeadingBase-sc-1fnzlkn-6.kCsgQi.headline').first().text().trim();

  // find the articleBody section
  const bodySection = main.find('section.dist__Box-sc-1fnzlkn-0.dist__StackBase-sc-1fnzlkn-7.fURyTV.iQviKm.articleBody').first();
  const ps = [];
  bodySection.find('p.dist__Box-sc-1fnzlkn-0.dist__TextBase-sc-1fnzlkn-3.bYFsJw.cuqaEv.article-text').each((i, el) => {
    ps.push($$(el).text().trim());
  });
  const body = ps.join('\n\n').trim();

  // If we didn't find an image in the listing, try common meta tags on the article page
  let finalImage = imgUrl || null;
  if (!finalImage) {
    const og = $$('meta[property="og:image"]').attr('content');
    const twitter = $$('meta[name="twitter:image"]').attr('content');
    const linkImage = $$('link[rel="image_src"]').attr('href');
    finalImage = og || twitter || linkImage || null;
  }

  return {
    title: title || href,
    url: finalImage || href,
    body,
    articleUrl: href
  };
}

async function parseKHOU(listingUrl) {
  const listingHtml = await fetchHtml(listingUrl);
  const $ = cheerio.load(listingHtml);

  const list = $('div.story-list').first().find('ul.story-list__list').first();
  const firstLi = list.find('li.story-list__item').first();
  const photo = firstLi.find('div.story-list__photo').first();
  const a = photo.find('a.story-list__image-link').first();
  if (!a) return null;
  let href = a.attr('href');
  if (!href) return null;
  if (!href.startsWith('http')) href = new URL(href, listingUrl).toString();

  const imgEl = a.find('img.story-list__image').first();
  const imgUrl = imgEl ? imgEl.attr('src') || null : null;

  const articleHtml = await fetchHtml(href);
  const $$ = cheerio.load(articleHtml);

  const container = $$('div.grid__module-sizer.grid__module-sizer_name_article').first();
  const title = container.find('h1.article__headline').first().text().trim();

  const ps = [];
  container.find('div.article__body').find('div.article__section.article__section_type_text.utility__text').each((i, section) => {
    $$(section).find('p').each((j, p) => ps.push($$(p).text().trim()));
  });
  const body = ps.join('\n\n').trim();

  return {
    title: title || href,
    url: imgUrl || href,
    body,
    articleUrl: href
  };
}

async function ensureArticlesDir() {
  if (!fs.existsSync(ARTICLES_DIR)) {
    fs.mkdirSync(ARTICLES_DIR, { recursive: true });
  }
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ArticleFetcher/1.0)' } });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return await res.text();
}

function textFromHtml(html) {
  const $ = cheerio.load(html);
  // Extract main text heuristically
  const selectors = [
    'article',
    '[itemprop=articleBody]',
    '.article-body',
    '.entry-content',
    '.post-content',
    '.Article',
    '.content'
  ];

  for (const sel of selectors) {
    const el = $(sel).first();
    if (el && el.text().trim().length > 200) {
      return el.text().trim();
    }
  }

  // Fallback to body text
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  return bodyText.slice(0, 10000); // limit size
}

// Simple keyword extraction from a title. Prefer a short, meaningful token.
function selectKeywordFromTitle(title) {
  if (!title) return null;
  // basic stopwords list
  const stop = new Set(['the','and','a','an','to','of','in','on','for','with','is','are','was','were','be','by','that','this','it','as','at','from','or','but','news','season','interactive','more','after','says','officials','official']);
  // keep letters, digits, hyphen and apostrophe
  const cleaned = title.replace(/[^A-Za-z0-9\-\'\s]/g, ' ');
  const parts = cleaned.split(/\s+/).map(s => s.trim()).filter(Boolean);
  // prefer a word >=4 chars that's not a stopword
  for (const p of parts) {
    const low = p.toLowerCase();
    if (low.length >= 4 && !stop.has(low)) return p;
  }
  // fallback: longest non-stopword
  let best = null;
  for (const p of parts) {
    const low = p.toLowerCase();
    if (stop.has(low)) continue;
    if (!best || p.length > best.length) best = p;
  }
  return best || (parts[0] || null);
}

// Query Pexels for a representative image for a given keyword.
// Returns an object { imageUrl, photographer } or null
async function fetchPexelsImage(keyword) {
  if (!keyword) return null;
  try {
    const q = encodeURIComponent(keyword);
    const url = `https://api.pexels.com/v1/search?query=${q}&per_page=6&page=1`;
    const res = await fetch(url, { headers: { Authorization: PEXELS_API_KEY } });
    if (!res.ok) {
      console.warn('Pexels request failed:', res.status, res.statusText);
      return null;
    }
    const data = await res.json();
    if (!data || !Array.isArray(data.photos) || data.photos.length === 0) return null;
    // pick first photo that has src
    const first = data.photos[0];
    for (const p of data.photos) {
      if (p && p.src) {
        const src = p.src.large || p.src.medium || p.src.original || p.src.small;
        if (src) return { imageUrl: src, photographer: p.photographer || null };
      }
    }
    // fallback
    const src = (first && first.src && (first.src.large || first.src.medium || first.src.original || first.src.small)) || null;
    if (!src) return null;
    return { imageUrl: src, photographer: first.photographer || null };
  } catch (e) {
    console.warn('Failed to fetch from Pexels:', e && e.message);
    return null;
  }
}

// Try to fetch an image, falling back to a generic "police car" query when nothing found
async function fetchPexelsImageWithFallback(keyword) {
  let res = null;
  if (keyword) res = await fetchPexelsImage(keyword).catch(() => null);
  if (res) return res;
  // fallback generic keyword to increase chance of success
  try {
    return await fetchPexelsImage('police car');
  } catch (e) {
    return null;
  }
}

async function pickArticleUrlFromListing(listingUrl) {
  try {
    const html = await fetchHtml(listingUrl);
    const $ = cheerio.load(html);

    // common patterns for article links
    const linkSelectors = [
      'a[href*="/news/"]',
      'a[href*="/article/"]',
      'a[href*="/stories/"]',
      'a.featured',
      'a.headline',
      'h3 a',
      'h2 a'
    ];

    const seen = new Set();
    const candidates = [];

    for (const sel of linkSelectors) {
      $(sel).each((i, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        let abs = href;
        try {
          abs = new URL(href, listingUrl).toString();
        } catch (e) {
          return;
        }
        if (!seen.has(abs)) {
          seen.add(abs);
          candidates.push(abs);
        }
      });
    }

    // Prefer links that look like an article
    for (const c of candidates) {
      if (/\/news\//i.test(c) || /\/article/i.test(c) || /\/stories\//i.test(c)) return c;
    }

    return candidates[0];
  } catch (err) {
    return null;
  }
}

async function fetchOneArticle(listing) {
  // allow an explicit listing to be provided; otherwise pick a random one
  const listingToUse = listing || SITES[Math.floor(Math.random() * SITES.length)];
  console.log('Using listing:', listingToUse);

  // Choose site-specific parser when available
  try {
    if (listingToUse.includes('click2houston.com')) {
      const r = await parseClick2Houston(listingToUse);
      if (r) return { title: r.title, url: r.url, content: r.body, articleUrl: r.articleUrl, source: listingToUse };
    }
    if (listingToUse.includes('khou.com')) {
      const r = await parseKHOU(listingToUse);
      if (r) return { title: r.title, url: r.url, content: r.body, articleUrl: r.articleUrl, source: listingToUse };
    }

    // Fallback generic behavior
    const articleUrl = await pickArticleUrlFromListing(listingToUse);
    if (!articleUrl) throw new Error('No article URL found from listing ' + listingToUse);

    console.log('Fetching article:', articleUrl);
    const articleHtml = await fetchHtml(articleUrl);
    const $ = cheerio.load(articleHtml);

    // title
    const title = ($('h1').first().text() || $('title').first().text()).trim() || articleUrl;
    const content = textFromHtml(articleHtml);

    return { title, url: articleUrl, content, source: listingToUse };
  } catch (err) {
    throw err;
  }
}

// Check for duplicates among locally saved JSON files (by url/articleUrl/title)
function isDuplicateLocally(article) {
  try {
    if (!fs.existsSync(ARTICLES_DIR)) return false;
    const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.toLowerCase().endsWith('.json'));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(ARTICLES_DIR, file), 'utf8');
        const doc = JSON.parse(raw);
        // compare articleUrl first, then url, then title
        if (article.articleUrl && (doc.articleUrl === article.articleUrl || doc.url === article.articleUrl)) return true;
        if (article.url && (doc.url === article.url || doc.articleUrl === article.url)) return true;
        if (article.title && doc.title && doc.title.trim() === article.title.trim()) return true;
        // check fingerprint if provided (stronger detection for rewritten clones)
        if (article.fingerprint && doc.fingerprint && article.fingerprint === doc.fingerprint) return true;
        // as a softer check, compute similarity between bodies if present
        if (article.body && doc.body) {
          try {
            const sim = textSimilarity(article.body, doc.body);
            // consider >=0.85 as near-duplicate (rewrites should have lower similarity)
            if (sim >= 0.85) return true;
          } catch (e) { /* ignore similarity errors */ }
        }
      } catch (e) {
        // ignore malformed files
      }
    }
  } catch (e) {
    return false;
  }
  return false;
}

function safeFilename(s) {
  return s.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '_').slice(0, 200);
}

// --- Content cleaning and lightweight paraphrasing ---
function removeIdentifiers(text) {
  if (!text) return '';
  let t = text;
  // Remove emails
  t = t.replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '');
  // Remove URLs
  t = t.replace(/https?:\/\/\S+/gi, '');
  // Remove common social handles like @username
  t = t.replace(/@\w{2,}/g, '');
  // Remove phone numbers (common US formats)
  t = t.replace(/\+?\d?[\s.-]?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}/g, '');
  // Remove leftover multiple spaces
  t = t.replace(/\s{2,}/g, ' ');
  return t.trim();
}

function removeContactLines(paragraph) {
  if (!paragraph) return true; // drop
  const p = paragraph.replace(/\s+/g, ' ').trim();
  const badPatterns = [
    /got a news tip/i,
    /email us/i,
    /call .*?\d{3}/i,
    /contact us/i,
    /follow us/i,
    /sign in/i,
    /join insider/i,
    /sponsored/i
  ];
  for (const rx of badPatterns) if (rx.test(p)) return true;
  return false;
}

function paraphraseText(text) {
  // Make paraphraseText a minimal whitespace normalizer only. All heavy rewriting should be
  // performed by Ollama. This prevents local synonym/substitution and sentence-reordering logic
  // from introducing repetitive patterns.
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

function processTitle(raw) {
  if (!raw) return '';
  let t = raw.trim();
  // remove byline like "By John Smith"
  t = t.replace(/^By\s+[A-Z][^\n\r]+/i, '').trim();
  t = removeIdentifiers(t);
  // Do not paraphrase locally; leave rewording to Ollama to avoid local repeated patterns.
  return t;
}

function processBody(raw) {
  if (!raw) return '';
  // Split into paragraphs. The scraper uses double-newline joins, so split on that.
  const paras = raw.split(/\n\s*\n/).map(p => p.trim());
  const kept = [];
  for (let p of paras) {
    if (!p) continue;
    // Remove identifiers from paragraph text first
    p = removeIdentifiers(p);
    // Drop paragraphs that are too short
    if (p.replace(/\s+/g, '').length <= 10) continue;
    // Drop contact / promotional lines
    if (removeContactLines(p)) continue;
    // Drop paragraphs that are mostly iframes or HTML-like
    if (/^<iframe|^<script|^<noscript/i.test(p)) continue;
    // Do not paraphrase locally; let Ollama handle rewriting to avoid duplication issues
    const para = p;
    kept.push(para);
  }
  return kept.join('\n\n');
}

// --- Rewrite helpers: try local Ollama CLI first, otherwise deterministic fallback ---
function enforce500Words(text) {
  if (!text) return '';
  // Only normalize whitespace. Do not fabricate filler locally; let Ollama perform any expansion.
  const norm = text.replace(/\s+/g, ' ').trim();
  const words = norm.length ? norm.split(' ').filter(Boolean) : [];
  if (words.length >= 500) return norm;
  // If under 500 words, return normalized text unchanged (caller may decide to accept shorter output).
  return norm;
}

// rewrite the title using Ollama or fallback paraphrase
async function rewriteTitle(rawTitle) {
  if (!rawTitle) return '';
  const basePrompt = `Rewrite the following article title. Return a single concise, engaging headline. Do NOT repeat phrases verbatim from the input. Prefer active voice and avoid clickbait. Provide only the headline.`;
  try {
    console.log('Attempting to rewrite title using Ollama (with similarity checks)');
    const out = await rewriteWithOllamaWithRetries(basePrompt, rawTitle, undefined, 2);
    const t = out.split(/\n/)[0] || out;
    return processTitle(t);
  } catch (e) {
    console.log('Title rewrite via Ollama failed or was too similar, falling back to local paraphrase. Error:', e && e.message);
    return processTitle(paraphraseText(rawTitle));
  }
}

// Turn a 500-word string into paragraphized article-like text without changing words.
function paragraphizeWords(text, wordsPerParagraph = 100) {
  if (!text) return '';
  // split on whitespace to preserve exact words
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const paras = [];
  for (let i = 0; i < words.length; i += wordsPerParagraph) {
    const chunk = words.slice(i, i + wordsPerParagraph).join(' ').trim();
    // minimal punctuation cleanup per paragraph
    const cleaned = chunk.replace(/!{2,}/g, '!').replace(/\?{2,}/g, '?').replace(/\.{3,}/g, '...');
    paras.push(cleaned);
  }
  let out = paras.join('\n\n');
  // ensure single trailing newline
  if (!out.endsWith('\n')) out += '\n';
  return out;
}

// --- Ollama API integration (hosted, requires API key) ---
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY;
const OLLAMA_API_URL = 'https://api.ollama.com/v1/generate';

async function rewriteWithOllamaLocal(promptText, model) {
  model = model || 'mistral';
  // Use Ollama API (hosted) instead of local CLI
  try {
    const res = await fetch(OLLAMA_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OLLAMA_API_KEY}`
      },
      body: JSON.stringify({
        model,
        prompt: promptText,
        stream: false
      })
    });
    if (!res.ok) {
      throw new Error(`Ollama API request failed: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    if (!data || !data.response) throw new Error('Ollama API: No response field in result');
    return data.response.trim();
  } catch (e) {
    throw new Error('Ollama API error: ' + (e && e.message));
  }
}

// Lightweight similarity check between two texts. Returns a score 0..1 where 1 means identical
function textSimilarity(a, b) {
  if (!a || !b) return 0;
  const stopwords = new Set(['the','and','a','an','to','of','in','on','for','with','is','are','was','were','be','by','that','this','it','as','at','from','or','but']);
  const tokenize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).filter(w => !stopwords.has(w));
  const wa = tokenize(a);
  const wb = tokenize(b);
  if (wa.length === 0 || wb.length === 0) return 0;
  const setA = new Set(wa);
  const setB = new Set(wb);
  let common = 0;
  for (const w of setA) if (setB.has(w)) common++;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : (common / union);
}

// Wrapper around Ollama call that retries when the output is too similar to the input.
// It tightens the prompt on each retry to explicitly forbid repeating sentences verbatim.
async function rewriteWithOllamaWithRetries(basePrompt, inputText, model, maxAttempts = 3) {
  model = model || process.env.OLLAMA_MODEL || 'mistral';
  let attempt = 0;
  let lastErr = null;
  const baseInstruction = `You are a professional editor. Do NOT repeat sentences verbatim from the input. Fully paraphrase and expand where needed. Use different sentence structure, synonyms, and reorder content. Avoid copying long phrases (no more than 3 consecutive identical words). Produce fluent, coherent article text of approximately 500 words unless requested otherwise.`;
  while (attempt < maxAttempts) {
    attempt++;
    const extra = attempt === 1 ? '' : `\n\nRetry attempt ${attempt}: The previous output was too similar to the input. Be stricter: DO NOT COPY. Expand by drawing out details, add connective phrases, and change sentence order.`;
    const prompt = `${baseInstruction}\n\n${basePrompt}${extra}\n\nInput:\n${inputText.slice(0, 20000)}`;
    try {
      const out = await rewriteWithOllamaLocal(prompt, model);
      // quick similarity check - if it's too similar, retry
      const sim = textSimilarity(inputText, out);
      console.log('Ollama similarity score:', sim);
      // If similarity is high (>= 0.5) consider it too close and retry
      if (sim >= 0.5 && attempt < maxAttempts) {
        console.warn('Ollama output too similar to input, will retry with stronger prompt');
        lastErr = new Error('Output too similar');
        continue;
      }
      return out;
    } catch (e) {
      console.warn('Ollama attempt failed:', e && (e.message || e));
      lastErr = e;
      // small backoff
      await new Promise(r => setTimeout(r, 200 * attempt));
      continue;
    }
  }
  throw lastErr || new Error('Ollama retries exhausted');
}

async function rewriteTo500(text) {
  if (!text) return '';
  const targetMin = 450; // lower bound to consider the output sufficiently long
  const target = 500;
  const basePrompt = `Rewrite the following article into an original, coherent article of approximately ${target} words. Do NOT repeat sentences verbatim from the input. Paraphrase, expand where appropriate, change sentence order, and vary sentence openings. Avoid using the same phrases longer than three words in a row. Preserve facts but not original phrasing. Output only the article text.`;

  const countWords = (s) => (s || '').trim().replace(/\s+/g, ' ').split(' ').filter(Boolean).length;

  try {
    let out = await rewriteWithOllamaWithRetries(basePrompt, text, undefined, 3);
    let words = countWords(out);
    console.log('rewriteTo500: initial Ollama word count =', words);

    // If output is too short, iteratively ask the model to expand the previous output to reach ~500 words.
    if (words < targetMin) {
      const maxExtraExpansions = 3;
      for (let exp = 1; exp <= maxExtraExpansions && words < targetMin; exp++) {
        // Provide a structured expansion prompt with suggestions to add concrete sections that commonly
        // increase useful length: background, timeline, manufacturer response, consumer actions, safety tips.
        const expandPrompt = `The article below is only ${words} words. Expand it to be about ${target} words. Do NOT repeat sentences verbatim from the text. Preserve facts but deepen and broaden the coverage by: (1) adding brief background or context, (2) including a short timeline of events/dates where relevant, (3) noting company/manufacturer responses or statements, (4) giving concrete consumer actions and safety/handling guidance, and (5) adding any likely consequences or next steps from authorities. Keep the tone factual and clear. Output only the expanded article text.\n\nPrevious article:\n${out.slice(0, 20000)}`;
        try {
          console.log(`rewriteTo500: expansion attempt ${exp} (asking Ollama directly)`);
          // Use direct Ollama CLI call for expansion (bypass similarity wrapper to allow overlap while expanding)
          const expanded = await rewriteWithOllamaLocal(expandPrompt, undefined);
          if (expanded && expanded.trim().length > 0) {
            out = expanded;
            words = countWords(out);
            console.log('rewriteTo500: expanded Ollama word count =', words);
          } else {
            console.warn('rewriteTo500: empty expansion from Ollama');
            break;
          }
        } catch (e) {
          console.warn('rewriteTo500: expansion attempt failed:', e && (e.message || e));
          break;
        }
      }
    }

    // Final normalization: prefer Ollama's output. If it's still short, return it as-is (no local fabrication).
    const exact = enforce500Words(out);
    return paragraphizeWords(exact, 100);
  } catch (e) {
    console.log('Falling back to local deterministic rewrite (Ollama unavailable or failed). Error:', e && e.message);
    // If Ollama isn't available, return normalized original text (we cannot reliably fabricate good filler locally)
    const norm = enforce500Words(paraphraseText(text));
    return paragraphizeWords(norm, 100);
  }
}

async function main() {
  await ensureArticlesDir();

  try {
    // Try a primary listing, and if duplicate, try the other listing once
    // pick a random starting index
    const startIndex = Math.floor(Math.random() * SITES.length);
    let article = null;
    let tried = 0;
    for (let i = 0; i < SITES.length && tried < SITES.length; i++) {
      const idx = (startIndex + i) % SITES.length;
      const listing = SITES[idx];
      tried++;
      try {
        const candidate = await fetchOneArticle(listing);
        // attach articleUrl if not present
        if (!candidate.articleUrl && candidate.url && candidate.url.startsWith('http')) candidate.articleUrl = candidate.url;
        if (isDuplicateLocally(candidate)) {
          console.log('Duplicate detected from', listing, '- trying next site');
          continue; // try next listing
        }
        article = candidate;
        break;
      } catch (e) {
        console.warn('Failed to fetch from', listing, e && e.message);
        continue;
      }
    }

    if (!article) throw new Error('No new article found from any listing');
    // rewrite the title as well (LLM or fallback) and use it in the filename
    const rewrittenTitle = await rewriteTitle(article.title || '');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const fname = `${ts}_${safeFilename(rewrittenTitle || article.title || 'article')}.txt`;
    const outPath = path.join(ARTICLES_DIR, fname);
  // process title and body to remove identifiers and paraphrase
  const title = rewrittenTitle || processTitle(article.title || '');
  const rawBody = processBody(article.content || article.body || '');

  // rewrite body to target ~500 words via Ollama prompt when available; do not truncate output
  const rewrittenBody = await rewriteTo500(rawBody);

  // Helper: ensure any literal "n/" appears only after a period. If it appears elsewhere,
  // insert a period and a space before it so it looks like sentence boundary.
  function sanitizeNslash(str) {
    if (!str) return str;
    return str.replace(/n\//g, function(match, offset, s) {
      // find previous non-space character
      let i = offset - 1;
      while (i >= 0 && /\s/.test(s[i])) i--;
      if (i >= 0 && s[i] === '.') return match; // already after a period
      return '. ' + match; // insert a sentence boundary before n/
    });
  }

  // Merge stray newlines inserted between sentence fragments where the following line
  // begins with an uppercase word (common with Ollama injecting newlines after abbreviations)
  function fixStrayNewlines(text) {
    if (!text) return text;
    // Replace occurrences like "U.S.\n\nImmigration" -> "U.S. Immigration"
    // Strategy: collapse newlines where the following token starts with uppercase or an opening parenthesis
    return text.replace(/([A-Za-z0-9\)\"])(\r?\n){1,2}(?=[A-Z\(\"])\s*/g, '$1 ');
  }

  const safeBody = sanitizeNslash(rewrittenBody);
  const fixedBody = fixStrayNewlines(safeBody);

  // Prefix the article body with a source attribution line
  let sourceLabel = '';
  try {
    if (article.source && article.source.includes('khou.com')) sourceLabel = 'According to KHOU';
    else if (article.source && article.source.includes('click2houston.com')) sourceLabel = 'According to Click2Houston';
    else if (article.articleUrl && article.articleUrl.includes('khou.com')) sourceLabel = 'According to KHOU';
    else if (article.articleUrl && article.articleUrl.includes('click2houston.com')) sourceLabel = 'According to Click2Houston';
  } catch (e) {
    sourceLabel = '';
  }
  const prefixedBody = sourceLabel ? `${sourceLabel}:\n\n${fixedBody}` : fixedBody;

  // Reflow paragraphs: remove existing newlines and insert a blank line before every Nth sentence.
  function reflowParagraphsEveryN(text, n = 3) {
    if (!text) return text;
    // normalize whitespace and remove existing newlines
    let s = text.replace(/\r\n|\r|\n/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    // find sentence boundaries by periods followed by space(s) and a capital letter
    // we'll walk the string and count periods that appear to be sentence ends
    const parts = [];
    let start = 0;
    let sentenceCount = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '.') {
        // lookahead: find next non-space character
        let j = i + 1;
        while (j < s.length && /\s/.test(s[j])) j++;
        const next = s[j] || '';
        // If next is uppercase letter, treat this as sentence boundary
        if (next && /[A-Z\u00C0-\u017F]/.test(next)) {
          // Also avoid counting ellipses as multiple sentence ends
          // Grab substring from start to j
          const sentence = s.slice(start, j).trim();
          if (sentence.length) {
            parts.push(sentence);
            sentenceCount++;
            start = j;
          }
        }
      }
    }
    // push any remainder
    if (start < s.length) {
      const tail = s.slice(start).trim();
      if (tail) parts.push(tail);
    }

    // Now join into paragraphs every n sentences
    const paras = [];
    for (let i = 0; i < parts.length; i += n) {
      const segment = parts.slice(i, i + n).join(' ');
      paras.push(segment);
    }
    return paras.join('\n\n');
  }

  const reformattedBody = reflowParagraphsEveryN(prefixedBody.replace(/(\r?\n){2,}/g, '\n\n'), 3);
  // Remove any accidental literal "Title: " markers that may have been injected into the body
  const cleanedBody = reformattedBody.replace(/Title: /g, '');

  // ensure final newline
  let content = `Title: ${title}\nURL: ${article.url}\n\n${cleanedBody}`;
  if (!content.endsWith('\n')) content += '\n';
    // Do not write files yet: check fingerprint/duplicates first, then persist below

    // Attempt to get a representative image from Pexels based on the title
      let pexelsResult = null;
      try {
        const keyword = selectKeywordFromTitle(title || article.title || '');
        // use fallback helper that will try a generic 'police car' if nothing found
        pexelsResult = await fetchPexelsImageWithFallback(keyword);
      } catch (e) {
        console.warn('Pexels fetch failed:', e && e.message);
      }

      // sanitize title: remove stray surrounding quotes and backslashes
      const cleanTitle = (title || article.title || '').replace(/^\s*["'`]+|["'`]+\s*$/g, '').replace(/\\/g, '');

      // Also write a JSON file next to the txt file
      // compute fingerprint for the final cleanedBody for stronger duplicate detection
      const finalNorm = (cleanedBody || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const finalFingerprint = (() => {
        try { const h = crypto.createHash('sha256'); h.update(finalNorm); return h.digest('hex'); } catch (e) { return null; }
      })();

      // If this fingerprint or similar body already exists locally, skip saving
      const possible = { fingerprint: finalFingerprint, body: cleanedBody };
      if (isDuplicateLocally(possible)) {
        console.log('Skipped saving duplicate article (fingerprint or high similarity detected).');
      } else {
      // write text file and json metadata
      try {
        fs.writeFileSync(outPath, content, 'utf8');
        console.log('Saved article to', outPath);
      } catch (e) {
        console.warn('Failed to write article text file:', e && e.message);
      }
      const json = {
        title: cleanTitle,
        // url should reference our chosen image (Pexels) when available, otherwise fall back to scraped url
        url: (pexelsResult && pexelsResult.imageUrl) || article.url || null,
  // sourcedBy should include photographer credit when available, prefixed for clarity
  sourcedBy: (pexelsResult && pexelsResult.photographer) ? `Image Source: ${pexelsResult.photographer}, Pexels` : null,
        // keep legacy imageUrl for compatibility
        imageUrl: (pexelsResult && pexelsResult.imageUrl) || article.url || null,
        body: cleanedBody,
        // fingerprint of normalized body to detect clones later
        fingerprint: finalFingerprint,
        scrapedAt: new Date().toISOString()
      };
    const jsonPath = outPath.replace(/\.txt$/i, '.json');
    try {
      fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), 'utf8');
      console.log('Saved JSON to', jsonPath);
    } catch (e) {
      console.warn('Failed to write JSON:', e && e.message);
    }
    }
  } catch (err) {
    console.error('Error:', err.message || err);
    process.exitCode = 1;
  }
}
// Export main for programmatic use (runner) while preserving CLI behavior
async function scrapeAndSave() {
  return main();
}

module.exports = { scrapeAndSave };

if (require.main === module) main();
