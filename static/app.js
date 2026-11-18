const $ = id => document.getElementById(id);
let token = localStorage.getItem('zhixue_token') || '';
let userId = '';
let course = null;
let courses = [];
let conversation = '';
let courseRevision = 0;
let conversationRevision = 0;
let courseListRevision = 0;
let documentListRevision = 0;
let conversationListRevision = 0;
let mistakeListRevision = 0;
let chatRequest = null;
let historyLoading = false;
let uploading = false;
const drafts = new Map();
const mistakeDrafts = new Map();

async function request(path, options = {}) {
  const headers = {...(options.headers || {})};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch('/api' + path, {...options, headers});
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    const error = new Error(typeof data?.detail === 'string' ? data.detail : `请求失败（${response.status}），请稍后重试`);
    error.status = response.status;
    throw error;
  }
  return response;
}

async function api(path, options) {
  return (await request(path, options)).json().catch(() => null);
}

async function streamChat(courseId, body, onEvent) {
  const response = await request(`/courses/${courseId}/chat/stream`, {method: 'POST', body});
  if (!response.body) throw new Error('无法读取回答，请重试');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) throw new Error('回答中断，请重试');
      const lines = (buffer + value).split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === 'done') return event;
        if (event.type === 'error') throw new Error(event.detail);
        onEvent(event);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function toast(text) {
  $('toast').textContent = text;
  $('toast').classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $('toast').classList.add('hidden'), 4500);
}

function button(id, fn) {
  const el = $(id);
  if (!el) return;
  el.onclick = async () => {
    el.disabled = true;
    try { await fn(); } catch (error) { toast(error.message); }
    finally { el.disabled = false; }
  };
}

const courseStorageKey = () => `zhixue_last_course_${userId}`;
const conversationStorageKey = id => `zhixue_last_conversation_${userId}_${id}`;
const draftKey = (courseId, conversationId) => `${courseId}:${conversationId || 'new'}`;
function saveDraft() {
  if (course) drafts.set(draftKey(course.id, conversation), $('question').value);
}
function restoreDraft() {
  $('question').value = course ? (drafts.get(draftKey(course.id, conversation)) || '') : '';
  resizeQuestion();
}
function saveMistakeDraft() {
  if (course) mistakeDrafts.set(course.id, {
    question: $('mistakeQuestion').value,
    answer: $('mistakeAnswer').value
  });
}
function restoreMistakeDraft() {
  const draft = course ? mistakeDrafts.get(course.id) : null;
  $('mistakeQuestion').value = draft?.question || '';
  $('mistakeAnswer').value = draft?.answer || '';
}
function resizeQuestion() {
  const input = $('question');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}
function isCurrentCourse(id, revision) {
  return course?.id === id && courseRevision === revision;
}
function isCurrentView(id, revision, viewRevision) {
  return isCurrentCourse(id, revision) && conversationRevision === viewRevision;
}
function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}
function syncSendState() {
  $('send').disabled = Boolean(chatRequest || historyLoading);
}
function closeMobileMenu() {
  const wasOpen = $('sidebar')?.classList.contains('is-open');
  const focusWasInside = $('sidebar')?.contains(document.activeElement);
  $('sidebar')?.classList.remove('is-open');
  $('sidebarBackdrop')?.classList.remove('is-visible');
  $('sidebarBackdrop')?.classList.add('hidden');
  $('mobileMenu')?.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('menu-open');
  if (wasOpen && focusWasInside) $('mobileMenu')?.focus();
}
function openMobileMenu() {
  $('sidebar')?.classList.add('is-open');
  $('sidebarBackdrop')?.classList.remove('hidden');
  $('sidebarBackdrop')?.classList.add('is-visible');
  $('mobileMenu')?.setAttribute('aria-expanded', 'true');
  document.body.classList.add('menu-open');
  $('closeMobileMenu')?.focus();
}
$('mobileMenu')?.addEventListener('click', () => {
  if ($('sidebar')?.classList.contains('is-open')) closeMobileMenu();
  else openMobileMenu();
});
$('closeMobileMenu')?.addEventListener('click', closeMobileMenu);
$('sidebarBackdrop')?.addEventListener('click', closeMobileMenu);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeMobileMenu();
});

