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
//   t  temperatura do ar agora, em °C (null se a API não informar)
//   tx e tn  temperatura máxima e mínima de hoje, em °C (null se a API não informar)
//   w  vento agora, em km/h · g  rajada agora, em km/h · gx  maior rajada prevista nas próximas 24 h, em km/h (null se a API não informar)
//
// Terceiro arquivo, data/relevo.json (altitude e desnível do terreno ao redor de cada município, usado no risco de deslizamento):
//   m[id] = [altitude do centro em m, desnível em m entre o ponto mais alto e o mais baixo num raio de ~5 km]
//   O relevo quase não muda, então é calculado aos poucos (até 400 municípios por execução) e guardado; depois de completo, não consulta mais.
//
// Segundo arquivo, data/hourly.json (previsão hora a hora das próximas 24 h, carregado só quando o painel do município é aberto):
//   start  hora local da primeira posição ("AAAA-MM-DDTHH:00"); m[id] = { p: chuva (mm) por hora, t: temperatura (°C, inteiro), c: chance de chuva (%), g: rajada de vento (km/h, inteiro) }

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const API = "https://api.open-meteo.com/v1/forecast";
const TAMANHO_LOTE = 50;      // pontos da grade por chamada
const GRADE = Number(process.env.GRADE_GRAUS) || 0.25; // municípios próximos (mesma célula de 0,25° ≈ 28 km) dividem uma consulta, para caber no limite gratuito da API
const PAUSA_MS = 15000;       // espera entre lotes, para respeitar o limite por minuto da API
const TENTATIVAS = 4;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (v) => Math.round(v * 10) / 10;
const num = (v) => (Number.isFinite(v) ? r1(v) : null);
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
  // Temperatura é opcional: se faltar, o site simplesmente não mostra, e a chuva continua funcionando.
  const horas = {
    start: tH[i + 1],
    p: chuvaH.slice(i + 1, i + 25).map((v) => r1(Number.isFinite(v) ? v : 0)),
    t: (loc.hourly?.temperature_2m || []).slice(i + 1, i + 25).map((v) => (Number.isFinite(v) ? Math.round(v) : null)),
    g: (loc.hourly?.wind_gusts_10m || []).slice(i + 1, i + 25).map((v) => (Number.isFinite(v) ? Math.round(v) : null)),
    c: Array.isArray(probH) ? probH.slice(i + 1, i + 25).map((v) => (Number.isFinite(v) ? Math.round(v) : 0)) : [],
  };
  const int = (v) => (Number.isFinite(v) ? Math.round(v) : null);
  const gv = horas.g.filter(Number.isFinite), gAgora = int(agora.wind_gusts_10m);
  const gx = gv.length || gAgora != null ? Math.max(...gv, gAgora ?? 0) : null;
  return { horas, n, h: passados, f: proximos, p, t: num(agora.temperature_2m), tx: num(loc.daily?.temperature_2m_max?.[d]), tn: num(loc.daily?.temperature_2m_min?.[d]), w: int(agora.wind_speed_10m), g: gAgora, gx };
}

