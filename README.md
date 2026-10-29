# PippiLove ♥

Un’app privata per due: esplorare la vostra sessualità con **Selene**, una guida AI con l’approccio di una sessuologa.

- **Colloquio con Selene** — domande aperte, una alla volta, che scavano a partire da quello che rispondi. Selene prende appunti (il tuo *ritratto*): li vedi solo tu e puoi cancellarli o escluderli dalle missioni.
- **Check-in del giorno** — racconti com’è andata, che energia e che voglia hai, cosa vorresti dall’altra persona. Selene adatta il consiglio di oggi (gesto, domanda per la sera, se è il momento giusto per la missione) a come state *entrambi*.
- **Missioni settimanali** — ogni lunedì Selene scrive una missione a testa: una cosa da fare per l’altra persona, pensata su ciò che la accende. Chi riceve la scopre solo a missione fatta (busta che si apre) e la vota. Se non te la senti, la cambi (2 volte a settimana).
- **Busta segreta** — se sai già cosa vorresti, scrivilo: Selene ci costruirà una missione.
- **Privacy** — colloqui, ritratto e check-in sono leggibili solo da chi li scrive (regole di sicurezza del database). L’AI li usa per ispirare missioni senza mai riportare le parole dell’altra persona.

Tecnica: PWA (HTML/CSS/JS senza build) su GitHub Pages · database e login su Supabase · AI tramite una funzione Supabase, così la chiave non sta mai sul telefono.

---

## Messa in funzione (circa 15 minuti, una volta sola)

### 1. Supabase (gratis)
1. Crea un progetto su [supabase.com](https://supabase.com) (regione consigliata: *Frankfurt*). Annota la **password del database**.
2. *Authentication → Sign In / Providers → Email*: disattiva **Confirm email** (così vi registrate subito, senza mail di conferma).
3. *Project Settings → API*: copia **Project URL** e la chiave **anon / publishable**. Il **Project ref** è il codice in `https://<ref>.supabase.co`.
4. Dal tuo account Supabase: *Account → Access Tokens → Generate new token* (serve a GitHub per pubblicare database e funzione).

### 2. Chiave AI gratuita (Groq)
Crea una chiave su [console.groq.com/keys](https://console.groq.com/keys). Il piano gratuito basta per due persone.
Selene prova da sola, in ordine, `openai/gpt-oss-120b` → `qwen/qwen3.8-27b` → `openai/gpt-oss-20b`: se un modello non è disponibile per il tuo account o ha finito la quota del giorno, passa al successivo. Con il segreto `AI_MODEL` puoi indicarne uno da provare per primo.

> Vuoi usare Claude (più bravo, a consumo, pochi centesimi al mese con Haiku)? Metti la chiave di [platform.claude.com](https://platform.claude.com) in `AI_API_KEY` e la variabile `AI_PROVIDER = anthropic`.

### 3. GitHub → Settings → Secrets and variables → Actions
**Secrets**
| Nome | Valore |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | il token del punto 1.4 |
| `SUPABASE_DB_PASSWORD` | la password del database |
| `AI_API_KEY` | la chiave Groq (o Anthropic) |

**Variables**
| Nome | Valore |
|---|---|
| `SUPABASE_PROJECT_REF` | il codice del progetto |
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | la chiave anon / publishable |
| `AI_PROVIDER` | facoltativo: `groq` (predefinito) o `anthropic` |

### 4. GitHub Pages
*Settings → Pages → Build and deployment → Source: **GitHub Actions***.
Con repository **privato** GitHub Pages richiede un piano a pagamento (GitHub Pro). In alternativa rendi il repository pubblico: nel codice non c’è nessun dato personale (i vostri dati stanno solo su Supabase, protetti da login).

### 5. Pubblica
*Actions → Pubblica PippiLove → Run workflow*. Al termine trovi il link dell’app nel riepilogo del job **sito**.

### 6. Sui telefoni
Apri il link → **iPhone**: Safari → Condividi → *Aggiungi alla schermata Home* · **Android**: Chrome → ⋮ → *Installa app*.
Uno dei due si registra e crea la coppia, l’altra persona si registra ed entra con il codice.

---

## Senza GitHub Actions (a mano)
1. Supabase → *SQL Editor*: incolla il contenuto di `supabase/migrations/20261025120000_pippilove.sql` e premi *Run*.
2. Supabase → *Edge Functions → Deploy a new function → Via editor*: nome `selene`, incolla `supabase/functions/selene/index.ts`, disattiva *Verify JWT*.
3. *Edge Functions → Secrets*: aggiungi `AI_API_KEY` (e se vuoi `AI_PROVIDER`).
4. Apri l’app: al primo avvio chiede URL e chiave Supabase.

## Struttura
```
index.html · css/style.css · js/app.js · js/motion.js · sw.js · manifest.webmanifest · icons/
supabase/migrations/…_pippilove.sql   database e regole di privacy
supabase/functions/selene/index.ts    Selene: colloquio, consiglio del giorno, missioni
.github/workflows/deploy.yml          pubblicazione automatica
```

Nota: Selene non è una terapeuta. Se emergono dolore, disagio o difficoltà importanti, il consiglio giusto è parlarne con un medico o una/un sessuologa/o.
