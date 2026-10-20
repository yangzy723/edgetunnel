'use strict';
const $ = id => document.getElementById(id),
  KEY = 'lunch-club:v1',
  categories = ['全部', '早餐', '午餐', '晚餐', '夜宵'],
  emojis = ['🍜', '🍚', '🥟', '🍲', '🍔', '🍕', '🥗', '🍢', '🥪', '🍣', '🍰', '🧋', '🥣', '🥩', '🍝', '🍳', '🍛', '🥘', '🌮', '🥐', '🥯', '🦞'],
  flavors = [
    { name: '西餐', icons: ['🥩', '🍝', '🍔', '🍕'] },
    { name: '粥 / 早餐', icons: ['🥣', '🍳', '🥪', '🥐', '🥯'] },
    { name: '中式家常', icons: ['🍜', '🍚', '🥟'] },
    { name: '火锅 / 烧烤', icons: ['🍲', '🍢'] },
    { name: '亚洲风味', icons: ['🍣', '🍛', '🥘'] },
    { name: '轻食', icons: ['🥗'] },
    { name: '墨西哥菜', icons: ['🌮'] },
    { name: '海鲜', icons: ['🦞'] },
    { name: '甜点 / 饮品', icons: ['🍰', '🧋'] }
  ];
let state = {
    version: 1,
    shops: [],
    history: []
  },
  filter = '全部',
  flavor = '',
  budget = '',
  query = '',
  lastWinner = null,
  spinning = false,
  angle = 0,
  editing = null,
  editingMeal = null,
  meals = [],
  mealSaving = false,
  mealsSyncing = false,
  mealsEpoch = 0,
  mealsKey = null,
  toastTimer, confirmAction = null,
  storageBlocked = false,
  syncController = null,
  cardsKey = null, wheelKey = null, historyKey = null,
  celebrationTimer;
const cardViews = new Map();
const foodColors = ['#f6e0d3', '#f5ecd4', '#ede5d2', '#f5e2d5', '#e4e9d8', '#dfe9d8', '#f2e7cb', '#e1e9eb', '#efe0e7'];

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  if ($('editor').open) {
    $('editor-message').textContent = message;
    $('editor-message').hidden = false
  }
  if ($('meal-editor')?.open) {
    $('meal-editor-message').textContent = message;
    $('meal-editor-message').hidden = false
  }
  toastTimer = setTimeout(() => $('toast').hidden = true, 4200)
}

function validateMealItem(m) {
  if (!m || typeof m.id !== 'string' || !m.id || m.id.length > 100 ||
    typeof m.name !== 'string' || !m.name.trim() || m.name.length > 32 ||
    !emojis.includes(m.emoji) || !Number.isFinite(m.eatenAt) || m.eatenAt <= 0) return null;
  const rating = m.rating === null || m.rating === undefined || m.rating === '' ? null : Number(m.rating);
  return {
    id: m.id,
    shopId: typeof m.shopId === 'string' && m.shopId ? m.shopId : null,
    name: m.name.trim(),
    emoji: m.emoji,
    dish: typeof m.dish === 'string' ? m.dish.slice(0, 48) : '',
    rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null,
    note: typeof m.note === 'string' ? m.note.slice(0, 120) : '',
    eatenAt: Math.trunc(m.eatenAt)
  };
}

function validate(data) {
  if (!data || data.version !== 1 || !Array.isArray(data.shops) || data.shops.length > 100 || !Array.isArray(data.history) || data.history.length > 20) throw Error('备份格式不正确');
  const ids = new Set();
  const shops = data.shops.map(s => {
    if (!s || typeof s.id !== 'string' || !s.id || s.id.length > 100 || ids.has(s.id) || typeof s.name !== 'string' || !s.name.trim() || s.name.length > 32 || !emojis.includes(s.emoji) || !['随时', ...categories.slice(1)].includes(s.category) || typeof s.note !== 'string' || s.note.length > 80 || typeof s.enabled !== 'boolean' || !(s.price === null || (Number.isInteger(s.price) && s.price >= 0 && s.price <= 9999))) throw Error('店铺数据不正确');
    ids.add(s.id);
    return {
      id: s.id,
      name: s.name.trim(),
      emoji: s.emoji,
      category: s.category,
      price: s.price,
      note: s.note,
      enabled: s.enabled
    }
  });
  const history = data.history.map(h => {
    if (!h || typeof h.name !== 'string' || h.name.length > 32 || !emojis.includes(h.emoji) || !Number.isFinite(h.time) || h.time < 0 || h.time > 8640000000000000) throw Error('历史记录不正确');
    return {
      name: h.name,
      emoji: h.emoji,
      time: h.time
    }
  });
  return {
    version: 1,
    shops,
    history
  }
}
try {
  const raw = localStorage.getItem(KEY);
  if (raw) state = validate(JSON.parse(raw))
} catch (error) {
  storageBlocked = true;
  $('save-status').textContent = '储存读取异常 · 请先导出备份';
  setTimeout(() => toast('未能读取原菜单。将尝试获取共享菜单。'), 100)
}
let revision = 0,
  cloudReady = false,
  saving = false,
  syncing = false,
  localMigration = state.shops.map(s => ({
    ...s
  }));
