// PippiLove · funzione "selene"
// Il ponte tra l'app e l'intelligenza artificiale. La chiave resta qui sul server, mai sul telefono.
// Azioni: interview · interview_reset · draw · reroll · today · ping
//
// Segreti (Supabase → Edge Functions → Secrets):
//   AI_API_KEY    chiave del fornitore AI (obbligatoria)
//   AI_PROVIDER   'groq' (predefinito, gratuito) · 'anthropic' (Claude) · 'openai' (qualsiasi API compatibile)
//   AI_MODEL      facoltativo; predefiniti: groq → llama-3.3-70b-versatile, anthropic → claude-haiku-5-5
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
const MODEL = Deno.env.get('AI_MODEL') || (PROVIDER === 'anthropic' ? 'claude-haiku-5-5' : 'llama-3.3-70b-versatile');
const BASE_URL = (Deno.env.get('AI_BASE_URL') || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
const INTERVIEW_DAILY_LIMIT = 150;
const MIN_INSIGHTS = 4;          // appunti minimi a testa prima della prima missione
const CONSOLIDATE_OVER = 60;     // oltre questo numero di appunti, Selene li riordina

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

// ── AI ──────────────────────────────────────────────────────────
type Msg = { role: 'user' | 'assistant'; content: string };
type Schema = Record<string, unknown>;

function normalise(messages: Msg[]): Msg[] {
  // ruoli alternati, si parte da "user"
  const merged: Msg[] = [];
  for (const m of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else merged.push({ ...m });
  }
  if (!merged.length || merged[0].role !== 'user') merged.unshift({ role: 'user', content: '(inizio)' });
  return merged;
}

function parseJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { /* prova a isolare l'oggetto */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('JSON non valido');
}

async function callAnthropic(system: string, messages: Msg[], schema: Schema, maxTokens: number, effort: string) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: maxTokens, system, messages,
      output_config: { effort, format: { type: 'json_schema', schema } },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { status: res.status, error: data?.error?.message || `HTTP ${res.status}` };
  if (data.stop_reason === 'refusal') return { status: 422, error: 'refusal' };
  const text = (data.content || []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('');
  return { status: 200, text };
}

async function callOpenAICompat(system: string, messages: Msg[], schema: Schema, maxTokens: number) {
  const sys = `${system}

FORMATO DI RISPOSTA: rispondi esclusivamente con un oggetto JSON valido, senza testo prima o dopo, che rispetti questo JSON Schema (tutti i campi "required" sono obbligatori):
${JSON.stringify(schema)}`;
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL, max_tokens: maxTokens, temperature: 0.8,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: sys }, ...messages],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { status: res.status, error: data?.error?.message || `HTTP ${res.status}` };
  return { status: 200, text: data?.choices?.[0]?.message?.content || '' };
}

async function ai<T>(system: string, messages: Msg[], schema: Schema, opts: { maxTokens?: number; effort?: string } = {}): Promise<T> {
  if (!API_KEY) throw new HttpError(500, 'Manca AI_API_KEY nei segreti della funzione Supabase');
  const msgs = normalise(messages);
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = PROVIDER === 'anthropic'
      ? await callAnthropic(system, msgs, schema, opts.maxTokens ?? 3000, opts.effort ?? 'low')
      : await callOpenAICompat(system, msgs, schema, opts.maxTokens ?? 1500);
    if (r.status === 429 || r.status >= 500) {
      lastErr = r.error || String(r.status);
      await new Promise(res => setTimeout(res, 1200 * (attempt + 1)));
      continue;
    }
    if (r.status !== 200) {
      if (r.error === 'refusal') throw new HttpError(422, 'Selene ha preferito non rispondere a questo messaggio');
      throw new HttpError(502, `AI: ${r.error}`);
    }
    try { return parseJson(r.text || '') as T; }
    catch { lastErr = 'risposta non in formato JSON'; }
  }
  if (/rate|limit|quota/i.test(lastErr)) throw new HttpError(429, 'Selene è molto richiesta in questo momento: riprova tra un minuto');
  throw new HttpError(502, `Selene non risponde (${lastErr}), riprova`);
}

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v.trim() : fallback);

