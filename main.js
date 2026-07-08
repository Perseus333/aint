"use strict";

/* ============================================================
   STORAGE KEYS
============================================================ */
const LS_PROVIDERS = "lac_providers";
const LS_CHATS = "lac_chats";
const LS_SELECTED_MODEL = "lac_selected_model";

/* ============================================================
   STATE
============================================================ */
let providers = loadJSON(LS_PROVIDERS, []);
// provider: { id, name, baseUrl, apiKey, models: [modelId, ...] }

let chats = loadJSON(LS_CHATS, []);
// chat: { id, title, titleCustom, messages: [{role, content}], createdAt }

let currentChatId = null;
let editingProviderId = null; // null = "add" mode
let isStreaming = false;
let streamAbortController = null;

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (err) {
    return fallback;
  }
}

function persistProviders() {
  localStorage.setItem(LS_PROVIDERS, JSON.stringify(providers));
}

function persistChats() {
  localStorage.setItem(LS_CHATS, JSON.stringify(chats));
}

/* ============================================================
   DOM REFERENCES
============================================================ */
const modelSelect = document.getElementById("model-select");
const chatListEl = document.getElementById("chat-list");
const chatListEmptyEl = document.getElementById("chat-list-empty");
const newChatBtn = document.getElementById("new-chat-btn");

const providerListEl = document.getElementById("provider-list");
const providerListEmptyEl = document.getElementById("provider-list-empty");
const addProviderBtn = document.getElementById("add-provider-btn");

const providerOverlay = document.getElementById("provider-overlay");
const providerForm = document.getElementById("provider-form");
const providerFormTitle = document.getElementById("provider-form-title");
const providerNameInput = document.getElementById("provider-name");
const providerUrlInput = document.getElementById("provider-url");
const providerKeyInput = document.getElementById("provider-key");
const providerDeleteBtn = document.getElementById("provider-delete-btn");
const providerCancelBtn = document.getElementById("provider-cancel-btn");

const messageStreamEl = document.getElementById("message-stream");
const streamEmptyEl = document.getElementById("stream-empty");

const composerForm = document.getElementById("composer");
const composerInput = document.getElementById("composer-input");
const composerSendBtn = document.getElementById("composer-send");

/* ============================================================
   UTIL
============================================================ */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function isoLocalTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    " " +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes())
  );
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function findChat(id) {
  return chats.find((c) => c.id === id) || null;
}

function findProvider(id) {
  return providers.find((p) => p.id === id) || null;
}

/* ============================================================
   MODEL SELECT (decoupled global dropdown)
============================================================ */
function renderModelSelect() {
  const previousValue = modelSelect.value;
  modelSelect.innerHTML = "";

  const allOptions = [];
  providers.forEach((p) => {
    (p.models || []).forEach((modelId) => {
      allOptions.push({ providerId: p.id, providerName: p.name, modelId });
    });
  });

  if (allOptions.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.disabled = true;
    opt.selected = true;
    opt.textContent = providers.length === 0 ? "No providers configured" : "No models available";
    modelSelect.appendChild(opt);
    return;
  }

  allOptions.forEach(({ providerId, providerName, modelId }) => {
    const opt = document.createElement("option");
    opt.value = providerId + "::" + modelId;
    opt.textContent = providerName + " / " + modelId;
    modelSelect.appendChild(opt);
  });

  const stored = localStorage.getItem(LS_SELECTED_MODEL);
  const candidateValue = previousValue || stored;
  const match = allOptions.find((o) => o.providerId + "::" + o.modelId === candidateValue);
  if (match) {
    modelSelect.value = candidateValue;
  } else {
    modelSelect.value = allOptions[0].providerId + "::" + allOptions[0].modelId;
  }
  localStorage.setItem(LS_SELECTED_MODEL, modelSelect.value);
}

modelSelect.addEventListener("change", () => {
  localStorage.setItem(LS_SELECTED_MODEL, modelSelect.value);
});

async function fetchModelsForProvider(provider) {
  try {
    const res = await fetch(joinUrl(provider.baseUrl, "/models"), {
      method: "GET",
      headers: provider.apiKey ? { Authorization: "Bearer " + provider.apiKey } : {},
    });
    if (!res.ok) return { providerId: provider.id, models: [] };
    const json = await res.json();
    const list = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
    const models = list
      .map((m) => (typeof m === "string" ? m : m && m.id))
      .filter(Boolean);
    return { providerId: provider.id, models };
  } catch (err) {
    return { providerId: provider.id, models: [] };
  }
}

