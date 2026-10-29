import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { startSparks, burst } from './motion.js';

// ── utilità ────────────────────────────────────────────────────
const $app = document.getElementById('app');
const $tabbar = document.getElementById('tabbar');
const $toast = document.getElementById('toast');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const flames = n => '🔥'.repeat(Math.max(1, n || 1));
const stars = n => `<span style="color:var(--gold)">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</span>`;
const LEVELS = ['Dolce', 'Audace', 'Molto audace'];
const CATS = {
  romance: ['🌹', 'Romanticismo'], touch: ['🤲', 'Tocco e sensi'], tease: ['😏', 'Seduzione e gioco'],
  words: ['💬', 'Parole e fantasie'], places: ['🗝️', 'Tempi e luoghi'], explore: ['🔥', 'Esplorazione'],
};
const MIN_INSIGHTS = 4; // come nella funzione Selene
const MAX_REROLLS = 5;  // come nella funzione Selene
const store = {
  get: k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const haptic = p => { try { navigator.vibrate?.(p); } catch {} };

function toast(msg, isErr = false) {
  $toast.textContent = msg;
  $toast.className = 'toast' + (isErr ? ' err' : '');
  $toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => ($toast.hidden = true), 3800);
}

function errMsg(e) {
  const m = e?.message || String(e);
  if (/Invalid login credentials/i.test(m)) return 'Nome o password non corretti';
  if (/already registered|already been registered/i.test(m)) return 'Questo nome è già registrato: accedi';
  if (/Password should be/i.test(m)) return 'La password deve avere almeno 6 caratteri';
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Connessione assente, riprova';
  return m;
}

// accesso solo con nome + password: l'email è interna e non riceve mai nulla
function nameToEmail(name) {
  const slug = String(name || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
  if (!slug) throw new Error('Scrivi il tuo nome');
  return `${slug}@pippilove.app`;
}

async function run(fn, btn) {
  if (btn) btn.disabled = true;
  try { return await fn(); }
  catch (e) { console.error(e); toast(errMsg(e), true); }
  finally { if (btn && btn.isConnected) btn.disabled = false; }
}

function mondayOf(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => isoDate(new Date());
const fmtDay = s => new Date(s + 'T12:00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'long' });
const longToday = () => new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
function daysLeft() {
  const next = mondayOf(); next.setDate(next.getDate() + 7);
  return Math.max(1, Math.ceil((next - new Date()) / 86400000));
}
function greeting() {
  const h = new Date().getHours();
  return h < 6 ? 'Notte fonda' : h < 13 ? 'Buongiorno' : h < 18 ? 'Buon pomeriggio' : 'Buonasera';
}

// ── configurazione Supabase ───────────────────────────────────
// tiene solo https://xxxx.supabase.co (toglie /rest/v1/ e simili incollati per errore)
function cleanUrl(u) {
  u = String(u || '').trim();
  if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { return new URL(u).origin; } catch { return u.replace(/\/+$/, ''); }
}
function getConfig() {
  if (SUPABASE_URL && SUPABASE_ANON_KEY) return { url: cleanUrl(SUPABASE_URL), key: SUPABASE_ANON_KEY.trim(), fromFile: true };
  const c = store.get('pippilove_config');
  return c?.url && c?.key ? { ...c, url: cleanUrl(c.url), key: String(c.key).trim() } : null;
}

let sb = null;
const freshState = () => ({
  session: null, profile: null, couple: null, partner: null,
  myInsights: 0, proposals: [], challenges: [],
  checkin: null, tip: null, tipLoading: false, drawing: false, drawBlocked: null,
  chat: null, chatSeen: 0, chatBusy: false, chatProgress: null, insights: null, chatExtras: null, chatOwner: null,
  loaded: false, authTab: 'login', checkinDraft: null, ckStep: 0, ckDir: 'in',
  rerollFor: null,
});
const S = freshState();
const uid = () => S.session?.user?.id;
const myName = () => S.profile?.display_name || 'tu';
const partnerName = () => S.partner?.name || 'il/la partner';
const thisWeek = () => isoDate(mondayOf());
const meReady = () => S.myInsights >= MIN_INSIGHTS;
const partnerReady = () => (S.partner?.insights || 0) >= MIN_INSIGHTS;

// ── chiamate a Selene (AI, lato server) ────────────────────────
async function selene(action, payload = {}) {
  const { data, error } = await sb.functions.invoke('selene', { body: { action, ...payload } });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); msg = j.error || msg; } catch {}
    const e = new Error(msg); e.status = error.context?.status; throw e;
  }
  return data;
}
const notDeployed = e => e?.status === 404 || /not found|Failed to send/i.test(e?.message || '');
const seleneErr = e => notDeployed(e) ? 'Selene non è ancora attiva: va pubblicata la funzione su Supabase (vedi README)' : errMsg(e);

// ── caricamento dati ──────────────────────────────────────────
async function loadAll() {
  const me = uid();
  const { data: profile, error: pe } = await sb.from('profiles').select('*').eq('id', me).maybeSingle();
  if (pe) throw pe;
  S.profile = profile;
  S.couple = null; S.partner = null;
  if (profile?.couple_id) {
    const [{ data: couple }, { data: partner }] = await Promise.all([
      sb.from('couples').select('*').eq('id', profile.couple_id).maybeSingle(),
      sb.rpc('partner_status'),
    ]);
    S.couple = couple;
    S.partner = partner || null;
  }
  const [ins, props, chk, tip] = await Promise.all([
    sb.from('insights').select('id', { count: 'exact', head: true }).eq('user_id', me),
    sb.from('proposals').select('*').eq('author_id', me).order('created_at', { ascending: false }),
    sb.from('checkins').select('*').eq('user_id', me).eq('day', today()).maybeSingle(),
    sb.from('daily_tips').select('content').eq('user_id', me).eq('day', today()).maybeSingle(),
  ]);
  S.myInsights = ins.count || 0;
  S.proposals = props.data || [];
  S.checkin = chk.data || null;
  S.tip = tip.data?.content || null;
  await loadGame();
  S.loaded = true;
  applyMood();
  maybeDraw();
  if (S.checkin) refreshTip(false);
}

async function loadGame() {
  if (!S.couple) { S.challenges = []; return; }
  const { data } = await sb.rpc('get_challenges');
  S.challenges = data || [];
}

// ogni settimana Selene scrive le missioni (appena entrambi hanno parlato con lei)
async function maybeDraw() {
  if (S.drawing || !S.partner || !meReady() || !partnerReady()) return;
  const have = S.challenges.filter(c => c.week_start === thisWeek()).length;
  if (have >= 2) return;
  S.drawing = true; if (route() === '/') render();
  try {
    const r = await selene('draw');
    S.drawBlocked = r?.ok ? null : r?.reason;
    await loadGame();
  } catch (e) { console.error(e); toast(seleneErr(e), true); }
  S.drawing = false;
  if (route() === '/') render();
}

