/* =========================================================
   connpass — app.js
   WebSocket 클라이언트 메인 + 앱 초기화
   ========================================================= */

'use strict';

// ─── 상수 ────────────────────────────────────────────────────────────────────
const WS_URL = `ws://${window.location.host}`;
const API_URL = '';

// 전역 노출 (settings.js에서 참조)
window.API_URL = API_URL;

// ─── 앱 상태 ─────────────────────────────────────────────────────────────────
const state = {
  ws: null,
  wsReconnectTimer: null,
  wsReconnectDelay: 3000,
  currentSessionId: null,
  isGenerating: false,
  isTranslateMode: false,
  translateConfig: {
    targetLang: 'KO',
    model: 'Kimi-K2.5',
    translatePrompt: '',
  },
  chatConfig: {
    model: 'GLM4.7',
    indexes: [],
    tools: ['rag', 'jira', 'gerrit'],
    temperature: 0.7,
    maxTokens: 4096,
    maxToolSteps: 10,
    thinkingMode: 'off',
  },
  currentTurnId: null,
  currentTextBlockId: null,
  currentThinkingBlockId: null,
  lastEventWasToolCall: false,
  sessions: [],
  persona: 'BT',
};

// 전역 노출 (settings.js에서 참조)
window.state = state;

// ─── WebSocket ────────────────────────────────────────────────────────────────
function connectWS() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  updateWsStatus('connecting');

  try {
    const ws = new WebSocket(WS_URL);
    state.ws = ws;

    ws.onopen = () => {
      updateWsStatus('connected');
      if (state.wsReconnectTimer) {
        clearTimeout(state.wsReconnectTimer);
        state.wsReconnectTimer = null;
      }
      // 세션 목록 요청
      requestSessionList();
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleWsMessage(data);
      } catch (e) {
        console.error('[WS] Failed to parse message:', e, event.data);
      }
    };

    ws.onerror = (err) => {
      console.error('[WS] Error:', err);
      updateWsStatus('disconnected');
    };

    ws.onclose = () => {
      updateWsStatus('disconnected');
      state.ws = null;

      // 생성 중이었으면 종료 처리
      if (state.isGenerating) {
        if (state.currentThinkingBlockId) {
          ChatRenderer.finalizeThinkingBlock(state.currentThinkingBlockId);
          state.currentThinkingBlockId = null;
        }
        if (state.currentTextBlockId) {
          ChatRenderer.finalizeTextBlock(state.currentTextBlockId);
          state.currentTextBlockId = null;
        }
        state.currentTurnId = null;
        state.lastEventWasToolCall = false;
        setGenerating(false);
        showToast('연결이 끊어졌습니다. 재연결 중...', 'error');
      }

      // 3초 후 재연결
      state.wsReconnectTimer = setTimeout(() => {
        connectWS();
      }, state.wsReconnectDelay);
    };
  } catch (e) {
    console.error('[WS] Failed to create WebSocket:', e);
    updateWsStatus('disconnected');
    state.wsReconnectTimer = setTimeout(connectWS, state.wsReconnectDelay);
  }
}

function handleWsMessage(data) {
  switch (data.type) {
    case 'thinking':
      if (data.delta !== undefined) {
        if (!state.currentThinkingBlockId) {
          state.currentThinkingBlockId = generateId();
          ChatRenderer.startThinkingBlock(state.currentThinkingBlockId, state.currentTurnId);
        }
        ChatRenderer.appendThinking(state.currentThinkingBlockId, data.delta);
      }
      break;

    case 'token':
      if (data.delta !== undefined) {
        // thinking 블록이 열려있으면 완료 처리
        if (state.currentThinkingBlockId) {
          ChatRenderer.finalizeThinkingBlock(state.currentThinkingBlockId);
          state.currentThinkingBlockId = null;
        }
        // tool_end 이후이거나 text block이 없으면 새 블록 생성
        if (!state.currentTextBlockId || state.lastEventWasToolCall) {
          state.currentTextBlockId = generateId();
          state.lastEventWasToolCall = false;
          ChatRenderer.startTextBlock(state.currentTextBlockId, state.currentTurnId);
        }
        ChatRenderer.appendToken(state.currentTextBlockId, data.delta);
      }
      break;

    case 'tool_start':
      // 열린 text block 중간 finalize
      if (state.currentTextBlockId) {
        ChatRenderer.finalizeTextBlock(state.currentTextBlockId);
        state.currentTextBlockId = null;
      }
      state.lastEventWasToolCall = true;
      ChatRenderer.addToolCallBlock(
        data.toolCallId,
        data.toolName,
        data.toolLabel || data.toolName,
        data.params || data.input,
        state.currentTurnId
      );
      break;

    case 'tool_end':
      ChatRenderer.updateToolCallBlock(data.toolCallId, data.details || { summary: data.result });
      break;

    case 'agent_end':
      if (state.currentThinkingBlockId) {
        ChatRenderer.finalizeThinkingBlock(state.currentThinkingBlockId);
        state.currentThinkingBlockId = null;
      }
      if (state.currentTextBlockId) {
        ChatRenderer.finalizeTextBlock(state.currentTextBlockId);
        state.currentTextBlockId = null;
      }
      state.currentTurnId = null;
      state.lastEventWasToolCall = false;
      setGenerating(false);
      updateTokenCounter(data.usage);
      break;

    case 'compaction':
      ChatRenderer.addCompactionBlock(data.message || '대화가 길어져 이전 내용을 요약했습니다');
      break;

    case 'error':
      if (state.currentThinkingBlockId) {
        ChatRenderer.finalizeThinkingBlock(state.currentThinkingBlockId);
        state.currentThinkingBlockId = null;
      }
      if (state.currentTextBlockId) {
        ChatRenderer.finalizeTextBlock(state.currentTextBlockId);
        state.currentTextBlockId = null;
      }
      state.currentTurnId = null;
      state.lastEventWasToolCall = false;
      ChatRenderer.addErrorBlock(data.message || '오류가 발생했습니다', data.code);
      setGenerating(false);
      break;

    case 'sessions.list':
      renderSessionList(data.sessions || []);
      break;

    case 'sessions.deleted':
      requestSessionList();
      break;

    case 'session.created':
      state.currentSessionId = data.sessionId;
      requestSessionList();
      break;

    case 'model_health':
      applyModelHealth(data.health || {});
      break;

    case 'usage':
      updateTokenCounter(data);
      break;

    default:
      break;
  }
}