// ── persona ─────────────────────────────────────────────────────
const SELENE = `Sei Selene, la guida di PippiLove: un'app privata usata solo da una coppia sposata di adulti (due persone, in Italia) per esplorare e nutrire la propria sessualità.
Il tuo approccio è quello di una sessuologa clinica esperta, calda e senza giudizio. Conosci il modello del doppio controllo (acceleratori e freni del desiderio), la differenza tra desiderio spontaneo e reattivo, l'importanza del contesto, della sicurezza emotiva, della novità, del gioco e della comunicazione.
Non sei una terapeuta: se emergono dolore fisico, traumi, violenza, disfunzioni o sofferenza importante, accogli con delicatezza, non trasformarlo in gioco e suggerisci di parlarne con un medico o una/un sessuologa/o.
Scrivi sempre in italiano, con tono intimo, elegante, ironico quando serve, mai volgare. Parli di sesso con naturalezza ma non scrivi descrizioni sessuali esplicite o grafiche: evochi, suggerisci, proponi.
Consenso, rispetto dei limiti e parola di sicurezza vengono prima di tutto. Non spingi mai oltre un "no".
Ciò che una persona ti confida resta riservato: puoi usarlo per ispirare proposte, ma non riporti mai all'altra persona le sue parole o dettagli intimi riconoscibili.`;

// ── dati ────────────────────────────────────────────────────────
type Ctx = {
  db: SupabaseClient; me: string; partner: string | null; couple: string | null;
  names: Record<string, string>; safeWord: string | null;
};

async function loadCtx(db: SupabaseClient, me: string): Promise<Ctx> {
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

type Checkin = { day: string; mood?: number; energy?: number; stress?: number; desire?: number; time_tonight?: string; note?: string; wish?: string; updated_at?: string };

const fmtCheckin = (c: Checkin | undefined, withPrivate: boolean) => c
  ? `umore ${c.mood ?? '?'}/5, energia ${c.energy ?? '?'}/5, stress ${c.stress ?? '?'}/5, voglia ${c.desire ?? '?'}/5${c.time_tonight ? `, tempo per noi stasera: ${c.time_tonight}` : ''}`
    + (withPrivate && c.note ? `\n  com'è andata la giornata: ${c.note}` : '')
    + (c.wish ? `\n  desiderio verso l'altro: ${c.wish}` : '')
  : 'nessun check-in';

async function personDossier(ctx: Ctx, id: string, opts: { forPartner: boolean }) {
  const { db } = ctx;
  const [ins, chk] = await Promise.all([
    db.from('insights').select('topic, note, shareable').eq('user_id', id).order('id', { ascending: true }).limit(120),
    db.from('checkins').select('*').eq('user_id', id).order('day', { ascending: false }).limit(5),
  ]);
  const notes = (ins.data || []).filter(i => !opts.forPartner || i.shareable);
  const limits = notes.filter(i => i.topic === 'limiti').map(i => `- ${i.note}`);
  const other = notes.filter(i => i.topic !== 'limiti').map(i => `- [${i.topic}] ${i.note}`);
  // i limiti si rispettano sempre, anche quelli segnati come privati
  const hardLimits = (ins.data || []).filter(i => i.topic === 'limiti' && !i.shareable).length;
  const checkins = ((chk.data || []) as Checkin[]).map(c => `- ${c.day}: ${fmtCheckin(c, !opts.forPartner)}`);
  return [
    `Nome: ${ctx.names[id]}`,
    `LIMITI (non proporre mai nulla che li tocchi):\n${limits.join('\n') || '— nessuno dichiarato'}${hardLimits ? `\n(+ ${hardLimits} limiti riservati: resta su proposte delicate se hai dubbi)` : ''}`,
    `Appunti di Selene dai colloqui:\n${other.join('\n') || '— ancora pochi'}`,
    `Check-in recenti:\n${checkins.join('\n') || '—'}`,
  ].join('\n');
}

async function currentWeek(db: SupabaseClient): Promise<string> {
  const { data } = await db.rpc('current_week');
  return data as string;
}

function romeToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const TOPICS = ['desiderio', 'acceleratori', 'freni', 'corpo', 'fantasie', 'limiti', 'comunicazione', 'emozioni', 'storia', 'contesto', 'coppia', 'preferenze'];

// ── colloquio ───────────────────────────────────────────────────
const INTERVIEW_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'Il tuo messaggio: breve (2-5 frasi), con UNA sola domanda finale.' },
    new_insights: {
      type: 'array',
      description: 'Solo informazioni nuove emerse dall\'ultimo messaggio della persona (spesso 0-3).',
      items: {
        type: 'object',
        properties: {
          topic: { type: 'string', enum: TOPICS },
          note: { type: 'string', description: 'Appunto sintetico in terza persona.' },
          shareable: { type: 'boolean', description: 'false se la persona ha chiesto di tenerlo per sé o è troppo delicato per ispirare missioni.' },
        },
        required: ['topic', 'note', 'shareable'],
        additionalProperties: false,
      },
    },
    phase: { type: 'string', enum: ['accoglienza', 'storia', 'corpo', 'desiderio', 'freni', 'fantasie', 'comunicazione', 'coppia', 'oggi', 'chiusura'] },
    progress: { type: 'integer', description: 'Quanto ti senti di conoscere la persona, da 0 a 100.' },
  },
  required: ['reply', 'new_insights', 'phase', 'progress'],
  additionalProperties: false,
};

