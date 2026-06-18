import { MessageSchema } from "../utils/types";
import { RJ_SYSTEM_PROMPT } from "./constants";
import { KokoroTTS } from "kokoro-js";
import { env } from "@huggingface/transformers";
import { sha256 } from "../utils/hashing";

// Configure Transformers.js / ONNX Runtime to use local files (MV3 compliant)
env.allowLocalModels = false; // We are likely fetching model weights from HF Hub (via fetch, which is allowed)
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths = "./"; // Look for .wasm files in the same directory (root of dist)
  env.backends.onnx.wasm.proxy = false; // Disable proxy to avoid worker complexities often found in extensions
}

const audioCache = new Map<string, Promise<string>>(); // text -> Promise<blobUrl>

// Track current playing audio to prevent overlaps
let currentAudio: HTMLAudioElement | null = null;

// Lazy-loaded KokoroTTS instance
let kokoroTTSInstance: KokoroTTS | null = null;
const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX"; // default
const KOKORO_VOICE = "af_bella"; // Bright, energetic female voice (Bella)

chrome.runtime.onMessage.addListener(
  (message: MessageSchema, sender, sendResponse) => {
    if (message.type === "GENERATE_RJ") {
      handleGeneration(message.payload).then(sendResponse);
      return true; // Keep channel open
    } else if (message.type === "PLAY_AUDIO") {
      playAudio(message.payload.tabId, message.payload)
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err }));
      return true;
    } else if (message.type === "PRELOAD_AUDIO") {
      preloadAudio(message.payload); // Fire and forget for response, but we log internally
      sendResponse({ success: true });
      return false;
    }
  },
);

async function shouldShutTheFuckUp(
  tabId: number,
  songNow?: string,
  songNext?: string,
): Promise<boolean> {
  const currentSongInfoFromContentScript: MessageSchema =
    await getCurrentSongInfo(tabId);
  console.log(
    `[Offscreen] Validation Check - Expected: Now="${songNow}", Next="${songNext}"`,
  );

  if (!currentSongInfoFromContentScript) {
    console.warn(
      "[Offscreen] Validation Check - Failed to get current song info (Content script dead?). Allowing playback.",
    );
    return false; // Default to allow if we can't check
  }

  if (currentSongInfoFromContentScript.type === "CURRENT_SONG_INFO") {
    console.log(
      `[Offscreen] Validation Check - Actual: Now="${currentSongInfoFromContentScript.payload.currentSongTitle}", Next="${currentSongInfoFromContentScript.payload.upcomingSongTitle}"`,
    );
    // If titles are missing/undefined, we shouldn't block, assuming normal flow, unless we are strict.
    // But strict is better to avoid wrong intro.
    if (!songNow || !currentSongInfoFromContentScript.payload.currentSongTitle)
      return false;

    return (
      currentSongInfoFromContentScript.payload.currentSongTitle !== songNow ||
      currentSongInfoFromContentScript.payload.upcomingSongTitle !== songNext
    );
  }
  console.log(
    `[Offscreen] Validation Check - Received unexpected message type: ${currentSongInfoFromContentScript.type}`,
  );
  return true;
}

function getCurrentSongInfo(tabId: number): Promise<MessageSchema> {
  return chrome.runtime.sendMessage({
    type: "OFFSCREEN_TO_CONTENT_PROXY",
    payload: {
      tabId,
      message: { type: "GET_CURRENT_SONG_INFO" },
    },
  });
}