function joinUrl(base, path) {
  return base.replace(/\/+$/, "") + path;
}

async function refreshAllModels() {
  if (providers.length === 0) {
    renderModelSelect();
    return;
  }
  const results = await Promise.all(providers.map((p) => fetchModelsForProvider(p)));
  results.forEach(({ providerId, models }) => {
    const p = findProvider(providerId);
    if (p) p.models = models;
  });
  persistProviders();
  renderModelSelect();
}

/* ============================================================
   PROVIDER MANAGEMENT
============================================================ */
function renderProviderList() {
  providerListEl.innerHTML = "";
  providerListEmptyEl.hidden = providers.length !== 0;

  providers.forEach((p) => {
    const li = document.createElement("li");
    li.className = "provider-item";

    const nameSpan = document.createElement("span");
    nameSpan.className = "provider-item-name";
    nameSpan.textContent = p.name;

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "provider-item-edit";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => openProviderOverlay(p.id));

    li.appendChild(nameSpan);
    li.appendChild(editBtn);
    providerListEl.appendChild(li);
  });
}

function openProviderOverlay(providerId) {
  editingProviderId = providerId || null;
  const provider = providerId ? findProvider(providerId) : null;

  providerFormTitle.textContent = provider ? "Edit Provider" : "Add Provider";
  providerNameInput.value = provider ? provider.name : "";
  providerUrlInput.value = provider ? provider.baseUrl : "";
  providerKeyInput.value = provider ? provider.apiKey : "";
  providerDeleteBtn.hidden = !provider;

  providerOverlay.hidden = false;
  providerNameInput.focus();
}

function closeProviderOverlay() {
  providerOverlay.hidden = true;
  editingProviderId = null;
  providerForm.reset();
}

addProviderBtn.addEventListener("click", () => openProviderOverlay(null));
providerCancelBtn.addEventListener("click", closeProviderOverlay);

providerOverlay.addEventListener("click", (e) => {
  if (e.target === providerOverlay) closeProviderOverlay();
});

providerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = providerNameInput.value.trim();
  const baseUrl = providerUrlInput.value.trim();
  const apiKey = providerKeyInput.value;

  if (!name || !baseUrl) return;

  if (editingProviderId) {
    const p = findProvider(editingProviderId);
    if (p) {
      p.name = name;
      p.baseUrl = baseUrl;
      p.apiKey = apiKey;
    }
  } else {
    providers.push({ id: uid(), name, baseUrl, apiKey, models: [] });
  }

  persistProviders();
  renderProviderList();
  closeProviderOverlay();
  await refreshAllModels();
});

providerDeleteBtn.addEventListener("click", () => {
  if (!editingProviderId) return;
  providers = providers.filter((p) => p.id !== editingProviderId);
  persistProviders();
  renderProviderList();
  renderModelSelect();
  closeProviderOverlay();
});

/* ============================================================
   CHAT LIST
============================================================ */
function renderChatList() {
  chatListEl.innerHTML = "";
  chatListEmptyEl.hidden = chats.length !== 0;

  const sorted = [...chats].sort((a, b) => b.createdAt - a.createdAt);

  sorted.forEach((chat) => {
    const li = document.createElement("li");
    li.className = "chat-item" + (chat.id === currentChatId ? " active" : "");

    const titleSpan = document.createElement("span");
    titleSpan.className = "chat-item-title";
    titleSpan.textContent = chat.title;
    titleSpan.addEventListener("click", () => selectChat(chat.id));

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "chat-item-edit";
    editBtn.textContent = "✎";
    editBtn.title = "Rename chat";
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      beginTitleEdit(li, chat);
    });

    li.appendChild(titleSpan);
    li.appendChild(editBtn);
    chatListEl.appendChild(li);
  });
}

function beginTitleEdit(li, chat) {
  li.innerHTML = "";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "chat-item-title-input";
  input.value = chat.title;
  li.appendChild(input);
  input.focus();
  input.select();

  function commit() {
    const val = input.value.trim();
    if (val) {
      chat.title = val;
      chat.titleCustom = true;
      persistChats();
    }
    renderChatList();
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      renderChatList();
    }
  });
  input.addEventListener("blur", commit);
}

