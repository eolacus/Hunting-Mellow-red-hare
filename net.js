// Shared live connection for all four screens (player, stage, host, npc).
// With a Firebase config in config.js it uses Firebase Realtime Database.
// Without one (or with ?mock in the URL) it runs a local rehearsal backend that syncs
// tabs of the same browser on one device, seeded from ../firebase/firebase-seed.json when present.
import CONFIG from './config.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';

// ---------- path helpers ----------
const split = p => String(p || '').split('/').filter(Boolean);
const getAt = (obj, path) => split(path).reduce((o, k) => (o == null ? undefined : o[k]), obj);
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function setAt(obj, path, val){
  const ks = split(path); if(!ks.length) return val;
  let o = obj; for(let i = 0; i < ks.length - 1; i++){ if(o[ks[i]] == null || typeof o[ks[i]] !== 'object') o[ks[i]] = {}; o = o[ks[i]]; }
  if(val === null || val === undefined) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = val;
  return obj;
}
const pushId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
async function loadSeed(){
  for(const u of ['../firebase/firebase-seed.json', 'firebase-seed.json']){
    try{ const r = await fetch(u, {cache:'no-store'}); if(r.ok) return await r.json(); }catch(e){}
  }
  return {};
}

// ---------- local rehearsal backend ----------
async function mockBackend(){
  const KEY = 'hmrh_mockdb';
  const ch = new BroadcastChannel('hmrh_mockdb');
  let db = null;
  try{ db = JSON.parse(localStorage.getItem(KEY)); }catch(e){}
  if(!db){ db = await loadSeed(); localStorage.setItem(KEY, JSON.stringify(db)); }
  let uid = sessionStorage.getItem('hmrh_uid');
  if(!uid){ uid = 'u' + pushId(); sessionStorage.setItem('hmrh_uid', uid); }
  const subs = new Set();
  const notify = () => subs.forEach(s => { const v = clone(getAt(db, s.path)); const j = JSON.stringify(v); if(j !== s.last){ s.last = j; s.cb(v === undefined ? null : v); } });
  const commit = () => { localStorage.setItem(KEY, JSON.stringify(db)); ch.postMessage(1); notify(); };
  ch.onmessage = () => { try{ db = JSON.parse(localStorage.getItem(KEY)) || {}; }catch(e){} notify(); };
  const onExit = [];
  addEventListener('pagehide', () => { onExit.forEach(([p, v]) => setAt(db, p, v)); if(onExit.length) commit(); });
  return {
    mode: 'mock', uid,
    now: () => Date.now(),
    on(path, cb){ const s = {path, cb, last: undefined}; subs.add(s); setTimeout(notify, 0); return () => subs.delete(s); },
    async get(path){ return clone(getAt(db, path)) ?? null; },
    async set(path, val){ setAt(db, path, clone(val)); commit(); },
    async update(path, obj){ for(const [k, v] of Object.entries(obj)) setAt(db, (path ? path + '/' : '') + k, clone(v)); commit(); },
    async push(path, val){ const id = pushId(); setAt(db, path + '/' + id, clone(val)); commit(); return id; },
    async remove(path){ setAt(db, path, null); commit(); },
    presence(path, onVal, offVal){ setAt(db, path, onVal); commit(); onExit.push([path, offVal]); },
    async claim(role, pin){
      const ok = String(pin) === String(getAt(db, 'secrets/' + role + 'Pin'));
      if(ok){ setAt(db, `claims/${role}/${uid}`, String(pin)); commit(); }
      return ok;
    },
    async resetAll(){ db = await loadSeed(); commit(); }
  };
}

