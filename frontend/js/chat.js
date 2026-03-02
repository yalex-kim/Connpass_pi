/* =========================================================
   Connpass — chat.js
   메시지 렌더링 모듈 (ChatRenderer)
   ========================================================= */

'use strict';

const ChatRenderer = {
  // 채팅 컨테이너 참조
  container: null,

  // 스트리밍 중인 메시지의 raw text 버퍼 (messageId → string)
  _rawBuffers: {},

  // ── 초기화 ──────────────────────────────────────────────
  init(containerEl) {
    this.container = containerEl;

    // marked 설정
    if (typeof marked !== 'undefined') {
      marked.setOptions({
        breaks: true,
        gfm: true,
        highlight: function(code, lang) {
          if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
            try {
              return hljs.highlight(code, { language: lang }).value;
            } catch (e) {
              // ignore
            }
          }
          return (typeof hljs !== 'undefined') ? hljs.highlightAuto(code).value : code;
        },
      });
    }
  },

  // ── 사용자 메시지 말풍선 추가 ───────────────────────────
  addUserMessage(text, messageId) {
    this._hideEmpty();

    const row = document.createElement('div');
    row.className = 'msg-row user';
    row.dataset.id = messageId;

    const now = new Date();
    const timeStr = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

    row.innerHTML = `
      <div class="msg-avatar avatar-user">YL</div>
      <div class="msg-body">
        <div class="msg-meta">나 · ${timeStr}</div>
        <div class="msg-content message__bubble">${this._escapeHtml(text)}</div>
      </div>
    `;

    this.container.appendChild(row);
    this.scrollToBottom();
    return row;
  },

  // ── AI 응답 말풍선 생성 (스트리밍 시작 시) ─────────────
  createAssistantMessage(messageId) {
    this._hideEmpty();

    const row = document.createElement('div');
    row.className = 'msg-row';
    row.dataset.id = messageId;

    const now = new Date();
    const timeStr = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

    row.innerHTML = `
      <div class="msg-avatar avatar-ai">AI</div>
      <div class="msg-body">
        <div class="msg-meta">Connpass · ${timeStr}</div>
        <div class="tool-cards-container" data-message-id="${messageId}"></div>
        <div class="msg-content" data-content-id="${messageId}"></div>
        <span class="cursor" data-cursor-id="${messageId}"></span>
      </div>
    `;

    this.container.appendChild(row);
    this._rawBuffers[messageId] = '';
    this.scrollToBottom();
    return row;
  },

  // ── 스트리밍 delta 추가 ─────────────────────────────────
  appendToken(messageId, delta) {
    if (!delta) return;

    // raw buffer 축적
    if (this._rawBuffers[messageId] === undefined) {
      this._rawBuffers[messageId] = '';
    }
    this._rawBuffers[messageId] += delta;

    const contentEl = this.container.querySelector(`[data-content-id="${messageId}"]`);
    if (!contentEl) return;

    // 스트리밍 중에는 escaping된 텍스트를 plain으로 보여주다가
    // finalizeMessage 에서 마크다운 렌더링
    contentEl.textContent = this._rawBuffers[messageId];
    this.scrollToBottom();
  },

  // ── 스트리밍 완료 시 마크다운 렌더링 ────────────────────
  finalizeMessage(messageId) {
    if (!messageId) return;

    const contentEl = this.container.querySelector(`[data-content-id="${messageId}"]`);
    const cursorEl = this.container.querySelector(`[data-cursor-id="${messageId}"]`);

    if (contentEl && this._rawBuffers[messageId] !== undefined) {
      const raw = this._rawBuffers[messageId];
      if (typeof marked !== 'undefined' && raw) {
        try {
          contentEl.innerHTML = marked.parse(raw);
          // hljs 적용 (marked highlight 옵션이 없는 경우 대비)
          if (typeof hljs !== 'undefined') {
            contentEl.querySelectorAll('pre code').forEach(block => {
              hljs.highlightElement(block);
            });
          }
        } catch (e) {
          contentEl.textContent = raw;
        }
      } else if (raw) {
        contentEl.textContent = raw;
      }
      delete this._rawBuffers[messageId];
    }

    // 커서 숨기기
    if (cursorEl) {
      cursorEl.classList.add('hidden');
    }

    this.scrollToBottom();
  },

  // ── tool call 카드 생성 (tool_start 이벤트) ─────────────
  createToolCard(toolCallId, toolName, toolLabel, params) {
    // 해당 메시지의 tool-cards-container 를 찾는다.
    // 최근에 생성된 assistant message의 container 사용
    const containers = this.container.querySelectorAll('.tool-cards-container');
    const tc = containers[containers.length - 1];
    if (!tc) return;

    const card = document.createElement('div');
    card.className = 'tool-card';
    card.dataset.toolCallId = toolCallId;

    let paramsStr = '';
    if (params && typeof params === 'object') {
      try {
        paramsStr = JSON.stringify(params, null, 2);
      } catch (e) {
        paramsStr = String(params);
      }
    } else if (params) {
      paramsStr = String(params);
    }

    const displayLabel = toolLabel || toolName;

    card.innerHTML = `
      <div class="tool-card-head" onclick="this.parentElement.querySelector('.tool-card-body').style.display = this.parentElement.querySelector('.tool-card-body').style.display === 'none' ? 'block' : 'none'">
        <div class="tool-status-dot dot-running"></div>
        <span class="tool-name">${this._escapeHtml(displayLabel)}</span>
        <span class="tool-duration tool-duration-el">...</span>
      </div>
      <div class="tool-card-body" style="display:none">
        <div class="tool-args"><pre style="margin:0;font-size:11px;color:var(--text-2);white-space:pre-wrap;word-break:break-all">${this._escapeHtml(paramsStr)}</pre></div>
      </div>
    `;

    card._startTime = Date.now();
    tc.appendChild(card);
    this.scrollToBottom();
    return card;
  },

  // ── tool 완료 업데이트 (tool_end 이벤트) ────────────────
  updateToolCard(toolCallId, details) {
    const card = this.container.querySelector(`[data-tool-call-id="${toolCallId}"]`);
    if (!card) return;

    const dot = card.querySelector('.tool-status-dot');
    const duration = card.querySelector('.tool-duration-el');

    const elapsed = card._startTime ? ((Date.now() - card._startTime) / 1000).toFixed(1) + 's' : '';

    if (dot) {
      dot.classList.remove('dot-running');
      const isError = details && details.error;
      dot.classList.add(isError ? 'dot-error' : 'dot-done');
    }

    if (duration) {
      duration.textContent = elapsed;
    }

    // 결과 요약 추가
    if (details) {
      const body = card.querySelector('.tool-card-body');
      if (body) {
        const resultEl = document.createElement('div');
        resultEl.className = 'tool-result';
        if (details.error) {
          resultEl.style.cssText = 'padding:8px 12px;border-top:1px solid var(--border);font-size:11px;color:var(--red);background:var(--red-dim);';
          resultEl.textContent = '✗ ' + (details.error || 'Error');
        } else {
          const summary = details.summary || details.result || (typeof details === 'string' ? details : '완료');
          resultEl.textContent = '✓ ' + (typeof summary === 'string' ? summary : JSON.stringify(summary));
        }
        body.appendChild(resultEl);
      }
    }
  },

  // ── 컴팩션 알림 ─────────────────────────────────────────
  addCompactionNotice(message) {
    const notice = document.createElement('div');
    notice.className = 'compaction-notice';
    notice.innerHTML = `<span>⚡ ${this._escapeHtml(message || '대화가 길어져 이전 내용을 요약했습니다')}</span>`;
    this.container.appendChild(notice);
    this.scrollToBottom();
  },

  // ── 번역 결과 말풍선 ────────────────────────────────────
  createTranslateMessage(messageId, sourceLang, targetLang) {
    this._hideEmpty();

    const row = document.createElement('div');
    row.className = 'msg-row';
    row.dataset.id = messageId;

    const now = new Date();
    const timeStr = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    const src = sourceLang || 'AUTO';
    const tgt = targetLang || 'KO';

    row.innerHTML = `
      <div class="msg-avatar avatar-ai">AI</div>
      <div class="msg-body">
        <div class="msg-meta">Connpass · ${timeStr}</div>
        <div class="msg-translate-result">
          <div class="msg-translate-meta">${this._escapeHtml(src)} → ${this._escapeHtml(tgt)}</div>
          <div class="msg-content" data-content-id="${messageId}" style="white-space:pre-wrap"></div>
          <span class="cursor" data-cursor-id="${messageId}"></span>
        </div>
      </div>
    `;

    this.container.appendChild(row);
    this._rawBuffers[messageId] = '';
    this.scrollToBottom();
    return row;
  },

  // ── 스크롤 하단으로 ──────────────────────────────────────
  scrollToBottom() {
    if (this.container) {
      requestAnimationFrame(() => {
        this.container.scrollTop = this.container.scrollHeight;
      });
    }
  },

  // ── 빈 상태 표시 ────────────────────────────────────────
  showEmpty() {
    const emptyState = document.getElementById('empty-state');
    if (emptyState) emptyState.style.display = 'flex';
  },

  // ── 채팅 클리어 ──────────────────────────────────────────
  clear() {
    if (this.container) {
      // empty-state를 제외한 모든 자식 제거
      const children = Array.from(this.container.children);
      children.forEach(child => {
        if (!child.id || child.id !== 'empty-state') {
          child.remove();
        }
      });
    }
    this._rawBuffers = {};
  },

  // ── Private: empty-state 숨기기 ─────────────────────────
  _hideEmpty() {
    const emptyState = document.getElementById('empty-state');
    if (emptyState) emptyState.style.display = 'none';
  },

  // ── Private: HTML escape ─────────────────────────────────
  _escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },
};