type InterviewOut = { reply: string; new_insights: { topic: string; note: string; shareable: boolean }[]; phase: string; progress: number };

async function interview(ctx: Ctx, message: string | undefined) {
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
  const { data: hist } = await db.from('interview_messages').select('role, content')
    .eq('user_id', me).order('id', { ascending: false }).limit(40);
  const history = ((hist || []) as Msg[]).reverse();
  if (!text && history.length && history[history.length - 1].role === 'assistant') {
    return { reply: history[history.length - 1].content, resumed: true };
  }

  const dossier = await personDossier(ctx, me, { forPartner: false });
  const partnerName = ctx.partner ? ctx.names[ctx.partner] : 'il/la partner';
  const first = history.length === 0 || (history.length === 1 && history[0].role === 'user' && !text);
  const system = `${SELENE}

Stai facendo un colloquio individuale con ${ctx.names[me]} (partner: ${partnerName}). Lo scopo è conoscere a fondo la sua sessualità per creare poi missioni e consigli di coppia su misura.
Conduci come una sessuologa in seduta:
- una domanda alla volta, aperta e concreta, che parte da ciò che la persona ha appena detto;
- prima di andare avanti rifletti in una frase ciò che hai capito, con calore;
- chiedi esempi, sensazioni nel corpo, momenti precisi, il perché;
- se la risposta è breve o vaga, approfondisci con gentilezza invece di cambiare argomento;
- non proporre mai opzioni da scegliere né elenchi: lascia spazio alle sue parole;
- esplora gradualmente: accoglienza → storia ed educazione → rapporto con il corpo → cosa accende il desiderio → cosa lo spegne → fantasie e curiosità → limiti → comunicazione e consenso → la coppia oggi;
- tieni conto di come sta oggi (check-in): se è stanca/o o giù, vai piano;
- se la persona è a disagio, rallenta; se vuole fermarsi, chiudi con dolcezza.
${first ? 'È l\'inizio: presentati in poche righe, spiega che tutto resta riservato (userai ciò che dice solo per ispirare le missioni, senza mai riportare le sue parole a ' + partnerName + '; può dirti "questo tienilo per te") e fai la prima domanda, leggera.' : ''}
In new_insights annota SOLO ciò che è emerso di nuovo nell'ultimo messaggio. Usa topic "limiti" per tutto ciò che non vuole fare o ricevere.

Cosa sai già di ${ctx.names[me]}:
${dossier}`;

  const out = await ai<InterviewOut>(system, history, INTERVIEW_SCHEMA, { maxTokens: 2500, effort: 'low' });
  const reply = str(out?.reply);
  if (!reply) throw new HttpError(502, 'Selene si è persa un attimo, riprova');

  await db.from('interview_messages').insert({ user_id: me, role: 'assistant', content: reply });
  const fresh = (Array.isArray(out.new_insights) ? out.new_insights : [])
    .filter(i => i && str(i.note))
    .slice(0, 6)
    .map(i => ({ user_id: me, topic: TOPICS.includes(i.topic) ? i.topic : 'preferenze', note: str(i.note), shareable: i.shareable !== false, source: 'interview' }));
  if (fresh.length) await db.from('insights').insert(fresh);

  // tieni la memoria ordinata
  const { count: total } = await db.from('insights').select('id', { count: 'exact', head: true }).eq('user_id', me);
  if ((total ?? 0) > CONSOLIDATE_OVER) {
    const job = consolidate(ctx).catch(e => console.error('consolidate', e));
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    if (rt?.waitUntil) rt.waitUntil(job); else await job;
  }

  return { reply, phase: str(out.phase), progress: Math.max(0, Math.min(100, Number(out.progress) | 0)), learned: fresh.length };
}