// ---------- Firebase backend ----------
async function firebaseBackend(cfg){
  const [{ initializeApp }, A, D] = await Promise.all([
    import(FB + 'firebase-app.js'), import(FB + 'firebase-auth.js'), import(FB + 'firebase-database.js')]);
  const app = initializeApp(cfg);
  const auth = A.getAuth(app);
  const cred = await A.signInAnonymously(auth);
  const db = D.getDatabase(app);
  const r = p => D.ref(db, p);
  // a refused write (rules, expired login) must not fail silently: tell the page
  const warn = (path, e) => { console.error('write failed', path, e); window.dispatchEvent(new CustomEvent('neterr', { detail: path + ': ' + (e && e.code || e) })); };
  let offset = 0; D.onValue(r('.info/serverTimeOffset'), s => { offset = s.val() || 0; });
  return {
    mode: 'firebase', uid: cred.user.uid,
    now: () => Date.now() + offset,
    on(path, cb){ return D.onValue(r(path), s => cb(s.val()), () => cb(null)); },
    async get(path){ return (await D.get(r(path))).val(); },
    set: (path, val) => D.set(r(path), val).catch(e => { warn(path, e); }),
    update: (path, obj) => D.update(r(path), obj).catch(e => { warn(path, e); }),
    async push(path, val){ const p = D.push(r(path)); await D.set(p, val); return p.key; },
    remove: path => D.remove(r(path)),
    presence(path, onVal, offVal){
      D.onValue(r('.info/connected'), s => { if(s.val() === true){ D.onDisconnect(r(path)).set(offVal ?? null); D.set(r(path), onVal).catch(() => {}); } });
    },
    async claim(role, pin){ try{ await D.set(r(`claims/${role}/${cred.user.uid}`), String(pin)); return true; }catch(e){ return false; } },
    async resetAll(){ throw new Error('Firebase 모드에서는 진행자 패널의 "게임 기록 초기화"를 쓰세요.'); }
  };
}

// ---------- connect once, share as window.NET ----------
let ready = null;
export function connect(){
  if(ready) return ready;
  const wantMock = /[?&]mock\b/.test(location.search) || !CONFIG || !CONFIG.apiKey;
  ready = (wantMock ? mockBackend() : firebaseBackend(CONFIG).catch(e => { console.warn('Firebase 연결 실패, 연습 모드로 전환', e); return mockBackend(); }))
    .then(N => { window.NET = N; dispatchEvent(new CustomEvent('net-ready', {detail: N})); return N; });
  return ready;
}

// ---------- shared game constants ----------
export const PHASES = ['arrive', 'opening', 'act1', 'mid', 'act2', 'trial', 'end', 'party'];
export const PHASE_NAME = { arrive: '입장', opening: '오프닝', act1: '1막 - 4문양 화합의 만찬', mid: '중간 이벤트 - 시간의 비밀', act2: '2막 - 오래된 기억을 모아', trial: '자정의 재판', end: '결말 - 자정의 종', party: '자유 파티' };
// opening starts with a few minutes for everyone to read their house handbook, unless the host moves on
export const ENVELOPE_MS = 5 * 60e3;
export const envelopeOn = (st, now) => !!st && st.phase === 'opening' && now - (st.phaseAt || 0) < ENVELOPE_MS && !((st.opGoAt || 0) > (st.phaseAt || 0));
export const PHASE_CH = { mid: 'c5', act2: 'c6', trial: 'c7', end: 'c8' };
export const STORY_MIN = { arrive: 420, opening: 420, act1: 420, mid: 500, act2: 510, trial: 719, end: 719, party: 720 };
export const HOUSES = [
  {k:'spade', s:'♠', n:'스페이드', red:false}, {k:'heart', s:'♥', n:'하트', red:true},
  {k:'clover', s:'♣', n:'클로버', red:false}, {k:'diamond', s:'♦', n:'다이아', red:true}];
export const TITLES = {gate:'경계의 문', c1:'첫 번째 문제', c2:'두 번째 문제', c3:'세 번째 문제', c4:'시계가 잠든 자리', c5:'시간의 비밀', c6:'백 년 전의 기록', c7:'자정의 재판', c8:'자정',
  opening:'오프닝', rules:'공통 규칙', phase:'페이즈 안내', house:'가문 설정서', secret:'가문의 비밀'};
export const pIdx = p => PHASES.indexOf(p);

