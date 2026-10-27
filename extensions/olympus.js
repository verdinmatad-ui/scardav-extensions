// Olympus: API JSON del propio sitio. No tiene búsqueda en el servidor, así que el catálogo
// completo se descarga una vez y se guarda con ctx.cache (cada llamada corre en un worker nuevo).
const SITE = "https://olympusxyz.com";
const API = SITE + "/api";
const HEADERS = { Accept: "application/json" };
const TTL = 30 * 60 * 1000;
const MAX_LIST_PAGES = 99; // tope de peticiones por llamada de la app: 100

// Minúsculas, sin acentos ni signos: "¡¡Acero, Sangre!!" → "acero sangre"
const norm = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function json(url, ctx) {
  const r = await ctx.http.get(url, { headers: HEADERS });
  try { return JSON.parse(r.text); } catch { throw new Error(`Olympus no devolvió JSON (HTTP ${r.status}) en ${url}`); }
}

// /api/series/list devuelve todas las series (cómics y novelas); aquí solo se guardan los cómics
async function catalog(ctx) {
  const hit = await ctx.cache.get("catalog");
  if (hit) return hit;

  const first = await json(`${API}/series/list`, ctx);
  let rows = first.data || [];
  const last = Math.min(Number(first.meta?.last_page ?? 1), MAX_LIST_PAGES);
  for (let p = 2; p <= last; p += 8) { // de 8 en 8 en paralelo
    const batch = await Promise.all(
      Array.from({ length: Math.min(8, last - p + 1) }, (_, k) => json(`${API}/series/list?page=${p + k}`, ctx)),
    );
    for (const j of batch) rows = rows.concat(j.data || []);
  }
  const items = rows
    .filter((s) => s.type === "comic" && s.slug && s.name)
    .map((s) => ({ id: s.slug, title: String(s.name).trim(), cover: s.cover || undefined, text: norm(String(s.name)) }));
  if (!items.length) throw new Error("Olympus: la lista de series llegó vacía");
  await ctx.cache.set("catalog", items, TTL);
  return items;
}

module.exports = {
  manifest: {
    id: "olympus",
    name: "Olympus",
    type: "manga",
    apiVersion: 2, // usa ctx.cache (no existe en apps anteriores a las extensiones de manga)
    version: 1,
    lang: "es",
    baseUrl: SITE,
    permissions: { domains: ["imagesolymp.xyz"] },
  },

  // Todas las palabras tienen que aparecer en el título; primero las coincidencias exactas o que empiezan igual
  async search(q, ctx) {
    const tokens = norm(q).split(" ").filter(Boolean);
    if (!tokens.length) return { items: [], hasNext: false };
    const full = tokens.join(" ");
    const rank = (t) => (t === full ? 0 : t.startsWith(tokens[0]) ? 1 : 2);
    const items = (await catalog(ctx))
      .filter((i) => tokens.every((t) => i.text.includes(t)))
      .sort((a, b) => rank(a.text) - rank(b.text) || a.title.length - b.title.length)
      .slice(0, 40)
      .map(({ id, title, cover }) => ({ id, title, cover }));
    return { items, hasNext: false };
  },

  // El id del manga es su slug de la API (sin el prefijo "comic-"). El id del capítulo es "slug/nombre" porque
  // el nombre puede ser decimal ("1.1") y getPages necesita las dos cosas para armar la URL.
  async getChapters(slug, ctx) {
    const url = (p) => `${API}/series/${encodeURIComponent(slug)}/chapters?page=${p}&direction=asc&type=comic`;
    const out = [];
    const add = (rows) => {
      for (const c of rows) {
        const n = parseFloat(c.name);
        const team = String((c.team && c.team.name) || "").trim();
        out.push({
          id: `${slug}/${c.name}`,
          number: Number.isFinite(n) ? n : 0,
          title: Number.isFinite(n) ? undefined : String(c.name),
          group: team && team !== "Olympus" ? team : undefined,
        });
      }
    };
    const first = await json(url(1), ctx);
    add(first.data || []);
    const last = Math.min(Number(first.meta?.last_page ?? 0), 95);
    if (last > 1) {
      // se sabe cuántas páginas hay: se piden de 5 en 5
      for (let p = 2; p <= last; p += 5) {
        const batch = await Promise.all(Array.from({ length: Math.min(5, last - p + 1) }, (_, k) => json(url(p + k), ctx)));
        batch.forEach((j) => add(j.data || []));
      }
    } else if (!last && (first.data || []).length) {
      // sin dato de paginación: se sigue hasta que una página venga vacía o repetida
      let prev = first.data[0].id;
      for (let p = 2; p <= 95; p++) {
        const rows = (await json(url(p), ctx)).data || [];
        if (!rows.length || rows[0].id === prev) break;
        prev = rows[0].id;
        add(rows);
      }
    }
    const seen = new Set();
    return out.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  },

  // Las imágenes del capítulo vienen ya en el HTML de la página (media.imagesolymp.xyz/comics/{serie}/{capítulo}/...)
  // Pasan por /api/proxy con el Referer del sitio (funciona aunque haya protección de hotlink).
  async getPages(chapterId, ctx) {
    const i = chapterId.indexOf("/");
    const slug = chapterId.slice(0, i);
    const name = chapterId.slice(i + 1);
    const r = await ctx.http.get(`${SITE}/series/comic-${encodeURIComponent(slug)}/capitulo/${encodeURIComponent(name)}`);
    const urls = [...new Set([...r.text.matchAll(/https:\/\/media\.imagesolymp\.xyz\/comics\/\d+\/\d+\/[^"'\s<>)\\]+/g)].map((m) => m[0].replace(/&amp;/g, "&")))];
    if (!urls.length) throw new Error(`Olympus: no se encontraron imágenes en el capítulo ${name} (HTTP ${r.status}; ¿cambió la página?)`);
    return urls.map((url) => ({ url, headers: { Referer: SITE + "/" }, direct: false }));
  },
};
