const BASE = "https://ww1.animefenix.vip";
const abs = (u) => (u ? new URL(u, BASE + "/").href : undefined);
const hex2a = (hex) => (hex.match(/.{1,2}/g) || []).map((h) => String.fromCharCode(parseInt(h, 16))).join("");

// Texto de un nodo uniendo cada trozo con un espacio ("streamwish" + "Opción 1" -> "streamwish Opción 1").
// .text() de cheerio los pega sin separador.
const textOf = (node) => {
  const parts = [];
  const walk = (n) => {
    if (n.type === "script" || n.type === "style") return;
    if (n.type === "text") {
      const t = (n.data || "").trim();
      if (t) parts.push(t);
    } else (n.children || []).forEach(walk);
  };
  walk(node);
  return parts.join(" ");
};

module.exports = {
  manifest: { id: "animefenix", name: "AnimeFenix", version: 3, lang: "es", baseUrl: BASE },

  async search(q, ctx) {
    const r = await ctx.http.get(`${BASE}/animes?buscar=${encodeURIComponent(q)}`);
    const $ = ctx.load(r.text);
    return $("article.li").map((_, el) => {
      const href = $(el).find("figure.i a").attr("href") || "";
      const m = href.match(/^(?:\.\/|\/)?([A-Za-z0-9._-]+)$/);
      if (!m) return null;
      const img = $(el).find("figure.i img");
      return {
        id: m[1],
        title: $(el).find("h3.h a").text().trim() || img.attr("alt") || m[1],
        cover: abs(img.attr("data-src")),
      };
    }).get();
  },

  async getEpisodes(animeId, ctx) {
    const r = await ctx.http.get(`${BASE}/${animeId}`);
    const $ = ctx.load(r.text);
    const sl = $("[data-sl]").attr("data-sl");
    if (!sl) throw new Error("animefenix: no se encontró data-sl");
    const m = r.text.match(/var\s+eps\s*=\s*(\[[\s\S]*?\])\s*;/);
    if (!m) throw new Error("animefenix: no se encontró var eps");
    const eps = JSON.parse(m[1]);
    return eps
      .map(([n, cod]) => ({ id: `${sl}-${n}${cod ? `-${cod}` : ""}`, number: Number(n) }))
      .filter((e) => Number.isFinite(e.number))
      .sort((a, b) => a.number - b.number); // el sitio los entrega de mayor a menor
  },

  async getVideoSources(epId, ctx) {
    const pageUrl = `${BASE}/ver/${epId}`;
    const page = await ctx.http.get(pageUrl);
    const token = ctx.load(page.text)(".opt").attr("data-encrypt");
    if (!token) throw new Error("animefenix: no se encontró data-encrypt");
    const r = await ctx.http.post(`${BASE}/fnx`, { acc: "opt", i: token }, { headers: { Referer: pageUrl, Origin: BASE } });
    const $ = ctx.load(r.text);
    const embeds = $("li[encrypt]").map((_, el) => {
      const url = abs(hex2a($(el).attr("encrypt") || ""));
      if (!url || !/^https?:/i.test(url)) return null;
      return { url, quality: textOf(el) || new URL(url).hostname, type: "embed" };
    }).get();
    // El core (lib/resolve.ts) resuelve los embeds de uno en uno y en orden de preferencia.
    return embeds;
  },
};