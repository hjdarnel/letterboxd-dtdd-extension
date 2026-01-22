/**
 * Letterboxd DTDD - Content Script
 * Injects a panel into Letterboxd film pages
 */

(function () {
  'use strict';

  const PANEL_ID = 'dtdd-panel';

  const PANEL_HTML = `
    <section id="dtdd-panel" class="dtdd-panel">
      <h3 class="dtdd-header">DTDD</h3>
      <div class="dtdd-content">
        <button class="dtdd-button" aria-label="DTDD Info">
          Info
          <span class="dtdd-tooltip">Letterboxd DTDD - More info coming soon!</span>
        </button>
      </div>
    </section>
  `;

  /**
   * Scrape IMDb and TMDB IDs from the sidebar links
   */
  function scrapeIds() {
    const links = document.querySelectorAll('.micro-button');
    let imdbId = null;
    let tmdbId = null;
    let isTv = false;

    for (const link of links) {
      const text = link.textContent?.trim();
      const href = link.href || '';

      if (text === 'IMDb') {
        const match = href.match(/imdb\.com\/title\/(tt\d+)/);
        if (match) {
          imdbId = match[1];
        }
      } else if (text === 'TMDB') {
        isTv = href.includes('/tv/');
        const match = href.match(/themoviedb\.org\/(?:tv|movie)\/(\d+)/);
        if (match) {
          tmdbId = match[1];
        }
      }
    }

    return { imdbId, tmdbId, isTv };
  }

  /**
   * Get film title and year from the page
   */
  function scrapeFilmInfo() {
    const title =
      document.querySelector('.headline-1 span')?.textContent?.trim() || null;
    const year =
      document.querySelector('.releasedate a')?.textContent?.trim() || null;
    const nativeTitle =
      document
        .querySelector('.originalname .quoted-creative-work-title')
        ?.textContent?.trim() || null;

    return { title, year, nativeTitle };
  }

  /**
   * Inject panel into page
   */
  function inject() {
    if (document.getElementById(PANEL_ID)) {
      return true;
    }

    const watchPanel = document.querySelector('.watch-panel');
    const insertPoint = watchPanel || document.querySelector('.poster-list');

    if (!insertPoint) {
      return false;
    }

    insertPoint.insertAdjacentHTML('afterend', PANEL_HTML);
    console.log('[DTDD] Panel injected');
    return true;
  }

  /**
   * Initialize extension
   */
  function init() {
    // Inject panel
    if (!inject()) {
      const observer = new MutationObserver((mutations, obs) => {
        if (inject()) {
          obs.disconnect();
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });

      setTimeout(() => {
        observer.disconnect();
      }, 10000);
    }

    // Log scraped data
    const ids = scrapeIds();
    const filmInfo = scrapeFilmInfo();
    console.log('[DTDD] Scraped IDs:', ids);
    console.log('[DTDD] Film info:', filmInfo);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
