const $ = id => document.getElementById(id);
let token = localStorage.getItem('zhixue_token') || '', course = null, conversation = '';
async function api(path, options = {}) {
  const headers = {...(options.headers || {})};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && !(options.body instanceof FormData)) { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(options.body); }
  const response = await fetch('/api' + path, {...options, headers});
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '请求失败，请检查输入');
  return data;
}
function toast(text) { $('toast').textContent = text; $('toast').classList.remove('hidden'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').classList.add('hidden'), 4000); }
function button(id, fn) { $(id).onclick = async () => { $(id).disabled = true; try { await fn(); } catch (e) { toast(e.message); } finally { $(id).disabled = false; } }; }
async function loadUser() { const me = await api('/me'); $('preference').value = me.preference; $('auth').classList.add('hidden'); $('workspace').classList.remove('hidden'); $('logout').classList.remove('hidden'); await loadCourses(); }
async function loadCourses() { const rows = await api('/courses'); $('courses').replaceChildren(); rows.forEach(c => { const b = document.createElement('button'); b.className = 'course-item' + (course?.id === c.id ? ' active' : ''); b.textContent = c.name; b.onclick = () => selectCourse(c).catch(e => toast(e.message)); $('courses').append(b); }); }
async function selectCourse(c) { course = c; conversation = ''; $('courseName').textContent = c.name; $('empty').classList.add('hidden'); $('courseView').classList.remove('hidden'); showTab('chat'); await Promise.all([loadCourses(), loadDocuments(), loadConversations(), loadMistakes()]); renderMessages([]); }
function showTab(id) { document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active',t.dataset.tab===id)); document.querySelectorAll('.panel').forEach(p => p.classList.toggle('hidden',p.id!==id)); }
document.querySelectorAll('.tab').forEach(t => t.onclick = () => showTab(t.dataset.tab));
async function loadDocuments() { const rows = await api(`/courses/${course.id}/documents`); $('documents').replaceChildren(); if (!rows.length) $('documents').textContent = '还没有资料，上传一份开始学习吧。'; rows.forEach(d => { const item = document.createElement('div'); item.className = 'item'; const name = document.createElement('span'); name.textContent = d.name; const del = document.createElement('button'); del.textContent = '删除'; del.onclick = async () => { if (!confirm(`删除资料「${d.name}」？`)) return; try { await api(`/courses/${course.id}/documents/${d.id}`, {method:'DELETE'}); await loadDocuments(); } catch(e) { toast(e.message); } }; item.append(name,del); $('documents').append(item); }); }
async function loadConversations() { const rows = await api(`/courses/${course.id}/conversations`); $('conversations').replaceChildren(new Option('新会话','')); rows.forEach(c => $('conversations').add(new Option(c.title,c.id))); $('conversations').value = conversation; }
async function loadMistakes() { const rows = await api(`/courses/${course.id}/mistakes`); $('mistakeList').replaceChildren(); rows.forEach(m => { const item = document.createElement('div'); item.className='item'; item.textContent = m.question + (m.answer ? '\n我的答案：' + m.answer : ''); $('mistakeList').append(item); }); }
function renderMessages(rows) { $('messages').replaceChildren(); if (!rows.length) { const w = document.createElement('div'); w.className='welcome'; const h=document.createElement('h2'); h.textContent='今天想学些什么？'; const p=document.createElement('p'); p.textContent='上传课程资料后，试着向我提出一个问题。'; w.append(h,p); $('messages').append(w); } else rows.forEach(appendMessage); }
function appendMessage(m) { const welcome = $('messages').querySelector('.welcome'); if (welcome) welcome.remove(); const el = document.createElement('div'); el.className = 'message ' + m.role; el.textContent = m.content; $('messages').append(el); $('messages').scrollTop = $('messages').scrollHeight; }
async function createCourse() { const name = prompt('课程名称'); if (!name?.trim()) return; const c = await api('/courses',{method:'POST',body:{name:name.trim()}}); await selectCourse(c); }
button('addCourse',createCourse); button('firstCourse',createCourse);
button('register',async () => { await api('/register',{method:'POST',body:{username:$('username').value,password:$('password').value}}); toast('注册成功，请登录'); });
button('login',async () => { const data=await api('/login',{method:'POST',body:{username:$('username').value,password:$('password').value}}); token=data.token; localStorage.setItem('zhixue_token',token); await loadUser(); });
button('logout',async () => { await api('/logout',{method:'POST'}); token=''; localStorage.removeItem('zhixue_token'); location.reload(); });
button('savePreference',async () => { await api('/me',{method:'PUT',body:{preference:$('preference').value}}); toast('已保存学习偏好'); });
button('newChat',async () => { conversation=''; $('conversations').value=''; renderMessages([]); });
$('conversations').onchange = async e => { conversation=e.target.value; try { renderMessages(conversation ? await api(`/courses/${course.id}/conversations/${conversation}`) : []); } catch(err) { toast(err.message); } };
button('send',async () => { const text=$('question').value.trim(); if (!text) return; const selectedCourse=course.id; const oldConversation=conversation; appendMessage({role:'user',content:text}); $('question').value=''; try { const result=await api(`/courses/${selectedCourse}/chat`,{method:'POST',body:{message:text,mode:$('mode').value,conversation_id:oldConversation || null}}); if (course.id===selectedCourse && conversation===oldConversation) { conversation=result.conversation_id; appendMessage({role:'assistant',content:result.answer}); await loadConversations(); } } catch(e) { if (course.id===selectedCourse && conversation===oldConversation) { $('question').value=text; appendMessage({role:'assistant',content:'发送失败：'+e.message}); } throw e; } });
$('file').onchange = async e => { const f=e.target.files[0]; if (!f) return; const data=new FormData(); data.append('file',f); try { toast('正在处理资料，请稍候…'); const result=await api(`/courses/${course.id}/documents`,{method:'POST',body:data}); toast(`资料已入库，共 ${result.chunks} 个片段`); await loadDocuments(); } catch(err) { toast(err.message); } finally { e.target.value=''; } };
button('addMistake',async () => { const question=$('mistakeQuestion').value.trim(); if (!question) return; await api(`/courses/${course.id}/mistakes`,{method:'POST',body:{question,answer:$('mistakeAnswer').value}}); $('mistakeQuestion').value=''; $('mistakeAnswer').value=''; await loadMistakes(); toast('错题已保存'); });
if (token) loadUser().catch(() => { token=''; localStorage.removeItem('zhixue_token'); });
