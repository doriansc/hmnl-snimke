// Snimke utakmica – build za GitHub Pages.
//  1. Za svaku ligu povuče raspored sa HNS Semafora (rezerva: raspored/*.json).
//  2. Iz M365 tenanta lige pročita uploade sa siteova kola (app-only Graph, federated credential).
//  3. Upload poveže s utakmicom: kolo = site kola, klub = račun koji je uploadao, domaćin = iz rasporeda.
//  4. Sve šifrira lozinkama korisnika i priprema mapu site/.
//
// Pokretanje u GitHub Actions: node scripts/build.mjs   (USERS iz Secrets, prijava preko OIDC-a)
// Lokalno s pravim podacima:   CLIENT_SECRET_<ID_LIGE>=... USERS="..." node scripts/build.mjs
// Lokalni test bez M365:        DEMO=1 USERS="demo:demo" node scripts/build.mjs

import { readFile, writeFile, mkdir, cp, rm } from "node:fs/promises";
import { fetchSemafor } from "./semafor.mjs";
import { buildAliases, assignMatch } from "./match.mjs";

const root = new URL("../", import.meta.url);
const cfg = JSON.parse(await readFile(new URL("config.json", root), "utf8"));
const env = process.env;
const GRAPH = env.GRAPH_BASE || "https://graph.microsoft.com/v1.0";
const LOGIN = env.LOGIN_BASE || "https://login.microsoftonline.com";
const ITER = 600_000;
const H = 3600e3;
const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|avi|wmv|webm|mts|m2ts|mpg|mpeg|3gp)$/i;
const roundRe = new RegExp(cfg.roundRegex, "i");
const seasonStart = Date.parse(cfg.seasonStart || "1970-01-01");
// "26/27" → prepoznaje "26/27", "26-27", "2627", "26_27"
const seasonRe = cfg.seasonTag ? new RegExp(cfg.seasonTag.replace(/\D+/g, "\\D?")) : null;
const EARLY_MS = 60 * 60e3;
// isječci (izjave, društvene mreže…) prikazuju se, ali se ne računaju kao snimka utakmice
let clipRe;
const isClip = path => {
  if (clipRe === undefined) clipRe = (cfg.clipPatterns || []).length ? new RegExp(cfg.clipPatterns.map(p => norm(p)).join("|")) : null;
  return !!clipRe && clipRe.test(norm(path));
};   // datoteka stvorena više od 1 h prije početka ne može biti snimka te utakmice
const { subtle } = globalThis.crypto;
const te = new TextEncoder();

const fail = msg => { console.error("GREŠKA: " + msg); process.exit(1); };
const warn = msg => console.log(env.GITHUB_ACTIONS ? `::warning::${msg}` : `UPOZORENJE: ${msg}`);
const b64 = u8 => Buffer.from(u8).toString("base64");
const hex = u8 => Buffer.from(u8).toString("hex");
const rand = n => crypto.getRandomValues(new Uint8Array(n));
const sha256 = async s => new Uint8Array(await subtle.digest("SHA-256", te.encode(s)));
const isSet = v => v && !/^UPISI/i.test(v);
const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/đ/g, "d").replace(/[^a-z0-9]/g, "");
const shortName = s => String(s).replace(/^(H|A)?MNK\s+/i, "");

/* ---------------- korisnici ---------------- */
function parseUsers(raw) {
  const users = (raw || "").split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#")).map(l => {
    const i = l.indexOf(":");
    if (i < 1) fail(`neispravan redak u USERS: "${l.slice(0, 20)}…" (očekuje se korisnik:lozinka)`);
    return { user: l.slice(0, i).trim().toLowerCase(), pass: l.slice(i + 1) };
  });
  if (!users.length) fail("USERS je prazan");
  for (const u of users) if (!env.DEMO && u.pass.length < 14) fail(`lozinka za "${u.user}" je prekratka (min. 14 znakova)`);
  return users;
}

/* ---------------- vrijeme (Europe/Zagreb) ---------------- */
function zagrebISO(date, time) {
  const guess = new Date(`${date}T${time}:00Z`);
  const off = new Intl.DateTimeFormat("en", { timeZone: "Europe/Zagreb", timeZoneName: "longOffset" })
    .formatToParts(guess).find(p => p.type === "timeZoneName").value.replace("GMT", "") || "+00:00";
  return new Date(`${date}T${time}:00${off}`).toISOString();
}

