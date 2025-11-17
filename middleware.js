// Vercel Edge Middleware (plain Web API) — avoid importing next/server so this compiles
// It detects crawler user agents and redirects them to the preview endpoint.

const CRAWLER_UAS = [
  /bot/i,
  /crawler/i,
  /spider/i,
  /facebookexternalhit/i,
  /twitterbot/i,
  /linkedinbot/i,
  /bingbot/i,
  /slurp/i
];

function isCrawler(ua){
  if(!ua) return false;
  return CRAWLER_UAS.some(rx => rx.test(ua));
}

export default async function middleware(req){
  try{
    const ua = req.headers.get('user-agent') || '';
    if(!isCrawler(ua)) return;

    const url = new URL(req.url);
    if(url.pathname === '/article.html' && (url.search || url.searchParams.get('title'))){
      // Build a safe query for the preview endpoint.
      let titleQuery = '';
      if(url.search){
        const raw = url.search.replace(/^\?/, '');
        if(raw.includes('=')){
          titleQuery = raw;
        } else {
          try{ const decoded = decodeURIComponent(raw); titleQuery = 'title=' + encodeURIComponent(decoded); }
          catch(e){ titleQuery = 'title=' + encodeURIComponent(raw); }
        }
      }

      // Proxy the preview API server-side and return its response to the crawler.
      const previewUrl = `${url.origin}/api/preview?${titleQuery}`;
      try{
        const previewRes = await fetch(previewUrl, { method: 'GET', headers: { 'User-Agent': ua } });
        // clone headers excluding hop-by-hop headers
        const resHeaders = new Headers(previewRes.headers);
        // Ensure content-type and cache-control are preserved; others fine to pass through
        const buf = await previewRes.arrayBuffer();
        return new Response(buf, { status: previewRes.status, headers: resHeaders });
      }catch(fetchErr){
        // if preview fetch fails, fall back to redirect (best-effort)
        const dest = `${url.origin}/api/preview?${titleQuery}`;
        return Response.redirect(dest, 307);
      }
    }
    // If request is for friendly /articles/:slug, proxy preview to crawlers too
    if(url.pathname.startsWith('/articles/')){
      const slug = url.pathname.replace(/^\/articles\//, '').replace(/\/+$/,'');
      if(slug){
        const previewUrl = `${url.origin}/api/preview?slug=${encodeURIComponent(slug)}`;
        try{
          const previewRes = await fetch(previewUrl, { method: 'GET', headers: { 'User-Agent': ua } });
          const resHeaders = new Headers(previewRes.headers);
          const buf = await previewRes.arrayBuffer();
          return new Response(buf, { status: previewRes.status, headers: resHeaders });
        }catch(err){
          // fall back to letting the route render the client app
        }
      }
    }
  }catch(e){ /* swallow errors to avoid breaking normal requests */ }
  // returning undefined lets the request continue to normal file handling
}

export const config = {
  matcher: ['/article.html', '/articles/:slug*']
};