try {
  const cached = localStorage.getItem(KEY + ':cloud');
  if (cached) state = validate(JSON.parse(cached))
} catch {}
try {
  const cachedMeals = localStorage.getItem(KEY + ':meals');
  if (cachedMeals) {
    const parsed = JSON.parse(cachedMeals);
    if (Array.isArray(parsed)) meals = parsed.map(validateMealItem).filter(Boolean).slice(0, 60)
  }
} catch {}
let hadLocal = (() => {
  try {
    return !storageBlocked && !!localStorage.getItem(KEY)
  } catch {
    return false
  }
})();

function persist() {
  if (storageBlocked) return false;
  try {
    localStorage.setItem(KEY + ':cloud', JSON.stringify(state));
    return true
  } catch {
    return false
  }
}

function persistMeals() {
  if (storageBlocked) return false;
  try {
    localStorage.setItem(KEY + ':meals', JSON.stringify(meals));
    return true
  } catch {
    return false
  }
}

async function mealsRequest(method = 'GET', body, id) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException('连接超时，请稍后重试', 'TimeoutError')), 12000);
  try {
    const url = id ? `/eat/api/meals?id=${encodeURIComponent(id)}` : '/eat/api/meals';
    const response = await fetch(url, {
      method,
      cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const data = await response.json();
    if (!response.ok) {
      const error = Error(data.error || '美食记录同步失败');
      error.data = data;
      error.status = response.status;
      throw error
    }
    return data
  } finally {
    clearTimeout(timeout)
  }
}

function applyMeals(list) {
  if (!Array.isArray(list)) return;
  mealsEpoch++;
  meals = list.map(validateMealItem).filter(Boolean);
  persistMeals()
}

async function syncMeals() {
  if (mealSaving || mealsSyncing) return;
  // A save/delete can finish while this read is in flight; keep the newer snapshot.
  const epoch = mealsEpoch;
  mealsSyncing = true;
  try {
    const data = await mealsRequest('GET');
    if (epoch === mealsEpoch && !mealSaving && data && Array.isArray(data.meals)) {
      applyMeals(data.meals);
      renderMeals()
    }
  } catch {} finally {
    mealsSyncing = false
  }
}

function cloudStatus(message, status = 'ok') {
  setText($('save-status'), message);
  $('save-status').dataset.status = status;
  $('connection-note').hidden = status !== 'error';
  if (status === 'error') setText($('connection-note'), state.shops.length ?
    '云端暂时未连接。你仍可抽取已缓存的菜单，修改店铺需要恢复连接。点击右上角状态可重试。' :
    '暂时未能连接共享奖池。点击右上角状态可重试。')
}
async function cloudRequest(method = 'GET', body, controller) {
  controller ||= new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException('共享连接超时，请稍后重试', 'TimeoutError')), 12000);
  try {
    const response = await fetch('/eat/api/pool', {
      method,
      cache: 'no-store',
      headers: body ? {
        'Content-Type': 'application/json'
      } : cloudReady ? { 'If-None-Match': `"eat-pool-${revision}"` } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    if (response.status === 304 && method === 'GET') return null;
    let data;
    try {
      data = await response.json()
    } catch {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw Error('共享服务尚未启用，请完成数据库部署')
    }
    if (!response.ok) {
      const error = Error(data.error || '同步失败，请稍后重试');
      error.data = data;
      error.status = response.status;
      throw error
    }
    return data
  } finally {
    clearTimeout(timeout)
  }
}

function applyCloud(data) {
  if (!Number.isSafeInteger(data.revision) || data.revision < 0) throw Error('共享菜单版本无效');
  const shops = data.shops === null ? [] : validate({
    version: 1,
    shops: data.shops,
    history: []
  }).shops;
  state.shops = shops;
  revision = data.revision;
  cloudReady = true;
  persist();
  $('migrate').hidden = !hadLocal;
}
async function syncPool(manual = false) {
  if (syncing || saving || spinning || $('editor').open || $('confirm-dialog').open) return;
  syncing = true;
  const controller = new AbortController();
  syncController = controller;
  render();
  try {
    const data = await cloudRequest('GET', undefined, controller);
    // An edit or spin may start while a background request is still in flight.
    if (controller.signal.aborted || saving || spinning || $('editor').open || $('confirm-dialog').open) return;
    const changed = data && (!cloudReady || data.revision !== revision);
    if (changed) {
      applyCloud(data);
      resetResult();
      render()
    }
    cloudStatus('云端共用 · 已同步');
    if (manual) {
      toast('共享奖池已更新');
      void syncMeals()
    }
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason?.name !== 'TimeoutError') return;
    cloudStatus(cloudReady ? '同步暂断 · 点击同步重试' : '共享未连接 · 点击同步重试', 'error');
    if (manual) toast(error.message)
  } finally {
    if (syncController === controller) {
      syncController = null;
      syncing = false;
      render()
    }
  }
}
async function saveShops(shops) {
  if (saving || !cloudReady) {
    toast('请先连接共享奖池');
    return false
  }
  const focusedControl = document.activeElement?.closest('.shop') ? document.activeElement : null;
  syncController?.abort();
  syncController = null;
  syncing = false;
  saving = true;
  cloudStatus('正在保存到云端…', 'busy');
  render();
  try {
    const data = await cloudRequest('PUT', {
      revision,
      shops
    });
    applyCloud(data);
    cloudStatus('云端共用 · 已保存');
    resetResult();
    return true
  } catch (error) {
    if (error.status === 409) {
      applyCloud(error.data);
      cloudStatus('奖池已更新 · 请重新确认修改', 'busy')
    } else cloudStatus('云端保存失败 · 请重试', 'error');
    toast(error.message);
    return false
  } finally {
    saving = false;
    render();
    if (focusedControl?.isConnected && !focusedControl.disabled && document.activeElement === document.body) {
      focusedControl.focus({ preventScroll: true })
    }
  }
}
$('sync-now').onclick = () => syncPool(true);
$('save-status').onclick = () => syncPool(true);
$('migrate').onclick = () => confirm('共享这台设备原来的菜单？', '将替换当前共享奖池，所有人都能看到和修改。', async () => {
  if (await saveShops(localMigration)) {
    localMigration = [];
    hadLocal = false;
    try {
      localStorage.removeItem(KEY)
    } catch {}
    $('migrate').hidden = true;
    toast('本机菜单已共享')
  }
});