const CONSOLIDATE_SCHEMA = {
  type: 'object',
  properties: {
    notes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          topic: { type: 'string', enum: TOPICS },
          note: { type: 'string' },
          shareable: { type: 'boolean' },
        },
        required: ['topic', 'note', 'shareable'],
        additionalProperties: false,
      },
    },
  },
  required: ['notes'],
  additionalProperties: false,
};

async function consolidate(ctx: Ctx) {
  const { db, me } = ctx;
  const { data: rows } = await db.from('insights').select('id, topic, note, shareable').eq('user_id', me).order('id');
  if (!rows || rows.length <= CONSOLIDATE_OVER) return;
  const out = await ai<{ notes: { topic: string; note: string; shareable: boolean }[] }>(
    `${SELENE}\n\nRiordina gli appunti su ${ctx.names[me]}: unisci i doppioni, tieni le informazioni più recenti quando si contraddicono, non inventare nulla, non perdere mai un limite. Massimo 35 appunti. Se uno degli appunti uniti era riservato (shareable false), anche il risultato lo è.`,
    [{ role: 'user', content: rows.map(r => `- [${r.topic}] (${r.shareable ? 'condivisibile' : 'riservato'}) ${r.note}`).join('\n') }],
    CONSOLIDATE_SCHEMA, { maxTokens: 4000, effort: 'medium' });
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
    title: { type: 'string', description: 'Titolo evocativo, 2-5 parole.' },
    mission: { type: 'string', description: 'La missione, rivolta a chi la deve fare (seconda persona), 2-4 frasi concrete. Usa il nome di chi la riceve.' },
    why: { type: 'string', description: 'Una frase per chi la fa: perché è pensata per l\'altra persona, senza citare confidenze.' },
    category: { type: 'string', enum: ['romance', 'touch', 'tease', 'words', 'places', 'explore'] },
    intensity: { type: 'integer', description: '1 dolce, 2 audace, 3 molto audace' },
    proposal_id: { type: 'string', description: 'id della proposta personale usata, oppure stringa vuota' },
  },
  required: ['title', 'mission', 'why', 'category', 'intensity', 'proposal_id'],
  additionalProperties: false,
};

type Mission = { title: string; mission: string; why: string; category: string; intensity: number; proposal_id: string | null };