let activeChat = null;

function createNewChat() {
  const chat = {
    id: uid(),
    title: isoLocalTimestamp(),
    titleCustom: false,
    messages: [],
    createdAt: Date.now(),
    persisted: false,
  };
  currentChatId = chat.id;
  activeChat = chat;
  // Not pushed into `chats` / localStorage until the first message is sent.
  renderChatList();
  renderMessages(chat);
  return chat;
}

function selectChat(id) {
  currentChatId = id;
  activeChat = findChat(id);
  renderChatList();
  renderMessages(activeChat);
}

newChatBtn.addEventListener("click", () => {
  if (isStreaming) return;
  createNewChat();
});

/* ============================================================
   MESSAGE RENDERING
============================================================ */
function getActiveChat() {
  return activeChat;
}

function renderMessages(chat) {
  messageStreamEl.querySelectorAll(".message").forEach((el) => el.remove());
  if (!chat || chat.messages.length === 0) {
    streamEmptyEl.hidden = false;
    return;
  }
  streamEmptyEl.hidden = true;
  chat.messages.forEach((msg) => {
    const { wrapper } = buildMessageElement(msg.role);
    updateMessageContent(wrapper, msg.content, false);
    messageStreamEl.appendChild(wrapper);
  });
  scrollStreamToBottom();
}

function buildMessageElement(role) {
  const wrapper = document.createElement("div");
  wrapper.className = "message role-" + role;

  const label = document.createElement("p");
  label.className = "message-role-label";
  label.textContent = role === "user" ? "You" : "Assistant";

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";

  const thinkingEl = document.createElement("details");
  thinkingEl.className = "thinking-block";
  thinkingEl.hidden = true;
  const summary = document.createElement("summary");
  const dot = document.createElement("span");
  dot.className = "thinking-dot";
  const summaryText = document.createElement("span");
  summaryText.textContent = "Thinking...";
  summary.appendChild(dot);
  summary.appendChild(summaryText);
  const thinkingBody = document.createElement("div");
  thinkingBody.className = "thinking-body";
  thinkingEl.appendChild(summary);
  thinkingEl.appendChild(thinkingBody);

  const contentEl = document.createElement("div");
  contentEl.className = "message-content";

  bubble.appendChild(thinkingEl);
  bubble.appendChild(contentEl);
  wrapper.appendChild(label);
  wrapper.appendChild(bubble);

  return { wrapper, thinkingEl, thinkingBody, summaryText, dot, contentEl };
}

function scrollStreamToBottom() {
  messageStreamEl.scrollTop = messageStreamEl.scrollHeight;
}

/* Splits raw text into { thinking, visible } handling an in-progress
   (still-streaming, unclosed) <think> block. */
function splitThinking(raw) {
  const OPEN = "<think>";
  const CLOSE = "</think>";
  let thinking = "";
  let visible = "";
  let i = 0;
  while (i < raw.length) {
    const openIdx = raw.indexOf(OPEN, i);
    if (openIdx === -1) {
      visible += raw.slice(i);
      break;
    }
    visible += raw.slice(i, openIdx);
    const closeIdx = raw.indexOf(CLOSE, openIdx + OPEN.length);
    if (closeIdx === -1) {
      thinking += raw.slice(openIdx + OPEN.length);
      i = raw.length;
      break;
    }
    thinking += raw.slice(openIdx + OPEN.length, closeIdx);
    i = closeIdx + CLOSE.length;
  }
  return { thinking, visible };
}

function updateMessageContent(wrapperOrRefs, rawContent, isLive) {
  let refs = wrapperOrRefs;
  if (refs instanceof HTMLElement) {
    refs = {
      thinkingEl: refs.querySelector(".thinking-block"),
      thinkingBody: refs.querySelector(".thinking-body"),
      summaryText: refs.querySelector(".thinking-block summary span:last-child"),
      dot: refs.querySelector(".thinking-dot"),
      contentEl: refs.querySelector(".message-content"),
    };
  }

  const { thinking, visible } = splitThinking(rawContent);

  if (thinking) {
    refs.thinkingEl.hidden = false;
    refs.thinkingBody.textContent = thinking;
  } else {
    refs.thinkingEl.hidden = true;
  }

  const stillThinking = isLive && rawContent.includes("<think>") && !isThinkClosed(rawContent);
  if (refs.dot) refs.dot.classList.toggle("pulsing", !!stillThinking);
  if (refs.summaryText) refs.summaryText.textContent = stillThinking ? "Thinking..." : "Thought";

  try {
    refs.contentEl.innerHTML = window.marked ? marked.parse(visible) : escapeHtml(visible);
  } catch (err) {
    refs.contentEl.textContent = visible;
  }

  if (window.renderMathInElement) {
    try {
      renderMathInElement(refs.contentEl, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "\\[", right: "\\]", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false },
        ],
        throwOnError: false,
      });
    } catch (err) {
      /* ignore render errors for partial/streaming LaTeX */
    }
  }
}

