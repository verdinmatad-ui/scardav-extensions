// Fuente de prueba con datos fijos y un stream HLS público. Antes era lib/sources/demo.ts.
// Se oculta o muestra con el interruptor "showDemo" de Ajustes (filtra por id "demo").
const STREAM = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";

module.exports = {
  manifest: { id: "demo", name: "Demo (stream de prueba)", version: 1, lang: "es" },

  async search(q) {
    const all = [{ id: "bbb", title: "Big Buck Bunny" }, { id: "sintel", title: "Sintel" }];
    return all.filter((a) => a.title.toLowerCase().includes(String(q || "").toLowerCase()));
  },
  async getEpisodes(id) {
    return [1, 2, 3].map((n) => ({ id: `${id}:${n}`, number: n, title: `Episodio ${n}` }));
  },
  async getVideoSources() {
    return [{ url: STREAM, quality: "auto" }];
  },
};