async function fetchAudio(
  localServerPort: number,
  textToSpeak: string,
): Promise<string> {
  console.log("Fetching Audio from Local Server...");
  const response = await fetch(`http://localhost:${localServerPort}/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: textToSpeak }),
  });

  if (!response.ok) throw new Error("Local Server TTS failed");

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  console.log("Audio fetched and blob created.");
  return url;
}

async function preloadAudio(payload: {
  localServerPort?: number;
  textToSpeak: string;
  speechProvider?: "tts" | "localserver" | "gemini-api" | "kokoro";
  geminiApiKey?: string;
}) {
  if (audioCache.has(payload.textToSpeak)) {
    console.log("Audio already cached (or fetching) for:", payload.textToSpeak);
    return;
  }

  console.log(
    `[Offscreen] Starting Audio Preload from: ${payload.speechProvider}`,
  );

  // Check OPFS Cache first (Persistent)
  const cacheKey = `${payload.textToSpeak}_${payload.speechProvider}`;
  try {
    const opfsUrl = await getAudioFromOPFS(cacheKey);
    if (opfsUrl) {
      console.log(
        `[Offscreen] [Cache Hit] Audio found in OPFS for: ${cacheKey}`,
      );
      return;
    }
  } catch (e) {
    console.warn("OPFS Check failed", e);
  }

  let audioPromise;
  if (payload.speechProvider === "localserver") {
    const port = payload.localServerPort || 8008;
    audioPromise = fetchAudio(port, payload.textToSpeak);
  } else if (payload.speechProvider === "kokoro") {
    audioPromise = fetchKokoroTTS(payload.textToSpeak);
  } else {
    audioPromise = fetchGeminiTTS(payload.geminiApiKey, payload.textToSpeak);
  }

  audioCache.set(payload.textToSpeak, audioPromise);

  try {
    const url = await audioPromise;
    console.log(
      `[Offscreen] Audio preload (prefetch) completed successfully from ${payload.speechProvider}`,
    );

    // Save to OPFS
    if (url.startsWith("blob:")) {
      const response = await fetch(url);
      const blob = await response.blob();
      await saveAudioToOPFS(cacheKey, blob);
    }

    // Cleanup memory cache after 10 mins
    setTimeout(
      async () => {
        if (audioCache.has(payload.textToSpeak)) {
          try {
            const url = await audioCache.get(payload.textToSpeak);
            if (url) URL.revokeObjectURL(url);
          } catch (e) {}
          audioCache.delete(payload.textToSpeak);
        }
      },
      10 * 60 * 1000,
    );
  } catch (e) {
    console.error("Audio preload failed", e);
    audioCache.delete(payload.textToSpeak); // Remove failed promise
  }
}

async function handleGeneration(payload: {
  oldSongTitle: string;
  oldArtist: string;
  newSongTitle: string;
  newArtist: string;
  modelProvider?: "gemini" | "gemini-api" | "webllm" | "localserver";
  geminiApiKey?: string;
  useWebLLM?: boolean;
  localServerPort?: number;
  currentTime?: string;
  systemPrompt?: string;
}) {
  // Default to gemini-api if not specified
  const modelProvider = payload.modelProvider || "gemini-api";
  console.log(
    `[Offscreen] Generating RJ intro using LLM provider: ${modelProvider}`,
  );
  let generationPromise: Promise<string>;

  if (modelProvider === "localserver") {
    generationPromise = generateWithLocalServer(payload);
  } else if (modelProvider === "webllm" || payload.useWebLLM) {
    // Condition checked at build time
    if (process.env.INCLUDE_WEBLLM) {
      try {
        // @ts-ignore
        const webLLMService = await import("./webllmService");
        generationPromise = webLLMService.generateWithWebLLM(payload);
      } catch (e) {
        console.error("Failed to load WebLLM service:", e);
        return "WebLLM service not available in this build.";
      }
    } else {
      console.warn("WebLLM requested but not included in this build.");
      return "WebLLM support is not enabled in this build of the extension.";
    }
  } else {
    // Default: Gemini API
    generationPromise = generateWithGeminiAPI(payload);
  }

  try {
    const text = await generationPromise;
    console.log(
      "[Offscreen] LLM generation (prefetch) completed successfully.",
    );
    return text;
  } catch (error) {
    console.error("LLM generation failed:", error);
    throw error;
  }
}

async function generateWithGeminiAPI(data: {
  oldSongTitle: string;
  oldArtist: string;
  newSongTitle: string;
  newArtist: string;
  geminiApiKey?: string;
  currentTime?: string;
}): Promise<string> {
  const apiKey = data.geminiApiKey;
  if (!apiKey) {
    console.error("Gemini API Key is missing");
    return `Error in Gemini LLM. Coming up next: ${data.newSongTitle} by ${data.newArtist}.`;
  }

  const timeContext = data.currentTime
    ? ` Current time: ${data.currentTime}.`
    : "";
  // Random 1/3 chance to add witty fact
  const aRandomNumber = Math.random();
  const addWittyFact = Math.floor(aRandomNumber * 3) + 1 === 3;
  const addWeatherInfo = Math.floor(aRandomNumber * 5) + 1 === 5; // 1/5 chance to add weather info
  const addNewsInfo = Math.floor(aRandomNumber * 10) + 1 === 10; // 1/10 chance to add news info

  const extraInstruction = addWittyFact
    ? "Maybe provide a witty random fact."
    : "";

  const prompt = `Previous Song: "${data.oldSongTitle}" by "${data.oldArtist}"\nNext Song: "${data.newSongTitle}" by "${data.newArtist}"\n${timeContext}\n\nGenerate the DJ intro now.${extraInstruction}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: RJ_SYSTEM_PROMPT }],
          },
          contents: [
            {
              parts: [
                {
                  text: prompt,
                },
              ],
            },
          ],
        }),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || "Gemini API failed");
    }

    const json = await response.json();
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      throw new Error("Invalid response format from Gemini API");
    }
    return text;
  } catch (err) {
    console.error("Gemini API request failed:", err);
    return `And this is ${data.newSongTitle} by ${data.newArtist}.`;
  }
}

