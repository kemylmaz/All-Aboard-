// Gunluk isletme giderini dogrular. Para kesen bir sistem sessizce yanlis
// calisamaz: store.ts icindeki computeDayUpkeep ile ayni kural burada da yazili.
import { readFileSync } from "node:fs";

const economy = JSON.parse(readFileSync("src/shared/economy.json", "utf8"));
const config = economy.upkeep;
const salaryOf = (id) => economy.drivers.find((d) => d.id === id)?.dailySalary ?? 0;

function upkeep(busCount, routeCount, driverIds, gameDay) {
  const buses = Math.max(1, busCount);
  const routes = Math.max(1, routeCount);
  const fleet = buses * config.busPerDay;
  const salaries = driverIds.reduce((total, id) => total + salaryOf(id), 0);
  const rent =
    gameDay % config.weeklyRentEveryDays === 0
      ? config.weeklyRentBase + (routes - 1) * config.weeklyRentPerRoute
      : 0;
  const inspection =
    gameDay % config.inspectionEveryDays === 0
      ? config.inspectionBase + (buses - 1) * config.inspectionPerBus
      : 0;
  return { fleet, salaries, rent, inspection, total: fleet + salaries + rent + inspection };
}

let failures = 0;
function ok(label, condition) {
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}`);
  if (!condition) failures += 1;
}

const DAY_TARGET = economy.dayGoals.earnings.targetNet;
const cheapest = [...economy.drivers].sort((a, b) => a.dailySalary - b.dailySalary)[0];

console.log("ILK HAFTA (1 arac, 1 hat, sofor yok):");
const plain = upkeep(1, 1, [], 3);
ok(`siradan gun ${plain.total} TL`, plain.total === config.busPerDay);
ok("gunluk hedefin onda birinden az", plain.total < DAY_TARGET / 10);
const firstRent = upkeep(1, 1, [], 7);
ok(`ilk kira gunu ${firstRent.total} TL`, firstRent.total === config.busPerDay + config.weeklyRentBase);
ok("ilk kira gunu hedefin ucte birini gecmez", firstRent.total <= DAY_TARGET / 3);

console.log("BUYUYEN ISLETME:");
const grown = upkeep(4, 4, [], 7);
ok("dort hatta kira dort kat degil, kademeli", grown.rent === config.weeklyRentBase + 3 * config.weeklyRentPerRoute);
ok("kira isletmeyle birlikte artiyor", grown.rent > firstRent.rent);
ok("filo gideri arac sayisiyla orantili", grown.fleet === 4 * config.busPerDay);

console.log("MUAYENE:");
const inspectSmall = upkeep(1, 1, [], 14);
const inspectBig = upkeep(4, 1, [], 14);
ok(`tek aracta ${inspectSmall.inspection} TL`, inspectSmall.inspection === config.inspectionBase);
ok("dort araca gore artiyor", inspectBig.inspection === config.inspectionBase + 3 * config.inspectionPerBus);
ok("14. gun hem kira hem muayene", inspectSmall.rent > 0 && inspectSmall.inspection > 0);
ok("ikisi birden ilk haftada hedefi asmiyor", inspectSmall.total < DAY_TARGET);

console.log("SOFOR MAASI:");
const withDriver = upkeep(1, 1, [cheapest.id], 3);
ok(`${cheapest.name} maasi kesiliyor: ${withDriver.salaries} TL`, withDriver.salaries === cheapest.dailySalary);
ok(
  "soforlu arac gider dustukten sonra hala kar birakiyor",
  economy.extraBuses.dailyGrossIncome - cheapest.dailySalary - config.busPerDay > 0,
);

console.log(failures === 0 ? "\nTUM GIDER TESTLERI GECTI" : `\n${failures} test basarisiz`);
process.exit(failures === 0 ? 0 : 1);
