// Teste offline do conversor de bairros. Uso: node scripts/testar-bairros.mjs
import assert from "node:assert/strict";
import { montar, montarAneis, consulta, baixarUm } from "./baixar-bairros.mjs";

const geo = (pts) => pts.map(([lon, lat]) => ({ lon, lat }));
// bairro "Centro" formado por 2 linhas que se juntam em um anel; bairro repetido e outro sem nome são ignorados
const resp = { elements: [
  { type: "relation", tags: { name: "Centro" }, members: [
    { type: "way", role: "outer", geometry: geo([[-54.5, -25.5], [-54.4, -25.5], [-54.4, -25.4]]) },
    { type: "way", role: "outer", geometry: geo([[-54.4, -25.4], [-54.5, -25.4], [-54.5, -25.5]]) } ] },
  { type: "relation", tags: { name: "Centro" }, members: [] },
  { type: "relation", tags: {}, members: [] },
  { type: "relation", tags: { name: "Vila A" }, members: [
    { type: "way", role: "outer", geometry: geo([[-54.3, -25.5], [-54.2, -25.5], [-54.2, -25.4], [-54.3, -25.4], [-54.3, -25.5]]) } ] },
] };
const d = montar(resp);
assert.equal(d.b.length, 2);
assert.deepEqual(d.b.map((b) => b.n), ["Centro", "Vila A"]);
// decodifica o primeiro anel de "Centro" e confere as coordenadas
const r = d.b[0].r[0]; let x = r[0], y = r[1]; const pts = [[x / 1e5, y / 1e5]];
for (let i = 2; i < r.length; i += 2) { x += r[i]; y += r[i + 1]; pts.push([x / 1e5, y / 1e5]); }
assert.deepEqual(pts[0], [-54.5, -25.5]); assert.deepEqual(pts[pts.length - 1], pts[0]);
assert.equal(pts.length, 5);
assert.equal(montarAneis([[[0, 0], [1, 0]]]).length, 0); // linha aberta não vira anel
assert.match(consulta({ id: "4108304", name: "Foz do Iguaçu", uf: "PR" }, true), /IBGE:GEOCODIGO"="4108304/);
// cai na busca por nome quando a busca por código não acha bairros
let chamadas = 0;
const dd = await baixarUm({ id: "1", name: "X", uf: "PR" }, async () => (++chamadas === 1 ? { elements: [] } : resp));
assert.equal(chamadas, 2); assert.equal(dd.b.length, 2);
console.log("Teste dos bairros: ok");