/* ---------------- prijava u tenante ---------------- */
let ghAssertion;
async function githubOidc() {
  if (ghAssertion) return ghAssertion;
  const r = await fetch(`${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent("api://AzureADTokenExchange")}`,
    { headers: { Authorization: "Bearer " + env.ACTIONS_ID_TOKEN_REQUEST_TOKEN } });
  if (!r.ok) throw new Error(`GitHub OIDC token nije dobiven (${r.status}) – provjeri "permissions: id-token: write"`);
  return (ghAssertion = (await r.json()).value);
}
async function getToken(league) {
  const form = { client_id: league.clientId, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" };
  const secret = env[`CLIENT_SECRET_${league.id.toUpperCase()}`];
  if (secret) form.client_secret = secret;
  else if (env.ACTIONS_ID_TOKEN_REQUEST_URL) {
    form.client_assertion_type = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
    form.client_assertion = await githubOidc();
  } else throw new Error(`nema načina prijave (pokreni u GitHub Actions ili postavi CLIENT_SECRET_${league.id.toUpperCase()})`);
  const r = await fetch(`${LOGIN}/${league.tenantId}/oauth2/v2.0/token`, { method: "POST", body: new URLSearchParams(form) });
  const j = await r.json();
  if (!r.ok) throw new Error(`prijava u tenant nije uspjela: ${j.error_description || r.status}`);
  return j.access_token;
}

/* ---------------- Graph ---------------- */
function graphClient(token) {
  const graph = async (url, tries = 0) => {
    const r = await fetch(url.startsWith("http") ? url : GRAPH + url, { headers: { Authorization: "Bearer " + token } });
    if ([429, 503, 504].includes(r.status) && tries < 5) {
      await new Promise(ok => setTimeout(ok, (+r.headers.get("Retry-After") || 2 ** tries) * 1000));
      return graph(url, tries + 1);
    }
    if (!r.ok) { let m = ""; try { m = (await r.json()).error.message; } catch {} throw new Error(`Graph ${r.status} ${m} – ${url}`); }
    return r.json();
  };
  const all = async url => { const out = []; let next = url; while (next) { const j = await graph(next); out.push(...(j.value || [])); next = j["@odata.nextLink"]; } return out; };
  return { graph, all };
}
async function pool(list, n, fn) {
  const res = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) { const k = i++; res[k] = await fn(list[k]); } }));
  return res;
}
function roundOf(site) {
  for (const src of [site.displayName, site.name, decodeURIComponent(site.webUrl || "")]) {
    const m = roundRe.exec(src || "");
    if (m) return +(m[1] || m[2]);
  }
  return null;
}

