#!/usr/bin/env node
// Gera data/weather.json com chuva real para os municípios do Paraná, de Santa Catarina e do Rio Grande do Sul.
// Fonte: Open-Meteo (https://open-meteo.com), gratuita para uso não comercial, sem chave de acesso.
// Uso: node scripts/atualizar-dados.mjs [caminho-de-saida]   (precisa do Node 18 ou mais novo)
//
// Formato de saída, por município (id do IBGE):
//   n  chuva agora, em mm na última hora
//   h  14 valores: chuva de cada um dos 14 dias passados, em mm (o último é ontem)
//   f  5 valores: chuva das próximas 24 h e dos 4 dias seguintes, em mm
//   p  chance de chuva nas próximas 24 h, em %, ou null se o modelo não informar

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const API = "https://api.open-meteo.com/v1/forecast";
const TAMANHO_LOTE = 50;      // pontos da grade por chamada
const GRADE = Number(process.env.GRADE_GRAUS) || 0.25; // municípios próximos (mesma célula de 0,25° ≈ 28 km) dividem uma consulta, para caber no limite gratuito da API
const PAUSA_MS = 15000;       // espera entre lotes, para respeitar o limite por minuto da API
const TENTATIVAS = 4;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (v) => Math.round(v * 10) / 10;
const soma = (a, de, ate) => { let s = 0; for (let i = de; i <= ate; i++) s += Number.isFinite(a[i]) ? a[i] : 0; return s; };

/** Converte a resposta da API para um município. Lança erro se algo vier fora do esperado. */
export function lerMunicipio(loc) {
  if (!loc || loc.error) throw new Error("resposta com erro: " + (loc && loc.reason));
  const tH = loc.hourly?.time, chuvaH = loc.hourly?.precipitation, probH = loc.hourly?.precipitation_probability;
  const tD = loc.daily?.time, chuvaD = loc.daily?.precipitation_sum;
  const agora = loc.current;
  if (!tH || !chuvaH || !tD || !chuvaD || !agora?.time) throw new Error("campos ausentes");

  const hora = agora.time.slice(0, 13) + ":00";
  const i = tH.indexOf(hora);
  if (i < 0 || i + 24 >= tH.length) throw new Error("horas fora do esperado");

  const dia = agora.time.slice(0, 10);
  const d = tD.indexOf(dia);
  if (d < 14 || d + 4 >= tD.length) throw new Error("dias fora do esperado");

  const passados = chuvaD.slice(d - 14, d).map((v) => r1(Number.isFinite(v) ? v : 0));
  const proximos = [r1(soma(chuvaH, i + 1, i + 24)), ...chuvaD.slice(d + 1, d + 5).map((v) => r1(Number.isFinite(v) ? v : 0))];

  let p = null;
  if (Array.isArray(probH)) {
    const v = probH.slice(i + 1, i + 25).filter(Number.isFinite);
    if (v.length) p = Math.round(Math.max(...v));
  }
  const n = r1(Number.isFinite(agora.precipitation) ? agora.precipitation : 0);
  return { n, h: passados, f: proximos, p };
}

async function buscarLote(lote, fetchImpl) {
  const url = API + "?" + new URLSearchParams({
    latitude: lote.map((c) => c.lat).join(","),
    longitude: lote.map((c) => c.lon).join(","),
    current: "precipitation",
    hourly: "precipitation,precipitation_probability",
    daily: "precipitation_sum",
    past_days: "14",
    forecast_days: "5",
    timezone: "America/Sao_Paulo",
  });
  let ultimoErro;
  for (let t = 1; t <= TENTATIVAS; t++) {
    try {
      const r = await fetchImpl(url, { headers: { "User-Agent": "PluvioGuard-atualizador" } });
      if (r.status === 429 || r.status >= 500) throw new Error("HTTP " + r.status);
      if (!r.ok) { const e = new Error("HTTP " + r.status); e.fatal = true; throw e; }
      const j = await r.json();
      const lista = Array.isArray(j) ? j : [j];
      if (lista.length !== lote.length) throw new Error(`a API devolveu ${lista.length} locais, esperado ${lote.length}`);
      return lista;
    } catch (e) {
      ultimoErro = e;
      if (e.fatal) break;
      if (t < TENTATIVAS) await dormir(t === 1 ? 5000 : 65000 * (t - 1)); // espera maior se for limite de uso
    }
  }
  throw new Error("falha ao buscar lote: " + (ultimoErro?.message || ultimoErro));
}

/** Agrupa municípios em células da grade; cada célula vira um único ponto de consulta (média das coordenadas). */
export function agrupar(municipios, grade = GRADE) {
  const g = new Map();
  for (const c of municipios) {
    const k = Math.round(c.lat / grade) + "," + Math.round(c.lon / grade);
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(c);
  }
  return [...g.values()].map((membros) => ({
    lat: Math.round((membros.reduce((a, c) => a + c.lat, 0) / membros.length) * 10000) / 10000,
    lon: Math.round((membros.reduce((a, c) => a + c.lon, 0) / membros.length) * 10000) / 10000,
    membros,
  }));
}

export async function gerar({ municipios, fetchImpl = fetch, pausa = PAUSA_MS, log = console.log, agora = () => new Date(), grade = GRADE }) {
  const m = {};
  const pontos = agrupar(municipios, grade);
  const lotes = Math.ceil(pontos.length / TAMANHO_LOTE);
  log(`${municipios.length} municípios em ${pontos.length} pontos de consulta`);
  for (let k = 0; k < pontos.length; k += TAMANHO_LOTE) {
    const lote = pontos.slice(k, k + TAMANHO_LOTE);
    if (k > 0) await dormir(pausa);
    const lista = await buscarLote(lote, fetchImpl);
    lote.forEach((p, j) => {
      const r = lerMunicipio(lista[j]);
      for (const c of p.membros) m[c.id] = r;
    });
    log(`lote ${k / TAMANHO_LOTE + 1}/${lotes} ok`);
  }
  if (Object.keys(m).length !== municipios.length) throw new Error("faltaram municípios");
  return { updated: agora().toISOString(), source: "Open-Meteo", m };
}

async function principal() {
  const aqui = path.dirname(fileURLToPath(import.meta.url));
  const saida = process.argv[2] || path.join(aqui, "..", "data", "weather.json");
  const municipios = JSON.parse(await readFile(path.join(aqui, "..", "municipios.json"), "utf8"));
  const dados = await gerar({ municipios });
  await mkdir(path.dirname(saida), { recursive: true });
  await writeFile(saida, JSON.stringify(dados));
  console.log("gravado", saida, "·", Object.keys(dados.m).length, "municípios ·", dados.updated);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal().catch((e) => { console.error("ERRO:", e.message); process.exit(1); });
}
