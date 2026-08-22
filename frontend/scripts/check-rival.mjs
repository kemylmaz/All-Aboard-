// Rakip firma kurallarini dogrular. Oyuncunun gelirini eriten bir sistem
// sessizce yanlis calisamaz; rival.ts icindeki mantigin aynisi burada yazili.
import { readFileSync } from "node:fs";

const economy = JSON.parse(readFileSync("src/shared/economy.json", "utf8"));
const config = economy.rival;
const ROUTES = ["starter-center", "main-city"];

function apply(state, drivenRouteId, satisfaction) {
  const next = {};
  let lost = false;
  let recovered = false;

  for (const routeId of ROUTES) {
    const current = state[routeId] ?? { neglectPoints: 0, stopsLost: 0 };
    let { neglectPoints, stopsLost } = current;

    if (routeId === drivenRouteId) {
      if (satisfaction >= config.recoverSatisfaction) {
        neglectPoints = 0;
        if (stopsLost > 0) { stopsLost -= 1; recovered = true; }
      } else if (satisfaction < config.poorDaySatisfaction) {
        neglectPoints += config.poorDayNeglect;
      } else {
        neglectPoints = Math.max(0, neglectPoints - 1);
      }
    } else {
      neglectPoints += config.idleNeglectPerDay;
    }

    while (neglectPoints >= config.neglectToLoseStop && stopsLost < config.maxStopsLost) {
      neglectPoints -= config.neglectToLoseStop;
      stopsLost += 1;
      if (routeId === drivenRouteId) lost = true;
    }
    if (stopsLost >= config.maxStopsLost) neglectPoints = 0;
    next[routeId] = { neglectPoints, stopsLost };
  }
  return { state: next, lost, recovered };
}

const demandFactor = (state, routeId) =>
  Math.max(0.2, 1 - (state[routeId]?.stopsLost ?? 0) * config.demandPenaltyPerStop);

let failures = 0;
function ok(label, condition) {
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}`);
  if (!condition) failures += 1;
}

console.log("KOTU GUNLER:");
let state = {};
let outcome;
for (let day = 1; day <= 3; day += 1) {
  outcome = apply(state, "starter-center", 40);
  state = outcome.state;
}
ok("ard arda 3 kotu gun bir durak kaybettirir", state["starter-center"].stopsLost === 1);
ok("kayip gun bildirilir", outcome.lost === true);
ok(`talep %${config.demandPenaltyPerStop * 100} dustu`, Math.abs(demandFactor(state, "starter-center") - 0.92) < 1e-9);

console.log("IYI GUN:");
const recoverOutcome = apply(state, "starter-center", 85);
ok("bir durak geri alinir", recoverOutcome.state["starter-center"].stopsLost === 0);
ok("geri alma bildirilir", recoverOutcome.recovered === true);
ok("ihmal sifirlanir", recoverOutcome.state["starter-center"].neglectPoints === 0);
ok("kayip yokken geri alma bildirilmez", apply(recoverOutcome.state, "starter-center", 85).recovered === false);

console.log("ORTA GUN:");
let mid = apply({}, "starter-center", 40).state;
ok("bir kotu gun 2 puan", mid["starter-center"].neglectPoints === config.poorDayNeglect);
mid = apply(mid, "starter-center", 65).state;
ok("orta gun ihmali eritir", mid["starter-center"].neglectPoints === config.poorDayNeglect - 1);

console.log("UGRAMADIGIN HAT:");
let idle = {};
for (let day = 1; day <= 5; day += 1) idle = apply(idle, "starter-center", 85).state;
ok("5 gun ugramamak bir durak eder", idle["main-city"].stopsLost === 1);
ok("surulen hat etkilenmez", idle["starter-center"].stopsLost === 0);

console.log("TAVAN:");
let capped = {};
for (let day = 1; day <= 60; day += 1) capped = apply(capped, "starter-center", 40).state;
ok(`en fazla ${config.maxStopsLost} durak`, capped["starter-center"].stopsLost === config.maxStopsLost);
ok("talep tabani korunur", demandFactor(capped, "starter-center") >= 0.2);
ok("tavanda ihmal birikmez", capped["starter-center"].neglectPoints === 0);

console.log(failures === 0 ? "\nTUM RAKIP TESTLERI GECTI" : `\n${failures} test basarisiz`);
process.exit(failures === 0 ? 0 : 1);