async function loadUser() {
  const me = await api('/me');
  userId = String(me.id);
  $('preference').value = me.preference || '';
  $('userName').textContent = me.username;
  $('avatar').textContent = me.username.slice(0, 1).toUpperCase();
  $('auth').classList.add('hidden');
  $('workspace').classList.remove('hidden');
  $('logout').classList.remove('hidden');
  await loadCourses(true);
}

function renderCourses() {
  $('courses').replaceChildren();
  courses.forEach(item => {
    const el = document.createElement('button');
    el.className = 'course-item' + (course?.id === item.id ? ' active' : '');
    el.textContent = item.name;
    el.title = item.name;
    if (course?.id === item.id) el.setAttribute('aria-current', 'page');
    el.onclick = () => selectCourse(item).catch(error => toast(error.message));
    $('courses').append(el);
  });
}

async function loadCourses(selectInitial = false) {
  const revision = ++courseListRevision;
  const rows = await api('/courses');
  if (revision !== courseListRevision) return rows;
  courses = rows;
  renderCourses();
  if (selectInitial && !course && rows.length) {
    const remembered = localStorage.getItem(courseStorageKey());
    await selectCourse(rows.find(item => String(item.id) === remembered) || rows[0]);
  }
  return rows;
}

async function selectCourse(item) {
  saveDraft();
  saveMistakeDraft();
  course = item;
  conversation = '';
  const revision = ++courseRevision;
  const initialView = ++conversationRevision;
  historyLoading = false;
  syncSendState();
  localStorage.setItem(courseStorageKey(), String(item.id));
  $('courseName').textContent = item.name;
  $('breadcrumb').textContent = item.name;
  $('empty').classList.add('hidden');
  $('courseView').classList.remove('hidden');
  $('uploadProgress').classList.add('hidden');
  $('conversations').replaceChildren(new Option('新会话', ''));
  setText('docCount', '…');
  setText('docTotal', '正在加载…');
  setText('mistakeCount', '…');
  $('documents').replaceChildren(emptyList('正在加载课程资料…'));
  $('mistakeList').replaceChildren(emptyList('正在加载错题…'));
  renderCourses();
  restoreDraft();
  restoreMistakeDraft();
  renderMessages([]);
  showTab('chat');
  closeMobileMenu();
  const [documentsResult, conversationsResult, mistakesResult] = await Promise.allSettled([
    loadDocuments(item.id, revision),
    loadConversations(item.id, revision),
    loadMistakes(item.id, revision)
  ]);
  if (!isCurrentCourse(item.id, revision)) return;
  const failures = [documentsResult, conversationsResult, mistakesResult].filter(result => result.status === 'rejected');
  if (failures.length) toast('部分课程内容加载失败，请稍后重试');
  if (conversationsResult.status === 'fulfilled' && conversationRevision === initialView) {
    const remembered = localStorage.getItem(conversationStorageKey(item.id));
    if (remembered && conversationsResult.value.some(row => String(row.id) === remembered)) {
      await selectConversation(remembered);
    }
  }
}

function showTab(id) {
  document.querySelectorAll('.tab').forEach(tab => {
    const active = tab.dataset.tab === id;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('.panel').forEach(panel => panel.classList.toggle('hidden', panel.id !== id));
}
const tabs = [...document.querySelectorAll('.tab')];
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => showTab(tab.dataset.tab));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    showTab(tabs[next].dataset.tab);
    tabs[next].focus();
  });
});

function emptyList(message) {
  const empty = document.createElement('div');
  empty.className = 'empty-list';
  empty.textContent = message;
  return empty;
}

async function loadDocuments(courseId = course?.id, revision = courseRevision) {
  if (!courseId) return [];
  const request = ++documentListRevision;
  let rows;
  try {
    rows = await api(`/courses/${courseId}/documents`);
  } catch (error) {
    if (!isCurrentCourse(courseId, revision) || request !== documentListRevision) return [];
    $('documents').replaceChildren(emptyList('课程资料加载失败，请重新选择课程后重试。'));
    setText('docCount', '—');
    setText('docTotal', '资料加载失败');
    throw error;
  }
  if (!isCurrentCourse(courseId, revision) || request !== documentListRevision) return rows;
  const list = $('documents');
  list.replaceChildren();
  setText('docCount', String(rows.length));
  setText('docTotal', `${rows.length} 份资料`);
  if (!rows.length) list.append(emptyList('还没有课程资料，添加第一份资料，让回答更贴近你的学习内容。'));
  rows.forEach(doc => {
    const item = document.createElement('div');
    item.className = 'item document-item';
    const name = document.createElement('div');
    name.className = 'item-name';
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = /\.(png|jpe?g|webp)$/i.test(doc.name) ? '▧' : '▤';
    const label = document.createElement('span');
    label.textContent = doc.name;
    name.append(icon, label);
    const remove = document.createElement('button');
    remove.textContent = '删除';
    remove.setAttribute('aria-label', `删除资料 ${doc.name}`);
    remove.onclick = async () => {
      if (!confirm(`删除资料「${doc.name}」？`)) return;
      remove.disabled = true;
      try {
        await api(`/courses/${courseId}/documents/${doc.id}`, {method: 'DELETE'});
        if (course?.id === courseId) await loadDocuments(courseId, courseRevision);
        toast('资料已删除');
      } catch (error) { toast(error.message); }
      finally { remove.disabled = false; }
    };
    item.append(name, remove);
    list.append(item);
  });
  return rows;
}

