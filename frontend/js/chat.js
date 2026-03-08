/* =========================================================
   Connpass — chat.js
   블록 기반 메시지 렌더링 모듈 (ChatRenderer)
   블록 타입: user | thinking | assistant_text | tool_call | compaction | error
   ========================================================= */

'use strict';

const ChatRenderer = {
  container: null,
  _rawBuffers: {},
  _thinkingStart: {},

  // ── 초기화 ──────────────────────────────────────────────
  init(containerEl) {
    this.container = containerEl;
    if (typeof marked !== 'undefined') {
      marked.setOptions({
        breaks: true,
        gfm: true,
        highlight: function(code, lang) {
          if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
            try { return hljs.highlight(code, { language: lang }).value; } catch (e) { /* ignore */ }
          }
          return (typeof hljs !== 'undefined') ? hljs.highlightAuto(code).value : code;
        },
      });
    }
  },

  // ── 유틸: 동일 turnId의 첫 번째 블록인지 확인 ──────────
  _isFirstInTurn(turnId) {
    if (!turnId) return true;
    return !this.container.querySelector('[data-turn-id="' + turnId + '"]');
  },

  _makeAvatarLead(label, cls) {
    const lead = document.createElement('div');
    lead.className = 'block-lead';
    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar ' + cls;
    avatar.textContent = label;
    lead.appendChild(avatar);
    return lead;
  },

  _makeLineLead() {
    const lead = document.createElement('div');
    lead.className = 'block-lead';
    const line = document.createElement('div');
    line.className = 'block-lead-line';
    lead.appendChild(line);
    return lead;
  },

  // ── 사용자 메시지 블록 ──────────────────────────────────
  addUserBlock(text, blockId) {
    this._hideEmpty();
    const block = document.createElement('div');
    block.className = 'block block--user';
    block.dataset.blockId = blockId;
    block.dataset.type = 'user';
    const now = new Date();
    const timeStr = now.toLocaleTimeString(window.t ? window.t('time.locale') : 'ko-KR', { hour: '2-digit', minute: '2-digit' });
    const lead = this._makeAvatarLead('YL', 'avatar-user');
    const body = document.createElement('div');
    body.className = 'block-body';
    body.innerHTML = '<div class="msg-meta">' + timeStr + '</div><div class="msg-content">' + this._escapeHtml(text) + '</div>';
    block.appendChild(lead);
    block.appendChild(body);
    this.container.appendChild(block);
    this.scrollToBottom();
    return block;
  },

  // ── thinking 블록 ────────────────────────────────────────
  startThinkingBlock(blockId, turnId) {
    this._hideEmpty();
    const firstInTurn = this._isFirstInTurn(turnId);
    const block = document.createElement('div');
    block.className = 'block block--thinking' + (firstInTurn ? '' : ' block--continued');
    block.dataset.blockId = blockId;
    block.dataset.type = 'thinking';
    if (turnId) block.dataset.turnId = turnId;
    const lead = firstInTurn ? this._makeAvatarLead('AI', 'avatar-ai') : this._makeLineLead();
    const body = document.createElement('div');
    body.className = 'block-body';
    body.innerHTML =
      '<div class="thinking-accordion-head" aria-expanded="false" role="button">' +
        '<span style="font-size:12px">&#x1F4AD;</span>' +
        '<span class="thinking-label">' + (window.t ? window.t('thinking.label') : '생각 중...') + '</span>' +
        '<span class="tool-chevron">&#9658;</span>' +
        '<span class="thinking-duration"></span>' +
      '</div>' +
      '<div class="thinking-accordion-body" hidden>' +
        '<pre class="thinking-content" data-thinking-id="' + blockId + '"></pre>' +
      '</div>';
    const head = body.querySelector('.thinking-accordion-head');
    head.addEventListener('click', function() {
      const expanded = head.getAttribute('aria-expanded') === 'true';
      head.setAttribute('aria-expanded', String(!expanded));
      body.querySelector('.thinking-accordion-body').hidden = expanded;
    });
    block.appendChild(lead);
    block.appendChild(body);
    this.container.appendChild(block);
    this._thinkingStart[blockId] = Date.now();
    this._rawBuffers[blockId] = '';
    this.scrollToBottom();
    return block;
  },

  appendThinking(blockId, delta) {
    if (!delta) return;
    this._rawBuffers[blockId] = (this._rawBuffers[blockId] || '') + delta;
    const pre = this.container.querySelector('[data-thinking-id="' + blockId + '"]');
    if (pre) pre.textContent = this._rawBuffers[blockId];
    this.scrollToBottom();
  },

  finalizeThinkingBlock(blockId) {
    const block = this.container.querySelector('[data-block-id="' + blockId + '"]');
    if (!block) return;
    const elapsed = this._thinkingStart[blockId]
      ? ((Date.now() - this._thinkingStart[blockId]) / 1000).toFixed(1)
      : '';
    const label = block.querySelector('.thinking-label');
    if (label) label.textContent = window.t ? window.t('thinking.done') : '생각함';
    const dur = block.querySelector('.thinking-duration');
    if (dur && elapsed) dur.textContent = elapsed + 's';
    delete this._rawBuffers[blockId];
    delete this._thinkingStart[blockId];
  },

  // ── assistant text 블록 ──────────────────────────────────
  startTextBlock(blockId, turnId) {
    this._hideEmpty();
    const firstInTurn = this._isFirstInTurn(turnId);
    const block = document.createElement('div');
    block.className = 'block block--assistant-text' + (firstInTurn ? '' : ' block--continued');
    block.dataset.blockId = blockId;
    block.dataset.type = 'assistant_text';
    if (turnId) block.dataset.turnId = turnId;
    const lead = firstInTurn ? this._makeAvatarLead('AI', 'avatar-ai') : this._makeLineLead();
    const body = document.createElement('div');
    body.className = 'block-body';
    if (firstInTurn) {
      const now = new Date();
      const timeStr = now.toLocaleTimeString(window.t ? window.t('time.locale') : 'ko-KR', { hour: '2-digit', minute: '2-digit' });
      const meta = document.createElement('div');
      meta.className = 'block-meta';
      meta.textContent = 'Connpass \xB7 ' + timeStr;
      body.appendChild(meta);
    }
    const content = document.createElement('div');
    content.className = 'msg-content';
    content.dataset.contentId = blockId;
    body.appendChild(content);
    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    cursor.dataset.cursorId = blockId;
    body.appendChild(cursor);
    block.appendChild(lead);
    block.appendChild(body);
    this.container.appendChild(block);
    this._rawBuffers[blockId] = '';
    this.scrollToBottom();
    return block;
  },

  appendToken(blockId, delta) {
    if (!delta) return;
    this._rawBuffers[blockId] = (this._rawBuffers[blockId] || '') + delta;
    const contentEl = this.container.querySelector('[data-content-id="' + blockId + '"]');
    if (contentEl) contentEl.textContent = this._rawBuffers[blockId];
    this.scrollToBottom();
  },

  finalizeTextBlock(blockId) {
    if (!blockId) return;
    const contentEl = this.container.querySelector('[data-content-id="' + blockId + '"]');
    const cursorEl = this.container.querySelector('[data-cursor-id="' + blockId + '"]');
    if (contentEl && this._rawBuffers[blockId] !== undefined) {
      const raw = this._rawBuffers[blockId];
      if (typeof marked !== 'undefined' && raw) {
        try {
          contentEl.innerHTML = marked.parse(raw);
          if (typeof hljs !== 'undefined') {
            contentEl.querySelectorAll('pre code').forEach(function(b) { hljs.highlightElement(b); });
          }
        } catch (e) { contentEl.textContent = raw; }
      } else if (raw) {
        contentEl.textContent = raw;
      }
      delete this._rawBuffers[blockId];
    }
    if (cursorEl) cursorEl.classList.add('hidden');
    this.scrollToBottom();
  },

  // ── tool_call 아코디언 블록 ─────────────────────────────
  addToolCallBlock(toolCallId, toolName, toolLabel, params, turnId) {
    const block = document.createElement('div');
    block.className = 'block block--tool-call';
    block.dataset.toolCallId = toolCallId;
    block.dataset.type = 'tool_call';
    if (turnId) block.dataset.turnId = turnId;
    const lead = this._makeLineLead();
    const body = document.createElement('div');
    body.className = 'block-body';
    let paramsStr = '';
    if (params && typeof params === 'object') {
      try { paramsStr = JSON.stringify(params, null, 2); } catch (e) { paramsStr = String(params); }
    } else if (params) {
      paramsStr = String(params);
    }
    const displayLabel = toolLabel || toolName;
    body.innerHTML =
      '<div class="tool-accordion-head" aria-expanded="false" role="button">' +
        '<div class="tool-status-dot dot-running"></div>' +
        '<span class="tool-name-label">' + this._escapeHtml(displayLabel) + '</span>' +
        '<span class="tool-chevron">&#9658;</span>' +
        '<span class="tool-duration-el"></span>' +
      '</div>' +
      '<div class="tool-accordion-body" hidden>' +
        '<div class="tool-section--args">' +
          '<div class="tool-section-label">ARGS</div>' +
          '<pre>' + this._escapeHtml(paramsStr) + '</pre>' +
        '</div>' +
      '</div>';
    const head = body.querySelector('.tool-accordion-head');
    head.addEventListener('click', function() {
      const expanded = head.getAttribute('aria-expanded') === 'true';
      head.setAttribute('aria-expanded', String(!expanded));
      body.querySelector('.tool-accordion-body').hidden = expanded;
    });
    block._startTime = Date.now();
    block.appendChild(lead);
    block.appendChild(body);
    this.container.appendChild(block);
    this.scrollToBottom();
    return block;
  },

  updateToolCallBlock(toolCallId, details) {
    const block = this.container.querySelector('[data-tool-call-id="' + toolCallId + '"]');
    if (!block) return;
    const dot = block.querySelector('.tool-status-dot');
    const durationEl = block.querySelector('.tool-duration-el');
    const accordionBody = block.querySelector('.tool-accordion-body');
    const elapsed = block._startTime
      ? ((Date.now() - block._startTime) / 1000).toFixed(1) + 's'
      : '';
    if (dot) {
      dot.classList.remove('dot-running');
      dot.classList.add(details && details.error ? 'dot-error' : 'dot-done');
    }
    if (durationEl) durationEl.textContent = elapsed;
    if (accordionBody && details) {
      const isError = !!(details.error);
      const resultSection = document.createElement('div');
      resultSection.className = 'tool-section--result' + (isError ? ' result-error' : ' result-ok');
      const label = document.createElement('div');
      label.className = 'tool-section-label';
      label.textContent = 'RESULT';
      const content = document.createElement('div');
      content.className = 'tool-result-content';
      if (isError) {
        content.textContent = details.error || 'Error';
      } else {
        const summary = details.summary || details.result;
        content.textContent = typeof summary === 'string' ? summary : JSON.stringify(summary != null ? summary : '완료');
      }
      resultSection.appendChild(label);
      resultSection.appendChild(content);
      accordionBody.appendChild(resultSection);
    }
  },

  // ── compaction 블록 ─────────────────────────────────────
  addCompactionBlock(message) {
    const block = document.createElement('div');
    block.className = 'block--compaction';
    block.innerHTML =
      '<div class="compaction-divider"></div>' +
      '<span>&#x26A1; ' + this._escapeHtml(message || (window.t ? window.t('compaction.msg') : '대화가 길어져 이전 내용을 요약했습니다')) + '</span>' +
      '<div class="compaction-divider"></div>';
    this.container.appendChild(block);
    this.scrollToBottom();
  },

  // ── error 블록 ──────────────────────────────────────────
  addErrorBlock(message, code) {
    const block = document.createElement('div');
    block.className = 'block block--error';
    block.innerHTML =
      '<span class="error-icon">&#x2715;</span>' +
      '<span>' + this._escapeHtml(message || (window.t ? window.t('error.default') : '오류가 발생했습니다')) +
        (code ? ' <span style="opacity:0.6">(' + this._escapeHtml(code) + ')</span>' : '') +
      '</span>';
    this.container.appendChild(block);
    this.scrollToBottom();
  },

  // ── 번역 결과 (기존 방식 유지) ──────────────────────────
  createTranslateMessage(messageId, sourceLang, targetLang) {
    this._hideEmpty();
    const row = document.createElement('div');
    row.className = 'msg-row';
    row.dataset.id = messageId;
    const now = new Date();
    const timeStr = now.toLocaleTimeString(window.t ? window.t('time.locale') : 'ko-KR', { hour: '2-digit', minute: '2-digit' });
    const src = sourceLang || 'AUTO';
    const tgt = targetLang || 'KO';
    row.innerHTML =
      '<div class="msg-avatar avatar-ai">AI</div>' +
      '<div class="msg-body">' +
        '<div class="msg-meta">Connpass \xB7 ' + timeStr + '</div>' +
        '<div class="msg-translate-result">' +
          '<div class="msg-translate-meta">' + this._escapeHtml(src) + ' \u2192 ' + this._escapeHtml(tgt) + '</div>' +
          '<div class="msg-content" data-content-id="' + messageId + '" style="white-space:pre-wrap"></div>' +
          '<span class="cursor" data-cursor-id="' + messageId + '"></span>' +
        '</div>' +
      '</div>';
    this.container.appendChild(row);
    this._rawBuffers[messageId] = '';
    this.scrollToBottom();
    return row;
  },

  // ── 공통 ─────────────────────────────────────────────────
  scrollToBottom() {
    if (this.container) {
      requestAnimationFrame(function() {
        ChatRenderer.container.scrollTop = ChatRenderer.container.scrollHeight;
      });
    }
  },

  clear() {
    if (this.container) {
      Array.from(this.container.children).forEach(function(child) {
        if (!child.id || child.id !== 'empty-state') child.remove();
      });
    }
    this._rawBuffers = {};
    this._thinkingStart = {};
  },

  showEmpty() {
    const emptyState = document.getElementById('empty-state');
    if (emptyState) emptyState.style.display = 'flex';
  },

  _hideEmpty() {
    const emptyState = document.getElementById('empty-state');
    if (emptyState) emptyState.style.display = 'none';
  },

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