async function readUploads(league) {
  const { graph, all } = graphClient(await getToken(league));
  const sel = "$select=id,displayName,name,webUrl,createdDateTime";
  let sites;
  if (league.sites.length) sites = await pool(league.sites, 4, p => graph(`/sites/${league.spHost}:${p}?${sel}`));
  else {
    const found = (await all(`/sites?search=${encodeURIComponent(league.siteSearch || "kolo")}&${sel}`)).filter(s => s.webUrl?.includes(league.spHost) && roundOf(s) != null);
    // samo siteovi ove sezone: napravljeni nakon seasonStart ili s oznakom sezone ("26/27") u nazivu/adresi
    const thisSeason = s => Date.parse(s.createdDateTime || 0) >= seasonStart || (seasonRe && seasonRe.test(`${s.displayName} ${decodeURIComponent(s.webUrl || "")}`));
    sites = found.filter(thisSeason);
    const skipped = found.filter(s => !thisSeason(s));
    if (skipped.length) console.log(`   ${league.name}: preskočeno ${skipped.length} siteova iz prošle sezone`);
  }
  if (!sites.length) throw new Error("nije pronađen nijedan site kola ove sezone (provjeri sites / siteSearch / seasonStart u config.json)");

  const perSite = await pool(sites, 4, async site => {
    const num = roundOf(site);
    const drives = (await all(`/sites/${site.id}/drives?$select=id,name,driveType`)).filter(d => d.driveType === "documentLibrary");
    const items = [];
    for (const d of drives) {
      // delta ne vraća parentReference.path, pa se putanja mapa slaže iz samih mapa (id → naziv, roditelj)
      const folders = new Map(), files = [];
      let next = `/drives/${d.id}/root/delta?$select=id,name,file,folder,root,size,createdDateTime,createdBy,webUrl,deleted,parentReference`;
      while (next) {
        const j = await graph(next);
        for (const it of j.value || []) {
          if (it.deleted) continue;
          if (it.folder && !it.root) folders.set(it.id, { name: it.name, parent: it.parentReference?.id });
          if (!it.file) continue;
          const isVideo = (it.file.mimeType || "").startsWith("video/") || VIDEO_EXT.test(it.name);
          if (cfg.onlyVideos && !isVideo) continue;
          files.push(it);
        }
        next = j["@odata.nextLink"];
      }
      const pathOf = id => { const parts = []; for (let f = folders.get(id), guard = 0; f && guard < 20; f = folders.get(f.parent), guard++) parts.unshift(f.name); return parts.join("/"); };
      for (const it of files)
        items.push({ name: it.name, folder: pathOf(it.parentReference?.id), url: it.webUrl, size: it.size || 0, created: it.createdDateTime,
          email: it.createdBy?.user?.email || "", by: it.createdBy?.user?.displayName || "", round: num });
    }
    return { site: { num, label: site.displayName, url: site.webUrl }, items };
  });
  return { sites: perSite.map(s => s.site), items: perSite.flatMap(s => s.items) };
}

/* ---------------- raspored ---------------- */
async function loadSchedule(league) {
  if (!env.DEMO && !env.OFFLINE_SCHEDULE) {
    try { return { matches: await fetchSemafor(league.semaforUrl), source: "semafor" }; }
    catch (e) { warn(`${league.name}: raspored sa Semafora nije dohvaćen (${e.message}) – koristim rezervnu kopiju`); }
  }
  const matches = JSON.parse(await readFile(new URL(league.fallbackSchedule, root), "utf8"));
  return { matches, source: env.DEMO ? "demo" : "rezerva" };
}

/* ---------------- demo podaci ---------------- */
function demoShift(matches) {
  // pomakni raspored tako da je 7. kolo danas: kola 1–6 su odigrana, 7. kolo je u tijeku (rok teče)
  const zg = t => Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zagreb", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(t).map(p => [p.type, p.value]));
  const today = (({ year, month, day }) => `${year}-${month}-${day}`)(zg(new Date()));
  const r7 = matches.find(m => m.round === 7);
  const shiftDays = Math.round((Date.parse(today) - Date.parse(r7.date)) / 864e5);
  const shift = d => new Date(Date.parse(d) + shiftDays * 864e5).toISOString().slice(0, 10);
  let k = 0;
  return matches.map((m, i) => {
    const out = { ...m, date: shift(m.date), time: m.time || ["18:00", "19:00", "20:00", "20:30"][i % 4] };
    if (m.round === 7) { const p = zg(new Date(Date.now() - (6 - k++) * H)); out.date = `${p.year}-${p.month}-${p.day}`; out.time = `${p.hour}:00`; }
    if (!out.score && m.round < 7) out.score = `${(i * 7) % 6}:${(i * 5) % 4}`;
    if (m.round === 7 && k <= 3) out.score = `${k}:1`;
    return out;
  });
}
function demoUploads(league, matches, accountOf) {
  const items = [];
  matches.forEach((m, i) => {
    const kick = Date.parse(zagrebISO(m.date, m.time));
    const h = (i * 37 + m.round * 11) % 100;
    if (kick > Date.now()) return;
    // SHMNL: produkcijska kuća uploada s računa vodstva u mapu "MNK X - MNK Y dd.mm.yyyy"; Prva HMNL: klub domaćin, razni nazivi
    const prod = league.id === "shmnl";
    const [y, mo, d] = m.date.split("-");
    const folder = prod ? `${m.homeName} - ${m.awayName} ${d}.${mo}.${y}` : "";
    const names = [`${shortName(m.homeName)} - ${shortName(m.awayName)}.mp4`, `${shortName(m.homeName).replace(/ /g, "_")}_vs_${shortName(m.awayName).replace(/ /g, "_")}.mp4`, `Snimka ${shortName(m.awayName)} ${d}.${mo}.mp4`];
    const push = (hrs, name) => { const t = kick + hrs * H; if (t < Date.now()) items.push({ name: name || (prod ? `CAM1_${String(1000 + i).slice(1)}.MP4` : names[i % 3]), folder,
      url: "#", size: (1.4 + (h % 5) * 0.5) * 1e9, created: new Date(t).toISOString(),
      email: prod ? "vodstvo@demo" : accountOf(m.homeId), by: prod ? "Vodstvo SHMNL" : shortName(m.homeName), round: m.round }); };
    if (h < 72) push(2 + (h % 18));                                   // u roku
    else if (h < 84) push(26 + (h % 30));                             // kasni
    else if (h < 88) { push(3, "1. poluvrijeme.mp4"); push(3.2, "2. poluvrijeme.mp4"); }   // dvije datoteke
    // ostalo: nedostaje
  });
  // jedna datoteka iz koje se utakmica ne može prepoznati
  const r5 = matches.find(m => m.round === 5);
  if (r5) items.push({ name: "snimka_final.mp4", folder: "", url: "#", size: 2e9, created: new Date(Date.parse(zagrebISO(r5.date, r5.time)) + 30 * H).toISOString(),
    email: "vodstvo@demo", by: league.id === "shmnl" ? "Vodstvo SHMNL" : "PrvaHMNL", round: 5 });
  return { sites: [...new Set(matches.map(m => m.round))].map(n => ({ num: n, label: `${n}. kolo`, url: "#" })), items };
}

