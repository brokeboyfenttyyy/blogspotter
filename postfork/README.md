# Houston Article Scraper

This is a tiny Node.js script that, when run, will pick one article from a set of Houston news listing pages and save it as a text file inside the `articles/` folder.

Setup

1. Install dependencies:

```powershell
npm install
```

2. Run the scraper:

```powershell
npm start
```

Notes

- The scraper uses heuristics and may not always extract clean article text for every site. It prefers elements like `<article>` or common article body classes.
- If `articles/` doesn't exist, it will be created automatically.
- If a site blocks automated requests, consider running the script occasionally or adding delays.

License: MIT