function eligible() {
  return state.shops.filter(s => s.enabled && matchesFilters(s))
}

function matchesFilters(shop) {
  return (filter === '全部' || shop.category === '随时' || shop.category === filter) &&
    (!flavor || flavors.find(f => f.name === flavor)?.icons.includes(shop.emoji)) &&
    (!budget || (shop.price !== null && shop.price <= Number(budget))) &&
    (!query || [shop.name, shop.note, flavors.find(f => f.icons.includes(shop.emoji))?.name || ''].join(' ').toLocaleLowerCase().includes(query))
}

function hasFilters() { return filter !== '全部' || flavor || budget || query }

function clearFilters() {
  filter = '全部';
  flavor = budget = query = '';
  $('shop-search').value = '';
  resetResult();
  render()
}

function setText(node, value) {
  if (node.textContent !== value) node.textContent = value
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node
}

function createShopCard(shop) {
  const row = element('div', 'shop');
  row.dataset.id = shop.id;
  const icon = element('div', 'food-icon');
  icon.setAttribute('aria-hidden', 'true');
  const copy = element('div', 'shop-copy');
  const title = element('div', 'shop-title');
  const name = element('div', 'shop-name');
  const price = element('span', 'shop-price');
  const meta = element('div', 'shop-meta');
  const note = element('p', 'shop-note');
  title.append(name, price);
  copy.append(title, meta, note);
  const edit = element('button', 'icon-btn', '✎');
  edit.onclick = () => openEditor(state.shops.find(s => s.id === shop.id));
  const label = element('label', 'toggle');
  const input = element('input');
  input.type = 'checkbox';
  input.onchange = async () => {
    const current = state.shops.find(s => s.id === shop.id);
    if (!current) return;
    const enabled = input.checked;
    input.checked = current.enabled;
    await saveShops(state.shops.map(s => s.id === shop.id ? { ...s, enabled } : s))
  };
  label.append(input, element('span'));
  row.append(icon, copy, edit, label);
  return { row, icon, name, price, meta, note, edit, input, signature: '' }
}