/* ---------------- obrada lige ---------------- */
async function processLeague(league) {
  const out = { id: league.id, name: league.name, connected: false, error: null, schedule: {}, clubs: {}, sites: [], matches: [], uploads: [] };

  let { matches, source } = await loadSchedule(league);
  if (env.DEMO) matches = demoShift(matches);
  out.schedule = { source, url: league.semaforUrl.replace(/detaljno\/?$/, "") };

  // klubovi: iz rasporeda, nazivi bez "MNK/HMNK/AMNK", računi iz config.json
  const conf = league.clubs || {};
  for (const m of matches) for (const [id, name] of [[m.homeId, m.homeName], [m.awayId, m.awayName]])
    out.clubs[id] = conf[id]?.name || shortName(name);
  const byAccount = {};
  for (const [id, c] of Object.entries(conf)) for (const a of c.accounts || []) byAccount[a.toLowerCase()] = id;
  const leagueAcc = new Set((league.leagueAccounts || []).map(a => a.toLowerCase()));
  const clubOf = (email, by) => {
    const local = email.toLowerCase().split("@")[0];
    if (leagueAcc.has(local)) return { club: null, label: "Liga" };
    if (byAccount[local]) return { club: byAccount[local], label: out.clubs[byAccount[local]] };
    // rezerva: usporedba s nazivom kluba (npr. račun "hajduk" ili zaslonski naziv "MNK Hajduk").
    // Prihvaća se samo jednoznačno podudaranje ("futsal" bi pasao na dva kluba pa se ne prihvaća).
    for (const cand of [norm(local.replace(/^(h|a)?mnk[._-]?/, "")), norm(shortName(by))]) {
      if (cand.length < 4) continue;
      const exact = Object.entries(out.clubs).filter(([, n]) => norm(n) === cand);
      const hits = exact.length ? exact : Object.entries(out.clubs).filter(([, n]) => { const nn = norm(n); return nn.startsWith(cand) || cand.startsWith(nn); });
      if (hits.length === 1) return { club: hits[0][0], label: hits[0][1] };
    }
    return { club: null, label: by || email || "Nepoznato" };
  };

  out.matches = matches.map(m => {
    const kickoff = zagrebISO(m.date, m.time || "23:59");
    return { id: m.id, round: m.round, kickoff, timeKnown: !!m.time,
      deadline: new Date(Date.parse(kickoff) + cfg.deadlineHours * H).toISOString(),
      home: m.homeId, away: m.awayId, score: m.score };
  });

  let raw = null;
  if (env.DEMO) {
    const accountOf = id => (Object.entries(byAccount).find(([, c]) => c === id)?.[0] || norm(out.clubs[id])) + "@demo";
    raw = demoUploads(league, matches, accountOf);
    out.connected = true;
  } else if (isSet(league.tenantId) && isSet(league.clientId) && isSet(league.spHost)) {
    try { raw = await readUploads(league); out.connected = true; }
    catch (e) { out.error = e.message; warn(`${league.name}: ${e.message.replace(/ – https?:\S+$/, "")}`); }
  }

  if (raw) {
    out.sites = raw.sites.sort((a, b) => (a.num ?? 999) - (b.num ?? 999));
    // utakmica se prepoznaje iz naziva mape i datoteke; rezerva je datum u nazivu, pa klub s čijeg je računa uploadano
    const aliases = buildAliases(out.clubs, Object.fromEntries(Object.entries(conf).map(([id, c]) => [id, c.aliases || []])));
    const roundMatches = r => matches.filter(m => m.round === r).map(m => ({ id: m.id, home: m.homeId, away: m.awayId, date: m.date }));
    out.uploads = raw.items.map(it => {
      const { club, label } = clubOf(it.email, it.by);
      let a = it.round != null ? assignMatch({ path: `${it.folder || ""}/${it.name}`, matches: roundMatches(it.round), aliases, uploaderClub: club })
                               : { match: null, method: null };
      if (a.match) {
        const m = out.matches.find(x => x.id === a.match);
        if (Date.parse(it.created) < Date.parse(m.kickoff) - EARLY_MS) a = { match: null, method: "prije utakmice" };
      }
      return { name: it.name, folder: it.folder || "", url: it.url, size: it.size, created: it.created,
        by: it.by || it.email, uploaderClub: club, uploaderLabel: label, round: it.round, match: a.match, method: a.method,
        clip: isClip(`${it.folder || ""}/${it.name}`) };
    }).sort((a, b) => b.created.localeCompare(a.created));
  }
  // javni log (repozitorij je javan): samo brojevi, bez naziva siteova i datoteka
  const clips = out.uploads.filter(u => u.clip).length, matched = out.uploads.filter(u => u.match && !u.clip).length;
  console.log(`${league.name}: raspored ${matches.length} utakmica (${source}), ` +
    (out.connected ? `${out.sites.length} siteova kola, ${out.uploads.length - clips} snimki (${matched} povezano, ${out.uploads.length - clips - matched} neprepoznato), ${clips} isječaka`
                   : out.error ? "GREŠKA (detalji na stranici)" : "SharePoint nije povezan"));
  return out;
}

