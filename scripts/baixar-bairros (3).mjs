#!/usr/bin/env node
// Baixa os limites dos bairros de cada município (OpenStreetMap, via Overpass) e grava um arquivo por município
// em data/bairros/<codigo-ibge>.json. O site lê esses arquivos em vez de consultar o Overpass a cada visita.
// Uso: node scripts/baixar-bairros.mjs [pasta-de-saida]
// Variáveis: PAUSA_MS (padrão 2000), TRABALHADORES (padrão 4), UF (só um estado), SO_CONTAR=1 (só conta os que faltam), MAX_MINUTOS (padrão 300: para sem erro e continua na próxima rodada),
//            FORCAR=1 (baixa de novo mesmo os já existentes), LIMITE=N (só os N primeiros, para teste).
// O script retoma de onde parou: município que já tem arquivo é pulado.
//
// Formato do arquivo: {"v":1,"b":[{"n":"Nome","r":[[x0,y0,dx,dy,dx,dy,...],...]}]}
//   coordenadas em graus x 100000 (inteiros); o primeiro par é absoluto (lon,lat), os seguintes são diferenças.
//   "r" tem todos os anéis do bairro (externos e internos; o site preenche com a regra par-ímpar).
//   {"v":1,"b":[]} significa "baixado, mas o OpenStreetMap não tem bairros deste município".

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const TOL = 0.00015; // simplificação (~17 m)
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const mesmo = (a, b) => a[0] === b[0] && a[1] === b[1];

export function consulta(m, porCodigo) {
  const corpo = 'map_to_area->.a;(rel(area.a)["boundary"="administrative"]["admin_level"~"^(9|10)$"];rel(area.a)["place"~"^(suburb|neighbourhood|quarter)$"];);out geom;';
  const cab = "[out:json][timeout:40];";
  if (porCodigo) return cab + 'rel["boundary"="administrative"]["admin_level"="8"]["IBGE:GEOCODIGO"="' + m.id + '"];' + corpo;
  return cab + 'area["ISO3166-2"="BR-' + m.uf + '"]["admin_level"="4"]->.s;rel(area.s)["boundary"="administrative"]["admin_level"="8"]["name"="' + m.name.replace(/"/g, "") + '"];' + corpo;
}

export function montarAneis(linhas) { // junta as linhas do OSM em anéis fechados
  const pool = linhas.filter((w) => w.length > 1).map((w) => w.slice()), aneis = [];
  while (pool.length) {
    let cur = pool.shift(), guarda = 0;
    while (!mesmo(cur[0], cur[cur.length - 1]) && pool.length && guarda++ < 20000) {
      const fim = cur[cur.length - 1];
      let achou = -1, inv = false;
      for (let i = 0; i < pool.length; i++) {
        if (mesmo(pool[i][0], fim)) { achou = i; break; }
        if (mesmo(pool[i][pool[i].length - 1], fim)) { achou = i; inv = true; break; }
      }
      if (achou < 0) break;
      const w = pool.splice(achou, 1)[0];
      if (inv) w.reverse();
      cur = cur.concat(w.slice(1));
    }
    if (cur.length >= 4 && mesmo(cur[0], cur[cur.length - 1])) aneis.push(cur);
  }
  return aneis;
}

function dp(pts, tol) { // Douglas-Peucker iterativo
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

/** Resposta do Overpass -> formato gravado. */
export function montar(json) {
  const vistos = new Set(), b = [];
  for (const e of (json && json.elements) || []) {
    if (e.type !== "relation" || !e.members || !e.tags) continue;
    const nome = e.tags.name || e.tags["name:pt"];
    if (!nome || vistos.has(nome)) continue;
    const ext = [], int = [];
    for (const mb of e.members) {
      if (mb.type !== "way" || !mb.geometry || mb.geometry.length < 2) continue;
      (mb.role === "inner" ? int : ext).push(mb.geometry.map((p) => [p.lon, p.lat]));
    }
    const r = montarAneis(ext).concat(montarAneis(int)).map(codificar).filter(Boolean);
    if (!r.length || !montarAneis(ext).length) continue;
    vistos.add(nome);
    b.push({ n: nome, r });
  }
  return { v: 1, b };
}

async function overpass(q, k = 0, tentados = 0) {
  const c = new AbortController(), tm = setTimeout(() => c.abort(), 50000);
  try {
    const r = await fetch(ENDPOINTS[k], { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "PluvioGuard-bairros/1.0" }, body: "data=" + encodeURIComponent(q), signal: c.signal });
    if (!r.ok) throw new Error("http " + r.status);
    const j = await r.json();
    // O Overpass sobrecarregado responde 200 com lista vazia e um aviso ("remark"); isso NÃO é "sem bairros".
    if (j && j.remark && /error|timed out|out of memory|too busy|rate_limited/i.test(j.remark)) throw new Error("overpass: " + String(j.remark).slice(0, 60));
    return j;
  } catch (e) {
    if (tentados + 1 < ENDPOINTS.length) return overpass(q, (k + 1) % ENDPOINTS.length, tentados + 1);
    throw e;
  } finally { clearTimeout(tm); }
}

