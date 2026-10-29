// PippiLove · funzione "selene"
// Il ponte tra l'app e l'intelligenza artificiale. La chiave resta qui sul server, mai sul telefono.
// Azioni: interview · interview_reset · draw · reroll · today · ping
//
// Segreti (Supabase → Edge Functions → Secrets):
//   AI_API_KEY    chiave del fornitore AI (obbligatoria)
//   AI_PROVIDER   'groq' (predefinito, gratuito) · 'anthropic' (Claude) · 'openai' (qualsiasi API compatibile)
//   AI_MODEL      facoltativo: modello preferito. Se non è disponibile o ha finito la quota,
//                 Selene passa da sola al successivo della lista MODELS qui sotto.
//   AI_BASE_URL   solo per 'openai': indirizzo base compatibile (es. https://openrouter.ai/api/v1)
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sono già presenti in automatico.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const PROVIDER = (Deno.env.get('AI_PROVIDER') || 'groq').toLowerCase();
const API_KEY = Deno.env.get('AI_API_KEY') || Deno.env.get('GROQ_API_KEY') || Deno.env.get('ANTHROPIC_API_KEY') || '';
const BASE_URL = (Deno.env.get('AI_BASE_URL') || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
// Groq gratuito: ogni modello ha la sua quota giornaliera, quindi a quota finita si passa al successivo.
const DEFAULT_MODELS: Record<string, string[]> = {
  groq: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile'],
  anthropic: ['claude-haiku-5-5', 'claude-sonnet-5-5'],
  openai: [],
};
const MODELS = [...new Set([Deno.env.get('AI_MODEL') || '', ...(DEFAULT_MODELS[PROVIDER] || [])].filter(Boolean))];
const STRICT_SCHEMA = /^(openai\/gpt-oss|qwen\/qwen3)/; // modelli Groq con output JSON garantito dallo schema
const INTERVIEW_DAILY_LIMIT = 150;
const MIN_INSIGHTS = 4;          // appunti minimi a testa prima della prima missione
const CONSOLIDATE_OVER = 45;     // oltre questo numero di appunti, Selene li riordina
const HISTORY = 14;              // messaggi di conversazione inviati all'AI
const RESUME_HOURS = 3;
const MAX_REROLLS = 5;           // cambi di missione a settimana          // se riapri la chat entro 3 ore, si riprende dall'ultima domanda

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

// ── AI ──────────────────────────────────────────────────────────
type Msg = { role: 'user' | 'assistant'; content: string };
type Schema = Record<string, unknown>;
type Effort = 'low' | 'medium';
type CallResult = { status: number; text?: string; error?: string };

const unavailable = new Set<string>(); // modelli non accessibili con questa chiave (per la vita del processo)

function normalise(messages: Msg[]): Msg[] {
  // ruoli alternati, si parte da "user"
  const merged: Msg[] = [];
  for (const m of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else merged.push({ ...m });
  }
  if (!merged.length || merged[0].role !== 'user') merged.unshift({ role: 'user', content: '(inizio della conversazione)' });
  return merged;
}

function parseJson(text: string): unknown {
  // alcuni modelli (es. Qwen) possono anteporre il ragionamento tra <think>…</think>
  const t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { /* prova a isolare l'oggetto */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('JSON non valido');
}

async function callAnthropic(model: string, system: string, messages: Msg[], schema: Schema, maxTokens: number, effort: Effort): Promise<CallResult> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model, max_tokens: maxTokens + 2000, system, messages,
      output_config: { effort, format: { type: 'json_schema', schema } },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { status: res.status, error: data?.error?.message || `HTTP ${res.status}` };
  if (data.stop_reason === 'refusal') return { status: 422, error: 'refusal' };
  const text = (data.content || []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('');
  return { status: 200, text };
}

async function callOpenAICompat(model: string, system: string, messages: Msg[], schema: Schema, maxTokens: number, effort: Effort, strict: boolean): Promise<CallResult> {
  const sys = strict ? system : `${system}

FORMATO DI RISPOSTA: rispondi solo con un oggetto JSON valido, senza testo prima o dopo, che rispetti questo JSON Schema (tutti i campi sono obbligatori):
${JSON.stringify(schema)}`;
  const body: Record<string, unknown> = {
    model, temperature: 0.75,
    max_completion_tokens: maxTokens + (model.includes('gpt-oss') ? 1500 : 0),
    messages: [{ role: 'system', content: sys }, ...messages],
    response_format: strict
      ? { type: 'json_schema', json_schema: { name: 'risposta', strict: true, schema } }
      : { type: 'json_object' },
  };
  if (model.includes('gpt-oss')) { body.reasoning_effort = effort; body.include_reasoning = false; }
  else if (/qwen3/i.test(model)) { body.reasoning_effort = effort; body.reasoning_format = 'hidden'; }
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { status: res.status, error: data?.error?.message || `HTTP ${res.status}` };
  return { status: 200, text: data?.choices?.[0]?.message?.content || '' };
}

const isModelError = (r: CallResult) =>
  r.status === 404 || /does not exist|not have access|model_not_found|decommission|not found|not supported|unknown model/i.test(r.error || '');

export async function ai<T>(system: string, messages: Msg[], schema: Schema, opts: { maxTokens?: number; effort?: Effort } = {}): Promise<T> {
  if (!API_KEY) throw new HttpError(500, 'Manca AI_API_KEY nei segreti della funzione Supabase');
  if (!MODELS.length) throw new HttpError(500, 'Manca AI_MODEL nei segreti della funzione Supabase');
  const msgs = normalise(messages);
  const maxTokens = opts.maxTokens ?? 1500, effort = opts.effort ?? 'low';
  let lastErr = '', rateLimited = false;

  for (const model of MODELS) {
    if (unavailable.has(model)) continue;
    let strict = PROVIDER === 'groq' && STRICT_SCHEMA.test(model);
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = PROVIDER === 'anthropic'
        ? await callAnthropic(model, system, msgs, schema, maxTokens, effort)
        : await callOpenAICompat(model, system, msgs, schema, maxTokens, effort, strict);
      if (r.status === 200) {
        try { return parseJson(r.text || '') as T; }
        catch { lastErr = 'risposta non in formato JSON'; continue; }
      }
      lastErr = `${model}: ${r.error}`;
      if (r.error === 'refusal') throw new HttpError(422, 'Selene ha preferito non rispondere a questo messaggio');
      if (isModelError(r)) { unavailable.add(model); break; }          // modello non accessibile → il prossimo
      if (r.status === 429) { rateLimited = true; break; }             // quota finita → il prossimo
      if (r.status === 400 && strict) { strict = false; continue; }    // schema rifiutato → JSON semplice
      if (r.status >= 500 && attempt < 1) { await new Promise(res => setTimeout(res, 900)); continue; }
      break;
    }
  }
  console.error('ai failed', lastErr);
  if (rateLimited) throw new HttpError(429, 'Selene ha esaurito le energie per oggi (quota gratuita dell’AI): riprova più tardi');
  throw new HttpError(502, `Selene non risponde (${lastErr || 'nessun modello disponibile'}), riprova`);
}

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v.trim() : fallback);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

