/* Grids for an area: map projections, the lattice of cells (square, angled or hexagonal), painting polygons onto it, and
   the files: GeoTIFF, shapefile, GeoJSON. Nothing here depends on the page; js/grid.js brings the data and the sheet. */
WG.gridfiles = (function () {
  const rad = Math.PI / 180;

  /* ---------- projections ---------- */
  /* transverse Mercator by the Krüger series (Karney 2011), WGS 84 */
  const A = 6378137, FL = 1 / 298.257223563, n = FL / (2 - FL), n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;
  const RECT = (A / (1 + n)) * (1 + n2 / 4 + n4 / 64 + n6 / 256), K0 = 0.9996, ECC = (2 * Math.sqrt(n)) / (1 + n);
  const ALPHA = [n / 2 - (2 * n2) / 3 + (5 * n3) / 16 + (41 * n4) / 180 - (127 * n5) / 288 + (7891 * n6) / 37800,
    (13 * n2) / 48 - (3 * n3) / 5 + (557 * n4) / 1440 + (281 * n5) / 630 - (1983433 * n6) / 1935360,
    (61 * n3) / 240 - (103 * n4) / 140 + (15061 * n5) / 26880 + (167603 * n6) / 181440,
    (49561 * n4) / 161280 - (179 * n5) / 168 + (6601661 * n6) / 7257600,
    (34729 * n5) / 80640 - (3418889 * n6) / 1995840,
    (212378941 * n6) / 319334400];
  const BETA = [n / 2 - (2 * n2) / 3 + (37 * n3) / 96 - n4 / 360 - (81 * n5) / 512 + (96199 * n6) / 604800,
    n2 / 48 + n3 / 15 - (437 * n4) / 1440 + (46 * n5) / 105 - (1118711 * n6) / 3870720,
    (17 * n3) / 480 - (37 * n4) / 840 - (209 * n5) / 4480 + (5569 * n6) / 90720,
    (4397 * n4) / 161280 - (11 * n5) / 504 - (830251 * n6) / 7257600,
    (4583 * n5) / 161280 - (108847 * n6) / 3991680,
    (20648693 * n6) / 638668800];
  const DELTA = [2 * n - (2 * n2) / 3 - 2 * n3, (7 * n2) / 3 - (8 * n3) / 5, (56 * n3) / 15];
  function utm(zone) {
    const lon0 = (zone * 6 - 183) * rad;
    return { id: `utm${zone}`, epsg: 32600 + zone, name: `UTM zone ${zone}N (WGS 84, EPSG:${32600 + zone})`,
      prj: `PROJCS["WGS_1984_UTM_Zone_${zone}N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",${zone * 6 - 183}.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]`,
      fwd(lon, lat) {
        const s = Math.sin(lat * rad), dl = lon * rad - lon0, t = Math.sinh(Math.atanh(s) - ECC * Math.atanh(ECC * s));
        const xi0 = Math.atan2(t, Math.cos(dl)), eta0 = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
        let xi = xi0, eta = eta0;
        ALPHA.forEach((a, j) => { const k = 2 * (j + 1); xi += a * Math.sin(k * xi0) * Math.cosh(k * eta0); eta += a * Math.cos(k * xi0) * Math.sinh(k * eta0); });
        return [500000 + K0 * RECT * eta, K0 * RECT * xi];
      },
      inv(E, N) {
        const xi = N / (K0 * RECT), eta = (E - 500000) / (K0 * RECT);
        let xi0 = xi, eta0 = eta;
        BETA.forEach((b, j) => { const k = 2 * (j + 1); xi0 -= b * Math.sin(k * xi) * Math.cosh(k * eta); eta0 -= b * Math.cos(k * xi) * Math.sinh(k * eta); });
        const chi = Math.asin(Math.sin(xi0) / Math.cosh(eta0));
        let phi = chi;
        DELTA.forEach((d, j) => { phi += d * Math.sin(2 * (j + 1) * chi); });
        return [(lon0 + Math.atan2(Math.sinh(eta0), Math.cos(xi0))) / rad, phi / rad];
      } };
  }
  /* CONUS Albers equal area (NAD 83, EPSG:5070), the grid of NLCD and the Cropland Data Layer (Snyder 1987, Eqs. 3-12, 14-3 to 14-11) */
  const ALBERS = (function () {
    const a = 6378137, f = 1 / 298.257222101, e2 = f * (2 - f), e = Math.sqrt(e2), lon0 = -96 * rad;
    const q = s => (1 - e2) * (s / (1 - e2 * s * s) - Math.log((1 - e * s) / (1 + e * s)) / (2 * e));
    const m = p => Math.cos(p) / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
    const p1 = 29.5 * rad, p2 = 45.5 * rad, q1 = q(Math.sin(p1)), q2 = q(Math.sin(p2)), m1 = m(p1), m2 = m(p2);
    const nn = (m1 * m1 - m2 * m2) / (q2 - q1), C = m1 * m1 + nn * q1, r0 = (a * Math.sqrt(C - nn * q(Math.sin(23 * rad)))) / nn;
    return { id: "albers", epsg: 5070, name: "CONUS Albers (NAD 83, EPSG:5070), as NLCD and the Cropland Data Layer",
      prj: 'PROJCS["NAD_1983_Contiguous_USA_Albers",GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Albers"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",-96.0],PARAMETER["Standard_Parallel_1",29.5],PARAMETER["Standard_Parallel_2",45.5],PARAMETER["Latitude_Of_Origin",23.0],UNIT["Meter",1.0]]',
      fwd(lon, lat) {
        const r = (a * Math.sqrt(C - nn * q(Math.sin(lat * rad)))) / nn, th = nn * (lon * rad - lon0);
        return [r * Math.sin(th), r0 - r * Math.cos(th)];
      },
      inv(E, N) {
        const r = Math.hypot(E, r0 - N), th = Math.atan2(E, r0 - N), qq = (C - ((r * nn) / a) ** 2) / nn;
        let p = Math.asin(qq / 2);
        for (let i = 0; i < 8; i++) { const s = Math.sin(p), w = 1 - e2 * s * s; p += ((w * w) / (2 * Math.cos(p))) * (qq / (1 - e2) - s / w + Math.log((1 - e * s) / (1 + e * s)) / (2 * e)); }
        return [(lon0 + th / nn) / rad, p / rad];
      } };
  })();
  const zoneOf = lon => Math.floor((lon + 180) / 6) + 1;

  /* ---------- the lattice ---------- */
  /* Cells of a given size on the map's easting and northing, turned clockwise by angle (degrees) about the origin (ox,
     oy). Square cells have the size as their side; hexagons as the width across their flats, with their points up or,
     with flat: true, sideways. u and v are the lattice's own axes. A cell is (i, j); its centre decides what it holds. */
  function lattice({ kind = "square", size, angle = 0, ox = 0, oy = 0, flat = false }) {
    const hex = kind === "hex", th = (angle + (hex && flat ? 90 : 0)) * rad, c = Math.cos(th), s = Math.sin(th);
    const du = size, dv = hex ? (size * Math.sqrt(3)) / 2 : size;
    const L = { kind, size, angle, ox, oy, flat, du, dv, hex,
      area: hex ? (size * size * Math.sqrt(3)) / 2 : size * size,
      toUV: (E, N) => [c * (E - ox) - s * (N - oy), s * (E - ox) + c * (N - oy)],
      fromUV: (u, v) => [ox + c * u + s * v, oy - s * u + c * v],
      // the first column's centre is at shift(j) × du on row j
      shift: j => (hex ? (j & 1 ? 0.5 : 0) : 0.5),
      vOf: j => (hex ? j : j + 0.5) * dv,
      centre: (i, j) => L.fromUV((i + L.shift(j)) * du, L.vOf(j)),
      // corners, clockwise as a shapefile wants them, closed
      ring(i, j) {
        const cu = (i + L.shift(j)) * du, cv = L.vOf(j);
        if (!hex) return [[-1, -1], [-1, 1], [1, 1], [1, -1], [-1, -1]].map(([a, b]) => L.fromUV(cu + (a * du) / 2, cv + (b * dv) / 2));
        const R = size / Math.sqrt(3);
        return [270, 330, 30, 90, 150, 210, 270].map(d => L.fromUV(cu - (R * Math.cos(d * rad)), cv + R * Math.sin(d * rad)));
      } };
    return L;
  }
  /* The rows and columns a boundary needs: { L, j0, j1, i0, i1, rows, cols, count }. Row 0 is the top: the largest v. */
  function windowOf(L, rings) {
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    rings.forEach(r => r.forEach(([E, N]) => { const [u, v] = L.toUV(E, N); if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; }));
    const pad = L.hex ? 1 : 0, j0 = Math.floor(v0 / L.dv) - pad, j1 = Math.ceil(v1 / L.dv) + pad - (L.hex ? 0 : 1), i0 = Math.floor(u0 / L.du) - pad - (L.hex ? 1 : 0), i1 = Math.ceil(u1 / L.du) + pad - (L.hex ? 0 : 1);
    const rows = j1 - j0 + 1, cols = i1 - i0 + 1;
    return { L, j0, j1, i0, i1, rows, cols, count: rows * cols };
  }
  const indexOf = (W, i, j) => (W.j1 - j) * W.cols + (i - W.i0);
  /* Set every cell whose centre lies in the polygon (rings in map metres, even-odd) with paint(index): a scanline over
     the rows the polygon crosses, so its cost goes with its edges and rows, not with the cells of the window. */
  function paint(W, rings, set) {
    const L = W.L, cross = new Map();
    rings.forEach(r => {
      let [ua, va] = L.toUV(r[0][0], r[0][1]);
      for (let k = 1; k < r.length; k++) {
        const [ub, vb] = L.toUV(r[k][0], r[k][1]);
        if (va !== vb) {
          const lo = Math.min(va, vb), hi = Math.max(va, vb);
          // rows whose centre line lo <= v < hi
          const first = Math.max(W.j0, Math.ceil(lo / L.dv - (L.hex ? 0 : 0.5))), last = Math.min(W.j1, Math.ceil(hi / L.dv - (L.hex ? 0 : 0.5)) - 1);
          for (let j = first; j <= last; j++) {
            const u = ua + ((ub - ua) * (L.vOf(j) - va)) / (vb - va);
            let a = cross.get(j);
            if (!a) cross.set(j, (a = []));
            a.push(u);
          }
        }
        ua = ub; va = vb;
      }
    });
    cross.forEach((a, j) => {
      a.sort((x, y) => x - y);
      const sh = L.shift(j), base = (W.j1 - j) * W.cols - W.i0;
      for (let k = 0; k + 1 < a.length; k += 2) {
        const c0 = Math.max(W.i0, Math.ceil(a[k] / L.du - sh)), c1 = Math.min(W.i1, Math.ceil(a[k + 1] / L.du - sh) - 1);
        for (let i = c0; i <= c1; i++) set(base + i);
      }
    });
  }
  /* a line segment widened to half on either side and at its ends, as a polygon for paint */
  function bandRing(ax, ay, bx, by, half) {
    const dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy) || 1, ux = (dx / d) * half, uy = (dy / d) * half;
    return [[ax - ux - uy, ay - uy + ux], [bx + ux - uy, by + uy + ux], [bx + ux + uy, by + uy - ux], [ax - ux + uy, ay - uy - ux], [ax - ux - uy, ay - uy + ux]];
  }

  /* ---------- GeoTIFF ---------- */
  const deflate = async u8 => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const NODATA = -9999;
  /* A GeoTIFF of Float32 bands, one plane per band, Deflate by strips: fill(band, row, out) gives one row at a time, so
     only the compressed strips are held. North-up with pixel scale and tiepoint; turned with a transformation matrix.
     Returns a Blob. o: { width, height, names, fill, epsg, x0, y0, size, angle, progress(0-1), stop() } where (x0, y0) is
     the outer corner of the first pixel. */
  async function geotiff(o) {
    const { width: w, height: h, names } = o, B = names.length, RPS = Math.max(1, Math.min(h, Math.floor(1048576 / (w * 4)) || 1));
    const nStrips = Math.ceil(h / RPS), parts = [], counts = [], total = B * nStrips;
    let off = 8, done = 0;
    const offsets = [];
    for (let b = 0; b < B; b++) {
      for (let s = 0; s < nStrips; s++) {
        const rows = Math.min(RPS, h - s * RPS), buf = new Float32Array(w * rows);
        for (let r = 0; r < rows; r++) o.fill(b, s * RPS + r, buf.subarray(r * w, (r + 1) * w));
        const z = await deflate(new Uint8Array(buf.buffer));
        parts.push(z); offsets.push(off); counts.push(z.length); off += z.length;
        done++;
        if (o.progress && done % 8 === 0) o.progress(done / total);
        if (o.stop && o.stop()) throw new Error("stopped");
      }
    }
    if (off & 1) { parts.push(new Uint8Array(1)); off++; }
    // the tags' long values follow the directory
    const th = (o.angle || 0) * rad, c = Math.cos(th), sn = Math.sin(th), sz = o.size;
    const geo = [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, o.epsg];
    const xml = `<GDALMetadata>${names.map((n, i) => `<Item name="DESCRIPTION" sample="${i}" role="description">${n.replace(/[<&>]/g, "_")}</Item>`).join("")}</GDALMetadata>\0`;
    const nod = `${NODATA}\0`;
    const tags = [[256, 4, [w]], [257, 4, [h]], [258, 3, new Array(B).fill(32)], [259, 3, [8]], [262, 3, [1]], [273, 4, offsets], [277, 3, [B]], [278, 4, [RPS]], [279, 4, counts], [284, 3, [2]]];
    if (B > 1) tags.push([338, 3, new Array(B - 1).fill(0)]);
    tags.push([339, 3, new Array(B).fill(3)]);
    // columns run along the lattice's u axis, rows down its v axis
    if (o.angle) tags.push([34264, 12, [c * sz, -sn * sz, 0, o.x0, -sn * sz, -c * sz, 0, o.y0, 0, 0, 0, 0, 0, 0, 0, 1]]);
    else { tags.push([33550, 12, [sz, sz, 0]]); tags.push([33922, 12, [0, 0, 0, o.x0, o.y0, 0]]); }
    tags.push([34735, 3, geo], [42112, 2, xml], [42113, 2, nod]);
    const SIZE = { 2: 1, 3: 2, 4: 4, 12: 8 }, len = t => (t[1] === 2 ? t[2].length : t[2].length), ifdSize = 2 + tags.length * 12 + 4;
    let extra = 0;
    tags.forEach(t => { const b = len(t) * SIZE[t[1]]; if (b > 4) extra += b + (b & 1); });
    const tail = new ArrayBuffer(ifdSize + extra), dv = new DataView(tail), bytes = new Uint8Array(tail);
    dv.setUint16(0, tags.length, true);
    let pos = 2, ex = ifdSize;
    const put = (p, t) => {
      if (t[1] === 2) { for (let i = 0; i < t[2].length; i++) bytes[p + i] = t[2].charCodeAt(i); return; }
      const st = SIZE[t[1]];
      t[2].forEach((v, i) => { if (t[1] === 3) dv.setUint16(p + i * st, v, true); else if (t[1] === 4) dv.setUint32(p + i * st, v, true); else dv.setFloat64(p + i * st, v, true); });
    };
    tags.forEach(t => {
      const b = len(t) * SIZE[t[1]];
      dv.setUint16(pos, t[0], true); dv.setUint16(pos + 2, t[1], true); dv.setUint32(pos + 4, len(t), true);
      if (b <= 4) put(pos + 8, t);
      else { dv.setUint32(pos + 8, off + ex, true); put(ex, t); ex += b + (b & 1); }
      pos += 12;
    });
    dv.setUint32(pos, 0, true);
    const head = new ArrayBuffer(8), hv = new DataView(head);
    hv.setUint16(0, 0x4949, true); hv.setUint16(2, 42, true); hv.setUint32(4, off, true);
    if (o.progress) o.progress(1);
    return new Blob([head, ...parts, tail], { type: "image/tiff" });
  }

  /* ---------- shapefile ---------- */
  /* n polygons; rings(k) gives the rings of cell k, each closed and clockwise for an outer ring. fields: [{ name (10
     characters at most), type "N" | "C", width, dec }], value(k, f) the cell's value for field f (null for blank). */
  function shapefile(base, n, rings, fields, value, prj) {
    const shapes = new Array(n);
    let bytes = 100;
    for (let k = 0; k < n; k++) { const R = rings(k), pts = R.reduce((a, r) => a + r.length, 0); shapes[k] = R; bytes += 8 + 44 + 4 * R.length + 16 * pts; }
    const shp = new ArrayBuffer(bytes), sv = new DataView(shp), shx = new ArrayBuffer(100 + 8 * n), xv = new DataView(shx);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, at = 100;
    for (let k = 0; k < n; k++) {
      const R = shapes[k], pts = R.reduce((a, r) => a + r.length, 0), words = (44 + 4 * R.length + 16 * pts) / 2;
      sv.setInt32(at, k + 1, false); sv.setInt32(at + 4, words, false);
      xv.setInt32(100 + 8 * k, at / 2, false); xv.setInt32(104 + 8 * k, words, false);
      let a = at + 8, bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      sv.setInt32(a, 5, true);
      sv.setInt32(a + 36, R.length, true); sv.setInt32(a + 40, pts, true);
      let pa = a + 44, pp = pa + 4 * R.length, idx = 0;
      R.forEach(r => {
        sv.setInt32(pa, idx, true); pa += 4; idx += r.length;
        r.forEach(([x, y]) => { sv.setFloat64(pp, x, true); sv.setFloat64(pp + 8, y, true); pp += 16; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; });
      });
      sv.setFloat64(a + 4, bx0, true); sv.setFloat64(a + 12, by0, true); sv.setFloat64(a + 20, bx1, true); sv.setFloat64(a + 28, by1, true);
      if (bx0 < x0) x0 = bx0; if (bx1 > x1) x1 = bx1; if (by0 < y0) y0 = by0; if (by1 > y1) y1 = by1;
      at += 8 + 2 * words;
    }
    [[sv, bytes], [xv, 100 + 8 * n]].forEach(([v, b]) => {
      v.setInt32(0, 9994, false); v.setInt32(24, b / 2, false); v.setInt32(28, 1000, true); v.setInt32(32, 5, true);
      [x0, y0, x1, y1].forEach((c, i) => v.setFloat64(36 + 8 * i, n ? c : 0, true));
    });
    // dBASE III
    const rec = 1 + fields.reduce((a, f) => a + f.width, 0), hb = 33 + 32 * fields.length, dbf = new Uint8Array(hb + rec * n + 1), dv = new DataView(dbf.buffer), now = new Date();
    dbf[0] = 3; dbf[1] = now.getUTCFullYear() - 1900; dbf[2] = now.getUTCMonth() + 1; dbf[3] = now.getUTCDate();
    dv.setUint32(4, n, true); dv.setUint16(8, hb, true); dv.setUint16(10, rec, true);
    fields.forEach((f, i) => {
      const p = 32 + 32 * i;
      for (let c = 0; c < Math.min(10, f.name.length); c++) dbf[p + c] = f.name.charCodeAt(c);
      dbf[p + 11] = f.type.charCodeAt(0); dbf[p + 16] = f.width; dbf[p + 17] = f.dec || 0;
    });
    dbf[hb - 1] = 0x0d;
    let d = hb;
    for (let k = 0; k < n; k++) {
      dbf[d++] = 0x20;
      fields.forEach(f => {
        const v = value(k, f);
        let s = v === null || v === undefined || v === "" || (typeof v === "number" && !Number.isFinite(v)) ? "" : f.type === "N" ? Number(v).toFixed(f.dec || 0) : String(v);
        if (s.length > f.width) s = f.type === "N" ? Number(v).toPrecision(Math.max(1, f.width - 6)).slice(0, f.width) : s.slice(0, f.width);
        s = f.type === "N" ? s.padStart(f.width) : s.padEnd(f.width);
        for (let c = 0; c < f.width; c++) dbf[d + c] = s.charCodeAt(c) & 0x7f;
        d += f.width;
      });
    }
    dbf[d] = 0x1a;
    return [{ name: `${base}.shp`, blob: new Blob([shp]) }, { name: `${base}.shx`, blob: new Blob([shx]) }, { name: `${base}.dbf`, blob: new Blob([dbf]) },
      { name: `${base}.prj`, text: prj }, { name: `${base}.cpg`, text: "ASCII" }];
  }

  /* ---------- GeoJSON ---------- */
  /* lon-lat polygons with properties (RFC 7946: outer rings counter-clockwise), as a Blob built in pieces */
  function geojson(n, ringsLonLat, props) {
    const parts = ['{"type":"FeatureCollection","features":['];
    for (let k = 0; k < n; k++) {
      const R = ringsLonLat(k).map(r => r.slice().reverse().map(([x, y]) => [+x.toFixed(8), +y.toFixed(8)]));
      parts.push(`${k ? "," : ""}{"type":"Feature","properties":${JSON.stringify(props(k))},"geometry":{"type":"Polygon","coordinates":${JSON.stringify(R)}}}`);
    }
    parts.push("]}");
    return new Blob(parts, { type: "application/geo+json" });
  }

  return { utm, ALBERS, zoneOf, lattice, windowOf, indexOf, paint, bandRing, geotiff, shapefile, geojson, NODATA };
})();