async function buscarLote(lote, fetchImpl) {
  const url = API + "?" + new URLSearchParams({
    latitude: lote.map((c) => c.lat).join(","),
    longitude: lote.map((c) => c.lon).join(","),
    current: "precipitation,temperature_2m,wind_speed_10m,wind_gusts_10m",
    hourly: "precipitation,precipitation_probability,temperature_2m,wind_gusts_10m",
    daily: "precipitation_sum,temperature_2m_max,temperature_2m_min",
    past_days: "14",
    forecast_days: "5",
    past_hours: "2",      // as horas só precisam de "agora" até +24 h: pedir só isso deixa a consulta bem mais leve
    forecast_hours: "30",
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
  const m = {}, hr = {};
  let start = null;
  const pontos = agrupar(municipios, grade);
  const lotes = Math.ceil(pontos.length / TAMANHO_LOTE);
  log(`${municipios.length} municípios em ${pontos.length} pontos de consulta`);
  for (let k = 0; k < pontos.length; k += TAMANHO_LOTE) {
    const lote = pontos.slice(k, k + TAMANHO_LOTE);
    if (k > 0) await dormir(pausa);
    const lista = await buscarLote(lote, fetchImpl);
    lote.forEach((p, j) => {
      const r = lerMunicipio(lista[j]);
      const { horas, ...resto } = r;
      start = start || horas.start;
      for (const c of p.membros) { m[c.id] = resto; hr[c.id] = { p: horas.p, t: horas.t, c: horas.c, g: horas.g }; }
    });
    log(`lote ${k / TAMANHO_LOTE + 1}/${lotes} ok`);
  }
  if (Object.keys(m).length !== municipios.length) throw new Error("faltaram municípios");
  return { updated: agora().toISOString(), source: "Open-Meteo", m, hourly: { updated: agora().toISOString(), start, m: hr } };
}

const ELEV_API = "https://api.open-meteo.com/v1/elevation";
const DELTA = 0.05; // ~5,5 km
const POR_EXECUCAO = 200; // municípios por execução (5 pontos cada); pouco por vez para não pesar no limite da API

/** Para cada município: altitude do centro e desnível (máx - mín) entre o centro e 4 pontos ao redor. */
export async function gerarRelevo({ municipios, existente = {}, fetchImpl = fetch, pausa = 3000, limite = POR_EXECUCAO, log = console.log }) {
  const m = { ...existente };
  const faltam = municipios.filter((c) => !m[c.id]).slice(0, limite);
  for (let k = 0; k < faltam.length; k += 20) {
    const lote = faltam.slice(k, k + 20), lat = [], lon = [];
    for (const c of lote) for (const [dy, dx] of [[0, 0], [DELTA, 0], [-DELTA, 0], [0, DELTA], [0, -DELTA]]) { lat.push(Math.round((c.lat + dy) * 1e4) / 1e4); lon.push(Math.round((c.lon + dx) * 1e4) / 1e4); }
    const url = ELEV_API + "?" + new URLSearchParams({ latitude: lat.join(","), longitude: lon.join(",") });
    let j;
    try {
      const r = await fetchImpl(url, { headers: { "User-Agent": "PluvioGuard-atualizador" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      j = await r.json();
      if (!Array.isArray(j.elevation) || j.elevation.length !== lat.length) throw new Error("resposta inesperada");
    } catch (e) { log("relevo interrompido (" + e.message + "); fica para a próxima execução"); break; } // guarda o que já veio
    lote.forEach((c, i) => {
      const e = j.elevation.slice(i * 5, i * 5 + 5);
      if (e.every(Number.isFinite)) m[c.id] = [Math.round(e[0]), Math.round(Math.max(...e) - Math.min(...e))];
    });
    log(`relevo ${Math.min(k + 20, faltam.length)}/${faltam.length}`);
    if (k + 20 < faltam.length) await dormir(pausa);
  }
  return m;
}

async function principal() {
  const aqui = path.dirname(fileURLToPath(import.meta.url));
  const saida = process.argv[2] || path.join(aqui, "..", "data", "weather.json");
  const municipios = JSON.parse(await readFile(path.join(aqui, "..", "municipios.json"), "utf8"));
  await mkdir(path.dirname(saida), { recursive: true });
  let dados;
  try {
    dados = await gerar({ municipios });
  } catch (e) {
    // Se a API recusar (limite de uso), mantém no ar os últimos dados já publicados em vez de derrubar a publicação.
    console.warn("::warning::não consegui atualizar agora (" + e.message + "); mantendo os últimos dados publicados");
    const base = process.env.SITE_URL || "https://burgath.github.io/Pluvioguard/data/";
    let ok = true;
    for (const nome of ["weather.json", "hourly.json", "relevo.json"]) {
      try {
        const r = await fetch(base + nome);
        if (!r.ok) throw new Error("HTTP " + r.status);
        await writeFile(path.join(path.dirname(saida), nome), await r.text());
      } catch (e2) { if (nome !== "relevo.json") ok = false; }
    }
    if (!ok) throw e;
    return;
  }
  const { hourly, ...semHoras } = dados;
  await writeFile(saida, JSON.stringify(semHoras));
  await writeFile(path.join(path.dirname(saida), "hourly.json"), JSON.stringify(hourly));
  // Relevo: opcional e feito aos poucos; se falhar, o resto do site segue normal.
  try {
    const arq = path.join(path.dirname(saida), "relevo.json");
    // Cada execução roda numa máquina limpa, então o progresso vem da versão já publicada do site.
    let atual = {};
    try {
      if (existsSync(arq)) atual = JSON.parse(await readFile(arq, "utf8")).m || {};
      else { const r = await fetch(process.env.RELEVO_URL || "https://burgath.github.io/Pluvioguard/data/relevo.json"); if (r.ok) atual = (await r.json()).m || {}; }
    } catch { atual = {}; }
    // O relevo gasta bastante da cota diária da API: só roda na primeira execução do dia (logo depois da cota zerar, 00h UTC) ou se forçado.
    const horaRelevo = new Date().getUTCHours() < 3 || process.env.RELEVO_AGORA === "1";
    if (!municipios.some((c) => !atual[c.id])) {
      await writeFile(arq, JSON.stringify({ updated: dados.updated, m: atual }));
      console.log("relevo completo:", Object.keys(atual).length);
    } else if (!horaRelevo) {
      if (Object.keys(atual).length) await writeFile(arq, JSON.stringify({ updated: dados.updated, m: atual }));
      console.log("relevo: fica para a primeira execução do dia (" + Object.keys(atual).length + " de " + municipios.length + " prontos)");
    } else {
      const novo = await gerarRelevo({ municipios, existente: atual });
      await writeFile(arq, JSON.stringify({ updated: dados.updated, m: novo }));
      console.log("relevo:", Object.keys(novo).length, "de", municipios.length);
    }
  } catch (e) { console.warn("relevo adiado:", e.message); }
  console.log("gravado", saida, "·", Object.keys(dados.m).length, "municípios ·", dados.updated);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal().catch((e) => { console.error("ERRO:", e.message); process.exit(1); });
}
