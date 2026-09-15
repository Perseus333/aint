(function () {
  'use strict';

  var STORAGE_KEYS = {
    providers: 'aichat_providers',
    chats: 'aichat_chats',
    selectedModel: 'aichat_selected_model'
  };

  var THINK_OPEN = '<think>';
  var THINK_CLOSE = '</think>';

  var state = {
    providers: [],
    chats: [],
    activeChat: null,
    selectedModel: null,
    editingProviderId: null,
    editingChatId: null,
    isStreaming: false,
    sidebarOpen: true
  };

  var el = {
    shell: document.querySelector('.shell'),
    status: document.getElementById('app-status'),
    sidebar: document.querySelector('.sidebar'),
    modelSearch: document.getElementById('model-search'),
    modelSelector: document.getElementById('model-select'),
    chatBrand: document.getElementById('chat-brand'),
    chatModelIndicator: document.getElementById('chat-model-indicator'),
    chatList: document.getElementById('chat-list'),
    chatListEmpty: document.getElementById('chat-list-empty'),
    newChatBtn: document.getElementById('new-chat-btn'),
    providerList: document.getElementById('provider-list'),
    providerListEmpty: document.getElementById('provider-list-empty'),
    addProviderBtn: document.getElementById('add-provider-btn'),
    providerForm: document.getElementById('provider-overlay'),
    providerFormName: document.getElementById('provider-name'),
    providerFormBaseUrl: document.getElementById('provider-url'),
    providerFormApiKey: document.getElementById('provider-form-apikey'),
    providerFormSave: document.querySelector('#provider-form button[type="submit"]'),
    providerFormCancel: document.getElementById('provider-cancel-btn'),
    providerFormDelete: document.getElementById('provider-delete-btn'),
    providerTestBtn: document.getElementById('provider-test-btn'),
    messages: document.getElementById('message-stream'),
    composer: document.getElementById('composer'),
    composerInput: document.getElementById('composer-input'),
    sendBtn: document.getElementById('composer-send')
  };

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
    } catch (err) {
      console.error('Failed to read', key, err);
      return fallback;
    }
  }

  function safeLocalStorageSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      console.error('Failed to persist', key, err);
    }
  }

  function setStatus(message, tone) {
    if (!message) {
      el.status.hidden = true;
      el.status.textContent = '';
      el.status.className = 'status-banner';
      return;
    }

    el.status.textContent = message;
    el.status.className = 'status-banner ' + (tone || 'info');
    el.status.hidden = false;
  }

  function saveProviders() {
    safeLocalStorageSet(STORAGE_KEYS.providers, state.providers);
  }

  function saveChats() {
    safeLocalStorageSet(STORAGE_KEYS.chats, state.chats);
  }

  function saveSelectedModel() {
    safeLocalStorageSet(STORAGE_KEYS.selectedModel, state.selectedModel);
  }

  function loadState() {
    state.chats = safeLocalStorageGet(STORAGE_KEYS.chats, []);
    state.providers = safeLocalStorageGet(STORAGE_KEYS.providers, []);
    state.selectedModel = safeLocalStorageGet(STORAGE_KEYS.selectedModel, null);

    if (!Array.isArray(state.chats)) state.chats = [];
    if (!Array.isArray(state.providers)) state.providers = [];
  }

  function shouldUseMobileLayout() {
    var width = window.innerWidth || document.documentElement.clientWidth || 0;
    var height = window.innerHeight || document.documentElement.clientHeight || 0;
    var ratio = width && height ? width / height : 0;
    var laptopMedia = window.matchMedia && window.matchMedia('(hover: hover)').matches;
    var coarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    var isLaptopLike = width >= 980 && height >= 620 && ratio >= 1.2 && ratio <= 2.2 && laptopMedia && !coarsePointer;
    return !isLaptopLike;
  }

  function syncSidebarState() {
    if (!el.shell) return;
    var mobile = shouldUseMobileLayout();
    el.shell.classList.toggle('sidebar-collapsed', !state.sidebarOpen);
    el.shell.classList.toggle('mobile-layout', mobile);
  }

  function toggleSidebar(forceValue) {
    if (typeof forceValue === 'boolean') {
      state.sidebarOpen = forceValue;
    } else {
      state.sidebarOpen = !state.sidebarOpen;
    }
    syncSidebarState();
  }

  function buildProviderHeaders(provider) {
    var headers = {};
    var apiKey = (provider.apiKey || '').trim();
    if (apiKey) {
      headers.Authorization = 'Bearer ' + apiKey;
      headers['X-API-Key'] = apiKey;
    }
    return headers;
  }

  function normalizeModelsResponse(data) {
    if (Array.isArray(data)) {
      return data
        .map(function (item) {
          if (typeof item === 'string') return item;
          return item && item.id ? item.id : null;
        })
        .filter(Boolean)
        .sort();
    }

    if (!data || typeof data !== 'object') return [];

    var list = Array.isArray(data.data)
      ? data.data
      : (Array.isArray(data.models)
        ? data.models
        : (Array.isArray(data.items) ? data.items : []));

    return list
      .map(function (item) {
        if (typeof item === 'string') return item;
        if (item && typeof item.id === 'string') return item.id;
        if (item && typeof item.model === 'string') return item.model;
        return null;
      })
      .filter(Boolean)
      .sort();
  }

  function fetchModelsForProvider(provider) {
    var url = stripTrailingSlash(provider.baseUrl || '') + '/models';
    return fetch(url, {
      headers: buildProviderHeaders(provider),
      mode: 'cors'
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (text) {
          throw new Error(provider.name + ': HTTP ' + res.status + (text ? ' — ' + text.slice(0, 180) : ''));
        });
      }
      return res.json();
    }).then(function (data) {
      return normalizeModelsResponse(data);
    });
  }

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

  function renderMarkdown(text) {
    try {
      return marked.parse(text || '', { breaks: true });
    } catch (err) {
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
      } catch (err) {
        console.error('KaTeX render error', err);
      }
    }
  }

  function scrollMessagesToBottom() {
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  function renderChatList() {
    el.chatList.innerHTML = '';
    if (state.chats.length === 0) {
      el.chatListEmpty.hidden = true;
      return;
    }

    el.chatListEmpty.hidden = true;
    var sorted = state.chats.slice().sort(function (a, b) {
      return (b.createdAt || 0) - (a.createdAt || 0);
    });

    for (var i = 0; i < sorted.length; i++) {
      var chat = sorted[i];
      var li = document.createElement('li');
      li.className = 'chat-item';
      li.dataset.id = chat.id;
      if (state.activeChat && chat.id === state.activeChat.id) li.classList.add('active');

      if (state.editingChatId === chat.id) {
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'chat-item-rename-input';
        input.value = chat.title || 'Untitled chat';
        (function (chatId, inputEl) {
          inputEl.addEventListener('keydown', function (event) {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitRename(chatId, inputEl.value);
            }
            if (event.key === 'Escape') {
              state.editingChatId = null;
              renderChatList();
            }
          });
          inputEl.addEventListener('blur', function () {
            commitRename(chatId, inputEl.value);
          });
        })(chat.id, input);
        li.appendChild(input);
        el.chatList.appendChild(li);
        requestAnimationFrame(function () {
          input.focus();
          input.select();
        });
        continue;
      }

      var titleBtn = document.createElement('button');
      titleBtn.type = 'button';
      titleBtn.className = 'chat-item-title';
      titleBtn.textContent = chat.title || 'Untitled chat';
      titleBtn.title = chat.title || 'Untitled chat';
      (function (chatId) {
        titleBtn.addEventListener('click', function () {
          selectChat(chatId);
        });
      })(chat.id);

      var editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'chat-item-edit';
      editBtn.setAttribute('aria-label', 'Rename chat');
      editBtn.textContent = '✎';
      (function (chatId) {
        editBtn.addEventListener('click', function (event) {
          event.stopPropagation();
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
      if (state.chats[i].id === chatId) {
        chat = state.chats[i];
        break;
      }
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
    if (!state.activeChat) return;
    var exists = false;
    for (var i = 0; i < state.chats.length; i++) {
      if (state.chats[i].id === state.activeChat.id) {
        exists = true;
        break;
      }
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
      if (state.chats[i].id === id) {
        chat = state.chats[i];
        break;
      }
    }
    if (!chat) return;
    state.activeChat = chat;
    renderChatList();
    renderMessages();
  }

  function buildMessageElement(msg) {
    var wrapper = document.createElement('div');
    wrapper.className = 'message message-' + msg.role;
    wrapper.dataset.id = msg.id;

    if (msg.role === 'assistant' && msg.thinking) {
      var details = document.createElement('details');
      details.className = 'think-block';
      details.open = true;
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

  function renderModelIndicator() {
    if (!el.chatModelIndicator) return;
    if (!state.selectedModel) {
      el.chatModelIndicator.textContent = 'No model selected';
      return;
    }

    var provider = null;
    for (var i = 0; i < state.providers.length; i++) {
      if (state.providers[i].id === state.selectedModel.providerId) {
        provider = state.providers[i];
        break;
      }
    }

    var providerName = provider ? provider.name : 'Provider';
    el.chatModelIndicator.textContent = providerName + ' · ' + state.selectedModel.modelId;
  }

  function syncEmptyChatState() {
    var hasMessages = Boolean(state.activeChat && state.activeChat.messages && state.activeChat.messages.length > 0);
    if (el.chatBrand) {
      el.chatBrand.hidden = hasMessages;
    }
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
    syncEmptyChatState();
    scrollMessagesToBottom();
  }

  function renderProviderList() {
    el.providerList.innerHTML = '';
    if (state.providers.length === 0) {
      el.providerListEmpty.hidden = true;
      return;
    }

    el.providerListEmpty.hidden = true;
    for (var i = 0; i < state.providers.length; i++) {
      var provider = state.providers[i];
      var li = document.createElement('li');
      li.className = 'provider-item';
      li.dataset.id = provider.id;

      var name = document.createElement('span');
      name.className = 'provider-name';
      name.textContent = provider.name;
      name.title = provider.baseUrl;

      var editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'provider-edit-btn';
      editBtn.textContent = 'Edit';
      (function (providerId) {
        editBtn.addEventListener('click', function () {
          openProviderForm(providerId);
        });
      })(provider.id);

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
        if (state.providers[i].id === providerId) {
          provider = state.providers[i];
          break;
        }
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

  function getProviderFromForm() {
    var name = el.providerFormName.value.trim();
    var baseUrl = stripTrailingSlash(el.providerFormBaseUrl.value);
    var apiKey = el.providerFormApiKey.value.trim();
    return {
      id: state.editingProviderId || uid(),
      name: name,
      baseUrl: baseUrl,
      apiKey: apiKey
    };
  }

  function runProviderConnectionTest() {
    var provider = getProviderFromForm();
    if (!provider.name || !provider.baseUrl) {
      setStatus('Display name and base URL are required before testing a provider.', 'error');
      return;
    }

    var originalText = el.providerTestBtn.textContent;
    el.providerTestBtn.disabled = true;
    el.providerTestBtn.textContent = 'Testing...';

    fetchModelsForProvider(provider).then(function (models) {
      var summary = models.length > 0
        ? provider.name + ' reachable — ' + models.length + ' models loaded.'
        : provider.name + ' reachable, but no models were returned.';
      setStatus(summary, 'success');
    }).catch(function (err) {
      var message = err && err.message ? err.message : 'Unknown error';
      setStatus(provider.name + ' connection failed: ' + message + '. Check the base URL and whether the provider allows browser CORS requests.', 'error');
    }).then(function () {
      el.providerTestBtn.disabled = false;
      el.providerTestBtn.textContent = originalText;
    });
  }

  function saveProviderForm() {
    var provider = getProviderFromForm();
    if (!provider.name || !provider.baseUrl) {
      alert('Display name and base URL are required.');
      return;
    }

    if (state.editingProviderId) {
      for (var i = 0; i < state.providers.length; i++) {
        if (state.providers[i].id === state.editingProviderId) {
          state.providers[i] = provider;
          break;
        }
      }
    } else {
      state.providers.push(provider);
    }

    saveProviders();
    renderProviderList();
    closeProviderForm();
    populateModelSelector();
    setStatus('Provider saved locally.', 'success');
  }

  function deleteProviderForm() {
    if (!state.editingProviderId) return;
    if (!confirm('Remove this provider? This cannot be undone.')) return;
    var idToRemove = state.editingProviderId;
    state.providers = state.providers.filter(function (provider) {
      return provider.id !== idToRemove;
    });
    saveProviders();
    renderProviderList();
    closeProviderForm();
    populateModelSelector();
    setStatus('Provider removed.', 'success');
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
    renderModelIndicator();
  }

  function filterModelOptions() {
    if (!el.modelSelector) return;
    var query = (el.modelSearch && el.modelSearch.value ? el.modelSearch.value : '').trim().toLowerCase();
    var options = Array.prototype.slice.call(el.modelSelector.options);
    var hasVisible = false;
    for (var i = 0; i < options.length; i++) {
      var option = options[i];
      if (option.disabled) {
        option.hidden = false;
        continue;
      }
      var matches = !query || option.textContent.toLowerCase().indexOf(query) !== -1;
      option.hidden = !matches;
      if (matches) hasVisible = true;
    }
    if (!hasVisible && el.modelSelector.options.length > 0) {
      el.modelSelector.value = '';
    }
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
      renderModelIndicator();
      return Promise.resolve();
    }

    var loading = document.createElement('option');
    loading.textContent = 'Loading models…';
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
          errOpt.textContent = 'Connection failed';
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
          if (!options[k].disabled) {
            options[k].selected = true;
            break;
          }
        }
      }

      filterModelOptions();
      updateSelectedModelFromDropdown();
    });
  }

  function setStreaming(value) {
    state.isStreaming = value;
    el.sendBtn.disabled = value;
    el.composerInput.disabled = value;
  }

  function autoGrowTextarea() {
    el.composerInput.style.height = 'auto';
    el.composerInput.style.height = Math.min(el.composerInput.scrollHeight, 200) + 'px';
  }

  function handleComposerSubmit(event) {
    event.preventDefault();
    if (state.isStreaming) return;

    if (!state.activeChat) {
      createNewChat();
    }

    var text = el.composerInput.value.trim();
    if (!text) return;

    if (!state.selectedModel) {
      setStatus('Choose a model from the sidebar first, or add a provider to get started.', 'error');
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
    if (!chat) return Promise.resolve();

    var providerId = state.selectedModel.providerId;
    var modelId = state.selectedModel.modelId;
    var provider = null;
    for (var i = 0; i < state.providers.length; i++) {
      if (state.providers[i].id === providerId) {
        provider = state.providers[i];
        break;
      }
    }
    if (!provider) {
      setStatus('The selected provider is no longer configured.', 'error');
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
    summary.textContent = 'Thinking…';
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

    var outgoingMessages = chat.messages.filter(function (msg) {
      return msg.id !== assistantMsg.id;
    }).map(function (msg) {
      return { role: msg.role, content: msg.content };
    });

    var headers = { 'Content-Type': 'application/json' };
    var apiKey = (provider.apiKey || '').trim();
    if (apiKey) {
      headers.Authorization = 'Bearer ' + apiKey;
      headers['X-API-Key'] = apiKey;
    }

    return fetch(provider.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ model: modelId, messages: outgoingMessages, stream: true }),
      mode: 'cors'
    }).then(function (res) {
      if (!res.ok || !res.body) {
        return res.text().catch(function () { return ''; }).then(function (errText) {
          throw new Error('HTTP ' + res.status + (errText ? ' ' + errText.slice(0, 180) : ''));
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
            } catch (err) {
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
      assistantMsg.content += prefix + '⚠️ Error: ' + (err && err.message ? err.message : 'Unknown error');
      bodyEl.textContent = assistantMsg.content;
      setStatus('Streaming failed: ' + (err && err.message ? err.message : 'Unknown error'), 'error');
    }).then(function () {
      bodyEl.classList.remove('streaming');
      bodyEl.innerHTML = renderMarkdown(assistantMsg.content);
      renderMathInScope(wrapper);
      setStreaming(false);
      saveChats();
      scrollMessagesToBottom();
    });
  }

  function bindEvents() {
    el.modelSelector.addEventListener('change', updateSelectedModelFromDropdown);
    if (el.modelSearch) {
      el.modelSearch.addEventListener('input', filterModelOptions);
    }
    el.newChatBtn.addEventListener('click', createNewChat);

    // provider form handlers
    el.addProviderBtn.addEventListener('click', function () {
      openProviderForm(null);
    });
    el.providerFormSave.addEventListener('click', saveProviderForm);
    el.providerFormCancel.addEventListener('click', closeProviderForm);
    el.providerFormDelete.addEventListener('click', deleteProviderForm);
    el.providerTestBtn.addEventListener('click', runProviderConnectionTest);

    // composer
    el.composer.addEventListener('submit', handleComposerSubmit);
    el.composerInput.addEventListener('input', autoGrowTextarea);
    el.composerInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        el.composer.requestSubmit();
      }
    });

    // Touch gesture handling for mobile sidebar swipe
    var touch = { startX: 0, startY: 0, lastX: 0, active: false };
    function onTouchStart(e) {
      if (!shouldUseMobileLayout()) return;
      var t = e.touches && e.touches[0];
      if (!t) return;
      touch.startX = t.clientX;
      touch.startY = t.clientY;
      touch.lastX = touch.startX;
      touch.active = true;
    }
    function onTouchMove(e) {
      if (!touch.active) return;
      var t = e.touches && e.touches[0];
      if (!t) return;
      touch.lastX = t.clientX;
    }
    function onTouchEnd(e) {
      if (!touch.active) return;
      var dx = touch.lastX - touch.startX;
      var absDx = Math.abs(dx);
      var dy = Math.abs((e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientY : 0) - touch.startY);
      touch.active = false;
      var threshold = 80; // minimum swipe distance
      var edgeThreshold = 60; // allow opening only if swipe starts near left edge

      // open on left-to-right swipe starting near left edge
      if (dx > threshold && touch.startX <= edgeThreshold) {
        state.sidebarOpen = true;
        syncSidebarState();
        return;
      }

      // close on right-to-left swipe when sidebar is open
      if (dx < -threshold && state.sidebarOpen) {
        state.sidebarOpen = false;
        syncSidebarState();
        return;
      }
    }

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
  }

  function init() {
    loadState();
    state.sidebarOpen = !shouldUseMobileLayout();
    syncSidebarState();
    renderProviderList();
    renderChatList();
    if (!state.activeChat && state.chats.length > 0) {
      state.activeChat = state.chats[state.chats.length - 1];
    }
    if (!state.activeChat) {
      createNewChat();
    } else {
      renderMessages();
    }
    bindEvents();
    renderModelIndicator();
    window.addEventListener('resize', function () {
      if (shouldUseMobileLayout()) {
        state.sidebarOpen = false;
      } else {
        state.sidebarOpen = true;
      }
      syncSidebarState();
    });
    populateModelSelector();
  }

  document.addEventListener('DOMContentLoaded', init);

  // Register service worker for PWA behavior when available and on secure origins
  var deferredInstallPrompt = null;
  var installBtn = null;

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeinstallprompt', function (e) {
      // Prevent the mini-infobar from appearing on mobile
      e.preventDefault();
      deferredInstallPrompt = e;
      installBtn = document.getElementById('install-btn');
      if (installBtn) {
        installBtn.hidden = false;
        installBtn.addEventListener('click', function () {
          installBtn.hidden = true;
          if (deferredInstallPrompt) {
            deferredInstallPrompt.prompt();
            deferredInstallPrompt.userChoice.then(function (choiceResult) {
              if (choiceResult.outcome === 'accepted') {
                console.info('PWA installed');
              } else {
                console.info('PWA install dismissed');
              }
              deferredInstallPrompt = null;
            });
          }
        });
      }
    });

    window.addEventListener('appinstalled', function () {
      console.info('App installed');
      var btn = document.getElementById('install-btn');
      if (btn) btn.hidden = true;
    });

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('/service-worker.js', { scope: '/' }).then(function (reg) {
          console.info('Service worker registered, scope:', reg.scope);
        }).catch(function (err) {
          console.info('Service worker registration failed:', err && err.message ? err.message : err);
        });
      });
    }
  }
})();
