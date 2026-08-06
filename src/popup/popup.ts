import { StorageSchema } from '../utils/types';

const toggle = document.getElementById('enableToggle') as HTMLInputElement;
const debugToggle = document.getElementById('debugToggle') as HTMLInputElement;
const modelSelect = document.getElementById('modelSelect') as HTMLSelectElement;
const speechSelect = document.getElementById('speechSelect') as HTMLSelectElement;
const djModeSelect = document.getElementById('djModeSelect') as HTMLSelectElement;
const localServerConfig = document.getElementById('localServerConfig') as HTMLElement;
const geminiApiConfig = document.getElementById('geminiApiConfig') as HTMLElement;
const geminiApiKeyInput = document.getElementById('geminiApiKeyInput') as HTMLInputElement;
const portInput = document.getElementById('portInput') as HTMLInputElement;
const testConnectionBtn = document.getElementById('testConnectionBtn') as HTMLButtonElement;
const connectionStatus = document.getElementById('connectionStatus') as HTMLElement;
const statusText = document.getElementById('statusText') as HTMLElement;


// Initialize state
chrome.storage.sync.get(['isEnabled', 'isDebugEnabled', 'modelProvider', 'speechProvider', 'localServerPort', 'geminiApiKey', 'djMode'], (result: Partial<StorageSchema>) => {
    const isEnabled = result.isEnabled ?? true;
    const isDebugEnabled = result.isDebugEnabled ?? false;
    const modelProvider = result.modelProvider || 'gemini-api';
    const speechProvider = result.speechProvider || 'tts';
    const localServerPort = result.localServerPort || 8008;
    const geminiApiKey = result.geminiApiKey || '';
    const djMode = result.djMode || 'radio';

    updateUI(isEnabled, isDebugEnabled);

    // Set values
    modelSelect.value = modelProvider;
    speechSelect.value = speechProvider;
    djModeSelect.value = djMode;
    portInput.value = localServerPort.toString();
    geminiApiKeyInput.value = geminiApiKey;

    updateVisibility();
});

toggle.addEventListener('change', () => {
    const isEnabled = toggle.checked;
    chrome.storage.sync.set({ isEnabled }, () => {
        updateUI(isEnabled, debugToggle.checked);
    });
});

debugToggle.addEventListener('change', () => {
    const isDebugEnabled = debugToggle.checked;
    chrome.storage.sync.set({ isDebugEnabled });
});

modelSelect.addEventListener('change', () => {
    const modelProvider = modelSelect.value as any;
    chrome.storage.sync.set({ modelProvider }, () => {
        updateVisibility();
    });
});

speechSelect.addEventListener('change', () => {
    const speechProvider = speechSelect.value as any;
    chrome.storage.sync.set({ speechProvider }, () => {
        updateVisibility();
    });
});

djModeSelect.addEventListener('change', () => {
    const djMode = djModeSelect.value as any;
    chrome.storage.sync.set({ djMode });
});

portInput.addEventListener('change', () => {
    const localServerPort = parseInt(portInput.value);
    if (!isNaN(localServerPort)) {
        chrome.storage.sync.set({ localServerPort });
    }
});

geminiApiKeyInput.addEventListener('change', () => {
    const geminiApiKey = geminiApiKeyInput.value;
    chrome.storage.sync.set({ geminiApiKey });
});

testConnectionBtn.addEventListener('click', async () => {
    const port = portInput.value;
    connectionStatus.textContent = "Testing...";
    connectionStatus.className = "status-msg";

    try {
        const response = await fetch(`http://localhost:${port}/health`);
        if (response.ok) {
            connectionStatus.textContent = "Success!";
            connectionStatus.classList.add("success");
        } else {
            connectionStatus.textContent = "Failed (Status " + response.status + ")";
            connectionStatus.classList.add("error");
        }
    } catch (e) {
        connectionStatus.textContent = "Connection Refused";
        connectionStatus.classList.add("error");
    }
});


function updateVisibility() {
    const showLocalConfig = modelSelect.value === 'localserver' || speechSelect.value === 'localserver';
    if (showLocalConfig) {
        localServerConfig.classList.remove('hidden');
    } else {
        localServerConfig.classList.add('hidden');
    }

    if (modelSelect.value === 'gemini-api' || speechSelect.value === 'gemini-api') {
        geminiApiConfig.classList.remove('hidden');
    } else {
        geminiApiConfig.classList.add('hidden');
    }
}

function updateUI(isEnabled: boolean, isDebugEnabled: boolean) {
    toggle.checked = isEnabled;
    debugToggle.checked = isDebugEnabled;
    statusText.textContent = isEnabled ? 'Enabled' : 'Disabled';
}