// ── tempo ───────────────────────────────────────────────────────
function romeToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function romeNow(): string {
  return new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date());
}
function sinceText(iso: string): string {
  const h = (Date.now() - new Date(iso).getTime()) / 3600000;
  if (h < 1) return 'pochi minuti';
  if (h < 24) return `${Math.round(h)} ore`;
  const d = Math.round(h / 24);
  return d === 1 ? 'un giorno' : `${d} giorni`;
}

// ── persona ─────────────────────────────────────────────────────
const SELENE = `Sei Selene, la guida di PippiLove: un'app privata usata solo da una coppia sposata di adulti in Italia per esplorare e nutrire la propria sessualità.
Hai l'approccio di una sessuologa clinica esperta, calda e senza giudizio: conosci il modello del doppio controllo (acceleratori e freni del desiderio), il desiderio spontaneo e reattivo, l'importanza del contesto, della sicurezza emotiva, della novità, del gioco e della comunicazione.
Non sei una terapeuta: se emergono dolore fisico, traumi, violenza, disfunzioni o sofferenza importante, accogli con delicatezza, non trasformarlo in gioco e suggerisci di parlarne con un medico o una/un sessuologa/o.
Scrivi in italiano, con tono intimo, elegante, diretto, ironico quando serve, mai volgare e mai da questionario. Parli di sesso con naturalezza ma senza descrizioni esplicite o grafiche: evochi, suggerisci, proponi.
Consenso, limiti e parola di sicurezza vengono prima di tutto. Non spingi mai oltre un "no".
Ciò che una persona ti confida resta riservato: puoi usarlo per ispirare proposte, ma non riporti mai all'altra persona le sue parole o dettagli intimi riconoscibili.`;

// ── dati ────────────────────────────────────────────────────────
type Ctx = {
  db: SupabaseClient; me: string; partner: string | null; couple: string | null;
  names: Record<string, string>; safeWord: string | null;
};
type Insight = { id: number; topic: string; note: string; shareable: boolean };
type Checkin = { user_id?: string; day: string; mood?: number; energy?: number; stress?: number; desire?: number; time_tonight?: string; note?: string; wish?: string; updated_at?: string };
type Person = { id: string; name: string; insights: Insight[]; checkins: Checkin[] };

export async function loadCtx(db: SupabaseClient, me: string): Promise<Ctx> {
  const { data: prof } = await db.from('profiles').select('id, couple_id, display_name').eq('id', me).single();
  const ctx: Ctx = { db, me, partner: null, couple: prof?.couple_id ?? null, names: { [me]: prof?.display_name || 'Tu' }, safeWord: null };
  if (ctx.couple) {
    const [{ data: members }, { data: couple }] = await Promise.all([
      db.from('profiles').select('id, display_name').eq('couple_id', ctx.couple),
      db.from('couples').select('safe_word').eq('id', ctx.couple).single(),
    ]);
    for (const m of members || []) { ctx.names[m.id] = m.display_name || 'Partner'; if (m.id !== me) ctx.partner = m.id; }
    ctx.safeWord = couple?.safe_word ?? null;
  }
  return ctx;
}

async function loadPerson(ctx: Ctx, id: string): Promise<Person> {
  const [ins, chk] = await Promise.all([
    ctx.db.from('insights').select('id, topic, note, shareable').eq('user_id', id).order('id', { ascending: false }).limit(80),
    ctx.db.from('checkins').select('*').eq('user_id', id).order('day', { ascending: false }).limit(5),
  ]);
  return { id, name: ctx.names[id] || 'Partner', insights: ((ins.data || []) as Insight[]).reverse(), checkins: (chk.data || []) as Checkin[] };
}

const partnerLabel = (ctx: Ctx) => (ctx.partner ? ctx.names[ctx.partner] : 'il/la partner');

// Ogni riga porta il nome del proprietario: così l'AI non confonde mai le due persone.
function notesOf(p: Person, opts: { onlyShareable: boolean; max?: number; topics?: string[]; perTopic?: number }) {
  const all = p.insights.filter(i => !opts.topics || opts.topics.includes(i.topic));
  const limits = all.filter(i => i.topic === 'limiti');
  let other = all.filter(i => i.topic !== 'limiti' && (!opts.onlyShareable || i.shareable));
  if (opts.perTopic) {
    // solo gli appunti più recenti di ogni argomento: un tema molto raccontato non deve occupare tutto lo spazio
    const seen: Record<string, number> = {};
    other = [...other].reverse().filter(i => (seen[i.topic] = (seen[i.topic] || 0) + 1) <= opts.perTopic!).reverse();
  }
  other = other.slice(-(opts.max ?? 40));
  const privateLimits = opts.onlyShareable ? limits.filter(i => !i.shareable).length : 0;
  const shownLimits = opts.onlyShareable ? limits.filter(i => i.shareable) : limits;
  return {
    limits: shownLimits.map(i => `- [${p.name} · limite] ${i.note}`).join('\n')
      + (privateLimits ? `\n- [${p.name}] ha anche ${privateLimits} limiti riservati: in caso di dubbio scegli la versione più delicata` : ''),
    notes: other.map(i => `- [${p.name} · ${i.topic}] ${i.note}`).join('\n'),
  };
}

const levels = (c: Checkin) =>
  `umore ${c.mood ?? '?'}/5, energia ${c.energy ?? '?'}/5, stress ${c.stress ?? '?'}/5, voglia di intimità ${c.desire ?? '?'}/5${c.time_tonight ? `, tempo per voi stasera: ${c.time_tonight}` : ''}`;

function checkinOwn(p: Person, c: Checkin | undefined) {
  if (!c) return `${p.name} non ha ancora fatto il check-in di oggi.`;
  return `${p.name} oggi: ${levels(c)}`
    + (c.note ? `\n${p.name} racconta la sua giornata: "${clip(c.note, 700)}"` : '')
    + (c.wish ? `\n${p.name} oggi vorrebbe ricevere da ${'{PARTNER}'}: "${clip(c.wish, 300)}"` : '');
}

// del partner arrivano solo i livelli e ciò che vorrebbe ricevere: mai il racconto privato della giornata
function checkinPartner(p: Person, c: Checkin | undefined, other: string) {
  if (!c) return `${p.name} oggi non ha ancora fatto il check-in.`;
  return `${p.name} oggi: ${levels(c)}` + (c.wish ? `\n${p.name} oggi vorrebbe ricevere da ${other}: "${clip(c.wish, 300)}"` : '');
}

const todayOf = (p: Person) => p.checkins.find(c => c.day === romeToday());

async function currentWeek(db: SupabaseClient): Promise<string> {
  const { data } = await db.rpc('current_week');
  return data as string;
}

