import { MessageSchema } from "../utils/types";

// Currently Gemini for Chrome is not available in all regions :(
const alreadyAnnounced = new Set<string>();

function getCacheKey(oldTitle: string, newTitle: string): string {
  // Readable format: currSongName::NextSongName
  // We can add time if needed, but for intro caching, the pair is usually sufficient.
  // User asked for {currSongName::NextSongName::Time}, but Time varies per generation request (current time).
  // If we cache by Time, we might never hit cache.
  // Let's stick to the pair, but make it readable.
  return `rj_intro_${oldTitle}::${newTitle}`;
}

export async function generateRJIntro(
  oldSongTitle: string,
  oldArtist: string,
  newSongTitle: string,
  newArtist: string,
  currentTime?: string,
  allowGeneration: boolean = true,
): Promise<string> {
  const key = getCacheKey(oldSongTitle, newSongTitle);

  // 1. Get Text (Cache or Generate)
  let textToSpeak: string | null = null;
  let didGenerate = false;

  // Check session storage first
  const storageResult = await chrome.storage.session.get(key);
  if (storageResult[key]) {
    console.log(
      `[Cache Hit] Using pre-generated intro for ${key} from storage`,
    );
    textToSpeak = storageResult[key];
  } else {
    if (!allowGeneration) {
      console.log(
        `[Cache Miss] Generation disallowed. Using fallback for ${newSongTitle}`,
      );
      return `This is: ${newSongTitle} by ${newArtist}`;
    }

    console.log(`[Cache Miss] Generating new intro for ${key}`);
    try {
      // @ts-ignore
      if (!(await chrome.offscreen.hasDocument())) {
        await chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: [chrome.offscreen.Reason.DOM_PARSER],
          justification: "To use local AI models",
        });
      }

      const settings = await chrome.storage.sync.get([
        "modelProvider",
        "geminiApiKey",
        "localServerPort",
      ]);
      const modelProvider = settings.modelProvider || "gemini-api";
      const geminiApiKey = settings.geminiApiKey || "";
      const localServerPort = settings.localServerPort || 8008;

      textToSpeak = await chrome.runtime.sendMessage({
        type: "GENERATE_RJ",
        payload: {
          oldSongTitle,
          oldArtist,
          newSongTitle,
          newArtist,
          useWebLLM: modelProvider === "webllm",
          modelProvider,
          geminiApiKey,
          localServerPort,
          currentTime,
        },
      });

      if (textToSpeak) {
        await chrome.storage.session.set({ [key]: textToSpeak });
        didGenerate = true;
      }
    } catch (err) {
      console.error("RJ Model failed:", err);
      // Don't return here, let it fall through or handle quietly?
      // If failed, we likely have no text.
      return `and this is ${newSongTitle} by ${newArtist}`;
    }
  }

  if (!textToSpeak)
    return `And this is ${newSongTitle} by ${newArtist}`;

  // 2. Trigger Preload (Unless we just failed to generate OR we are just playing)
  // If we are "allowing generation", it usually means we are pre-warming.
  // If we are NOT allowing generation (i.e., just playing), we probably shouldn't trigger preload logic recursively?
  // Actually, if we got a cache hit, the AUDIO might implicitly trigger?
  // Wait, audio preload is separate.

  // If allowGeneration is true (Prewarm), we definitely want to Preload Audio.
  if (allowGeneration) {
    const settings = await chrome.storage.sync.get([
      "speechProvider",
      "localServerPort",
      "geminiApiKey",
    ]);
    const speechProvider = settings.speechProvider || "gemini-api";
    const localServerPort = settings.localServerPort || 8008;
    const geminiApiKey = settings.geminiApiKey || "";

    if (
      speechProvider === "localserver" ||
      speechProvider === "gemini-api" ||
      speechProvider === "kokoro"
    ) {
      console.log(
        `[Preload] Triggering Audio Preload for: ${speechProvider} (Generated: ${didGenerate})`,
      );

      // Ensure offscreen exists (might be needed if cache hit but offscreen died)
      // @ts-ignore
      if (!(await chrome.offscreen.hasDocument())) {
        await chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: [chrome.offscreen.Reason.DOM_PARSER],
          justification: "To use local AI models",
        });
      }

      chrome.runtime.sendMessage({
        type: "PRELOAD_AUDIO",
        payload: {
          localServerPort,
          textToSpeak: textToSpeak,
          speechProvider,
          geminiApiKey,
        },
      });
    }
  }

  return textToSpeak;
}

