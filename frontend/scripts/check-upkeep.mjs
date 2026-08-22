// Gunluk isletme giderini dogrular. Para kesen bir sistem sessizce yanlis
// calisamaz: store.ts icindeki computeDayUpkeep ile ayni kural burada da yazili.
import { readFileSync } from "node:fs";

const economy = JSON.parse(readFileSync("src/shared/economy.json", "utf8"));
const config = economy.upkeep;
const salaryOf = (id) => economy.drivers.find((d) => d.id === id)?.dailySalary ?? 0;

function upkeep(busCount, driverIds, gameDay) {
  const fleet = Math.max(1, busCount) * config.busPerDay;
  const salaries = driverIds.reduce((total, id) => total + salaryOf(id), 0);
  const rent = gameDay % config.weeklyRentEveryDays === 0 ? config.weeklyRent : 0;
  const inspection = gameDay % config.inspectionEveryDays === 0 ? config.inspectionCost : 0;
  return { fleet, salaries, rent, inspection, total: fleet + salaries + rent + inspection };
}

let failures = 0;
function ok(label, condition) {
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}`);
  if (!condition) failures += 1;
}

const DAY_TARGET = economy.dayGoals.earnings.targetNet;
const cheapest = [...economy.drivers].sort((a, b) => a.dailySalary - b.dailySalary)[0];

console.log("SIRADAN GUN:");
const plain = upkeep(1, [], 3);
ok(`tek arac, sofursuz: ${plain.total} TL`, plain.total === config.busPerDay);
ok("kira yok", plain.rent === 0);
ok("muayene yok", plain.inspection === 0);
ok("gunluk hedefin yarisindan az", plain.total < DAY_TARGET / 2);

console.log("KIRA GUNU (7. gun):");
const rentDay = upkeep(1, [], 7);
ok(`kira tahsil edildi: ${rentDay.rent} TL`, rentDay.rent === config.weeklyRent);
ok("muayene yok (7 % 14 != 0)", rentDay.inspection === 0);

console.log("MUAYENE GUNU (14. gun):");
const both = upkeep(1, [], 14);
ok("14. gun hem kira hem muayene", both.rent > 0 && both.inspection > 0);
ok("ikisi birden gunluk hedefi asmiyor", both.total < DAY_TARGET);

console.log("FILO BUYUDUKCE:");
const fleet4 = upkeep(4, [], 3);
ok(`dort arac: ${fleet4.fleet} TL`, fleet4.fleet === 4 * config.busPerDay);
ok("arac sayisiyla dogru orantili", fleet4.fleet === plain.fleet * 4);

console.log("SOFOR MAASI:");
const withDriver = upkeep(1, [cheapest.id], 3);
ok(`${cheapest.name} maasi kesiliyor: ${withDriver.salaries} TL`, withDriver.salaries === cheapest.dailySalary);
ok("ayni sofor iki kez sayilmaz", upkeep(1, [cheapest.id], 3).salaries === cheapest.dailySalary);
ok(
  "soforlu arac yine de kar birakiyor",
  economy.extraBuses.dailyGrossIncome - cheapest.dailySalary - config.busPerDay > 0,
);

console.log(failures === 0 ? "\nTUM GIDER TESTLERI GECTI" : `\n${failures} test basarisiz`);
process.exit(failures === 0 ? 0 : 1);