function applyModelHealth(health) {
  // topbar #model-select 옵션 비활성화
  const modelSelect = document.getElementById('model-select');
  if (modelSelect) {
    modelSelect.querySelectorAll('option').forEach(opt => {
      const online = health[opt.value];
      if (online === false) {
        opt.disabled = true;
        if (!opt.textContent.includes(' (offline)')) {
          opt.textContent = opt.value + ' (offline)';
        }
      } else if (online === true) {
        opt.disabled = false;
        // "offline" 접미어 제거
        opt.textContent = opt.textContent.replace(' (offline)', '');
      }
    });
    // 현재 선택 모델이 offline이면 toast 경고
    const currentOpt = modelSelect.options[modelSelect.selectedIndex];
    if (currentOpt && health[currentOpt.value] === false) {
      showToast(`${currentOpt.value} 모델이 현재 오프라인입니다. 다른 모델을 선택해주세요.`, 'error');
    }
  }

  // 설정 패널의 .model-card 비활성화
  document.querySelectorAll('.model-card').forEach(card => {
    const modelName = card.dataset.model || card.querySelector('.model-name')?.textContent;
    if (modelName && health[modelName] === false) {
      card.classList.add('offline');
    } else if (modelName && health[modelName] === true) {
      card.classList.remove('offline');
    }
  });
}

// ─── 메시지 전송 ──────────────────────────────────────────────────────────────
async function sendMessage(text) {
  text = text.trim();
  if (!text || state.isGenerating) return;

  // WS 연결 확인
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showToast('서버에 연결 중입니다. 잠시 후 다시 시도해주세요.', 'error');
    connectWS();
    return;
  }

  // 세션 없으면 생성
  if (!state.currentSessionId) {
    await createNewSession();
  }

  setGenerating(true);
  ChatRenderer.addUserBlock(text, generateId());
  // turn ID 초기화 (text block은 첫 token 도착 시 lazy 생성)
  state.currentTurnId = generateId();
  state.currentTextBlockId = null;
  state.currentThinkingBlockId = null;
  state.lastEventWasToolCall = false;

  // 입력창 초기화 및 포커스 유지
  const textarea = document.getElementById('main-input');
  if (textarea) {
    textarea.value = '';
    autoResize(textarea);
    textarea.focus();
  }

  if (state.isTranslateMode) {
    // 번역 모드: tool_choice: none, LLM 직통 — 기존 방식 유지
    const translateId = generateId();
    state.currentTextBlockId = translateId;
    ChatRenderer.createTranslateMessage(
      translateId,
      'AUTO',
      state.translateConfig.targetLang
    );
    state.ws.send(JSON.stringify({
      type: 'translate',
      sessionId: state.currentSessionId,
      text,
      config: {
        ...state.translateConfig,
        model: state.translateConfig.model || state.chatConfig.model,
      },
    }));
  } else {
    // 일반 채팅 모드: Agent loop — text block은 첫 token 도착 시 lazy 생성
    state.ws.send(JSON.stringify({
      type: 'chat',
      sessionId: state.currentSessionId,
      message: text,
      config: {
        ...state.chatConfig,
        indexes: state.chatConfig.indexes,
      },
    }));
  }
}

