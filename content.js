/**
 * Letterboxd DTDD Integration - Content Script
 * Injects a panel into Letterboxd film pages and fetches Does The Dog Die data
 */

(function () {
  'use strict';

  // =============================================================================
  // CONFIGURATION - Modify these values to adjust extension behavior
  // =============================================================================

  // Vote thresholds and categorization
  const MIN_VOTES_FOR_CONFIDENCE = 3; // Minimum votes required before we trust any result
  const MIN_VOTES_FOR_SENSITIVE = 1; // Lower threshold for sensitive topics (animal death, SA, etc.)

  // Wilson Score configuration
  const WILSON_Z_SCORE = 1.645; // 90% confidence (use 1.96 for 95%)
  const WILSON_CONFIDENCE_THRESHOLD = 0.5; // 50% - majority threshold

  // Warning category values (returned by categorizeWarning)
  const WARNING_CATEGORY = {
    YES: 'yes', // Confident or raw majority yes
    NO: 'no', // Confident or raw majority no
    MIXED: 'mixed', // Equal yes and no votes
    UNKNOWN: 'unknown', // Not enough votes to determine
  };

  // Sort order for warning categories (lower = higher priority in list)
  // Sensitive topics get a bonus (-10) to appear first
  const WARNING_SORT_ORDER = {
    [WARNING_CATEGORY.YES]: 0,
    [WARNING_CATEGORY.NO]: 1,
    [WARNING_CATEGORY.MIXED]: 2,
    [WARNING_CATEGORY.UNKNOWN]: 2,
  };
  const SENSITIVE_SORT_BONUS = -10; // Subtracted from sort order for sensitive topics

  // =============================================================================
  // INTERNAL CONSTANTS - Generally don't need modification
  // =============================================================================

  const PANEL_ID = 'dtdd-panel';
  const DTDD_SEARCH_API = 'https://www.doesthedogdie.com/dddsearch';
  const DTDD_MEDIA_API = 'https://www.doesthedogdie.com/media';
  const DTDD_BASE_URL = 'https://www.doesthedogdie.com';
  const STORAGE_KEY_PINNED = 'dtdd-pinned-topics';
  const STORAGE_KEY_MAX_WARNINGS = 'dtdd-max-warnings';
  const DEFAULT_MAX_WARNINGS = 5;
  const PANEL_INSERT_SELECTOR = 'aside.sidebar';

  function log(...args) {
    console.debug('[DTDD]', ...args);
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
   * Calculate Wilson Score confidence interval bounds
   * Returns { lower, upper } representing the confidence interval for the true "yes" proportion
   *
   * @see https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval#Wilson_score_interval
   */
  function wilsonScore(yesCount, totalCount) {
    if (totalCount === 0) return { lower: 0, upper: 0 };

    const z = WILSON_Z_SCORE;
    const p = yesCount / totalCount;
    const n = totalCount;

    const denominator = 1 + (z * z) / n;
    const center = p + (z * z) / (2 * n);
    const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);

    const lower = (center - spread) / denominator;
    const upper = (center + spread) / denominator;

    return {
      lower: Math.max(0, lower),
      upper: Math.min(1, upper),
    };
  }

  /**
   * Categorize a topic stat using Wilson Score confidence intervals
   *
   * Logic:
   * 1. If total votes < minimum threshold → unknown (threshold is lower for sensitive topics)
   * 2. If Wilson lower bound > 50% → confident yes
   * 3. If Wilson upper bound < 50% → confident no
   * 4. Otherwise fall back to raw majority (yesSum vs noSum)
   * 5. If exactly equal → mixed
   */
  function categorizeWarning(stat) {
    const { yesSum, noSum } = stat;
    const totalVotes = yesSum + noSum;
    const isSensitive = stat.topic?.isSensitive ?? false;
    const topicName =
      stat.topic?.doesName || stat.topic?.name || 'unknown topic';

    // Use lower threshold for sensitive topics
    const minVotes = isSensitive
      ? MIN_VOTES_FOR_SENSITIVE
      : MIN_VOTES_FOR_CONFIDENCE;

    // Not enough data
    if (totalVotes < minVotes) {
      log(
        `"${topicName}" -> ${WARNING_CATEGORY.UNKNOWN} (${totalVotes} votes < ${minVotes} minimum${isSensitive ? ', sensitive' : ''})`,
      );
      return WARNING_CATEGORY.UNKNOWN;
    }

    const { lower, upper } = wilsonScore(yesSum, totalVotes);

    let result;
    let reason;

    if (lower > WILSON_CONFIDENCE_THRESHOLD) {
      // Statistically confident majority yes
      result = WARNING_CATEGORY.YES;
      reason = `wilson lower ${(lower * 100).toFixed(0)}% > 50%`;
    } else if (upper < WILSON_CONFIDENCE_THRESHOLD) {
      // Statistically confident majority no
      result = WARNING_CATEGORY.NO;
      reason = `wilson upper ${(upper * 100).toFixed(0)}% < 50%`;
    } else if (yesSum > noSum) {
      // Uncertain but leans yes
      result = WARNING_CATEGORY.YES;
      reason = `raw majority (${yesSum} > ${noSum})`;
    } else if (noSum > yesSum) {
      // Uncertain but leans no
      result = WARNING_CATEGORY.NO;
      reason = `raw majority (${noSum} > ${yesSum})`;
    } else {
      // Exactly split
      result = WARNING_CATEGORY.MIXED;
      reason = 'equal votes';
    }

    log(
      `"${topicName}" -> ${result} (yes: ${yesSum}, no: ${noSum}, ${reason}${isSensitive ? ', sensitive' : ''})`,
    );
    return result;
  }

  /**
   * Get sort order for a topic stat (lower = higher priority)
   * Sensitive topics get a bonus to appear first
   */
  function getWarningSortOrder(stat) {
    const category = categorizeWarning(stat);
    const isSensitive = stat.topic?.isSensitive ?? false;
    const baseOrder = WARNING_SORT_ORDER[category] ?? 2;
    return isSensitive ? baseOrder + SENSITIVE_SORT_BONUS : baseOrder;
  }

  /**
   * Build the panel HTML with warnings
   */
  function buildPanelHtml(
    state,
    data = null,
    pinnedIds = new Set(),
    maxWarnings = DEFAULT_MAX_WARNINGS,
  ) {
    const headerDtddUrl = data?.mediaId
      ? `${DTDD_BASE_URL}/media/${data.mediaId}`
      : null;
    const headerText = headerDtddUrl
      ? `<a href="${headerDtddUrl}" target="_blank" rel="noopener noreferrer" title="View all on Does The Dog Die">Content Warnings</a>`
      : 'Content Warnings';
    const header = `<h3 class="dtdd-header">${headerText} <button class="dtdd-settings-btn" title="Settings">⚙</button></h3>`;

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
    const { topics } = data;

    // Separate pinned topics (always show) from regular topics
    // Sort by: sensitive first, then warning category (yes → no → mixed), then by yes votes
    const pinnedTopics = topics
      .filter((t) => pinnedIds.has(t.topic?.id))
      .sort((a, b) => {
        const aOrder = getWarningSortOrder(a);
        const bOrder = getWarningSortOrder(b);
        if (aOrder !== bOrder) return aOrder - bOrder;
        return b.yesSum - a.yesSum;
      });

    // Regular yes topics (not pinned, has enough votes)
    // Sensitive topics are boosted to appear first
    const yesTopics = topics
      .filter(
        (t) =>
          !pinnedIds.has(t.topic?.id) &&
          categorizeWarning(t) === WARNING_CATEGORY.YES,
      )
      .sort((a, b) => {
        // Sensitive topics first, then by yes votes
        const aSensitive = a.topic?.isSensitive ?? false;
        const bSensitive = b.topic?.isSensitive ?? false;
        if (aSensitive !== bSensitive) return bSensitive - aSensitive;
        return b.yesSum - a.yesSum;
      })
      .slice(0, maxWarnings);

    const hasWarnings = pinnedTopics.length > 0 || yesTopics.length > 0;

    let warningsHtml = '';

    if (hasWarnings) {
      // Render pinned items with a separator class on the last one
      const pinnedHtml = pinnedTopics
        .map((t, i) => {
          const category = categorizeWarning(t);
          const statusClass =
            category === WARNING_CATEGORY.NO
              ? 'dtdd-status-no'
              : category === WARNING_CATEGORY.UNKNOWN
                ? 'dtdd-status-unknown'
                : '';
          const tooltipAttr = t.comment
            ? `data-tooltip="${escapeHtml(t.comment)}"`
            : '';
          const isLastPinned =
            i === pinnedTopics.length - 1 && yesTopics.length > 0;
          const separatorClass = isLastPinned ? 'dtdd-pinned-last' : '';
          return `<li class="dtdd-warning-item ${statusClass} ${separatorClass}" ${tooltipAttr}><span class="dtdd-votes"><span class="dtdd-yes-count">${t.yesSum}</span>/<span class="dtdd-no-count">${t.noSum}</span></span> ${escapeHtml(t.topic.name.toLowerCase())}</li>`;
        })
        .join('');

      const yesHtml = yesTopics
        .map((t) => {
          const tooltipAttr = t.comment
            ? `data-tooltip="${escapeHtml(t.comment)}"`
            : '';
          return `<li class="dtdd-warning-item dtdd-warning-main" ${tooltipAttr}><span class="dtdd-votes"><span class="dtdd-yes-count">${t.yesSum}</span>/<span class="dtdd-no-count">${t.noSum}</span></span> ${escapeHtml(t.topic.name.toLowerCase())}</li>`;
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

    const insertPoint = document.querySelector(PANEL_INSERT_SELECTOR);

    if (!insertPoint) return false;

    insertPoint.insertAdjacentHTML('beforeend', html);
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
      setTimeout(() => observer.disconnect(), 10_000);
      return;
    }

    await loadData();
  }

  async function loadData() {
    try {
      // Load settings from storage
      const storageData = await chrome.storage.sync.get([
        STORAGE_KEY_PINNED,
        STORAGE_KEY_MAX_WARNINGS,
      ]);
      const pinnedIds = new Set(storageData[STORAGE_KEY_PINNED] || []);
      const maxWarnings =
        storageData[STORAGE_KEY_MAX_WARNINGS] ?? DEFAULT_MAX_WARNINGS;

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
      log('Max warnings to display:', maxWarnings);

      injectPanel(
        buildPanelHtml(
          'loaded',
          {
            mediaId: media.id,
            topics: details.topicItemStats,
          },
          pinnedIds,
          maxWarnings,
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
