/* =========================================================
   connpass — settings.js
   설정 패널 로직 (SettingsPanel)
   ========================================================= */

'use strict';

const SettingsPanel = {
  isOpen: false,
  currentSection: 'llm', // 'llm' | 'mcp' | 'skill' | 'agentmd' | 'translate' | 'ui'

  // ── 초기화 ──────────────────────────────────────────────
  init() {
    // 설정 섹션 nav 클릭 이벤트
    document.querySelectorAll('.nav-item[data-section]').forEach(item => {
      item.addEventListener('click', () => {
        this.showSection(item.dataset.section);
      });
    });

    // 저장 버튼
    const saveBtn = document.getElementById('settings-save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => this._saveAll());
    }

    // 설정 토글 버튼
    const toggleBtn = document.getElementById('settings-toggle-btn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => this.toggle());
    }

    // 모델 카드 선택
    document.querySelectorAll('.model-card').forEach(card => {
      card.addEventListener('click', () => {
        document.querySelectorAll('.model-card').forEach(c => c.classList.remove('sel'));
        card.classList.add('sel');
        // 상태 업데이트
        const modelName = card.querySelector('.model-name')?.textContent;
        if (modelName && typeof state !== 'undefined') {
          state.chatConfig.model = modelName;
          // topbar select 동기화
          const sel = document.getElementById('model-select');
          if (sel) sel.value = modelName;
        }
      });
    });

    // range 슬라이더 실시간 값 표시
    this._initRangeInputs();

    // toggle 버튼들
    document.querySelectorAll('.s-tog').forEach(tog => {
      tog.addEventListener('click', () => {
        tog.classList.toggle('on');
      });
    });

    // 테마 카드
    document.querySelectorAll('.s-theme-card').forEach(card => {
      card.addEventListener('click', () => {
        document.querySelectorAll('.s-theme-card').forEach(c => c.classList.remove('sel'));
        card.classList.add('sel');
        const theme = card.id === 's-theme-light' ? 'light' : 'dark';
        document.documentElement.dataset.theme = theme;
        localStorage.setItem('connpass-theme', theme);
      });
    });

    // 저장된 테마 복원
    const savedTheme = localStorage.getItem('connpass-theme');
    if (savedTheme) {
      document.documentElement.dataset.theme = savedTheme;
      const activeCard = document.getElementById(`s-theme-${savedTheme}`);
      if (activeCard) {
        document.querySelectorAll('.s-theme-card').forEach(c => c.classList.remove('sel'));
        activeCard.classList.add('sel');
      }
    }

    // 강조 색상 스워치
    document.querySelectorAll('.s-swatch').forEach(swatch => {
      swatch.addEventListener('click', () => {
        const accent = swatch.style.background || swatch.dataset.color;
        if (!accent) return;
        document.querySelectorAll('.s-swatch').forEach(s => s.classList.remove('sel'));
        swatch.classList.add('sel');
        // CSS 변수 직접 적용 (UI only)
        const glow = this._hexToRgba(accent, 0.12);
        const dim = this._hexToRgba(accent, 0.18);
        document.documentElement.style.setProperty('--accent', accent);
        document.documentElement.style.setProperty('--accent-glow', glow);
        document.documentElement.style.setProperty('--accent-dim', dim);
      });
    });

    // 폰트 옵션
    document.querySelectorAll('.s-font-opt').forEach(opt => {
      opt.addEventListener('click', () => {
        document.querySelectorAll('.s-font-opt').forEach(o => o.classList.remove('sel'));
        opt.classList.add('sel');
      });
    });

    // 밀도 옵션
    document.querySelectorAll('.s-density-opt').forEach(opt => {
      opt.addEventListener('click', () => {
        document.querySelectorAll('.s-density-opt').forEach(o => o.classList.remove('sel'));
        opt.classList.add('sel');
      });
    });

    // Agent.md 변수 삽입 버튼
    document.querySelectorAll('[data-insert-var]').forEach(btn => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.insertVar;
        const ta = document.getElementById('agentmd-input');
        if (ta && v) this._insertAtCursor(ta, v);
      });
    });

    // 번역 프롬프트 변수 삽입 버튼
    document.querySelectorAll('[data-insert-tvar]').forEach(btn => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.insertTvar;
        const ta = document.getElementById('translate-prompt-input');
        if (ta && v) this._insertAtCursor(ta, v);
      });
    });

    // Jira 추가 버튼
    const addJiraBtn = document.getElementById('add-jira-btn');
    if (addJiraBtn) {
      addJiraBtn.dataset.bound = '1';
      addJiraBtn.addEventListener('click', () => {
        const form = document.getElementById('s-add-jira');
        if (form) form.classList.toggle('open');
      });
    }

    // Jira 등록 버튼
    const registerJiraBtn = document.getElementById('register-jira-btn');
    if (registerJiraBtn) {
      registerJiraBtn.dataset.bound = '1';
      registerJiraBtn.addEventListener('click', () => this._registerJira());
    }

    // Jira 취소 버튼
    const cancelJiraBtn = document.getElementById('cancel-jira-btn');
    if (cancelJiraBtn) {
      cancelJiraBtn.dataset.bound = '1';
      cancelJiraBtn.addEventListener('click', () => {
        const form = document.getElementById('s-add-jira');
        if (form) form.classList.remove('open');
      });
    }

    // MCP 추가 버튼
    const addMcpBtn = document.getElementById('add-mcp-btn');
    if (addMcpBtn) {
      addMcpBtn.addEventListener('click', () => {
        const form = document.getElementById('s-add-mcp');
        if (form) form.classList.toggle('open');
      });
    }

    // MCP 등록 버튼
    const registerMcpBtn = document.getElementById('register-mcp-btn');
    if (registerMcpBtn) {
      registerMcpBtn.addEventListener('click', () => this._registerMcp());
    }

    // MCP 취소 버튼
    const cancelMcpBtn = document.getElementById('cancel-mcp-btn');
    if (cancelMcpBtn) {
      cancelMcpBtn.addEventListener('click', () => {
        const form = document.getElementById('s-add-mcp');
        if (form) form.classList.remove('open');
      });
    }

    // Gerrit 추가 버튼
    const addGerritBtn = document.getElementById('add-gerrit-btn');
    if (addGerritBtn) {
      addGerritBtn.addEventListener('click', () => {
        const form = document.getElementById('s-add-gerrit');
        if (form) form.classList.toggle('open');
      });
    }

    // Gerrit 등록 버튼
    const registerGerritBtn = document.getElementById('register-gerrit-btn');
    if (registerGerritBtn) {
      registerGerritBtn.addEventListener('click', () => this._registerGerrit());
    }

    // Gerrit 취소 버튼
    const cancelGerritBtn = document.getElementById('cancel-gerrit-btn');
    if (cancelGerritBtn) {
      cancelGerritBtn.addEventListener('click', () => {
        const form = document.getElementById('s-add-gerrit');
        if (form) form.classList.remove('open');
      });
    }

    // 공통 파라미터 저장 버튼
    const saveCommonBtn = document.getElementById('save-common-params-btn');
    if (saveCommonBtn) {
      saveCommonBtn.addEventListener('click', () => this.saveModelSettings());
    }

    // LLM 모델 추가 버튼
    const addLlmBtn = document.getElementById('add-llm-model-btn');
    if (addLlmBtn) {
      addLlmBtn.addEventListener('click', () => {
        const form = document.getElementById('s-add-llm');
        if (form) form.classList.toggle('open');
      });
    }

    // vLLM 모델 목록 조회 버튼
    const fetchVllmBtn = document.getElementById('fetch-vllm-models-btn');
    if (fetchVllmBtn) {
      fetchVllmBtn.addEventListener('click', () => this._fetchVllmModels());
    }

    // 모델 선택 시 표시 이름 자동 입력
    const modelIdSel = document.getElementById('new-llm-model-id');
    if (modelIdSel) {
      modelIdSel.addEventListener('change', () => {
        const nameInput = document.getElementById('new-llm-display-name');
        if (nameInput && modelIdSel.value && !nameInput.value) {
          nameInput.value = modelIdSel.value;
        }
      });
    }

    // LLM 모델 등록 버튼
    const registerLlmBtn = document.getElementById('register-llm-model-btn');
    if (registerLlmBtn) {
      registerLlmBtn.addEventListener('click', () => this._registerLlmModel());
    }

    // LLM 모델 추가 폼 취소
    const cancelLlmBtn = document.getElementById('cancel-llm-model-btn');
    if (cancelLlmBtn) {
      cancelLlmBtn.addEventListener('click', () => {
        const form = document.getElementById('s-add-llm');
        if (form) form.classList.remove('open');
        this._resetLlmForm();
      });
    }

    // 연결 테스트 버튼
    const testConnBtn = document.getElementById('test-conn-btn');
    if (testConnBtn) {
      testConnBtn.addEventListener('click', () => this._testConnection());
    }

    // Skill md 토글
    document.querySelectorAll('.skill-md-toggle-btn').forEach(btn => {
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

    // 기본 타겟 언어 버튼 (번역 설정)
    document.querySelectorAll('.default-lang-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.closest('div').querySelectorAll('.default-lang-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // 저장된 설정 로드
    this._loadSavedSettings();

    // Jira / Gerrit 서버 목록 초기 로드
    this.loadJiraServers();
    this.loadGerritServers();

    // LLM 모델 설정 초기 로드
    this.loadModelSettings();
    this.loadLlmConfigs();
  },

  // ── 설정 패널 열기 ──────────────────────────────────────
  open(section) {
    this.isOpen = true;
    const chatArea = document.querySelector('.chat-area');
    const settingsView = document.getElementById('settings-view');
    const toggleBtn = document.getElementById('settings-toggle-btn');

    if (chatArea) chatArea.style.display = 'none';
    if (settingsView) settingsView.classList.add('active');
    if (toggleBtn) toggleBtn.classList.add('active');

    if (section) this.showSection(section);
  },

  // ── 설정 패널 닫기 ──────────────────────────────────────
  close() {
    this.isOpen = false;
    const chatArea = document.querySelector('.chat-area');
    const settingsView = document.getElementById('settings-view');
    const toggleBtn = document.getElementById('settings-toggle-btn');

    if (chatArea) chatArea.style.display = '';
    if (settingsView) settingsView.classList.remove('active');
    if (toggleBtn) toggleBtn.classList.remove('active');
  },

  // ── 토글 ─────────────────────────────────────────────────
  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open(this.currentSection);
    }
  },

  // ── 섹션 전환 ────────────────────────────────────────────
  showSection(section) {
    this.currentSection = section;

    document.querySelectorAll('.sec').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    const secEl = document.getElementById('sec-' + section);
    if (secEl) secEl.classList.add('active');

    const navEl = document.querySelector(`.nav-item[data-section="${section}"]`);
    if (navEl) navEl.classList.add('active');

    const content = document.querySelector('.settings-content');
    if (content) content.scrollTop = 0;

    // 섹션별 데이터 로드
    if (section === 'llm') { this.loadModelSettings(); this.loadLlmConfigs(); }
    if (section === 'jira') this.loadJiraServers();
    if (section === 'gerrit') this.loadGerritServers();
    if (section === 'mcp') this.loadMcpServers();
  },

  // ── 모델 설정 로드 (기본 모델 선택 + 공통 파라미터) ──────
  async loadModelSettings() {
    try {
      const API_URL = (typeof window.API_URL !== 'undefined') ? window.API_URL : 'http://localhost:5000';
      const res = await fetch(`${API_URL}/api/settings/model`);
      if (!res.ok) return;
      const data = await res.json();

      // 기본 모델 카드 선택 상태 업데이트
      if (data.model) {
        document.querySelectorAll('.model-card').forEach(card => {
          const name = card.querySelector('.model-name')?.textContent;
          card.classList.toggle('sel', name === data.model);
        });
        if (typeof state !== 'undefined') state.chatConfig.model = data.model;
        const sel = document.getElementById('model-select');
        if (sel) sel.value = data.model;
      }

      // 공통 파라미터: maxToolSteps
      if (data.maxToolSteps !== undefined) {
        const stepsRange = document.getElementById('range-maxsteps');
        const stepsVal = document.getElementById('sv-step');
        if (stepsRange) { stepsRange.value = data.maxToolSteps; }
        if (stepsVal) stepsVal.textContent = data.maxToolSteps;
        if (typeof state !== 'undefined') state.chatConfig.maxToolSteps = data.maxToolSteps;
      }

      // 공통 파라미터: thinkingMode
      if (data.thinkingMode !== undefined) {
        const sel = document.getElementById('sel-thinking');
        if (sel) sel.value = data.thinkingMode;
        if (typeof state !== 'undefined') state.chatConfig.thinkingMode = data.thinkingMode;
      }
    } catch (e) {
      // 서버 미연결 시 무시
    }
  },

  // ── 공통 파라미터 저장 (maxToolSteps, thinkingMode) ──────
  async saveModelSettings() {
    try {
      const API_URL = (typeof window.API_URL !== 'undefined') ? window.API_URL : 'http://localhost:5000';
      const selectedCard = document.querySelector('.model-card.sel');
      const model = selectedCard?.querySelector('.model-name')?.textContent || 'GLM4.7';
      const maxToolSteps = parseInt(document.getElementById('range-maxsteps')?.value || '10');
      const thinkingMode = document.getElementById('sel-thinking')?.value || 'off';

      await fetch(`${API_URL}/api/settings/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, maxToolSteps, thinkingMode }),
      });

      const saveBtn = document.getElementById('save-common-params-btn');
      if (saveBtn) {
        const orig = saveBtn.textContent;
        saveBtn.textContent = '저장됨 ✓';
        saveBtn.disabled = true;
        setTimeout(() => { saveBtn.textContent = orig; saveBtn.disabled = false; }, 1500);
      }
    } catch (e) {
      // 서버 미연결 시 무시
    }
  },

  // ── LLM 모델별 설정 로드 ────────────────────────────────
  async loadLlmConfigs() {
    try {
      const API_URL = (typeof window.API_URL !== 'undefined') ? window.API_URL : 'http://localhost:5000';
      const res = await fetch(`${API_URL}/api/settings/llm-configs`);
      if (!res.ok) return;
      const configs = await res.json();
      this._renderLlmConfigs(configs);
    } catch (e) {
      // 서버 미연결 시 무시
    }
  },

  // ── LLM 모델별 설정 저장 ────────────────────────────────
  async saveLlmConfig(modelId) {
    const API_URL = (typeof window.API_URL !== 'undefined') ? window.API_URL : 'http://localhost:5000';
    const row = document.querySelector(`.llm-cfg-row[data-model="${modelId}"]`);
    if (!row) return;

    const displayName = row.querySelector('.llm-cfg-display-name')?.value || modelId;
    const baseUrl = row.querySelector('.llm-cfg-url')?.value || 'http://vllm.internal/v1';
    const apiKey = row.querySelector('.llm-cfg-key')?.value || '';
    const temperature = parseFloat(row.querySelector('.llm-cfg-temp')?.value || '0.7');
    const maxTokens = parseInt(row.querySelector('.llm-cfg-tokens')?.value || '4096');
    const contextWindow = parseInt(row.querySelector('.llm-cfg-ctx')?.value || '128000');

    try {
      const res = await fetch(`${API_URL}/api/settings/llm-configs/${encodeURIComponent(modelId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: displayName, base_url: baseUrl, api_key: apiKey, temperature, max_tokens: maxTokens, context_window: contextWindow }),
      });
      if (!res.ok) throw new Error('Failed to save');

      const saveBtn = row.querySelector('.llm-cfg-save-btn');
      if (saveBtn) {
        const orig = saveBtn.textContent;
        saveBtn.textContent = '저장됨 ✓';
        saveBtn.disabled = true;
        setTimeout(() => { saveBtn.textContent = orig; saveBtn.disabled = false; }, 1500);
      }
    } catch (e) {
      alert(`저장 실패: ${e.message}`);
    }
  },

  // ── LLM 모델별 설정 렌더링 ──────────────────────────────
  _renderLlmConfigs(configs) {
    const container = document.getElementById('llm-model-configs');
    if (!container) return;

    // 사용자 추가 모델 카드 렌더링 (#user-model-cards)
    const userCards = document.getElementById('user-model-cards');
    const userModels = configs.filter(c => !c.is_builtin);
    if (userCards) {
      if (userModels.length > 0) {
        userCards.innerHTML = '<div style="border-top:1px solid var(--border);margin-top:6px;padding-top:6px;font-size:10px;color:var(--text-2);letter-spacing:.05em;margin-bottom:4px">— 사용자 추가 —</div>' +
          userModels.map(cfg => `
            <div class="model-card" data-model="${cfg.model_id}">
              <div class="model-icon">🔧</div>
              <div class="model-info">
                <div class="model-name">${cfg.display_name || cfg.model_id}</div>
                <div class="model-meta">
                  <span>${Math.round(cfg.context_window / 1000)}K ctx</span>
                  <span>tool_call ✓</span>
                </div>
              </div>
            </div>`).join('');
        // 카드 클릭 이벤트 재등록
        userCards.querySelectorAll('.model-card').forEach(card => {
          card.addEventListener('click', () => {
            document.querySelectorAll('.model-card').forEach(c => c.classList.remove('sel'));
            card.classList.add('sel');
            const modelName = card.querySelector('.model-name')?.textContent;
            if (modelName && typeof state !== 'undefined') {
              state.chatConfig.model = modelName;
              const sel = document.getElementById('model-select');
              if (sel) sel.value = modelName;
            }
          });
        });
      } else {
        userCards.innerHTML = '';
      }
      // topbar model-select에 사용자 추가 모델 옵션 동기화
      this._syncModelSelectOptions(userModels);
    }

    // 설정 행 렌더링 (빌트인 + 사용자 모두)
    container.innerHTML = configs.map(cfg => {
      const modelId = cfg.model_id;
      const isBuiltin = cfg.is_builtin;
      const deleteBtn = isBuiltin ? '' :
        `<button class="s-btn-sm s-danger llm-cfg-del-btn" onclick="SettingsPanel.deleteLlmModel('${modelId}')" style="margin-right:auto">삭제</button>`;
      return `
        <div class="llm-cfg-row" data-model="${modelId}">
          <div class="llm-cfg-header" onclick="this.parentElement.classList.toggle('open')">
            <span class="llm-cfg-name">${cfg.display_name || modelId}</span>
            <span class="llm-cfg-url-preview">${cfg.base_url}</span>
            <span class="llm-cfg-chevron">▾</span>
          </div>
          <div class="llm-cfg-body">
            <div class="s-form-row">
              <div class="s-form-label">표시 이름</div>
              <div class="s-form-ctrl"><input class="s-input llm-cfg-display-name" type="text" value="${cfg.display_name || modelId}"></div>
            </div>
            <div class="s-form-row">
              <div class="s-form-label">서버 URL</div>
              <div class="s-form-ctrl"><input class="s-input llm-cfg-url" type="text" value="${cfg.base_url}" placeholder="http://vllm.internal/v1"></div>
            </div>
            <div class="s-form-row">
              <div class="s-form-label">API Key<small>선택사항</small></div>
              <div class="s-form-ctrl"><input class="s-input llm-cfg-key" type="password" value="${cfg.api_key || ''}" placeholder="sk-..."></div>
            </div>
            <div class="s-form-row">
              <div class="s-form-label">Temperature</div>
              <div class="s-form-ctrl">
                <div class="range-wrap">
                  <input type="range" class="llm-cfg-temp" min="0" max="2" step="0.1" value="${cfg.temperature}"
                    oninput="this.nextElementSibling.textContent=parseFloat(this.value).toFixed(1)">
                  <span class="range-val">${parseFloat(cfg.temperature).toFixed(1)}</span>
                </div>
              </div>
            </div>
            <div class="s-form-row">
              <div class="s-form-label">Max Tokens</div>
              <div class="s-form-ctrl">
                <div class="range-wrap">
                  <input type="range" class="llm-cfg-tokens" min="512" max="32768" step="256" value="${cfg.max_tokens}"
                    oninput="this.nextElementSibling.textContent=Number(this.value).toLocaleString()">
                  <span class="range-val" style="width:48px">${Number(cfg.max_tokens).toLocaleString()}</span>
                </div>
              </div>
            </div>
            <div class="s-form-row">
              <div class="s-form-label">Context Window</div>
              <div class="s-form-ctrl"><input class="s-input llm-cfg-ctx" type="number" value="${cfg.context_window}" min="1024" step="1024"></div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
              ${deleteBtn}
              <button class="s-btn-sm llm-cfg-save-btn" onclick="SettingsPanel.saveLlmConfig('${modelId}')" style="padding:6px 14px;margin-left:auto">저장</button>
            </div>
          </div>
        </div>`;
    }).join('');
  },

  // ── topbar model-select 사용자 모델 옵션 동기화 ─────────
  _syncModelSelectOptions(userModels) {
    const sel = document.getElementById('model-select');
    if (!sel) return;
    // 기존 사용자 추가 optgroup 제거
    const existing = sel.querySelector('optgroup[label="사용자 추가"]');
    if (existing) existing.remove();
    if (!userModels || userModels.length === 0) return;
    const grp = document.createElement('optgroup');
    grp.label = '사용자 추가';
    userModels.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.model_id;
      opt.textContent = m.display_name || m.model_id;
      grp.appendChild(opt);
    });
    sel.appendChild(grp);
  },

  // ── vLLM 서버에서 모델 목록 조회 ────────────────────────
  async _fetchVllmModels() {
    const API_URL = (typeof window.API_URL !== 'undefined') ? window.API_URL : 'http://localhost:5000';
    const baseUrl = document.getElementById('new-llm-base-url')?.value?.trim() || '';
    const apiKey = document.getElementById('new-llm-api-key')?.value?.trim() || '';
    const statusEl = document.getElementById('fetch-vllm-status');
    const pickerEl = document.getElementById('vllm-model-picker');
    const selectEl = document.getElementById('new-llm-model-id');

    if (!baseUrl) {
      if (statusEl) statusEl.textContent = '서버 URL을 입력하세요';
      return;
    }

    if (statusEl) { statusEl.textContent = '조회 중...'; statusEl.style.color = 'var(--text-2)'; }

    try {
      const params = new URLSearchParams({ base_url: baseUrl });
      if (apiKey) params.set('api_key', apiKey);
      const res = await fetch(`${API_URL}/api/settings/llm-configs/vllm-models?${params}`);
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || 'Failed');

      const models = data.models || [];
      if (models.length === 0) {
        if (statusEl) { statusEl.textContent = '모델 없음'; statusEl.style.color = 'var(--orange)'; }
        return;
      }

      // 이미 등록된 model_id 목록
      const existingIds = Array.from(
        document.querySelectorAll('.llm-cfg-row')
      ).map(r => r.dataset.model);

      if (selectEl) {
        selectEl.innerHTML = '<option value="">— 모델 선택 —</option>' +
          models.map(id => {
            const registered = existingIds.includes(id);
            return `<option value="${id}"${registered ? ' disabled' : ''}>${id}${registered ? ' (등록됨)' : ''}</option>`;
          }).join('');
      }
      if (pickerEl) pickerEl.style.display = 'block';
      if (statusEl) { statusEl.textContent = `${models.length}개 모델 발견`; statusEl.style.color = 'var(--green)'; }
    } catch (e) {
      if (statusEl) { statusEl.textContent = e.message; statusEl.style.color = 'var(--red)'; }
    }
  },

  // ── LLM 모델 등록 ───────────────────────────────────────
  async _registerLlmModel() {
    const API_URL = (typeof window.API_URL !== 'undefined') ? window.API_URL : 'http://localhost:5000';
    const modelId = document.getElementById('new-llm-model-id')?.value?.trim();
    const displayName = document.getElementById('new-llm-display-name')?.value?.trim() || modelId;
    const baseUrl = document.getElementById('new-llm-base-url')?.value?.trim() || 'http://vllm.internal/v1';
    const apiKey = document.getElementById('new-llm-api-key')?.value?.trim() || '';
    const temperature = parseFloat(document.getElementById('new-llm-temp')?.value || '0.7');
    const maxTokens = parseInt(document.getElementById('new-llm-max-tokens')?.value || '4096');
    const ctxWindow = parseInt(document.getElementById('new-llm-ctx')?.value || '128000');

    if (!modelId) { alert('모델을 선택해주세요'); return; }

    const btn = document.getElementById('register-llm-model-btn');
    if (btn) { btn.textContent = '등록 중...'; btn.disabled = true; }

    try {
      const res = await fetch(`${API_URL}/api/settings/llm-configs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model_id: modelId,
          display_name: displayName,
          base_url: baseUrl,
          api_key: apiKey,
          temperature,
          max_tokens: maxTokens,
          context_window: ctxWindow,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');

      // 폼 닫기 + 목록 갱신
      const form = document.getElementById('s-add-llm');
      if (form) form.classList.remove('open');
      this._resetLlmForm();
      await this.loadLlmConfigs();
    } catch (e) {
      alert(`등록 실패: ${e.message}`);
    } finally {
      if (btn) { btn.textContent = '등록'; btn.disabled = false; }
    }
  },

  // ── LLM 모델 삭제 ───────────────────────────────────────
  async deleteLlmModel(modelId) {
    if (!confirm(`"${modelId}" 모델을 삭제할까요?`)) return;
    const API_URL = (typeof window.API_URL !== 'undefined') ? window.API_URL : 'http://localhost:5000';
    try {
      const res = await fetch(`${API_URL}/api/settings/llm-configs/${encodeURIComponent(modelId)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      await this.loadLlmConfigs();
    } catch (e) {
      alert(`삭제 실패: ${e.message}`);
    }
  },

  // ── LLM 추가 폼 초기화 ──────────────────────────────────
  _resetLlmForm() {
    const ids = ['new-llm-base-url','new-llm-api-key','new-llm-display-name'];
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    const statusEl = document.getElementById('fetch-vllm-status');
    if (statusEl) statusEl.textContent = '';
    const picker = document.getElementById('vllm-model-picker');
    if (picker) picker.style.display = 'none';
    const sel = document.getElementById('new-llm-model-id');
    if (sel) sel.innerHTML = '<option value="">— 모델 선택 —</option>';
  },

  // ── MCP 서버 목록 로드 ──────────────────────────────────
  async loadMcpServers() {
    try {
      const API_URL = (typeof window.API_URL !== 'undefined') ? window.API_URL : 'http://localhost:5000';
      const res = await fetch(`${API_URL}/api/mcp/servers`);
      if (!res.ok) return;
      const data = await res.json();
      this._renderMcpServers(data.servers || []);
    } catch (e) {
      // 서버 미연결 시 무시
    }
  },

  // ── MCP 서버 추가 ────────────────────────────────────────
  async addMcpServer(name, url, transport = 'streamable-http') {
    const API_URL = (typeof window.API_URL !== 'undefined') ? window.API_URL : 'http://localhost:5000';
    const res = await fetch(`${API_URL}/api/mcp/servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url, transport }),
    });
    if (!res.ok) throw new Error('Failed to add MCP server');
    return await res.json();
  },

  // ── MCP 서버 삭제 ────────────────────────────────────────
  async deleteMcpServer(id) {
    const API_URL = (typeof window.API_URL !== 'undefined') ? window.API_URL : 'http://localhost:5000';
    const res = await fetch(`${API_URL}/api/mcp/servers/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete MCP server');
  },

  // ── MCP 서버 테스트 ──────────────────────────────────────
  async testMcpServer(id) {
    const API_URL = (typeof window.API_URL !== 'undefined') ? window.API_URL : 'http://localhost:5000';
    const res = await fetch(`${API_URL}/api/mcp/servers/${id}/test`, { method: 'POST' });
    return await res.json();
  },

  // ── Jira 서버 목록 로드 ─────────────────────────────────
  async loadJiraServers() {
    try {
      const API_URL = (typeof window.API_URL !== 'undefined') ? window.API_URL : 'http://localhost:5000';
      const res = await fetch(`${API_URL}/api/jira/servers`);
      if (!res.ok) return;
      const data = await res.json();
      this._renderJiraServers(Array.isArray(data) ? data : []);
    } catch (e) {
      // 서버 미연결 시 무시
    }
  },

  // ── Jira 서버 추가 ───────────────────────────────────────
  async addJiraServer(name, url, email, token, prefixes = '') {
    const API_URL = (typeof window.API_URL !== 'undefined') ? window.API_URL : 'http://localhost:5000';
    const res = await fetch(`${API_URL}/api/jira/servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url, email, token, prefixes }),
    });
    if (!res.ok) throw new Error('Failed to add Jira server');
    return await res.json();
  },

  // ── Jira 서버 삭제 ───────────────────────────────────────
  async deleteJiraServer(id) {
    const API_URL = (typeof window.API_URL !== 'undefined') ? window.API_URL : 'http://localhost:5000';
    const res = await fetch(`${API_URL}/api/jira/servers/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete Jira server');
  },

  // ── Jira 서버 테스트 ─────────────────────────────────────
  async testJiraServer(id) {
    const API_URL = (typeof window.API_URL !== 'undefined') ? window.API_URL : 'http://localhost:5000';
    const res = await fetch(`${API_URL}/api/jira/servers/${id}/test`, { method: 'POST' });
    return await res.json();
  },

  // ── Skill 목록 로드 ──────────────────────────────────────
  async loadSkills() {
    try {
      const API_URL = (typeof window.API_URL !== 'undefined') ? window.API_URL : 'http://localhost:5000';
      const res = await fetch(`${API_URL}/api/skills`);
      if (!res.ok) return;
      const data = await res.json();
      // Skills are static in mockup; dynamic rendering is future work
      const badge = document.querySelector('.nav-item[data-section="skill"] .nav-badge');
      if (badge && data.skills) badge.textContent = data.skills.length;
    } catch (e) {
      // 서버 미연결 시 무시
    }
  },

  // ── 번역 설정 로드 ───────────────────────────────────────
  async loadTranslateSettings() {
    try {
      const saved = localStorage.getItem('translateConfig');
      if (saved) {
        const config = JSON.parse(saved);
        if (config.targetLang) {
          document.querySelectorAll('.default-lang-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.lang === config.targetLang);
          });
        }
        if (config.translatePrompt) {
          const ta = document.getElementById('translate-prompt-input');
          if (ta) ta.value = config.translatePrompt;
        }
      }
    } catch (e) {
      // 무시
    }
  },

  // ── 번역 설정 저장 ───────────────────────────────────────
  async saveTranslateSettings() {
    const activeLangBtn = document.querySelector('.default-lang-btn.active');
    const targetLang = activeLangBtn?.dataset.lang || 'KO';
    const translatePrompt = document.getElementById('translate-prompt-input')?.value || '';

    const config = { targetLang, translatePrompt };
    localStorage.setItem('translateConfig', JSON.stringify(config));

    // 앱 상태에 반영
    if (typeof state !== 'undefined') {
      state.translateConfig.targetLang = targetLang;
      state.translateConfig.translatePrompt = translatePrompt;
    }
  },

  // ── Agent.md 로드 ────────────────────────────────────────
  async loadAgentMd() {
    try {
      const API_URL = (typeof window.API_URL !== 'undefined') ? window.API_URL : 'http://localhost:5000';
      const res = await fetch(`${API_URL}/api/settings/agentmd`);
      if (!res.ok) return;
      const data = await res.json();
      const ta = document.getElementById('agentmd-input');
      if (ta && data.content) ta.value = data.content;
    } catch (e) {
      // 서버 미연결 시 무시
    }
  },

  // ── Agent.md 저장 ────────────────────────────────────────
  async saveAgentMd() {
    try {
      const API_URL = (typeof window.API_URL !== 'undefined') ? window.API_URL : 'http://localhost:5000';
      const ta = document.getElementById('agentmd-input');
      const content = ta?.value || '';
      await fetch(`${API_URL}/api/settings/agentmd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
    } catch (e) {
      // 서버 미연결 시 무시
    }
  },

  // ── Private: 전체 저장 ──────────────────────────────────
  async _saveAll() {
    try {
      await Promise.allSettled([
        this.saveModelSettings(),
        this.saveTranslateSettings(),
        this.saveAgentMd(),
      ]);
    } catch (e) {
      // 무시
    }

    // 저장 배지 표시
    const badge = document.getElementById('save-badge');
    if (badge) {
      badge.classList.add('show');
      setTimeout(() => badge.classList.remove('show'), 2500);
    }
  },

  // ── Private: MCP 등록 ────────────────────────────────────
  async _registerMcp() {
    const nameInput = document.getElementById('new-mcp-name');
    const urlInput = document.getElementById('new-mcp-url');
    const transportSelect = document.getElementById('new-mcp-transport');
    const name = nameInput?.value?.trim();
    const url = urlInput?.value?.trim();
    const transport = transportSelect?.value || 'streamable-http';

    if (!name || !url) {
      if (typeof showToast !== 'undefined') showToast('이름과 URL을 입력하세요', 'error');
      return;
    }

    const registerBtn = document.getElementById('register-mcp-btn');
    if (registerBtn) registerBtn.disabled = true;

    try {
      await this.addMcpServer(name, url, transport);
      if (typeof showToast !== 'undefined') showToast(`${name} MCP 서버가 등록되었습니다`, 'success');
      if (nameInput) nameInput.value = '';
      if (urlInput) urlInput.value = '';
      const form = document.getElementById('s-add-mcp');
      if (form) form.classList.remove('open');
      await this.loadMcpServers();
    } catch (e) {
      if (typeof showToast !== 'undefined') showToast('MCP 서버 등록 실패: ' + e.message, 'error');
    } finally {
      if (registerBtn) registerBtn.disabled = false;
    }
  },

  // ── Private: MCP 서버 목록 렌더링 ──────────────────────
  _renderMcpServers(servers) {
    const container = document.getElementById('mcp-servers-list');
    if (!container) return;

    container.innerHTML = '';
    servers.forEach(srv => {
      const row = document.createElement('div');
      row.className = 's-mcp-row';
      const isOn = srv.connected !== false;
      row.innerHTML = `
        <div class="s-mcp-head">
          <div class="s-dot ${isOn ? 's-dot-on' : 's-dot-off'}"></div>
          <span class="s-mcp-name">${this._esc(srv.name)}</span>
          <div class="s-mcp-acts">
            <button class="s-btn-sm" onclick="SettingsPanel.testMcpServer('${srv.id}').then(r => alert(JSON.stringify(r)))">테스트</button>
            <button class="s-btn-sm s-danger" onclick="SettingsPanel._confirmDeleteMcp('${srv.id}','${this._esc(srv.name)}')">삭제</button>
          </div>
          <button class="s-tog ${isOn ? 'on' : ''}" onclick="this.classList.toggle('on')"></button>
        </div>
        <div class="s-mcp-url">${this._esc(srv.url)}</div>
        ${srv.tools ? `<div class="s-chip-row">${srv.tools.map(t => `<span class="s-chip">${this._esc(t)}</span>`).join('')}</div>` : ''}
      `;
      container.appendChild(row);
    });
  },

  async _confirmDeleteMcp(id, name) {
    if (!confirm(`"${name}" MCP 서버를 삭제하시겠습니까?`)) return;
    try {
      await this.deleteMcpServer(id);
      if (typeof showToast !== 'undefined') showToast(`${name} 삭제됨`, 'success');
      await this.loadMcpServers();
    } catch (e) {
      if (typeof showToast !== 'undefined') showToast('삭제 실패: ' + e.message, 'error');
    }
  },

  // ── Private: Jira 등록 ──────────────────────────────────
  async _registerJira() {
    const nameInput = document.getElementById('new-jira-name');
    const urlInput = document.getElementById('new-jira-url');
    const emailInput = document.getElementById('new-jira-email');
    const tokenInput = document.getElementById('new-jira-token');
    const prefixesInput = document.getElementById('new-jira-prefixes');
    const name = nameInput?.value?.trim();
    const url = urlInput?.value?.trim();
    const email = emailInput?.value?.trim() || '';
    const token = tokenInput?.value?.trim() || '';
    const prefixes = prefixesInput?.value?.trim() || '';

    if (!name || !url) {
      if (typeof showToast !== 'undefined') showToast('이름과 URL을 입력하세요', 'error');
      return;
    }

    const registerBtn = document.getElementById('register-jira-btn');
    if (registerBtn) registerBtn.disabled = true;

    try {
      const srv = await this.addJiraServer(name, url, email, token, prefixes);
      // 등록 후 연결 테스트
      const result = await this.testJiraServer(srv.id);
      if (result.status === 'ok') {
        if (typeof showToast !== 'undefined') showToast(`${name} 연결 성공 (${result.user || 'OK'})`, 'success');
      } else {
        if (typeof showToast !== 'undefined') showToast(`등록됨 — 연결 확인 필요: ${result.error}`, 'warning');
      }
      if (nameInput) nameInput.value = '';
      if (urlInput) urlInput.value = '';
      if (emailInput) emailInput.value = '';
      if (tokenInput) tokenInput.value = '';
      if (prefixesInput) prefixesInput.value = '';
      const form = document.getElementById('s-add-jira');
      if (form) form.classList.remove('open');
      await this.loadJiraServers();
    } catch (e) {
      if (typeof showToast !== 'undefined') showToast('Jira 서버 등록 실패: ' + e.message, 'error');
    } finally {
      if (registerBtn) registerBtn.disabled = false;
    }
  },

  // ── Private: Jira 서버 목록 렌더링 ─────────────────────
  _renderJiraServers(servers) {
    const container = document.getElementById('jira-servers-list');
    if (!container) return;

    container.innerHTML = '';
    if (!servers.length) {
      container.innerHTML = '<div style="font-size:11px;color:var(--text-2);padding:8px 0">등록된 Jira 서버가 없습니다.</div>';
      return;
    }
    servers.forEach(srv => {
      const isCloud = srv.url && srv.url.includes('atlassian.net');
      const typeLabel = isCloud ? 'Cloud' : 'Server';
      const isOn = srv.enabled !== 0;
      const row = document.createElement('div');
      row.className = 's-mcp-row';
      row.innerHTML = `
        <div class="s-mcp-head">
          <div class="s-dot ${isOn ? 's-dot-on' : 's-dot-off'}"></div>
          <span class="s-mcp-name">${this._esc(srv.name)}</span>
          <div class="s-mcp-acts">
            <button class="s-btn-sm" onclick="SettingsPanel.testJiraServer('${srv.id}').then(r => alert(r.status === 'ok' ? '연결 성공: ' + (r.user || 'OK') : '연결 실패: ' + r.error))">테스트</button>
            <button class="s-btn-sm s-danger" onclick="SettingsPanel._confirmDeleteJira('${srv.id}','${this._esc(srv.name)}')">삭제</button>
          </div>
        </div>
        <div class="s-mcp-url">${this._esc(srv.url)}</div>
        <div class="s-chip-row">
          <span class="s-chip">${typeLabel}</span>
          ${srv.email ? `<span class="s-chip">${this._esc(srv.email)}</span>` : ''}
          ${srv.prefixes ? srv.prefixes.split(',').map(p => p.trim()).filter(Boolean).map(p => `<span class="s-chip" style="color:var(--accent)">${this._esc(p)}-*</span>`).join('') : ''}
        </div>
      `;
      container.appendChild(row);
    });
  },

  async _confirmDeleteJira(id, name) {
    if (!confirm(`"${name}" Jira 서버를 삭제하시겠습니까?`)) return;
    try {
      await this.deleteJiraServer(id);
      if (typeof showToast !== 'undefined') showToast(`${name} 삭제됨`, 'success');
      await this.loadJiraServers();
    } catch (e) {
      if (typeof showToast !== 'undefined') showToast('삭제 실패: ' + e.message, 'error');
    }
  },

  // ── Gerrit 서버 목록 로드 ────────────────────────────────
  async loadGerritServers() {
    try {
      const API_URL = (typeof window.API_URL !== 'undefined') ? window.API_URL : 'http://localhost:5000';
      const res = await fetch(`${API_URL}/api/gerrit/servers`);
      if (!res.ok) return;
      const data = await res.json();
      this._renderGerritServers(Array.isArray(data) ? data : []);
    } catch (e) {
      // 서버 미연결 시 무시
    }
  },

  // ── Gerrit 서버 추가 ─────────────────────────────────────
  async addGerritServer(name, url, username, token, auth_type) {
    const API_URL = (typeof window.API_URL !== 'undefined') ? window.API_URL : 'http://localhost:5000';
    const res = await fetch(`${API_URL}/api/gerrit/servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url, username, token, auth_type }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  // ── Gerrit 서버 삭제 ─────────────────────────────────────
  async deleteGerritServer(id) {
    const API_URL = (typeof window.API_URL !== 'undefined') ? window.API_URL : 'http://localhost:5000';
    const res = await fetch(`${API_URL}/api/gerrit/servers/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  // ── Gerrit 서버 연결 테스트 ──────────────────────────────
  async testGerritServer(id) {
    const API_URL = (typeof window.API_URL !== 'undefined') ? window.API_URL : 'http://localhost:5000';
    const res = await fetch(`${API_URL}/api/gerrit/servers/${id}/test`, { method: 'POST' });
    return res.json();
  },

  // ── Private: Gerrit 등록 ─────────────────────────────────
  async _registerGerrit() {
    const nameInput = document.getElementById('new-gerrit-name');
    const urlInput = document.getElementById('new-gerrit-url');
    const usernameInput = document.getElementById('new-gerrit-username');
    const tokenInput = document.getElementById('new-gerrit-token');
    const authTypeSelect = document.getElementById('new-gerrit-auth-type');
    const name = nameInput?.value?.trim();
    const url = urlInput?.value?.trim();
    const username = usernameInput?.value?.trim() || '';
    const token = tokenInput?.value?.trim() || '';
    const auth_type = authTypeSelect?.value || 'basic';

    if (!name || !url) {
      if (typeof showToast !== 'undefined') showToast('이름과 URL을 입력하세요', 'error');
      return;
    }

    const registerBtn = document.getElementById('register-gerrit-btn');
    if (registerBtn) registerBtn.disabled = true;

    try {
      await this.addGerritServer(name, url, username, token, auth_type);
      if (typeof showToast !== 'undefined') showToast(`${name} Gerrit 서버가 등록되었습니다`, 'success');
      [nameInput, urlInput, usernameInput, tokenInput].forEach(el => { if (el) el.value = ''; });
      const form = document.getElementById('s-add-gerrit');
      if (form) form.classList.remove('open');
      await this.loadGerritServers();
    } catch (e) {
      if (typeof showToast !== 'undefined') showToast('Gerrit 서버 등록 실패: ' + e.message, 'error');
    } finally {
      if (registerBtn) registerBtn.disabled = false;
    }
  },

  // ── Private: Gerrit 서버 목록 렌더링 ────────────────────
  _renderGerritServers(servers) {
    const container = document.getElementById('gerrit-servers-list');
    if (!container) return;

    container.innerHTML = '';
    if (!servers.length) {
      container.innerHTML = '<div style="font-size:11px;color:var(--text-2);padding:8px 0">등록된 Gerrit 서버가 없습니다.</div>';
      return;
    }
    servers.forEach(srv => {
      const isOn = srv.enabled !== 0;
      const authLabel = srv.auth_type === 'bearer' ? 'Bearer' : 'Basic';
      const row = document.createElement('div');
      row.className = 's-mcp-row';
      row.innerHTML = `
        <div class="s-mcp-head">
          <div class="s-dot ${isOn ? 's-dot-on' : 's-dot-off'}"></div>
          <span class="s-mcp-name">${this._esc(srv.name)}</span>
          <div class="s-mcp-acts">
            <button class="s-btn-sm" onclick="SettingsPanel.testGerritServer('${srv.id}').then(r => alert(r.status === 'ok' ? '연결 성공: ' + (r.user || 'OK') : '연결 실패: ' + r.error))">테스트</button>
            <button class="s-btn-sm s-danger" onclick="SettingsPanel._confirmDeleteGerrit('${srv.id}','${this._esc(srv.name)}')">삭제</button>
          </div>
        </div>
        <div class="s-mcp-url">${this._esc(srv.url)}</div>
        <div class="s-chip-row">
          <span class="s-chip">${authLabel}</span>
          ${srv.username ? `<span class="s-chip">${this._esc(srv.username)}</span>` : ''}
        </div>
      `;
      container.appendChild(row);
    });
  },

  async _confirmDeleteGerrit(id, name) {
    if (!confirm(`"${name}" Gerrit 서버를 삭제하시겠습니까?`)) return;
    try {
      await this.deleteGerritServer(id);
      if (typeof showToast !== 'undefined') showToast(`${name} 삭제됨`, 'success');
      await this.loadGerritServers();
    } catch (e) {
      if (typeof showToast !== 'undefined') showToast('삭제 실패: ' + e.message, 'error');
    }
  },

  // ── Private: 연결 테스트 ─────────────────────────────────
  async _testConnection() {
    const el = document.getElementById('conn-result');
    if (el) {
      el.style.color = 'var(--orange)';
      el.textContent = '연결 중...';
    }

    try {
      const API_URL = (typeof window.API_URL !== 'undefined') ? window.API_URL : 'http://localhost:5000';
      const res = await fetch(`${API_URL}/api/health`);
      if (res.ok) {
        if (el) {
          el.style.color = 'var(--green)';
          el.textContent = '✓ 연결 성공';
        }
      } else {
        throw new Error('HTTP ' + res.status);
      }
    } catch (e) {
      if (el) {
        el.style.color = 'var(--red)';
        el.textContent = '✗ 연결 실패 — ' + e.message;
      }
    }
  },

  // ── Private: range 입력 초기화 ──────────────────────────
  _initRangeInputs() {
    document.querySelectorAll('input[type=range][data-param]').forEach(input => {
      const displayId = input.dataset.display;
      if (displayId) {
        const display = document.getElementById(displayId);
        input.addEventListener('input', () => {
          if (display) {
            const val = input.dataset.format === 'int'
              ? Number(input.value).toLocaleString()
              : input.value;
            display.textContent = val + (input.dataset.suffix || '');
          }
          // 앱 상태에도 반영
          this._syncParamToState(input.dataset.param, input.value);
        });
      }
    });

    const stepRange = document.getElementById('range-maxsteps');
    const stepVal = document.getElementById('sv-step');
    if (stepRange && stepVal) {
      stepRange.addEventListener('input', () => {
        stepVal.textContent = stepRange.value;
        if (typeof state !== 'undefined') state.chatConfig.maxToolSteps = parseInt(stepRange.value);
      });
    }
  },

  _syncParamToState(param, value) {
    if (typeof state === 'undefined') return;
    switch (param) {
      case 'temperature': state.chatConfig.temperature = parseFloat(value); break;
      case 'maxTokens': state.chatConfig.maxTokens = parseInt(value); break;
      case 'maxToolSteps': state.chatConfig.maxToolSteps = parseInt(value); break;
    }
  },

  // ── Private: 저장된 설정 로드 ───────────────────────────
  _loadSavedSettings() {
    // localStorage에서 기본 설정 복원
    const savedModel = localStorage.getItem('selectedModel');
    if (savedModel) {
      document.querySelectorAll('.model-card').forEach(card => {
        const name = card.querySelector('.model-name')?.textContent;
        card.classList.toggle('sel', name === savedModel);
      });
    }

    const savedLang = localStorage.getItem('lang') || 'ko';
    document.querySelectorAll('.lang-btn').forEach(btn => {
      btn.classList.toggle('active', btn.textContent.toLowerCase() === savedLang);
    });
  },

  // ── Private: textarea 커서 위치에 삽입 ─────────────────
  _insertAtCursor(ta, text) {
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    ta.selectionStart = ta.selectionEnd = s + text.length;
    ta.focus();
  },

  // ── Private: hex to rgba ─────────────────────────────────
  _hexToRgba(hex, alpha) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) return `rgba(79,156,249,${alpha})`;
    const r = parseInt(result[1], 16);
    const g = parseInt(result[2], 16);
    const b = parseInt(result[3], 16);
    return `rgba(${r},${g},${b},${alpha})`;
  },

  // ── Private: HTML escape ─────────────────────────────────
  _esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },
};
