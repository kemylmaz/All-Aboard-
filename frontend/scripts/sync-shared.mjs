// `shared/economy.json` repo kökünde duruyor ve kanonik kaynak orası. Next'in
// build kökü `frontend/` olduğu için dosya build sırasında dışarıdan
// çözülemiyor; bu betik her dev/build öncesi içeri kopyalar.
// Kaynağı DÜZENLEME: repo kökündeki dosyayı düzenle, bu kopya üretilir.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "..", "shared", "economy.json");
const target = join(here, "..", "src", "shared", "economy.json");

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log("shared/economy.json -> src/shared/economy.json");
