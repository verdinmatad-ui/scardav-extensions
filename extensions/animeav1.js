// Extensión para https://animeav1.com  (v2, hecha sobre el HTML real del sitio)
// Instalación: copiar a data/extensions/animeav1.js (se recarga sola).
//
// El sitio es SvelteKit: cada página trae sus datos en un script (kit.start(... data: [...])).
// En vez de depender de selectores CSS se leen esos datos:
//   /catalogo?search=&page=&genre=&category=&minYear=&maxYear=  -> results:[{id,title,slug,...}] + pagination
//   /media/<slug>      -> media:{ ..., episodesCount, episodes:[{id,number}] }
//   /media/<slug>/<n>  -> embeds:{SUB:[{server,url}], DUB:[...]}
// Parámetros que acepta /catalogo (declarados por la propia web): page, order, letter, status, genre,
// category, minYear, maxYear, search.
const BASE = "https://animeav1.com";
const COVER = (id) => BASE.replace("//", "//cdn.") + "/covers/" + id + ".jpg"; // https://cdn.animeav1.com/covers/<id>.jpg

// ---------- utilidades de lectura ----------
// Devuelve el texto desde el { o [ de `start` hasta su cierre, respetando comillas.
function balanced(s, start) {
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, q = "";
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return s.slice(start, i + 1);
  }
  return "";
}

// Contenido del primer `key:[` / `key:{` que aparece (con o sin comillas en la clave).
function block(html, key) {
  const m = new RegExp('["\']?' + key + '["\']?\\s*:\\s*[\\[{]').exec(html);
  return m ? balanced(html, m.index + m[0].length - 1) : "";
}

// Los strings del script son literales JS: "a \"b\" \u002F" -> a "b" /
function jsString(raw) {
  try { return JSON.parse('"' + raw + '"'); } catch { return raw.replace(/\\(.)/g, "$1"); }
}

// ---------- Catálogo / búsqueda ----------
function parseResults(html) {
  const arr = block(html, "results");
  const items = [];
  const seen = new Set();
  const starts = [];
  const re = /\{id:"(\d+)",title:"/g;
  let m;
  while ((m = re.exec(arr))) starts.push({ at: m.index, id: m[1] });
  starts.forEach((s, i) => {
    const seg = arr.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : arr.length);
    const t = /title:"((?:[^"\\]|\\.)*)"/.exec(seg);
    const sl = /,slug:"([^"]+)"/.exec(seg);
    if (!t || !sl || seen.has(sl[1])) return;
    seen.add(sl[1]);
    items.push({ id: sl[1], title: jsString(t[1]), cover: COVER(s.id) });
  });
  return items;
}

function listUrl(page, query, f) {
  const p = [];
  if (query) p.push("search=" + encodeURIComponent(query));
  // genre y category son listas: un parámetro repetido por valor
  for (const g of (f.genero || "").split(",")) if (g) p.push("genre=" + encodeURIComponent(g));
  for (const c of (f.tipo || "").split(",")) if (c) p.push("category=" + encodeURIComponent(c));
  if (/^\d{4}$/.test(f.desde || "")) p.push("minYear=" + f.desde);
  if (/^\d{4}$/.test(f.hasta || "")) p.push("maxYear=" + f.hasta);
  if (page > 1) p.push("page=" + page);
  return BASE + "/catalogo" + (p.length ? "?" + p.join("&") : "");
}

async function fetchList(page, query, filters, ctx) {
  const r = await ctx.http.get(listUrl(page, query, filters || {}));
  if (r.status !== 200) throw new Error("AnimeAV1 respondió " + r.status);
  const items = parseResults(r.text);
  const pg = /currentPage:(\d+),recordsPerPage:\d+,totalPages:(\d+)/.exec(r.text);
  const hasNext = pg ? Number(pg[1]) < Number(pg[2]) : items.length > 0;
  return { items, hasNext };
}

