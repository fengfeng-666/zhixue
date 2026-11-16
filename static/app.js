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
async function loadUser() { const me = await api('/me'); $('preference').value = me.preference; $('userName').textContent = me.username; $('avatar').textContent = me.username.slice(0,1).toUpperCase(); $('auth').classList.add('hidden'); $('workspace').classList.remove('hidden'); $('logout').classList.remove('hidden'); await loadCourses(); }
async function loadCourses() { const rows = await api('/courses'); $('courses').replaceChildren(); rows.forEach(c => { const b = document.createElement('button'); b.className = 'course-item' + (course?.id === c.id ? ' active' : ''); b.textContent = c.name; b.onclick = () => selectCourse(c).catch(e => toast(e.message)); $('courses').append(b); }); }
async function selectCourse(c) { course = c; conversation = ''; $('courseName').textContent = c.name; $('breadcrumb').textContent = c.name; $('empty').classList.add('hidden'); $('courseView').classList.remove('hidden'); showTab('chat'); await Promise.all([loadCourses(), loadDocuments(), loadConversations(), loadMistakes()]); renderMessages([]); }
function showTab(id) { document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active',t.dataset.tab===id)); document.querySelectorAll('.panel').forEach(p => p.classList.toggle('hidden',p.id!==id)); }
document.querySelectorAll('.tab').forEach(t => t.onclick = () => showTab(t.dataset.tab));
async function loadDocuments() { const rows = await api(`/courses/${course.id}/documents`); $('documents').replaceChildren(); $('docCount').textContent = rows.length; $('docTotal').textContent = `${rows.length} 份资料`; if (!rows.length) { const empty = document.createElement('div'); empty.className = 'empty-list'; empty.textContent = '还没有导入资料，添加第一份资料开始学习吧。'; $('documents').append(empty); } rows.forEach(d => { const item = document.createElement('div'); item.className = 'item'; const name = document.createElement('div'); name.className='item-name'; const icon = document.createElement('span'); icon.className='file-icon'; icon.textContent=/\.(png|jpe?g|webp)$/i.test(d.name) ? '▧' : '▤'; const label=document.createElement('span'); label.textContent=d.name; name.append(icon,label); const del = document.createElement('button'); del.textContent = '删除'; del.onclick = async () => { if (!confirm(`删除资料「${d.name}」？`)) return; try { await api(`/courses/${course.id}/documents/${d.id}`, {method:'DELETE'}); await loadDocuments(); } catch(e) { toast(e.message); } }; item.append(name,del); $('documents').append(item); }); }
async function loadConversations() { const rows = await api(`/courses/${course.id}/conversations`); $('conversations').replaceChildren(new Option('新会话','')); rows.forEach(c => $('conversations').add(new Option(c.title,c.id))); $('conversations').value = conversation; }
async function loadMistakes() { const rows = await api(`/courses/${course.id}/mistakes`); $('mistakeList').replaceChildren(); rows.forEach(m => { const item = document.createElement('div'); item.className='item'; item.textContent = m.question + (m.answer ? '\n我的答案：' + m.answer : ''); $('mistakeList').append(item); }); }
function renderMessages(rows) { $('messages').replaceChildren(); if (!rows.length) { const w = document.createElement('div'); w.className='welcome'; const mark=document.createElement('div'); mark.className='welcome-mark'; mark.textContent='✳'; const h=document.createElement('h2'); h.textContent='今天，想学点什么？'; const p=document.createElement('p'); p.textContent='无论是一个问题，还是一个学习目标，我都在这里。'; const tags=document.createElement('div'); tags.className='welcome-tags'; ['✧ 理解知识点','▤ 梳理课程内容','◷ 制定学习计划'].forEach(t=>{const tag=document.createElement('span'); tag.textContent=t; tags.append(tag);}); w.append(mark,h,p,tags); $('messages').append(w); } else rows.forEach(appendMessage); }
function appendMessage(m) { const welcome = $('messages').querySelector('.welcome'); if (welcome) welcome.remove(); const el = document.createElement('div'); el.className = 'message ' + m.role; el.textContent = m.content; $('messages').append(el); $('messages').scrollTop = $('messages').scrollHeight; }
async function createCourse() { const name = prompt('课程名称'); if (!name?.trim()) return; const c = await api('/courses',{method:'POST',body:{name:name.trim()}}); await selectCourse(c); }
button('addCourse',createCourse); button('firstCourse',createCourse); button('emptyCourse',createCourse);
button('register',async () => { await api('/register',{method:'POST',body:{username:$('username').value,password:$('password').value}}); toast('注册成功，请登录'); });
button('login',async () => { const data=await api('/login',{method:'POST',body:{username:$('username').value,password:$('password').value}}); token=data.token; localStorage.setItem('zhixue_token',token); await loadUser(); });
button('logout',async () => { await api('/logout',{method:'POST'}); token=''; localStorage.removeItem('zhixue_token'); location.reload(); });
button('savePreference',async () => { await api('/me',{method:'PUT',body:{preference:$('preference').value}}); $('preferenceDialog').close(); toast('已保存学习偏好'); });
button('newChat',async () => { conversation=''; $('conversations').value=''; renderMessages([]); });
$('conversations').onchange = async e => { conversation=e.target.value; try { renderMessages(conversation ? await api(`/courses/${course.id}/conversations/${conversation}`) : []); } catch(err) { toast(err.message); } };
button('send',async () => { const text=$('question').value.trim(); if (!text) return; const selectedCourse=course.id; const oldConversation=conversation; appendMessage({role:'user',content:text}); $('question').value=''; try { const result=await api(`/courses/${selectedCourse}/chat`,{method:'POST',body:{message:text,mode:$('mode').value,conversation_id:oldConversation || null}}); if (course.id===selectedCourse && conversation===oldConversation) { conversation=result.conversation_id; appendMessage({role:'assistant',content:result.answer}); await loadConversations(); } } catch(e) { if (course.id===selectedCourse && conversation===oldConversation) { $('question').value=text; appendMessage({role:'assistant',content:'发送失败：'+e.message}); } throw e; } });
async function uploadFiles(files) {
  if (!course || !files.length) return;
  const courseId = course.id; const progress = $('uploadProgress'); progress.classList.remove('hidden');
  const errors = []; let completed = 0;
  for (const file of files) {
    progress.textContent = `正在导入 ${completed + 1} / ${files.length}：${file.name}`;
    const data = new FormData(); data.append('file', file);
    try { await api(`/courses/${courseId}/documents`, {method:'POST',body:data}); }
    catch (err) { errors.push(`${file.name}：${err.message}`); }
    completed++;
  }
  progress.classList.add('hidden');
  if (course?.id === courseId) await loadDocuments();
  toast(errors.length ? `完成 ${files.length-errors.length} 个；${errors.join('；')}` : `已成功导入 ${files.length} 份资料`);
}
$('file').onchange = async e => { try { await uploadFiles([...e.target.files]); } catch(err) { toast(err.message); } finally { e.target.value=''; } };
const drop = $('dropZone');
for (const name of ['dragenter','dragover']) drop.addEventListener(name,e=>{e.preventDefault(); drop.classList.add('dragging');});
for (const name of ['dragleave','drop']) drop.addEventListener(name,e=>{e.preventDefault(); drop.classList.remove('dragging');});
drop.addEventListener('drop',e=>uploadFiles([...e.dataTransfer.files]).catch(err=>toast(err.message)));
drop.addEventListener('keydown',e=>{if(e.key==='Enter' || e.key===' '){e.preventDefault(); $('file').click();}});
button('addMistake',async () => { const question=$('mistakeQuestion').value.trim(); if (!question) return; await api(`/courses/${course.id}/mistakes`,{method:'POST',body:{question,answer:$('mistakeAnswer').value}}); $('mistakeQuestion').value=''; $('mistakeAnswer').value=''; await loadMistakes(); toast('错题已保存'); });
if (token) loadUser().catch(() => { token=''; localStorage.removeItem('zhixue_token'); });

$('goDocs').onclick = () => showTab('docs');
document.querySelectorAll('.suggestion').forEach(el=>el.onclick=()=>{ $('question').value=el.dataset.prompt; $('question').focus(); });
$('openPreference').onclick=()=>$('preferenceDialog').showModal();
document.querySelectorAll('.close-dialog').forEach(el=>el.onclick=()=>el.closest('dialog').close());
async function openModelSettings() {
  const config=await api('/model-settings');
  $('baseUrl').value=config.base_url; $('chatModel').value=config.chat_model; $('visionModel').value=config.vision_model; $('embeddingModel').value=config.embedding_model; $('apiKey').value='';
  $('apiKey').placeholder=config.has_personal_key ? '已保存，留空保持不变' : '输入 API Key';
  $('keyHint').textContent=config.has_personal_key ? '已加密保存个人密钥；留空则保持不变。' : (config.has_key ? '当前使用服务端默认密钥；输入可设置个人密钥。' : '密钥加密存储，不会再次显示。');
  $('clearKey').classList.toggle('hidden', !config.has_personal_key);
  $('settingsDialog').showModal();
}
for (const id of ['openSettings','openSettingsSide','topSettings']) $(id).onclick=()=>openModelSettings().catch(e=>toast(e.message));
function settingsBody(clear=false) { return {base_url:$('baseUrl').value.trim(),chat_model:$('chatModel').value.trim(),vision_model:$('visionModel').value.trim(),embedding_model:$('embeddingModel').value.trim(),api_key:$('apiKey').value || null,clear_api_key:clear}; }
$('settingsForm').onsubmit=async e=>{e.preventDefault(); $('saveSettings').disabled=true; try {await api('/model-settings',{method:'PUT',body:settingsBody()}); $('settingsDialog').close(); toast('模型设置已保存');} catch(err){toast(err.message);} finally {$('saveSettings').disabled=false;}};
$('clearKey').onclick=async()=>{if(!confirm('移除已保存的个人密钥？之后将使用服务端默认密钥（如有）。')) return; try {await api('/model-settings',{method:'PUT',body:settingsBody(true)}); $('settingsDialog').close(); toast('个人密钥已移除');} catch(err){toast(err.message);}};
