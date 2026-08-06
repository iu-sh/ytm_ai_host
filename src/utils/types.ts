export interface StorageSchema {
  isEnabled: boolean;
  isDebugEnabled: boolean;
  modelProvider: "gemini" | "gemini-api" | "webllm" | "localserver";
  geminiApiKey?: string;
  speechProvider: "tts" | "localserver" | "gemini-api" | "kokoro";
  localServerPort: number;
  djMode: "party" | "radio" | "ghazal";
}

export type MessageSchema =
  | {
    type: "SONG_ABOUT_TO_END";
    payload: {
      currentSongTitle: string;
      currentSongArtist: string;
      upcomingSongTitle: string;
      upcomingSongArtist: string;
    };
  }
  | {
    type: "GENERATE_RJ";
    payload: {
      oldSongTitle: string;
      oldArtist: string;
      newSongTitle: string;
      newArtist: string;
      useWebLLM?: boolean; // Keep for backward compat or refactor logic to use modelProvider
      modelProvider?: "gemini" | "gemini-api" | "webllm" | "localserver";
      geminiApiKey?: string;
      localServerPort?: number;
      systemPrompt?: string;
      currentTime?: string;
    };
  }
  | {
    type: "TTS_ENDED";
  }
  | {
    type: "TTS_STARTED";
  }
  | {
    type: "PREWARM_RJ";
    payload: {
      oldSongTitle: string;
      oldArtist: string;
      newSongTitle: string;
      newArtist: string;
      useWebLLM?: boolean;
      modelProvider?: "gemini" | "gemini-api" | "webllm" | "localserver"; // Add this here too
      geminiApiKey?: string;
      currentTime?: string;
    };
  }
  | {
    type: "PLAY_AUDIO";
    payload: {
      tabId: number;
      audioData?: number[]; // Optional now
      localServerPort?: number;
      textToSpeak: string;
      speechProvider?: "tts" | "localserver" | "gemini-api" | "kokoro";
      geminiApiKey?: string;
      forSongNow?: string;
      forSongNext?: string;
      djMode?: "party" | "radio" | "ghazal";
    };
  }
  | {
    type: "SPEAK_WITH_LOCAL_SERVER"; // Cleaner command
    payload: {
      text: string;
      port: number;
    };
  }
  | {
    type: "PRELOAD_AUDIO";
    payload: {
      localServerPort?: number;
      textToSpeak: string;
      speechProvider?: "tts" | "localserver" | "gemini-api" | "kokoro";
      geminiApiKey?: string;
      djMode?: "party" | "radio" | "ghazal";
    };
  }
  | {
    type: "GET_CURRENT_SONG_INFO";
  }
  | {
    type: "CURRENT_SONG_INFO";
    payload: {
      currentSongTitle?: string;
      upcomingSongTitle?: string;
    };
  }
  | {
    type: "OFFSCREEN_TO_CONTENT_PROXY";
    payload: {
      tabId: number;
      message: MessageSchema;
    };
  }
  | {
    type: "YTM_EXTENSION_REQUEST_DATA";
  }
  | {
    type: "YTM_EXTENSION_RESPONSE_DATA";
    currentSong?: CurrentSong;
    upcomingSong?: UpcomingSong;
  };

export interface CurrentSong {
  title: string;
  artist: string;
  album: string;
  isPaused: boolean;
}

export interface UpcomingSong {
  title: string;
  artist: string;
}

// --- CONSTANTS ---
export const EVENT_TRIGGER = "YTM_EXT_TRIGGER"; // Song Changed (Paused)
export const EVENT_UPDATE = "YTM_EXT_UPDATE"; // Info Updated (e.g. Queue loaded)
export const EVENT_RESUME = "YTM_EXT_RESUME";
export const EVENT_REQUEST_DATA = "YTM_EXTENSION_REQUEST_DATA";
export const EVENT_RETURN_DATA = "YTM_EXTENSION_RETURN_DATA";
export const EVENT_TTS_STARTED = "YTM_EXT_TTS_STARTED";