async function refreshTip(force) {
  if (S.tipLoading) return;
  S.tipLoading = true; if (route() === '/') render();
  try { S.tip = await selene('today', { force }); applyMood(); }
  catch (e) { if (force || !S.tip) toast(seleneErr(e), true); }
  S.tipLoading = false;
  if (route() === '/') render();
}

function applyMood() {
  const tone = S.tip?.mood_color;
  for (const m of ['quiete', 'tenerezza', 'gioco', 'passione', 'cura']) document.body.classList.toggle('mood-' + m, tone === m);
}

async function refresh() { await loadAll(); render(); }

// ── router ───────────────────────────────────────────────────
const route = () => (location.hash.replace(/^#/, '') || '/').split('?')[0];
let lastRoute = null;

function render() {
  const cfg = getConfig();
  let html, tabs = false;
  const r = route();
  if (!cfg) html = viewSetup();
  else if (!S.session) html = viewAuth();
  else if (!S.loaded) html = `<div class="splash"><div class="orb lg"></div></div>`;
  else if (!S.couple) html = viewPair();
  else if (!store.get('pl_intro') || r === '/benvenuti') html = viewIntro();
  else {
    tabs = r !== '/checkin';
    html = ({
      '/': viewHome, '/checkin': viewCheckin, '/selene': viewSelene, '/ritratto': viewPortrait,
      '/proposte': viewProposals, '/diario': viewDiary, '/impostazioni': viewSettings,
    }[r] || viewHome)();
  }
  const anim = r !== lastRoute ? 'page-enter' : '';
  lastRoute = r;
  // l'intro è a tutto schermo: niente contenitore animato (sposterebbe il position: fixed)
  $app.innerHTML = html.trimStart().startsWith('<div class="intro"') ? html : `<div class="${anim}">${html}</div>`;
  $tabbar.hidden = !tabs;
  document.body.classList.toggle('no-tabs', !tabs);
  $tabbar.querySelectorAll('a').forEach(a => {
    const t = a.dataset.tab;
    a.classList.toggle('on', (t === 'home' && ['/', '/checkin'].includes(r)) || (t === 'selene' && r === '/ritratto') || r === '/' + t);
  });
  afterRender(r);
}

function afterRender(r) {
  if (r === '/selene') {
    if (S.chat === null) loadChat();
    document.getElementById('chatEnd')?.scrollIntoView({ block: 'end' });
    const ta = document.querySelector('.composer textarea');
    ta?.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(160, ta.scrollHeight) + 'px'; });
  }
  if (r === '/ritratto' && S.insights === null) loadInsights();
}

window.addEventListener('hashchange', () => { S.rerollFor = null; S.chatSeen = 0; render(); window.scrollTo(0, 0); });

// ── componenti ───────────────────────────────────────────────
function missionBody(ch, { forGiver } = {}) {
  const [emo, label] = CATS[ch.category] || CATS.romance;
  return `
    <div class="row wrap"><span class="chip">${emo} ${label}</span><span class="chip gold flames">${flames(ch.intensity)}</span>
      ${ch.proposal_body ? `<span class="chip rose">✉ ${ch.proposal_by_me ? 'Dalla tua proposta' : `Dalla proposta di ${esc(partnerName())}`}</span>` : ''}</div>
    <div class="mission-title">${esc(ch.title)}</div>
    <p class="mission-text">${esc(ch.body)}</p>
    ${forGiver && ch.why ? `<p class="why small">Selene: ${esc(ch.why)}</p>` : ''}`;
}

const opened = id => (store.get('pl_opened') || []).includes(id);
function markOpened(id) { const a = store.get('pl_opened') || []; a.push(id); store.set('pl_opened', a.slice(-60)); }

function envelope(id, label, sub) {
  return `
    <div class="center stack">
      <div class="envelope-wrap"><div class="envelope" data-act="openEnvelope" data-id="${id}" role="button" aria-label="Apri la busta">
        <div class="back"></div><div class="letter">♥</div><div class="front"></div><div class="flap"></div><div class="seal">✦</div>
      </div></div>
      <h3>${label}</h3>
      <p class="muted small">${sub}</p>
    </div>`;
}

function seleneLoader(text) {
  return `<div class="loader-orb"><div class="orb thinking"></div><p class="muted serif-i">${text}</p></div>`;
}

// ── viste: accesso ───────────────────────────────────────────
function viewSetup() {
  return `
  <div class="stack-lg stagger">
    <div class="center stack" style="margin-top:40px">
      <div class="orb lg" style="margin:0 auto"></div>
      <div class="brand">Pippi<b>Love</b></div>
      <p class="muted">Configurazione iniziale</p>
    </div>
    <form class="card stack" data-form="setup">
      <p class="small muted">Incolla l’indirizzo e la chiave “anon public” del progetto Supabase (Project Settings → API).</p>
      <label class="field"><span>Project URL</span><input type="url" name="url" placeholder="https://xxxx.supabase.co" required></label>
      <label class="field"><span>Chiave anon public</span><input type="text" name="key" required autocomplete="off"></label>
      <button class="btn block">Salva</button>
    </form>
  </div>`;
}

function viewAuth() {
  const signup = S.authTab === 'signup';
  return `
  <div class="stack-lg stagger">
    <div class="center stack" style="margin-top:28px">
      <div class="orb lg" style="margin:0 auto 6px"></div>
      <div class="brand">Pippi<b>Love</b></div>
      <p class="muted serif-i" style="font-size:18px">Uno spazio solo vostro.</p>
    </div>
    <div class="tabs2">
      <button data-act="authTab" data-v="login" class="${signup ? '' : 'on'}">Accedi</button>
      <button data-act="authTab" data-v="signup" class="${signup ? 'on' : ''}">Registrati</button>
    </div>
    <form class="card stack" data-form="${signup ? 'signup' : 'login'}">
      <label class="field"><span>Il tuo nome</span><input type="text" name="name" required autocomplete="username" autocapitalize="words"></label>
      <label class="field"><span>Password</span><input type="password" name="password" required minlength="6" autocomplete="${signup ? 'new-password' : 'current-password'}"></label>
      <button class="btn block">${signup ? 'Crea account' : 'Entra'}</button>
    </form>
    <p class="faint center">Ciò che racconti a Selene resta privato: l’altra persona non lo legge mai.</p>
  </div>`;
}

function viewPair() {
  return `
  <div class="stack-lg stagger">
    <div class="page-head">
      <div class="eyebrow">Ciao ${esc(myName())}</div>
      <h1>Collegatevi</h1>
      <p>Uno dei due crea la coppia, l’altra persona entra con il codice.</p>
    </div>
    <div class="card glow stack">
      <h3>Crea la coppia</h3>
      <p class="muted small">Riceverai un codice da dare a chi ami.</p>
      <button class="btn block" data-act="createCouple">Crea e mostra il codice</button>
    </div>
    <form class="card stack" data-form="join">
      <h3>Ho un codice</h3>
      <input type="text" name="code" placeholder="ES. 4AA65C" maxlength="6" autocapitalize="characters" style="text-transform:uppercase;letter-spacing:.2em;text-align:center;font-size:22px" required>
      <button class="btn ghost block">Entra nella coppia</button>
    </form>
    <button class="btn link block" data-act="logout">Esci</button>
  </div>`;
}