async function playAudio(
  tabId: number,
  payload: {
    localServerPort?: number;
    textToSpeak: string;
    speechProvider?: "tts" | "localserver" | "gemini-api" | "kokoro";
    geminiApiKey?: string;
    forSongNow?: string;
    forSongNext?: string;
  },
) {
  try {
    // Stop any currently playing audio to prevent overlap
    if (currentAudio) {
      console.log(
        "[Offscreen] Stopping currently playing audio to start new track.",
      );
      currentAudio.pause();
      currentAudio = null;
    }

    // should I shut the fuck up instead?
    if (
      await shouldShutTheFuckUp(tabId, payload.forSongNow, payload.forSongNext)
    ) {
      console.log(
        "[Offscreen] Validation failed: Song changed. Shutup mode activated.",
      );
      // Testing without shutting the fuck up for now :)
      // because the events are not in sync. Comment out "return", if things break.
      // return;
    }
    console.log(
      `[Offscreen] Playing audio using provider: ${payload.speechProvider || "tts"}`,
    );

    // 1. Try Memory Cache
    let audioPromise = audioCache.get(payload.textToSpeak);

    // 2. Try OPFS Cache
    const cacheKey = `${payload.textToSpeak}_${payload.speechProvider}`;
    if (!audioPromise) {
      try {
        const opfsUrl = await getAudioFromOPFS(cacheKey);
        if (opfsUrl) {
          console.log(`[Offscreen] [Cache Hit] Audio found in OPFS`);
          audioPromise = Promise.resolve(opfsUrl);
        }
      } catch (e) {
        console.warn("OPFS Lookup failed", e);
      }
    }

    if (!audioPromise) {
      console.log(
        "[Offscreen] Audio not cached, requesting now (Just-In-Time)...",
      );
      if (payload.speechProvider === "localserver") {
        const port = payload.localServerPort || 8008;
        audioPromise = fetchAudio(port, payload.textToSpeak);
      } else if (payload.speechProvider === "kokoro") {
        audioPromise = fetchKokoroTTS(payload.textToSpeak);
      } else {
        audioPromise = fetchGeminiTTS(
          payload.geminiApiKey,
          payload.textToSpeak,
        );
      }
      audioCache.set(payload.textToSpeak, audioPromise);
    } else {
      console.log(
        `[Offscreen] Playing cached audio from provider: ${payload.speechProvider} (awaiting promise if pending).`,
      );
    }

    const urlOrBuffer = await audioPromise;

    // If it's a blob URL (localserver or Kokoro), use Audio element
    if (typeof urlOrBuffer === "string" && urlOrBuffer.startsWith("blob:")) {
      currentAudio = new Audio(urlOrBuffer);
      return new Promise<void>((resolve, reject) => {
        if (!currentAudio) return reject("Audio object lost");
        currentAudio.onended = () => {
          resolve();
          currentAudio = null;
        };
        currentAudio.onerror = (e) => {
          reject(e);
          currentAudio = null;
        };
        currentAudio
          .play()
          .then(() => {
            // Notify system that TTS actually started talking
            chrome.runtime.sendMessage({ type: "TTS_STARTED" });
          })
          .catch((e) => {
            reject(e);
            currentAudio = null;
          });
      });
    }
    // If it's an ArrayBuffer (Gemini API returns PCM, which we convert to WAV ArrayBuffer or play directly)
    else {
      // Note: In strict Typescript, urlOrBuffer would be string.
      // But fetchGeminiTTS returns a string (blob URL) now?
      // Wait, fetchGeminiTTS calls URL.createObjectURL(blob) at the end.
      // So urlOrBuffer IS a string.
      // The logic below 'else' seems to assume it might not be?
      // Actually, fetchGeminiTTS returns a blob URL string.
      // So this block is redundant if everything returns a blob URL.
      // Let's verify fetchGeminiTTS again.
      // Yes, it returns `URL.createObjectURL`.

      // However, if we change implementation later, let's keep it robust.
      // If it IS a string, treating it as URL.
      currentAudio = new Audio(urlOrBuffer);
      return new Promise<void>((resolve, reject) => {
        if (!currentAudio) return reject("Audio object lost");
        currentAudio.onended = () => {
          resolve();
          currentAudio = null;
        };
        currentAudio.onerror = (e) => {
          reject(e);
          currentAudio = null;
        };
        currentAudio.play().catch((e) => {
          reject(e);
          currentAudio = null;
        });
      });
    }
  } catch (e) {
    console.error("[Offscreen] Audio playback failed. Details:", e);
    if (e instanceof Error)
      console.error("Message:", e.message, "Stack:", e.stack);

    audioCache.delete(payload.textToSpeak);
    throw e;
  }
}