function renderCards(shown, list) {
  const container = $('cards');
  const visibleIds = new Set(shown.map(s => s.id));
  // Remove only obsolete rows. Unchanged rows retain keyboard focus and scroll position.
  for (const [id, view] of cardViews) {
    if (!visibleIds.has(id)) {
      view.row.remove();
      cardViews.delete(id)
    }
  }
  container.querySelector('.empty')?.remove();
  if (!shown.length) {
    const empty = element('div', 'empty');
    empty.append(element('span', 'empty-mark', state.shops.length ? '⌕' : '◌'));
    const connected = cloudReady || state.shops.length;
    empty.append(element('p', '', state.shops.length ? '暂时没有符合条件的美味。' : cloudReady ? '你的下一顿，从第一家小店开始。' : syncing ? '正在找回大家的美味…' : '连接后，就能添加你的美味清单。'));
    const action = element('button', 'soft-btn', state.shops.length ? '清除筛选，看看全部' : connected ? '＋ 添加第一家店' : '重新连接');
    action.onclick = state.shops.length ? clearFilters : connected ? () => openEditor() : () => syncPool(true);
    action.disabled = saving || spinning || (!connected && syncing);
    empty.append(action);
    container.append(empty);
    return
  }
  const positions = new Map(list.map((s, i) => [s.id, i + 1]));
  shown.forEach((shop, index) => {
    let view = cardViews.get(shop.id);
    if (!view) {
      view = createShopCard(shop);
      cardViews.set(shop.id, view)
    }
    const signature = JSON.stringify(shop);
    if (signature !== view.signature) {
      view.signature = signature;
      const flavorIndex = flavors.findIndex(f => f.icons.includes(shop.emoji));
      setText(view.icon, shop.emoji);
      view.icon.style.background = foodColors[flavorIndex] || '#eee8d8';
      setText(view.name, shop.name);
      setText(view.price, shop.price === null ? '预算随心' : '¥' + shop.price);
      view.price.classList.toggle('unspecified', shop.price === null);
      setText(view.meta, [shop.category, flavors[flavorIndex]?.name].filter(Boolean).join(' · '));
      setText(view.note, shop.note);
      view.note.hidden = !shop.note;
      view.row.classList.toggle('off', !shop.enabled);
      view.edit.setAttribute('aria-label', '编辑 ' + shop.name);
      view.input.setAttribute('aria-label', '让 ' + shop.name + ' 参与抽奖');
      view.input.checked = shop.enabled
    }
    if (list.length > 20 && positions.has(shop.id)) view.icon.dataset.number = positions.get(shop.id);
    else delete view.icon.dataset.number;
    if (container.children[index] !== view.row) container.insertBefore(view.row, container.children[index] || null)
  })
}

function render() {
  const list = eligible();
  const shown = state.shops.filter(matchesFilters);
  const locked = spinning || saving || !cloudReady;
  const spinLabel = spinning ? '命运正在下单…' : !list.length ? '先选几家喜欢的店' :
    lastWinner ? '再抽一次' : '帮我决定！';
  setText($('total-count'), state.shops.length + ' 家');
  setText($('eligible-count'), list.length + ' 家待选');
  setText($('spin-label'), spinLabel);
  setText($('filter-summary'), `${shown.length} 家符合 · ${list.length} 家参与` + (budget ? ' · 按已填预算' : ''));
  setText($('wheel-context'), hasFilters() ? [filter !== '全部' ? filter : '', flavor, budget ? '人均 ≤ ¥' + budget : '', query ? '搜索结果' : ''].filter(Boolean).join(' / ') : '每一家，都有被选中的理由。');
  $('spin').disabled = spinning || saving || !list.length;
  $('add').disabled = locked;
  if ($('add-meal')) $('add-meal').disabled = locked || mealSaving;
  if ($('meal-form')) {
    $('meal-form').querySelectorAll('input, select, button').forEach(control => control.disabled = mealSaving);
    setText($('save-meal-btn'), mealSaving ? '正在保存…' : '保存到吃过清单');
  }
  $('import').disabled = locked;
  $('migrate').disabled = locked;
  $('sync-now').disabled = spinning || saving || syncing;
  $('save-status').disabled = spinning || saving || syncing;
  $('shop-form').querySelectorAll('input, select, button').forEach(control => control.disabled = saving);
  setText($('shop-form').querySelector('button[type=submit]'), saving ? '正在保存…' : '保存到奖池');
  $('clear-history').disabled = spinning || !state.history.length;
  $('flavor-filter').disabled = $('budget-filter').disabled = $('shop-search').disabled = spinning || saving;
  $('flavor-filter').value = flavor;
  $('budget-filter').value = budget;
  $('reset-filters').hidden = !hasFilters();
  $('reset-filters').disabled = spinning || saving;
  document.querySelector('.lottery').classList.toggle('is-empty', !list.length);
  if (!$('filters').childElementCount) categories.forEach(c => {
    const b = element('button', 'chip', c);
    b.onclick = () => {
      filter = c;
      resetResult();
      render()
    };
    $('filters').append(b)
  });
  $('filters').querySelectorAll('button').forEach(b => {
    b.disabled = spinning || saving;
    b.classList.toggle('active', b.textContent === filter);
    b.setAttribute('aria-pressed', String(b.textContent === filter))
  });
  const nextCardsKey = JSON.stringify([filter, flavor, budget, query, state.shops, cloudReady, syncing && !cloudReady]);
  if (nextCardsKey !== cardsKey) {
    cardsKey = nextCardsKey;
    renderCards(shown, list)
  }
  $('cards').querySelectorAll('.shop button, .shop input').forEach(control => control.disabled = locked);
  drawWheel(list);
  renderMeals();
  renderHistory()
}