// ── intro immersiva (la prima volta) ─────────────────────────
function viewIntro() {
  const lines = [
    'Respira.',
    'Questo è uno spazio solo vostro.',
    'Qui puoi dire anche ciò che non hai mai detto.',
    'Selene ascolta, ricorda, e non giudica.',
    'Quello che le racconti resta tuo.',
    `Ogni settimana, una sorpresa per ${esc(partnerName() === 'il/la partner' ? 'chi ami' : partnerName())}.`,
  ];
  const step = 4.2;
  return `
  <div class="intro">
    <button class="btn link small skip" data-act="introDone">Salta</button>
    <div class="orb xl"></div>
    <div class="breath-cue"><span>inspira</span><span>espira</span></div>
    <div class="lines">
      ${lines.map((l, i) => `<p class="${i === lines.length - 1 ? 'last' : ''}" style="--t:${(0.8 + i * step).toFixed(1)}s;--d:${step + 0.4}s">${l}</p>`).join('')}
    </div>
    <button class="btn enter" style="--t:${(0.8 + lines.length * step - 1.5).toFixed(1)}s;min-width:220px" data-act="introDone">Entra</button>
  </div>`;
}

// ── vista: oggi ──────────────────────────────────────────────
function viewHome() {
  const w = thisWeek();
  const mine = S.challenges.find(c => c.week_start === w && c.giver_id === uid());
  const theirs = S.challenges.find(c => c.week_start === w && c.receiver_id === uid());
  const pn = esc(partnerName());
  const parts = [];

  parts.push(`
    <div class="page-head">
      <div class="eyebrow">${longToday()}</div>
      <h1>${greeting()}, ${esc(myName())}</h1>
    </div>`);

  if (!S.partner) {
    parts.push(`
      <div class="card glow stack">
        <div class="card-label">In attesa</div>
        <h2>Manca solo l’altra metà</h2>
        <p class="muted">Dai questo codice a chi ami: lo inserirà dopo essersi registrata/o.</p>
        <div class="code">${esc(S.couple.invite_code)}</div>
        <button class="btn ghost block" data-act="shareCode">Condividi il codice</button>
      </div>`);
  }

  // il check-in del giorno e la lettura di Selene
  if (!S.checkin) {
    parts.push(`
      <a class="card glow stack" href="#/checkin">
        <div class="row" style="gap:16px"><div class="orb"></div><div>
          <div class="card-label">Prima di tutto</div>
          <h2>Come stai, oggi?</h2>
        </div></div>
        <p class="muted">Raccontami la giornata: cosa è successo, che energia hai, cosa ti manca. Selene adatta tutto a come state davvero, oggi.</p>
      </a>`);
  } else if (S.tipLoading && !S.tip) {
    parts.push(`<div class="card">${seleneLoader('Selene sta leggendo la vostra giornata…')}</div>`);
  } else if (S.tip) {
    const t = S.tip;
    parts.push(`
      <div class="card glow stack">
        <div class="row" style="gap:14px"><div class="orb ${S.tipLoading ? 'thinking' : ''}" style="--s:46px"></div><div style="flex:1">
          <div class="card-label">Selene, per oggi</div>
          <h3>${esc(t.headline)}</h3>
        </div></div>
        <p class="why">${esc(t.reading)}</p>
        <div class="tip-line"><div class="k">♥</div><div class="v"><div class="lbl">Un gesto per ${pn}</div>${esc(t.gesture)}</div></div>
        ${t.mission_tip ? `<div class="tip-line"><div class="k">✦</div><div class="v"><div class="lbl">La tua missione, oggi</div>${esc(t.mission_tip)}</div></div>` : ''}
        <div class="tip-line"><div class="k">☾</div><div class="v"><div class="lbl">Per te</div>${esc(t.self_care)}</div></div>
        <div class="tip-line"><div class="k">?</div><div class="v"><div class="lbl">Stasera chiedi</div>${esc(t.question)}</div></div>
        <div class="row"><a class="btn ghost small" href="#/checkin">È cambiato qualcosa?</a><span class="spacer"></span><button class="btn link small" data-act="newTip">Un’altra idea</button></div>
      </div>`);
  } else {
    parts.push(`<div class="card stack"><div class="card-label">Check-in fatto ✓</div><p class="muted small">Selene non è raggiungibile in questo momento.</p><button class="btn ghost small" data-act="newTip">Riprova</button></div>`);
  }

  // il colloquio con Selene sblocca il gioco
  if (!meReady()) {
    const pct = Math.round((S.myInsights / MIN_INSIGHTS) * 100);
    parts.push(`
      <a class="card stack" href="#/selene">
        <div class="card-label">Per iniziare il gioco</div>
        <h2>${S.myInsights ? 'Continua a raccontarti' : 'Conosci Selene'}</h2>
        <p class="muted">Un colloquio privato, come da una sessuologa: domande vere, una alla volta, sulla tua sessualità. Da lì nasceranno le missioni.</p>
        <div class="progress"><i style="width:${Math.min(100, pct)}%"></i></div>
        <span class="btn block">${S.myInsights ? 'Riprendi il colloquio' : 'Inizia il colloquio'}</span>
      </a>`);
  } else if (S.partner && !partnerReady()) {
    parts.push(`
      <div class="card stack">
        <div class="card-label">Quasi pronti</div>
        <h2>Aspettiamo ${pn}</h2>
        <p class="muted">Le missioni partono quando anche ${pn} avrà parlato un po’ con Selene. Intanto puoi continuare il tuo colloquio: più Selene ti conosce, più le missioni saranno tue.</p>
        <a class="btn ghost block" href="#/selene">Parla con Selene</a>
      </div>`);
  }

  if (S.drawing && (!mine || !theirs)) {
    parts.push(`<div class="card">${seleneLoader('Selene sta scrivendo le missioni di questa settimana…')}</div>`);
  }

  if (mine) {
    if (mine.status === 'pending' && !opened(mine.id + ':g' + mine.rerolls)) {
      parts.push(`<div class="card glow">${envelope(mine.id + ':g' + mine.rerolls, `La tua missione per ${pn}`, 'Tocca la busta per aprirla')}</div>`);
    } else if (mine.status === 'pending') {
      const rr = S.rerollFor === mine.id;
      parts.push(`
        <div class="card glow stack reveal">
          <div class="card-label">La tua missione per ${pn} · ancora ${daysLeft()} ${daysLeft() === 1 ? 'giorno' : 'giorni'}</div>
          ${missionBody(mine, { forGiver: true })}
          ${rr ? `
            <form class="stack" data-form="reroll" data-id="${mine.id}">
              <textarea name="reason" style="min-height:80px" placeholder="Cosa non va? Es. “è un mio desiderio, non suo”, “l’abbiamo già fatto”, “non me la sento”…"></textarea>
              <div class="row"><button type="button" class="btn ghost" data-act="cancelReroll">Annulla</button><button class="btn" style="flex:1">Chiedine un’altra</button></div>
            </form>` : `
            <button class="btn block" data-act="done" data-id="${mine.id}">L’ho fatto ♥</button>
            ${mine.rerolls < MAX_REROLLS ? `<button class="btn link block" data-act="reroll" data-id="${mine.id}">Non va bene · cambiala (${MAX_REROLLS - mine.rerolls})</button>` : `<p class="faint center">Hai già cambiato missione ${MAX_REROLLS} volte questa settimana</p>`}`}
        </div>`);
    } else {
      parts.push(`
        <div class="card stack">
          <div class="card-label">Missione compiuta ✓</div>
          ${missionBody(mine)}
          ${mine.rating ? `<p class="small">${pn} ha dato ${stars(mine.rating)}${mine.feedback ? ` · “${esc(mine.feedback)}”` : ''}</p>` : `<p class="faint">${pn} non l’ha ancora votata.</p>`}
        </div>`);
    }
  }

  if (theirs) {
    if (theirs.hidden) {
      parts.push(`
        <div class="card stack center">
          <div class="lock-ico beat">💌</div>
          <h3>${pn} ha una missione per te</h3>
          <p class="muted small">È una sorpresa. La scoprirai quando l’avrà fatta.</p>
        </div>`);
    } else if (!opened(theirs.id + ':r')) {
      parts.push(`<div class="card glow">${envelope(theirs.id + ':r', `${pn} ha compiuto la sua missione per te`, 'Apri la busta e scopri cos’era')}</div>`);
    } else {
      parts.push(`
        <div class="card glow stack reveal">
          <div class="card-label">Cosa ha fatto ${pn} per te</div>
          ${missionBody(theirs)}
          ${theirs.rating ? `<p class="small">Il tuo voto: ${stars(theirs.rating)}</p>` : `
            <form class="stack" data-form="rate" data-id="${theirs.id}">
              <p>Com’è stato?</p>
              <div class="stars" data-stars>${[1, 2, 3, 4, 5].map(n => `<button type="button" data-act="star" data-v="${n}">★</button>`).join('')}</div>
              <input type="hidden" name="rating">
              <textarea name="feedback" placeholder="Un pensiero per ${pn} (lo leggerà anche Selene)" style="min-height:80px"></textarea>
              <button class="btn block">Invia</button>
            </form>`}
        </div>`);
    }
  }

  return `<div class="stack stagger">${parts.join('')}</div>`;
}

