/* global aeScripts */

(() => {
  'use strict';

  const CATEGORY_LABELS = { builtin: '自研脚本', external: '外部脚本', favorites: '常用脚本' };
  const state = {
    scripts: [],
    selectedId: null,
    activeCategory: 'builtin',
    search: '',
    membership: { isMember: false, status: 'unknown' },
    contextScriptId: null,
    lastRun: null,
    scanCandidates: [],
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const api = window.aeScripts || {};

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
  }

  function normalizeScript(script) {
    return {
      id: String(script.id),
      name: script.name || '未命名脚本',
      category: script.category === 'external' ? 'external' : 'builtin',
      description: script.description || '暂无简介。',
      aeVersions: Array.isArray(script.aeVersions) ? script.aeVersions : [],
      access: script.access === 'member' ? 'member' : 'free',
      tutorial: script.tutorial || '暂无教程。',
      tags: Array.isArray(script.tags) ? script.tags : [],
      isFavorite: Boolean(script.isFavorite),
      isHidden: Boolean(script.isHidden),
      note: script.note || '',
      canRun: Boolean(script.canRun),
      requiresMembership: script.access === 'member',
      type: script.type || '',
      runMode: script.runMode || '一次性脚本',
    };
  }

  async function callApi(method, ...args) {
    if (typeof api[method] !== 'function') throw new Error(`IPC 接口未暴露：${method}`);
    return api[method](...args);
  }

  function showToast(message, type = '') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`.trim();
    toast.textContent = message;
    $('#toast-region').appendChild(toast);
    window.setTimeout(() => toast.remove(), 3200);
  }

  function applyTheme(theme) {
    const nextTheme = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = nextTheme;
    localStorage.setItem('ae-scripts-theme', nextTheme);
    $('#theme-toggle').setAttribute('aria-label', `切换到${nextTheme === 'dark' ? '浅色' : '深色'}主题`);
  }

  function getFilteredScripts() {
    const keyword = state.search.trim().toLocaleLowerCase();
    return state.scripts.filter((script) => {
      if (script.isHidden) return false;
      if (state.activeCategory === 'favorites' && !script.isFavorite) return false;
      if (state.activeCategory !== 'favorites' && script.category !== state.activeCategory) return false;
      if (!keyword) return true;
      return [script.name, script.description, script.note].some((field) => String(field).toLocaleLowerCase().includes(keyword));
    });
  }

  function updateCounts() {
    const visible = state.scripts.filter((script) => !script.isHidden);
    const counts = {
      builtin: visible.filter((script) => script.category === 'builtin').length,
      external: visible.filter((script) => script.category === 'external').length,
      favorites: visible.filter((script) => script.isFavorite).length,
    };
    Object.entries(counts).forEach(([key, count]) => { $(`[data-count-for="${key}"]`).textContent = count; });
  }

  function renderCategoryChildren() {
    ['builtin', 'external', 'favorites'].forEach((category) => {
      const container = $(`[data-children-for="${category}"]`);
      const scripts = state.scripts.filter((script) => !script.isHidden && (category === 'favorites' ? script.isFavorite : script.category === category));
      container.innerHTML = scripts.slice(0, 8).map((script) => `<button class="category-child ${script.id === state.selectedId ? 'is-active' : ''}" data-script-id="${escapeHtml(script.id)}" type="button">${escapeHtml(script.name)}</button>`).join('');
    });
  }

  function renderList() {
    const scripts = getFilteredScripts();
    $('#current-category').textContent = CATEGORY_LABELS[state.activeCategory];
    $('#list-title').textContent = state.search ? `搜索结果：${state.search}` : '全部脚本';
    $('#result-count').textContent = `${scripts.length} 个脚本`;
    // 正常渲染时隐藏加载提示；刷新失败时 refreshScripts 会重新显示错误文本。
    $('#list-status').classList.add('hidden');
    $('#list-empty').classList.toggle('hidden', scripts.length > 0);
    $('#empty-message').textContent = state.scripts.length === 0 ? '还没有可显示的脚本，请先导入或安装脚本。' : '尝试更换关键词，或切换左侧分类。';
    $('#script-list').innerHTML = scripts.map((script) => `
      <button class="script-item ${script.id === state.selectedId ? 'is-selected' : ''}" data-script-id="${escapeHtml(script.id)}" type="button">
        <span class="script-item-main"><span class="script-name">${escapeHtml(script.name)}</span><span class="script-meta"><span>${script.category === 'builtin' ? '自研' : '外部'}</span><span class="script-access ${script.access === 'free' ? 'free' : ''}">${script.access === 'member' ? '会员' : '免费'}</span></span></span>
        ${script.isFavorite ? '<span class="favorite-star" title="已收藏" aria-label="已收藏">★</span>' : '<span></span>'}
      </button>`).join('');
    $('#script-list').classList.toggle('hidden', scripts.length === 0);
    renderCategoryChildren();
  }

  function renderDetail() {
    const script = state.scripts.find((item) => item.id === state.selectedId);
    if (!script) {
      $('#script-detail').innerHTML = '<div class="detail-placeholder"><div class="placeholder-icon" aria-hidden="true">✦</div><h3>选择一个脚本</h3><p>从左侧列表选择脚本，查看详情与运行条件。</p></div>';
      return;
    }
    const isAex = script.type === 'aex';
    const canRun = !isAex && (script.access === 'member' ? state.membership.isMember : script.canRun);
    const runHint = isAex ? 'AEX 是原生插件，请按安装指引操作' : (script.access === 'member' && !state.membership.isMember ? '开通会员后即可使用' : (!script.canRun && script.access === 'free' ? '当前环境不可运行' : ''));
    const versions = script.aeVersions.length ? script.aeVersions.join('、') : '未指定';
    const editButton = script.category === 'external' ? '<button id="edit-script" class="secondary-button" type="button">编辑信息</button>' : '';
    const runResult = state.lastRun && state.lastRun.id === script.id ? `<section id="run-result" class="run-result ${state.lastRun.error ? 'is-error' : ''}"><div class="run-result-title">${escapeHtml(state.lastRun.title)}</div><pre>${escapeHtml(state.lastRun.body || '')}</pre></section>` : '';
    $('#script-detail').innerHTML = `<div class="detail-content"><div class="detail-heading"><div><h3>${escapeHtml(script.name)}</h3><p class="detail-description">${escapeHtml(script.description)}</p></div><span class="badge">${escapeHtml(script.runMode)}</span></div><div class="detail-badges"><span class="badge">AE ${escapeHtml(versions)}</span><span class="badge ${script.access === 'member' ? 'access-member' : ''}">${script.access === 'member' ? '会员脚本' : '免费脚本'}</span>${script.note ? `<span class="badge">备注：${escapeHtml(script.note)}</span>` : ''}</div><section class="detail-section"><h4>使用教程</h4><p class="tutorial">${escapeHtml(script.tutorial)}</p></section><div class="detail-actions">${editButton}<button id="run-script" class="primary-button" type="button" ${canRun ? '' : 'disabled'}>${canRun ? '运行脚本' : '暂不可运行'}</button><span class="action-hint">${escapeHtml(runHint)}</span></div>${runResult}</div>`;
    $('#run-script').addEventListener('click', () => runScript(script));
    $('#edit-script')?.addEventListener('click', () => editScript(script));
  }

  async function editScript(script) {
    const dialog = $('#edit-dialog');
    $('#edit-name').value = script.name;
    $('#edit-description').value = script.description === '暂无简介。' ? '' : script.description;
    $('#edit-tags').value = (script.tags || []).join(', ');
    $('#edit-tutorial').value = script.tutorial === '暂无教程。' ? '' : script.tutorial;
    dialog.showModal();
    const result = await new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
    if (result !== 'save') return;
    const name = $('#edit-name').value.trim();
    if (!name) { showToast('脚本名称不能为空', 'error'); return; }
    await updateScript('updateScript', script.id, { name, description: $('#edit-description').value.trim(), tutorial: $('#edit-tutorial').value.trim(), tags: $('#edit-tags').value.split(',').map((tag) => tag.trim()).filter(Boolean) });
  }

  function renderScanCandidates() {
    const list = $('#scan-list'); const candidates = state.scanCandidates;
    $('#scan-import').disabled = !candidates.some((item) => item.selected);
    list.innerHTML = candidates.length ? candidates.map((item, index) => `<label class="scan-item"><input type="checkbox" data-scan-index="${index}" ${item.selected ? 'checked' : ''}/><span class="scan-item-main"><span class="scan-item-name">${escapeHtml(item.name)}</span><span class="scan-item-path">${escapeHtml(item.path)}</span></span><span class="scan-item-type">${escapeHtml(item.type)}</span></label>`).join('') : '<p class="dialog-muted">没有在常见目录中找到可导入的 JSX、JSXBIN 或 AEX 脚本。</p>';
  }

  async function scanScripts() {
    const dialog = $('#scan-dialog'); $('#scan-status').textContent = '正在检索常见目录…'; state.scanCandidates = []; renderScanCandidates(); dialog.showModal();
    try { const result = await callApi('scanExternalScripts'); state.scanCandidates = (result?.scripts || []).map((item) => ({ ...item, selected: false })); $('#scan-status').textContent = result?.truncated ? '结果较多，仅展示前 500 个脚本；请选择要添加的项目。' : `找到 ${state.scanCandidates.length} 个可导入脚本，请选择要添加的项目。`; renderScanCandidates(); }
    catch (error) { $('#scan-status').textContent = error.message || '检索失败'; }
  }

  async function importScannedScripts() {
    const selected = state.scanCandidates.filter((item) => item.selected); if (!selected.length) return; $('#scan-import').disabled = true; $('#scan-status').textContent = `正在添加 ${selected.length} 个脚本…`;
    try { const result = await callApi('importExternalScriptPaths', selected.map((item) => item.path)); state.activeCategory = 'external'; await refreshScripts(result.imported?.[0]?.id); renderList(); renderDetail(); $('#scan-dialog').close(); showToast(`已添加 ${result.imported?.length || 0} 个脚本${result.errors?.length ? `，${result.errors.length} 个失败` : ''}`); }
    catch (error) { $('#scan-status').textContent = error.message || '批量导入失败'; $('#scan-import').disabled = false; }
  }

  async function importScript() {
    try {
      const imported = await callApi('importExternalScript');
      if (!imported) return;
      state.activeCategory = 'external';
      await refreshScripts(imported.id);
      renderList();
      renderDetail();
      showToast(`已导入：${imported.name}`);
    } catch (error) { showToast(error.message || '脚本导入失败', 'error'); }
  }

  async function runScript(script) {
    state.lastRun = { id: script.id, title: '正在运行…', body: '已将脚本交给 After Effects 执行。脚本界面由 AE 承载，运行结果会回到这里。' }; renderDetail();
    try { const result = await callApi('runScript', script.id); state.lastRun = { id: script.id, title: '运行完成', body: result?.returnValue || '脚本已执行完成（没有返回文本）。' }; renderDetail(); showToast(`已完成运行：${script.name}`); }
    catch (error) { state.lastRun = { id: script.id, title: '运行失败', body: error.message || '运行请求失败', error: true }; renderDetail(); showToast(error.message || '运行请求失败', 'error'); }
  }

  async function refreshMembership() {
    try {
      const membership = await callApi('getMembershipStatus');
      state.membership = { ...state.membership, ...(membership || {}) };
      const active = Boolean(state.membership.isMember);
      $('#membership-summary').innerHTML = `<span class="status-dot ${active ? 'is-active' : 'is-warning'}" aria-hidden="true"></span><span>${active ? '会员已激活' : '免费模式'}</span>`;
    } catch (error) {
      $('#membership-summary').innerHTML = '<span class="status-dot is-warning" aria-hidden="true"></span><span>会员状态暂不可用</span>';
      showToast(error.message || '会员状态查询失败', 'error');
    }
  }

  function renderUpdateStatus(status = {}) {
    if (status.status === 'available') showToast(`发现新版本 ${status.version}，请点击检查更新后下载`);
    if (status.status === 'downloaded') showToast(`新版本 ${status.version} 已下载，重启后安装`);
    if (status.status === 'error') showToast(status.error || '更新失败', 'error');
  }

  async function checkForUpdate() {
    try {
      const status = await callApi('checkForUpdate');
      if (status.status === 'available') {
        const shouldDownload = window.confirm(`发现新版本 ${status.version}，现在下载吗？`);
        if (shouldDownload) {
          const downloaded = await callApi('downloadUpdate');
          if (downloaded.status === 'downloaded' && window.confirm('更新已下载，立即重启安装吗？')) await callApi('installUpdate');
        }
      } else if (status.status === 'up-to-date') showToast('当前已是最新版本');
      else if (status.status === 'not_configured') showToast('当前版本尚未配置更新服务器');
      else if (status.status === 'dev-build') showToast('开发模式不执行自动更新');
      else if (status.error) showToast(status.error, 'error');
    } catch (error) { showToast(error.message || '检查更新失败', 'error'); }
  }

  async function refreshScripts(preferredId) {
    $('#list-status').textContent = '正在加载脚本…';
    $('#list-status').classList.remove('hidden');
    try {
      const result = await callApi('getScripts', { includeHidden: false });
      state.scripts = (Array.isArray(result) ? result : result.scripts || []).map(normalizeScript);
      updateCounts();
      state.selectedId = preferredId || state.selectedId || getFilteredScripts()[0]?.id || null;
      if (!state.scripts.some((script) => script.id === state.selectedId)) state.selectedId = getFilteredScripts()[0]?.id || null;
      renderList();
      renderDetail();
    } catch (error) {
      state.scripts = [];
      updateCounts();
      renderList();
      $('#list-status').textContent = error.message || '脚本加载失败，请稍后重试。';
      $('#list-status').classList.remove('hidden');
      renderDetail();
    }
  }

  async function updateScript(action, scriptId, payload = {}) {
    try {
      await callApi(action, scriptId, payload);
      await refreshScripts(scriptId);
      showToast('已保存脚本设置');
    } catch (error) { showToast(error.message || '保存失败', 'error'); }
  }

  function openContextMenu(event, scriptId) {
    event.preventDefault();
    state.contextScriptId = scriptId;
    const menu = $('#context-menu');
    menu.classList.remove('hidden');
    menu.style.left = `${Math.min(event.clientX, window.innerWidth - 165)}px`;
    menu.style.top = `${Math.min(event.clientY, window.innerHeight - 120)}px`;
    const script = state.scripts.find((item) => item.id === scriptId);
    menu.querySelector('[data-action="favorite"]').textContent = script?.isFavorite ? '取消收藏' : '收藏脚本';
  }

  function closeContextMenu() { $('#context-menu').classList.add('hidden'); state.contextScriptId = null; }

  async function handleContextAction(action) {
    const script = state.scripts.find((item) => item.id === state.contextScriptId);
    closeContextMenu();
    if (!script) return;
    if (action === 'favorite') await updateScript('setFavorite', script.id, { favorite: !script.isFavorite });
    if (action === 'hide') await updateScript('setHidden', script.id, { hidden: true });
    if (action === 'note') {
      const note = window.prompt('编辑脚本备注', script.note || '');
      if (note !== null) await updateScript('setNote', script.id, { note: note.trim() });
    }
  }

  function selectCategory(category) {
    state.activeCategory = category;
    const first = getFilteredScripts()[0];
    if (first) state.selectedId = first.id;
    renderList();
    renderDetail();
  }

  function bindEvents() {
    $('#script-search').addEventListener('input', (event) => { state.search = event.target.value; renderList(); if (!getFilteredScripts().some((script) => script.id === state.selectedId)) { state.selectedId = getFilteredScripts()[0]?.id || null; renderDetail(); } });
    $('#script-search').addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.target.value = ''; state.search = ''; renderList(); } });
    document.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#script-search').focus(); } });
    $('#theme-toggle').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
    $('#import-script').addEventListener('click', importScript);
    $('#scan-script').addEventListener('click', scanScripts);
    $('#scan-list').addEventListener('change', (event) => { const index = Number(event.target.dataset.scanIndex); if (Number.isInteger(index) && state.scanCandidates[index]) { state.scanCandidates[index].selected = event.target.checked; renderScanCandidates(); } });
    $('#scan-import').addEventListener('click', importScannedScripts);
    $('#update-check').addEventListener('click', checkForUpdate);
    if (typeof api.onUpdateStatus === 'function') api.onUpdateStatus(renderUpdateStatus);
    $('#category-tree').addEventListener('click', (event) => { const toggle = event.target.closest('.category-toggle'); const child = event.target.closest('.category-child'); if (child) { state.activeCategory = child.closest('.category-children')?.dataset.childrenFor || state.activeCategory; state.selectedId = child.dataset.scriptId; renderList(); renderDetail(); return; } if (toggle) { const category = toggle.dataset.category; const expanded = toggle.getAttribute('aria-expanded') === 'true'; toggle.setAttribute('aria-expanded', String(!expanded)); $(`[data-children-for="${category}"]`).hidden = expanded; selectCategory(category); } });
    $('#script-list').addEventListener('click', (event) => { const item = event.target.closest('.script-item'); if (!item) return; state.selectedId = item.dataset.scriptId; renderList(); renderDetail(); });
    $('#script-list').addEventListener('contextmenu', (event) => { const item = event.target.closest('.script-item'); if (item) openContextMenu(event, item.dataset.scriptId); });
    $('#context-menu').addEventListener('click', (event) => { const action = event.target.closest('[data-action]')?.dataset.action; if (action) handleContextAction(action); });
    document.addEventListener('click', (event) => { if (!event.target.closest('#context-menu')) closeContextMenu(); });
  }

  async function init() {
    applyTheme(localStorage.getItem('ae-scripts-theme') || 'dark');
    bindEvents();
    await Promise.all([refreshScripts(), refreshMembership()]);
    renderList();
    renderDetail();
  }

  init();
})();