// ─── Stop ─────────────────────────────────────────────────────────────────────
function stopGeneration() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN && state.currentSessionId) {
    state.ws.send(JSON.stringify({
      type: 'stop',
      sessionId: state.currentSessionId,
    }));
  }
  if (state.currentThinkingBlockId) {
    ChatRenderer.finalizeThinkingBlock(state.currentThinkingBlockId);
    state.currentThinkingBlockId = null;
  }
  if (state.currentTextBlockId) {
    ChatRenderer.finalizeTextBlock(state.currentTextBlockId);
    state.currentTextBlockId = null;
  }
  state.currentTurnId = null;
  state.lastEventWasToolCall = false;
  setGenerating(false);
}

// ─── 세션 관리 ────────────────────────────────────────────────────────────────
async function createNewSession() {
  // 세션은 Flask REST API로 직접 생성 (WS는 chat/translate/stop/sessions.list/delete만 처리)
  try {
    const res = await fetch(`${API_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona: state.persona, model: state.chatConfig.model }),
    });
    if (res.ok) {
      const data = await res.json();
      state.currentSessionId = data.id;
      requestSessionList();
      return state.currentSessionId;
    }
  } catch (e) {
    console.error('[Session] Failed to create session:', e);
  }

  // 로컬 fallback (Flask 미응답 시)
  state.currentSessionId = 'local-' + Date.now();
  return state.currentSessionId;
}

async function loadSession(sessionId) {
  state.currentSessionId = sessionId;
  state.currentTurnId = null;
  state.currentTextBlockId = null;
  state.currentThinkingBlockId = null;
  state.lastEventWasToolCall = false;
  ChatRenderer.clear();
  ChatRenderer.showEmpty();

  try {
    const res = await fetch(`${API_URL}/api/sessions/${sessionId}`);
    if (res.ok) {
      const data = await res.json();
      const messages = data.messages || [];
      const toolCallsByMessage = data.toolCallsByMessage || {};

      if (messages.length > 0) {
        const emptyState = document.getElementById('empty-state');
        if (emptyState) emptyState.style.display = 'none';

        messages.forEach(msg => {
          let content = msg.content;
          try { content = JSON.parse(content); } catch { /* 문자열 그대로 사용 */ }

          if (msg.role === 'user') {
            const text = typeof content === 'string' ? content : (content[0]?.text ?? '');
            ChatRenderer.addUserBlock(text, generateId());

          } else if (msg.role === 'assistant') {
            const turnId = generateId();
            let text;
            if (typeof content === 'string') {
              text = content;
            } else if (Array.isArray(content)) {
              text = content.find(b => b.type === 'text')?.text ?? '';
            } else if (content?.content && Array.isArray(content.content)) {
              text = content.content.find(b => b.type === 'text')?.text ?? '';
            } else {
              text = '';
            }

            // 텍스트 블록 (있으면)
            if (text) {
              const textBlockId = generateId();
              ChatRenderer.startTextBlock(textBlockId, turnId);
              ChatRenderer.appendToken(textBlockId, text);
              ChatRenderer.finalizeTextBlock(textBlockId);
            }

            // tool_calls 재현 (있으면)
            const toolCalls = toolCallsByMessage[msg.id] || [];
            toolCalls.forEach(tc => {
              ChatRenderer.addToolCallBlock(tc.id, tc.toolName, tc.toolLabel, tc.args, turnId);
              ChatRenderer.updateToolCallBlock(tc.id, tc.isError
                ? { error: typeof tc.result === 'object' ? JSON.stringify(tc.result) : String(tc.result || 'Error') }
                : { summary: typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result) }
              );
            });
          }
        });
      }
    }
  } catch (e) {
    console.error('[Session] Failed to load session:', e);
  }
}

async function deleteSession(sessionId) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'sessions.delete', sessionId }));
    return;
  }

  try {
    await fetch(`${API_URL}/api/sessions/${sessionId}`, { method: 'DELETE' });
    requestSessionList();
  } catch (e) {
    console.error('[Session] Failed to delete session:', e);
  }
}

function requestSessionList() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'sessions.list' }));
  } else {
    // 폴백: REST API (Flask는 배열 직접 반환)
    fetch(`${API_URL}/api/sessions`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (Array.isArray(data)) renderSessionList(data);
      })
      .catch(() => {});
  }
}

function renderSessionList(sessions) {
  state.sessions = sessions || [];
  const listEl = document.getElementById('session-list');
  if (!listEl) return;

  listEl.innerHTML = '';

  if (sessions.length === 0) {
    listEl.innerHTML = '<div style="padding:12px 10px;font-size:11px;color:var(--text-2);text-align:center">대화 없음</div>';
    return;
  }

  // 날짜별 그룹핑
  const groups = {};
  const now = new Date();
  sessions.forEach(s => {
    const d = new Date(s.updatedAt || s.createdAt || Date.now());
    const diffMs = now - d;
    const diffDays = Math.floor(diffMs / 86400000);
    let group;
    if (diffDays === 0) group = '오늘';
    else if (diffDays === 1) group = '어제';
    else if (diffDays <= 7) group = '이번 주';
    else group = '이전';
    if (!groups[group]) groups[group] = [];
    groups[group].push(s);
  });

  const groupOrder = ['오늘', '어제', '이번 주', '이전'];
  groupOrder.forEach(groupName => {
    if (!groups[groupName]) return;

    const sectionEl = document.createElement('div');
    sectionEl.className = 'sidebar-section';
    sectionEl.textContent = groupName;
    listEl.appendChild(sectionEl);

    groups[groupName].forEach(session => {
      const item = document.createElement('div');
      item.className = 'session-item' + (session.id === state.currentSessionId ? ' active' : '');
      item.dataset.sessionId = session.id;

      const persona = session.persona || 'BT';
      const badgeClass = persona === 'WiFi' ? 'badge-wifi' : 'badge-bt';
      const timeAgo = _timeAgo(session.updatedAt || session.createdAt);
      const title = session.title || session.firstMessage || '새 채팅';

      item.innerHTML = `
        <div class="session-title">${_escHtml(title)}</div>
        <div class="session-meta">
          <span class="session-badge ${badgeClass}">${_escHtml(persona)}</span>
          <span>${timeAgo}</span>
          <button class="session-delete-btn" style="margin-left:auto;background:none;border:none;color:var(--text-2);cursor:pointer;font-size:12px;padding:0 4px;opacity:0;transition:opacity 0.1s" title="삭제">✕</button>
        </div>
      `;

      item.querySelector('.session-delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('이 대화를 삭제하시겠습니까?')) {
          deleteSession(session.id);
          if (session.id === state.currentSessionId) {
            startNewChat();
          }
        }
      });

      item.addEventListener('mouseenter', () => {
        const btn = item.querySelector('.session-delete-btn');
        if (btn) btn.style.opacity = '1';
      });
      item.addEventListener('mouseleave', () => {
        const btn = item.querySelector('.session-delete-btn');
        if (btn) btn.style.opacity = '0';
      });

      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('session-delete-btn')) return;
        document.querySelectorAll('.session-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        loadSession(session.id);
      });

      listEl.appendChild(item);
    });
  });
}

// ─── 번역 모드 ────────────────────────────────────────────────────────────────
function toggleTranslateMode() {
  state.isTranslateMode = !state.isTranslateMode;
  updateTranslateModeUI();

  if (state.isTranslateMode) {
    showToast('번역 모드 활성화. 빠른 응답을 위해 Kimi-K2.5 사용을 권장합니다.', 'info');
  }
}

function updateTranslateModeUI() {
  const translateBtn = document.getElementById('translate-btn');
  const translateBar = document.getElementById('translate-bar');
  const indexBar = document.getElementById('index-bar');
  const inputTools = document.querySelector('.input-tools');
  const textarea = document.getElementById('main-input');
  const badge = document.getElementById('topbar-translate-badge');

  if (state.isTranslateMode) {
    if (translateBtn) translateBtn.classList.add('active');
    if (translateBar) translateBar.classList.add('active');
    if (indexBar) indexBar.classList.add('hidden');
    if (inputTools) inputTools.classList.add('translate-mode');
    if (badge) badge.classList.add('show');
    if (textarea) textarea.placeholder = '번역할 텍스트를 입력하세요... (언어 자동 감지)';
  } else {
    if (translateBtn) translateBtn.classList.remove('active');
    if (translateBar) translateBar.classList.remove('active');
    if (indexBar) indexBar.classList.remove('hidden');
    if (inputTools) inputTools.classList.remove('translate-mode');
    if (badge) badge.classList.remove('show');
    if (textarea) textarea.placeholder = '질문하거나 명령을 입력하세요... (예: BT-4821 분석해줘)';
  }
}

function setTargetLang(btn, lang) {
  document.querySelectorAll('.target-lang-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.translateConfig.targetLang = lang;
}

// ─── 인덱스 바 ────────────────────────────────────────────────────────────────
async function loadIndexes() {
  const indexBar = document.getElementById('index-bar');
  if (!indexBar) return;

  try {
    const res = await fetch(`${API_URL}/api/rag/indexes`);
    if (!res.ok) return;
    const data = await res.json();
    renderIndexBar(data.indexes || []);
  } catch (e) {
    // 서버 미연결 시 mockup 칩 유지
  }
}

function renderIndexBar(indexes) {
  const indexBar = document.getElementById('index-bar');
  if (!indexBar || !indexes.length) return;

  // label 스팬 유지
  const label = indexBar.querySelector('span');

  // 기존 칩 제거
  indexBar.querySelectorAll('.index-chip').forEach(c => c.remove());

  indexes.forEach(idx => {
    const chip = document.createElement('div');
    chip.className = 'index-chip' + (idx.active ? ' active' : '');
    chip.textContent = idx.name || idx.id;
    chip.dataset.indexId = idx.id;
    chip.addEventListener('click', () => toggleIndex(idx.id, chip));
    indexBar.appendChild(chip);
  });
}

function toggleIndex(indexId, chipEl) {
  chipEl.classList.toggle('active');
  const isActive = chipEl.classList.contains('active');

  if (isActive) {
    if (!state.chatConfig.indexes.includes(indexId)) {
      state.chatConfig.indexes.push(indexId);
    }
  } else {
    state.chatConfig.indexes = state.chatConfig.indexes.filter(id => id !== indexId);
  }
}

// ─── 새 채팅 ─────────────────────────────────────────────────────────────────
function startNewChat() {
  state.currentSessionId = null;
  state.currentTurnId = null;
  state.currentTextBlockId = null;
  state.currentThinkingBlockId = null;
  state.lastEventWasToolCall = false;

  ChatRenderer.clear();
  ChatRenderer.showEmpty();

  document.querySelectorAll('.session-item').forEach(i => i.classList.remove('active'));
  setGenerating(false);
}

// ─── 페르소나 ────────────────────────────────────────────────────────────────
function setPersona(btn, persona) {
  document.querySelectorAll('.persona-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.persona = persona;
}

// ─── Quick prompts ────────────────────────────────────────────────────────────
function sendQuick(el) {
  const text = el.querySelector('.qp-text')?.textContent || el.textContent;
  if (text) sendMessage(text.trim());
}

// ─── 언어 전환 (UI 다국어) ───────────────────────────────────────────────────
const LANG = {
  ko: {
    'new_chat': '＋ 새 채팅',
    'today': '오늘', 'yesterday': '어제', 'this_week': '이번 주',
    'input.placeholder': '질문하거나 명령을 입력하세요... (예: BT-4821 분석해줘)',
    'qp1.label': 'RAG 검색', 'qp1.text': 'BT 연결 끊김 관련 유사 Jira 이슈 찾아줘',
    'qp2.label': '스펙 분석', 'qp2.text': 'Bluetooth 5.3 vs 5.4 주요 변경사항 비교해줘',
    'qp3.label': 'Jira 분석', 'qp3.text': '이번 주 BT 프로젝트 미해결 이슈 요약해줘',
    'qp4.label': '로그 분석', 'qp4.text': 'HCI_ERR_CONNECTION_TIMEOUT 에러 원인 알려줘',
    'empty.subtitle': 'BT/WiFi 엔지니어링 AI 어시스턴트<br>문서 검색, Jira 분석, Gerrit 리뷰를 자연어로',
  },
  en: {
    'new_chat': '＋ New Chat',
    'today': 'Today', 'yesterday': 'Yesterday', 'this_week': 'This Week',
    'input.placeholder': 'Ask a question or command... (e.g. Analyze BT-4821)',
    'qp1.label': 'RAG Search', 'qp1.text': 'Find similar Jira issues related to BT disconnection',
    'qp2.label': 'Spec Analysis', 'qp2.text': 'Compare key changes between Bluetooth 5.3 and 5.4',
    'qp3.label': 'Jira Analysis', 'qp3.text': 'Summarize unresolved BT project issues this week',
    'qp4.label': 'Log Analysis', 'qp4.text': 'Explain the cause of HCI_ERR_CONNECTION_TIMEOUT error',
    'empty.subtitle': 'BT/WiFi Engineering AI Assistant<br>Doc search, Jira analysis, Gerrit review in natural language',
  },
};

let currentLang = localStorage.getItem('lang') || 'ko';

function t(key) {
  return LANG[currentLang]?.[key] ?? LANG['ko'][key] ?? key;
}

function setLang(lang, btn) {
  currentLang = lang;
  localStorage.setItem('lang', lang);
  document.querySelectorAll('.lang-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  applyLang();
}

function applyLang() {
  const newChatBtn = document.querySelector('.new-chat-btn');
  if (newChatBtn) newChatBtn.innerHTML = `<span>＋</span> ${currentLang === 'ko' ? '새 채팅' : 'New Chat'}`;

  const textarea = document.getElementById('main-input');
  if (textarea && !state.isTranslateMode) textarea.placeholder = t('input.placeholder');

  // 빠른 프롬프트
  const qps = document.querySelectorAll('.quick-prompt');
  [1, 2, 3, 4].forEach((n, i) => {
    if (qps[i]) {
      const label = qps[i].querySelector('.qp-label');
      const text = qps[i].querySelector('.qp-text');
      if (label) label.textContent = t(`qp${n}.label`);
      if (text) text.textContent = t(`qp${n}.text`);
    }
  });

  // empty subtitle
  const sub = document.querySelector('.empty-subtitle');
  if (sub) sub.innerHTML = t('empty.subtitle');

  document.documentElement.lang = currentLang;
}

// ─── 유틸 ─────────────────────────────────────────────────────────────────────
function generateId() {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function setGenerating(val) {
  state.isGenerating = val;
  const sendBtn = document.getElementById('send-btn');
  const textarea = document.getElementById('main-input');

  if (sendBtn) {
    if (val) {
      sendBtn.textContent = '■';
      sendBtn.classList.add('stop');
      sendBtn.title = '생성 중지';
    } else {
      sendBtn.textContent = '▶';
      sendBtn.classList.remove('stop');
      sendBtn.title = '전송';
    }
  }

  if (textarea) {
    textarea.disabled = val;
    if (!val) textarea.focus();
  }
}

function showToast(msg, type = 'info') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = msg;
  container.appendChild(toast);

  // 3초 후 자동 제거
  setTimeout(() => {
    toast.classList.add('hiding');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
    setTimeout(() => { if (toast.parentElement) toast.remove(); }, 300);
  }, 3000);
}

// WS 상태 인디케이터 업데이트
function updateWsStatus(status) {
  const dot = document.getElementById('ws-status-dot');
  if (!dot) return;
  dot.className = 'ws-status';
  if (status === 'connected') dot.classList.add('connected');
  else if (status === 'connecting') dot.classList.add('connecting');
  // disconnected = 기본 (빨간색)
}

// textarea 자동 높이 조절
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

// 토큰 카운터 업데이트
function updateTokenCounter(usage) {
  if (!usage) return;
  const fill = document.getElementById('token-fill');
  const text = document.getElementById('token-text');
  if (!fill || !text) return;

  const used = usage.total_tokens || usage.input_tokens || 0;
  const ctx = usage.context_window || 128000;
  const pct = Math.min((used / ctx) * 100, 100);

  fill.style.width = pct + '%';
  fill.style.background = pct > 75 ? 'var(--orange)' : 'var(--green)';

  const usedK = Math.round(used / 1000);
  const ctxK = Math.round(ctx / 1000);
  text.textContent = `${usedK}K / ${ctxK}K`;
}

// 시간 ago 표시
function _timeAgo(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '방금 전';
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '어제';
  if (days < 7) return `${days}일 전`;
  return d.toLocaleDateString('ko-KR');
}

function _escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── 이벤트 리스너 설정 ──────────────────────────────────────────────────────
function setupEventListeners() {
  // 전송 버튼
  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) {
    sendBtn.addEventListener('click', () => {
      if (state.isGenerating) {
        stopGeneration();
      } else {
        const textarea = document.getElementById('main-input');
        if (textarea) sendMessage(textarea.value);
      }
    });
  }

  // textarea Enter 키
  const textarea = document.getElementById('main-input');
  if (textarea) {
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!state.isGenerating) sendMessage(textarea.value);
      }
    });
    textarea.addEventListener('input', () => autoResize(textarea));
  }

  // 새 채팅 버튼
  const newChatBtn = document.querySelector('.new-chat-btn');
  if (newChatBtn) {
    newChatBtn.addEventListener('click', startNewChat);
  }

  // 번역 토글 버튼
  const translateBtn = document.getElementById('translate-btn');
  if (translateBtn) {
    translateBtn.addEventListener('click', toggleTranslateMode);
  }

  // 타겟 언어 버튼들
  document.querySelectorAll('.target-lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const lang = btn.textContent.trim();
      setTargetLang(btn, lang);
    });
  });

  // 설정 토글 버튼 — SettingsPanel.init()에서 이미 등록됨, 중복 등록 금지

  // 페르소나 버튼
  document.querySelectorAll('.persona-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const persona = btn.textContent.trim();
      setPersona(btn, persona);
    });
  });

  // 언어 토글
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const lang = btn.textContent.trim().toLowerCase();
      setLang(lang, btn);
    });
  });

  // 모델 셀렉터 (topbar)
  const modelSelect = document.getElementById('model-select');
  if (modelSelect) {
    modelSelect.addEventListener('change', () => {
      state.chatConfig.model = modelSelect.value;
      localStorage.setItem('selectedModel', modelSelect.value);
      // 설정 모델 카드와 동기화
      document.querySelectorAll('.model-card').forEach(card => {
        const name = card.querySelector('.model-name')?.textContent;
        card.classList.toggle('sel', name === modelSelect.value);
      });
    });
  }

  // 인덱스 칩 (mockup에 있는 기본 칩들)
  document.querySelectorAll('#index-bar .index-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      chip.classList.toggle('active');
      // 인덱스 id가 있으면 상태 업데이트
      if (chip.dataset.indexId) toggleIndex(chip.dataset.indexId, chip);
    });
  });

  // tool 칩 토글
  document.querySelectorAll('.input-tool-chip:not(.translate-toggle-btn)').forEach(chip => {
    chip.addEventListener('click', () => {
      chip.classList.toggle('active');
    });
  });

  // 빠른 프롬프트
  document.querySelectorAll('.quick-prompt').forEach(qp => {
    qp.addEventListener('click', () => sendQuick(qp));
  });

  // next-step 아이템
  document.querySelectorAll('.next-step-item').forEach(item => {
    item.addEventListener('click', () => {
      const text = item.textContent.trim();
      if (text) sendMessage(text);
    });
  });

  // 설정 내 저장 버튼
  const saveBtn = document.getElementById('settings-save-btn');
  if (saveBtn) {
    // SettingsPanel.init()에서 이미 처리
  }

  // 설정 섹션 nav (data-section 속성으로 처리)
  document.querySelectorAll('.nav-item').forEach(item => {
    const section = item.getAttribute('onclick')?.match(/showSec\('(\w+)'/)?.[1];
    if (section) {
      item.dataset.section = section;
      item.removeAttribute('onclick');
      item.addEventListener('click', () => SettingsPanel.showSection(section));
    }
  });

  // 설정 model 카드 (onclick 제거, event 리스너 등록)
  document.querySelectorAll('.model-card').forEach(card => {
    card.removeAttribute('onclick');
    card.addEventListener('click', () => {
      document.querySelectorAll('.model-card').forEach(c => c.classList.remove('sel'));
      card.classList.add('sel');
      const modelName = card.querySelector('.model-name')?.textContent;
      if (modelName) {
        state.chatConfig.model = modelName;
        localStorage.setItem('selectedModel', modelName);
        const sel = document.getElementById('model-select');
        if (sel) sel.value = modelName;
      }
    });
  });

  // 설정 내 toggle 버튼들
  document.querySelectorAll('.s-tog').forEach(tog => {
    tog.removeAttribute('onclick');
    tog.addEventListener('click', () => tog.classList.toggle('on'));
  });

  // 설정 연결 테스트 버튼
  const testConnBtn = document.getElementById('test-conn-btn');
  if (testConnBtn) {
    testConnBtn.removeAttribute('onclick');
    testConnBtn.addEventListener('click', () => {
      const el = document.getElementById('conn-result');
      if (el) { el.style.color = 'var(--orange)'; el.textContent = '연결 중...'; }
      fetch(`${API_URL}/api/health`)
        .then(r => {
          if (el) { el.style.color = 'var(--green)'; el.textContent = '✓ 연결 성공'; }
        })
        .catch(e => {
          if (el) { el.style.color = 'var(--red)'; el.textContent = '✗ 연결 실패'; }
        });
    });
  }

  // 설정 saveAll 버튼
  const saveAllBtn = document.querySelector('.btn-save[onclick]');
  if (saveAllBtn) {
    saveAllBtn.removeAttribute('onclick');
    saveAllBtn.addEventListener('click', () => {
      const badge = document.getElementById('save-badge');
      if (badge) { badge.classList.add('show'); setTimeout(() => badge.classList.remove('show'), 2500); }
    });
  }

  // 테마 카드
  document.querySelectorAll('.s-theme-card').forEach(card => {
    card.removeAttribute('onclick');
    card.addEventListener('click', () => {
      document.querySelectorAll('.s-theme-card').forEach(c => c.classList.remove('sel'));
      card.classList.add('sel');
    });
  });

  // 강조 색상 스워치
  document.querySelectorAll('.s-swatch').forEach(swatch => {
    swatch.removeAttribute('onclick');
    swatch.addEventListener('click', () => {
      const color = swatch.style.background;
      document.querySelectorAll('.s-swatch').forEach(s => s.classList.remove('sel'));
      swatch.classList.add('sel');
      if (color) {
        document.documentElement.style.setProperty('--accent', color);
      }
    });
  });

  // 폰트 옵션
  document.querySelectorAll('.s-font-opt').forEach(opt => {
    opt.removeAttribute('onclick');
    opt.addEventListener('click', () => {
      document.querySelectorAll('.s-font-opt').forEach(o => o.classList.remove('sel'));
      opt.classList.add('sel');
    });
  });

  // 밀도 옵션
  document.querySelectorAll('.s-density-opt').forEach(opt => {
    opt.removeAttribute('onclick');
    opt.addEventListener('click', () => {
      document.querySelectorAll('.s-density-opt').forEach(o => o.classList.remove('sel'));
      opt.classList.add('sel');
    });
  });

  // Agent.md 변수 삽입 버튼
  document.querySelectorAll('[onclick*="insertVar"]').forEach(btn => {
    const match = btn.getAttribute('onclick')?.match(/insertVar\('([^']+)'\)/);
    if (match) {
      const v = match[1];
      btn.removeAttribute('onclick');
      btn.addEventListener('click', () => {
        const ta = document.getElementById('agentmd-input');
        if (ta) _insertAtCursor(ta, v);
      });
    }
  });

  // 번역 프롬프트 변수 삽입
  document.querySelectorAll('[onclick*="insertTVar"]').forEach(btn => {
    const match = btn.getAttribute('onclick')?.match(/insertTVar\('([^']+)'\)/);
    if (match) {
      const v = match[1];
      btn.removeAttribute('onclick');
      btn.addEventListener('click', () => {
        const ta = document.getElementById('translate-prompt-input');
        if (ta) _insertAtCursor(ta, v);
      });
    }
  });

  // skill md 토글
  document.querySelectorAll('[onclick*="toggleSkillMd"]').forEach(btn => {
    btn.removeAttribute('onclick');
    btn.addEventListener('click', () => {
      const row = btn.closest('.s-skill-row');
      if (!row) return;
      const preview = row.querySelector('.s-md-preview');
      if (!preview) return;
      const open = preview.classList.toggle('open');
      preview.style.display = open ? 'block' : 'none';
      btn.style.color = open ? 'var(--accent)' : '';
    });
  });

  // MCP 추가 폼 토글
  const addMcpFormBtn = document.querySelector('[onclick*="s-add-mcp"]');
  if (addMcpFormBtn) {
    addMcpFormBtn.removeAttribute('onclick');
    addMcpFormBtn.addEventListener('click', () => {
      const form = document.getElementById('s-add-mcp');
      if (form) form.classList.toggle('open');
    });
  }

  // Jira 버튼 백업 바인딩 (settings.js init 보완)
  const addJiraBtn = document.getElementById('add-jira-btn');
  if (addJiraBtn && !addJiraBtn.dataset.bound) {
    addJiraBtn.dataset.bound = '1';
    addJiraBtn.addEventListener('click', () => {
      const form = document.getElementById('s-add-jira');
      if (form) form.classList.toggle('open');
    });
  }
  const registerJiraBtn = document.getElementById('register-jira-btn');
  if (registerJiraBtn && !registerJiraBtn.dataset.bound) {
    registerJiraBtn.dataset.bound = '1';
    registerJiraBtn.addEventListener('click', () => {
      if (typeof SettingsPanel !== 'undefined') SettingsPanel._registerJira();
    });
  }
  const cancelJiraBtn = document.getElementById('cancel-jira-btn');
  if (cancelJiraBtn && !cancelJiraBtn.dataset.bound) {
    cancelJiraBtn.dataset.bound = '1';
    cancelJiraBtn.addEventListener('click', () => {
      const form = document.getElementById('s-add-jira');
      if (form) form.classList.remove('open');
    });
  }

  // 기본 언어 버튼 (번역 설정 섹션)
  document.querySelectorAll('[onclick*="selDefaultLang"]').forEach(btn => {
    btn.removeAttribute('onclick');
    btn.addEventListener('click', () => {
      btn.closest('div').querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // range 슬라이더
  const tempRange = document.getElementById('range-temperature');
  const tempVal = document.getElementById('sv-temp');
  if (tempRange && tempVal) {
    tempRange.addEventListener('input', () => {
      tempVal.textContent = tempRange.value;
      state.chatConfig.temperature = parseFloat(tempRange.value);
    });
  }

  const tokRange = document.getElementById('range-maxtokens');
  const tokVal = document.getElementById('sv-tok');
  if (tokRange && tokVal) {
    tokRange.addEventListener('input', () => {
      tokVal.textContent = Number(tokRange.value).toLocaleString();
      state.chatConfig.maxTokens = parseInt(tokRange.value);
    });
  }

  const stepRange = document.getElementById('range-maxsteps');
  const stepVal = document.getElementById('sv-step');
  if (stepRange && stepVal) {
    stepRange.addEventListener('input', () => {
      stepVal.textContent = stepRange.value;
      state.chatConfig.maxToolSteps = parseInt(stepRange.value);
    });
  }

  // 인라인 oninput range (mockup style)
  document.querySelectorAll('input[type=range][oninput]').forEach(input => {
    const oninput = input.getAttribute('oninput');
    if (oninput) {
      input.addEventListener('input', () => {
        try { new Function(oninput)(); } catch (e) { /* ignore */ }
      });
    }
  });
}

// Private helper
function _insertAtCursor(ta, text) {
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + text.length;
  ta.focus();
}

// ─── 초기화 ───────────────────────────────────────────────────────────────────
async function init() {
  // 1. WebSocket 연결
  connectWS();

  // 2. ChatRenderer 초기화
  ChatRenderer.init(document.getElementById('messages'));

  // 3. SettingsPanel 초기화
  try {
    SettingsPanel.init();
  } catch (e) {
    console.error('[SettingsPanel.init] 초기화 오류:', e);
  }

  // 4. 인덱스 로드 (서버 연결 시)
  loadIndexes();

  // 5. 이벤트 리스너 설정
  setupEventListeners();

  // 6. 언어 초기화
  const savedLang = localStorage.getItem('lang') || 'ko';
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.textContent.trim().toLowerCase() === savedLang);
  });
  currentLang = savedLang;
  applyLang();

  // 7. 저장된 모델 복원
  const savedModel = localStorage.getItem('selectedModel');
  if (savedModel) {
    const sel = document.getElementById('model-select');
    if (sel) sel.value = savedModel;
    state.chatConfig.model = savedModel;
  }

  // 8. 번역 설정 복원
  try {
    const savedTranslate = localStorage.getItem('translateConfig');
    if (savedTranslate) {
      const conf = JSON.parse(savedTranslate);
      Object.assign(state.translateConfig, conf);
    }
  } catch (e) { /* 무시 */ }
}

// DOMContentLoaded 후 초기화
document.addEventListener('DOMContentLoaded', init);