chrome.runtime.onMessage.addListener(
  (message: MessageSchema, sender, sendResponse) => {
    if (message.type === "SONG_ABOUT_TO_END" && sender.tab?.id) {
      const {
        currentSongTitle,
        currentSongArtist,
        upcomingSongTitle,
        upcomingSongArtist,
      } = message.payload;
      // Pass currentTime here as well in case cache missed and we need it now
      const currentTime = new Date().toLocaleTimeString([], {
        weekday: "long",
        hour: "2-digit",
        minute: "2-digit",
      });
      // Immediately acknowledge message to prevent port collecting error on Content Script side
      sendResponse({ received: true });

      announceSong(
        sender.tab.id,
        currentSongTitle,
        currentSongArtist,
        upcomingSongTitle,
        upcomingSongArtist,
        currentTime,
      );
    } else if (message.type === "PREWARM_RJ") {
      const { oldSongTitle, oldArtist, newSongTitle, newArtist, currentTime } =
        message.payload;
      console.log(
        `[Pre-Warm] Received request for ${oldSongTitle} -> ${newSongTitle}`,
      );
      generateRJIntro(
        oldSongTitle,
        oldArtist,
        newSongTitle,
        newArtist,
        currentTime,
      );
    } else if (message.type === "OFFSCREEN_TO_CONTENT_PROXY") {
      const { tabId, message: nestedMessage } = message.payload;
      chrome.tabs.sendMessage(tabId, nestedMessage, (response) => {
        sendResponse(response);
      });
      return true; // Keep channel open for async response
    } else if (message.type === "TTS_STARTED") {
      // Forward to all YTM tabs (or at least the active one)
      // Since offscreen doesn't know tabId easily here (it's in payload but message doesn't have it at top level always)
      // Actually playAudio payload has tabId, but TTS_STARTED from offscreen might simpler global broadcast?
      // Or we can query tabs.
      chrome.tabs.query({ url: "*://music.youtube.com/*" }, (tabs) => {
        for (const tab of tabs) {
          if (tab.id) chrome.tabs.sendMessage(tab.id, { type: "TTS_STARTED" });
        }
      });
    }
  },
);