async function myPendingMission(ctx: Ctx) {
  const week = await currentWeek(ctx.db);
  const { data } = await ctx.db.from('challenges').select('ai_title, ai_text, status')
    .eq('giver_id', ctx.me).eq('week_start', week).maybeSingle();
  return data && data.status === 'pending' ? data : null;
}

const TOPICS = ['desiderio', 'acceleratori', 'freni', 'corpo', 'fantasie', 'limiti', 'comunicazione', 'emozioni', 'storia', 'contesto', 'coppia', 'preferenze'];
const TOPIC_HINT: Record<string, string> = {
  desiderio: 'cosa desidera e come nasce il suo desiderio', acceleratori: 'cosa lo/la accende davvero (situazioni, gesti, parole, atmosfere)',
  freni: 'cosa spegne il desiderio (stress, fretta, pensieri, abitudini)', corpo: 'il rapporto con il proprio corpo e con il tocco',
  fantasie: 'fantasie e curiosità mai dette', comunicazione: 'come chiede, dice di sì e dice di no',
  emozioni: 'cosa prova nell’intimità (sicurezza, vulnerabilità, gioco)', storia: 'come ha imparato la sessualità, le prime esperienze di coppia',
  contesto: 'tempi, luoghi, routine e momenti della settimana', coppia: 'come vive la coppia oggi, cosa le manca, cosa è cambiato',
  preferenze: 'ritmi, preferenze concrete e piccole cose che fanno la differenza',
};

// parole significative di un appunto, senza il nome della persona
function keyWords(s: string, name: string) {
  const n = name.toLowerCase();
  return new Set(s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/).filter(w => w.length > 3 && w !== n));
}
function similar(a: string, b: string, name: string) {
  const A = keyWords(a, name), B = keyWords(b, name);
  if (!A.size || !B.size) return false;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / Math.min(A.size, B.size) >= 0.7;
}

// dove portare la conversazione: argomenti poco esplorati, evitando quelli più battuti di recente
export function themeGuidance(p: Person, salt = 0) {
  const recent: Record<string, number> = {};
  for (const i of p.insights.slice(-8)) if (i.topic !== 'limiti') recent[i.topic] = (recent[i.topic] || 0) + 1;
  const avoid = Object.entries(recent).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([t]) => t);
  const total: Record<string, number> = {};
  for (const i of p.insights) total[i.topic] = (total[i.topic] || 0) + 1;
  const candidates = TOPICS.filter(t => t !== 'limiti' && !avoid.includes(t)).sort((a, b) => (total[a] || 0) - (total[b] || 0)).slice(0, 3);
  const focus = candidates[salt % candidates.length] || 'coppia';
  return { focus, avoid };
}

function exploreMap(p: Person) {
  const count: Record<string, number> = {};
  for (const i of p.insights) count[i.topic] = (count[i.topic] || 0) + 1;
  const done = TOPICS.filter(t => count[t]).map(t => `${t} (${count[t]})`);
  const todo = TOPICS.filter(t => !count[t]);
  return `Aree già esplorate: ${done.join(', ') || 'nessuna'}.\nAree ancora da esplorare: ${todo.join(', ') || 'nessuna: approfondisci dove senti più energia'}.`;
}

// ── colloquio ───────────────────────────────────────────────────
const INSIGHT_ITEM = {
  type: 'object',
  properties: {
    topic: { type: 'string', enum: TOPICS },
    note: { type: 'string' },
    shareable: { type: 'boolean' },
  },
  required: ['topic', 'note', 'shareable'],
  additionalProperties: false,
};

const CHAT_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    suggestions: { type: 'array', items: { type: 'string' } },
    idea_text: { type: 'string' },
    idea_kind: { type: 'string', enum: ['receive', 'give', 'together', 'none'] },
    idea_intensity: { type: 'integer' },
    new_insights: { type: 'array', items: INSIGHT_ITEM },
    progress: { type: 'integer' },
  },
  required: ['reply', 'suggestions', 'idea_text', 'idea_kind', 'idea_intensity', 'new_insights', 'progress'],
  additionalProperties: false,
};

type ChatOut = {
  reply: string; suggestions: string[]; idea_text: string; idea_kind: string; idea_intensity: number;
  new_insights: { topic: string; note: string; shareable: boolean }[]; progress: number;
};

