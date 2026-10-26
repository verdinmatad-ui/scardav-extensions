// Genera el index.json de un repo de extensiones a partir de la carpeta catalog/.
// Uso:  node scripts/make-repo-index.mjs <URL_BASE_RAW> [nombre del repo] [carpeta] [archivo de salida]
// Ejemplo: node scripts/make-repo-index.mjs https://raw.githubusercontent.com/usuario/repo/main/extensions "Mi repo" extensions index.json
// Sin archivo de salida escribe por la salida estándar. En Windows PowerShell 5 NO uses `> index.json`:
// guarda en UTF-16 y la app no puede leerlo. Pasa el archivo de salida como cuarto argumento.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";

const [base, name = "Mi repo", dir = "catalog", out] = process.argv.slice(2);
if (!base) {
  console.error("Uso: node scripts/make-repo-index.mjs <URL_BASE_RAW> [nombre] [carpeta] [archivo de salida]");
  process.exit(1);
}
if (!/^https:\/\//.test(base)) {
  console.error("La URL base debe ser https (la app rechaza cualquier otra).");
  process.exit(1);
}

const extensions = [];
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort()) {
  const bytes = fs.readFileSync(path.join(dir, file)); // el hash se calcula sobre los bytes tal cual
  const module = { exports: {} };
  try {
    vm.runInNewContext(bytes.toString("utf8"), { module, exports: module.exports, console, URL, URLSearchParams, atob, btoa }, { timeout: 2000 });
  } catch (e) {
    console.error(`${file}: no se pudo evaluar (${e.message}); se omite`);
    continue;
  }
  const m = module.exports.manifest;
  if (!m || typeof m.id !== "string" || !/^[a-z0-9_-]{1,40}$/.test(m.id) || typeof m.name !== "string" || !m.name) {
    console.error(`${file}: manifest inválido (id o name); se omite`);
    continue;
  }
  extensions.push({
    id: m.id,
    name: m.name,
    version: Number(m.version) || 1,
    lang: m.lang,
    type: m.type,
    baseUrl: m.baseUrl,
    url: `${base.replace(/\/$/, "")}/${file}`,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  });
}
const json = JSON.stringify({ name, extensions }, null, 2) + "\n";
if (out) {
  fs.writeFileSync(out, json, "utf8"); // UTF-8 sin BOM y con LF
  console.error(`${out}: ${extensions.length} extensión(es)`);
} else {
  process.stdout.write(json);
}