function isThinkClosed(raw) {
  const lastOpen = raw.lastIndexOf("<think>");
  if (lastOpen === -1) return true;
  return raw.indexOf("</think>", lastOpen) !== -1;
}

/* ============================================================
   SENDING MESSAGES / SSE STREAMING
============================================================ */
composerInput.addEventListener("input", () => {
  composerInput.style.height = "auto";
  composerInput.style.height = Math.min(composerInput.scrollHeight, 200) + "px";
});

composerInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    composerForm.requestSubmit();
  }
});

composerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (isStreaming) return;

  const text = composerInput.value.trim();
  if (!text) return;

  const modelValue = modelSelect.value;
  if (!modelValue || modelValue.indexOf("::") === -1) {
    alert("Configure a provider and select a model before sending a message.");
    return;
  }

  let chat = getActiveChat();
  if (!chat) {
    chat = createNewChat();
  }
  if (!chat.persisted) {
    chat.persisted = true;
    chats.push(chat);
  }

  chat.messages.push({ role: "user", content: text });
  persistChats();

  composerInput.value = "";
  composerInput.style.height = "auto";
  streamEmptyEl.hidden = true;

  const { wrapper: userWrapper } = buildMessageElement("user");
  updateMessageContent(userWrapper, text, false);
  messageStreamEl.appendChild(userWrapper);

  renderChatList();
  scrollStreamToBottom();

  await streamAssistantReply(chat, modelValue);
});

async function streamAssistantReply(chat, modelValue) {
  const [providerId, modelId] = modelValue.split("::");
  const provider = findProvider(providerId);
  if (!provider) {
    alert("The selected provider is no longer available.");
    return;
  }

  const assistantMsg = { role: "assistant", content: "" };
  chat.messages.push(assistantMsg);

  const refs = buildMessageElement("assistant");
  messageStreamEl.appendChild(refs.wrapper);
  scrollStreamToBottom();

  isStreaming = true;
  composerSendBtn.disabled = true;

  let rawContent = "";
  let renderScheduled = false;

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      updateMessageContent(refs.wrapper, rawContent, true);
      scrollStreamToBottom();
    });
  }

  streamAbortController = new AbortController();

  try {
    const response = await fetch(joinUrl(provider.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(provider.apiKey ? { Authorization: "Bearer " + provider.apiKey } : {}),
      },
      body: JSON.stringify({
        model: modelId,
        stream: true,
        messages: chat.messages
          .slice(0, -1)
          .map((m) => ({ role: m.role, content: m.content })),
      }),
      signal: streamAbortController.signal,
    });

    if (!response.ok || !response.body) {
      const errText = await safeReadText(response);
      rawContent = "Error: request failed (" + response.status + "). " + errText;
      scheduleRender();
    } else {
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") continue;

          try {
            const json = JSON.parse(payload);
            const delta =
              (json.choices &&
                json.choices[0] &&
                json.choices[0].delta &&
                json.choices[0].delta.content) ||
              "";
            if (delta) {
              rawContent += delta;
              assistantMsg.content = rawContent;
              scheduleRender();
            }
          } catch (err) {
            /* ignore malformed SSE fragments */
          }
        }
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      rawContent += "\n\n[Connection error: " + err.message + "]";
    }
  } finally {
    assistantMsg.content = rawContent;
    updateMessageContent(refs.wrapper, rawContent, false);
    persistChats();
    isStreaming = false;
    composerSendBtn.disabled = false;
    streamAbortController = null;
  }
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch (err) {
    return "";
  }
}

/* ============================================================
   BOOT
============================================================ */
function init() {
  renderProviderList();
  renderChatList();
  createNewChat();
  renderModelSelect();
  refreshAllModels();
}

init();
