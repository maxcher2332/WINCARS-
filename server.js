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
  const d = (raw && raw.data) ? raw.data : (raw || {});

  // Year / Make / Model
  const year  = safeStr(pickFirst(d, "year", "model_year"));
  const make  = safeStr(pickFirst(d, "make", "manufacturer", "brand")).toUpperCase();
  const baseModel = safeStr(pickFirst(d, "model", "model_name"));
  const trim  = safeStr(pickFirst(d, "trim", "trim_name"));
  const modelFull = [baseModel, trim].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

  // Pricing
  const msrp         = parseNum(pickFirst(d, "msrp", "base_msrp", "base_price"));
  const destination  = parseNum(pickFirst(d, "delivery_charges", "destination", "destination_charge"));
  const optionsTotal = parseNum(pickFirst(d, "installed_options_msrp", "options_total", "options_price"));
  const totalPrice   = parseNum(pickFirst(d, "combined_msrp", "total_price", "total_msrp")) || (msrp + destination + optionsTotal);

  // Engine — MarketCheck returns a string like "2.0L I4"
  const engine = (typeof d.engine === "string")
    ? d.engine + " Engine"
    : (() => {
        const e = d.engine || d.powertrain || {};
        const parts = [];
        const disp = pickFirst(e, "displacement", "engine_size", "size");
        if (disp) parts.push(typeof disp === "number" && disp > 100 ? `${(disp / 1000).toFixed(1)}L` : String(disp));
        const cyl = pickFirst(e, "cylinders", "engine_cylinders");
        if (cyl) parts.push(`I-${cyl}`);
        if (/turbo/i.test(String(pickFirst(e, "compressor", "aspiration") || ""))) parts.push("Turbo");
        parts.push("Engine");
        return parts.filter(Boolean).join(" ");
      })();

  // Transmission — MarketCheck returns a string
  const transmission = safeStr(
    typeof d.transmission === "string" ? d.transmission :
    pickFirst(d.transmission || {}, "name", "description", "type")
  );

  // Drivetrain
  const drivetrain = safeStr(pickFirst(d, "drivetrain", "drive_type", "driveline"));

  // Powertrain type (HEV/EV/etc) — append to engine description for richness
  const powertrainType = safeStr(d.powertrain_type);
  const engineFull = powertrainType && !engine.toLowerCase().includes(powertrainType.toLowerCase())
    ? `${engine} (${powertrainType})`
    : engine;

  // Colors
  const exteriorColor = safeStr(pickFirst(d, "exterior_color", "ext_color"));
  const interiorColor = safeStr(pickFirst(d, "interior_color", "int_color"));

  // Body / doors / seats
  const bodyType = safeStr(pickFirst(d, "body_type", "body_style", "vehicle_class", "vehicle_type"));
  const doors    = safeStr(pickFirst(d, "doors", "num_doors"));
  const seats    = safeStr(pickFirst(d, "seating_capacity", "seating", "seats", "max_seating"));

  // Fuel economy — MarketCheck has these at top level
  const fuelEconomy = {
    type:                safeStr(pickFirst(d, "fuel_type", "fuel", "fuel_grade") || "Gasoline") + " Vehicle",
    combinedMpg:         parseNum(pickFirst(d, "combined_mpg", "epa_combined")),
    cityMpg:             parseNum(pickFirst(d, "city_mpg", "epa_city")),
    highwayMpg:          parseNum(pickFirst(d, "highway_mpg", "epa_highway")),
    gallonsPer100Miles:  0,
    annualFuelCost:      0,
    fuelCostVsAverage:   0, fuelCostYears: 5, bestVehicleMpge: 140, ghgRating: 0
  };
  if (fuelEconomy.combinedMpg) {
    fuelEconomy.gallonsPer100Miles = +(100 / fuelEconomy.combinedMpg).toFixed(1);
  }

  // Safety ratings — MarketCheck uses { rating: { safety: { front, side, overall }, rollover } }
  const ratingObj = d.rating || {};
  const safetyObj = ratingObj.safety || d.safety_ratings || {};
  const safetyRatings = {
    overall:               parseNum(pickFirst(safetyObj, "overall", "overall_rating")),
    frontalCrashDriver:    parseNum(pickFirst(safetyObj, "front", "frontal_driver", "driver")),
    frontalCrashPassenger: parseNum(pickFirst(safetyObj, "front", "frontal_passenger", "passenger")),
    sideCrashFrontSeat:    parseNum(pickFirst(safetyObj, "side", "side_front", "side_driver")),
    sideCrashRearSeat:     parseNum(pickFirst(safetyObj, "side", "side_rear", "side_passenger")),
    rollover:              parseNum(pickFirst(ratingObj, "rollover", "rollover_rating"))
  };

  // ---- Warranty: MarketCheck returns OBJECT with keys total/powertrain/anti_corrosion/roadside_assistance
  // Each inner: { duration: months, distance: miles }
  const wObj = d.warranty || {};
  const warrantyMap = [
    { key: "total",                name: "Basic Warranty" },
    { key: "powertrain",           name: "Powertrain Warranty" },
    { key: "anti_corrosion",       name: "Anti-Corrosion Warranty" },
    { key: "roadside_assistance",  name: "Roadside Assistance" }
  ];
  const warranty = warrantyMap
    .filter(w => wObj[w.key] && (wObj[w.key].duration || wObj[w.key].distance))
    .map(w => {
      const inner = wObj[w.key];
      const months = inner.duration;
      const miles  = inner.distance;
      const milesStr = (miles && miles !== 999999) ? `${Number(miles).toLocaleString("en-US")} miles` : null;
      const terms = [months ? `${months} months` : null, milesStr].filter(Boolean).join(" / ");
      return { name: w.name, terms: terms || "—" };
    });

  // ---- Optional equipment: from installed_options_details array
  const optionsRaw = Array.isArray(d.installed_options_details) ? d.installed_options_details : [];
  const optionalEquipment = optionsRaw.map(o => ({
    category: "Installed Options",
    name:     safeStr(o.name || o.description),
    price:    parseNum(o.msrp ?? o.sale_price),
    features: []
  }));

  // ---- Standard equipment: features.STANDARD array — categorise by `category` field
  const featuresObj = d.features || {};
  const standardFeatures = Array.isArray(featuresObj.STANDARD) ? featuresObj.STANDARD : [];

  const standardEquipment = {
    "COMFORT": [], "CONVENIENCE": [],
    "EXTERIOR AND APPEARANCE": [],
    "IN-CAR ENTERTAINMENT": [],
    "POWERTRAIN AND MECHANICAL": [],
    "SAFETY AND SECURITY": [],
    "TECHNOLOGY AND TELEMATICS": []
  };

  const COMFORT_HINT = /seat|head\s?rest|leather|heated|ventilated|armrest|lumbar|climate|air condition|hvac|carpet|cushion|sunroof|moonroof|cup\s?holder|vanity|console|massage/i;
  const TECH_HINT    = /bluetooth|usb|smartphone|navigation|wifi|wireless|carplay|android auto|sirius|hd radio|aux audio|streaming|charg|garage door|homelink|pre-?sense|premium audio|sound system|infotainment|voice|telematic|app/i;

  for (const f of standardFeatures) {
    const desc = safeStr(f.description || f.feature_type);
    if (!desc) continue;
    const cat = safeStr(f.category).toLowerCase();
    let bucket;
    if (cat.includes("safety") || cat.includes("driver assist")) {
      bucket = "SAFETY AND SECURITY";
    } else if (cat.includes("infotainment") || cat.includes("entertainment")) {
      bucket = TECH_HINT.test(desc) ? "TECHNOLOGY AND TELEMATICS" : "IN-CAR ENTERTAINMENT";
    } else if (cat.includes("engine") || cat.includes("transmission") || cat.includes("powertrain") || cat.includes("suspension") || cat.includes("hybrid") || cat.includes("electric") || cat.includes("fuel") || cat.includes("brake")) {
      bucket = "POWERTRAIN AND MECHANICAL";
    } else if (cat.includes("exterior")) {
      bucket = "EXTERIOR AND APPEARANCE";
    } else if (cat.includes("comfort") || cat.includes("convenience")) {
      bucket = COMFORT_HINT.test(desc) ? "COMFORT" : "CONVENIENCE";
    } else if (cat.includes("interior")) {
      bucket = COMFORT_HINT.test(desc) ? "COMFORT" : "CONVENIENCE";
    } else {
      bucket = "CONVENIENCE";
    }
    standardEquipment[bucket].push(desc);
  }

  // Dedupe
  for (const k in standardEquipment) {
    standardEquipment[k] = [...new Set(standardEquipment[k])];
  }

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
    modelNumber:  safeStr(pickFirst(d, "manufacturer_code", "model_number", "style_id", "model_code")),
    exteriorColor: safeStr(pickFirst(d, "exterior_color", "ext_color")),
    interiorColor: safeStr(pickFirst(d, "interior_color", "int_color")),
    bodyType, doors, seats,
    pricing: { msrp, destination, totalPrice, optionsTotal },
    engine: engineFull,
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
    country:      safeStr(pickFirst(d, "country", "country_of_origin", "manufacturer_country")),
    manufacturer: safeStr(pickFirst(d, "manufacturer", "make") || make),
    vin
  };
}

app.listen(PORT, () => {
  console.log(`✅ Wincars window-sticker server (MarketCheck) running on port ${PORT}`);
});
