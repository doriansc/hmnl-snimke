// Raspored utakmica s HNS Semafora (semafor.hns.family, podaci iz COMET-a).
// Parsira stranicu natjecanja ".../natjecanja/<id>/<naziv>/detaljno/".
// Čita se samo prvi popis utakmica na stranici (ligaški dio, kola 1–18); play-off je poseban popis.

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = s => String(s ?? "")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
  .replace(/\s+/g, " ").trim();

const attr = (tag, name) => (tag.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];

export function parseSemafor(html) {
  const start = html.indexOf('class="matchlist');
  if (start < 0) return [];
  const next = html.indexOf('class="matchlist', start + 16);
  const block = html.slice(start, next > 0 ? next : undefined);

  const out = [];
  for (const m of block.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/g)) {
    const tag = m[1], body = m[2];
    const id = attr(tag, "data-match"), round = attr(tag, "data-round");
    if (!id || !round) continue;

    const date = decode((body.match(/<div class="date">([\s\S]*?)<\/div>/) || [])[1]);
    const dm = date.match(/^(\d{2})\.(\d{2})\.(\d{4})\.?\s*(\d{1,2}:\d{2})?/);
    if (!dm) continue;
    const club = n => {
      const c = body.match(new RegExp(`<div class="club${n}"[^>]*?data-id="(\\d+)"[^>]*>\\s*<a[^>]*>([^<]*)`));
      return c ? { id: c[1], name: decode(c[2]) } : null;
    };
    const home = club(1), away = club(2);
    if (!home || !away) continue;
    const r1 = decode((body.match(/<div class="res1">([^<]*)</) || [])[1]);
    const r2 = decode((body.match(/<div class="res2">([^<]*)</) || [])[1]);

    out.push({
      id, round: +round,
      date: `${dm[3]}-${dm[2]}-${dm[1]}`,
      time: dm[4] ? dm[4].padStart(5, "0") : null,
      homeId: home.id, homeName: home.name,
      awayId: away.id, awayName: away.name,
      score: /^\d+$/.test(r1) && /^\d+$/.test(r2) ? `${r1}:${r2}` : null,
      venue: decode((body.match(/<div class="facility">([^<]*)</) || [])[1]) || null
    });
  }
  return out;
}

export async function fetchSemafor(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (HMNL snimke; GitHub Actions)", "Accept-Language": "hr" } });
  if (!r.ok) throw new Error(`Semafor ${r.status}`);
  const matches = parseSemafor(await r.text());
  if (matches.length === 0) throw new Error("Semafor: nije pronađena nijedna utakmica (promijenjen izgled stranice?)");
  return matches;
}