export function chatSystem(o: {
  me: string; partner: string; mode: 'intro' | 'rientro' | 'risposta'; gap?: string; now: string;
  checkin: string; mission: string; notes: string; limits: string; map: string; lastWasQuestionStreak: number;
  focus: string; avoid: string[]; alreadyInEnvelope: string[]; pastMissions: string[];
}) {
  const { me, partner } = o;
  return `${SELENE}

STAI PARLANDO CON: ${me}. Dagli/dalle del tu. ${partner} è il/la partner: non è presente in questa chat, non conosci le sue confidenze e non devi mai attribuire a ${me} cose di ${partner}, né inventare cosa pensa o vuole ${partner}. Ogni dato qui sotto è etichettato con il nome della persona a cui si riferisce.
Ora è ${o.now}.

COME FUNZIONA IL GIOCO (fondamentale)
- Tu raccogli in privato i desideri di ${me} e li trasformi in sorprese che ${partner} preparerà per ${me}, senza sapere da dove vengono. Allo stesso modo raccogli quelli di ${partner} e li trasformi in missioni per ${me}.
- Quindi, quando ${me} ti racconta cosa desidera ricevere, sentire o vivere: CUSTODISCILO. Non dirgli/le di farlo da sé, non suggerire di chiederlo a ${partner}, non trasformarlo in qualcosa che ${me} deve fare per ${partner}. Rassicura che lo terrai tu e che diventerà una sorpresa ("questo lo custodisco io…"), e se serve chiedi un dettaglio che lo renda realizzabile (come, quando, con quale intensità, cosa NON deve succedere). In questo caso idea_kind = "receive".
- Le idee che proponi a ${me} da fare per ${partner} ("give") non possono basarsi su desideri di ${partner}, che non conosci: nascono dalla voglia di ${me} di prendersi cura di ${partner}, dalla missione in corso o da proposte di coppia generiche. Le cose da vivere insieme sono "together".

VARIETÀ (fondamentale)
- Non fissarti: non tornare di tua iniziativa su temi e idee già trattati. Se è ${me} a riportarli, seguili, altrimenti vai altrove.
- Temi molto battuti di recente, da NON riprendere tu: ${o.avoid.length ? o.avoid.map(t => `${t} (${TOPIC_HINT[t] || t})`).join('; ') : 'nessuno'}.
- Tema da aprire oggi se ${me} non porta altro: ${o.focus} — ${TOPIC_HINT[o.focus] || ''}.
- Ogni idea che proponi dev'essere nuova: diversa da quelle già nella busta e dalle missioni già vissute (elenchi qui sotto), non una loro piccola variante.

COME CONDUCI OGNI RISPOSTA
1. Prima rispondi davvero a ciò che ${me} ha appena scritto: riprendi una sua parola o immagine precisa e mostra che hai colto anche ciò che sta sotto (emozione, bisogno, timore). Se ti fa una domanda o ti chiede un'idea, rispondi subito e concretamente: non rimandare con un'altra domanda.
2. Poi scegli UNA mossa:
   a) APPROFONDIRE: una sola domanda aperta e specifica che nasce da ciò che ha detto (un momento preciso, una sensazione nel corpo, cosa cambierebbe, cosa teme);
   b) PROPORRE: un'idea concreta (per stasera o per la settimana: un gesto di cura per ${partner}, un gioco di coppia, un piccolo esercizio per conoscersi meglio, o una chiave di lettura da sessuologa applicata al suo caso), rispettando le regole del gioco qui sopra.
   Alterna le due mosse. ${o.lastWasQuestionStreak >= 2 ? 'Nelle ultime risposte hai fatto solo domande: QUESTA VOLTA PROPONI qualcosa di concreto (puoi chiudere con una domanda breve).' : 'Non fare più di due domande di fila senza proporre qualcosa.'}
3. Adatta tutto a come sta oggi ${me} (check-in qui sotto): se è stanca/o, stressata/o o giù, proposte di cura, ascolto e contatto senza pressione; se ha energia e voglia, osa di più. Se non c'è il check-in e il momento è giusto, chiedi com'è andata la giornata.
4. Quando il discorso lo permette, porta con naturalezza verso il tema da aprire oggi.
Lunghezza: 2-6 frasi. Più lungo solo se ti chiede un'idea o una spiegazione. Niente elenchi lunghi.

${o.mode === 'intro' ? `PRIMO INCONTRO: presentati in 2-3 frasi, spiega che quello che ${me} ti dice resta riservato (lo userai per ispirare sorprese e missioni, senza mai riportare le sue parole a ${partner}; può dirti "questo tienilo per te") e fai una prima domanda leggera, legata a come sta oggi.` : ''}${o.mode === 'rientro' ? `${me} RIAPRE LA CHAT dopo ${o.gap}. Non ripetere l'ultima domanda: saluta in modo adatto al momento della giornata, riallacciati a com'è oggi (check-in, se c'è, altrimenti chiedi com'è andata) o alla missione in corso, e offri subito qualcosa: una piccola idea per oggi o una domanda nuova. Se c'era un filo rimasto in sospeso puoi richiamarlo in una frase.` : ''}

CAMPI DA COMPILARE
- reply: il tuo messaggio a ${me}.
- suggestions: esattamente 3 risposte brevi (massimo 6 parole) che ${me} potrebbe toccare per continuare, scritte da ${me} in prima persona: una per approfondire, una per chiederti un'idea, una per parlare di oggi o cambiare argomento.
- idea_text / idea_kind / idea_intensity: se nella reply proponi un'idea concreta che potrebbe diventare una missione, riscrivila qui in una frase in prima persona di ${me} (es. "Vorrei che mi preparassi un bagno caldo e restassi con me"). idea_kind: receive = ${partner} la fa per ${me}; give = ${me} la fa per ${partner}; together = insieme. idea_intensity: 1 dolce, 2 audace, 3 molto audace. L'app mostrerà un pulsante per metterla nella busta segreta. Se non proponi nulla: idea_text "", idea_kind "none", idea_intensity 1.
- new_insights: SOLO informazioni nuove su ${me} emerse dal suo ultimo messaggio (spesso 0-3). Ogni nota inizia con il nome "${me}" (es. "${me} si accende quando…"). Se ${me} racconta qualcosa di ${partner}, scrivi "${me} percepisce che ${partner}…", mai come un fatto su ${partner}. Quando ${me} esprime un desiderio verso ${partner}, scrivi la nota come "${me} vorrebbe che ${partner}…" (topic desiderio): servirà per le missioni di ${partner}. Non ripetere appunti già presenti in "COSA SAI GIÀ". topic "limiti" per ciò che non vuole fare o ricevere. shareable false se ${me} ha chiesto di tenerlo per sé o è troppo delicato per ispirare missioni.
- progress: quanto senti di conoscere ${me}, da 0 a 100.

MAPPA DELL'ESPLORAZIONE DI ${me.toUpperCase()}
${o.map}

OGGI
${o.checkin}

MISSIONE CHE ${me.toUpperCase()} STA FACENDO PER ${partner.toUpperCase()} QUESTA SETTIMANA
${o.mission}

IDEE GIÀ NELLA BUSTA SEGRETA DI ${me.toUpperCase()} (non riproporle)
${o.alreadyInEnvelope.map(x => '- ' + x).join('\n') || '—'}

MISSIONI GIÀ VISSUTE (non riproporle)
${o.pastMissions.map(x => '- ' + x).join('\n') || '—'}

LIMITI DI ${me.toUpperCase()}
${o.limits || '— nessuno dichiarato'}

COSA SAI GIÀ DI ${me.toUpperCase()}
${o.notes || '— ancora poco: è l’inizio'}`;
}

export async function interview(ctx: Ctx, message: string | undefined) {
  const { db, me } = ctx;
  const since = new Date(Date.now() - 86400000).toISOString();
  const { count } = await db.from('interview_messages').select('id', { count: 'exact', head: true })
    .eq('user_id', me).eq('role', 'user').gte('created_at', since);
  if ((count ?? 0) >= INTERVIEW_DAILY_LIMIT) throw new HttpError(429, 'Per oggi basta così: riprendiamo domani ♥');

  const text = message?.trim();
  if (text) {
    if (text.length > 4000) throw new HttpError(400, 'Messaggio troppo lungo');
    await db.from('interview_messages').insert({ user_id: me, role: 'user', content: text });
  }
  const { data: hist } = await db.from('interview_messages').select('role, content, created_at')
    .eq('user_id', me).order('id', { ascending: false }).limit(HISTORY);
  const history = ((hist || []) as (Msg & { created_at: string })[]).reverse();
  const last = history[history.length - 1];

  let mode: 'intro' | 'rientro' | 'risposta' = 'risposta';
  if (!text) {
    if (!history.length) mode = 'intro';
    else if (last.role === 'assistant') {
      const hours = (Date.now() - new Date(last.created_at).getTime()) / 3600000;
      if (hours < RESUME_HOURS) return { reply: last.content, resumed: true };
      mode = 'rientro';
    }
  }

  const meP = await loadPerson(ctx, me);
  const partner = partnerLabel(ctx);
  const { notes, limits } = notesOf(meP, { onlyShareable: false, max: 36, perTopic: 4 });
  const [mission, myProps, past] = await Promise.all([
    myPendingMission(ctx),
    db.from('proposals').select('body').eq('author_id', me).order('created_at', { ascending: false }).limit(12),
    ctx.couple
      ? db.from('challenges').select('ai_title, giver_id, receiver_id, status').eq('couple_id', ctx.couple).order('week_start', { ascending: false }).limit(10)
      : Promise.resolve({ data: [] as { ai_title: string; giver_id: string; receiver_id: string; status: string }[] }),
  ]);
  // le missioni che ${me} riceve e non ha ancora scoperto restano segrete anche per la chat
  const pastMissions = ((past.data || []) as { ai_title: string; giver_id: string; receiver_id: string; status: string }[])
    .filter(c => c.ai_title && (c.status === 'done' || c.giver_id === me))
    .map(c => `"${c.ai_title}" (${ctx.names[c.giver_id]} per ${ctx.names[c.receiver_id]})`);
  const theme = themeGuidance(meP, history.length + new Date().getDate());
  // quante risposte consecutive di Selene finivano con una domanda
  let streak = 0;
  for (let i = history.length - 1; i >= 0 && streak < 3; i--) {
    if (history[i].role !== 'assistant') continue;
    if (/\?\s*$/.test(history[i].content)) streak++; else break;
  }

  const system = chatSystem({
    me: meP.name, partner, mode, gap: last ? sinceText(last.created_at) : '', now: romeNow(),
    checkin: checkinOwn(meP, todayOf(meP)).replaceAll('{PARTNER}', partner),
    mission: mission ? `"${mission.ai_title}": ${mission.ai_text}` : 'nessuna missione in corso',
    notes, limits, map: exploreMap(meP), lastWasQuestionStreak: streak,
    focus: theme.focus, avoid: theme.avoid,
    alreadyInEnvelope: ((myProps.data || []) as { body: string }[]).map(p => clip(p.body, 140)), pastMissions,
  });

  const msgs: Msg[] = history.map(h => ({ role: h.role, content: clip(h.content, 1500) }));
  if (mode === 'rientro') msgs.push({ role: 'user', content: `(${meP.name} ha appena riaperto la chat. Scrivi tu il primo messaggio.)` });
  if (mode === 'intro') msgs.push({ role: 'user', content: `(${meP.name} apre la chat per la prima volta. Presentati.)` });

  const out = await ai<ChatOut>(system, msgs, CHAT_SCHEMA, { maxTokens: 1400, effort: 'low' });
  const reply = str(out?.reply);
  if (!reply) throw new HttpError(502, 'Selene si è persa un attimo, riprova');

  await db.from('interview_messages').insert({ user_id: me, role: 'assistant', content: reply });
  const fresh: { user_id: string; topic: string; note: string; shareable: boolean; source: string }[] = [];
  if (text) {
    for (const i of (Array.isArray(out.new_insights) ? out.new_insights : []).slice(0, 5)) {
      const note = clip(str(i?.note), 400);
      if (!note) continue;
      // niente doppioni: se Selene sa già la stessa cosa, non la riscrive
      if ([...meP.insights.map(x => x.note), ...fresh.map(x => x.note)].some(n => similar(n, note, meP.name))) continue;
      fresh.push({ user_id: me, topic: TOPICS.includes(i.topic) ? i.topic : 'preferenze', note, shareable: i.shareable !== false, source: 'interview' });
    }
  }
  if (fresh.length) await db.from('insights').insert(fresh);

  if (meP.insights.length + fresh.length > CONSOLIDATE_OVER) {
    const job = consolidate(ctx).catch(e => console.error('consolidate', e));
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    if (rt?.waitUntil) rt.waitUntil(job); else await job;
  }

  const kind = ['receive', 'give', 'together'].includes(out.idea_kind) ? out.idea_kind : null;
  const ideaText = str(out.idea_text);
  return {
    reply,
    suggestions: (Array.isArray(out.suggestions) ? out.suggestions : []).map(s => clip(str(s), 60)).filter(Boolean).slice(0, 3),
    idea: kind && ideaText.length > 8 ? { text: clip(ideaText, 300), kind, intensity: Math.max(1, Math.min(3, Number(out.idea_intensity) | 0 || 1)) } : null,
    progress: Math.max(0, Math.min(100, Number(out.progress) | 0)),
    learned: fresh.length,
  };
}

const CONSOLIDATE_SCHEMA = {
  type: 'object',
  properties: { notes: { type: 'array', items: INSIGHT_ITEM } },
  required: ['notes'],
  additionalProperties: false,
};

async function consolidate(ctx: Ctx) {
  const { db, me } = ctx;
  const { data: rows } = await db.from('insights').select('id, topic, note, shareable').eq('user_id', me).order('id');
  if (!rows || rows.length <= CONSOLIDATE_OVER) return;
  const name = ctx.names[me];
  const out = await ai<{ notes: { topic: string; note: string; shareable: boolean }[] }>(
    `${SELENE}\n\nRiordina gli appunti su ${name}: unisci i doppioni, tieni le informazioni più recenti quando si contraddicono, non inventare nulla, non perdere mai un limite. Massimo 30 appunti. Ogni nota inizia con "${name}". Se uno degli appunti uniti era riservato (shareable false), anche il risultato lo è.`,
    [{ role: 'user', content: rows.map(r => `- [${r.topic}] (${r.shareable ? 'condivisibile' : 'riservato'}) ${r.note}`).join('\n') }],
    CONSOLIDATE_SCHEMA, { maxTokens: 3500, effort: 'low' });
  const notes = (out?.notes || []).filter(n => str(n.note));
  const limitsBefore = rows.filter(r => r.topic === 'limiti').length;
  const limitsAfter = notes.filter(n => n.topic === 'limiti').length;
  if (notes.length < 5 || (limitsBefore > 0 && limitsAfter === 0)) return; // risultato sospetto: non toccare nulla
  await db.from('insights').insert(notes.map(n => ({
    user_id: me, topic: TOPICS.includes(n.topic) ? n.topic : 'preferenze', note: str(n.note), shareable: n.shareable !== false, source: 'riordino',
  })));
  await db.from('insights').delete().in('id', rows.map(r => r.id));
}

// ── missione settimanale ────────────────────────────────────────
const MISSION_SCHEMA = {
  type: 'object',
  properties: {
    chi_la_fa: { type: 'string' },
    per_chi: { type: 'string' },
    title: { type: 'string' },
    mission: { type: 'string' },
    why: { type: 'string' },
    category: { type: 'string', enum: ['romance', 'touch', 'tease', 'words', 'places', 'explore'] },
    intensity: { type: 'integer' },
    proposal_id: { type: 'string' },
  },
  required: ['chi_la_fa', 'per_chi', 'title', 'mission', 'why', 'category', 'intensity', 'proposal_id'],
  additionalProperties: false,
};

type Mission = { chi_la_fa?: string; per_chi?: string; title: string; mission: string; why: string; category: string; intensity: number; proposal_id: string | null };
type Proposal = { id: string; author_id: string; kind: string; body: string; intensity: number };

const CATEGORIES: Record<string, string> = {
  romance: 'romanticismo', touch: 'tocco e sensi', tease: 'seduzione e gioco', words: 'parole e fantasie', places: 'tempi e luoghi', explore: 'esplorazione',
};
export function pickCategory(recent: string[]) {
  const last2 = recent.slice(0, 2);
  const count: Record<string, number> = {};
  for (const c of recent.slice(0, 8)) count[c] = (count[c] || 0) + 1;
  return Object.keys(CATEGORIES).filter(c => !last2.includes(c)).sort((a, b) => (count[a] || 0) - (count[b] || 0))[0] || 'romance';
}

export function missionPrompt(o: {
  giver: Person; receiver: Person; week: string; level: number; safeWord: string | null;
  proposals: Proposal[]; history: string[]; extra: string; category?: string; recentCategories?: string[];
}) {
  const G = o.giver.name, R = o.receiver.name;
  const recv = notesOf(o.receiver, { onlyShareable: true, max: 32, perTopic: 4 });
  // di chi fa la missione servono solo limiti, energie e ciò che si è offerto di fare: NON i suoi desideri
  const giv = notesOf(o.giver, { onlyShareable: true, max: 12, topics: ['limiti', 'comunicazione', 'contesto'] });
  const recvWishes = o.receiver.checkins.filter(c => c.wish).slice(0, 3).map(c => `- ${c.day}: ${R} vorrebbe ricevere da ${G}: "${clip(c.wish!, 200)}"`);
  const recvLevels = o.receiver.checkins.slice(0, 3).map(c => `- ${c.day}: ${levels(c)}`);
  const givLevels = o.giver.checkins.slice(0, 3).map(c => `- ${c.day}: ${levels(c)}`);
  const propLine = (p: Proposal) => {
    const who = p.author_id === o.receiver.id ? R : G;
    const what = p.kind === 'receive' ? `${who} vorrebbe RICEVERE da ${who === R ? G : R}` : p.kind === 'give' ? `${who} vorrebbe FARE per ${who === R ? G : R}` : `${who} vorrebbe fare INSIEME`;
    return `- id ${p.id} · ${what} (intensità ${p.intensity}): "${clip(p.body, 300)}"`;
  };

  const system = `${SELENE}

COMPITO: scrivi UNA missione settimanale.
- CHI LA FA: ${G}. Il testo è rivolto a ${G}, con il tu.
- PER CHI: ${R}. La missione deve far stare bene ${R} e nutrire ciò che accende ${R}. ${R} non saprà cosa sarà finché non sarà fatta.
Attenzione a non invertire i ruoli: i desideri da soddisfare sono quelli di ${R}, non quelli di ${G}.

Regole:
- Il cuore del tuo lavoro: prendi i desideri di ${R} (gli appunti "${R} vorrebbe che ${G}…", ciò che accende ${R}, le proposte in cui ${R} vuole ricevere, i desideri dei check-in) e TRASFORMALI in un'azione concreta che ${G} compie per ${R}. ${G} non deve capire che viene da una confidenza: scrivila come un'idea di Selene.
- Di ${G} considera solo limiti ed energie, per proporre qualcosa che ${G} possa fare volentieri.
- Categoria di questa settimana: ${o.category ? `${o.category} (${CATEGORIES[o.category]})` : 'libera'}. Scegline un'altra solo se non c'è proprio materiale adatto. ${o.recentCategories?.length ? `Ultime categorie usate: ${o.recentCategories.slice(0, 4).join(', ')}.` : ''}
- Non fissarti su un solo desiderio: se uno è già stato usato in una missione recente (storico qui sotto), parti da un altro.
- MAI nulla che tocchi i limiti di ${R} o di ${G}.
- Livello attuale della coppia: ${o.level}/3. Scendi se i check-in recenti raccontano stanchezza o stress; sali solo se entrambi sembrano pronti.
- Concreta, realizzabile in una settimana, originale e personale. Varia rispetto alle ultime settimane; riprendi lo spirito di ciò che ha preso voti alti, evita ciò che ha preso voti bassi.
- Se una proposta della busta segreta in cui ${R} vuole ricevere (o in cui ${G} vuole fare, o da fare insieme) è adatta, puoi costruirci la missione: metti il suo id in proposal_id e rispettane il contenuto. Altrimenti proposal_id = "".
- Non citare mai confidenze o parole dei colloqui: trasformale in un'idea.
- ${o.safeWord ? `Se la missione è audace, ricorda la parola di sicurezza della coppia: "${o.safeWord}".` : 'Se la missione è audace, ricorda di concordare prima una parola di sicurezza.'}

Campi: chi_la_fa = "${G}", per_chi = "${R}", title (2-5 parole, evocativo), mission (2-4 frasi concrete rivolte a ${G}, usando il nome ${R}), why (una frase per ${G}: perché è pensata per ${R}, senza citare confidenze), category, intensity (1 dolce, 2 audace, 3 molto audace), proposal_id.`;

  const user = `COSA ACCENDE ${R.toUpperCase()} (appunti di Selene su ${R}):
${recv.notes || '— ancora pochi'}

COSA ${R.toUpperCase()} HA CHIESTO DI RECENTE NEI CHECK-IN:
${recvWishes.join('\n') || '—'}

LIMITI DI ${R.toUpperCase()}:
${recv.limits || '— nessuno dichiarato'}

LIMITI E CONTESTO DI ${G.toUpperCase()} (chi fa la missione):
${[giv.limits, giv.notes].filter(Boolean).join('\n') || '— nessuno dichiarato'}

COME STANNO DI RECENTE
${recvLevels.length ? recvLevels.map(l => `${R} ${l.slice(2)}`).map(l => '- ' + l).join('\n') : `- ${R}: nessun check-in`}
${givLevels.length ? givLevels.map(l => `${G} ${l.slice(2)}`).map(l => '- ' + l).join('\n') : `- ${G}: nessun check-in`}

BUSTA SEGRETA (proposte scritte da loro):
${o.proposals.map(propLine).join('\n') || '—'}

STORICO RECENTE DELLE MISSIONI:
${o.history.join('\n') || '— (prima settimana)'}
${o.extra}
Scrivi la missione della settimana del ${o.week}: ${G} la fa per ${R}.`;
  return { system, user };
}

async function createMission(ctx: Ctx, week: string, giverId: string, receiverId: string, extra = ''): Promise<Mission> {
  const { db } = ctx;
  const [giver, receiver, props, hist] = await Promise.all([
    loadPerson(ctx, giverId),
    loadPerson(ctx, receiverId),
    db.from('proposals').select('id, author_id, kind, body, intensity').eq('couple_id', ctx.couple!),
    db.from('challenges').select('week_start, giver_id, receiver_id, ai_title, ai_category, proposal_id, status, rating, feedback')
      .eq('couple_id', ctx.couple!).order('week_start', { ascending: false }).limit(16),
  ]);
  const used = new Set((hist.data || []).filter(h => h.proposal_id && (h.status === 'done' || h.week_start === week)).map(h => h.proposal_id));
  const eligible = ((props.data || []) as Proposal[]).filter(p => !used.has(p.id) && (
    (p.kind === 'receive' && p.author_id === receiverId) || (p.kind === 'give' && p.author_id === giverId) || p.kind === 'together'));
  const doneCount = (hist.data || []).filter(h => h.status === 'done').length;
  const level = Math.min(3, 1 + Math.floor(doneCount / 5));
  const history = (hist.data || []).map(h =>
    `- ${h.week_start} · ${ctx.names[h.giver_id]} per ${ctx.names[h.receiver_id]}: "${h.ai_title || 'missione'}" — ${h.status === 'done' ? 'fatta' : 'in corso'}${h.rating ? `, voto di ${ctx.names[h.receiver_id]}: ${h.rating}/5` : ''}${h.feedback ? `, commento: "${clip(h.feedback, 160)}"` : ''}`);

  const recentCategories = (hist.data || []).filter(h => h.week_start !== week && h.ai_category).map(h => h.ai_category as string);
  const category = pickCategory(recentCategories);
  const { system, user } = missionPrompt({ giver, receiver, week, level, safeWord: ctx.safeWord, proposals: eligible, history, extra, category, recentCategories });
  let m = await ai<Mission>(system, [{ role: 'user', content: user }], MISSION_SCHEMA, { maxTokens: 1500, effort: 'medium' });
  // controllo dei ruoli: se l'AI li ha invertiti, si riprova una volta
  const swapped = (x: Mission) => str(x.per_chi).toLowerCase() === giver.name.toLowerCase() || str(x.chi_la_fa).toLowerCase() === receiver.name.toLowerCase();
  if (swapped(m)) {
    m = await ai<Mission>(system, [{ role: 'user', content: user },
      { role: 'assistant', content: JSON.stringify(m) },
      { role: 'user', content: `Hai invertito i ruoli: la missione la fa ${giver.name} PER ${receiver.name}. Riscrivila.` }], MISSION_SCHEMA, { maxTokens: 1500, effort: 'medium' });
  }
  if (!str(m?.title) || !str(m?.mission)) throw new HttpError(502, 'Missione non valida, riprova');
  m.title = str(m.title); m.mission = str(m.mission); m.why = str(m.why);
  m.intensity = Math.max(1, Math.min(3, Number(m.intensity) | 0 || 1));
  if (!['romance', 'touch', 'tease', 'words', 'places', 'explore'].includes(m.category)) m.category = 'romance';
  const pid = str(m.proposal_id);
  m.proposal_id = pid && eligible.some(p => p.id === pid) ? pid : null;
  return m;
}

async function missionRow(ctx: Ctx, m: Mission) {
  if (!m.proposal_id) return { proposal_id: null, proposal_body: null, proposal_author: null };
  const { data } = await ctx.db.from('proposals').select('id, body, author_id').eq('id', m.proposal_id).single();
  return { proposal_id: data?.id ?? null, proposal_body: data?.body ?? null, proposal_author: data?.author_id ?? null };
}

async function readiness(ctx: Ctx) {
  const counts = await Promise.all([ctx.me, ctx.partner!].map(async id =>
    (await ctx.db.from('insights').select('id', { count: 'exact', head: true }).eq('user_id', id)).count ?? 0));
  return counts.every(c => c >= MIN_INSIGHTS);
}

export async function draw(ctx: Ctx) {
  if (!ctx.couple || !ctx.partner) return { ok: false, reason: 'partner' };
  if (!(await readiness(ctx))) return { ok: false, reason: 'colloquio' };
  const week = await currentWeek(ctx.db);
  const { data: existing } = await ctx.db.from('challenges').select('giver_id').eq('couple_id', ctx.couple).eq('week_start', week);
  const have = new Set((existing || []).map(e => e.giver_id));
  const pairs = [[ctx.me, ctx.partner], [ctx.partner, ctx.me]].filter(([g]) => !have.has(g));
  for (const [giver, receiver] of pairs) {
    const { data: other } = await ctx.db.from('challenges').select('ai_title').eq('couple_id', ctx.couple).eq('week_start', week).neq('giver_id', giver).maybeSingle();
    const m = await createMission(ctx, week, giver, receiver, other?.ai_title ? `\nL'altra missione di questa settimana è "${other.ai_title}": proponi qualcosa di diverso.\n` : '');
    await ctx.db.from('challenges').upsert({
      couple_id: ctx.couple, week_start: week, giver_id: giver, receiver_id: receiver,
      ai_title: m.title, ai_text: m.mission, ai_why: m.why, ai_category: m.category, ai_intensity: m.intensity,
      ...(await missionRow(ctx, m)),
    }, { onConflict: 'couple_id,week_start,giver_id', ignoreDuplicates: true });
  }
  return { ok: true };
}