// "19:30" today (device local time, Korea) -> ms
export function atToday(hhmm, nowMs){
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  const d = new Date(nowMs || Date.now()); d.setHours(h || 0, m || 0, 0, 0); return d.getTime();
}
// latest automatic schedule entry that has started
export function scheduledPhase(schedule, nowMs){
  let best = null;
  for(const e of Object.values(schedule || {})) if(e && e.auto && atToday(e.time, nowMs) <= nowMs && (!best || pIdx(e.phase) > pIdx(best))) best = e.phase;
  return best;
}
// admin pages move the phase forward on schedule. It acts when a scheduled time is newly reached
// (or once on load to catch up), so a manual step back is not undone until the next scheduled time.
export function autoAdvance(N, getState, getConfig){
  let last, wasOn;
  setInterval(() => {
    const st = getState(), cfg = getConfig(); if(!st || !cfg || !st.phase) return;
    const on = st.auto !== false; if(on && wasOn === false) last = undefined;   // resuming catches up to the clock
    wasOn = on;
    const sp = scheduledPhase(cfg.schedule, N.now());
    if(sp === last) return;
    last = sp;
    if(st.auto === false) return;
    if(sp && pIdx(sp) > pIdx(st.phase)) N.update('state', { phase: sp, phaseAt: N.now(), stageScene: '', showSpell: false, openingPage: 0 });
  }, 2000);
}
// next timed entry after now
export function nextEntry(schedule, nowMs, curPhase){
  let best = null;
  for(const e of Object.values(schedule || {})){ if(curPhase && pIdx(e.phase) <= pIdx(curPhase)) continue;
    const t = atToday(e.time, nowMs); if(t > nowMs && (!best || t < best.t)) best = {...e, t}; }
  return best;
}
export const fmtClock = ms => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
export const fmtLeft = ms => { if(ms <= 0) return '0:00'; const s = Math.round(ms / 1000), m = Math.floor(s / 60); return m >= 60 ? Math.floor(m / 60) + '시간 ' + (m % 60) + '분' : m + ':' + String(s % 60).padStart(2, '0'); };
export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
export const md = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/&lt;br&gt;/g, '<br>');
// admin login with a PIN kept in this browser
export async function login(N, role, title){
  const key = 'hmrh_pin_' + role;
  let pin = localStorage.getItem(key);
  if(pin && await N.claim(role, pin)) return true;
  return new Promise(res => {
    const d = document.createElement('div'); d.className = 'login';
    d.innerHTML = `<div class="lb"><div class="lk">Hunting Mellow Red Hare</div><h2>${title}</h2><input type="password" placeholder="비밀번호" autocomplete="off"><button>들어가기</button><div class="lm"></div></div>`;
    document.body.append(d);
    const inp = d.querySelector('input'), btn = d.querySelector('button'), m = d.querySelector('.lm');
    const go = async () => { const v = inp.value.trim(); if(!v) return; btn.disabled = true;
      if(await N.claim(role, v)){ localStorage.setItem(key, v); d.remove(); res(true); } else { m.textContent = '비밀번호가 맞지 않습니다.'; btn.disabled = false; } };
    btn.onclick = go; inp.onkeydown = e => { if(e.key === 'Enter') go(); }; inp.focus();
  });
}
export const LOGIN_CSS = `.login{position:fixed;inset:0;z-index:999;display:flex;align-items:center;justify-content:center;background:#0b0405;padding:16px}
.login .lb{width:100%;max-width:340px;text-align:center;padding:28px 20px;border:1px solid #c9a45c;background:#140709}
.login .lk{font-family:'Pinyon Script',cursive;color:#e6c98a;font-size:22px}.login h2{font-family:'Noto Serif KR',serif;color:#efe3d0;margin:6px 0 16px;font-size:20px}
.login input{width:100%;box-sizing:border-box;padding:12px;font-size:16px;background:#000;color:#efe3d0;border:1px solid #6b4a2a;border-radius:4px;margin-bottom:10px;text-align:center}
.login button{width:100%;padding:12px;font-size:15px;background:#9e1b2b;color:#fff;border:0;border-radius:4px}.login .lm{color:#e0414f;font-size:13px;margin-top:8px;min-height:18px}`;
