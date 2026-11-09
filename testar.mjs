// Teste offline: simula as respostas da Open-Meteo e confere se o script monta o data/weather.json certo.
// Uso: node scripts/testar.mjs
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { gerar, agrupar, lerMunicipio } from "./atualizar-dados.mjs";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const municipios = JSON.parse(await readFile(path.join(aqui, "..", "municipios.json"), "utf8"));
assert.equal(municipios.length, 1188);
assert.deepEqual(Object.fromEntries(["PR","SC","RS"].map((u) => [u, municipios.filter((c) => c.uf === u).length])), { PR: 399, SC: 293, RS: 496 });

// Relógio fixo: sábado 2026-11-07, 14:15 em Brasília.
const HOJE = "2026-11-07", HORA_ATUAL = 14;
const pad = (n) => String(n).padStart(2, "0");
const dia = (off) => { const d = new Date(Date.UTC(2026, 10, 7 + off)); return d.toISOString().slice(0, 10); };

/** Resposta no formato da Open-Meteo: 14 dias passados + hoje + 4 à frente, de hora em hora. */
function respostaSimulada(lat, lon) {
  const semente = Math.abs(Math.sin(lat * 12.9898 + lon * 78.233)) ;
  const horas = [], chuva = [], prob = [];
  for (let off = -14; off <= 4; off++) for (let h = 0; h < 24; h++) {
    horas.push(`${dia(off)}T${pad(h)}:00`);
    const chove = ((off * 24 + h) * 7 + Math.floor(semente * 100)) % 11 === 0;
    chuva.push(chove ? 2.5 : 0);
    prob.push(chove ? 80 : 10);
  }
  const dias = [], soma = [];
  for (let off = -14; off <= 4; off++) {
    dias.push(dia(off));
    const t = horas.map((x, i) => [x, chuva[i]]).filter(([x]) => x.startsWith(dia(off)));
    soma.push(Math.round(t.reduce((a, [, v]) => a + v, 0) * 10) / 10);
  }
  return {
    latitude: lat, longitude: lon,
    current: { time: `${HOJE}T${pad(HORA_ATUAL)}:15`, interval: 900, precipitation: 0.4 },
    hourly: { time: horas, precipitation: chuva, precipitation_probability: prob },
    daily: { time: dias, precipitation_sum: soma },
  };
}

let chamadas = 0;
const fetchFalso = async (url) => {
  chamadas++;
  const u = new URL(url);
  assert.equal(u.searchParams.get("past_days"), "14");
  assert.equal(u.searchParams.get("timezone"), "America/Sao_Paulo");
  const lats = u.searchParams.get("latitude").split(",").map(Number);
  const lons = u.searchParams.get("longitude").split(",").map(Number);
  assert.equal(lats.length, lons.length);
  assert.ok(lats.length <= 50);
  assert.ok(lats.every((v) => v < -22 && v > -34) && lons.every((v) => v < -48 && v > -58));
  const lista = lats.map((la, i) => respostaSimulada(la, lons[i]));
  return { ok: true, status: 200, json: async () => (lista.length === 1 ? lista[0] : lista) };
};

const dados = await gerar({ municipios, fetchImpl: fetchFalso, pausa: 0, log: () => {}, agora: () => new Date("2026-11-07T17:10:00Z") });
const pontos = agrupar(municipios).length;
assert.equal(chamadas, Math.ceil(pontos / 50));
assert.ok(pontos < 700, "muitos pontos de consulta: " + pontos);
assert.equal(Object.keys(dados.m).length, 1188);
assert.equal(dados.updated, "2026-11-07T17:10:00.000Z");
for (const c of municipios) {
  const r = dados.m[c.id];
  assert.ok(r, "falta " + c.name);
  assert.equal(r.h.length, 14);
  assert.equal(r.f.length, 5);
  assert.equal(r.n, 0.4);
  assert.ok(r.p === null || (r.p >= 0 && r.p <= 100));
  assert.ok([...r.h, ...r.f].every((v) => Number.isFinite(v) && v >= 0));
}

// Resposta com erro da API deve falhar de forma clara, sem gravar dados incompletos.
assert.throws(() => lerMunicipio({ error: true, reason: "limite excedido" }), /limite excedido/);
// Resposta sem a hora atual nos dados horários também.
const quebrada = respostaSimulada(-25, -49); quebrada.current.time = "2030-01-01T10:00";
assert.throws(() => lerMunicipio(quebrada), /fora do esperado/);
// Probabilidade ausente vira null.
const semProb = respostaSimulada(-25, -49); delete semProb.hourly.precipitation_probability;
assert.equal(lerMunicipio(semProb).p, null);

console.log("Todos os testes passaram:", Object.keys(dados.m).length, "municípios em", pontos, "pontos e", chamadas, "chamadas simuladas.");