export async function reroll(ctx: Ctx, challengeId: string, reason: string | undefined) {
  const { data: ch } = await ctx.db.from('challenges').select('*').eq('id', challengeId).single();
  if (!ch || ch.giver_id !== ctx.me || ch.status !== 'pending') throw new HttpError(404, 'Missione non trovata');
  if (ch.rerolls >= MAX_REROLLS) throw new HttpError(400, `Hai già cambiato missione ${MAX_REROLLS} volte questa settimana`);
  const reasons = [...(ch.reroll_reasons || []), `"${ch.ai_title}" — ${reason?.trim() || 'non se la sente'}`];
  const extra = `\nMISSIONI GIÀ SCARTATE QUESTA SETTIMANA DA ${ctx.names[ctx.me]} (proponi qualcosa di diverso, tenendo conto del motivo):\n${reasons.map(r => '- ' + r).join('\n')}\n`;
  const m = await createMission(ctx, ch.week_start, ch.giver_id, ch.receiver_id, extra);
  const { error } = await ctx.db.from('challenges').update({
    ai_title: m.title, ai_text: m.mission, ai_why: m.why, ai_category: m.category, ai_intensity: m.intensity,
    ...(await missionRow(ctx, m)), rerolls: ch.rerolls + 1, reroll_reasons: reasons,
  }).eq('id', ch.id);
  if (error) throw error;
  return { ok: true };
}

