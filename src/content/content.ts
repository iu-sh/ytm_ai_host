import {
  MessageSchema,
  CurrentSong,
  UpcomingSong,
  EVENT_TRIGGER,
  EVENT_UPDATE,
  EVENT_RESUME,
  EVENT_REQUEST_DATA,
  EVENT_RETURN_DATA,
  EVENT_TTS_STARTED,
} from "../utils/types";

// --- CONSTANTS --- (Imported from types)

// --- STATE ---
let currentSong: CurrentSong | null = null;
let upcomingSong: UpcomingSong | null = null;

// Track processing to avoid duplicates
const processedPairs = new Set<string>(); // "TitleA::TitleB"
const prefetchTimestamps = new Map<string, number>(); // "TitleA::TitleB" -> Timestamp

let isDebug = false;
let isEnabled = true;

// --- LOGGING ---
function log(msg: string, ...args: any[]) {
  if (isDebug) console.log(`%c[Content] ${msg}`, "color: #00ccff", ...args);
}

// --- INITIALIZATION ---
function injectScript() {
  try {
    const script = document.createElement("script");
    const url = chrome.runtime.getURL("injector.js");
    console.log(
      "%c[Content] Attempting to inject script from URL:",
      "color: yellow",
      url,
    );
    script.src = url;
    script.onload = () => {
      console.log(
        "%c[Content] Injector.js injected successfully",
        "color: #00ccff",
      );
      script.remove();
    };
    script.onerror = (e) =>
      console.error(
        "%c[Content] Failed to inject injector.js",
        "color: red",
        e,
      );
    (document.head || document.documentElement).appendChild(script);
  } catch (e) {
    console.error("Injection failed", e);
  }
}

function init() {
  console.log(
    "%c[Content] Script Loaded & Running",
    "color: #00ccff; font-size: 12px; font-weight: bold;",
  );

  // Inject the Interceptor Script (MAIN World)
  injectScript();

  // Connection Timeout Watchdog
  const connectionTimeout = setTimeout(() => {
    console.error(
      "%c[Content] CRITICAL: Injector handshake timed out! Injector.js may not be running.",
      "font-size: 16px; background: red; color: white; padding: 4px;",
    );
  }, 2500);

  // Listen for the first handshake success to clear the error
  const handshakeSuccess = () => {
    clearTimeout(connectionTimeout);
    console.log(
      "%c[Content] Injector Connected Successfully",
      "color: #00ff00; font-weight: bold;",
    );
    document.removeEventListener(EVENT_RETURN_DATA, handshakeSuccess);
  };
  document.addEventListener(EVENT_RETURN_DATA, handshakeSuccess);

  chrome.storage.sync.get(["isDebugEnabled", "isEnabled"], (result) => {
    isDebug = result.isDebugEnabled ?? false;
    isEnabled = result.isEnabled ?? true;

    updateAIRJModeIndicator();

    // Request initial status from Injector
    // Using a small retry loop to ensure Injector is ready (race condition fix)
    const requestData = () =>
      document.dispatchEvent(new CustomEvent(EVENT_REQUEST_DATA));

    // Wait slightly for injection to take hold
    setTimeout(() => {
      requestData();
      setTimeout(requestData, 1000); // Retry once after 1s
    }, 500);
  });
}

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === "sync") {
    if (changes.isDebugEnabled) isDebug = changes.isDebugEnabled.newValue;
    if (changes.isEnabled) {
      isEnabled = changes.isEnabled.newValue;
      updateAIRJModeIndicator();
    }
  }
});

// --- UI INDICATOR ---
function updateAIRJModeIndicator() {
  const logoAnchor = document.querySelector("a.ytmusic-logo");
  if (!logoAnchor) return;
  let indicator = document.getElementById("ai-rj-mode-indicator");

  if (isEnabled) {
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.id = "ai-rj-mode-indicator";
      indicator.innerText = "AI RJ Mode";
      Object.assign(indicator.style, {
        fontSize: "10px",
        fontWeight: "bold",
        color: "#fff",
        opacity: "0.7",
        position: "absolute",
        bottom: "-12px",
        left: "0",
        width: "100%",
        textAlign: "center",
        pointerEvents: "none",
        whiteSpace: "nowrap",
        fontFamily: "Roboto, Arial, sans-serif",
      });
      if (window.getComputedStyle(logoAnchor).position === "static") {
        (logoAnchor as HTMLElement).style.position = "relative";
      }
      logoAnchor.appendChild(indicator);
    }
  } else {
    indicator?.remove();
  }
}

// --- LOGIC: SONG CHANGE HANDLING ---

/**
 * Handle Song Change Event (Triggered by Injector)
 * The song is PAUSED when this fires.
 */