// ── vista: check-in a passi ──────────────────────────────────
const CHECK = [
  { k: 'mood', q: 'Umore', icons: ['😞', '😕', '😐', '🙂', '😄'], cap: ['giù', 'alle stelle'] },
  { k: 'energy', q: 'Energia', icons: ['🪫', '🥱', '🙂', '💪', '⚡'], cap: ['a terra', 'piena'] },
  { k: 'stress', q: 'Stress', icons: ['🌿', '🙂', '😬', '😣', '🌋'], cap: ['zero', 'tantissimo'] },
  { k: 'desire', q: 'Voglia di intimità', icons: ['❄️', '🌙', '✨', '💗', '🔥'], cap: ['nessuna', 'tanta'] },
];
const TIME = ['Niente', 'Un po’', 'Tutta la sera'];

function viewCheckin() {
  if (!S.checkinDraft) { S.checkinDraft = { ...(S.checkin || {}) }; S.ckStep = 0; S.ckDir = 'in'; }
  const d = S.checkinDraft;
  const pn = esc(partnerName());
  const step = S.ckStep;
  let body;
  if (step === 0) {
    body = `
      <div class="center" style="padding:10px 0 4px"><div class="orb lg" style="margin:0 auto"></div></div>
      <h1 class="center">Come stai, davvero?</h1>
      <p class="muted center">Raccontami la giornata come la racconteresti a un’amica: cosa è successo, cosa ti porti addosso, cosa ti ha fatto bene.</p>
      <textarea class="big" id="ckNote" placeholder="Oggi…">${esc(d.note || '')}</textarea>
      <button class="btn block" data-act="ckNext">Avanti</button>`;
  } else if (step === 1) {
    body = `
      <h1>E dentro?</h1>
      <p class="muted">Quattro tocchi, d’istinto.</p>
      ${CHECK.map(c => `
        <div class="card stack">
          <h3 style="font-size:17px">${c.q}</h3>
          <div class="scale5">${c.icons.map((ic, i) => `<button type="button" class="${d[c.k] === i + 1 ? 'on' : ''}" data-act="ck" data-k="${c.k}" data-v="${i + 1}">${ic}</button>`).join('')}</div>
          <div class="scale-cap"><span>${c.cap[0]}</span><span>${c.cap[1]}</span></div>
        </div>`).join('')}
      <button class="btn block" data-act="ckNext">Avanti</button>`;
  } else {
    body = `
      <h1>Stasera</h1>
      <div class="card stack">
        <h3 style="font-size:17px">Quanto tempo avete per voi?</h3>
        <div class="opts">${TIME.map(t => `<button type="button" class="opt ${d.time_tonight === t ? 'on' : ''}" data-act="ckTime" data-v="${esc(t)}">${t}</button>`).join('')}</div>
      </div>
      <div class="card stack">
        <h3 style="font-size:17px">C’è qualcosa che vorresti da ${pn} oggi?</h3>
        <p class="faint">Selene lo trasformerà in un suggerimento per ${pn}, senza mai riportare le tue parole.</p>
        <textarea id="ckWish" placeholder="Un abbraccio lungo, silenzio, essere sedotta/o, ridere insieme…">${esc(d.wish || '')}</textarea>
      </div>
      <button class="btn block" data-act="saveCheckin">Affida la giornata a Selene</button>`;
  }
  return `
  <div class="stack">
    <div class="row">
      ${step ? `<button class="btn link small" data-act="ckBack">‹ Indietro</button>` : `<a href="#/" class="btn link small">✕ Chiudi</a>`}
      <span class="spacer"></span><span class="faint">${longToday()}</span>
    </div>
    <div class="steps">${[0, 1, 2].map(i => `<i class="${i <= step ? 'on' : ''}"></i>`).join('')}</div>
    <div class="stack ${S.ckDir === 'back' ? 'step-back' : 'step-in'}">${body}</div>
  </div>`;
}