// ── consiglio del giorno ────────────────────────────────────────
const TODAY_SCHEMA = {
  type: 'object',
  properties: {
    per_chi: { type: 'string' },
    headline: { type: 'string' },
    reading: { type: 'string' },
    gesture: { type: 'string' },
    mission_tip: { type: 'string' },
    self_care: { type: 'string' },
    question: { type: 'string' },
    mood_color: { type: 'string', enum: ['quiete', 'tenerezza', 'gioco', 'passione', 'cura'] },
  },
  required: ['per_chi', 'headline', 'reading', 'gesture', 'mission_tip', 'self_care', 'question', 'mood_color'],
  additionalProperties: false,
};

export function todayPrompt(o: { me: Person; partner: Person | null; mineToday: Checkin; theirsToday?: Checkin; mission: string; now: string; pastTips?: string[] }) {
  const M = o.me.name, P = o.partner?.name || 'il/la partner';
  const mine = notesOf(o.me, { onlyShareable: false, max: 20, perTopic: 3 });
  const theirs = o.partner ? notesOf(o.partner, { onlyShareable: true, max: 20, perTopic: 3 }) : { notes: '', limits: '' };
  const system = `${SELENE}

Scrivi il consiglio di oggi PER ${M} (dagli/dalle del tu). ${P} è il/la partner.
Non confondere mai le due persone: ciò che è etichettato "${M}" riguarda ${M}, ciò che è etichettato "${P}" riguarda ${P}. La giornata raccontata è quella di ${M}. Di ${P} conosci solo i livelli di oggi e ciò che vorrebbe ricevere: non inventare cosa le/gli è successo.
Obiettivo: aiutare ${M} a vivere la giornata in modo da nutrire l'intimità con ${P}, partendo da come stanno entrambi OGGI.
Se uno dei due è stanco, stressato o giù, proponi calore, ascolto e contatto senza pressione. Se l'energia c'è, osa di più.
Ciò che ${P} vorrebbe ricevere puoi tradurlo in un gesto concreto per ${M}, senza dire che ${P} l'ha scritto.
Sii specifica, breve, mai generica. Niente elenchi.

Campi: per_chi = "${M}"; headline (titolo breve e caldo); reading (1-2 frasi: come leggi la giornata di ${M} e il clima tra voi); gesture (un piccolo gesto concreto che ${M} può fare oggi per ${P}); mission_tip (se ${M} ha una missione in corso: se e come portarla avanti oggi; altrimenti ""); self_care (un suggerimento per ${M}, per accendere o proteggere il proprio desiderio oggi); question (una domanda che ${M} può fare a ${P} stasera); mood_color.`;

  const user = `ORA: ${o.now}

${M.toUpperCase()} — LA PERSONA A CUI SCRIVI
${checkinOwn(o.me, o.mineToday).replaceAll('{PARTNER}', P)}
Limiti di ${M}:
${mine.limits || '—'}
Appunti su ${M}:
${mine.notes || '—'}

${P.toUpperCase()} — IL/LA PARTNER
${o.partner ? checkinPartner(o.partner, o.theirsToday, M) : '—'}
Limiti di ${P}:
${theirs.limits || '—'}
Cosa accende ${P}:
${theirs.notes || '—'}

MISSIONE CHE ${M.toUpperCase()} STA FACENDO PER ${P.toUpperCase()}:
${o.mission}

GESTI E DOMANDE GIÀ SUGGERITI NEI GIORNI SCORSI (non ripeterli, proponi altro):
${o.pastTips?.map(t => '- ' + t).join('\n') || '—'}`;
  return { system, user };
}