export async function baixarUm(m, busca = overpass) {
  let j = await busca(consulta(m, true));
  let dados = montar(j);
  if (!dados.b.length) dados = montar(await busca(consulta(m, false)));
  return dados;
}

async function existe(p) { try { await access(p); return true; } catch { return false; } }
// Arquivo "pronto" = existe e, se estiver sem bairros, foi confirmado (ok:1). Vazios antigos, sem confirmação, são refeitos.
async function pronto(p) {
  try { const j = JSON.parse(await readFile(p, "utf8")); return !!(j && j.b && (j.b.length || j.ok === 1)); } catch { return false; }
}

async function principal() {
  const aqui = path.dirname(fileURLToPath(import.meta.url));
  const saida = path.resolve(process.argv[2] || path.join(aqui, "..", "data", "bairros"));
  const pausa = Number(process.env.PAUSA_MS) || 2000, limiteMs = (Number(process.env.MAX_MINUTOS) || 300) * 60000;
  const trabalhadores = Number(process.env.TRABALHADORES) || 4; // 2 em cada servidor Overpass (cada um aceita 2 consultas ao mesmo tempo)
  const uf = (process.env.UF || "").toUpperCase(); // opcional: só um estado (PR, SC ou RS)
  const lista = JSON.parse(await readFile(path.join(aqui, "..", "municipios.json"), "utf8")).filter((m) => !uf || m.uf === uf).slice(0, Number(process.env.LIMITE) || undefined);
  await mkdir(saida, { recursive: true });
  if (process.env.SO_CONTAR) { // só informa quantos municípios ainda não têm arquivo
    let faltam = 0;
    for (const m of lista) if (!(await pronto(path.join(saida, m.id + ".json")))) faltam++;
    console.log(faltam);
    return;
  }
  const ini = Date.now();
  const placar = { ok: 0, vazio: 0, pulado: 0, falha: 0 };
  let proximo = 0, parar = false;
  async function trabalhador(id) {
    while (!parar) {
      const m = lista[proximo++];
      if (!m) return;
      const arq = path.join(saida, m.id + ".json");
      if (!process.env.FORCAR && await pronto(arq)) { placar.pulado++; continue; }
      if (Date.now() - ini > limiteMs) { parar = true; console.log("Tempo máximo desta etapa atingido; ela continua na próxima."); return; }
      let dados = null;
      for (let t = 1; t <= 3 && !dados; t++) {
        try { dados = await baixarUm(m, (q) => overpass(q, id % ENDPOINTS.length)); } catch (e) { console.log(`  ${m.name}: tentativa ${t} falhou (${e.message})`); await dormir(pausa * 4 * t); }
      }
      if (!dados) { placar.falha++; continue; }
      if (!dados.b.length) dados.ok = 1;
      await writeFile(arq, JSON.stringify(dados));
      dados.b.length ? placar.ok++ : placar.vazio++;
      console.log(`${m.name} (${m.uf}): ${dados.b.length} bairros`);
      await dormir(pausa);
    }
  }
  await Promise.all(Array.from({ length: trabalhadores }, (_, i) => trabalhador(i)));
  console.log(`Fim da etapa: ${placar.ok} com bairros, ${placar.vazio} sem bairros no OSM, ${placar.pulado} já existiam, ${placar.falha} falharam.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) principal().catch((e) => { console.error(e); process.exit(1); });
