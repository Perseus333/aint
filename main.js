(function () {
  'use strict';

  /* ==========================================================================
     Constants
     ========================================================================== */
  var STORAGE_KEYS = {
    providers: 'aichat_providers',
    chats: 'aichat_chats',
    selectedModel: 'aichat_selected_model'
  };

  var THINK_OPEN = '<think>';
  var THINK_CLOSE = '</think>';

  /* ==========================================================================
     State
     ========================================================================== */
  var state = {
    providers: [],
    chats: [],
    activeChat: null,        // chat object currently displayed; may not be in state.chats yet
    selectedModel: null,     // { providerId, modelId } | null — decoupled from any chat
    editingProviderId: null, // null => provider form is in "add" mode
    editingChatId: null,     // id of chat currently being renamed inline
    isStreaming: false
  };

  /* ==========================================================================
     DOM references
     ========================================================================== */

  var el = {
    modelSelector: document.getElementById('model-select'), // Fixed
    chatList: document.getElementById('chat-list'),
    newChatBtn: document.getElementById('new-chat-btn'),
    providerList: document.getElementById('provider-list'),
    addProviderBtn: document.getElementById('add-provider-btn'),
    providerForm: document.getElementById('provider-overlay'), // Fixed (Targeting the overlay wrapper so hiding/showing works)
    providerFormName: document.getElementById('provider-name'), // Fixed
    providerFormBaseUrl: document.getElementById('provider-url'), // Fixed
    providerFormApiKey: document.getElementById('provider-form-apikey'), // Double check if you renamed this to 'provider-key' in HTML
    providerFormSave: document.querySelector('#provider-form button[type="submit"]'), // Fixed (Targeting the form's submit action)
    providerFormCancel: document.getElementById('provider-cancel-btn'), // Fixed
    providerFormDelete: document.getElementById('provider-delete-btn'), // Fixed
    messages: document.getElementById('message-stream'), // Fixed from previous step
    composer: document.getElementById('composer'),
    composerInput: document.getElementById('composer-input'),
    sendBtn: document.getElementById('composer-send') // Fixed
  };

  /* ==========================================================================
     Utilities
     ========================================================================== */
  function uid() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function formatLocalISO(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
      ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function stripTrailingSlash(url) {
    return String(url || '').trim().replace(/\/+$/, '');
  }

  function safeLocalStorageGet(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      console.error('Failed to read', key, e);
      return fallback;
    }
  }

  function safeLocalStorageSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.error('Failed to persist', key, e);
    }
  }

  /* ==========================================================================
     Persistence
     ========================================================================== */
  function syncToServer(endpoint, data) {
    fetch(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).catch(function (e) { console.warn('Server sync failed (' + endpoint + '):', e); });
  }

  async function loadState() {
    // Server is source of truth; localStorage is the fallback when server unreachable.
    try {
      var results = await Promise.all([
        fetch('/api/chats').then(function (r) { return r.json(); }),
        fetch('/api/providers').then(function (r) { return r.json(); })
      ]);
      state.chats     = results[0];
      state.providers = results[1];
      safeLocalStorageSet(STORAGE_KEYS.chats,     state.chats);
      safeLocalStorageSet(STORAGE_KEYS.providers, state.providers);
    } catch (e) {
      console.warn('Cannot reach server, falling back to localStorage:', e);
      state.chats     = safeLocalStorageGet(STORAGE_KEYS.chats,     []);
      state.providers = safeLocalStorageGet(STORAGE_KEYS.providers, []);
    }
    state.selectedModel = safeLocalStorageGet(STORAGE_KEYS.selectedModel, null);
  }

  function saveProviders() {
    safeLocalStorageSet(STORAGE_KEYS.providers, state.providers);
    syncToServer('/api/providers', state.providers);
  }

  function saveChats() {
    safeLocalStorageSet(STORAGE_KEYS.chats, state.chats);
    syncToServer('/api/chats', state.chats);
  }

  function saveSelectedModel() { safeLocalStorageSet(STORAGE_KEYS.selectedModel, state.selectedModel); }

  /* ==========================================================================
     Streaming <think> tag extractor
     Buffers content so a tag split across two SSE chunks is never misread
     as literal text, and never blocks output longer than necessary.
     ========================================================================== */
  function longestSuffixPrefixOverlap(str, tag) {
    var maxLen = Math.min(str.length, tag.length - 1);
    for (var len = maxLen; len > 0; len--) {
      if (str.slice(str.length - len) === tag.slice(0, len)) return len;
    }
    return 0;
  }

  function createTagStreamProcessor(handlers) {
    var onMain = handlers.onMain;
    var onThink = handlers.onThink;
    var pending = '';
    var inThink = false;

    function push(chunk) {
      pending += chunk;
      var progressed = true;
      while (progressed) {
        progressed = false;
        if (!inThink) {
          var openIdx = pending.indexOf(THINK_OPEN);
          if (openIdx !== -1) {
            if (openIdx > 0) onMain(pending.slice(0, openIdx));
            pending = pending.slice(openIdx + THINK_OPEN.length);
            inThink = true;
            progressed = true;
          } else {
            var overlapO = longestSuffixPrefixOverlap(pending, THINK_OPEN);
            var safeLenO = pending.length - overlapO;
            if (safeLenO > 0) {
              onMain(pending.slice(0, safeLenO));
              pending = pending.slice(safeLenO);
            }
          }
        } else {
          var closeIdx = pending.indexOf(THINK_CLOSE);
          if (closeIdx !== -1) {
            if (closeIdx > 0) onThink(pending.slice(0, closeIdx));
            pending = pending.slice(closeIdx + THINK_CLOSE.length);
            inThink = false;
            progressed = true;
          } else {
            var overlapC = longestSuffixPrefixOverlap(pending, THINK_CLOSE);
            var safeLenC = pending.length - overlapC;
            if (safeLenC > 0) {
              onThink(pending.slice(0, safeLenC));
              pending = pending.slice(safeLenC);
            }
          }
        }
      }
    }

    function flush() {
      if (pending) {
        if (inThink) onThink(pending); else onMain(pending);
        pending = '';
      }
    }

    return { push: push, flush: flush };
  }

  /* ==========================================================================
     Markdown / KaTeX rendering
     ========================================================================== */
  function renderMarkdown(text) {
    try {
      return marked.parse(text || '', { breaks: true });
    } catch (e) {
      return '<p>' + escapeHtml(text || '') + '</p>';
    }
  }

  function renderMathInScope(scopeEl) {
    if (window.renderMathInElement) {
      try {
        renderMathInElement(scopeEl, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '\\[', right: '\\]', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\(', right: '\\)', display: false }
          ],
          throwOnError: false
        });
      } catch (e) {
        console.error('KaTeX render error', e);
      }
    }
  }

  function scrollMessagesToBottom() {
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  /* ==========================================================================
     Chat list rendering (sidebar middle zone)
     ========================================================================== */
  function renderChatList() {
    el.chatList.innerHTML = '';
    var sorted = state.chats.slice().sort(function (a, b) { return b.createdAt - a.createdAt; });

    for (var i = 0; i < sorted.length; i++) {
      var chat = sorted[i];
      var li = document.createElement('li');
      li.className = 'chat-item';
      li.dataset.id = chat.id;
      if (state.activeChat && chat.id === state.activeChat.id) {
        li.classList.add('active');
      }

      if (state.editingChatId === chat.id) {
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'chat-item-rename-input';
        input.value = chat.title;
        (function (chatId, inputEl) {
          inputEl.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); commitRename(chatId, inputEl.value); }
            if (e.key === 'Escape') { state.editingChatId = null; renderChatList(); }
          });
          inputEl.addEventListener('blur', function () { commitRename(chatId, inputEl.value); });
        })(chat.id, input);
        li.appendChild(input);
        el.chatList.appendChild(li);
        (function (inputEl) {
          requestAnimationFrame(function () { inputEl.focus(); inputEl.select(); });
        })(input);
        continue;
      }

      var titleBtn = document.createElement('button');
      titleBtn.type = 'button';
      titleBtn.className = 'chat-item-title';
      titleBtn.textContent = chat.title;
      titleBtn.title = chat.title;
      (function (chatId) {
        titleBtn.addEventListener('click', function () { selectChat(chatId); });
      })(chat.id);

      var editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'chat-item-edit';
      editBtn.setAttribute('aria-label', 'Rename chat');
      editBtn.textContent = '\u270E';
      (function (chatId) {
        editBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          state.editingChatId = chatId;
          renderChatList();
        });
      })(chat.id);

      li.appendChild(titleBtn);
      li.appendChild(editBtn);
      el.chatList.appendChild(li);
    }
  }

  function commitRename(chatId, newTitle) {
    var trimmed = (newTitle || '').trim();
    var chat = null;
    for (var i = 0; i < state.chats.length; i++) {
      if (state.chats[i].id === chatId) { chat = state.chats[i]; break; }
    }
    if (chat && trimmed) {
      chat.title = trimmed;
      saveChats();
    }
    state.editingChatId = null;
    renderChatList();
  }

  function createNewChat() {
    if (state.isStreaming) return;
    state.activeChat = {
      id: uid(),
      title: formatLocalISO(new Date()),
      createdAt: Date.now(),
      messages: []
    };
    renderChatList();
    renderMessages();
  }

  function persistActiveChatIfNeeded() {
    var exists = false;
    for (var i = 0; i < state.chats.length; i++) {
      if (state.chats[i].id === state.activeChat.id) { exists = true; break; }
    }
    if (!exists) {
      state.chats.push(state.activeChat);
      saveChats();
      renderChatList();
    }
  }

  function selectChat(id) {
    if (state.isStreaming) return;
    var chat = null;
    for (var i = 0; i < state.chats.length; i++) {
      if (state.chats[i].id === id) { chat = state.chats[i]; break; }
    }
    if (!chat) return;
    state.activeChat = chat;
    renderChatList();
    renderMessages();
  }

  /* ==========================================================================
     Message rendering (chat pane)
     ========================================================================== */
  function buildMessageElement(msg) {
    var wrapper = document.createElement('div');
    wrapper.className = 'message message-' + msg.role;
    wrapper.dataset.id = msg.id;

    if (msg.role === 'assistant' && msg.thinking) {
      var details = document.createElement('details');
      details.className = 'think-block';
      var summary = document.createElement('summary');
      summary.textContent = 'Thought process';
      var thinkBody = document.createElement('div');
      thinkBody.className = 'think-body';
      thinkBody.textContent = msg.thinking;
      details.appendChild(summary);
      details.appendChild(thinkBody);
      wrapper.appendChild(details);
    }

    var body = document.createElement('div');
    body.className = 'message-body';
    body.innerHTML = renderMarkdown(msg.content || '');
    wrapper.appendChild(body);

    return wrapper;
  }

  function renderMessages() {
    el.messages.innerHTML = '';
    if (!state.activeChat) return;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < state.activeChat.messages.length; i++) {
      frag.appendChild(buildMessageElement(state.activeChat.messages[i]));
    }
    el.messages.appendChild(frag);
    renderMathInScope(el.messages);
    scrollMessagesToBottom();
  }

  /* ==========================================================================
     Provider management (sidebar bottom zone)
     ========================================================================== */
  function renderProviderList() {
    el.providerList.innerHTML = '';
    if (state.providers.length === 0) {
      var empty = document.createElement('li');
      empty.className = 'provider-empty';
      empty.textContent = 'No providers yet';
      el.providerList.appendChild(empty);
      return;
    }
    for (var i = 0; i < state.providers.length; i++) {
      var p = state.providers[i];
      var li = document.createElement('li');
      li.className = 'provider-item';
      li.dataset.id = p.id;

      var name = document.createElement('span');
      name.className = 'provider-name';
      name.textContent = p.name;
      name.title = p.baseUrl;

      var editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'provider-edit-btn';
      editBtn.textContent = 'Edit';
      (function (providerId) {
        editBtn.addEventListener('click', function () { openProviderForm(providerId); });
      })(p.id);

      li.appendChild(name);
      li.appendChild(editBtn);
      el.providerList.appendChild(li);
    }
  }

  function openProviderForm(providerId) {
    state.editingProviderId = providerId || null;
    if (providerId) {
      var provider = null;
      for (var i = 0; i < state.providers.length; i++) {
        if (state.providers[i].id === providerId) { provider = state.providers[i]; break; }
      }
      if (!provider) return;
      el.providerFormName.value = provider.name;
      el.providerFormBaseUrl.value = provider.baseUrl;
      el.providerFormApiKey.value = provider.apiKey;
      el.providerFormDelete.hidden = false;
    } else {
      el.providerFormName.value = '';
      el.providerFormBaseUrl.value = '';
      el.providerFormApiKey.value = '';
      el.providerFormDelete.hidden = true;
    }
    el.providerForm.hidden = false;
    el.providerFormName.focus();
  }

  function closeProviderForm() {
    el.providerForm.hidden = true;
    state.editingProviderId = null;
  }

  function saveProviderForm() {
    var name = el.providerFormName.value.trim();
    var baseUrl = stripTrailingSlash(el.providerFormBaseUrl.value);
    var apiKey = el.providerFormApiKey.value.trim();

    if (!name || !baseUrl) {
      alert('Display name and base URL are required.');
      return;
    }

    if (state.editingProviderId) {
      for (var i = 0; i < state.providers.length; i++) {
        if (state.providers[i].id === state.editingProviderId) {
          state.providers[i].name = name;
          state.providers[i].baseUrl = baseUrl;
          state.providers[i].apiKey = apiKey;
          break;
        }
      }
    } else {
      state.providers.push({ id: uid(), name: name, baseUrl: baseUrl, apiKey: apiKey });
    }

    saveProviders();
    renderProviderList();
    closeProviderForm();
    populateModelSelector();
  }

  function deleteProviderForm() {
    if (!state.editingProviderId) return;
    if (!confirm('Remove this provider? This cannot be undone.')) return;
    var idToRemove = state.editingProviderId;
    state.providers = state.providers.filter(function (p) { return p.id !== idToRemove; });
    saveProviders();
    renderProviderList();
    closeProviderForm();
    populateModelSelector();
  }

  /* ==========================================================================
     Model discovery + global selector
     ========================================================================== */
  function fetchModelsForProvider(provider) {
    var headers = {};
    if (provider.apiKey) headers.Authorization = 'Bearer ' + provider.apiKey;

    return fetch(provider.baseUrl + '/models', { headers: headers }).then(function (res) {
      if (!res.ok) throw new Error(provider.name + ': HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      var list = Array.isArray(data.data) ? data.data : (Array.isArray(data.models) ? data.models : []);
      return list
        .map(function (m) { return typeof m === 'string' ? m : (m && m.id); })
        .filter(Boolean)
        .sort();
    });
  }

  function currentSelectedValue() {
    return state.selectedModel ? (state.selectedModel.providerId + '::' + state.selectedModel.modelId) : null;
  }

  function updateSelectedModelFromDropdown() {
    var value = el.modelSelector.value;
    var sep = value ? value.indexOf('::') : -1;
    if (sep === -1) {
      state.selectedModel = null;
    } else {
      state.selectedModel = {
        providerId: value.slice(0, sep),
        modelId: value.slice(sep + 2)
      };
    }
    saveSelectedModel();
  }

  function populateModelSelector() {
    var previousValue = currentSelectedValue();
    el.modelSelector.innerHTML = '';

    if (state.providers.length === 0) {
      var opt = document.createElement('option');
      opt.textContent = 'No providers configured';
      opt.disabled = true;
      opt.selected = true;
      el.modelSelector.appendChild(opt);
      state.selectedModel = null;
      saveSelectedModel();
      return Promise.resolve();
    }

    var loading = document.createElement('option');
    loading.textContent = 'Loading models\u2026';
    loading.disabled = true;
    loading.selected = true;
    el.modelSelector.appendChild(loading);

    return Promise.all(state.providers.map(function (provider) {
      return fetchModelsForProvider(provider).then(function (models) {
        return { provider: provider, models: models, error: null };
      }).catch(function (err) {
        return { provider: provider, models: [], error: err };
      });
    })).then(function (results) {
      el.modelSelector.innerHTML = '';
      var matchedPrevious = false;

      for (var i = 0; i < results.length; i++) {
        var provider = results[i].provider;
        var models = results[i].models;
        var error = results[i].error;

        var group = document.createElement('optgroup');
        group.label = error ? (provider.name + ' (unavailable)') : provider.name;

        if (error) {
          var errOpt = document.createElement('option');
          errOpt.disabled = true;
          errOpt.textContent = 'Could not load models';
          group.appendChild(errOpt);
        } else if (models.length === 0) {
          var emptyOpt = document.createElement('option');
          emptyOpt.disabled = true;
          emptyOpt.textContent = 'No models returned';
          group.appendChild(emptyOpt);
        } else {
          for (var j = 0; j < models.length; j++) {
            var modelId = models[j];
            var modelOpt = document.createElement('option');
            var value = provider.id + '::' + modelId;
            modelOpt.value = value;
            modelOpt.textContent = modelId;
            if (value === previousValue) {
              modelOpt.selected = true;
              matchedPrevious = true;
            }
            group.appendChild(modelOpt);
          }
        }
        el.modelSelector.appendChild(group);
      }

      if (!matchedPrevious) {
        var options = el.modelSelector.options;
        for (var k = 0; k < options.length; k++) {
          if (!options[k].disabled) { options[k].selected = true; break; }
        }
      }

      updateSelectedModelFromDropdown();
    });
  }

  /* ==========================================================================
     Sending messages + SSE streaming engine
     ========================================================================== */
  function setStreaming(value) {
    state.isStreaming = value;
    el.sendBtn.disabled = value;
    el.composerInput.disabled = value;
  }

  function autoGrowTextarea() {
    el.composerInput.style.height = 'auto';
    el.composerInput.style.height = Math.min(el.composerInput.scrollHeight, 200) + 'px';
  }

  function handleComposerSubmit(e) {
    e.preventDefault();
    if (state.isStreaming) return;

    var text = el.composerInput.value.trim();
    if (!text) return;

    if (!state.selectedModel) {
      alert('Choose a model from the sidebar first (add a provider if the list is empty).');
      return;
    }

    el.composerInput.value = '';
    autoGrowTextarea();

    var userMsg = { id: uid(), role: 'user', content: text };
    state.activeChat.messages.push(userMsg);
    persistActiveChatIfNeeded();
    el.messages.appendChild(buildMessageElement(userMsg));
    renderMathInScope(el.messages);
    scrollMessagesToBottom();
    saveChats();

    sendToModel();
  }

  function sendToModel() {
    var chat = state.activeChat;
    var providerId = state.selectedModel.providerId;
    var modelId = state.selectedModel.modelId;
    var provider = null;
    for (var i = 0; i < state.providers.length; i++) {
      if (state.providers[i].id === providerId) { provider = state.providers[i]; break; }
    }
    if (!provider) {
      alert('The provider for the selected model is no longer configured.');
      return Promise.resolve();
    }

    var assistantMsg = { id: uid(), role: 'assistant', content: '', thinking: '', model: modelId };
    chat.messages.push(assistantMsg);

    var wrapper = document.createElement('div');
    wrapper.className = 'message message-assistant';
    wrapper.dataset.id = assistantMsg.id;

    var thinkDetails = document.createElement('details');
    thinkDetails.className = 'think-block';
    thinkDetails.hidden = true;
    var summary = document.createElement('summary');
    summary.textContent = 'Thinking\u2026';
    var thinkBody = document.createElement('div');
    thinkBody.className = 'think-body';
    thinkDetails.appendChild(summary);
    thinkDetails.appendChild(thinkBody);

    var bodyEl = document.createElement('div');
    bodyEl.className = 'message-body streaming';

    wrapper.appendChild(thinkDetails);
    wrapper.appendChild(bodyEl);
    el.messages.appendChild(wrapper);
    scrollMessagesToBottom();

    var processor = createTagStreamProcessor({
      onMain: function (chunk) {
        assistantMsg.content += chunk;
        bodyEl.textContent = assistantMsg.content;
        scrollMessagesToBottom();
      },
      onThink: function (chunk) {
        assistantMsg.thinking += chunk;
        if (thinkDetails.hidden) thinkDetails.hidden = false;
        thinkBody.textContent = assistantMsg.thinking;
        scrollMessagesToBottom();
      }
    });

    setStreaming(true);

    var outgoingMessages = chat.messages
      .filter(function (m) { return m.id !== assistantMsg.id; })
      .map(function (m) { return { role: m.role, content: m.content }; });

    var headers = { 'Content-Type': 'application/json' };
    if (provider.apiKey) headers.Authorization = 'Bearer ' + provider.apiKey;

    return fetch(provider.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ model: modelId, messages: outgoingMessages, stream: true })
    }).then(function (res) {
      if (!res.ok || !res.body) {
        return res.text().catch(function () { return ''; }).then(function (errText) {
          throw new Error('HTTP ' + res.status + ' ' + errText);
        });
      }

      var reader = res.body.getReader();
      var decoder = new TextDecoder('utf-8');
      var sseBuffer = '';

      function pump() {
        return reader.read().then(function (result) {
          if (result.done) return;
          sseBuffer += decoder.decode(result.value, { stream: true });
          var lines = sseBuffer.split('\n');
          sseBuffer = lines.pop();

          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line || line.indexOf('data:') !== 0) continue;
            var payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;

            var json;
            try {
              json = JSON.parse(payload);
            } catch (e) {
              continue;
            }

            var choice = json.choices && json.choices[0];
            var delta = choice && (choice.delta ? choice.delta.content : choice.text);
            if (delta) processor.push(delta);
          }

          return pump();
        });
      }

      return pump();
    }).then(function () {
      processor.flush();
    }).catch(function (err) {
      processor.flush();
      var prefix = assistantMsg.content ? '\n\n' : '';
      assistantMsg.content += prefix + '\u26A0\uFE0F Error: ' + err.message;
      bodyEl.textContent = assistantMsg.content;
    }).then(function () {
      bodyEl.classList.remove('streaming');
      bodyEl.innerHTML = renderMarkdown(assistantMsg.content);
      renderMathInScope(wrapper);
      setStreaming(false);
      saveChats();
      scrollMessagesToBottom();
    });
  }

  /* ==========================================================================
     Init
     ========================================================================== */
  function bindEvents() {
    el.modelSelector.addEventListener('change', updateSelectedModelFromDropdown);
    el.newChatBtn.addEventListener('click', createNewChat);

    el.addProviderBtn.addEventListener('click', function () { openProviderForm(null); });
    el.providerFormSave.addEventListener('click', saveProviderForm);
    el.providerFormCancel.addEventListener('click', closeProviderForm);
    el.providerFormDelete.addEventListener('click', deleteProviderForm);

    el.composer.addEventListener('submit', handleComposerSubmit);
    el.composerInput.addEventListener('input', autoGrowTextarea);
    el.composerInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        el.composer.requestSubmit();
      }
    });
  }

  async function init() {
    await loadState();
    renderProviderList();
    renderChatList();
    createNewChat(); // always boot into a brand-new, blank session
    bindEvents();
    populateModelSelector();
  }

  document.addEventListener('DOMContentLoaded', init);
})();

