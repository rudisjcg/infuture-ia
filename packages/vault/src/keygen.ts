import { generateMasterKey } from "./index";

const key = generateMasterKey();
console.log("\nINFUTURE_MASTER_KEY=" + key + "\n");
console.log(
  "EN: Paste this line into your .env file and keep it safe. Losing it makes stored credentials unreadable.",
);
console.log(
  "ES: Pega esta línea en tu archivo .env y guárdala en un lugar seguro. Si la pierdes, las credenciales guardadas no se podrán leer.\n",
);
