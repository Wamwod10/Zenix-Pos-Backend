import { createHash } from "node:crypto";

export const SEED_KEY = "zenix-market-demo-v1";

export function parseSeedMode(args) {
  const allowed = new Set(["--apply", "--dry-run"]);
  const unknown = args.find((arg) => !allowed.has(arg));
  if (unknown) throw new Error(`Unknown argument: ${unknown}`);
  if (args.includes("--apply") && args.includes("--dry-run")) throw new Error("Choose exactly one of --apply or --dry-run");
  return {apply:args.includes("--apply")};
}

export function resolveAnchorDate(existingAnchor, databaseToday) {
  const anchor = existingAnchor || databaseToday;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(anchor))) throw new Error("Seed anchor date must be YYYY-MM-DD");
  return String(anchor);
}

export function assertOperationalSafety(summary) {
  if (Object.values(summary || {}).some((value) => Number(value) > 0)) {
    throw new Error(`Rerun refused because operational data changed after seeding: ${JSON.stringify(summary)}`);
  }
}

export function stableUuid(namespace, key) {
  const bytes = Buffer.from(createHash("sha256").update(`${namespace}:${SEED_KEY}:${key}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function validateTargetProfile(rows, expectedLogin, expectedOrganizationName) {
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error(`Expected exactly one profile for login ${expectedLogin}`);
  const row = rows[0];
  if (!row.active) throw new Error("Target profile is inactive");
  if (!row.organization_id || !row.store_id) throw new Error("Target profile has no organization/store binding");
  if (String(row.username).toLocaleLowerCase("en-US") !== expectedLogin.toLocaleLowerCase("en-US")) throw new Error("Target login mismatch");
  if (String(row.organization_name).toLocaleLowerCase("en-US") !== expectedOrganizationName.toLocaleLowerCase("en-US")) throw new Error("Target organization mismatch");
  return { userId:row.id, organizationId:row.organization_id, storeId:row.store_id, username:row.username, organizationName:row.organization_name };
}

const GROUPS = [
  ["Sut mahsulotlari", "Musaffo", ["Sut 1L","Qatiq 1L","Kefir 1L","Smetana 400g","Tvorog 400g","Qaymoq 200ml","Sariyog‘ 200g","Golland pishlog‘i 300g","Mozzarella 250g","Ayran 1L"]],
  ["Non va qandolat", "Safia", ["Oq non","Patir non","Baton","Lavash","Suxari 300g","Pechenye 400g","Vafli 300g","Keks 250g","Pryanik 400g","Kruassan"]],
  ["Ichimliklar", "Hydrolife", ["Suv 0.5L","Suv 1.5L","Gazli suv 1L","Cola 1L","Limonad 1L","Apelsin sharbati 1L","Olma sharbati 1L","Muzli choy 1L","Energetik 0.45L","Kompot 1L"]],
  ["Choy va qahva", "Ahmad Tea", ["Qora choy 100g","Ko‘k choy 100g","Choy paket 25 dona","Bergamot choyi 100g","Qahva 3-in-1 20 dona","Eruvchan qahva 95g","Donali qahva 250g","Kakao 100g","Qaymoq kukuni 200g","Shakar stiki 100 dona"]],
  ["Yorma va makaron", "Makfa", ["Guruch 1kg","Grechka 1kg","Mosh 1kg","No‘xat 1kg","Loviya 1kg","Manna yormasi 800g","Suli yormasi 500g","Makaron spiral 450g","Spagetti 500g","Vermishel 450g"]],
  ["Konserva va sous", "Heinz", ["Tomat pastasi 500g","Ketchup 350g","Mayonez 400g","No‘xat konserva 400g","Makkajo‘xori konserva 400g","Tuna konserva 185g","Mol go‘shti konserva 325g","Adjika 300g","Soya sousi 250ml","Xantal 200g"]],
  ["Shirinliklar", "Roshen", ["Sutli shokolad 90g","Qora shokolad 90g","Karamel 500g","Konfet assorti 500g","Marmelad 300g","Zefir 300g","Halva 400g","Chak-chak 300g","Saqich 10 dona","Shokolad batonchasi"]],
  ["Ziravor va pishiriq", "Pripravych", ["Osh tuzi 1kg","Shakar 1kg","Un oliy nav 2kg","Kungaboqar yog‘i 1L","Zaytun yog‘i 500ml","Qora murch 50g","Zira 50g","Paprika 50g","Xamirturush 100g","Vanilin 10g"]],
  ["Maishiy kimyo", "Ariel", ["Kir kukuni 3kg","Idish geli 500ml","Suyuq sovun 500ml","Xo‘jalik sovuni","Oqartirgich 1L","Pol tozalagich 1L","Shisha tozalagich 500ml","Gubka 5 dona","Axlat paketi 30 dona","Qog‘oz sochiq 2 dona"]],
  ["Gigiyena", "Colgate", ["Tish pastasi 100ml","Tish cho‘tkasi","Shampun 400ml","Dush geli 400ml","Hojatxona qog‘ozi 4 dona","Nam salfetka 100 dona","Quruq salfetka 100 dona","Dezodorant 150ml","Paxta tayoqcha 100 dona","Bolalar tagligi 10 dona"]],
];

function ean13(index) {
  const first12 = `478900000${String(index + 1).padStart(3,"0")}`;
  const sum = [...first12].reduce((total, digit, i) => total + Number(digit) * (i % 2 ? 3 : 1), 0);
  return `${first12}${(10 - (sum % 10)) % 10}`;
}

export function buildCatalog() {
  const products = [];
  GROUPS.forEach(([category, brand, names], categoryIndex) => names.forEach((name, itemIndex) => {
    const index = categoryIndex * 10 + itemIndex;
    const costPrice = Math.round((3500 + categoryIndex * 1800 + itemIndex * 1350) / 500) * 500;
    const sellPrice = Math.ceil((costPrice * (1.22 + (index % 4) * 0.025)) / 500) * 500;
    products.push({
      index, name, category, brand, unit:"dona", sku:`ZM-${String(index + 1).padStart(3,"0")}`,
      barcode:ean13(index), costPrice, sellPrice, wholesalePrice:Math.ceil(costPrice * 1.12 / 500) * 500,
      minStock:8 + (index % 8), received:100 + ((index * 7) % 60),
    });
  }));
  return products;
}

function dateAdd(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function hashNumber(value) {
  return createHash("sha256").update(value).digest().readUInt32BE(0);
}

export function buildDemoPlan(anchorDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)) throw new Error("anchorDate must be YYYY-MM-DD");
  const catalog = buildCatalog();
  const days = Array.from({length:7}, (_, i) => ({date:dateAdd(anchorDate, i - 6), index:i}));
  const sales = [];
  const sold = Array(100).fill(0);
  const paymentTotals = {cash:0, card:0, transfer:0};
  let revenue = 0;
  let grossProfit = 0;
  for (const day of days) {
    for (let saleIndex = 0; saleIndex < 18; saleIndex += 1) {
      const saleKey = `${day.date}:${saleIndex}`;
      const itemCount = 1 + (hashNumber(`${saleKey}:count`) % 5);
      const chosen = new Set();
      const items = [];
      for (let lineIndex = 0; lineIndex < itemCount; lineIndex += 1) {
        let productIndex = hashNumber(`${saleKey}:product:${lineIndex}`) % catalog.length;
        while (chosen.has(productIndex)) productIndex = (productIndex + 1) % catalog.length;
        chosen.add(productIndex);
        const product = catalog[productIndex];
        const quantity = 1 + (hashNumber(`${saleKey}:qty:${lineIndex}`) % 3);
        const lineTotal = product.sellPrice * quantity;
        sold[productIndex] += quantity;
        items.push({productIndex, quantity, unitPrice:product.sellPrice, costPrice:product.costPrice, lineTotal});
        grossProfit += (product.sellPrice - product.costPrice) * quantity;
      }
      const total = items.reduce((sum, item) => sum + item.lineTotal, 0);
      const kind = ["cash","card","split","transfer"][saleIndex % 4];
      let payments;
      if (kind === "split") {
        const cash = Math.floor(total * 0.4 / 500) * 500;
        payments = [{method:"cash",amount:cash},{method:"card",amount:total-cash}];
      } else payments = [{method:kind,amount:total}];
      payments.forEach((payment) => { paymentTotals[payment.method] += payment.amount; });
      const hour = 8 + ((saleIndex * 47 + day.index * 13) % 13);
      const minute = (saleIndex * 17 + day.index * 11) % 60;
      sales.push({
        key:saleKey, dayIndex:day.index, saleIndex, businessDate:day.date,
        createdAt:`${day.date}T${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}:00+05:00`,
        items, total, payments, paymentKind:kind,
      });
      revenue += total;
    }
  }
  sales.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const finalStock = catalog.map((product, index) => ({productIndex:index, received:product.received, sold:sold[index], quantity:product.received-sold[index]}));
  return {catalog, days, sales, finalStock, summary:{revenue,grossProfit,payments:paymentTotals,paymentTotal:Object.values(paymentTotals).reduce((a,b)=>a+b,0)}};
}