async function createMission(ctx: Ctx, week: string, giver: string, receiver: string, extra = ''): Promise<Mission> {
  const { db } = ctx;
  const [recvDossier, giverDossier, props, hist] = await Promise.all([
    personDossier(ctx, receiver, { forPartner: true }),
    personDossier(ctx, giver, { forPartner: true }),
    db.from('proposals').select('id, author_id, kind, body, intensity').eq('couple_id', ctx.couple!),
    db.from('challenges').select('week_start, giver_id, ai_title, proposal_id, status, rating, feedback')
      .eq('couple_id', ctx.couple!).order('week_start', { ascending: false }).limit(16),
  ]);
  const used = new Set((hist.data || []).filter(h => h.proposal_id && (h.status === 'done' || h.week_start === week)).map(h => h.proposal_id));
  const eligible = (props.data || []).filter(p => !used.has(p.id) && (
    (p.kind === 'receive' && p.author_id === receiver) || (p.kind === 'give' && p.author_id === giver) || p.kind === 'together'));
  const doneCount = (hist.data || []).filter(h => h.status === 'done').length;
  const level = Math.min(3, 1 + Math.floor(doneCount / 5));
  const history = (hist.data || []).map(h =>
    `- ${h.week_start} ${ctx.names[h.giver_id]} → ${h.ai_title || '(missione)'}: ${h.status === 'done' ? 'fatta' : 'in corso'}${h.rating ? `, voto ${h.rating}/5` : ''}${h.feedback ? `, commento: "${h.feedback}"` : ''}`);
  const giverName = ctx.names[giver], recvName = ctx.names[receiver];

  const system = `${SELENE}

Ogni settimana crei UNA missione: qualcosa che ${giverName} farà per ${recvName}. ${recvName} non saprà cosa sarà finché non sarà fatta.
Regole:
- Deve nutrire ciò che accende ${recvName} (desideri, acceleratori, bisogni emotivi, check-in recenti) ed essere qualcosa che ${giverName} può fare volentieri.
- MAI proporre qualcosa che tocchi i LIMITI di uno dei due.
- Livello attuale della coppia: ${level}/3. Scendi se i check-in raccontano stanchezza o stress; sali solo se entrambi sembrano pronti.
- Concreta, realizzabile in una settimana, originale e personale. Varia rispetto alle ultime settimane; tieni conto dei voti (riprendi lo spirito di ciò che è piaciuto, evita ciò che ha preso voti bassi).
- Se c'è una proposta personale adatta, puoi costruire la missione su di essa (priorità alle proposte "receive" scritte da ${recvName}): in quel caso metti il suo id in proposal_id e rispettane il contenuto. Altrimenti proposal_id = "".
- Non citare mai confidenze o parole dei colloqui: trasformale in un'idea.
${ctx.safeWord ? `- Se la missione è audace, ricorda la parola di sicurezza della coppia: "${ctx.safeWord}".` : '- Se la missione è audace, ricorda di concordare prima una parola di sicurezza.'}`;

  const user = `CHI RICEVE — ${recvName}
${recvDossier}

CHI FA — ${giverName}
${giverDossier}

PROPOSTE PERSONALI DISPONIBILI:
${eligible.map(p => `- id ${p.id} · scritta da ${ctx.names[p.author_id]} · tipo ${p.kind} · intensità ${p.intensity}: "${p.body}"`).join('\n') || '—'}

STORICO RECENTE:
${history.join('\n') || '— (prima settimana)'}
${extra}
Scrivi la missione della settimana del ${week} per ${giverName}.`;

  const m = await ai<Mission>(system, [{ role: 'user', content: user }], MISSION_SCHEMA, { maxTokens: 3000, effort: 'medium' });
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

async function draw(ctx: Ctx) {
  if (!ctx.couple || !ctx.partner) return { ok: false, reason: 'partner' };
  if (!(await readiness(ctx))) return { ok: false, reason: 'colloquio' };
  const week = await currentWeek(ctx.db);
  const { data: existing } = await ctx.db.from('challenges').select('giver_id').eq('couple_id', ctx.couple).eq('week_start', week);
  const have = new Set((existing || []).map(e => e.giver_id));
  const pairs = [[ctx.me, ctx.partner], [ctx.partner, ctx.me]].filter(([g]) => !have.has(g));
  // le due missioni una dopo l'altra, così la seconda sa qual è la prima
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

async function reroll(ctx: Ctx, challengeId: string, reason: string | undefined) {
  const { data: ch } = await ctx.db.from('challenges').select('*').eq('id', challengeId).single();
  if (!ch || ch.giver_id !== ctx.me || ch.status !== 'pending') throw new HttpError(404, 'Missione non trovata');
  if (ch.rerolls >= 2) throw new HttpError(400, 'Hai già cambiato missione 2 volte questa settimana');
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
    headline: { type: 'string', description: 'Titolo breve e caldo per oggi.' },
    reading: { type: 'string', description: '1-2 frasi: come leggi la giornata della persona e il clima di coppia, con empatia.' },
    gesture: { type: 'string', description: 'Un piccolo gesto concreto da fare oggi per il/la partner.' },
    mission_tip: { type: 'string', description: 'Se c\'è una missione in corso: se e come portarla avanti oggi, adattandola a come stanno entrambi. Altrimenti stringa vuota.' },
    self_care: { type: 'string', description: 'Un suggerimento per sé, per accendere o proteggere il proprio desiderio oggi.' },
    question: { type: 'string', description: 'Una domanda da fare al/la partner stasera.' },
    mood_color: { type: 'string', enum: ['quiete', 'tenerezza', 'gioco', 'passione', 'cura'], description: 'Il tono della giornata, usato per i colori dell\'app.' },
  },
  required: ['headline', 'reading', 'gesture', 'mission_tip', 'self_care', 'question', 'mood_color'],
  additionalProperties: false,
};

async function today(ctx: Ctx, force: boolean) {
  const { db, me, partner } = ctx;
  const day = romeToday();
  const ids = [me, partner].filter(Boolean) as string[];
  const { data: chks } = await db.from('checkins').select('*').eq('day', day).in('user_id', ids);
  const mine = (chks || []).find(c => c.user_id === me) as Checkin | undefined;
  if (!mine) throw new HttpError(400, 'Prima raccontami come stai oggi');
  const theirs = (chks || []).find(c => c.user_id === partner) as Checkin | undefined;
  const basis = `${mine.updated_at}|${theirs?.updated_at ?? ''}`;

  if (!force) {
    const { data: cached } = await db.from('daily_tips').select('content, basis').eq('user_id', me).eq('day', day).maybeSingle();
    if (cached && cached.basis === basis) return cached.content;
  }

  const week = await currentWeek(db);
  const { data: ch } = await db.from('challenges').select('ai_title, ai_text, status')
    .eq('giver_id', me).eq('week_start', week).maybeSingle();
  const myName = ctx.names[me], pName = partner ? ctx.names[partner] : 'il/la partner';

  const system = `${SELENE}

Oggi aiuti ${myName} a vivere la giornata in modo da nutrire l'intimità con ${pName}, partendo da come stanno entrambi OGGI e da ciò che è successo.
Il check-in di ${pName} ti serve per capire come starle/gli vicino: non citare le sue parole né dettagli privati; al massimo indicazioni di tono ("oggi meglio la dolcezza"). Il suo "desiderio verso l'altro" invece puoi tradurlo in un suggerimento concreto, senza dire che l'ha scritto.
Se uno dei due è stanco, stressato o giù, proponi calore, ascolto e contatto senza pressione: il desiderio nasce dal contesto giusto. Se l'energia c'è, osa di più.
Sii specifica, breve, mai generica. Niente elenchi.`;

  const user = `${myName.toUpperCase()} OGGI (${day}):
${fmtCheckin(mine, true)}

${pName.toUpperCase()} OGGI:
${theirs ? fmtCheckin(theirs, true) : 'non ha ancora fatto il check-in'}

CHI È ${myName}:
${await personDossier(ctx, me, { forPartner: false })}

CHI È ${pName}:
${partner ? await personDossier(ctx, partner, { forPartner: true }) : '—'}

MISSIONE DI ${myName} PER ${pName} QUESTA SETTIMANA:
${ch && ch.status === 'pending' ? `${ch.ai_title} — ${ch.ai_text}` : 'nessuna in corso'}`;

  const out = await ai<Record<string, unknown>>(system, [{ role: 'user', content: user }], TODAY_SCHEMA, { maxTokens: 2500, effort: 'low' });
  const clean = {
    headline: str(out.headline, 'Oggi'), reading: str(out.reading), gesture: str(out.gesture),
    mission_tip: str(out.mission_tip) || null, self_care: str(out.self_care), question: str(out.question),
    mood_color: ['quiete', 'tenerezza', 'gioco', 'passione', 'cura'].includes(out.mood_color as string) ? out.mood_color : 'tenerezza',
  };
  await db.from('daily_tips').upsert({ user_id: me, day, content: clean, basis });
  return clean;
}

// ── server ──────────────────────────────────────────────────────
Deno.serve(async (req) => {
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
      case 'interview_reset': {
        await db.from('interview_messages').delete().eq('user_id', user.id);
        return json({ ok: true });
      }
      case 'draw': return json(await draw(ctx));
      case 'reroll': return json(await reroll(ctx, body.challenge_id, body.reason));
      case 'today': return json(await today(ctx, !!body.force));
      case 'ping': return json({ ok: true, provider: PROVIDER, model: MODEL, key: !!API_KEY });
      default: throw new HttpError(400, 'Azione sconosciuta');
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    console.error(e);
    return json({ error: (e as Error).message || 'Errore' }, status);
  }
});