export async function today(ctx: Ctx, force: boolean) {
  const { db, me, partner } = ctx;
  const day = romeToday();
  const ids = [me, partner].filter(Boolean) as string[];
  const { data: chks } = await db.from('checkins').select('*').eq('day', day).in('user_id', ids);
  const mineToday = (chks || []).find(c => c.user_id === me) as Checkin | undefined;
  if (!mineToday) throw new HttpError(400, 'Prima raccontami come stai oggi');
  const theirsToday = (chks || []).find(c => c.user_id === partner) as Checkin | undefined;
  const basis = `v2|${mineToday.updated_at}|${theirsToday?.updated_at ?? ''}`;

  if (!force) {
    const { data: cached } = await db.from('daily_tips').select('content, basis').eq('user_id', me).eq('day', day).maybeSingle();
    if (cached && cached.basis === basis) return cached.content;
  }

  const [meP, partnerP, mission, prevTips] = await Promise.all([
    loadPerson(ctx, me),
    partner ? loadPerson(ctx, partner) : Promise.resolve(null),
    myPendingMission(ctx),
    db.from('daily_tips').select('day, content').eq('user_id', me).neq('day', day).order('day', { ascending: false }).limit(4),
  ]);
  const pastTips = ((prevTips.data || []) as { content: { gesture?: string; question?: string } }[])
    .flatMap(t => [t.content?.gesture, t.content?.question]).filter(Boolean).map(x => clip(String(x), 160));
  const { system, user } = todayPrompt({
    me: meP, partner: partnerP, mineToday, theirsToday, now: romeNow(), pastTips,
    mission: mission ? `"${mission.ai_title}": ${mission.ai_text}` : 'nessuna in corso',
  });

  const out = await ai<Record<string, unknown>>(system, [{ role: 'user', content: user }], TODAY_SCHEMA, { maxTokens: 1200, effort: 'low' });
  const clean = {
    headline: str(out.headline, 'Oggi'), reading: str(out.reading), gesture: str(out.gesture),
    mission_tip: str(out.mission_tip) || null, self_care: str(out.self_care), question: str(out.question),
    mood_color: ['quiete', 'tenerezza', 'gioco', 'passione', 'cura'].includes(out.mood_color as string) ? out.mood_color : 'tenerezza',
  };
  await db.from('daily_tips').upsert({ user_id: me, day, content: clean, basis });
  return clean;
}