function grabCheckinText() {
  const n = document.getElementById('ckNote'); if (n) S.checkinDraft.note = n.value;
  const w = document.getElementById('ckWish'); if (w) S.checkinDraft.wish = w.value;
}

// ── vista: Selene ────────────────────────────────────────────
async function loadChat() {
  const owner = uid();
  S.chat = []; S.chatOwner = owner;
  const { data } = await sb.from('interview_messages').select('role,content,created_at').eq('user_id', owner).order('id').limit(300);
  if (uid() !== owner) return;
  S.chat = data || [];
  render();
  sendToSelene(''); // Selene riprende il filo, o se è passato del tempo ti scrive lei per prima
}

function wordsAnimated(text) {
  let i = 0;
  return esc(text).split(/(\s+)/).map(tok => /^\s+$/.test(tok) ? tok : `<span class="w" style="animation-delay:${Math.min(i++ * 45, 6000)}ms">${tok}</span>`).join('');
}

const KIND_LABEL = () => ({ receive: `${esc(partnerName())} per te`, give: `Tu per ${esc(partnerName())}`, together: 'Insieme' });

function chatExtras() {
  const x = S.chatExtras;
  if (!x || S.chatBusy) return '';
  const chips = (x.suggestions || []).map(t => `<button type="button" class="chip-btn" data-act="chipSend" data-v="${esc(t)}">${esc(t)}</button>`).join('');
  const idea = x.idea ? `
    <div class="idea-card">
      <div class="card-label">✦ Idea di Selene · ${KIND_LABEL()[x.idea.kind]}</div>
      <p class="serif-i">“${esc(x.idea.text)}”</p>
      ${x.idea.saved ? `<div class="row"><p class="faint" style="flex:1">Nella busta segreta ✓</p><button class="btn link small" data-act="unsaveIdea">Togli dalla busta</button></div>` : `<button class="btn small" data-act="saveIdea">Metti nella busta segreta ✉</button>`}
    </div>` : '';
  return idea + (chips ? `<div class="chips">${chips}</div>` : '');
}

function viewSelene() {
  const msgs = S.chat || [];
  const lastIdx = msgs.length - 1;
  queueMicrotask(() => { S.chatSeen = msgs.length; });
  return `
  <div class="chat-page">
    <div class="chat-head row" style="gap:14px">
      <div class="orb ${S.chatBusy ? 'thinking' : ''}"></div>
      <div style="flex:1">
        <h2>Selene</h2>
        <p class="faint">In privato con ${esc(myName())}${S.chatProgress != null ? ` · ${S.chatProgress}%` : ''}</p>
      </div>
      <a class="btn ghost small" href="#/ritratto">Il tuo ritratto</a>
    </div>
    <div class="chat">
      ${msgs.map((m, i) => `<div class="bubble ${m.role === 'user' ? 'me' : 'sel'}${i < S.chatSeen ? ' still' : ''}">${m.role === 'assistant' && i === lastIdx && m.fresh && i >= S.chatSeen ? wordsAnimated(m.content) : esc(m.content)}</div>${m.learned ? `<div class="learned">✦ Selene ha preso nota</div>` : ''}`).join('')}
      ${S.chatBusy ? `<div class="bubble sel typing"><i></i><i></i><i></i></div>` : ''}
      ${chatExtras()}
      ${!S.chatBusy && !S.checkin && msgs.length ? `<a class="checkin-nudge" href="#/checkin">☾ Non hai ancora raccontato com’è andata oggi · <b>fai il check-in</b></a>` : ''}
      ${msgs.length > 2 ? '' : `<p class="faint center" style="margin-top:6px">Puoi dire “questo tienilo per te”: Selene non lo userà nelle missioni.</p>`}
      <div id="chatEnd"></div>
    </div>
    <form class="composer" data-form="chat">
      <textarea name="msg" rows="1" placeholder="Rispondi a Selene…" ${S.chatBusy ? 'disabled' : ''}></textarea>
      <button class="btn" aria-label="Invia" ${S.chatBusy ? 'disabled' : ''}>➤</button>
    </form>
  </div>`;
}

async function sendToSelene(text) {
  const owner = uid();
  if (text) S.chat.push({ role: 'user', content: text });
  S.chatBusy = true; S.chatExtras = text ? null : S.chatExtras; render();
  try {
    const r = await selene('interview', { message: text });
    if (uid() !== owner) return; // nel frattempo è cambiato account
    if (!r.resumed) {
      if (text && r.learned) S.chat[S.chat.length - 1].learned = true;
      S.chat.push({ role: 'assistant', content: r.reply, fresh: true });
      S.chatExtras = { suggestions: r.suggestions || [], idea: r.idea || null };
      haptic(8);
    } else if (!S.chatExtras) {
      S.chatExtras = { suggestions: ['Dammi un’idea per stasera', 'Ti racconto com’è andata oggi', 'Facciamo un gioco'], idea: null };
    }
    if (r.progress != null) S.chatProgress = r.progress;
    if (r.learned) {
      const before = S.myInsights;
      S.myInsights += r.learned;
      S.insights = null;
      if (before < MIN_INSIGHTS && S.myInsights >= MIN_INSIGHTS) setTimeout(() => toast('Selene ti conosce abbastanza per la prima missione ✦'), 1800);
    }
  } catch (e) {
    toast(seleneErr(e), true);
    if (text) { S.chat.pop(); S.chatRestore = text; }
  }
  S.chatBusy = false;
  if (route() === '/selene') {
    render();
    if (S.chatRestore) { const ta = document.querySelector('.composer textarea'); if (ta) ta.value = S.chatRestore; S.chatRestore = null; }
  }
}

// ── vista: il tuo ritratto (la memoria di Selene) ────────────
const TOPIC_LABEL = {
  desiderio: 'Desiderio', acceleratori: 'Cosa ti accende', freni: 'Cosa ti spegne', corpo: 'Corpo', fantasie: 'Fantasie',
  limiti: 'Limiti', comunicazione: 'Comunicazione', emozioni: 'Emozioni', storia: 'Storia', contesto: 'Contesto',
  coppia: 'Coppia', preferenze: 'Preferenze',
};

async function loadInsights() {
  S.insights = [];
  const { data } = await sb.from('insights').select('*').eq('user_id', uid()).order('id', { ascending: false });
  S.insights = data || [];
  S.myInsights = S.insights.length;
  if (route() === '/ritratto') render();
}