function resetResult() {
  lastWinner = null;
  $('result-actions').hidden = true;
  document.querySelector('.result').classList.remove('revealed');
  $('cards').querySelectorAll('.winner').forEach(row => row.classList.remove('winner'));
  $('result-caption').textContent = '胃已经准备好了，运气呢？';
  $('result-title').textContent = '下一顿，会是谁？';
  $('result-detail').textContent = '每家入选店铺，都有同样的机会'
}

function drawWheel(list) {
  const nextKey = JSON.stringify(list.map(s => [s.id, s.name, s.emoji]));
  if (nextKey === wheelKey) return;
  wheelKey = nextKey;
  const ns = 'http://www.w3.org/2000/svg',
    svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 360 360');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', list.length ? '美食转盘，共 ' + list.length + ' 家店' : '奖池为空');
  const palette = ['#f3ce73', '#f6e8cb', '#bdcbae', '#edb099', '#dce1c8', '#eac591'];
  const n = list.length || 1,
    step = 2 * Math.PI / n;
  for (let i = 0; i < n; i++) {
    const a = i * step - Math.PI / 2,
      b = a + step;
    const path = document.createElementNS(ns, n === 1 ? 'circle' : 'path');
    if (n === 1) {
      path.setAttribute('cx', '180');
      path.setAttribute('cy', '180');
      path.setAttribute('r', '180')
    } else {
      path.setAttribute('d', `M180 180 L${180+180*Math.cos(a)} ${180+180*Math.sin(a)} A180 180 0 ${step>Math.PI?1:0} 1 ${180+180*Math.cos(b)} ${180+180*Math.sin(b)} Z`)
    }
    path.setAttribute('fill', palette[i % palette.length]);
    path.setAttribute('stroke', '#fff8e8');
    path.setAttribute('stroke-width', '1.5');
    svg.append(path);
    if (list.length && (n <= 36 || i % Math.ceil(n / 36) === 0)) {
      const t = document.createElementNS(ns, 'text');
      t.setAttribute('transform', `translate(180 180) rotate(${(i+.5)*360/n-90})`);
      t.setAttribute('x', '112');
      t.setAttribute('y', '4');
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('fill', '#3c4c37');
      t.setAttribute('font-size', n > 20 ? '9' : '13');
      t.setAttribute('font-weight', '650');
      t.textContent = n > 20 ? String(i + 1) : n > 12 ? list[i].emoji : list[i].emoji + ' ' + [...list[i].name].slice(0, 6).join('');
      svg.append(t)
    }
  }
  $('wheel').replaceChildren(svg)
}

