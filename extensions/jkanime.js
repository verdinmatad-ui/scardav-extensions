// JkAnime (https://jkanime.net). Antes era la fuente integrada lib/sources/jkanime.ts.
// Cambios respecto a la versión integrada (una extensión corre en un worker sin Buffer, process ni globalThis compartido):
//   - process.env.VIDEO_SERVERS_*  -> constantes de abajo (sube manifest.version al cambiarlas)
//   - Buffer.from(x, "base64")     -> atob
//   - globalThis.__jkMeta          -> ctx.cache (cada llamada nace en un worker nuevo)
//   - extract() / hostRank()       -> el core resuelve los embeds (lib/resolve.ts); aquí solo se devuelven
const BASE = "https://jkanime.net";

// Rutas del sitio que no son animes (para filtrar enlaces en la búsqueda)
const NOT_ANIME = new Set([
  "directorio", "horario", "comunidad", "top", "estrenos", "pedidos", "historial", "aplicacion",
  "buscar", "guardado", "aleatorio", "notificaciones", "dash", "usuario", "studio", "ajax",
  "ajax_search", "jkplayer",
]);

// Saca el slug de un enlace tipo https://jkanime.net/{slug}/ (los slugs pueden llevar punto: "...-vs.-konohamaru")
const slugOf = (href) => {
  const m = (href || "").match(/^https:\/\/jkanime\.net\/([a-z0-9._-]+)(?:\/\d+)?\/?$/i);
  return m && !NOT_ANIME.has(m[1]) ? m[1] : undefined;
};

// base64 -> texto (Buffer no existe en las extensiones)
const fromB64 = (s) => {
  const bin = atob(s);
  try { return decodeURIComponent(escape(bin)); } catch { return bin; }
};

// El listado de episodios del sitio viene en páginas de 16.
// MAX_PAGES solo limita el método lento de getEpisodes (series con huecos en la numeración);
// el método rápido (primera + última página) no tiene tope. Tope de peticiones por llamada de la app: 100.
const PER_PAGE = 16;
const MAX_PAGES = 60;

// El id numérico del anime y el token CSRF salen de la página (anime o episodio 1).
// Se recuerdan 20 min por anime con ctx.cache; `local` evita repetir esa consulta dentro de una misma llamada.
const META_TTL = 20 * 60_000;
const local = new Map();
const metaKey = (slug) => "meta:" + slug.slice(0, 150); // las claves de ctx.cache admiten hasta 200 caracteres

