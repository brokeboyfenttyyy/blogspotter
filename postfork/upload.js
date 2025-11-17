const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');

// Load environment variables from .env
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const ARTICLES_DIR = path.join(__dirname, 'articles');

// Configuration (from .env)
const MONGO_URI = process.env.MONGOURL_ENV;
const DB_NAME = process.env.BLOGNAME;
const COLLECTION_NAME = 'Articles';

async function uploadAll() {
  if (!fs.existsSync(ARTICLES_DIR)) {
    console.log('No articles directory found, nothing to upload.');
    return;
  }

  const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.toLowerCase().endsWith('.json'));
  if (files.length === 0) {
    console.log('No JSON files to upload.');
    return;
  }

  const client = new MongoClient(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const col = db.collection(COLLECTION_NAME);

    for (const file of files) {
      const full = path.join(ARTICLES_DIR, file);
      try {
        const raw = fs.readFileSync(full, 'utf8');
        const doc = JSON.parse(raw);
        // determine image URL for deduplication. prefer explicit fields if present
        const imageUrl = doc.image || doc.imageUrl || doc.url || null;

        // ensure an index on imageUrl for faster lookups (non-blocking)
        try {
          await col.createIndex({ imageUrl: 1 });
        } catch (e) {
          // ignore index creation errors
        }

        let exists = null;
        if (imageUrl) {
          exists = await col.findOne({ imageUrl });
        } else {
          // fallback: if no imageUrl present, try a conservative check by title+url
          try {
            exists = await col.findOne({ title: doc.title || null, articleUrl: doc.articleUrl || doc.url || null });
          } catch (e) {
            exists = null;
          }
        }

        if (exists) {
          console.log(`Skipped duplicate ${file} (matching imageUrl or title+url)`);
          // delete json and matching txt to keep directory clean
          try { fs.unlinkSync(full); } catch (e) { /* ignore */ }
          const txtFile = full.replace(/\.json$/i, '.txt');
          try { fs.unlinkSync(txtFile); } catch (e) { /* ignore */ }
          continue;
        }

        // attach imageUrl to the document (if available)
        if (imageUrl) doc.imageUrl = imageUrl;
        // insert as new document
        const res = await col.insertOne(doc);
        console.log(`Inserted ${file} -> _id=${res.insertedId}`);
        // delete json and corresponding txt (if exists)
        try { fs.unlinkSync(full); } catch (e) { /* ignore */ }
        const txtFile = full.replace(/\.json$/i, '.txt');
        try { fs.unlinkSync(txtFile); } catch (e) { /* ignore */ }
      } catch (err) {
        console.error('Failed to process', file, err.message || err);
      }
    }

  } finally {
    await client.close();
  }
}

if (require.main === module) {
  uploadAll().catch(err => {
    console.error('Upload failed', err);
    process.exitCode = 1;
  });
}
