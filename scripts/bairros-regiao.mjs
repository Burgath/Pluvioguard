#!/usr/bin/env node
// Gera data/bairros/<codigo-ibge>.json de TODOS os municípios de uma vez, a partir de um arquivo exportado do
// OpenStreetMap (geojsonseq, um polígono por linha). Não usa o servidor Overpass (que bloqueia o GitHub).
// Uso: node scripts/bairros-regiao.mjs <arquivo.geojsonseq> [pasta-de-saida]
// Município com bairros já gravados é mantido. Município sem bairros no mapa recebe {"v":1,"b":[],"ok":1}.
// Município que não aparece no arquivo (sem limite com IBGE:GEOCODIGO) fica sem arquivo, para outra tentativa.

import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const TOL = 0.00015;

function dp(pts, tol) {
  const n = pts.length;
  if (n < 3) return pts;
  const manter = new Uint8Array(n); manter[0] = manter[n - 1] = 1;
  const pilha = [[0, n - 1]];
  while (pilha.length) {
    const [a, b] = pilha.pop();
    let dmax = 0, im = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      let d;
      if (L === 0) d = Math.hypot(pts[i][0] - ax, pts[i][1] - ay);
      else { const t = Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / L)); d = Math.hypot(pts[i][0] - (ax + t * dx), pts[i][1] - (ay + t * dy)); }
      if (d > dmax) { dmax = d; im = i; }
    }
    if (dmax > tol && im > 0) { manter[im] = 1; pilha.push([a, im], [im, b]); }
  }
  return pts.filter((_, i) => manter[i]);
}

function codificar(anel) {
  const p = dp(anel, TOL).map(([x, y]) => [Math.round(x * 1e5), Math.round(y * 1e5)]);
  const f = p.filter((q, i) => i === 0 || q[0] !== p[i - 1][0] || q[1] !== p[i - 1][1]);
  if (f.length < 4) return null;
  const out = [f[0][0], f[0][1]];
  for (let i = 1; i < f.length; i++) out.push(f[i][0] - f[i - 1][0], f[i][1] - f[i - 1][1]);
  return out;
}

export function aneisDe(g) { // todos os anéis (externos e internos) de um Polygon/MultiPolygon, como listas de [lon,lat]
  if (!g) return [];
  if (g.type === "Polygon") return g.coordinates;
  if (g.type === "MultiPolygon") return [].concat(...g.coordinates);
  return [];
}

export function dentro(aneis, x, y) { // regra par-ímpar
  let c = false;
  for (const r of aneis) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}

function bbox(aneis) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const r of aneis) for (const p of r) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  return [x0, y0, x1, y1];
}

async function linhas(arq, cada) {
  const rl = createInterface({ input: createReadStream(arq), crlfDelay: Infinity });
  for await (let l of rl) {
    l = l.replace(/^\x1e/, "").trim();
    if (l) await cada(l);
  }
}

const RX_MUN = /"admin_level"\s*:\s*"8"/;
const RX_BAIRRO = /"admin_level"\s*:\s*"(9|10)"|"place"\s*:\s*"(suburb|neighbourhood|quarter)"/;

export async function processar(arq, saida, ids) {
  const munis = []; // {id, aneis, bb}
  await linhas(arq, (l) => {
    if (!RX_MUN.test(l) || !l.includes("IBGE:GEOCODIGO")) return;
    let f; try { f = JSON.parse(l); } catch { return; }
    const t = f.properties || {};
    if (t.boundary !== "administrative" || t.admin_level !== "8" || !t["IBGE:GEOCODIGO"]) return;
    const aneis = aneisDe(f.geometry).map((r) => dp(r, 0.0003));
    if (aneis.length) munis.push({ id: String(t["IBGE:GEOCODIGO"]), aneis, bb: bbox(aneis) });
  });
  const porMuni = new Map(); // id -> {b:[], vistos:Set}
  for (const m of munis) porMuni.set(m.id, { b: [], vistos: new Set() });
  await linhas(arq, (l) => {
    if (!RX_BAIRRO.test(l)) return;
    let f; try { f = JSON.parse(l); } catch { return; }
    const t = f.properties || {};
    const ehBairro = (t.boundary === "administrative" && (t.admin_level === "9" || t.admin_level === "10")) || ["suburb", "neighbourhood", "quarter"].includes(t.place);
    const nome = t.name || t["name:pt"];
    if (!ehBairro || !nome) return;
    const aneis = aneisDe(f.geometry);
    if (!aneis.length) return;
    const bb = bbox(aneis), cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
    let alvo = null;
    for (const m of munis) {
      if (cx < m.bb[0] || cx > m.bb[2] || cy < m.bb[1] || cy > m.bb[3]) continue;
      if (dentro(m.aneis, cx, cy)) { alvo = m; break; }
    }
    if (!alvo) { // centro do bbox pode cair fora de um bairro côncavo: tenta o primeiro vértice
      const p = aneis[0][0];
      for (const m of munis) { if (p[0] >= m.bb[0] && p[0] <= m.bb[2] && p[1] >= m.bb[1] && p[1] <= m.bb[3] && dentro(m.aneis, p[0], p[1])) { alvo = m; break; } }
    }
    if (!alvo) return;
    const a = porMuni.get(alvo.id);
    if (a.vistos.has(nome)) return;
    const r = aneis.map(codificar).filter(Boolean);
    if (!r.length) return;
    a.vistos.add(nome);
    a.b.push({ n: nome, r });
  });
  await mkdir(saida, { recursive: true });
  const placar = { com: 0, vazio: 0, mantido: 0, ausente: 0 };
  for (const id of ids) {
    const arq2 = path.join(saida, id + ".json");
    const a = porMuni.get(id);
    if (!a) { placar.ausente++; continue; }
    let atual = null; try { atual = JSON.parse(await readFile(arq2, "utf8")); } catch {}
    if (atual && atual.b && atual.b.length) { placar.mantido++; continue; }
    if (a.b.length) { await writeFile(arq2, JSON.stringify({ v: 1, b: a.b })); placar.com++; }
    else { await writeFile(arq2, JSON.stringify({ v: 1, b: [], ok: 1 })); placar.vazio++; }
  }
  return { placar, munis: munis.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const aqui = path.dirname(fileURLToPath(import.meta.url));
  const arq = process.argv[2];
  if (!arq) { console.error("Uso: node scripts/bairros-regiao.mjs <arquivo.geojsonseq> [pasta-de-saida]"); process.exit(1); }
  const saida = path.resolve(process.argv[3] || path.join(aqui, "..", "data", "bairros"));
  const ids = JSON.parse(await readFile(path.join(aqui, "..", "municipios.json"), "utf8")).map((m) => String(m.id));
  const { placar, munis } = await processar(arq, saida, ids);
  console.log(`Limites de municípios no arquivo: ${munis}. Com bairros: ${placar.com}. Sem bairros no mapa: ${placar.vazio}. Já tinham bairros: ${placar.mantido}. Município não achado no arquivo: ${placar.ausente}.`);
}
