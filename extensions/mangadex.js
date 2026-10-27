// MangaDex: API pública JSON (https://api.mangadex.org). Sin scraping.
// Idiomas: edita LANGS / FALLBACK y sube manifest.version para publicar el cambio.
const API = "https://api.mangadex.org";
const COVERS = "https://uploads.mangadex.org/covers";

const LANGS = ["es-la", "es"]; // idiomas preferidos
const FALLBACK = ["en"];       // si el título no tiene capítulos en LANGS se prueba con estos ([] lo desactiva)
const RATINGS = ["safe", "suggestive"]; // contenido para adultos excluido
const PER_PAGE = 24;
const KIND = { ja: "manga", ko: "manhwa", zh: "manhua", "zh-hk": "manhua" };

const qs = (parts) =>
  parts.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&").replace(/%5B%5D/g, "[]");

// MangaDex responde 200 o 4xx con { result: "error", errors: [...] }: se muestra el motivo
function parse(text) {
  let j;
  try { j = JSON.parse(text); } catch { throw new Error("MangaDex no devolvió JSON"); }
  if (j.result === "error") throw new Error("MangaDex: " + (j.errors?.[0]?.detail ?? j.errors?.[0]?.title ?? "error desconocido"));
  return j;
}

const pickTitle = (t) => t.es ?? t["es-la"] ?? t.en ?? t["ja-ro"] ?? Object.values(t)[0] ?? "Sin título";

function toManga(m) {
  const file = (m.relationships || []).find((x) => x.type === "cover_art")?.attributes?.fileName;
  return {
    id: m.id,
    title: pickTitle(m.attributes.title || {}),
    cover: file ? `${COVERS}/${m.id}/${file}.256.jpg` : undefined,
    kind: KIND[m.attributes.originalLanguage] || "other",
  };
}

// Listado paginado de títulos. `extra` trae el orden o la búsqueda.
async function list(ctx, page, extra) {
  const offset = (page - 1) * PER_PAGE;
  const params = [
    ["limit", String(PER_PAGE)],
    ["offset", String(offset)],
    ["includes[]", "cover_art"],
    ...RATINGS.map((r) => ["contentRating[]", r]),
    ...LANGS.concat(FALLBACK).map((l) => ["availableTranslatedLanguage[]", l]),
    ...extra,
  ];
  const j = parse((await ctx.http.get(`${API}/manga?${qs(params)}`)).text);
  const data = j.data || [];
  return {
    items: data.map(toManga),
    // MangaDex no deja pedir más allá de offset + limit = 10000
    hasNext: data.length > 0 && offset + data.length < (j.total || 0) && offset + PER_PAGE < 10000,
  };
}

// Todos los capítulos con páginas propias en esos idiomas. `tag` añade el idioma ("EN · grupo")
async function feed(mangaId, langs, tag, ctx) {
  const all = [];
  let offset = 0;
  for (;;) {
    const params = [
      ["limit", "500"],
      ["offset", String(offset)],
      ["order[chapter]", "asc"],
      ["includes[]", "scanlation_group"],
      ...langs.map((l) => ["translatedLanguage[]", l]),
      ...RATINGS.map((r) => ["contentRating[]", r]),
    ];
    const j = parse((await ctx.http.get(`${API}/manga/${mangaId}/feed?${qs(params)}`)).text);
    for (const c of j.data || []) {
      const a = c.attributes;
      if (!a.pages || a.externalUrl) continue; // capítulos externos (sin páginas en MangaDex)
      const n = parseFloat(a.chapter);
      const group = (c.relationships || []).find((x) => x.type === "scanlation_group")?.attributes?.name;
      all.push({
        id: c.id,
        number: Number.isFinite(n) ? n : 0,
        title: a.title || undefined,
        volume: a.volume || undefined,
        group: tag ? [String(a.translatedLanguage || "").toUpperCase(), group].filter(Boolean).join(" · ") : group,
        pages: a.pages,
      });
    }
    offset += (j.data || []).length;
    if (!(j.data || []).length || offset >= j.total) break;
  }
  return all;
}

module.exports = {
  manifest: {
    id: "mangadex",
    name: "MangaDex",
    type: "manga",
    version: 1,
    lang: "es",
    baseUrl: "https://mangadex.org",
    permissions: { domains: ["mangadex.org"] }, // api.mangadex.org y uploads.mangadex.org son subdominios
  },

  async search(q, ctx, { page = 1 } = {}) {
    return list(ctx, page, [["title", q], ["order[relevance]", "desc"]]);
  },

  async getLatest(page, ctx) {
    return list(ctx, page, [["order[latestUploadedChapter]", "desc"]]);
  },

  async getPopular(page, ctx) {
    return list(ctx, page, [["order[followedCount]", "desc"]]);
  },

  async getChapters(mangaId, ctx) {
    let all = await feed(mangaId, LANGS, false, ctx);
    if (!all.length && FALLBACK.length) all = await feed(mangaId, FALLBACK, true, ctx);
    // Varios grupos suben el mismo capítulo: se queda el primero de cada número
    // para que la app no los mande a "Extras" por repetidos.
    const seen = new Set();
    return all.filter((c) => {
      if (c.number === 0) return true;
      if (seen.has(c.number)) return false;
      seen.add(c.number);
      return true;
    });
  },

  async getPages(chapterId, ctx) {
    const j = parse((await ctx.http.get(`${API}/at-home/server/${chapterId}`)).text);
    const { baseUrl, chapter } = j;
    if (!baseUrl || !chapter?.data?.length) throw new Error("capítulo sin páginas");
    // Para ahorrar datos: cambia "data" por "data-saver" y chapter.data por chapter.dataSaver
    return chapter.data.map((f) => ({ url: `${baseUrl}/data/${chapter.hash}/${f}`, direct: true }));
  },
};