function viewPortrait() {
  const ins = S.insights || [];
  const groups = {};
  for (const i of ins) (groups[i.topic] ||= []).push(i);
  const order = Object.keys(TOPIC_LABEL).filter(k => groups[k]);
  return `
  <div class="stack-lg stagger">
    <div class="row"><a href="#/selene" class="btn link small">‹ Selene</a></div>
    <div class="page-head">
      <div class="eyebrow">Solo per te</div>
      <h1>Il tuo ritratto</h1>
      <p>Quello che Selene ha capito di te. Lo vedi solo tu. Spegni l’interruttore per non farlo usare nelle missioni, o cancellalo.</p>
    </div>
    ${ins.length ? order.map(k => `
      <div class="stack">
        <h3>${TOPIC_LABEL[k]}</h3>
        <div class="list">${groups[k].map(i => `
          <div class="item">
            <div class="body small">${esc(i.note)}</div>
            <button class="toggle ${i.shareable ? 'on' : ''}" data-act="insShare" data-id="${i.id}" aria-label="Usa nelle missioni"></button>
            <button class="btn link small" data-act="insDel" data-id="${i.id}" aria-label="Elimina">✕</button>
          </div>`).join('')}</div>
      </div>`).join('') : `<div class="card center stack"><div class="orb" style="margin:0 auto"></div><p class="muted">Ancora nessun appunto. Parla con Selene.</p><a class="btn block" href="#/selene">Inizia il colloquio</a></div>`}
    <button class="btn link block" data-act="resetChat">Ricomincia il colloquio da capo</button>
  </div>`;
}

// ── proposte ─────────────────────────────────────────────────
function viewProposals() {
  const pn = esc(partnerName());
  const secret = S.partner?.secret_proposals || 0;
  const kindLabel = { receive: 'Per me', give: `Per ${pn}`, together: 'Insieme' };
  const list = S.proposals.map(p => `
    <div class="item">
      <div class="ico">${p.kind === 'receive' ? '🎁' : p.kind === 'give' ? '💝' : '🫶'}</div>
      <div class="body">
        <div>${esc(p.body)}</div>
        <div class="row wrap" style="margin-top:6px"><span class="chip">${kindLabel[p.kind]}</span><span class="chip gold flames">${flames(p.intensity)}</span></div>
      </div>
      <button class="btn ghost small del" data-act="delProposal" data-id="${p.id}">Elimina</button>
    </div>`).join('');

  return `
  <div class="stack-lg stagger">
    <div class="page-head">
      <div class="eyebrow">La busta segreta</div>
      <h1>Sai già cosa vorresti?</h1>
      <p>Scrivilo con parole tue. Resta segreto: Selene ci costruirà una missione e ${pn} lo scoprirà al momento giusto.</p>
    </div>
    <form class="card glow stack" data-form="proposal">
      <textarea name="body" required minlength="3" maxlength="500" placeholder="Es. Vorrei che mi svegliassi con la colazione a letto e poi…"></textarea>
      <div>
        <p class="small muted" style="margin-bottom:8px">Chi lo fa?</p>
        <div class="seg" style="--n:3">
          <button type="button" class="on" data-act="pick" data-name="kind" data-v="receive">${pn} per me</button>
          <button type="button" data-act="pick" data-name="kind" data-v="give">Io per ${pn}</button>
          <button type="button" data-act="pick" data-name="kind" data-v="together">Insieme</button>
        </div>
        <input type="hidden" name="kind" value="receive">
      </div>
      <div>
        <p class="small muted" style="margin-bottom:8px">Intensità</p>
        <div class="seg" style="--n:3">
          ${LEVELS.map((l, i) => `<button type="button" class="${i === 0 ? 'on' : ''}" data-act="pick" data-name="intensity" data-v="${i + 1}">${flames(i + 1)} ${l}</button>`).join('')}
        </div>
        <input type="hidden" name="intensity" value="1">
      </div>
      <button class="btn block">Metti nella busta ✉</button>
    </form>
    ${secret ? `<div class="item"><div class="ico beat">💌</div><div class="body"><div class="title">${pn} ha ${secret} ${secret === 1 ? 'proposta segreta' : 'proposte segrete'}</div><div class="faint">Le scoprirai quando diventeranno missioni.</div></div></div>` : ''}
    <div class="stack">
      <div class="row"><h3 style="flex:1">Le tue (${S.proposals.length})</h3>${S.proposals.length > 1 ? `<button class="btn link small" data-act="delAllProposals">Svuota la busta</button>` : ''}</div>
      <p class="faint">Ci sono anche le idee che hai salvato dalla chat con Selene. Elimina quelle che non ti rappresentano.</p>
      ${list || '<p class="faint">Nessuna proposta, per ora.</p>'}
    </div>
  </div>`;
}

// ── diario ───────────────────────────────────────────────────
function viewDiary() {
  const pn = esc(partnerName());
  const weeks = {};
  for (const c of S.challenges) (weeks[c.week_start] ||= []).push(c);
  const keys = Object.keys(weeks).sort().reverse();
  const done = S.challenges.filter(c => c.status === 'done');
  const rated = done.filter(c => c.rating);
  const avg = rated.length ? (rated.reduce((s, c) => s + c.rating, 0) / rated.length).toFixed(1) : '—';
  const line = (c) => {
    const mineC = c.giver_id === uid();
    const who = mineC ? `Tu per ${pn}` : `${pn} per te`;
    const title = c.hidden ? 'Sorpresa in corso…' : c.title;
    const state = c.status === 'done' ? (c.rating ? stars(c.rating) : '✓') : 'in corso';
    return `<div class="item"><div class="ico">${mineC ? '💝' : '🎁'}</div><div class="body"><div class="faint">${who}</div><div class="title">${esc(title)}</div>${c.feedback && !c.hidden ? `<div class="small muted">“${esc(c.feedback)}”</div>` : ''}</div><div class="small">${state}</div></div>`;
  };
  return `
  <div class="stack-lg stagger">
    <div class="page-head"><div class="eyebrow">Noi due</div><h1>Il vostro diario</h1></div>
    <div class="row">
      <div class="card" style="flex:1;text-align:center"><div class="mission-title" style="margin:0">${done.length}</div><div class="faint">missioni fatte</div></div>
      <div class="card" style="flex:1;text-align:center"><div class="mission-title" style="margin:0">${avg}</div><div class="faint">voto medio</div></div>
    </div>
    ${keys.length ? keys.map(k => `<div class="stack"><h3>Settimana dal ${fmtDay(k)}</h3><div class="list">${weeks[k].map(line).join('')}</div></div>`).join('')
      : '<p class="faint center">Il diario si riempirà con le vostre missioni.</p>'}
  </div>`;
}