async function loadConversations(courseId = course?.id, revision = courseRevision) {
  if (!courseId) return [];
  const request = ++conversationListRevision;
  let rows;
  try {
    rows = await api(`/courses/${courseId}/conversations`);
  } catch (error) {
    if (!isCurrentCourse(courseId, revision) || request !== conversationListRevision) return [];
    if (!conversation) $('conversations').replaceChildren(new Option('对话加载失败', ''));
    throw error;
  }
  if (!isCurrentCourse(courseId, revision) || request !== conversationListRevision) return [];
  $('conversations').replaceChildren(new Option('新会话', ''));
  rows.forEach(row => $('conversations').add(new Option(row.title, row.id)));
  $('conversations').value = conversation;
  return rows;
}

async function loadMistakes(courseId = course?.id, revision = courseRevision) {
  if (!courseId) return [];
  const request = ++mistakeListRevision;
  let rows;
  try {
    rows = await api(`/courses/${courseId}/mistakes`);
  } catch (error) {
    if (!isCurrentCourse(courseId, revision) || request !== mistakeListRevision) return [];
    $('mistakeList').replaceChildren(emptyList('错题加载失败，请重新选择课程后重试。'));
    setText('mistakeCount', '—');
    throw error;
  }
  if (!isCurrentCourse(courseId, revision) || request !== mistakeListRevision) return rows;
  const list = $('mistakeList');
  list.replaceChildren();
  setText('mistakeCount', String(rows.length));
  if (!rows.length) list.append(emptyList('还没有记录错题，把容易出错的地方留在这里，之后可以随时复盘。'));
  rows.forEach(mistake => {
    const item = document.createElement('div');
    item.className = 'item mistake-item';
    const body = document.createElement('div');
    body.className = 'mistake-item-body';
    const question = document.createElement('strong');
    question.textContent = mistake.question;
    body.append(question);
    if (mistake.answer) {
      const answer = document.createElement('p');
      answer.textContent = `我的答案 / 错误原因：${mistake.answer}`;
      body.append(answer);
    }
    const remove = document.createElement('button');
    remove.textContent = '删除';
    remove.setAttribute('aria-label', '删除这道错题');
    remove.onclick = async () => {
      if (!confirm('确定删除这道错题吗？')) return;
      remove.disabled = true;
      try {
        await api(`/courses/${courseId}/mistakes/${mistake.id}`, {method: 'DELETE'});
        if (course?.id === courseId) await loadMistakes(courseId, courseRevision);
        toast('错题已删除');
      } catch (error) { toast(error.message); }
      finally { remove.disabled = false; }
    };
    item.append(body, remove);
    list.append(item);
  });
  return rows;
}

// Construct Markdown with DOM APIs so model output can never inject HTML or script.
function appendInline(parent, text, depth = 0) {
  if (depth > 3) { parent.append(document.createTextNode(text)); return; }
  const pattern = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(text))) {
    parent.append(document.createTextNode(text.slice(cursor, match.index)));
    let node;
    if (match[1] !== undefined) {
      node = document.createElement('code');
      node.textContent = match[1];
    } else if (match[2] !== undefined) {
      let url;
      try { url = new URL(match[3], location.href); } catch { url = null; }
      if (url && ['https:', 'http:', 'mailto:'].includes(url.protocol)) {
        node = document.createElement('a');
        node.href = url.href;
        node.target = '_blank';
        node.rel = 'noopener noreferrer';
        appendInline(node, match[2], depth + 1);
      } else {
        node = document.createTextNode(match[0]);
      }
    } else {
      node = document.createElement(match[4] !== undefined || match[5] !== undefined ? 'strong' : 'em');
      appendInline(node, match[4] ?? match[5] ?? match[6] ?? match[7], depth + 1);
    }
    parent.append(node);
    cursor = pattern.lastIndex;
  }
  parent.append(document.createTextNode(text.slice(cursor)));
}