async function loadMeta(slug, ctx, force) {
  if (!force) {
    if (local.has(slug)) return local.get(slug);
    try {
      const hit = await ctx.cache.get(metaKey(slug));
      if (hit && hit.id) { local.set(slug, hit); return hit; }
    } catch { /* sin caché: se pide la página */ }
  }
  for (const path of [`/${slug}/`, `/${slug}/1/`]) {
    const r = await ctx.http.get(BASE + path);
    const id = (r.text.match(/ajax\/episodes\/(\d+)/) || [])[1];
    if (id) {
      const meta = { id, token: (r.text.match(/name="csrf-token" content="([^"]+)"/) || [])[1] || "" };
      local.set(slug, meta);
      try { await ctx.cache.set(metaKey(slug), meta, META_TTL); } catch { /* no es grave */ }
      return meta;
    }
  }
  throw new Error("No se encontró el id del anime en la página");
}

// POST /ajax/episodes/{animeId}/{página} con _token. Si el token guardado ya no vale, se pide uno nuevo una vez.
async function episodesPage(slug, p, ctx, retry = true) {
  const { id, token } = await loadMeta(slug, ctx, !retry);
  const r = await ctx.http.post(
    `${BASE}/ajax/episodes/${id}/${p}`,
    { _token: token },
    { headers: { Referer: `${BASE}/${slug}/` } },
  );
  try {
    return JSON.parse(r.text);
  } catch {
    if (!retry) throw new Error(`JkAnime no devolvió la lista de episodios (HTTP ${r.status})`);
    local.delete(slug);
    return episodesPage(slug, p, ctx, false);
  }
}

// Convierte las tarjetas de una lista en animes, sin repetidos (un anime con varios episodios nuevos sale una vez)
function cards($, selector, coverOf) {
  const found = new Map();
  $(selector).each((_, el) => {
    const item = $(el);
    const slug = slugOf(item.find("a[href]").first().attr("href"));
    const title = item.find("h5.card-title").first().text().replace(/\s+/g, " ").trim();
    if (!slug || !title || found.has(slug)) return;
    const cover = (coverOf(item) || "").trim();
    found.set(slug, { id: slug, title, cover: cover || undefined });
  });
  return found;
}

module.exports = {
  manifest: {
    id: "jkanime",
    name: "JkAnime",
    version: 2,
    apiVersion: 2, // usa ctx.cache
    lang: "es",
    baseUrl: BASE,
    permissions: { domains: ["jkanime.net"] },
  },

  // Cada resultado es un .anime__item: la portada va en data-setbg y el título en h5 > a
  async search(q, ctx) {
    const r = await ctx.http.get(`${BASE}/buscar?q=${encodeURIComponent(q)}`);
    const $ = ctx.load(r.text);
    const found = new Map();
    $(".anime__item").each((_, el) => {
      const item = $(el);
      const link = item.find("h5 a").first();
      const slug = slugOf(link.attr("href") || item.find("a[href]").first().attr("href"));
      const title = link.text().replace(/\s+/g, " ").trim();
      if (!slug || !title || found.has(slug)) return;
      const cover = (item.find("[data-setbg]").first().attr("data-setbg") || "").trim();
      found.set(slug, { id: slug, title, cover: cover || undefined });
    });
    return [...found.values()];
  },

  // Primera y última página bastan si la numeración es continua (2 peticiones en vez de hasta 60,
  // que con la pausa de 500 ms por petición superaban el timeout de 30 s en series largas como One Piece).
  // Si hay huecos (especiales, numeración rara), cae al método lento página por página.
  async getEpisodes(slug, ctx) {
    const first = await episodesPage(slug, 1, ctx);
    const lastPage = Number(first.last_page) || 1;
    const tail = lastPage > 1 ? await episodesPage(slug, lastPage, ctx) : first;
    const nums = [...(first.data || []), ...(tail.data || [])].map((e) => Number(e.number)).filter(Number.isFinite);
    if (!nums.length) return [];
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const total = (lastPage - 1) * PER_PAGE + (tail.data || []).length;

    // Numeración sin huecos: se genera el rango completo
    if (max - min + 1 === total) {
      return Array.from({ length: total }, (_, i) => ({ id: `${slug}/${min + i}`, number: min + i }));
    }

    // Con huecos: método lento, página por página (reutiliza la primera)
    const out = [];
    for (let p = 1; p <= MAX_PAGES; p++) {
      const json = p === 1 ? first : await episodesPage(slug, p, ctx);
      const items = json.data || [];
      for (const e of items) out.push({ id: `${slug}/${e.number}`, number: Number(e.number) });
      if (items.length < PER_PAGE || (json.last_page && p >= json.last_page)) break;
    }
    return out;
  },

  // Devuelve los embeds del episodio (el sitio los lista en `var servers` y en `video[n]`)
  async getVideoSources(epId, ctx) {
    const r = await ctx.http.get(`${BASE}/${epId}/`);
    const $ = ctx.load(r.text);
    const names = {};
    $("a.servers[data-id]").each((_, el) => {
      names[$(el).attr("data-id")] = $(el).text().trim();
    });

    const out = [];
    const list = (r.text.match(/var servers = (\[[\s\S]*?\]);/) || [])[1];
    if (list) {
      let servers = [];
      try { servers = JSON.parse(list); } catch { /* se sigue con video[n] */ }
      for (const s of servers) {
        if (/mediafire|1fichier/i.test(s.server)) continue; // solo descarga
        try {
          out.push({ url: fromB64(s.remote).trim(), quality: s.server, type: "embed" });
        } catch { /* enlace con base64 inválido */ }
      }
    }
    for (const m of r.text.matchAll(/video\[(\d+)\]\s*=\s*'<iframe[^>]*src="([^"]+)"/g)) {
      out.push({ url: m[2], quality: names[m[1]] || `Servidor ${m[1]}`, type: "embed" });
    }

    // El core (lib/resolve.ts) elige el orden, prueba los hosts y deja los embeds de respaldo.
    return out;
  },

  // Portada > "Programación": últimos episodios publicados (pestañas Animes y Donghuas).
  // El sitio no pagina esta lista: son ~36 títulos únicos y listo.
  async getLatest(page, ctx) {
    if (page > 1) return { items: [], hasNext: false };
    const r = await ctx.http.get(`${BASE}/`);
    const $ = ctx.load(r.text);
    const found = new Map();
    for (const tab of ["#animes", "#donghuas"]) {
      // data-animepic es la portada del anime; src puede ser la captura del episodio
      const part = cards($, `${tab} .card`, (item) => {
        const img = item.find("img").first();
        return img.attr("data-animepic") || img.attr("src");
      });
      for (const [k, v] of part) if (!found.has(k)) found.set(k, v);
    }
    return { items: [...found.values()], hasNext: false };
  },

  // /top: ranking de 50 títulos en una sola página
  async getPopular(page, ctx) {
    if (page > 1) return { items: [], hasNext: false };
    const r = await ctx.http.get(`${BASE}/top`);
    const $ = ctx.load(r.text);
    const found = cards($, ".toplist .card", (item) => item.find("img").first().attr("src"));
    return { items: [...found.values()], hasNext: false };
  },
};