// ── impostazioni ─────────────────────────────────────────────
function viewSettings() {
  const cfg = getConfig();
  return `
  <div class="stack-lg stagger">
    <div class="page-head"><div class="eyebrow">Altro</div><h1>Impostazioni</h1></div>
    <form class="card stack" data-form="name">
      <label class="field"><span>Il tuo nome</span><input type="text" name="name" value="${esc(S.profile?.display_name || '')}" required></label>
      <button class="btn ghost block">Salva nome</button>
    </form>
    <form class="card stack" data-form="safeword">
      <label class="field"><span>La vostra parola di sicurezza</span><input type="text" name="safe" value="${esc(S.couple?.safe_word || '')}" placeholder="Es. ananas"></label>
      <p class="faint">Detta in qualsiasi momento, si ferma tutto. Senza domande.</p>
      <button class="btn ghost block">Salva</button>
    </form>
    <div class="card stack">
      <h3>Come funziona</h3>
      <ul class="rules">
        <li>Selene fa a ciascuno un colloquio privato, come una sessuologa, e prende appunti che vedi solo tu.</li>
        <li>Ogni giorno, col check-in, legge come state e adatta consigli e tempi.</li>
        <li>Ogni lunedì scrive una missione a testa: una cosa da fare per l’altra persona, pensata su ciò che la accende.</li>
        <li>Chi riceve non sa cosa l’aspetta: lo scopre a missione fatta, e la vota.</li>
        <li>Se una missione non ti va, cambiala (fino a 5 volte a settimana). Il consenso vale sempre.</li>
      </ul>
    </div>
    <div class="card stack">
      <a class="btn ghost block" href="#/ritratto">Il tuo ritratto</a>
      <button class="btn ghost block" data-act="replayIntro">Rivedi l’introduzione</button>
      ${S.partner ? '' : `<p class="small muted">Codice coppia: <b style="color:var(--gold)">${esc(S.couple?.invite_code)}</b></p>`}
    </div>
    <form class="card stack danger" data-form="resetAll">
      <h3>Ricomincia da zero con Selene</h3>
      <p class="faint">Cancella la tua conversazione con Selene, il tuo ritratto e i consigli del giorno. Selene ti conoscerà di nuovo dall’inizio. I dati di ${esc(partnerName())} non vengono toccati.</p>
      <label class="check"><input type="checkbox" name="proposals"> Svuota anche la mia busta segreta</label>
      <label class="check"><input type="checkbox" name="checkins"> Cancella anche i miei check-in</label>
      <label class="check"><input type="checkbox" name="missions"> Togli le missioni di questa settimana non ancora fatte (anche quella di ${esc(partnerName())})</label>
      <button class="btn ghost block">Ricomincia da zero</button>
    </form>
    <button class="btn link block" data-act="logout">Esci dall’account</button>
    ${cfg && !cfg.fromFile ? `<button class="btn link block" data-act="resetConfig">Cambia configurazione Supabase</button>` : ''}
  </div>`;
}

// ── azioni ───────────────────────────────────────────────────
const actions = {
  authTab: el => { S.authTab = el.dataset.v; render(); },
  chipSend: el => { if (!S.chatBusy) { haptic(6); sendToSelene(el.dataset.v); } },
  unsaveIdea: el => run(async () => {
    const idea = S.chatExtras?.idea;
    if (!idea?.saved) return;
    const { error } = await sb.from('proposals').delete().eq('id', idea.saved);
    if (error) throw error;
    S.proposals = S.proposals.filter(p => p.id !== idea.saved);
    idea.saved = false;
    toast('Tolta dalla busta');
    render();
  }, el),
  saveIdea: el => run(async () => {
    const idea = S.chatExtras?.idea;
    if (!idea || idea.saved) return;
    const row = { couple_id: S.couple.id, author_id: uid(), kind: idea.kind, body: idea.text.slice(0, 500), intensity: idea.intensity || 1 };
    const { data, error } = await sb.from('proposals').insert(row).select().single();
    if (error) throw error;
    S.proposals.unshift(data);
    idea.saved = data.id;
    const r = el.getBoundingClientRect();
    burst(r.left + r.width / 2, r.top);
    toast('Nella busta segreta ✉');
    render();
  }, el),
  logout: async () => { await sb.auth.signOut(); },
  resetConfig: () => { localStorage.removeItem('pippilove_config'); location.reload(); },

  introDone: () => {
    store.set('pl_intro', true);
    burst(innerWidth / 2, innerHeight / 2.4);
    if (location.hash === '#/benvenuti' || !meReady()) location.hash = meReady() ? '#/' : '#/selene';
    else render();
  },
  replayIntro: () => { location.hash = '#/benvenuti'; },

  createCouple: el => run(async () => {
    const { error } = await sb.rpc('create_couple');
    if (error) throw error;
    await refresh();
  }, el),

  shareCode: async () => {
    const text = `Entra in PippiLove con il codice ${S.couple.invite_code} ❤️ ${location.origin + location.pathname}`;
    if (navigator.share) { try { await navigator.share({ text }); } catch {} }
    else { await navigator.clipboard?.writeText(text); toast('Codice copiato'); }
  },

  openEnvelope: el => {
    if (el.classList.contains('open')) return;
    el.classList.add('open');
    haptic(12);
    const r = el.getBoundingClientRect();
    setTimeout(() => burst(r.left + r.width / 2, r.top + r.height / 3), 600);
    setTimeout(() => { markOpened(el.dataset.id); render(); }, 1400);
  },

  ckNext: () => {
    grabCheckinText();
    const d = S.checkinDraft;
    if (S.ckStep === 1 && (!d.mood || !d.energy || !d.stress || !d.desire)) { toast('Tocca un’icona per ognuna delle quattro'); return; }
    S.ckStep = Math.min(2, S.ckStep + 1); S.ckDir = 'in'; render(); window.scrollTo(0, 0);
  },
  ckBack: () => { grabCheckinText(); S.ckStep = Math.max(0, S.ckStep - 1); S.ckDir = 'back'; render(); },
  ck: el => {
    S.checkinDraft[el.dataset.k] = Number(el.dataset.v);
    el.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === el));
    haptic(8);
  },
  ckTime: el => {
    S.checkinDraft.time_tonight = el.dataset.v;
    el.parentElement.querySelectorAll('.opt').forEach(b => b.classList.toggle('on', b === el));
  },
  saveCheckin: el => run(async () => {
    grabCheckinText();
    const d = S.checkinDraft;
    const row = {
      user_id: uid(), day: today(), mood: d.mood, energy: d.energy, stress: d.stress, desire: d.desire,
      time_tonight: d.time_tonight || null,
      note: (d.note || '').trim() || null,
      wish: (d.wish || '').trim() || null,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await sb.from('checkins').upsert(row).select().single();
    if (error) throw error;
    S.checkin = data; S.checkinDraft = null;
    location.hash = '#/';
    refreshTip(false);
  }, el),
  newTip: () => refreshTip(true),

  pick: el => {
    const form = el.closest('form');
    form.querySelector(`input[name="${el.dataset.name}"]`).value = el.dataset.v;
    el.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === el));
  },
  star: el => {
    const v = Number(el.dataset.v);
    const form = el.closest('form');
    form.querySelector('input[name=rating]').value = v;
    form.querySelectorAll('[data-stars] button').forEach(b => b.classList.toggle('on', Number(b.dataset.v) <= v));
    haptic(6);
  },

  done: el => run(async () => {
    if (!confirm('Missione fatta? ' + partnerName() + ' potrà scoprirla e votarla.')) return;
    const { error } = await sb.rpc('complete_challenge', { p_id: el.dataset.id });
    if (error) throw error;
    const r = el.getBoundingClientRect();
    burst(r.left + r.width / 2, r.top);
    toast('Bravo/a ♥');
    await loadGame(); render();
  }, el),
  reroll: el => { S.rerollFor = el.dataset.id; render(); },
  cancelReroll: () => { S.rerollFor = null; render(); },

  delAllProposals: el => run(async () => {
    if (!confirm('Svuotare tutta la tua busta segreta?')) return;
    const { error } = await sb.from('proposals').delete().eq('author_id', uid());
    if (error) throw error;
    S.proposals = [];
    render();
  }, el),
  delProposal: el => run(async () => {
    if (!confirm('Eliminare questa proposta?')) return;
    const { error } = await sb.from('proposals').delete().eq('id', el.dataset.id);
    if (error) throw error;
    S.proposals = S.proposals.filter(p => p.id !== el.dataset.id);
    render();
  }, el),

  insShare: el => run(async () => {
    const ins = S.insights.find(i => String(i.id) === el.dataset.id);
    const { error } = await sb.from('insights').update({ shareable: !ins.shareable }).eq('id', ins.id);
    if (error) throw error;
    ins.shareable = !ins.shareable;
    el.classList.toggle('on', ins.shareable);
  }, el),
  insDel: el => run(async () => {
    if (!confirm('Cancellare questo appunto? Selene lo dimenticherà.')) return;
    const { error } = await sb.from('insights').delete().eq('id', el.dataset.id);
    if (error) throw error;
    S.insights = S.insights.filter(i => String(i.id) !== el.dataset.id);
    S.myInsights = S.insights.length;
    render();
  }, el),
  resetChat: el => run(async () => {
    if (!confirm('Cancellare la conversazione con Selene? Gli appunti del tuo ritratto restano finché non li elimini.')) return;
    await selene('interview_reset');
    S.chat = null; S.chatProgress = null;
    location.hash = '#/selene';
  }, el),
};

