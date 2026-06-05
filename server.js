/**
 * Wincars window-sticker proxy — MarketCheck NeoVIN edition.
 *
 * Env vars (Render → Environment):
 *   MC_API_KEY      — MarketCheck API key  (mc_live_...)
 *   VDB_API_KEY     — (optional) legacy vehicledatabases key, used as fallback
 *
 * Endpoints:
 *   GET /api/window-sticker?vin=...   sticker-shaped JSON (mapped)
 *   GET /api/vin-decode?vin=...       raw MarketCheck NeoVIN passthrough
 *   GET /api/raw?vin=...              same as above (alias)
 *   GET /api/info                     account info if available
 */

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import "dotenv/config";

const app = express();
const PORT = process.env.PORT || 3000;
const MC_API_KEY  = process.env.MC_API_KEY  || "";
const VDB_API_KEY = process.env.VDB_API_KEY || "";

if (!MC_API_KEY && !VDB_API_KEY) {
  console.error("❌ Need MC_API_KEY (or legacy VDB_API_KEY) env var.");
  process.exit(1);
}
console.log(`▶ Provider: ${MC_API_KEY ? "MarketCheck NeoVIN" : "vehicledatabases (legacy)"}`);

app.use(cors());
app.use(express.static("./"));

/* ===== helpers ===== */
const parseNum = v => {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  const cleaned = String(v).replace(/[, $]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
};
const safeStr = v => (v === null || v === undefined ? "" : String(v));

/* ===== MarketCheck NeoVIN fetcher ===== */
async function fetchFromMarketCheck(vin) {
  const url = `https://api.marketcheck.com/v2/decode/car/neovin/${encodeURIComponent(vin)}/specs?api_key=${encodeURIComponent(MC_API_KEY)}`;
  const r = await fetch(url, { headers: { "Accept": "application/json" } });
  console.log(`[MC] GET ${url.replace(MC_API_KEY, "***")} → ${r.status}`);
  const text = await r.text();
  if (!r.ok) {
    const err = new Error(`MarketCheck error HTTP ${r.status}: ${text.slice(0, 200)}`);
    err.status = r.status; err.body = text;
    throw err;
  }
  try { return JSON.parse(text); }
  catch { throw new Error("Bad JSON from MarketCheck: " + text.slice(0, 200)); }
}

/* ===== Endpoints ===== */
app.get("/api/window-sticker", async (req, res) => {
  const vin = (req.query.vin || "").trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
    return res.status(400).json({ error: "Invalid VIN (must be 17 chars)." });
  }
  try {
    const raw = await fetchFromMarketCheck(vin);
    res.json(mapMarketCheckToSticker(raw, vin));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.body || "" });
  }
});

app.get(["/api/vin-decode", "/api/raw"], async (req, res) => {
  const vin = (req.query.vin || "").trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
    return res.status(400).json({ error: "Invalid VIN." });
  }
  try {
    const raw = await fetchFromMarketCheck(vin);
    res.json(raw);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.body || "" });
  }
});

