// Prepoznavanje utakmice iz naziva mape i datoteke.
// Nazivi nisu dosljedni ("MNK Crnica - MNK Osijek 25.09.2026", "Torcida_vs_Olmissum.mp4", "CrnicaOsijek"...),
// pa se u putanji traže nazivi klubova. U jednom kolu svaki klub igra jednu utakmicu,
// pa je dovoljan i jedan prepoznat klub; ako se nađu klubovi iz dvije utakmice, datoteka ostaje neprepoznata.

// česte riječi koje se ne smiju same koristiti kao naziv kluba ("poluvrijeme" sadrži "vrijeme", "novi snimak"...)
const GENERIC = new Set(["mnk", "hmnk", "amnk", "futsal", "klub", "club", "vs", "snimka", "snimak", "utakmica", "kolo",
  "vrijeme", "novo", "novi", "mala", "mali", "veliki", "velika", "gornji", "donji", "grad", "sveti"]);

export const normText = s => ` ${String(s || "")
  .normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/đ/g, "d")
  .replace(/[^a-z0-9]+/g, " ").trim()} `;
const compact = s => s.replace(/\s+/g, "");

// Aliasi: puni kratki naziv ("futsal istra pula"), sastavljeni oblik ("novovrijeme"),
// i pojedine riječi od barem 4 slova koje su jedinstvene u ligi ("istra", "pula", "dinamo").
// Riječi koje se ponavljaju u više klubova ("futsal", "split" u "Universitas Split") ne koriste se samostalno,
// osim ako su cijeli naziv kluba ("Split").
export function buildAliases(clubs, extra = {}) {
  const words = {};
  for (const [id, name] of Object.entries(clubs))
    for (const w of new Set(normText(name).trim().split(" "))) (words[w] ||= new Set()).add(id);
  const out = [];
  for (const [id, name] of Object.entries(clubs)) {
    const full = normText(name).trim();
    const set = new Set([full, ...(extra[id] || []).map(a => normText(a).trim())]);
    for (const w of full.split(" ")) if (w.length >= 4 && !GENERIC.has(w) && words[w].size === 1) set.add(w);
    for (const a of set) if (a) out.push({ id, alias: a, compact: compact(a) });
  }
  return out.sort((a, b) => b.alias.length - a.alias.length);   // duži prvi: "universitas split" prije "split"
}

// Koji se klubovi spominju u tekstu (s brojem pojavljivanja)
export function findClubs(text, aliases) {
  let t = normText(text), c = compact(t);
  const found = {};
  for (const { id, alias, compact: ca } of aliases) {
    let hit = false;
    if (t.includes(` ${alias} `)) { t = t.split(` ${alias} `).join(" # "); c = compact(t); hit = true; }
    else if (ca.length >= 5 && c.includes(ca)) { c = c.split(ca).join("#"); hit = true; }
    if (hit) found[id] = (found[id] || 0) + 1;
  }
  return found;
}

const DATE_RE = /(\d{1,2})[.\-_ /](\d{1,2})[.\-_ /](\d{4}|\d{2})(?!\d)|(\d{4})[.\-_](\d{2})[.\-_](\d{2})/g;
export function findDates(text) {
  const out = new Set();
  for (const m of String(text).matchAll(DATE_RE)) {
    let y, mo, d;
    if (m[4]) [y, mo, d] = [m[4], m[5], m[6]];
    else { d = m[1]; mo = m[2]; y = m[3].length === 2 ? "20" + m[3] : m[3]; }
    if (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31) out.add(`${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  return out;
}

// matches: utakmice TOG kola [{id, home, away, date}]; uploaderClub: klub s čijeg je računa uploadano (ili null)
export function assignMatch({ path, matches, aliases, uploaderClub }) {
  const found = findClubs(path, aliases);
  const score = new Map();
  for (const [club, n] of Object.entries(found)) {
    const m = matches.find(x => x.home === club || x.away === club);
    if (m) score.set(m.id, (score.get(m.id) || 0) + n);
  }
  if (score.size) {
    const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked.length === 1 || ranked[0][1] > ranked[1][1]) return { match: ranked[0][0], method: "naziv" };
    return { match: null, method: "dvosmisleno" };
  }
  const dates = findDates(path);
  const byDate = matches.filter(m => dates.has(m.date));
  if (byDate.length === 1) return { match: byDate[0].id, method: "datum" };
  if (uploaderClub) {
    const m = matches.find(x => x.home === uploaderClub || x.away === uploaderClub);
    if (m) return { match: m.id, method: "račun" };
  }
  return { match: null, method: null };
}
