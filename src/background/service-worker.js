"use strict";

const STORAGE_KEYS = ["presets", "settings", "lastBatch"];

const DEFAULT_SETTINGS = {
  delayMs: 4000,
  maxConcurrent: 3,
  rating: "iiiN",
  autoDeriveWorkspace: true
};

const DEFAULT_PRESETS = [
  {
    id: "seed-qhvy",
    name: "QH Vibe",
    styleCode: "qhvy",
    stylePrompt: "",
    workspaceOverride: "",
    instrumental: false
  }
];

async function seedDefaults() {
  const current = await chrome.storage.local.get(STORAGE_KEYS);
  const patch = {};
  if (!Array.isArray(current.presets)) patch.presets = DEFAULT_PRESETS;
  if (!current.settings || typeof current.settings !== "object") {
    patch.settings = DEFAULT_SETTINGS;
  } else {
    patch.settings = Object.assign({}, DEFAULT_SETTINGS, current.settings);
  }
  await chrome.storage.local.set(patch);
}

async function enablePanelOnActionClick() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.warn("[SunoGen] setPanelBehavior failed", err);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  seedDefaults();
  enablePanelOnActionClick();
});

chrome.runtime.onStartup.addListener(() => {
  enablePanelOnActionClick();
});

/**
 * Relay a message from a content script to the side panel (and vice versa is
 * handled directly by the panel). Kept here so future work has a single place
 * to fan out notifications.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  if (msg.type === "SUNOGEN_GET_TAB") {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs) => sendResponse({ ok: true, tab: tabs[0] || null }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  return false;
});