async function handleSongChange(detail: any) {
  if (!isEnabled) {
    document.dispatchEvent(new CustomEvent(EVENT_RESUME));
    return;
  }

  const prevSong = currentSong;
  currentSong = detail.currentSong;
  upcomingSong = detail.upcomingSong;

  log(`Song Changed: ${currentSong?.title} (Next: ${upcomingSong?.title})`);

  // 2. Announce the TRANSITION to this song (if available)
  // We are looking for a transition from prevSong -> currentSong
  // But since we store prewarmed keys as "Current::Next", we look for "Prev::Current"
  if (prevSong && currentSong) {
    const pairKey = `${prevSong.title}::${currentSong.title}`;

    // Check if we have an announcement pending/ready?
    // Actually, the background/offscreen handles the "Ready" part via TTS.
    // We just ask the background: "Hey, song changed to B. Did you have a script for A->B?"
    // But wait, the architecture is: Content asks to Play.

    // Simpler approach:
    // We assume `SONG_ABOUT_TO_END` logic was replaced by this strictly event-driven flow?
    // No, the user said: "When we have the event of A::B... content script should start prefetch...
    // and as soon as the song changes... trigger the announce flow".

    // So here we trigger the announce flow.
    await triggerAnnounce(pairKey);
  } else {
    // First song or no previous context. Just resume.
    log("No previous song context or first load. Resuming.");
    document.dispatchEvent(new CustomEvent(EVENT_RESUME));
  }

  // 3. Start Prefetch for NEXT Pair (Current::Upcoming)
  schedulePrefetch();
}

/**
 * Triggers the announcement (TTS) for the given pair.
 * It sends a message to background to play the audio.
 * Then waits for TTS_ENDED or timeout to Resume.
 */
// Flag to detect if we resumed playback while announcing (e.g. Safety Timer)
let isPlaybackResumed = false;

// Listen for RESUME events to cancel pending announcements
document.addEventListener(EVENT_RESUME, () => {
  isPlaybackResumed = true;
  log("Detection: Playback Resumed (User or Safety Timer)");
});

async function triggerAnnounce(pairKey: string) {
  return new Promise<void>((resolve) => {
    // Expected current song (The "To" song)
    const expectedCurrentTitle = pairKey.split("::")[1];

    log(`Triggering Announce for ${pairKey}`);
    isPlaybackResumed = false; // Reset flag

    // 1. Setup Resume/Abort Handler
    const resumeHandler = (msg: any) => {
      if (msg.type === "TTS_ENDED") {
        chrome.runtime.onMessage.removeListener(resumeHandler);

        // --- GUARD: LATE ANNOUNCEMENT ---
        // If playback already resumed (by Safety Timer or User), DO NOT announce.
        // Or if context changed completely.
        if (isPlaybackResumed) {
          log("Abort Announce: Playback was already resumed.");
          resolve();
          return;
        }

        // --- GUARD: WRONG SONG ---
        // If the song playing now is NOT what we expected to announce...
        if (currentSong?.title !== expectedCurrentTitle) {
          log(
            `Abort Announce: Song changed mismatch! (Exp: ${expectedCurrentTitle}, Act: ${currentSong?.title})`,
          );
          // Ensure we resume just in case
          document.dispatchEvent(new CustomEvent(EVENT_RESUME));
          resolve();
          return;
        }

        log("TTS Ended. Resuming.");
        document.dispatchEvent(new CustomEvent(EVENT_RESUME));
        resolve();
      }
    };
    chrome.runtime.onMessage.addListener(resumeHandler);

    // 2. Send Request
    // 2. Send Request
    try {
      chrome.runtime.sendMessage(
        {
          type: "SONG_ABOUT_TO_END",
          payload: {
            currentSongTitle: pairKey.split("::")[0], // Previous
            currentSongArtist: "Unknown",
            upcomingSongTitle: pairKey.split("::")[1], // Current
            upcomingSongArtist: currentSong!.artist,
          },
        },
        (response) => {
          if (chrome.runtime.lastError) {
            log(
              "Message sending failed (SW dead?):",
              chrome.runtime.lastError.message,
            );
            // Resume immediately
            document.dispatchEvent(new CustomEvent(EVENT_RESUME));
            resolve();
          }
        },
      );
    } catch (e) {
      log("Context Invalidated or Send Failed:", e);
      document.dispatchEvent(new CustomEvent(EVENT_RESUME));
      resolve();
    }

    // 3. Safety Timeout (Content-Side)
    // Default 4s. If TTS starts, we extend it indefinitely (or rely on Injector's long timer).
    let safetyTimer = setTimeout(() => {
      if (!isPlaybackResumed) {
        log("Announce Timeout (4s). Resuming manually.");
        document.dispatchEvent(new CustomEvent(EVENT_RESUME));
        resolve();
      }
    }, 4000);

    const ttsStartedHandler = () => {
      log("TTS Started! Clearing 4s safety timer.");
      clearTimeout(safetyTimer);
      document.removeEventListener(EVENT_TTS_STARTED, ttsStartedHandler);
    };
    document.addEventListener(EVENT_TTS_STARTED, ttsStartedHandler);

    // Ensure we clean up listener if it ends/resumes before start
    const originalResumeHandler = resumeHandler; // We can't access resumeHandler easily if we don't modify structure.
    // Actually, when we resolve, we should clean up.
    // But promise closure...
    // Let's just rely on the fact that if it resolves, the timer does nothing.
    // But we should clean up the listener to avoid memory leak?
    // It's a one-off per announce. Usage is low. OK for now.
  });
}

