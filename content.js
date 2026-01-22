/**
 * Letterboxd DTDD - Content Script
 * Injects a panel into Letterboxd film pages and fetches DTDD data
 */

(function () {
  'use strict';

  const PANEL_ID = 'dtdd-panel';
  const DTDD_SEARCH_API = 'https://www.doesthedogdie.com/dddsearch';
  const DTDD_MEDIA_API = 'https://www.doesthedogdie.com/media';
  const DTDD_BASE_URL = 'https://www.doesthedogdie.com';
  const DEBUG = true;
  const STORAGE_KEY_PINNED = 'dtdd-pinned-topics';
  const PANEL_INSERT_SELECTOR = '.watch-panel';
  const PANEL_INSERT_FALLBACK_SELECTOR = '.poster-list';

  function log(...args) {
    if (DEBUG) console.log('[DTDD]', ...args);
  }

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
        if (match) imdbId = match[1];
      } else if (text === 'TMDB') {
        isTv = href.includes('/tv/');
        const match = href.match(/themoviedb\.org\/(?:tv|movie)\/(\d+)/);
        if (match) tmdbId = match[1];
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
   * Send message to background script to fetch from DTDD API
   */
  function fetchDtdd(url) {
    log('Fetching:', url);
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ name: 'DTDD_FETCH', url }, (response) => {
        if (chrome.runtime.lastError) {
          console.error(
            '[DTDD] Message error:',
            chrome.runtime.lastError.message,
          );
          resolve(null);
          return;
        }
        if (response?.error) {
          console.error('[DTDD] API error:', response.error);
          resolve(null);
          return;
        }
        log('Response:', response?.data);
        resolve(response?.data || null);
      });
    });
  }

  /**
   * Match DTDD search results by TMDB ID, then by name+year
   */
  function matchDtddResult(result, tmdbId, title, year, isTv) {
    if (!result?.items?.length) return null;

    const expectedType = isTv ? 'TV Show' : 'Movie';

    for (const item of result.items) {
      const itemType = item.itemType?.name;

      // Filter by type
      if (itemType && itemType !== expectedType) continue;

      // Exact TMDB match
      if (tmdbId && item.tmdbId === parseInt(tmdbId)) return item;

      // Skip if item has different TMDB ID
      if (item.tmdbId && tmdbId && item.tmdbId !== parseInt(tmdbId)) continue;

      // Match by name and year
      const nameMatches =
        item.name === title || item.name === `${title} ${year}`;
      const yearMatches = String(item.releaseYear) === String(year);

      if (nameMatches && yearMatches) return item;
    }

    return null;
  }

  /**
   * Find DTDD media using 3-tier fallback
   */
  async function findDtddMedia() {
    const { imdbId, tmdbId, isTv } = scrapeIds();
    const { title, year, nativeTitle } = scrapeFilmInfo();

    log('Scraped IDs:', { imdbId, tmdbId, isTv });
    log('Film info:', { title, year, nativeTitle });

    let dtddData = null;

    // Tier 1: Search by IMDb ID
    if (imdbId) {
      const result = await fetchDtdd(`${DTDD_SEARCH_API}?imdb=${imdbId}`);
      if (result?.items?.length > 0) {
        const item = result.items[0];
        if (!tmdbId || !item.tmdbId || item.tmdbId === parseInt(tmdbId)) {
          dtddData = item;
          log('Found via IMDb ID');
        }
      }
    }

    // Tier 2: Search by title
    if (!dtddData && title) {
      const result = await fetchDtdd(
        `${DTDD_SEARCH_API}?q=${encodeURIComponent(title)}`,
      );
      dtddData = matchDtddResult(result, tmdbId, title, year, isTv);
      if (dtddData) log('Found via title search');
    }

    // Tier 3: Search by native title
    if (!dtddData && nativeTitle) {
      const result = await fetchDtdd(
        `${DTDD_SEARCH_API}?q=${encodeURIComponent(nativeTitle)}`,
      );
      dtddData = matchDtddResult(result, tmdbId, nativeTitle, year, isTv);
      if (dtddData) log('Found via native title search');
    }

    return dtddData;
  }

  /**
   * Fetch full media details including topic warnings
   */
  async function fetchMediaDetails(mediaId) {
    const result = await fetchDtdd(`${DTDD_MEDIA_API}/${mediaId}`);
    return result;
  }

  /**
   * Categorize a topic stat as yes/no/unknown
   * Requires minimum vote threshold for confidence
   */
  const MIN_VOTES_THRESHOLD = 5;

  function categorizeWarning(stat) {
    const { yesSum, noSum } = stat;
    const totalVotes = yesSum + noSum;
    const topicName = stat.topic?.doesName || 'unknown topic';

    // Not enough data to be confident
    if (totalVotes < MIN_VOTES_THRESHOLD) {
      log(
        `"${topicName}" -> unknown (${totalVotes} votes < ${MIN_VOTES_THRESHOLD} threshold)`,
      );
      return 'unknown';
    }

    let result;
    if (yesSum > noSum) result = 'yes';
    else if (noSum > yesSum) result = 'no';
    else result = 'mixed';

    log(`"${topicName}" -> ${result} (yes: ${yesSum}, no: ${noSum})`);
    return result;
  }

  /**
   * Build the panel HTML with warnings
   */
  function buildPanelHtml(state, data = null, pinnedIds = new Set()) {
    const header = `<h3 class="dtdd-header">Content Warnings <button class="dtdd-settings-btn" title="Settings">⚙</button></h3>`;

    if (state === 'loading') {
      return `
        <section id="${PANEL_ID}" class="dtdd-panel">
          ${header}
          <div class="dtdd-content">
            <div class="dtdd-loading">Loading warnings...</div>
          </div>
        </section>
      `;
    }

    if (state === 'error') {
      return `
        <section id="${PANEL_ID}" class="dtdd-panel">
          ${header}
          <div class="dtdd-content">
            <div class="dtdd-error">Failed to load warnings</div>
          </div>
        </section>
      `;
    }

    if (state === 'not-found') {
      return `
        <section id="${PANEL_ID}" class="dtdd-panel">
          ${header}
          <div class="dtdd-content">
            <div class="dtdd-not-found">No warnings available for this title</div>
          </div>
        </section>
      `;
    }

    // state === 'loaded'
    const { mediaId, topics } = data;
    const dtddUrl = `${DTDD_BASE_URL}/media/${mediaId}`;

    // Separate pinned topics (always show) from regular topics
    // Sort order for warning categories: yes=0, no=1, maybe/unknown/mixed=2
    const warningOrder = { yes: 0, no: 1, mixed: 2, unknown: 2 };
    const pinnedTopics = topics
      .filter((t) => pinnedIds.has(t.topic?.id))
      .sort((a, b) => {
        // Sort by warning status (yes → no → maybe), then by yes votes
        const aCategory = categorizeWarning(a);
        const bCategory = categorizeWarning(b);
        const aOrder = warningOrder[aCategory] ?? 2;
        const bOrder = warningOrder[bCategory] ?? 2;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return b.yesSum - a.yesSum;
      });

    // Regular yes topics (not pinned, has enough votes)
    const yesTopics = topics
      .filter(
        (t) => !pinnedIds.has(t.topic?.id) && categorizeWarning(t) === 'yes',
      )
      .sort((a, b) => b.yesSum - a.yesSum)
      .slice(0, 10);

    const hasWarnings = pinnedTopics.length > 0 || yesTopics.length > 0;

    let warningsHtml = '';

    if (hasWarnings) {
      // Render pinned items with a separator class on the last one
      const pinnedHtml = pinnedTopics
        .map((t, i) => {
          const category = categorizeWarning(t);
          const statusClass =
            category === 'no'
              ? 'dtdd-status-no'
              : category === 'unknown'
                ? 'dtdd-status-unknown'
                : '';
          const tooltipAttr = t.comment
            ? `data-tooltip="${escapeHtml(t.comment)}"`
            : '';
          const isLastPinned =
            i === pinnedTopics.length - 1 && yesTopics.length > 0;
          const separatorClass = isLastPinned ? 'dtdd-pinned-last' : '';
          return `<li class="dtdd-warning-item ${statusClass} ${separatorClass}" ${tooltipAttr}><span class="dtdd-votes"><span class="dtdd-yes-count">${t.yesSum}</span>/<span class="dtdd-no-count">${t.noSum}</span></span> ${escapeHtml(t.topic.name)}</li>`;
        })
        .join('');

      const yesHtml = yesTopics
        .map((t) => {
          const tooltipAttr = t.comment
            ? `data-tooltip="${escapeHtml(t.comment)}"`
            : '';
          return `<li class="dtdd-warning-item" ${tooltipAttr}><span class="dtdd-votes"><span class="dtdd-yes-count">${t.yesSum}</span>/<span class="dtdd-no-count">${t.noSum}</span></span> ${escapeHtml(t.topic.name)}</li>`;
        })
        .join('');

      warningsHtml = `
        <div class="dtdd-warning-group dtdd-warning-yes">
          <ul class="dtdd-warning-list">
            ${pinnedHtml}${yesHtml}
          </ul>
        </div>
      `;
    } else {
      warningsHtml = `<div class="dtdd-not-found">No significant warnings reported</div>`;
    }

    return `
      <section id="${PANEL_ID}" class="dtdd-panel">
        ${header}
        <div class="dtdd-content">
          ${warningsHtml}
          <a href="${dtddUrl}" target="_blank" rel="noopener noreferrer" class="dtdd-link">
            View all on DoesTheDogDie
          </a>
        </div>
      </section>
    `;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Inject or update panel in page
   */
  function injectPanel(html) {
    const existing = document.getElementById(PANEL_ID);
    if (existing) {
      existing.outerHTML = html;
      attachSettingsHandler();
      return true;
    }

    const insertPoint =
      document.querySelector(PANEL_INSERT_SELECTOR) ||
      document.querySelector(PANEL_INSERT_FALLBACK_SELECTOR);

    if (!insertPoint) return false;

    insertPoint.insertAdjacentHTML('afterend', html);
    attachSettingsHandler();
    log('Panel injected');
    return true;
  }

  /**
   * Attach click handler to settings button
   */
  function attachSettingsHandler() {
    const btn = document.querySelector('.dtdd-settings-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ name: 'OPEN_OPTIONS' });
      });
    }
  }

  /**
   * Initialize extension
   */
  async function init() {
    // Inject loading state first
    const loadingHtml = buildPanelHtml('loading');
    if (!injectPanel(loadingHtml)) {
      // Wait for DOM with MutationObserver
      const observer = new MutationObserver((mutations, obs) => {
        if (injectPanel(loadingHtml)) {
          obs.disconnect();
          loadData();
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => observer.disconnect(), 10000);
      return;
    }

    await loadData();
  }

  async function loadData() {
    try {
      // Load pinned topics from storage
      const storageData = await chrome.storage.sync.get(STORAGE_KEY_PINNED);
      const pinnedIds = new Set(storageData[STORAGE_KEY_PINNED] || []);

      const media = await findDtddMedia();

      if (!media) {
        injectPanel(buildPanelHtml('not-found'));
        return;
      }

      log('Found media:', media.id, media.name);

      const details = await fetchMediaDetails(media.id);

      if (!details?.topicItemStats) {
        injectPanel(buildPanelHtml('not-found'));
        return;
      }

      log('Loaded', details.topicItemStats.length, 'topics');
      log('Pinned topic IDs:', [...pinnedIds]);

      injectPanel(
        buildPanelHtml(
          'loaded',
          {
            mediaId: media.id,
            topics: details.topicItemStats,
          },
          pinnedIds,
        ),
      );
    } catch (err) {
      console.error('[DTDD] Error loading data:', err);
      injectPanel(buildPanelHtml('error'));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