async function fetchKokoroTTS(text: string): Promise<string> {
  console.log("[Offscreen] [Kokoro] Fetching Audio...");
  try {
    if (!kokoroTTSInstance) {
      console.log("[Offscreen] [Kokoro] Initializing model...");
      kokoroTTSInstance = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        dtype: "q8", // 8-bit quantization for browser efficiency
      });
      console.log("[Offscreen] [Kokoro] Model initialized.");
    }

    console.log("[Offscreen] [Kokoro] Generating audio...");
    // Generate audio
    const rawAudio = await kokoroTTSInstance.generate(text, {
      voice: KOKORO_VOICE,
    });

    // Convert RawAudio to Blob URL
    const blob = rawAudio.toBlob();
    const url = URL.createObjectURL(blob);
    console.log("[Offscreen] [Kokoro] Audio generated and blob created.");
    return url;
  } catch (err) {
    console.error("Kokoro TTS failed:", err);
    throw err;
  }
}

async function fetchGeminiTTS(
  apiKey: string | undefined,
  text: string,
): Promise<string> {
  if (!apiKey) throw new Error("Gemini API Key missing for TTS");

  console.log("Fetching Audio from Gemini API...");
  // Use gemini-2.5-flash-preview-tts
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: "Aoede", // Breezy female voice
              },
            },
          },
        },
      }),
    },
  );

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || "Gemini TTS failed");
  }

  const json = await response.json();
  const base64Data =
    json.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

  if (!base64Data) throw new Error("No audio data returned from Gemini TTS");

  // Convert Base64 to ArrayBuffer (PCM)
  const binaryString = atob(base64Data);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const pcmData = bytes.buffer;

  // Wrap PCM in WAV container
  const wavBuffer = createWavFile(pcmData);
  const blob = new Blob([wavBuffer], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  return url;
}