// ---------- Servidores del episodio ----------
const unescapeUrl = (u) =>
  u.replace(/\\u002F/gi, "/").replace(/\\\//g, "/").replace(/\\u0026/gi, "&").replace(/&amp;/g, "&");

function parseEmbeds(html) {
  const b = block(html, "embeds"); // solo "embeds": las descargas (Mega, 1Fichier) van aparte en "downloads"
  const out = [];
  const secRe = /["']?(SUB|DUB)["']?\s*:\s*\[/g;
  let s;
  while ((s = secRe.exec(b))) {
    const arr = balanced(b, s.index + s[0].length - 1);
    for (const obj of arr.match(/\{[^{}]*\}/g) || []) {
      const server = /["']?server["']?\s*:\s*["']([^"']+)["']/.exec(obj);
      const url = /["']?url["']?\s*:\s*["']([^"']+)["']/.exec(obj);
      if (server && url) out.push({ lang: s[1], server: server[1], url: unescapeUrl(url[1]) });
    }
  }
  return out.sort((a, b2) => (a.lang === b2.lang ? 0 : a.lang === "SUB" ? -1 : 1));
}

const GENRES = [
  ["accion", "Acción"], ["aventura", "Aventura"], ["ciencia-ficcion", "Ciencia Ficción"], ["comedia", "Comedia"],
  ["deportes", "Deportes"], ["drama", "Drama"], ["fantasia", "Fantasía"], ["misterio", "Misterio"],
  ["recuentos-de-la-vida", "Recuentos de la Vida"], ["romance", "Romance"], ["seinen", "Seinen"],
  ["shoujo", "Shoujo"], ["shounen", "Shounen"], ["sobrenatural", "Sobrenatural"], ["suspenso", "Suspenso"],
  ["terror", "Terror"], ["antropomorfico", "Antropomórfico"], ["artes-marciales", "Artes Marciales"],
  ["carreras", "Carreras"], ["detectives", "Detectives"], ["ecchi", "Ecchi"], ["elenco-adulto", "Elenco Adulto"],
  ["escolares", "Escolares"], ["espacial", "Espacial"], ["gore", "Gore"], ["gourmet", "Gourmet"],
  ["harem", "Harem"], ["historico", "Histórico"], ["idols-hombre", "Idols (Hombre)"],
  ["idols-mujer", "Idols (Mujer)"], ["infantil", "Infantil"], ["isekai", "Isekai"], ["josei", "Josei"],
  ["juegos-estrategia", "Juegos Estrategia"], ["mahou-shoujo", "Mahou Shoujo"], ["mecha", "Mecha"],
  ["militar", "Militar"], ["mitologia", "Mitología"], ["musica", "Música"], ["parodia", "Parodia"],
  ["psicologico", "Psicológico"], ["samurai", "Samurai"], ["shoujo-ai", "Shoujo Ai"],
  ["shounen-ai", "Shounen Ai"], ["superpoderes", "Superpoderes"], ["vampiros", "Vampiros"],
];

module.exports = {
  manifest: {
    id: "animeav1",
    name: "AnimeAV1",
    version: 3,
    lang: "es",
    baseUrl: BASE,
    permissions: {
      domains: ["animeav1.com", "cdn.animeav1.com", "zilla-networks.com", "uns.bio", "voe.sx", "byselapuix.com", "mp4upload.com"],
    },
  },

  // Sin texto ni filtros el catálogo viene ordenado por lo más reciente agregado
  async getLatest(page, ctx) {
    return fetchList(page, "", {}, ctx);
  },

  async getFilters(ctx) {
    return [
      {
        id: "tipo", label: "Tipo", type: "multiselect",
        options: [
          { value: "tv-anime", label: "TV Anime" },
          { value: "pelicula", label: "Película" },
          { value: "ova", label: "OVA" },
          { value: "ona", label: "ONA" },
          { value: "especial", label: "Especial" },
        ],
      },
      { id: "genero", label: "Género", type: "multiselect", options: GENRES.map(([value, label]) => ({ value, label })) },
      { id: "desde", label: "Año desde (1990-2026)", type: "text" },
      { id: "hasta", label: "Año hasta (1990-2026)", type: "text" },
    ];
  },

  async search(q, ctx, opts) {
    const page = (opts && opts.page) || 1;
    return fetchList(page, (q || "").trim(), (opts && opts.filters) || {}, ctx);
  },

  // animeId = slug ("one-piece"); id de episodio = "slug/numero"
  async getEpisodes(animeId, ctx) {
    const r = await ctx.http.get(BASE + "/media/" + encodeURIComponent(animeId));
    if (r.status !== 200) throw new Error("AnimeAV1 respondió " + r.status);
    const nums = new Set();
    // La ficha trae la lista completa: episodes:[{id:3433,number:1},...]
    for (const m of block(r.text, "episodes").matchAll(/number:\s*(\d+(?:\.\d+)?)/g)) nums.add(Number(m[1]));
    return [...nums].sort((a, b) => a - b).map((n) => ({ id: animeId + "/" + n, number: n }));
  },

  async getVideoSources(episodeId, ctx) {
    const i = episodeId.lastIndexOf("/");
    const slug = episodeId.slice(0, i), num = episodeId.slice(i + 1);
    const r = await ctx.http.get(BASE + "/media/" + encodeURIComponent(slug) + "/" + encodeURIComponent(num));
    if (r.status !== 200) throw new Error("AnimeAV1 respondió " + r.status);
    // El core (lib/resolve.ts) convierte los embeds en enlaces directos.
    return parseEmbeds(r.text).map((e) => ({
      url: e.url,
      quality: e.server,
      lang: e.lang, // "SUB" | "DUB"
      type: /\.m3u8(\?|$)/i.test(e.url) ? "hls" : /\.mp4(\?|$)/i.test(e.url) ? "mp4" : "embed",
    }));
  },
};