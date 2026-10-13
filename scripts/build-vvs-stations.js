// Converts the VVS stop list (opendata-oepnv.de "Haltestellen VVS" CSV) into
// public/vvs-stations.json for the station search drawer.
//
// Usage: node scripts/build-vvs-stations.js [path/to/vvs_haltestelle_jXX.csv]
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CSV = path.join(ROOT, 'scripts', 'data', 'vvs_haltestelle_j26.csv');
const OUT_FILE = path.join(ROOT, 'public', 'vvs-stations.json');

// Semicolon-separated, optionally double-quoted fields ("" escapes a quote)
function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ';') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

// Coordinates use a decimal comma ("9,2285864")
const toNum = (s) => {
  const n = Number(String(s || '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

function main() {
  const csvPath = path.resolve(process.argv[2] || DEFAULT_CSV);
  // The VVS export is ISO-8859-1 encoded
  const text = fs.readFileSync(csvPath, 'latin1');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const col = (name) => {
    const idx = header.indexOf(name);
    if (idx === -1) throw new Error(`Column "${name}" not found in ${csvPath}`);
    return idx;
  };
  const C = {
    name: col('Name'),
    nameWithPlace: col('Name mit Ort'),
    globalId: col('Globale ID'),
    municipality: col('Gemeinde'),
    district: col('Teilort'),
    modes: col('Verkehrsmittel'),
    lines: col('Linien (EFA)'),
    x: col('X-Koordinate'),
    y: col('Y-Koordinate'),
  };

  const stations = [];
  const seen = new Set();
  for (const line of lines.slice(1)) {
    const f = parseCsvLine(line);
    const globalId = (f[C.globalId] || '').trim();
    const name = (f[C.name] || '').trim();
    if (!globalId || !name || seen.has(globalId)) continue;
    seen.add(globalId);

    const municipality = (f[C.municipality] || '').trim();
    const district = (f[C.district] || '').trim();
    const modes = (f[C.modes] || '').split(';').map((s) => s.trim()).filter(Boolean);
    const nameWithPlace = (f[C.nameWithPlace] || '').trim();

    // Extra text the search matches against besides the name
    const searchText = [...new Set([nameWithPlace, municipality, district])]
      .filter((s) => s && s !== name)
      .join(' ');

    const station = {
      name,
      place: municipality,
      eva: `VVS_${globalId}`,
      lat: toNum(f[C.y]),
      lon: toNum(f[C.x]),
      tags: modes.map((m) => m.toUpperCase()),
      lines: (f[C.lines] || '').trim(),
      vvs: true,
    };
    if (searchText) station.searchText = searchText;
    stations.push(station);
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(stations));
  console.log(`Wrote ${stations.length} VVS stations to ${path.relative(ROOT, OUT_FILE)}`);
}

main();