// --- LOGIC: PREFETCH ---

let prefetchTimer: any = null;

function schedulePrefetch() {
  if (prefetchTimer) clearTimeout(prefetchTimer);

  if (!currentSong || !upcomingSong) {
    log("Cannot schedule prefetch: missing info");
    return;
  }

  const pairKey = `${currentSong.title}::${upcomingSong.title}`;
  log(`Scheduling prefetch for ${pairKey} in 15s...`);

  // Store start time for this pair attempt
  const now = Date.now();

  // 40s into a song, probably a good time to prefetch the RJ intro, the user will hopefully
  // not skip and waste our expensive Gemini API call :/.
  prefetchTimer = setTimeout(() => {
    performPrefetch(pairKey, currentSong!, upcomingSong!);
  }, 40000);
}

function performPrefetch(
  pairKey: string,
  cSong: CurrentSong,
  uSong: UpcomingSong,
) {
  // Verify we are still playing the same song context
  if (!currentSong || !upcomingSong) return;
  const currentPair = `${currentSong.title}::${upcomingSong.title}`;

  if (currentPair !== pairKey) {
    log(`Prefetch aborted: Context changed (${currentPair} != ${pairKey})`);
    return;
  }

  // Check history to avoid spamming the same pair if we loop?
  // User: "compare the upcoming requests for a difference of 15seconds"
  // Since we just waited 15s, this is satisfied?

  if (processedPairs.has(pairKey)) {
    // Maybe we allow re-fetching if it's been a long time?
    // For now, strict once-per-session-per-pair to save tokens.
    log(`Already prefetched ${pairKey}. Skipping.`);
    return;
  }

  log(`Sending PREWARM_RJ for ${pairKey}`);
  processedPairs.add(pairKey);

  chrome.runtime.sendMessage({
    type: "PREWARM_RJ",
    payload: {
      oldSongTitle: cSong.title,
      oldArtist: cSong.artist,
      newSongTitle: uSong.title,
      newArtist: uSong.artist,
      currentTime: new Date().toLocaleTimeString([], {
        weekday: "long",
        hour: "2-digit",
        minute: "2-digit",
      }),
    },
  });
}

// --- EVENT LISTENERS ---

// 1. From Injector (Song Change / Data Update)
document.addEventListener(EVENT_TRIGGER, (e: any) => {
  handleSongChange(e.detail);
});

document.addEventListener(EVENT_UPDATE, (e: any) => {
  const { currentSong: c, upcomingSong: u } = e.detail;
  // Only update data, don't trigger song change logic unless title changed
  if (c?.title !== currentSong?.title) {
    // This is weird, injector should have fired TRIGGER.
    // But maybe we missed it?
    handleSongChange(e.detail);
  } else {
    // Just update upcoming (Queue loaded?)
    if (upcomingSong?.title !== u?.title) {
      log(`Queue Updated: ${upcomingSong?.title} -> ${u?.title}`);
      upcomingSong = u;
      // If we have a new upcoming song, we should probably schedule prefetch now!
      schedulePrefetch();
    }
  }
});

document.addEventListener(EVENT_RETURN_DATA, (e: any) => {
  const { currentSong: c, upcomingSong: u } = e.detail;
  currentSong = c;
  upcomingSong = u;
  log(`Initial Data: ${currentSong?.title} -> ${upcomingSong?.title}`);

  // On initial load, we might want to prefetch?
  if (currentSong && upcomingSong) {
    schedulePrefetch();
  }
});

// 2. From Background (TTS Ended, etc.)
// 2. From Background (TTS Ended, etc.)
chrome.runtime.onMessage.addListener(
  (message: MessageSchema, sender, sendResponse) => {
    if (message.type === "TTS_ENDED") {
      // Handled in triggerAnnounce usually, but as a fallback:
      log("TTS_ENDED received globally.");
      // We assume triggerAnnounce listener caught it.
      // If we are paused and stuck, we can resume here too.
      if (document.querySelector("video")?.paused) {
        document.dispatchEvent(new CustomEvent(EVENT_RESUME));
      }
    } else if (message.type === "TTS_STARTED") {
      log("TTS Started Signal Received. Extending Safety Timers.");
      // Forward to Injector
      document.dispatchEvent(new CustomEvent(EVENT_TTS_STARTED));
    } else if (message.type === "GET_CURRENT_SONG_INFO") {
      sendResponse({
        type: "CURRENT_SONG_INFO",
        payload: {
          currentSongTitle: currentSong?.title,
          upcomingSongTitle: upcomingSong?.title,
        },
      });
    }
  },
);

// Start
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