function renderMeals() {
  const listEl = $('meals-list');
  if (!listEl) return;
  const locked = spinning || saving || mealSaving || !cloudReady;
  setText($('meals-count'), meals.length + ' 顿');
  const nextKey = JSON.stringify([meals, locked]);
  if (nextKey === mealsKey) return;
  mealsKey = nextKey;
  listEl.replaceChildren();
  if (!meals.length) {
    const empty = element('div', 'empty meal-empty');
    empty.append(element('span', 'empty-mark', '🍽️'));
    empty.append(element('p', '', cloudReady ? '还没有记录吃过的美味。吃到好味道时，随手记一笔吧！' : '连接云端后，即可查看与记录大家吃过的美味。'));
    if (cloudReady) {
      const btn = element('button', 'soft-btn', '＋ 记下第一顿美味');
      btn.disabled = locked;
      btn.onclick = () => openMealEditor();
      empty.append(btn)
    }
    listEl.append(empty);
    return
  }
  meals.forEach(m => {
    const card = element('article', 'meal-card');
    card.dataset.id = m.id;
    const head = element('div', 'meal-card-head');
    const icon = element('span', 'meal-icon', m.emoji);
    const flavorIndex = flavors.findIndex(f => f.icons.includes(m.emoji));
    icon.style.background = foodColors[flavorIndex] || '#eee8d8';
    const meta = element('div', 'meal-head-copy');
    const titleRow = element('div', 'meal-title-row');
    titleRow.append(element('h3', 'meal-name', m.name));
    if (m.rating) {
      const stars = element('span', 'meal-stars', '★'.repeat(m.rating) + '☆'.repeat(5 - m.rating));
      stars.setAttribute('aria-label', m.rating + ' 星好评');
      titleRow.append(stars)
    }
    const timeStr = new Date(m.eatenAt).toLocaleString('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    meta.append(titleRow, element('time', 'meal-time', timeStr));
    const editBtn = element('button', 'icon-btn meal-edit-btn', '✎');
    editBtn.disabled = locked;
    editBtn.setAttribute('aria-label', '编辑记录 ' + m.name);
    editBtn.onclick = () => openMealEditor(m);
    head.append(icon, meta, editBtn);
    card.append(head);
    if (m.dish) {
      const dish = element('div', 'meal-dish');
      dish.append(element('span', 'meal-dish-tag', '必点 / 菜品'), element('span', '', m.dish));
      card.append(dish)
    }
    if (m.note) {
      card.append(element('p', 'meal-note', m.note))
    }
    listEl.append(card)
  })
}

function openMealEditor(meal, presetShop) {
  if (spinning || saving || mealSaving || !cloudReady) {
    if (!cloudReady) toast('请先连接共享奖池');
    return
  }
  editingMeal = meal?.id || null;
  const form = $('meal-form');
  form.reset();
  $('meal-name').setCustomValidity('');
  $('meal-editor-message').hidden = true;
  const select = $('meal-shop-select');
  select.replaceChildren(element('option', '', '手动输入或自由记录…'));
  select.firstChild.value = '';
  state.shops.forEach(s => {
    const opt = element('option', '', `${s.emoji} ${s.name}`);
    opt.value = s.id;
    select.append(opt)
  });
  $('meal-editor-title').textContent = meal ? '修改这顿美食记录' : '记一顿吃过的美味';
  $('delete-meal').hidden = !meal;
  if (meal) {
    select.value = meal.shopId && state.shops.some(s => s.id === meal.shopId) ? meal.shopId : '';
    $('meal-name').value = meal.name;
    $('meal-emoji').value = meal.emoji;
    $('meal-dish').value = meal.dish || '';
    $('meal-rating').value = meal.rating ? String(meal.rating) : '';
    $('meal-note').value = meal.note || ''
  } else if (presetShop) {
    select.value = presetShop.id && state.shops.some(s => s.id === presetShop.id) ? presetShop.id : '';
    $('meal-name').value = presetShop.name;
    $('meal-emoji').value = presetShop.emoji;
    $('meal-dish').value = '';
    $('meal-rating').value = '5';
    $('meal-note').value = presetShop.note || ''
  }
  $('meal-editor-mark').textContent = $('meal-emoji').value;
  $('meal-editor').showModal();
  (presetShop ? $('meal-dish') : $('meal-name')).focus()
}

function renderHistory() {
  const nextKey = JSON.stringify(state.history);
  if (nextKey === historyKey) return;
  historyKey = nextKey;
  $('history').replaceChildren();
  if (!state.history.length) {
    $('history').append(element('p', 'empty', '还没有抽奖记录，今天的第一份惊喜正在等你。'));
    return
  }
  state.history.slice(0, 8).forEach(h => {
    const n = element('div', 'history-item');
    const copy = element('div', 'history-copy');
    copy.append(element('div', 'history-name', h.name));
    copy.append(element('small', '', new Date(h.time).toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })));
    n.append(element('span', 'history-emoji', h.emoji), copy);
    $('history').append(n)
  })
}

function randomIndex(n) {
  const value = new Uint32Array(1),
    limit = Math.floor(4294967296 / n) * n;
  do {
    crypto.getRandomValues(value)
  } while (value[0] >= limit);
  return value[0] % n
}
$('spin').onclick = () => {
  const list = eligible();
  if (spinning || saving || !list.length) return;
  const index = randomIndex(list.length),
    winner = {
      ...list[index]
    };
  spinning = true;
  resetResult();
  document.querySelector('.lottery').classList.add('is-spinning');
  $('wheel').style.willChange = 'transform';
  render();
  $('result-caption').textContent = '别急，美味正在赶来的路上';
  $('result-title').textContent = '今天的饭搭子是…';
  $('result-detail').textContent = '转一转，把纠结留在上一餐';
  const target = (360 - (index + .5) * 360 / list.length) % 360;
  angle += 360 * 5 + ((target - angle % 360 + 360) % 360);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const duration = reduced ? 0 : list.length === 1 ? 650 : 3800;
  $('wheel').style.transitionDuration = duration + 'ms';
  let finished = false;
  let fallback;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(fallback);
    $('wheel').removeEventListener('transitionend', onEnd);
    $('wheel').style.willChange = '';
    $('wheel').style.transitionDuration = '';
    document.querySelector('.lottery').classList.remove('is-spinning');
    spinning = false;
    state.history.unshift({
      name: winner.name,
      emoji: winner.emoji,
      time: Date.now()
    });
    state.history = state.history.slice(0, 20);
    persist();
    render();
    $('result-caption').textContent = '叮！今天的美味签已送达';
    $('result-title').textContent = winner.emoji + ' ' + winner.name;
    $('result-detail').textContent = [winner.price === null ? '' : `人均 ¥${winner.price}`, winner.note || '就从这顿饭，开启好心情。'].filter(Boolean).join(' · ');
    $('spin-label').textContent = '再抽一次';
    lastWinner = winner;
    $('result-actions').hidden = false;
    document.querySelector('.result').classList.add('revealed');
    const row = [...$('cards').children].find(row => row.dataset.id === winner.id);
    row?.classList.add('winner');
    if (!reduced) celebrate()
  };
  const onEnd = event => {
    if (event.target === $('wheel') && event.propertyName === 'transform') finish()
  };
  $('wheel').addEventListener('transitionend', onEnd);
  // Give the browser a frame to promote the wheel before starting the transition.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    $('wheel').style.transform = `rotate(${angle}deg)`;
    fallback = setTimeout(finish, reduced ? 80 : duration + 400)
  }))
};