/* ---------------- šifriranje ---------------- */
async function encrypt(payload, users) {
  const dek = rand(32);
  const dekKey = await subtle.importKey("raw", dek, "AES-GCM", false, ["encrypt"]);
  const iv = rand(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, dekKey, te.encode(JSON.stringify(payload))));
  const entries = {};
  for (const { user, pass } of users) {
    const salt = await sha256(cfg.saltPrefix + "salt:" + user);
    const base = await subtle.importKey("raw", te.encode(pass), "PBKDF2", false, ["deriveKey"]);
    const kek = await subtle.deriveKey({ name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const wiv = rand(12);
    entries[hex(await sha256(cfg.saltPrefix + "id:" + user))] = { iv: b64(wiv), key: b64(new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: wiv }, kek, dek))) };
  }
  return { v: 2, iter: ITER, saltPrefix: cfg.saltPrefix, iv: b64(iv), data: b64(ct), users: entries };
}

/* ---------------- glavno ---------------- */
const users = parseUsers(env.USERS);
const leagues = [];
for (const l of cfg.leagues) leagues.push(await processLeague(l));

const tried = cfg.leagues.filter(l => env.DEMO || (isSet(l.tenantId) && isSet(l.clientId) && isSet(l.spHost)));
if (tried.length && leagues.every(l => !l.connected)) fail("nijedna liga nije učitana iz M365 – stranica se ne objavljuje (stara verzija ostaje)");

const payload = { generated: new Date().toISOString(), deadlineHours: cfg.deadlineHours, leagues };
const out = new URL("site/", root);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(new URL("public/", root), out, { recursive: true });
await writeFile(new URL("data.json", out), JSON.stringify(await encrypt(payload, users)));
console.log(`OK: ${leagues.length} lige, ${users.length} korisnika`);