function announceSong(
  tabId: number,
  currentSongTitle: string,
  currentSongArtist: string,
  upcomingSongTitle: string,
  upcomingSongArtist: string,
  currentTime: string,
) {
  if (alreadyAnnounced.has(`${currentSongTitle}:::${upcomingSongTitle}`)) {
    console.log(
      `[Skip] Already announced ${currentSongTitle} -> ${upcomingSongTitle}`,
    );
    chrome.tabs.sendMessage(tabId, { type: "TTS_ENDED" });
    return;
  }

  generateRJIntro(
    currentSongTitle,
    currentSongArtist,
    upcomingSongTitle,
    upcomingSongArtist,
    currentTime,
    false,
  ).then(async (response: string) => {
    console.log("Generated Intro:", response);
    alreadyAnnounced.add(`${currentSongTitle}:::${upcomingSongTitle}`);

    // Cleanup set
    setTimeout(
      () => {
        alreadyAnnounced.delete(`${currentSongTitle}:::${upcomingSongTitle}`);
      },
      2 * 60 * 1000,
    );

    const settings = await chrome.storage.sync.get([
      "speechProvider",
      "localServerPort",
      "geminiApiKey",
    ]);
    const speechProvider = settings.speechProvider || "gemini-api";
    const localServerPort = settings.localServerPort || 8008;
    const geminiApiKey = settings.geminiApiKey || "";

    console.log(
      `[Announce] Speech Provider: ${speechProvider}, Local Port: ${localServerPort}`,
    );

    if (
      speechProvider === "localserver" ||
      speechProvider === "gemini-api" ||
      speechProvider === "kokoro"
    ) {
      try {
        // Ensure document exists
        // @ts-ignore
        if (!(await chrome.offscreen.hasDocument())) {
          console.log("[Announce] Creating offscreen document...");
          await chrome.offscreen.createDocument({
            url: "offscreen.html",
            reasons: [chrome.offscreen.Reason.DOM_PARSER],
            justification: "To use local AI models",
          });
        }

        const playbackResult = await chrome.runtime.sendMessage({
          type: "PLAY_AUDIO",
          payload: {
            tabId,
            localServerPort,
            textToSpeak: response,
            speechProvider,
            geminiApiKey,
            // Validate against the New Song (which is now playing/paused in the player)
            forSongNow: upcomingSongTitle,
            forSongNext: upcomingSongTitle, // Logic check: we usually just check "Is valid song loaded?". checking Next is tricky if queue updates. Let's just validate Now.
          },
        });

        if (playbackResult && playbackResult.success === false) {
          throw new Error(
            playbackResult.error || "Offscreen audio playback reported failure",
          );
        }

        console.log(`${speechProvider} TTS ended`);
        chrome.tabs.sendMessage(tabId, { type: "TTS_ENDED" });
      } catch (e) {
        console.error(
          `[Announce] Failed to play audio with ${speechProvider}`,
          e,
        );
        // Fallback to Chrome TTS? Or just fail? Let's fallback.
        console.log("[Announce] Falling back to Chrome TTS");
        speakNative(response, tabId);
      }
    } else {
      console.log("[Announce] Using native Chrome TTS");
      speakNative(response, tabId);
    }
  });
}

function speakNative(text: string, tabId: number) {
  chrome.tts.speak(text, {
    rate: 0.9,
    pitch: 1.1,
    volume: 1,
    voiceName: "Google UK English Female",
    onEvent: (event) => {
      if (event.type === "end") {
        console.log("TTS ended");
        chrome.tabs.sendMessage(tabId, { type: "TTS_ENDED" });
      }
    },
  });
}

// Lifecycle Management: Close offscreen if no YTM tabs are open
async function checkOffscreen() {
  const tabs = await chrome.tabs.query({ url: "*://music.youtube.com/*" });
  if (tabs.length === 0) {
    // @ts-ignore
    if (await chrome.offscreen.hasDocument()) {
      console.log(
        "No YTM tabs open. Closing offscreen document to free memory.",
      );
      // @ts-ignore
      await chrome.offscreen.closeDocument();
    }
  }
}

chrome.tabs.onRemoved.addListener(checkOffscreen);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // If a tab navigates away from YTM, check if we should close
  if (changeInfo.status === "complete") {
    checkOffscreen();
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  const settings = await chrome.storage.sync.get([
    "isEnabled",
    "isDebugEnabled",
    "modelProvider",
    "speechProvider",
  ]);
  const updates: any = {};

  // 0. Set defaults
  if (settings.isEnabled === undefined) {
    updates.isEnabled = true;
  }
  if (settings.isDebugEnabled === undefined) {
    updates.isDebugEnabled = false;
  }

  // 1. Migrate deprecated "Gemini (Chrome)" -> "Gemini API"
  if (settings.modelProvider === "gemini") {
    console.log("Migrating modelProvider: gemini -> gemini-api");
    updates.modelProvider = "gemini-api";
  }

  // 2. Migrate default "Chrome TTS" -> "Gemini API"
  if (settings.speechProvider === "tts" || !settings.speechProvider) {
    console.log("Migrating speechProvider: tts -> gemini-api");
    updates.speechProvider = "gemini-api";
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.sync.set(updates);
    console.log("Settings migrated successfully.");
  }
});