app.get("/api/info", async (_req, res) => {
  try {
    // MarketCheck account info endpoint (if available on the plan)
    const r = await fetch(`https://api.marketcheck.com/v2/account/info?api_key=${encodeURIComponent(MC_API_KEY)}`, {
      headers: { "Accept": "application/json" }
    });
    res.status(r.status).type("application/json").send(await r.text());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ===== Mapper: MarketCheck NeoVIN → sticker JSON ===== */

// MarketCheck NeoVIN typically returns something like:
// {
//   vin, year, make, model, trim, body_type, vehicle_type,
//   engine: { engine_size, cylinders, fuel_type, horsepower, ... },
//   transmission: "Automatic" | { name, ... },
//   drivetrain, doors, seating, msrp, invoice,
//   exterior_color, interior_color,
//   options: [ { code, name, price, type } ],
//   installed_equipment: [ ... ] or features: [ ... ],
//   epa_mileage: { city, highway, combined },
//   safety_ratings: { ... } or nhtsa: { ... },
//   warranties: [ ... ]
// }
// The exact shape varies — this mapper is forgiving and falls back to "" / 0 / [].

function pickFirst(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

function mapMarketCheckToSticker(raw, vin) {
  // MarketCheck may wrap in { data: {...} } or return at top level
  const d = (raw && raw.data) ? raw.data : (raw || {});

  // Year / Make / Model
  const year  = safeStr(pickFirst(d, "year", "model_year"));
  const make  = safeStr(pickFirst(d, "make", "manufacturer", "brand")).toUpperCase();
  const baseModel = safeStr(pickFirst(d, "model", "model_name"));
  const trim  = safeStr(pickFirst(d, "trim", "trim_name"));
  const style = safeStr(pickFirst(d, "style", "trim_and_style", "vehicle_type"));
  const modelFull = [baseModel, trim, style].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

  // Pricing
  const msrp        = parseNum(pickFirst(d, "msrp", "base_msrp", "base_price"));
  const destination = parseNum(pickFirst(d, "destination", "destination_charge", "delivery_charges"));
  const optionsTotal = parseNum(pickFirst(d, "options_total", "options_price"));
  const invoiceP    = parseNum(pickFirst(d, "invoice", "invoice_price"));
  const totalPrice  = parseNum(pickFirst(d, "total_price", "total_msrp")) || (msrp + destination + optionsTotal);

  // Engine
  const engineObj = d.engine || d.powertrain || {};
  const engineParts = [];
  const disp = pickFirst(engineObj, "displacement", "engine_size", "size");
  if (disp) engineParts.push(typeof disp === "number" && disp > 100 ? `${(disp / 1000).toFixed(1)}L` : String(disp));
  const cylinders = pickFirst(engineObj, "cylinders", "engine_cylinders");
  if (cylinders) engineParts.push(`I-${cylinders}`.replace("I-I-", "I-"));
  const compressor = pickFirst(engineObj, "compressor", "aspiration");
  if (compressor && /turbo/i.test(String(compressor))) engineParts.push("Turbo");
  engineParts.push("Engine");
  const engine = engineParts.filter(Boolean).join(" ");

  // Transmission
  const transObj = d.transmission || {};
  const transmission = safeStr(
    typeof transObj === "string" ? transObj :
    pickFirst(transObj, "name", "description", "type")
  );

  // Drivetrain
  const drivetrain = safeStr(pickFirst(d, "drivetrain", "drive_type", "driveline"));

  // Colors
  const exteriorColor = safeStr(pickFirst(d, "exterior_color", "ext_color"));
  const interiorColor = safeStr(pickFirst(d, "interior_color", "int_color"));

  // Body / doors / seats
  const bodyType = safeStr(pickFirst(d, "body_type", "body_style", "vehicle_class"));
  const doors    = safeStr(pickFirst(d, "doors", "num_doors"));
  const seats    = safeStr(pickFirst(d, "seating", "seats", "max_seating"));

  // Fuel economy
  const mpg = d.epa_mileage || d.mpg || d.fuel_economy || {};
  const fuelEconomy = {
    type:                safeStr(pickFirst(d, "fuel_type", "fuel", "fuel_grade") || "Gasoline") + " Vehicle",
    combinedMpg:         parseNum(pickFirst(mpg, "combined", "combined_mpg", "epa_combined", "epa_combined_economy")),
    cityMpg:             parseNum(pickFirst(mpg, "city",     "city_mpg",     "epa_city",     "epa_city_economy")),
    highwayMpg:          parseNum(pickFirst(mpg, "highway",  "highway_mpg",  "epa_highway",  "epa_hwy_economy")),
    gallonsPer100Miles:  0,
    annualFuelCost:      parseNum(pickFirst(mpg, "annual_fuel_cost", "annual_cost")),
    fuelCostVsAverage:   0, fuelCostYears: 5, bestVehicleMpge: 140, ghgRating: 0
  };
  if (fuelEconomy.combinedMpg) {
    fuelEconomy.gallonsPer100Miles = +(100 / fuelEconomy.combinedMpg).toFixed(1);
  }

  // Safety ratings (NHTSA-style 1–5 stars)
  const sr = d.safety_ratings || d.nhtsa || d.nhtsa_safety || {};
  const findStar = (...keys) => {
    for (const k of keys) {
      const v = sr[k];
      if (v !== undefined && v !== null && v !== "") return parseNum(v);
    }
    return 0;
  };
  const safetyRatings = {
    overall:               findStar("overall", "overall_rating", "overall_stars"),
    frontalCrashDriver:    findStar("frontal_driver", "frontal_crash_driver", "driver"),
    frontalCrashPassenger: findStar("frontal_passenger", "frontal_crash_passenger", "passenger"),
    sideCrashFrontSeat:    findStar("side_front", "side_crash_front", "side_driver"),
    sideCrashRearSeat:     findStar("side_rear", "side_crash_rear", "side_passenger"),
    rollover:              findStar("rollover", "rollover_rating")
  };

  // ---- safe-array helper: takes anything, returns array ----
  const toArray = v => {
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") return Object.values(v).filter(x => x && typeof x === "object");
    return [];
  };

  // Warranty
  const warrantiesRaw = toArray(d.warranties || d.warranty);
  const warranty = warrantiesRaw.map(w => ({
    name: safeStr(pickFirst(w, "type", "name", "title")).replace(/\b\w/g, c => c.toUpperCase()),
    terms: w.miles
      ? `${w.months || w.term_months || "?"} months / ${w.miles} miles`
      : (w.terms || `${w.months || "?"} months`)
  }));

  // Optional equipment (options / packages)
  const optionsRaw = toArray(d.options || d.installed_options || d.packages);
  const optionalEquipment = optionsRaw
    .filter(o => o && (o.name || o.description || o.title))
    .map(o => ({
      category: safeStr(pickFirst(o, "category", "type", "group") || "Other")
                  .replace(/_/g, " ")
                  .replace(/\w\S*/g, t => t[0].toUpperCase() + t.slice(1).toLowerCase()),
      name:     safeStr(pickFirst(o, "name", "description", "title")),
      price:    parseNum(pickFirst(o, "price", "msrp")) || (o.price ?? "included"),
      features: Array.isArray(o.features) ? o.features : []
    }));

  // Standard equipment / features
  const featuresRaw = toArray(
    d.installed_equipment || d.features || d.standard_features || d.standard_options || d.installed_features
  );
  const featureStrings = featuresRaw.flatMap(f => {
    if (typeof f === "string") return [f];
    if (f && (f.name || f.description || f.title)) return [safeStr(f.name || f.description || f.title)];
    if (f && Array.isArray(f.items)) return f.items.map(safeStr);
    return [];
  });

  // Categorise features into our 7 sticker buckets
  const COMFORT_RX = /seat|head\s?rest|leather|heated|ventilated|armrest|lumbar|recline|climate|air condition|hvac|heater|carpet|trim|cup\s?holder|sunroof|moonroof|sunshade|cushion/i;
  const TECH_RX    = /bluetooth|usb|smartphone|voice|navigation|wifi|wireless|carplay|android auto|sirius|hd radio|aux audio|streaming|wireless charg|garage door|homelink|pre-?sense|premium audio|sound system|infotainment/i;
  const SAFE_RX    = /airbag|abs|brake|stability|traction|warning|monitoring|lane|crash|safety|alarm|theft|key|child|cruise/i;
  const POW_RX     = /engine|transmission|cylinder|drivetrain|drive type|axle|suspension|differential|alternator|battery|exhaust/i;
  const EXT_RX     = /wheel|tire|rim|spoiler|bumper|grille|fog|headl|tail\s?l|mirror|door handle|paint|moulding|trim ring|panoramic|wiper/i;
  const ENT_RX     = /radio|speaker|amplif|subwoofer|cd|dvd|sd card|aux|usb|bluetooth|connected services|carplay|android/i;

  const standardEquipment = {
    "COMFORT": [],
    "CONVENIENCE": [],
    "EXTERIOR AND APPEARANCE": [],
    "IN-CAR ENTERTAINMENT": [],
    "POWERTRAIN AND MECHANICAL": [],
    "SAFETY AND SECURITY": [],
    "TECHNOLOGY AND TELEMATICS": []
  };
  for (const f of featureStrings) {
    if (SAFE_RX.test(f))       standardEquipment["SAFETY AND SECURITY"].push(f);
    else if (POW_RX.test(f))   standardEquipment["POWERTRAIN AND MECHANICAL"].push(f);
    else if (EXT_RX.test(f))   standardEquipment["EXTERIOR AND APPEARANCE"].push(f);
    else if (ENT_RX.test(f))   standardEquipment["IN-CAR ENTERTAINMENT"].push(f);
    else if (TECH_RX.test(f))  standardEquipment["TECHNOLOGY AND TELEMATICS"].push(f);
    else if (COMFORT_RX.test(f)) standardEquipment["COMFORT"].push(f);
    else                       standardEquipment["CONVENIENCE"].push(f);
  }

  return {
    make,
    year,
    model: modelFull || baseModel,
    modelNumber:  safeStr(pickFirst(d, "model_number", "style_id", "model_code")),
    exteriorColor, interiorColor,
    bodyType, doors, seats,
    pricing: { msrp, destination, totalPrice, optionsTotal },
    engine,
    transmission,
    drivetrain,
    summary: safeStr(pickFirst(d, "summary", "description")),
    warranty,
    optionalEquipment,
    standardEquipment,
    equipmentLayout: {
      columnA: ["COMFORT", "CONVENIENCE", "EXTERIOR AND APPEARANCE", "IN-CAR ENTERTAINMENT"],
      columnB: ["POWERTRAIN AND MECHANICAL", "SAFETY AND SECURITY", "TECHNOLOGY AND TELEMATICS"]
    },
    fuelEconomy,
    safetyRatings,
    country:      safeStr(pickFirst(d, "country_of_origin", "country", "manufacturer_country")),
    manufacturer: safeStr(pickFirst(d, "manufacturer", "make") || make),
    vin
  };
}

app.listen(PORT, () => {
  console.log(`✅ Wincars window-sticker server (MarketCheck) running on port ${PORT}`);
});
