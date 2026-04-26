/**
 * Wincars window-sticker proxy
 * Uses Vehicle Databases "Advanced VIN Decode" API.
 * API key lives only on the server (Render env: VDB_API_KEY).
 */

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import "dotenv/config";

const app = express();
const PORT = process.env.PORT || 3000;
const VDB_API_KEY = process.env.VDB_API_KEY;

if (!VDB_API_KEY) {
  console.error("❌ Missing VDB_API_KEY environment variable.");
  process.exit(1);
}

app.use(cors());
app.use(express.static("./"));

/* ----- helpers ----- */
const parseNum = v => {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  const cleaned = String(v).replace(/[, $]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
};
const safeStr = v => (v === null || v === undefined ? "" : String(v));

/* ----- API endpoints ----- */
app.get("/api/window-sticker", async (req, res) => {
  const vin = (req.query.vin || "").trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
    return res.status(400).json({ error: "Invalid VIN (must be 17 chars)." });
  }
  const url = `https://api.vehicledatabases.com/advanced-vin-decode/v2/${encodeURIComponent(vin)}`;
  try {
    const r = await fetch(url, {
      headers: { "x-authkey": VDB_API_KEY, "Accept": "application/json" }
    });
    console.log(`[VDB] GET ${url} → ${r.status}`);
    const text = await r.text();
    if (!r.ok) {
      return res.status(r.status).json({
        error: "Vehicle Databases API error",
        status: r.status,
        details: text
      });
    }
    let raw;
    try { raw = JSON.parse(text); }
    catch { return res.status(502).json({ error: "Bad JSON from VDB", body: text }); }
    res.json(mapToSticker(raw, vin));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

app.get("/api/vin-decode", async (req, res) => {
  const vin = (req.query.vin || "").trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
    return res.status(400).json({ error: "Invalid VIN." });
  }
  const url = `https://api.vehicledatabases.com/advanced-vin-decode/v2/${encodeURIComponent(vin)}`;
  try {
    const r = await fetch(url, {
      headers: { "x-authkey": VDB_API_KEY, "Accept": "application/json" }
    });
    const t = await r.text();
    res.status(r.status).type("application/json").send(t);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/info", async (_req, res) => {
  try {
    const r = await fetch("https://api.vehicledatabases.com/info", {
      headers: { "x-authkey": VDB_API_KEY, "Accept": "application/json" }
    });
    const t = await r.text();
    res.status(r.status).type("application/json").send(t);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =====================================================================
   Map VDB Advanced-VIN-Decode response → window-sticker format
   ===================================================================== */

// Keywords helping us classify Interior Features into COMFORT / CONVENIENCE
const COMFORT_REGEX = /seat|airbag|head\s?rest|head\s?room|leg\s?room|cushion|leather|heated|ventilated|armrest|adjustable|memory seat|massage|lumbar|recline|climate|air condition|hvac|heater|carpet|trim|leatherette|cup\s?holder|sunroof|moonroof|sunshade|sun visor|vanity mirror/i;

const TECH_REGEX = /bluetooth|usb|smartphone|voice|navigation|wifi|wireless|telematic|carplay|android auto|sirius|hd radio|aux audio|streaming|app[-\s]?link|wireless charg|map[-\s]?link|garage door|homelink|pre-?sense|connect|premium audio|sound system/i;

function categorizeInteriorFeature(feature) {
  const f = feature.toLowerCase();
  if (TECH_REGEX.test(feature)) return "tech";
  if (COMFORT_REGEX.test(feature)) return "comfort";
  return "convenience";
}

function findFeatureGroup(features, title) {
  if (!Array.isArray(features)) return [];
  const group = features.find(f => (f.title || "").toLowerCase().includes(title.toLowerCase()));
  return Array.isArray(group?.description) ? group.description : [];
}

function mapToSticker(raw, vin) {
  const d = raw?.data || {};
  const price = d.price || {};
  const features = Array.isArray(d.features) ? d.features : [];
  const specs = Array.isArray(d.specifications) ? d.specifications : [];
  const findSpec = (key) => {
    const s = specs.find(x => Object.prototype.hasOwnProperty.call(x, key));
    return s ? s[key] : {};
  };
  const engineSpec = findSpec("engine");
  const fuelSpec = findSpec("fuel");
  const mpgSpec = findSpec("mpg");
  const seatingSpec = findSpec("seating");

  // Pricing
  const msrp = parseNum(price.base_msrp);
  const destination = parseNum(price.delivery_charges);
  const totalPriceFromApi = parseNum(price.total_price);
  const totalPrice = totalPriceFromApi || (msrp + destination);

  // Equipment categorization
  const interiorFeatures = findFeatureGroup(features, "interior");
  const exteriorFeatures = findFeatureGroup(features, "exterior");
  const entertainmentFeatures = findFeatureGroup(features, "entertainment");
  const safetyFeatures = findFeatureGroup(features, "safety");
  const mechanicalFeatures = findFeatureGroup(features, "mechanical");

  const standardEquipment = {
    "COMFORT": [],
    "CONVENIENCE": [],
    "EXTERIOR AND APPEARANCE": exteriorFeatures.slice(),
    "IN-CAR ENTERTAINMENT": entertainmentFeatures.slice(),
    "POWERTRAIN AND MECHANICAL": mechanicalFeatures.slice(),
    "SAFETY AND SECURITY": safetyFeatures.slice(),
    "TECHNOLOGY AND TELEMATICS": []
  };

  // Split Interior Features into COMFORT, CONVENIENCE, TECHNOLOGY
  for (const f of interiorFeatures) {
    const cat = categorizeInteriorFeature(f);
    if (cat === "tech") standardEquipment["TECHNOLOGY AND TELEMATICS"].push(f);
    else if (cat === "comfort") standardEquipment["COMFORT"].push(f);
    else standardEquipment["CONVENIENCE"].push(f);
  }
  // Move tech-flavored entertainment items also to TECHNOLOGY
  for (const f of entertainmentFeatures) {
    if (TECH_REGEX.test(f) && !standardEquipment["TECHNOLOGY AND TELEMATICS"].includes(f)) {
      standardEquipment["TECHNOLOGY AND TELEMATICS"].push(f);
    }
  }

  // Optional equipment from oem_options_and_packages
  const oem = Array.isArray(d.oem_options_and_packages) ? d.oem_options_and_packages : [];
  const optionalEquipment = [];
  for (const groupObj of oem) {
    for (const [groupKey, items] of Object.entries(groupObj)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const desc = item?.description || {};
        // Only include "Custom" packages (those with prices)
        if (desc.package_type !== "Custom") continue;
        const cat = (item.title || groupKey || "Other").replace(/_/g, " ").replace(/&/g, "&");
        optionalEquipment.push({
          category: titleCase(cat),
          name: safeStr(desc.package_name),
          price: parseNum(desc.package_price),
          features: Array.isArray(desc.package_features) ? desc.package_features : []
        });
      }
    }
  }
  const optionsTotal = optionalEquipment.reduce((s, o) => s + (Number(o.price) || 0), 0);

  // Warranty mapping
  const warranties = Array.isArray(d.warranties) ? d.warranties : [];
  const warranty = warranties
    .filter(w => w && (w.months || w.miles))
    .map(w => ({
      name: safeStr(w.type || "").replace(/\b\w/g, c => c.toUpperCase()),
      terms: w.miles
        ? `${w.months || "?"} months / ${w.miles} miles`
        : `${w.months || "?"} months`
    }));

  // NHTSA safety ratings
  const ratingsArr = Array.isArray(d.safety_ratings) ? d.safety_ratings : [];
  const nhtsa = ratingsArr.find(r => Array.isArray(r.nhtsa_crash_test_ratings))?.nhtsa_crash_test_ratings || [];
  const findRating = (typeRegex) => {
    const r = nhtsa.find(item => typeRegex.test(item.type || ""));
    return r ? parseNum(r.rating) : 0;
  };

  const safetyRatings = {
    overall:               findRating(/^Overall$/i),
    frontalCrashDriver:    findRating(/^Driver/i) || findRating(/Overall Front/i),
    frontalCrashPassenger: findRating(/^Passenger/i),
    sideCrashFrontSeat:    findRating(/Side Barrier Rating Driver/i) || findRating(/Side - Pole/i),
    sideCrashRearSeat:     findRating(/Side Barrier Rating Passenger Rear Seat/i) || findRating(/Side - Pole Barrier combined \(REAR\)/i),
    rollover:              findRating(/Rollover/i)
  };

  // Fuel economy from specifications.mpg
  const fuelEconomy = {
    type:               (fuelSpec.type || "Gasoline") + " Vehicle",
    combinedMpg:        parseNum(mpgSpec.epa_combined_economy),
    cityMpg:            parseNum(mpgSpec.epa_city_economy),
    highwayMpg:         parseNum(mpgSpec.epa_hwy_economy),
    gallonsPer100Miles: mpgSpec.epa_combined_economy ? +(100 / parseNum(mpgSpec.epa_combined_economy)).toFixed(1) : 0,
    annualFuelCost:     0,
    fuelCostVsAverage:  0,
    fuelCostYears:      5,
    bestVehicleMpge:    140,
    ghgRating:          0
  };

  // First standard exterior/interior color (representative; VDB doesn't tell which is on THIS car)
  const exColors = Array.isArray(d.exterior_colors) ? d.exterior_colors : [];
  const inColors = Array.isArray(d.interior_colors) ? d.interior_colors : [];
  const exteriorColor = safeStr(exColors.find(c => c.color_type === "Standard")?.description || exColors[0]?.description);
  const interiorColor = safeStr(inColors.find(c => c.color_type === "Standard")?.description || inColors[0]?.description);

  // Engine description
  const engineDesc = [
    engineSpec.displacement ? `${(engineSpec.displacement / 1000).toFixed(1)}L` : "",
    engineSpec.cylinders_configuration || "",
    engineSpec.compressor && /turbo/i.test(engineSpec.compressor) ? "Turbo" : "",
    "Engine"
  ].filter(Boolean).join(" ");

  return {
    make:           safeStr(d.make).toUpperCase(),
    year:           safeStr(d.year),
    model:          safeStr(d.trim_and_style || `${d.model || ""} ${d.trim || ""}`.trim()),
    modelNumber:    safeStr(engineSpec.code || d.style_id || ""),
    exteriorColor,
    interiorColor,
    bodyType:       safeStr(d.vehicle?.body_type),
    doors:          safeStr(d.vehicle?.doors),
    seats:          safeStr(seatingSpec.number_of_seats),

    pricing: { msrp, destination, totalPrice, optionsTotal },

    engine: engineDesc,
    transmission: safeStr(d.transmission?.description || d.transmission?.type || ""),
    drivetrain: safeStr(engineSpec.drivetype || ""),

    summary: safeStr(d.summary),

    warranty,
    optionalEquipment,
    standardEquipment,

    equipmentLayout: {
      columnA: ["COMFORT", "CONVENIENCE", "EXTERIOR AND APPEARANCE", "IN-CAR ENTERTAINMENT"],
      columnB: ["POWERTRAIN AND MECHANICAL", "SAFETY AND SECURITY", "TECHNOLOGY AND TELEMATICS"]
    },

    fuelEconomy,
    safetyRatings,

    country:      safeStr(d.country || ""),
    manufacturer: safeStr(d.manufacturer || d.make || ""),
    vin
  };
}

function titleCase(s) {
  return s.replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.substring(1).toLowerCase());
}

app.listen(PORT, () => {
  console.log(`✅ Wincars window-sticker server running on port ${PORT}`);
});
