import { MongoClient } from 'mongodb';

// Vercel serverless function: GET /api/posts
// Environment variables:
// - MONGODB_URI (required)
// - MONGODB_DB (optional, default: HourlyHouston)
// - MONGODB_COLLECTION (optional, default: Articles)

let cachedClient = null;
let cachedDb = null;

function slugify(title){
  if(!title) return '';
  return String(title)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function escapeForRegex(str){
  // escape special regex characters so we can build dynamic regexes safely
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function connectToDatabase(uri, dbName) {
  if (cachedClient && cachedDb) return { client: cachedClient, db: cachedDb };
  const client = new MongoClient(uri, { ignoreUndefined: true });
  await client.connect();
  const db = client.db(dbName);
  cachedClient = client;
  cachedDb = db;
  return { client, db };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    res.status(500).json({ error: 'MONGODB_URI not configured' });
    return;
  }

  const dbName = process.env.MONGODB_DB || 'HourlyHouston';
  const collectionName = process.env.MONGODB_COLLECTION || 'Articles';

  try {
    const { db } = await connectToDatabase(uri, dbName);
    const col = db.collection(collectionName);

    // count total documents
    const totalDocs = await col.countDocuments();

    // If ?title=... return the document matching that title (used by article page)
    // If ?title=... or ?slug=... return the document matching that title/slug (used by article page)
    if (req.query && (req.query.title || req.query.slug)) {
        const titleQuery = req.query.title;
        const slugQuery = req.query.slug;
        let doc = null;
        if(slugQuery){
          // try slug match first (stored slug field)
          doc = await col.findOne({ slug: slugQuery }, { projection: { title: 1, url: 1, body: 1, scrapedAt: 1, sourcedBy: 1 } });
          if(!doc){
            // fallback to title-like matching from slug
            const slugToTitle = String(slugQuery).replace(/-/g,' ').replace(/\s+/g,' ').trim();
            // Try exact-title-like match first (case-insensitive)
            doc = await col.findOne({ title: { $regex: `^${escapeForRegex(slugToTitle)}$`, $options: 'i' } }, { projection: { title: 1, url: 1, body: 1, scrapedAt: 1, sourcedBy: 1 } });
            if(!doc){
              // Looser fallback: convert slug parts into a permissive regex that allows
              // punctuation or words between parts. Example: 'foo-bar_baz' -> /foo.*bar.*baz/i
              const parts = String(slugQuery).split(/-+/).map(p => p.trim()).filter(Boolean).map(escapeForRegex);
              if(parts.length){
                const loosePattern = parts.join('.*');
                try{
                  doc = await col.findOne({ title: { $regex: loosePattern, $options: 'i' } }, { projection: { title: 1, url: 1, body: 1, scrapedAt: 1, sourcedBy: 1 } });
                }catch(e){ /* if regex is invalid or DB errors, ignore and continue */ }
              }
            }
          }
        } else if(titleQuery){
          doc = await col.findOne({ title: titleQuery }, { projection: { title: 1, url: 1, body: 1, scrapedAt: 1, sourcedBy: 1 } });
        }
      const out = doc ? {
        _id: doc._id,
        title: doc.title || '',
        url: doc.url || '',
          slug: slugify(doc.title || ''),
        body: doc.body || '',
        sourcedBy: doc.sourcedBy || '',
        scrapedAt: doc.scrapedAt ? new Date(doc.scrapedAt).toISOString() : null,
      } : null;
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
      if (!out) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json({ post: out });
    }

    // If ?hero=1 return only the most recent document
    if(req.query && req.query.hero === '1'){
  const heroDoc = await col.find({}, { projection: { title: 1, url: 1, body: 1, scrapedAt: 1, sourcedBy: 1 } }).sort({ scrapedAt: -1 }).limit(1).toArray();
      const d = heroDoc[0] || null;
      const out = d ? {
        _id: d._id,
        title: d.title || '',
        url: d.url || '',
        slug: slugify(d.title || ''),
        body: d.body || '',
        sourcedBy: d.sourcedBy || '',
        scrapedAt: d.scrapedAt ? new Date(d.scrapedAt).toISOString() : null,
      } : null;
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
      res.status(200).json({ post: out });
      return;
    }

    // Pagination for story grid (excludes the hero which is always the most recent)
    const page = parseInt(req.query.page || '1', 10) || 1;
    const perPage = parseInt(req.query.perPage || '6', 10) || 6; // default 6 (3x2)

    // compute skip to exclude hero (most recent) then page offset
    const skip = Math.max(0, (page - 1) * perPage) + (totalDocs > 0 ? 1 : 0);
    const limit = perPage;

  const cursor = col.find({}, { projection: { title: 1, url: 1, body: 1, scrapedAt: 1, sourcedBy: 1 } }).sort({ scrapedAt: -1 }).skip(skip).limit(limit);
    const docs = await cursor.toArray();

    const out = docs.map(d => ({
      _id: d._id,
      title: d.title || '',
      url: d.url || '',
      slug: slugify(d.title || ''),
      body: d.body || '',
      sourcedBy: d.sourcedBy || '',
      scrapedAt: d.scrapedAt ? new Date(d.scrapedAt).toISOString() : null,
    }));

    // total items available for paging the grid (exclude hero)
    const totalForGrid = Math.max(0, totalDocs - (totalDocs > 0 ? 1 : 0));

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.status(200).json({ posts: out, total: totalForGrid });
  } catch (err) {
    console.error('DB error', err);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
}
