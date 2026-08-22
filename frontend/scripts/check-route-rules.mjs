// Hat kurallarinin gercekten hatta ve saate bagli olup olmadigini dogrular.
// routeProfile.ts icindeki mantigin aynisi; saf oldugu icin tarayici gerekmez.
import { readFileSync } from "node:fs";

const economy = JSON.parse(readFileSync("src/shared/economy.json", "utf8"));

const hourOf = (minutes) => Math.floor(minutes / 60) % 24;
const withinHours = (hour, start, end) =>
  start <= end ? hour >= start && hour < end : hour >= start || hour < end;

const rules = (id) => economy.routes[id];

function demandAt(id, minutes) {
  const rush = rules(id).rush;
  if (!rush) return 1;
  return withinHours(hourOf(minutes), rush.startHour, rush.endHour)
    ? rush.peakMultiplier
    : rush.offPeakMultiplier;
}

function fareAt(id, minutes) {
  const night = rules(id).nightShift;
  if (!night) return 1;
  return withinHours(hourOf(minutes), night.startHour, night.endHour) ? night.fareMultiplier : 1;
}

function brake(id, fromKmh, toKmh) {
  const smooth = rules(id).smoothRide;
  if (!smooth) return 0;
  return fromKmh - toKmh >= smooth.harshBrakeKmh && toKmh > 5
    ? smooth.harshBrakeSatisfactionPenalty
    : 0;
}

let failures = 0;
function ok(label, condition) {
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}`);
  if (!condition) failures += 1;
}

const H = (hour) => hour * 60;

console.log("UNIVERSITE HATTI (main-city):");
ok("09:00 pik saatte talep 2.4x", demandAt("main-city", H(9)) === 2.4);
ok("13:00 olu saatte talep 0.5x", demandAt("main-city", H(13)) === 0.5);
ok("mahalle hatti saatten etkilenmez", demandAt("starter-center", H(9)) === 1 && demandAt("starter-center", H(13)) === 1);

console.log("GECE HATTI (north-loop):");
ok("23:00 ucret 1.6x", fareAt("north-loop", H(23)) === 1.6);
ok("02:00 — gece yarisini asan pencere calisiyor", fareAt("north-loop", H(2)) === 1.6);
ok("14:00 normal ucret", fareAt("north-loop", H(14)) === 1);
ok("universite hattinda gece bonusu yok", fareAt("main-city", H(23)) === 1);

console.log("HASTANE HATTI (premium-outer):");
ok("40 -> 20 km/s sert fren cezali", brake("premium-outer", 40, 20) === 3);
ok("40 -> 32 km/s yumusak, ceza yok", brake("premium-outer", 40, 32) === 0);
ok("durakta durus (10 -> 0) cezasiz", brake("premium-outer", 10, 0) === 0);
ok("mahalle hattinda sert fren serbest", brake("starter-center", 40, 10) === 0);
ok("hiz cezasi carpani 2", rules("premium-outer").smoothRide.speedingPenaltyMultiplier === 2);

console.log(failures === 0 ? "\nTUM HAT KURALI TESTLERI GECTI" : `\n${failures} test basarisiz`);
process.exit(failures === 0 ? 0 : 1);
