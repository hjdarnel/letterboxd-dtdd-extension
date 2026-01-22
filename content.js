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

  function init() {
    if (inject()) {
      return;
    }

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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