function celebrate() {
  const box = $('confetti');
  clearTimeout(celebrationTimer);
  box.replaceChildren();
  const fragment = document.createDocumentFragment();
  const count = innerWidth < 760 ? 16 : 28;
  for (let i = 0; i < count; i++) {
    const p = element('i');
    p.style.left = Math.random() * 100 + '%';
    p.style.background = ['#d95135', '#f5cb64', '#91a986', '#e9ad95'][i % 4];
    p.style.animationDelay = Math.random() * .5 + 's';
    p.style.setProperty('--drift', `${Math.random() * 160 - 80}px`);
    p.style.setProperty('--twist', `${Math.random() * 360 + 360}deg`);
    fragment.append(p)
  }
  box.append(fragment);
  celebrationTimer = setTimeout(() => box.replaceChildren(), 3300)
}

function openEditor(shop) {
  if (spinning || saving || !cloudReady) return;
  if (!shop && state.shops.length >= 100) {
    toast('奖池最多放 100 家店，先整理一下吧');
    return
  }
  editing = shop?.id || null;
  $('shop-form').reset();
  $('shop-name').setCustomValidity('');
  $('editor-message').hidden = true;
  $('editor-title').textContent = shop ? '编辑这家小店' : '添一家心动小店';
  $('delete-shop').hidden = !shop;
  if (shop) {
    $('shop-name').value = shop.name;
    $('shop-category').value = shop.category;
    $('shop-price').value = shop.price ?? '';
    $('shop-note').value = shop.note;
    $('shop-emoji').value = shop.emoji
  }
  $('editor-mark').textContent = $('shop-emoji').value;
  $('editor').showModal();
  $('shop-name').focus()
}
$('add').onclick = () => openEditor();
flavors.forEach(f => {
  const option = element('option', '', f.name);
  option.value = f.name;
  $('flavor-filter').append(option)
});
$('flavor-filter').onchange = () => {
  flavor = $('flavor-filter').value;
  resetResult();
  render()
};
$('budget-filter').onchange = () => {
  budget = $('budget-filter').value;
  resetResult();
  render()
};
$('shop-search').oninput = () => {
  query = $('shop-search').value.trim().toLocaleLowerCase();
  resetResult();
  render()
};
$('reset-filters').onclick = clearFilters;
$('shop-emoji').onchange = () => $('editor-mark').textContent = $('shop-emoji').value;
$('locate-result').onclick = () => {
  if (!lastWinner) return;
  cardViews.get(lastWinner.id)?.row.scrollIntoView({
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    block: 'center'
  })
};
if ($('record-winner')) {
  $('record-winner').onclick = () => {
    if (!lastWinner) return;
    openMealEditor(null, lastWinner)
  }
}
if ($('add-meal')) {
  $('add-meal').onclick = () => openMealEditor();
  $('meal-emoji').onchange = () => $('meal-editor-mark').textContent = $('meal-emoji').value;
  $('meal-shop-select').onchange = () => {
    const chosen = state.shops.find(s => s.id === $('meal-shop-select').value);
    if (chosen) {
      $('meal-name').value = chosen.name;
      $('meal-emoji').value = chosen.emoji;
      $('meal-editor-mark').textContent = chosen.emoji;
      $('meal-name').setCustomValidity('')
    }
  };
  $('meal-name').oninput = () => $('meal-name').setCustomValidity('');
  $('close-meal-editor').onclick = $('cancel-meal-editor').onclick = () => $('meal-editor').close();
  $('meal-editor').addEventListener('cancel', event => {
    if (mealSaving) event.preventDefault()
  });
  $('meal-form').onsubmit = async e => {
    e.preventDefault();
    const name = $('meal-name').value.trim();
    if (!name) {
      $('meal-name').setCustomValidity('请输入店铺或食物名称');
      $('meal-name').reportValidity();
      return
    }
    const existing = meals.find(m => m.id === editingMeal);
    const body = {
      id: editingMeal || crypto.randomUUID(),
      shopId: $('meal-shop-select').value || null,
      name,
      emoji: $('meal-emoji').value,
      dish: $('meal-dish').value.trim(),
      rating: $('meal-rating').value ? Number($('meal-rating').value) : null,
      note: $('meal-note').value.trim(),
      eatenAt: existing ? existing.eatenAt : Date.now()
    };
    mealSaving = true;
    mealsEpoch++;
    render();
    try {
      const data = await mealsRequest(editingMeal ? 'PUT' : 'POST', body);
      applyMeals(data.meals);
      $('meal-editor').close();
      toast(editingMeal ? '美食记录已更新' : '已记入吃过清单，所有设备同步留存！')
    } catch (error) {
      if (error.data?.meals) applyMeals(error.data.meals);
      toast(error.message || '保存失败，请稍后重试')
    } finally {
      mealSaving = false;
      render()
    }
  };
  $('delete-meal').onclick = () => {
    const id = editingMeal;
    $('meal-editor').close();
    confirm('删除这条吃过的记录？', '删除后将从云端共享记录中移除。', async () => {
      mealSaving = true;
      mealsEpoch++;
      render();
      try {
        const data = await mealsRequest('DELETE', undefined, id);
        applyMeals(data.meals);
        toast('已删除这条记录')
      } catch (error) {
        toast(error.message || '删除失败，请重试')
      } finally {
        mealSaving = false;
        render()
      }
    })
  }
}
$('copy-result').onclick = async () => {
  if (!lastWinner) return;
  const winner = lastWinner;
  const text = ['今天吃：' + winner.emoji + ' ' + winner.name, winner.price === null ? '' : '人均 ¥' + winner.price, winner.note].filter(Boolean).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('饭点已复制，发给你的饭搭子吧')
  } catch {
    toast('未能复制，请长按或选中结果文字复制')
  }
};
$('close-editor').onclick = $('cancel-editor').onclick = () => $('editor').close();
$('editor').addEventListener('cancel', event => {
  if (saving) event.preventDefault()
});
$('shop-form').onsubmit = async e => {
  e.preventDefault();
  const name = $('shop-name').value.trim();
  if (!name) {
    $('shop-name').setCustomValidity('请输入店铺名称');
    $('shop-name').reportValidity();
    return
  }
  const previous = state.shops.find(s => s.id === editing),
    shop = {
      id: editing || crypto.randomUUID(),
      name,
      category: $('shop-category').value,
      price: $('shop-price').value === '' ? null : Number($('shop-price').value),
      emoji: $('shop-emoji').value,
      note: $('shop-note').value.trim(),
      enabled: previous?.enabled ?? true
    };
  if (editing && !previous) {
    toast('这家店已被其他人删除，请重新添加');
    return
  }
  const proposed = previous ? state.shops.map(s => s.id === editing ? shop : s) : [...state.shops, shop];
  const saved = await saveShops(proposed);
  if (saved) {
    $('editor').close();
    if (!matchesFilters(shop)) clearFilters();
    render();
    toast('已共享，其他设备会自动更新！')
  }
};
$('shop-name').oninput = () => $('shop-name').setCustomValidity('');