const forms = {
  resetAll: async f => {
    if (!confirm('Sei sicuro? Selene dimenticherà tutto quello che le hai raccontato. Non si può annullare.')) return;
    await selene('reset_all', { options: { proposals: f.proposals.checked, checkins: f.checkins.checked, missions: f.missions.checked } });
    Object.assign(S, { chat: null, chatExtras: null, chatProgress: null, insights: null, tip: null });
    await loadAll();
    toast('Fatto: si riparte da zero ♥');
    location.hash = '#/selene';
    render();
  },
  setup: async f => {
    store.set('pippilove_config', { url: cleanUrl(f.url.value), key: f.key.value.trim() });
    location.reload();
  },
  login: async f => {
    const { error } = await sb.auth.signInWithPassword({ email: nameToEmail(f.name.value), password: f.password.value });
    if (error) throw error;
  },
  signup: async f => {
    const { data, error } = await sb.auth.signUp({
      email: nameToEmail(f.name.value), password: f.password.value,
      options: { data: { name: f.name.value.trim() } },
    });
    if (error) throw error;
    if (!data.session) toast('Su Supabase va spenta la conferma email (vedi README)', true);
  },
  join: async f => {
    const { error } = await sb.rpc('join_couple', { p_code: f.code.value.trim() });
    if (error) throw error;
    toast('Siete collegati ♥');
    burst(innerWidth / 2, innerHeight / 3);
    await refresh();
  },
  chat: async f => {
    const text = f.msg.value.trim();
    if (!text || S.chatBusy) return;
    f.msg.value = '';
    await sendToSelene(text);
  },
  reroll: async (f, form) => {
    const id = form.dataset.id;
    S.rerollFor = null; S.drawing = true; render();
    try {
      await selene('reroll', { challenge_id: id, reason: f.reason.value });
      await loadGame();
    } catch (e) { toast(seleneErr(e), true); }
    finally { S.drawing = false; render(); }
  },
  proposal: async f => {
    const row = { couple_id: S.couple.id, author_id: uid(), kind: f.kind.value, body: f.body.value.trim(), intensity: Number(f.intensity.value) };
    const { data, error } = await sb.from('proposals').insert(row).select().single();
    if (error) throw error;
    S.proposals.unshift(data);
    toast('Nella busta segreta ✉');
    render();
  },
  rate: async (f, form) => {
    const rating = Number(f.rating.value);
    if (!rating) { toast('Scegli da 1 a 5 stelle'); return; }
    const { error } = await sb.rpc('rate_challenge', { p_id: form.dataset.id, p_rating: rating, p_feedback: f.feedback.value });
    if (error) throw error;
    toast('Grazie ♥');
    await loadGame(); render();
  },
  name: async f => {
    const name = f.name.value.trim();
    const { error } = await sb.from('profiles').update({ display_name: name }).eq('id', uid());
    if (error) throw error;
    S.profile.display_name = name;
    toast('Salvato');
  },
  safeword: async f => {
    const { error } = await sb.from('couples').update({ safe_word: f.safe.value.trim() || null }).eq('id', S.couple.id);
    if (error) throw error;
    S.couple.safe_word = f.safe.value.trim();
    toast('Salvata');
  },
};

$app.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || !actions[el.dataset.act]) return;
  if (el.tagName === 'BUTTON' || el.classList.contains('envelope')) e.preventDefault();
  actions[el.dataset.act](el, e);
});
$app.addEventListener('submit', e => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const btn = form.querySelector('button:not([type=button])');
  run(() => forms[form.dataset.form](form.elements, form), btn);
});
$app.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && e.target.matches('.composer textarea') && matchMedia('(hover: hover)').matches) {
    e.preventDefault(); e.target.form.requestSubmit();
  }
});

// ── avvio ────────────────────────────────────────────────────
async function boot() {
  startSparks();
  const cfg = getConfig();
  if (!cfg) { render(); return; }
  sb = createClient(cfg.url, cfg.key, { auth: { persistSession: true, autoRefreshToken: true } });
  const { data } = await sb.auth.getSession();
  S.session = data.session;
  if (S.session) await run(loadAll);
  render();
  sb.auth.onAuthStateChange(async (event, session) => {
    if (event === 'TOKEN_REFRESHED') { S.session = session; return; }
    if (event === 'INITIAL_SESSION') return;
    const changed = session?.user?.id !== S.session?.user?.id;
    S.session = session;
    if (!changed) return;
    // nuovo account (anche sullo stesso telefono): si riparte da zero, nulla dell'altra persona resta in memoria
    Object.assign(S, freshState(), { session, authTab: S.authTab });
    applyMood();
    render();
    if (session) await run(loadAll);
    render();
  });
  document.addEventListener('visibilitychange', () => {
    const r = route();
    if (document.visibilityState === 'visible' && S.session && S.loaded && ['/', '/diario', '/proposte'].includes(r)) {
      loadAll().then(render).catch(() => {});
    }
  });
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
boot();