// Helper to add WAV header to raw PCM data
function createWavFile(pcmData: ArrayBuffer): ArrayBuffer {
  const numChannels = 1;
  const sampleRate = 24000;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmData.byteLength;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const header = new ArrayBuffer(headerSize);
  const view = new DataView(header);

  // RIFF chunk descriptor
  writeString(view, 0, "RIFF");
  view.setUint32(4, totalSize - 8, true);
  writeString(view, 8, "WAVE");

  // fmt sub-chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
  view.setUint16(22, numChannels, true); // NumChannels
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, byteRate, true); // ByteRate
  view.setUint16(32, blockAlign, true); // BlockAlign
  view.setUint16(34, bitsPerSample, true); // BitsPerSample

  // data sub-chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // Concatenate header and data
  const wavFile = new Uint8Array(headerSize + dataSize);
  wavFile.set(new Uint8Array(header), 0);
  wavFile.set(new Uint8Array(pcmData), 44);

  return wavFile.buffer;
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

async function generateWithLocalServer(data: {
  oldSongTitle: string;
  oldArtist: string;
  newSongTitle: string;
  newArtist: string;
  localServerPort?: number;
  currentTime?: string;
  systemPrompt?: string;
}): Promise<string> {
  try {
    const port = data.localServerPort || 8008;
    const timeContext = data.currentTime
      ? ` Current time: ${data.currentTime}.`
      : "";

    // Random 1/3 chance to add witty fact
    const addWittyFact = Math.floor(Math.random() * 3) + 1 === 3;
    const extraInstruction = addWittyFact
      ? " Also, say a witty random fact."
      : "";

    const prompt = `Previous: "${data.oldSongTitle}" by ${data.oldArtist}\nNext: "${data.newSongTitle}" by "${data.newArtist}\n${timeContext}\n${extraInstruction}`;

    const response = await fetch(`http://localhost:${port}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: prompt,
        system_prompt: data.systemPrompt || RJ_SYSTEM_PROMPT, // Use passed prompt or proper RJ one
      }),
    });

    const json = await response.json();
    if (json.error) throw new Error(json.error);

    return json.text || `Coming up next: ${data.newSongTitle}`;
  } catch (err) {
    console.error("Local Server Model failed:", err);
    return `Coming up next: ${data.newSongTitle} by ${data.newArtist}.`;
  }
}

// --- OPFS Utilities ---

async function getAudioFromOPFS(key: string): Promise<string | null> {
  try {
    const hash = await sha256(key);
    const filename = `dj_audio_${hash}.wav`;
    console.log(`[OPFS] Reading ${filename} for key length: ${key.length}`);
    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(filename);
    const file = await fileHandle.getFile();
    return URL.createObjectURL(file);
  } catch (error) {
    // console.log(`[OPFS] Miss/Error for key length: ${key.length}`, error);
    return null;
  }
}

async function saveAudioToOPFS(key: string, blob: Blob) {
  try {
    const hash = await sha256(key);
    const filename = `dj_audio_${hash}.wav`;
    console.log(`[OPFS] Saving ${filename} for key length: ${key.length}`);
    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    console.log(`[Offscreen] [OPFS] Saved audio: ${filename}`);

    // Trigger cleanup roughly
    cleanUpOldFiles();
  } catch (error) {
    console.error("[Offscreen] [OPFS] Save failed:", error);
  }
}

async function cleanUpOldFiles() {
  // Random check (1 in 10) to avoid running on every save
  if (Math.random() > 0.1) return;

  console.log("[Offscreen] [OPFS] Running cleanup...");
  try {
    const root = await navigator.storage.getDirectory();
    // @ts-ignore - values() iterator
    for await (const name of root.keys()) {
      if (name.startsWith("dj_audio_")) {
        try {
          const handle = await root.getFileHandle(name);
          const file = await handle.getFile();
          // Delete if older than 30 mins
          if (Date.now() - file.lastModified > 30 * 60 * 1000) {
            await root.removeEntry(name);
            console.log(`[Offscreen] [OPFS] Deleted old file: ${name}`);
          }
        } catch (e) {}
      }
    }
  } catch (e) {
    console.warn("[Offscreen] Cleanup failed", e);
  }
}