function confirm(title, description, action) {
  $('confirm-title').textContent = title;
  $('confirm-description').textContent = description;
  confirmAction = action;
  $('confirm-dialog').showModal();
  $('confirm-cancel').focus()
}
$('confirm-cancel').onclick = () => $('confirm-dialog').close();
$('confirm-ok').onclick = () => {
  const action = confirmAction;
  confirmAction = null;
  $('confirm-dialog').close();
  action?.()
};
$('delete-shop').onclick = () => {
  const id = editing;
  $('editor').close();
  confirm('和这家店暂时告别？', '删除后，可以随时重新添加。', async () => {
    await saveShops(state.shops.filter(s => s.id !== id))
  })
};
$('clear-history').onclick = () => confirm('清空饭点记录？', '只清空抽奖记录，店铺奖池会保留。', () => {
  state.history = [];
  persist();
  renderHistory();
  $('clear-history').disabled = true
});
$('export').onclick = () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], {
      type: 'application/json'
    }),
    url = URL.createObjectURL(blob),
    link = element('a');
  link.href = url;
  link.download = '饭点事务所-' + new Date().toLocaleDateString('sv-SE') + '.json';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('已生成备份，可在另一台设备导入')
};
$('import').onclick = () => $('import-file').click();
$('import-file').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 200000) {
    toast('备份文件过大，请选择本页面导出的 JSON');
    return
  }
  try {
    const incoming = validate(JSON.parse(await file.text()));
    confirm('导入这份美味清单？', `将用备份中的 ${incoming.shops.length} 家店替换所有人的共享奖池；抽奖记录仅更新本机。建议先导出备份。`, async () => {
      if (await saveShops(incoming.shops)) {
        state.history = incoming.history;
        clearFilters();
        persist();
        render();
        toast('导入成功，共享菜单已更新')
      }
    })
  } catch (error) {
    toast('无法导入：请选择本页面导出的有效 JSON 备份')
  }
};
window.addEventListener('focus', () => {
  syncPool();
  void syncMeals()
});
window.addEventListener('online', () => {
  syncPool();
  void syncMeals()
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    syncPool();
    void syncMeals()
  }
});
setInterval(() => {
  if (!document.hidden) syncPool()
}, 8000);
setInterval(() => {
  if (!document.hidden) void syncMeals()
}, 30000);
$('today-date').textContent = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
render();
syncPool();
void syncMeals();