// ── ripartire da zero ───────────────────────────────────────────
export async function resetAll(ctx: Ctx, opts: { proposals?: boolean; checkins?: boolean; missions?: boolean }) {
  const { db, me } = ctx;
  await db.from('interview_messages').delete().eq('user_id', me);
  await db.from('insights').delete().eq('user_id', me);
  await db.from('daily_tips').delete().eq('user_id', me);
  if (opts.proposals) await db.from('proposals').delete().eq('author_id', me);
  if (opts.checkins) await db.from('checkins').delete().eq('user_id', me);
  if (opts.missions && ctx.couple) {
    const week = await currentWeek(db);
    // le missioni di questa settimana non ancora fatte erano basate sui vecchi dati: si tolgono (per entrambi)
    await db.from('challenges').delete().eq('couple_id', ctx.couple).eq('week_start', week).eq('status', 'pending');
  }
  return { ok: true };
}

// ── server ──────────────────────────────────────────────────────
// (PIPPI_TEST serve solo ai test locali dei prompt)
if (!Deno.env.get('PIPPI_TEST')) Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: { user } } = await db.auth.getUser(token);
    if (!user) throw new HttpError(401, 'Non autenticato');
    const body = await req.json().catch(() => ({}));
    const ctx = await loadCtx(db, user.id);

    switch (body.action) {
      case 'interview': return json(await interview(ctx, body.message));
      case 'reset_all': return json(await resetAll(ctx, body.options || {}));
      case 'interview_reset': {
        await db.from('interview_messages').delete().eq('user_id', user.id);
        return json({ ok: true });
      }
      case 'draw': return json(await draw(ctx));
      case 'reroll': return json(await reroll(ctx, body.challenge_id, body.reason));
      case 'today': return json(await today(ctx, !!body.force));
      case 'ping': return json({ ok: true, provider: PROVIDER, models: MODELS, unavailable: [...unavailable], key: !!API_KEY });
      default: throw new HttpError(400, 'Azione sconosciuta');
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    console.error(e);
    return json({ error: (e as Error).message || 'Errore' }, status);
  }
});
