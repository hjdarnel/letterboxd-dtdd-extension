/**
 * Letterboxd DTDD - Settings Page Script
 * Handles loading and saving extension settings
 */

// =============================================================================
// CONFIGURATION - Modify these values to adjust settings page behavior
// =============================================================================

// Timing constants (milliseconds)
const API_KEY_SAVE_DEBOUNCE_MS = 500; // Delay before saving API key after typing stops
const STATUS_MESSAGE_DURATION_MS = 2500; // How long to show "Saved" status message

// =============================================================================
// INTERNAL CONSTANTS - Generally don't need modification
// =============================================================================

const STORAGE_KEYS = {
  API_KEY: 'dtdd-key',
  PINNED_TOPICS: 'dtdd-pinned-topics',
  MAX_WARNINGS: 'dtdd-max-warnings',
};

const DEFAULT_MAX_WARNINGS = 5;

const DTDD_CATEGORIES_API = 'https://www.doesthedogdie.com/categories';

let allTopics = [];

document.addEventListener('DOMContentLoaded', init);

async function init() {
  await loadSettings();
  await loadCategories();
  setupEventListeners();
}

async function loadSettings() {
  const data = await chrome.storage.sync.get(Object.values(STORAGE_KEYS));

  const apiKeyInput = document.getElementById('api-key');
  if (data[STORAGE_KEYS.API_KEY]) {
    apiKeyInput.value = data[STORAGE_KEYS.API_KEY];
  }

  const maxWarningsInput = document.getElementById('max-warnings');
  maxWarningsInput.value =
    data[STORAGE_KEYS.MAX_WARNINGS] ?? DEFAULT_MAX_WARNINGS;
}

async function loadCategories() {
  const topicsContainer = document.getElementById('topics-container');
  const topicsLoading = document.getElementById('topics-loading');
  const topicsError = document.getElementById('topics-error');
  const topicsSearch = document.getElementById('topics-search');

  try {
    const response = await fetchDtdd(DTDD_CATEGORIES_API);

    if (!response || !Array.isArray(response)) {
      throw new Error('Invalid response');
    }

    // Response is a flat array of topics with TopicCategory embedded
    allTopics = response.map((topic) => ({
      id: topic.id,
      name: topic.name,
      categoryName: topic.TopicCategory?.name || 'Uncategorized',
      keywords: topic.keywords || '',
    }));

    // Load pinned state from local storage
    const data = await chrome.storage.sync.get(STORAGE_KEYS.PINNED_TOPICS);
    const pinnedIds = new Set(data[STORAGE_KEYS.PINNED_TOPICS] || []);

    topicsLoading.style.display = 'none';
    topicsSearch.style.display = 'block';
    renderTopics(allTopics, pinnedIds);
  } catch (err) {
    console.error('[DTDD] Failed to load categories:', err);
    topicsLoading.style.display = 'none';
    topicsError.style.display = 'block';
  }
}

function renderTopics(topics, pinnedIds) {
  const topicsContainer = document.getElementById('topics-container');

  if (topics.length === 0) {
    topicsContainer.innerHTML =
      '<div class="topics-empty">No topics match your search</div>';
    return;
  }

  // Sort: pinned first, then by category, then by id
  const sorted = [...topics].sort((a, b) => {
    const aPinned = pinnedIds.has(a.id);
    const bPinned = pinnedIds.has(b.id);
    if (aPinned !== bPinned) return bPinned - aPinned;
    const categoryCompare = a.categoryName.localeCompare(b.categoryName);
    if (categoryCompare !== 0) return categoryCompare;
    return a.id - b.id;
  });

  topicsContainer.innerHTML = sorted
    .map((topic) => {
      const isPinned = pinnedIds.has(topic.id);
      return `
      <label class="topic-item ${isPinned ? 'pinned' : ''}" data-topic-id="${topic.id}">
        <input type="checkbox" ${isPinned ? 'checked' : ''}>
        <span class="topic-name">${escapeHtml(topic.name.toLowerCase())}</span>
        <span class="topic-category">${escapeHtml(topic.categoryName)}</span>
      </label>
    `;
    })
    .join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function fetchDtdd(url) {
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
      resolve(response?.data || null);
    });
  });
}

function setupEventListeners() {
  const apiKeyInput = document.getElementById('api-key');
  apiKeyInput.addEventListener('input', handleApiKeyChange);

  const maxWarningsInput = document.getElementById('max-warnings');
  maxWarningsInput.addEventListener('input', handleMaxWarningsChange);

  const topicsSearch = document.getElementById('topics-search');
  topicsSearch.addEventListener('input', handleSearch);

  const topicsContainer = document.getElementById('topics-container');
  topicsContainer.addEventListener('change', handleTopicToggle);
}

async function handleSearch(event) {
  const query = event.target.value.toLowerCase().trim();

  const data = await chrome.storage.sync.get(STORAGE_KEYS.PINNED_TOPICS);
  const pinnedIds = new Set(data[STORAGE_KEYS.PINNED_TOPICS] || []);

  const filtered = query
    ? allTopics.filter(
        (t) =>
          t.name.toLowerCase().includes(query) ||
          t.categoryName.toLowerCase().includes(query) ||
          t.keywords.toLowerCase().includes(query),
      )
    : allTopics;

  renderTopics(filtered, pinnedIds);
}

let apiKeySaveTimeout = null;

async function handleApiKeyChange(event) {
  const apiKey = event.target.value.trim();

  // Debounce saves to avoid excessive writes
  if (apiKeySaveTimeout) {
    clearTimeout(apiKeySaveTimeout);
  }

  apiKeySaveTimeout = setTimeout(async () => {
    await chrome.storage.sync.set({
      [STORAGE_KEYS.API_KEY]: apiKey,
    });
    showStatus('Saved');
  }, API_KEY_SAVE_DEBOUNCE_MS);
}

let maxWarningsSaveTimeout = null;

async function handleMaxWarningsChange(event) {
  const value = parseInt(event.target.value, 10);

  // Validate: must be a positive integer
  if (isNaN(value) || value < 1) return;

  // Debounce saves to avoid excessive writes
  if (maxWarningsSaveTimeout) {
    clearTimeout(maxWarningsSaveTimeout);
  }

  maxWarningsSaveTimeout = setTimeout(async () => {
    await chrome.storage.sync.set({
      [STORAGE_KEYS.MAX_WARNINGS]: value,
    });
    showStatus('Saved');
  }, API_KEY_SAVE_DEBOUNCE_MS);
}

async function handleTopicToggle(event) {
  if (event.target.type !== 'checkbox') return;

  const topicItem = event.target.closest('.topic-item');
  const topicId = parseInt(topicItem.dataset.topicId, 10);
  const isPinned = event.target.checked;

  const data = await chrome.storage.sync.get(STORAGE_KEYS.PINNED_TOPICS);
  const pinnedIds = new Set(data[STORAGE_KEYS.PINNED_TOPICS] || []);

  if (isPinned) {
    pinnedIds.add(topicId);
    topicItem.classList.add('pinned');
  } else {
    pinnedIds.delete(topicId);
    topicItem.classList.remove('pinned');
  }

  await chrome.storage.sync.set({
    [STORAGE_KEYS.PINNED_TOPICS]: [...pinnedIds],
  });
}

function showStatus(message, isError = false) {
  const status = document.getElementById('save-status');
  status.textContent = message;
  status.classList.toggle('error', isError);
  status.classList.add('visible');

  setTimeout(() => {
    status.classList.remove('visible');
  }, STATUS_MESSAGE_DURATION_MS);
}
