const path = require('path');
const { scrapeAndSave } = require('./index');
const { exec } = require('child_process');
const fs = require('fs');

// Runner will call the scraper, then call upload.js via node to perform upload and cleanup.
// It runs once immediately, then repeats every INTERVAL_MINUTES (default 60).

const INTERVAL_MINUTES = parseInt(process.env.INTERVAL_MINUTES, 10) || 60;
const UPLOAD_SCRIPT = path.join(__dirname, 'upload.js');

async function runOnce() {
  console.log(new Date().toISOString(), 'Starting scrape');
  try {
    await scrapeAndSave();
    console.log(new Date().toISOString(), 'Scrape complete, launching uploader');

    // run node upload.js in a child process so uploader runs in same project context
    exec(`node "${UPLOAD_SCRIPT}"`, { cwd: __dirname }, (err, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (err) console.error('Uploader failed:', err && err.message);
      else console.log(new Date().toISOString(), 'Uploader finished');
    });
  } catch (err) {
    console.error('Runner caught error during scrape:', err && err.message);
  }
}

let timer = null;

async function start() {
  await runOnce();
  timer = setInterval(() => {
    runOnce().catch(e => console.error('Scheduled run error:', e && e.message));
  }, INTERVAL_MINUTES * 60 * 1000);
  console.log(`Scheduled to run every ${INTERVAL_MINUTES} minute(s).`);
}

function stop() {
  if (timer) clearInterval(timer);
  console.log('Runner stopping.');
  process.exit(0);
}

process.on('SIGINT', () => {
  console.log('Received SIGINT');
  stop();
});
process.on('SIGTERM', () => {
  console.log('Received SIGTERM');
  stop();
});

if (require.main === module) start();

module.exports = { start, stop };