function tableCells(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);
  return text.split('|').map(cell => cell.trim());
}
function isTableRule(line) {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}
function isBlockStart(line, next) {
  return /^\s{0,3}(`{3,}|~{3,})/.test(line) || /^\s{0,3}#{1,6}\s+/.test(line) ||
    /^\s{0,3}>/.test(line) || /^\s{0,3}(?:[-*+]\s+|\d+[.)]\s+)/.test(line) ||
    /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line) ||
    (line.includes('|') && next !== undefined && isTableRule(next));
}
function appendMarkdown(parent, text, depth = 0) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      index++;
      const codeLines = [];
      while (index < lines.length) {
        const close = lines[index].trim();
        if (close[0] === fence[1][0] && close.length >= fence[1].length && [...close].every(char => char === fence[1][0])) { index++; break; }
        codeLines.push(lines[index++]);
      }
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = codeLines.join('\n');
      pre.append(code);
      parent.append(pre);
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const node = document.createElement(`h${Math.min(heading[1].length + 2, 6)}`);
      appendInline(node, heading[2]);
      parent.append(node);
      index++;
      continue;
    }
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      parent.append(document.createElement('hr'));
      index++;
      continue;
    }
    if (line.includes('|') && index + 1 < lines.length && isTableRule(lines[index + 1])) {
      const headers = tableCells(line);
      const wrap = document.createElement('div');
      wrap.className = 'markdown-table';
      const table = document.createElement('table');
      const head = document.createElement('thead');
      const headRow = document.createElement('tr');
      headers.forEach(value => { const cell = document.createElement('th'); appendInline(cell, value); headRow.append(cell); });
      head.append(headRow);
      table.append(head);
      index += 2;
      const body = document.createElement('tbody');
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        const values = tableCells(lines[index++]);
        const row = document.createElement('tr');
        headers.forEach((_, cellIndex) => { const cell = document.createElement('td'); appendInline(cell, values[cellIndex] || ''); row.append(cell); });
        body.append(row);
      }
      table.append(body);
      wrap.append(table);
      parent.append(wrap);
      continue;
    }
    if (/^\s{0,3}>/.test(line) && depth < 4) {
      const quoteLines = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) quoteLines.push(lines[index++].replace(/^\s{0,3}>\s?/, ''));
      const quote = document.createElement('blockquote');
      appendMarkdown(quote, quoteLines.join('\n'), depth + 1);
      parent.append(quote);
      continue;
    }
    const listMatch = line.match(/^\s{0,3}([-*+]|\d+[.)])\s+(.+)$/);
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[1]);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (index < lines.length) {
        const match = lines[index].match(/^\s{0,3}([-*+]|\d+[.)])\s+(.+)$/);
        if (!match || /^\d/.test(match[1]) !== ordered) break;
        const item = document.createElement('li');
        appendInline(item, match[2]);
        list.append(item);
        index++;
      }
      parent.append(list);
      continue;
    }
    const paragraph = document.createElement('p');
    let first = true;
    while (index < lines.length && lines[index].trim() && (first || !isBlockStart(lines[index], lines[index + 1]))) {
      if (!first) paragraph.append(document.createElement('br'));
      appendInline(paragraph, lines[index]);
      first = false;
      index++;
    }
    parent.append(paragraph);
  }
}

const welcomePrompts = [
  {label: '梳理课程重点', prompt: '请帮我梳理这门课程的核心知识点，并说明它们之间的联系。', mode: 'qa'},
  {label: '制定学习计划', prompt: '请根据课程资料为我制定一周学习计划。', mode: 'plan'}
];
function usePrompt(prompt, mode) {
  showTab('chat');
  $('question').value = prompt;
  if (mode && [...$('mode').options].some(option => option.value === mode)) $('mode').value = mode;
  resizeQuestion();
  saveDraft();
  $('question').focus();
}
function renderMessages(rows) {
  const list = $('messages');
  list.replaceChildren();
  if (!rows.length) {
    const welcome = document.createElement('div');
    welcome.className = 'welcome';
    const heading = document.createElement('h2');
    heading.textContent = '想问这门课的什么？';
    const tags = document.createElement('div');
    tags.className = 'welcome-tags';
    welcomePrompts.forEach(suggestion => {
      const tag = document.createElement('button');
      tag.type = 'button';
      tag.textContent = suggestion.label;
      tag.onclick = () => usePrompt(suggestion.prompt, suggestion.mode);
      tags.append(tag);
    });
    welcome.append(heading, tags);
    list.append(welcome);
  } else rows.forEach(appendMessage);
}
function reasoningDetails(text) {
  const details = document.createElement('details');
  details.className = 'message-reasoning';
  const summary = document.createElement('summary');
  summary.textContent = '思考过程';
  const content = document.createElement('div');
  content.className = 'reasoning-content';
  content.textContent = text;
  details.append(summary, content);
  return details;
}
function appendMessage(message) {
  $('messages').querySelector('.welcome')?.remove();
  const el = document.createElement('div');
  const role = message.role === 'user' ? 'user' : 'assistant';
  el.className = `message ${role}`;
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = role === 'user' ? '你' : '知学助手';
  const content = document.createElement('div');
  content.className = 'message-content';
  if (role === 'assistant') appendMarkdown(content, message.content);
  else content.textContent = message.content;
  el.append(meta);
  if (role === 'assistant' && message.reasoning?.trim()) el.append(reasoningDetails(message.reasoning));
  el.append(content);
  $('messages').append(el);
  $('messages').scrollTop = $('messages').scrollHeight;
  return el;
}
function createStreamingReply() {
  const message = appendMessage({role: 'assistant', content: ''});
  const list = $('messages');
  const answer = message.querySelector('.message-content');
  const answerText = answer.appendChild(document.createTextNode(''));
  answer.classList.add('streaming-text');
  const status = document.createElement('div');
  status.className = 'message-pending';
  status.setAttribute('role', 'status');
  status.textContent = '正在等待模型回应…';
  message.insertBefore(status, answer);
  const details = reasoningDetails('');
  const summary = details.querySelector('summary');
  const reasoning = details.querySelector('.reasoning-content').appendChild(document.createTextNode(''));
  let scrollFrame = null;

  function followReply() {
    if (scrollFrame !== null || list.scrollHeight - list.scrollTop - list.clientHeight > 48) return;
    scrollFrame = requestAnimationFrame(() => {
      if (message.isConnected) list.scrollTop = list.scrollHeight;
      scrollFrame = null;
    });
  }

  return {
    message,
    update(event) {
      followReply();
      if (event.type === 'reasoning') {
        if (!details.isConnected) message.insertBefore(details, status);
        summary.textContent = '正在思考…';
        reasoning.appendData(event.text);
        status.textContent = '';
      } else if (event.type === 'answer') {
        summary.textContent = '思考过程';
        status.textContent = '';
        answerText.appendData(event.text);
      } else if (event.type === 'tool') {
        summary.textContent = '思考过程';
        status.textContent = '正在检索相关内容…';
        answerText.data = '';
      }
    },
    finish(text) {
      followReply();
      summary.textContent = '思考过程';
      if (!reasoning.data.trim()) details.remove();
      status.remove();
      answer.classList.remove('streaming-text');
      answer.replaceChildren();
      appendMarkdown(answer, text);
    }
  };
}
function markMessageFailed(el, text, error) {
  el.classList.add('message-error');
  const status = document.createElement('div');
  status.className = 'message-error-text';
  status.textContent = `发送失败：${error.message}`;
  const actions = document.createElement('div');
  actions.className = 'message-actions';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = '重试';
  retry.onclick = () => {
    if (chatRequest) return;
    el.remove();
    sendMessage(text, false);
  };
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.textContent = '重新编辑';
  edit.onclick = () => {
    const current = $('question').value;
    $('question').value = current ? `${text}\n${current}` : text;
    el.remove();
    resizeQuestion();
    saveDraft();
    $('question').focus();
  };
  actions.append(retry, edit);
  el.append(status, actions);
  $('messages').scrollTop = $('messages').scrollHeight;
}

async function selectConversation(id) {
  if (!course) return;
  saveDraft();
  conversation = id;
  const courseId = course.id;
  const revision = courseRevision;
  const viewRevision = ++conversationRevision;
  historyLoading = Boolean(id);
  syncSendState();
  localStorage.setItem(conversationStorageKey(courseId), id);
  $('conversations').value = id;
  restoreDraft();
  if (!id) { renderMessages([]); return; }
  $('messages').replaceChildren(emptyList('正在加载对话…'));
  try {
    const rows = await api(`/courses/${courseId}/conversations/${id}`);
    if (isCurrentView(courseId, revision, viewRevision)) renderMessages(rows);
  } catch (error) {
    if (isCurrentView(courseId, revision, viewRevision)) {
      $('messages').replaceChildren(emptyList('对话暂时无法加载，请重新选择后重试。'));
      toast(error.message);
    }
  } finally {
    if (isCurrentView(courseId, revision, viewRevision)) {
      historyLoading = false;
      syncSendState();
    }
  }
}

async function sendMessage(explicitText, fromInput = true) {
  if (!course || chatRequest || historyLoading) return;
  const text = (explicitText ?? $('question').value).trim();
  if (!text) { $('question').focus(); return; }
  if (text.length > 8000) { toast('问题不能超过 8000 个字符'); return; }
  const selectedCourse = course.id;
  const revision = courseRevision;
  const viewRevision = conversationRevision;
  const oldConversation = conversation;
  const mode = $('mode').value;
  chatRequest = {courseId: selectedCourse, conversationId: oldConversation, text};
  const sendButtonMarkup = $('send').innerHTML;
  $('send').textContent = '生成中…';
  syncSendState();
  $('send').setAttribute('aria-busy', 'true');
  if (fromInput) {
    $('question').value = '';
    resizeQuestion();
    saveDraft();
  }
  const userMessage = appendMessage({role: 'user', content: text});
  const reply = createStreamingReply();
  try {
    const result = await streamChat(selectedCourse, {message: text, mode, conversation_id: oldConversation || null}, event => {
      if (isCurrentView(selectedCourse, revision, viewRevision)) reply.update(event);
    });
    if (isCurrentView(selectedCourse, revision, viewRevision)) {
      const oldKey = draftKey(selectedCourse, oldConversation);
      const nextKey = draftKey(selectedCourse, result.conversation_id);
      if (oldKey !== nextKey && drafts.has(oldKey)) {
        drafts.set(nextKey, drafts.get(oldKey));
        drafts.delete(oldKey);
      }
      conversation = result.conversation_id;
      localStorage.setItem(conversationStorageKey(selectedCourse), conversation);
      reply.finish(result.answer);
      await loadConversations(selectedCourse, revision).catch(() => {});
    } else if (course?.id === selectedCourse) {
      await loadConversations(selectedCourse, courseRevision).catch(() => {});
      if (oldConversation && conversation === oldConversation) {
        await selectConversation(oldConversation);
      }
      toast('回答已生成，可在课程对话中查看');
    } else {
      toast('回答已生成，可在课程对话中查看');
    }
  } catch (error) {
    reply.message.remove();
    if (isCurrentView(selectedCourse, revision, viewRevision)) {
      markMessageFailed(userMessage, text, error);
    } else {
      const key = draftKey(selectedCourse, oldConversation);
      const sameCurrentConversation = course?.id === selectedCourse && conversation === oldConversation;
      const existing = sameCurrentConversation ? $('question').value : drafts.get(key);
      drafts.set(key, existing ? `${text}\n${existing}` : text);
      if (sameCurrentConversation) restoreDraft();
      toast(`发送失败，问题已保留在草稿中：${error.message}`);
    }
  } finally {
    chatRequest = null;
    $('send').innerHTML = sendButtonMarkup;
    syncSendState();
    $('send').removeAttribute('aria-busy');
  }
}

function openCourseDialog() {
  $('courseForm').reset();
  $('courseError').textContent = '';
  $('courseError').classList.add('hidden');
  closeMobileMenu();
  $('courseDialog').showModal();
  $('newCourseName').focus();
}
for (const id of ['addCourse', 'firstCourse', 'emptyCourse']) $(id).addEventListener('click', openCourseDialog);
$('courseForm').onsubmit = async event => {
  event.preventDefault();
  const name = $('newCourseName').value.trim();
  if (!name) {
    $('courseError').textContent = '请输入课程名称。';
    $('courseError').classList.remove('hidden');
    return;
  }
  $('courseError').classList.add('hidden');
  $('saveCourse').disabled = true;
  let created;
  try { created = await api('/courses', {method: 'POST', body: {name}}); }
  catch (error) { $('courseError').textContent = error.message; $('courseError').classList.remove('hidden'); }
  finally { $('saveCourse').disabled = false; }
  if (!created) return;
  $('courseDialog').close();
  try {
    await loadCourses();
    await selectCourse(created);
    toast('课程创建成功');
  } catch (error) { toast('课程已创建，但加载失败：' + error.message); }
};

let isRegistering = false;
function authError(message) {
  $('authError').textContent = message;
  $('authError').classList.toggle('hidden', !message);
}
$('register').onclick = () => {
  isRegistering = !isRegistering;
  $('authTitle').textContent = isRegistering ? '创建你的账号' : '欢迎来到知学';
  $('authDescription').textContent = isRegistering ? '设置用户名和密码，开启你的学习空间。' : '登录你的学习空间，继续探索。';
  $('authSubmitLabel').textContent = isRegistering ? '创建账号并登录' : '登录';
  $('authSwitchText').textContent = isRegistering ? '已经有账号？' : '还没有账号？';
  $('register').textContent = isRegistering ? '返回登录' : '创建账号';
  $('usernameHint').classList.toggle('hidden', !isRegistering);
  $('passwordHint').classList.toggle('hidden', !isRegistering);
  $('password').autocomplete = isRegistering ? 'new-password' : 'current-password';
  authError('');
  $('username').focus();
};
async function submitAuth() {
  const username = $('username').value.trim();
  const secret = $('password').value;
  if (!username || !secret) { authError('请输入用户名和密码。'); return; }
  if (isRegistering && username.length < 3) { authError('用户名至少需要 3 个字符。'); return; }
  if (isRegistering && secret.length < 8) { authError('密码至少需要 8 个字符。'); return; }
  authError('');
  $('login').disabled = true;
  try {
    const credentials = {username, password: secret};
    if (isRegistering) await api('/register', {method: 'POST', body: credentials});
    const data = await api('/login', {method: 'POST', body: credentials});
    token = data.token;
    localStorage.setItem('zhixue_token', token);
    await loadUser();
    $('password').value = '';
    if (isRegistering) toast('账号创建成功，欢迎使用知学');
  } catch (error) { authError(error.message); }
  finally { $('login').disabled = false; }
}
$('login').onclick = submitAuth;
for (const id of ['username', 'password']) $(id).addEventListener('keydown', event => {
  if (event.key === 'Enter' && !$('login').disabled) submitAuth();
});
button('logout', async () => {
  try { await api('/logout', {method: 'POST'}); }
  finally { token = ''; localStorage.removeItem('zhixue_token'); location.reload(); }
});
button('savePreference', async () => {
  await api('/me', {method: 'PUT', body: {preference: $('preference').value}});
  $('preferenceDialog').close();
  toast('已保存学习偏好');
});
button('newChat', async () => {
  showTab('chat');
  await selectConversation('');
  $('question').focus();
});
$('conversations').onchange = event => selectConversation(event.target.value);
$('send').onclick = () => sendMessage();
$('question').addEventListener('input', () => { resizeQuestion(); saveDraft(); });
$('question').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !event.repeat) {
    event.preventDefault();
    sendMessage();
  }
});

async function uploadFiles(files) {
  if (!course || !files.length || uploading) return;
  uploading = true;
  $('file').disabled = true;
  const courseId = course.id;
  const revision = courseRevision;
  const progress = $('uploadProgress');
  progress.classList.remove('hidden');
  const errors = [];
  let completed = 0;
  try {
    for (const file of files) {
      if (isCurrentCourse(courseId, revision)) progress.textContent = `正在导入 ${completed + 1} / ${files.length}：${file.name}`;
      const data = new FormData();
      data.append('file', file);
      try { await api(`/courses/${courseId}/documents`, {method: 'POST', body: data}); }
      catch (error) { errors.push(`${file.name}：${error.message}`); }
      completed++;
    }
    if (course?.id === courseId) await loadDocuments(courseId, courseRevision);
    toast(errors.length ? `完成 ${files.length - errors.length} 个；${errors.join('；')}` : `已成功导入 ${files.length} 份资料`);
  } finally {
    if (isCurrentCourse(courseId, revision)) progress.classList.add('hidden');
    $('file').disabled = false;
    uploading = false;
  }
}
$('file').onchange = async event => {
  try { await uploadFiles([...event.target.files]); } catch (error) { toast(error.message); }
  finally { event.target.value = ''; }
};
const drop = $('dropZone');
for (const name of ['dragenter', 'dragover']) drop.addEventListener(name, event => { event.preventDefault(); drop.classList.add('dragging'); });
for (const name of ['dragleave', 'drop']) drop.addEventListener(name, event => { event.preventDefault(); drop.classList.remove('dragging'); });
drop.addEventListener('drop', event => uploadFiles([...event.dataTransfer.files]).catch(error => toast(error.message)));
drop.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('file').click(); }
});
button('addMistake', async () => {
  if (!course) return;
  const question = $('mistakeQuestion').value.trim();
  const answer = $('mistakeAnswer').value;
  if (!question) { toast('请先写下题目内容'); $('mistakeQuestion').focus(); return; }
  const courseId = course.id;
  await api(`/courses/${courseId}/mistakes`, {method: 'POST', body: {question, answer}});
  if (course?.id === courseId) {
    if ($('mistakeQuestion').value.trim() === question) $('mistakeQuestion').value = '';
    if ($('mistakeAnswer').value === answer) $('mistakeAnswer').value = '';
    saveMistakeDraft();
    await loadMistakes(courseId, courseRevision);
  } else {
    const draft = mistakeDrafts.get(courseId);
    if (draft) {
      if (draft.question.trim() === question) draft.question = '';
      if (draft.answer === answer) draft.answer = '';
    }
  }
  toast('错题已保存');
});

$('quickReview')?.addEventListener('click', () => {
  showTab('chat');
  $('mode').value = 'review';
  if (!$('question').value.trim()) {
    $('question').value = '请帮我复盘记录过的错题，分析错误原因并给出练习建议。';
    resizeQuestion();
    saveDraft();
  }
  $('question').focus();
});
$('openPreference').onclick = () => { closeMobileMenu(); $('preferenceDialog').showModal(); };
document.querySelectorAll('.close-dialog').forEach(el => el.onclick = () => el.closest('dialog').close());
async function openModelSettings() {
  const config = await api('/model-settings');
  $('baseUrl').value = config.base_url;
  $('chatModel').value = config.chat_model;
  $('visionModel').value = config.vision_model;
  $('embeddingModel').value = config.embedding_model;
  $('apiKey').value = '';
  $('apiKey').placeholder = config.key_error ? '重新输入 API Key' : (config.has_personal_key ? '已保存，留空保持不变' : '输入 API Key');
  $('keyHint').textContent = config.key_error
    ? '保存的密钥无法解密。请恢复原加密密钥，或重新输入 / 移除个人密钥。'
    : (config.has_personal_key ? '已加密保存个人密钥；留空则保持不变。' : (config.has_key ? '当前使用服务端默认密钥；输入可设置个人密钥。' : '密钥加密存储，不会再次显示。'));
  $('keyHint').classList.toggle('key-warning', Boolean(config.key_error));
  $('clearKey').classList.toggle('hidden', !config.has_personal_key);
  closeMobileMenu();
  $('settingsDialog').showModal();
}
for (const id of ['openSettings', 'topSettings']) {
  $(id).addEventListener('click', () => openModelSettings().catch(error => toast(error.message)));
}
function settingsBody(clear = false) {
  return {
    base_url: $('baseUrl').value.trim(),
    chat_model: $('chatModel').value.trim(),
    vision_model: $('visionModel').value.trim(),
    embedding_model: $('embeddingModel').value.trim(),
    api_key: $('apiKey').value || null,
    clear_api_key: clear
  };
}
$('settingsForm').onsubmit = async event => {
  event.preventDefault();
  $('saveSettings').disabled = true;
  try {
    await api('/model-settings', {method: 'PUT', body: settingsBody()});
    $('settingsDialog').close();
    toast('模型设置已保存');
  } catch (error) { toast(error.message); }
  finally { $('saveSettings').disabled = false; }
};
$('clearKey').onclick = async () => {
  if (!confirm('移除已保存的个人密钥？之后将使用服务端默认密钥（如有）。')) return;
  try {
    await api('/model-settings', {method: 'PUT', body: settingsBody(true)});
    $('settingsDialog').close();
    toast('个人密钥已移除');
  } catch (error) { toast(error.message); }
};

if (token) loadUser().catch(error => {
  if (error.status === 401) { token = ''; localStorage.removeItem('zhixue_token'); }
  else toast('暂时无法加载学习空间，请检查网络后重试');
});
