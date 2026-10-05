// vendor/three-mediapipe-rig/runtime/src/meshcap/parse-mcap-file.ts
import { Matrix4 as Matrix42 } from "three/webgpu";

// vendor/three-mediapipe-rig/dependencies/fflate-0.8.2/src/worker.ts
var ch2 = {};
var worker_default = (c, id, msg, transfer, cb) => {
  const w = new Worker(ch2[id] ||= URL.createObjectURL(new Blob([
    c + ';addEventListener("error",function(e){e=e.error;postMessage({$e$:[e.message,e.code,e.stack]})})'
  ], { type: "text/javascript" })));
  w.onmessage = (e) => {
    const d = e.data, ed = d.$e$;
    if (ed) {
      const err = new Error(ed[0]);
      err["code"] = ed[1];
      err.stack = ed[2];
      cb(err, null);
    } else
      cb(null, d);
  };
  w.postMessage(msg, transfer);
  return w;
};

// vendor/three-mediapipe-rig/dependencies/fflate-0.8.2/src/index.ts
var u8 = Uint8Array;
var u16 = Uint16Array;
var i32 = Int32Array;
var fleb = new u8([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0, 0, 0, 0]);
var fdeb = new u8([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 0, 0]);
var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
var freb = (eb, start) => {
  const b = new u16(31);
  for (let i = 0;i < 31; ++i) {
    b[i] = start += 1 << eb[i - 1];
  }
  const r = new i32(b[30]);
  for (let i = 1;i < 30; ++i) {
    for (let j = b[i];j < b[i + 1]; ++j) {
      r[j] = j - b[i] << 5 | i;
    }
  }
  return { b, r };
};
var { b: fl, r: revfl } = freb(fleb, 2);
fl[28] = 258, revfl[258] = 28;
var { b: fd, r: revfd } = freb(fdeb, 0);
var rev = new u16(32768);
for (let i = 0;i < 32768; ++i) {
  let x = (i & 43690) >> 1 | (i & 21845) << 1;
  x = (x & 52428) >> 2 | (x & 13107) << 2;
  x = (x & 61680) >> 4 | (x & 3855) << 4;
  rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
}
var hMap = (cd, mb, r) => {
  const s = cd.length;
  let i = 0;
  const l = new u16(mb);
  for (;i < s; ++i) {
    if (cd[i])
      ++l[cd[i] - 1];
  }
  const le = new u16(mb);
  for (i = 1;i < mb; ++i) {
    le[i] = le[i - 1] + l[i - 1] << 1;
  }
  let co;
  if (r) {
    co = new u16(1 << mb);
    const rvb = 15 - mb;
    for (i = 0;i < s; ++i) {
      if (cd[i]) {
        const sv = i << 4 | cd[i];
        const r2 = mb - cd[i];
        let v = le[cd[i] - 1]++ << r2;
        for (const m = v | (1 << r2) - 1;v <= m; ++v) {
          co[rev[v] >> rvb] = sv;
        }
      }
    }
  } else {
    co = new u16(s);
    for (i = 0;i < s; ++i) {
      if (cd[i]) {
        co[i] = rev[le[cd[i] - 1]++] >> 15 - cd[i];
      }
    }
  }
  return co;
};
var flt = new u8(288);
for (let i = 0;i < 144; ++i)
  flt[i] = 8;
for (let i = 144;i < 256; ++i)
  flt[i] = 9;
for (let i = 256;i < 280; ++i)
  flt[i] = 7;
for (let i = 280;i < 288; ++i)
  flt[i] = 8;
var fdt = new u8(32);
for (let i = 0;i < 32; ++i)
  fdt[i] = 5;
var flm = /* @__PURE__ */ hMap(flt, 9, 0);
var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
var fdm = /* @__PURE__ */ hMap(fdt, 5, 0);
var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
var max = (a) => {
  let m = a[0];
  for (let i = 1;i < a.length; ++i) {
    if (a[i] > m)
      m = a[i];
  }
  return m;
};
var bits = (d, p, m) => {
  const o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
};
var bits16 = (d, p) => {
  const o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
};
var shft = (p) => (p + 7) / 8 | 0;
var slc = (v, s, e) => {
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  return new u8(v.subarray(s, e));
};
var ec = [
  "unexpected EOF",
  "invalid block type",
  "invalid length/literal",
  "invalid distance",
  "stream finished",
  "no stream handler",
  ,
  "no callback",
  "invalid UTF-8 data",
  "extra field too long",
  "date not in range 1980-2099",
  "filename too long",
  "stream finishing",
  "invalid zip data"
];
var err = (ind, msg, nt) => {
  const e = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace)
    Error.captureStackTrace(e, err);
  if (!nt)
    throw e;
  return e;
};
var inflt = (dat, st, buf, dict) => {
  const sl = dat.length, dl = dict ? dict.length : 0;
  if (!sl || st.f && !st.l)
    return buf || new u8(0);
  const noBuf = !buf;
  const resize = noBuf || st.i != 2;
  const noSt = st.i;
  if (noBuf)
    buf = new u8(sl * 3);
  const cbuf = (l) => {
    let bl = buf.length;
    if (l > bl) {
      const nbuf = new u8(Math.max(bl * 2, l));
      nbuf.set(buf);
      buf = nbuf;
    }
  };
  let final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
  const tbts = sl * 8;
  do {
    if (!lm) {
      final = bits(dat, pos, 1);
      const type = bits(dat, pos + 1, 3);
      pos += 3;
      if (!type) {
        const s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
        if (t > sl) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + l);
        buf.set(dat.subarray(s, t), bt);
        st.b = bt += l, st.p = pos = t * 8, st.f = final;
        continue;
      } else if (type == 1)
        lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
      else if (type == 2) {
        const hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
        const tl = hLit + bits(dat, pos + 5, 31) + 1;
        pos += 14;
        const ldt = new u8(tl);
        const clt = new u8(19);
        for (let i = 0;i < hcLen; ++i) {
          clt[clim[i]] = bits(dat, pos + i * 3, 7);
        }
        pos += hcLen * 3;
        const clb = max(clt), clbmsk = (1 << clb) - 1;
        const clm = hMap(clt, clb, 1);
        for (let i = 0;i < tl; ) {
          const r = clm[bits(dat, pos, clbmsk)];
          pos += r & 15;
          const s = r >> 4;
          if (s < 16) {
            ldt[i++] = s;
          } else {
            let c = 0, n = 0;
            if (s == 16)
              n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i - 1];
            else if (s == 17)
              n = 3 + bits(dat, pos, 7), pos += 3;
            else if (s == 18)
              n = 11 + bits(dat, pos, 127), pos += 7;
            while (n--)
              ldt[i++] = c;
          }
        }
        const lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
        lbt = max(lt);
        dbt = max(dt);
        lm = hMap(lt, lbt, 1);
        dm = hMap(dt, dbt, 1);
      } else
        err(1);
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
    }
    if (resize)
      cbuf(bt + 131072);
    const lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
    let lpos = pos;
    for (;; lpos = pos) {
      const c = lm[bits16(dat, pos) & lms], sym = c >> 4;
      pos += c & 15;
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
      if (!c)
        err(2);
      if (sym < 256)
        buf[bt++] = sym;
      else if (sym == 256) {
        lpos = pos, lm = null;
        break;
      } else {
        let add = sym - 254;
        if (sym > 264) {
          const i = sym - 257, b = fleb[i];
          add = bits(dat, pos, (1 << b) - 1) + fl[i];
          pos += b;
        }
        const d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
        if (!d)
          err(3);
        pos += d & 15;
        let dt = fd[dsym];
        if (dsym > 3) {
          const b = fdeb[dsym];
          dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
        }
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + 131072);
        const end = bt + add;
        if (bt < dt) {
          const shift = dl - dt, dend = Math.min(dt, end);
          if (shift + bt < 0)
            err(3);
          for (;bt < dend; ++bt)
            buf[bt] = dict[shift + bt];
        }
        for (;bt < end; ++bt)
          buf[bt] = buf[bt - dt];
      }
    }
    st.l = lm, st.p = lpos, st.b = bt, st.f = final;
    if (lm)
      final = 1, st.m = lbt, st.d = dm, st.n = dbt;
  } while (!final);
  return bt != buf.length && noBuf ? slc(buf, 0, bt) : buf.subarray(0, bt);
};
var wbits = (d, p, v) => {
  v <<= p & 7;
  const o = p / 8 | 0;
  d[o] |= v;
  d[o + 1] |= v >> 8;
};
var wbits16 = (d, p, v) => {
  v <<= p & 7;
  const o = p / 8 | 0;
  d[o] |= v;
  d[o + 1] |= v >> 8;
  d[o + 2] |= v >> 16;
};
var hTree = (d, mb) => {
  const t = [];
  for (let i = 0;i < d.length; ++i) {
    if (d[i])
      t.push({ s: i, f: d[i] });
  }
  const s = t.length;
  const t2 = t.slice();
  if (!s)
    return { t: et, l: 0 };
  if (s == 1) {
    const v = new u8(t[0].s + 1);
    v[t[0].s] = 1;
    return { t: v, l: 1 };
  }
  t.sort((a, b) => a.f - b.f);
  t.push({ s: -1, f: 25001 });
  let l = t[0], r = t[1], i0 = 0, i1 = 1, i2 = 2;
  t[0] = { s: -1, f: l.f + r.f, l, r };
  while (i1 != s - 1) {
    l = t[t[i0].f < t[i2].f ? i0++ : i2++];
    r = t[i0 != i1 && t[i0].f < t[i2].f ? i0++ : i2++];
    t[i1++] = { s: -1, f: l.f + r.f, l, r };
  }
  let maxSym = t2[0].s;
  for (let i = 1;i < s; ++i) {
    if (t2[i].s > maxSym)
      maxSym = t2[i].s;
  }
  const tr = new u16(maxSym + 1);
  let mbt = ln(t[i1 - 1], tr, 0);
  if (mbt > mb) {
    let i = 0, dt = 0;
    const lft = mbt - mb, cst = 1 << lft;
    t2.sort((a, b) => tr[b.s] - tr[a.s] || a.f - b.f);
    for (;i < s; ++i) {
      const i22 = t2[i].s;
      if (tr[i22] > mb) {
        dt += cst - (1 << mbt - tr[i22]);
        tr[i22] = mb;
      } else
        break;
    }
    dt >>= lft;
    while (dt > 0) {
      const i22 = t2[i].s;
      if (tr[i22] < mb)
        dt -= 1 << mb - tr[i22]++ - 1;
      else
        ++i;
    }
    for (;i >= 0 && dt; --i) {
      const i22 = t2[i].s;
      if (tr[i22] == mb) {
        --tr[i22];
        ++dt;
      }
    }
    mbt = mb;
  }
  return { t: new u8(tr), l: mbt };
};
var ln = (n, l, d) => {
  return n.s == -1 ? Math.max(ln(n.l, l, d + 1), ln(n.r, l, d + 1)) : l[n.s] = d;
};
var lc = (c) => {
  let s = c.length;
  while (s && !c[--s])
    ;
  const cl = new u16(++s);
  let cli = 0, cln = c[0], cls = 1;
  const w = (v) => {
    cl[cli++] = v;
  };
  for (let i = 1;i <= s; ++i) {
    if (c[i] == cln && i != s)
      ++cls;
    else {
      if (!cln && cls > 2) {
        for (;cls > 138; cls -= 138)
          w(32754);
        if (cls > 2) {
          w(cls > 10 ? cls - 11 << 5 | 28690 : cls - 3 << 5 | 12305);
          cls = 0;
        }
      } else if (cls > 3) {
        w(cln), --cls;
        for (;cls > 6; cls -= 6)
          w(8304);
        if (cls > 2)
          w(cls - 3 << 5 | 8208), cls = 0;
      }
      while (cls--)
        w(cln);
      cls = 1;
      cln = c[i];
    }
  }
  return { c: cl.subarray(0, cli), n: s };
};
var clen = (cf, cl) => {
  let l = 0;
  for (let i = 0;i < cl.length; ++i)
    l += cf[i] * cl[i];
  return l;
};
var wfblk = (out, pos, dat) => {
  const s = dat.length;
  const o = shft(pos + 2);
  out[o] = s & 255;
  out[o + 1] = s >> 8;
  out[o + 2] = out[o] ^ 255;
  out[o + 3] = out[o + 1] ^ 255;
  for (let i = 0;i < s; ++i)
    out[o + i + 4] = dat[i];
  return (o + 4 + s) * 8;
};
var wblk = (dat, out, final, syms, lf, df, eb, li, bs, bl, p) => {
  wbits(out, p++, final);
  ++lf[256];
  const { t: dlt, l: mlb } = hTree(lf, 15);
  const { t: ddt, l: mdb } = hTree(df, 15);
  const { c: lclt, n: nlc } = lc(dlt);
  const { c: lcdt, n: ndc } = lc(ddt);
  const lcfreq = new u16(19);
  for (let i = 0;i < lclt.length; ++i)
    ++lcfreq[lclt[i] & 31];
  for (let i = 0;i < lcdt.length; ++i)
    ++lcfreq[lcdt[i] & 31];
  const { t: lct, l: mlcb } = hTree(lcfreq, 7);
  let nlcc = 19;
  for (;nlcc > 4 && !lct[clim[nlcc - 1]]; --nlcc)
    ;
  const flen = bl + 5 << 3;
  const ftlen = clen(lf, flt) + clen(df, fdt) + eb;
  const dtlen = clen(lf, dlt) + clen(df, ddt) + eb + 14 + 3 * nlcc + clen(lcfreq, lct) + 2 * lcfreq[16] + 3 * lcfreq[17] + 7 * lcfreq[18];
  if (bs >= 0 && flen <= ftlen && flen <= dtlen)
    return wfblk(out, p, dat.subarray(bs, bs + bl));
  let lm, ll, dm, dl;
  wbits(out, p, 1 + (dtlen < ftlen)), p += 2;
  if (dtlen < ftlen) {
    lm = hMap(dlt, mlb, 0), ll = dlt, dm = hMap(ddt, mdb, 0), dl = ddt;
    const llm = hMap(lct, mlcb, 0);
    wbits(out, p, nlc - 257);
    wbits(out, p + 5, ndc - 1);
    wbits(out, p + 10, nlcc - 4);
    p += 14;
    for (let i = 0;i < nlcc; ++i)
      wbits(out, p + 3 * i, lct[clim[i]]);
    p += 3 * nlcc;
    const lcts = [lclt, lcdt];
    for (let it = 0;it < 2; ++it) {
      const clct = lcts[it];
      for (let i = 0;i < clct.length; ++i) {
        const len = clct[i] & 31;
        wbits(out, p, llm[len]), p += lct[len];
        if (len > 15)
          wbits(out, p, clct[i] >> 5 & 127), p += clct[i] >> 12;
      }
    }
  } else {
    lm = flm, ll = flt, dm = fdm, dl = fdt;
  }
  for (let i = 0;i < li; ++i) {
    const sym = syms[i];
    if (sym > 255) {
      const len = sym >> 18 & 31;
      wbits16(out, p, lm[len + 257]), p += ll[len + 257];
      if (len > 7)
        wbits(out, p, sym >> 23 & 31), p += fleb[len];
      const dst = sym & 31;
      wbits16(out, p, dm[dst]), p += dl[dst];
      if (dst > 3)
        wbits16(out, p, sym >> 5 & 8191), p += fdeb[dst];
    } else {
      wbits16(out, p, lm[sym]), p += ll[sym];
    }
  }
  wbits16(out, p, lm[256]);
  return p + ll[256];
};
var deo = /* @__PURE__ */ new i32([65540, 131080, 131088, 131104, 262176, 1048704, 1048832, 2114560, 2117632]);
var et = /* @__PURE__ */ new u8(0);
var dflt = (dat, lvl, plvl, pre, post, st) => {
  const s = st.z || dat.length;
  const o = new u8(pre + s + 5 * (1 + Math.ceil(s / 7000)) + post);
  const w = o.subarray(pre, o.length - post);
  const lst = st.l;
  let pos = (st.r || 0) & 7;
  if (lvl) {
    if (pos)
      w[0] = st.r >> 3;
    const opt = deo[lvl - 1];
    const n = opt >> 13, c = opt & 8191;
    const msk = (1 << plvl) - 1;
    const prev = st.p || new u16(32768), head = st.h || new u16(msk + 1);
    const bs1 = Math.ceil(plvl / 3), bs2 = 2 * bs1;
    const hsh = (i2) => (dat[i2] ^ dat[i2 + 1] << bs1 ^ dat[i2 + 2] << bs2) & msk;
    const syms = new i32(25000);
    const lf = new u16(288), df = new u16(32);
    let lc2 = 0, eb = 0, i = st.i || 0, li = 0, wi = st.w || 0, bs = 0;
    for (;i + 2 < s; ++i) {
      const hv = hsh(i);
      let imod = i & 32767, pimod = head[hv];
      prev[imod] = pimod;
      head[hv] = imod;
      if (wi <= i) {
        const rem = s - i;
        if ((lc2 > 7000 || li > 24576) && (rem > 423 || !lst)) {
          pos = wblk(dat, w, 0, syms, lf, df, eb, li, bs, i - bs, pos);
          li = lc2 = eb = 0, bs = i;
          for (let j = 0;j < 286; ++j)
            lf[j] = 0;
          for (let j = 0;j < 30; ++j)
            df[j] = 0;
        }
        let l = 2, d = 0, ch = c, dif = imod - pimod & 32767;
        if (rem > 2 && hv == hsh(i - dif)) {
          const maxn = Math.min(n, rem) - 1;
          const maxd = Math.min(32767, i);
          const ml = Math.min(258, rem);
          while (dif <= maxd && --ch && imod != pimod) {
            if (dat[i + l] == dat[i + l - dif]) {
              let nl = 0;
              for (;nl < ml && dat[i + nl] == dat[i + nl - dif]; ++nl)
                ;
              if (nl > l) {
                l = nl, d = dif;
                if (nl > maxn)
                  break;
                const mmd = Math.min(dif, nl - 2);
                let md = 0;
                for (let j = 0;j < mmd; ++j) {
                  const ti = i - dif + j & 32767;
                  const pti = prev[ti];
                  const cd = ti - pti & 32767;
                  if (cd > md)
                    md = cd, pimod = ti;
                }
              }
            }
            imod = pimod, pimod = prev[imod];
            dif += imod - pimod & 32767;
          }
        }
        if (d) {
          syms[li++] = 268435456 | revfl[l] << 18 | revfd[d];
          const lin = revfl[l] & 31, din = revfd[d] & 31;
          eb += fleb[lin] + fdeb[din];
          ++lf[257 + lin];
          ++df[din];
          wi = i + l;
          ++lc2;
        } else {
          syms[li++] = dat[i];
          ++lf[dat[i]];
        }
      }
    }
    for (i = Math.max(i, wi);i < s; ++i) {
      syms[li++] = dat[i];
      ++lf[dat[i]];
    }
    pos = wblk(dat, w, lst, syms, lf, df, eb, li, bs, i - bs, pos);
    if (!lst) {
      st.r = pos & 7 | w[pos / 8 | 0] << 3;
      pos -= 7;
      st.h = head, st.p = prev, st.i = i, st.w = wi;
    }
  } else {
    for (let i = st.w || 0;i < s + lst; i += 65535) {
      let e = i + 65535;
      if (e >= s) {
        w[pos / 8 | 0] = lst;
        e = s;
      }
      pos = wfblk(w, pos + 1, dat.subarray(i, e));
    }
    st.i = s;
  }
  return slc(o, 0, pre + shft(pos) + post);
};
var crct = /* @__PURE__ */ (() => {
  const t = new Int32Array(256);
  for (let i = 0;i < 256; ++i) {
    let c = i, k = 9;
    while (--k)
      c = (c & 1 && -306674912) ^ c >>> 1;
    t[i] = c;
  }
  return t;
})();
var crc = () => {
  let c = -1;
  return {
    p(d) {
      let cr = c;
      for (let i = 0;i < d.length; ++i)
        cr = crct[cr & 255 ^ d[i]] ^ cr >>> 8;
      c = cr;
    },
    d() {
      return ~c;
    }
  };
};
var adler = () => {
  let a = 1, b = 0;
  return {
    p(d) {
      let n = a, m = b;
      const l = d.length | 0;
      for (let i = 0;i != l; ) {
        const e = Math.min(i + 2655, l);
        for (;i < e; ++i)
          m += n += d[i];
        n = (n & 65535) + 15 * (n >> 16), m = (m & 65535) + 15 * (m >> 16);
      }
      a = n, b = m;
    },
    d() {
      a %= 65521, b %= 65521;
      return (a & 255) << 24 | (a & 65280) << 8 | (b & 255) << 8 | b >> 8;
    }
  };
};
var dopt = (dat, opt, pre, post, st) => {
  if (!st) {
    st = { l: 1 };
    if (opt.dictionary) {
      const dict = opt.dictionary.subarray(-32768);
      const newDat = new u8(dict.length + dat.length);
      newDat.set(dict);
      newDat.set(dat, dict.length);
      dat = newDat;
      st.w = dict.length;
    }
  }
  return dflt(dat, opt.level == null ? 6 : opt.level, opt.mem == null ? st.l ? Math.ceil(Math.max(8, Math.min(13, Math.log(dat.length))) * 1.5) : 20 : 12 + opt.mem, pre, post, st);
};
var mrg = (a, b) => {
  const o = {};
  for (const k in a)
    o[k] = a[k];
  for (const k in b)
    o[k] = b[k];
  return o;
};
var wcln = (fn, fnStr, td) => {
  const dt = fn();
  const st = fn.toString();
  const ks = st.slice(st.indexOf("[") + 1, st.lastIndexOf("]")).replace(/\s+/g, "").split(",");
  for (let i = 0;i < dt.length; ++i) {
    let v = dt[i], k = ks[i];
    if (typeof v == "function") {
      fnStr += ";" + k + "=";
      const st2 = v.toString();
      if (v.prototype) {
        if (st2.indexOf("[native code]") != -1) {
          const spInd = st2.indexOf(" ", 8) + 1;
          fnStr += st2.slice(spInd, st2.indexOf("(", spInd));
        } else {
          fnStr += st2;
          for (const t in v.prototype)
            fnStr += ";" + k + ".prototype." + t + "=" + v.prototype[t].toString();
        }
      } else
        fnStr += st2;
    } else
      td[k] = v;
  }
  return fnStr;
};
var ch = [];
var cbfs = (v) => {
  const tl = [];
  for (const k in v) {
    if (v[k].buffer) {
      tl.push((v[k] = new v[k].constructor(v[k])).buffer);
    }
  }
  return tl;
};
var wrkr = (fns, init, id, cb) => {
  if (!ch[id]) {
    let fnStr = "", td2 = {}, m = fns.length - 1;
    for (let i = 0;i < m; ++i)
      fnStr = wcln(fns[i], fnStr, td2);
    ch[id] = { c: wcln(fns[m], fnStr, td2), e: td2 };
  }
  const td = mrg({}, ch[id].e);
  return worker_default(ch[id].c + ";onmessage=function(e){for(var k in e.data)self[k]=e.data[k];onmessage=" + init.toString() + "}", id, td, cbfs(td), cb);
};
var bInflt = () => [u8, u16, i32, fleb, fdeb, clim, fl, fd, flrm, fdrm, rev, ec, hMap, max, bits, bits16, shft, slc, err, inflt, inflateSync, pbf, gopt];
var bDflt = () => [u8, u16, i32, fleb, fdeb, clim, revfl, revfd, flm, flt, fdm, fdt, rev, deo, et, hMap, wbits, wbits16, hTree, ln, lc, clen, wfblk, wblk, shft, slc, dflt, dopt, deflateSync, pbf];
var pbf = (msg) => postMessage(msg, [msg.buffer]);
var gopt = (o) => o && {
  out: o.size && new u8(o.size),
  dictionary: o.dictionary
};
var cbify = (dat, opts, fns, init, id, cb) => {
  const w = wrkr(fns, init, id, (err2, dat2) => {
    w.terminate();
    cb(err2, dat2);
  });
  w.postMessage([dat, opts], opts.consume ? [dat.buffer] : []);
  return () => {
    w.terminate();
  };
};
var wbytes = (d, b, v) => {
  for (;v; ++b)
    d[b] = v, v >>>= 8;
};
var gzh = (c, o) => {
  const fn = o.filename;
  c[0] = 31, c[1] = 139, c[2] = 8, c[8] = o.level < 2 ? 4 : o.level == 9 ? 2 : 0, c[9] = 3;
  if (o.mtime != 0)
    wbytes(c, 4, Math.floor(new Date(o.mtime || Date.now()) / 1000));
  if (fn) {
    c[3] = 8;
    for (let i = 0;i <= fn.length; ++i)
      c[i + 10] = fn.charCodeAt(i);
  }
};
var gzhl = (o) => 10 + (o.filename ? o.filename.length + 1 : 0);
var zlh = (c, o) => {
  const lv = o.level, fl2 = lv == 0 ? 0 : lv < 6 ? 1 : lv == 9 ? 3 : 2;
  c[0] = 120, c[1] = fl2 << 6 | (o.dictionary && 32);
  c[1] |= 31 - (c[0] << 8 | c[1]) % 31;
  if (o.dictionary) {
    const h = adler();
    h.p(o.dictionary);
    wbytes(c, 2, h.d());
  }
};
class Deflate {
  constructor(opts, cb) {
    if (typeof opts == "function")
      cb = opts, opts = {};
    this.ondata = cb;
    this.o = opts || {};
    this.s = { l: 0, i: 32768, w: 32768, z: 32768 };
    this.b = new u8(98304);
    if (this.o.dictionary) {
      const dict = this.o.dictionary.subarray(-32768);
      this.b.set(dict, 32768 - dict.length);
      this.s.i = 32768 - dict.length;
    }
  }
  b;
  s;
  o;
  ondata;
  p(c, f) {
    this.ondata(dopt(c, this.o, 0, 0, this.s), f);
  }
  push(chunk, final) {
    if (!this.ondata)
      err(5);
    if (this.s.l)
      err(4);
    const endLen = chunk.length + this.s.z;
    if (endLen > this.b.length) {
      if (endLen > 2 * this.b.length - 32768) {
        const newBuf = new u8(endLen & -32768);
        newBuf.set(this.b.subarray(0, this.s.z));
        this.b = newBuf;
      }
      const split = this.b.length - this.s.z;
      this.b.set(chunk.subarray(0, split), this.s.z);
      this.s.z = this.b.length;
      this.p(this.b, false);
      this.b.set(this.b.subarray(-32768));
      this.b.set(chunk.subarray(split), 32768);
      this.s.z = chunk.length - split + 32768;
      this.s.i = 32766, this.s.w = 32768;
    } else {
      this.b.set(chunk, this.s.z);
      this.s.z += chunk.length;
    }
    this.s.l = final & 1;
    if (this.s.z > this.s.w + 8191 || final) {
      this.p(this.b, final || false);
      this.s.w = this.s.i, this.s.i -= 2;
    }
  }
  flush() {
    if (!this.ondata)
      err(5);
    if (this.s.l)
      err(4);
    this.p(this.b, false);
    this.s.w = this.s.i, this.s.i -= 2;
  }
}
function deflate(data, opts, cb) {
  if (!cb)
    cb = opts, opts = {};
  if (typeof cb != "function")
    err(7);
  return cbify(data, opts, [
    bDflt
  ], (ev) => pbf(deflateSync(ev.data[0], ev.data[1])), 0, cb);
}
function deflateSync(data, opts) {
  return dopt(data, opts || {}, 0, 0);
}
function inflate(data, opts, cb) {
  if (!cb)
    cb = opts, opts = {};
  if (typeof cb != "function")
    err(7);
  return cbify(data, opts, [
    bInflt
  ], (ev) => pbf(inflateSync(ev.data[0], gopt(ev.data[1]))), 1, cb);
}
function inflateSync(data, opts) {
  return inflt(data, { i: 2 }, opts && opts.out, opts && opts.dictionary);
}

class Gzip {
  c = crc();
  l = 0;
  v = 1;
  o;
  s;
  ondata;
  constructor(opts, cb) {
    Deflate.call(this, opts, cb);
  }
  push(chunk, final) {
    this.c.p(chunk);
    this.l += chunk.length;
    Deflate.prototype.push.call(this, chunk, final);
  }
  p(c, f) {
    const raw = dopt(c, this.o, this.v && gzhl(this.o), f && 8, this.s);
    if (this.v)
      gzh(raw, this.o), this.v = 0;
    if (f)
      wbytes(raw, raw.length - 8, this.c.d()), wbytes(raw, raw.length - 4, this.l);
    this.ondata(raw, f);
  }
  flush() {
    Deflate.prototype.flush.call(this);
  }
}
class Zlib {
  c = adler();
  v = 1;
  o;
  s;
  ondata;
  constructor(opts, cb) {
    Deflate.call(this, opts, cb);
  }
  push(chunk, final) {
    this.c.p(chunk);
    Deflate.prototype.push.call(this, chunk, final);
  }
  p(c, f) {
    const raw = dopt(c, this.o, this.v && (this.o.dictionary ? 6 : 2), f && 4, this.s);
    if (this.v)
      zlh(raw, this.o), this.v = 0;
    if (f)
      wbytes(raw, raw.length - 4, this.c.d());
    this.ondata(raw, f);
  }
  flush() {
    Deflate.prototype.flush.call(this);
  }
}
var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder;
var tds = 0;
try {
  td.decode(et, { stream: true });
  tds = 1;
} catch (e) {}

// vendor/three-mediapipe-rig/runtime/src/meshcap/constants.ts
var MCAP_MAGIC = 1296253264;
var MCAP_FILE_VERSION = 3;

// vendor/three-mediapipe-rig/runtime/src/tracking/util/face-tracker-utils.ts
import { BufferAttribute } from "three";
var FACE_LANDMARKS_COUNT = 478;
var createFaceLandmarksIndexAttribute = (mesh) => {
  if (mesh.geometry.hasAttribute("landmarkIndex"))
    return;
  const geometry = mesh.geometry;
  const posAttr = geometry.attributes.position;
  const uniquePositions = [];
  const seen = new Map;
  const posIndex2LandmarkIndex = [];
  for (let i = 0;i < posAttr.count; i++) {
    const key = Math.round(posAttr.getX(i) * 1e6) + "," + Math.round(posAttr.getY(i) * 1e6) + "," + Math.round(posAttr.getZ(i) * 1e6);
    if (!seen.has(key)) {
      seen.set(key, uniquePositions.length);
      uniquePositions.push(i);
    }
    const idx = seen.get(key);
    posIndex2LandmarkIndex.push(idx < FACE_LANDMARKS_COUNT ? idx : 65535);
  }
  geometry.setAttribute("landmarkIndex", new BufferAttribute(new Float32Array(posIndex2LandmarkIndex), 1));
};

// vendor/three-mediapipe-rig/runtime/src/meshcap/audio.ts
async function audioSourceToArrayBuffer(source) {
  if (source instanceof ArrayBuffer) {
    return source;
  }
  if (source instanceof File || source instanceof Blob) {
    return source.arrayBuffer();
  }
  if (typeof source === "string") {
    const res = await fetch(source);
    return res.arrayBuffer();
  }
  throw new Error(`Unsupported audio source type: ${typeof source}`);
}
async function extractAudioSprites(audioFile, clips) {
  const ctx = new AudioContext;
  const arrayBuffer = await audioSourceToArrayBuffer(audioFile);
  const sourceBuffer = await ctx.decodeAudioData(arrayBuffer);
  const audios = [];
  for (const clip of clips) {
    if (!clip.audioSprite) {
      audios.push(undefined);
      continue;
    }
    const startSample = Math.floor(clip.audioSprite.start * sourceBuffer.sampleRate);
    const lengthSample = Math.floor(clip.duration * sourceBuffer.sampleRate);
    const clipBuffer = ctx.createBuffer(sourceBuffer.numberOfChannels, lengthSample, sourceBuffer.sampleRate);
    for (let ch3 = 0;ch3 < sourceBuffer.numberOfChannels; ch3++) {
      const src = sourceBuffer.getChannelData(ch3).subarray(startSample, startSample + lengthSample);
      clipBuffer.getChannelData(ch3).set(src);
    }
    const wav = audioBufferToWav(clipBuffer);
    const blob = new Blob([wav], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const el = new Audio(url);
    clip.audioSprite.domElement = el;
    console.log("Assigned audio to clip: ", clip.name, " at ", clip.audioSprite.start, " for ", clip.duration, " seconds");
    audios.push(el);
  }
  ctx.close();
  return {
    blob: new Blob([arrayBuffer], { type: "audio/wav" }),
    sprites: clips.map((c) => c.audioSprite ? [c.audioSprite.start, c.duration] : undefined)
  };
}
function audioBufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const length = buffer.length * numChannels * 2;
  const ab = new ArrayBuffer(44 + length);
  const view = new DataView(ab);
  const write = (offset, str) => [...str].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  write(0, "RIFF");
  view.setUint32(4, 36 + length, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true);
  view.setUint16(32, numChannels * 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, length, true);
  let pos = 44;
  for (let i = 0;i < buffer.length; i++) {
    for (let ch3 = 0;ch3 < numChannels; ch3++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch3)[i]));
      view.setInt16(pos, s * 32767, true);
      pos += 2;
    }
  }
  return ab;
}
var atlasAudioContext = new WeakMap;
function createAudioAtlasPlayer(audioBuffer, clips) {
  const ctx = atlasAudioContext.get(audioBuffer) || new AudioContext;
  atlasAudioContext.set(audioBuffer, ctx);
  const gainNode = ctx.createGain();
  gainNode.connect(ctx.destination);
  gainNode.gain.value = 1;
  let currentlyPlaying;
  return {
    stopCurrent() {
      if (currentlyPlaying) {
        currentlyPlaying.stop();
        currentlyPlaying = undefined;
      }
    },
    setVolume(value) {
      gainNode.gain.value = value;
    },
    playSprite(clipIndex) {
      this.stopCurrent();
      const clip = clips[clipIndex];
      if (!clip.audioSprite)
        return;
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(gainNode);
      source.start(0, clip.audioSprite.start, clip.duration);
      currentlyPlaying = source;
      return source;
    }
  };
}

// vendor/three-mediapipe-rig/runtime/src/meshcap/material.ts
import { DataTexture, FloatType, MeshPhysicalNodeMaterial, RGBAFormat, Vector3, NearestFilter } from "three/webgpu";
import { attribute, float, instancedArray, nodeObject, positionLocal, select, texture, uniform, varying, vec2, vec3 } from "three/tsl";
function createMeshCapMaterial(atlasTexture, clips, targetMesh, host, audioAtlas) {
  const addMaterial = !host;
  host ??= new MeshPhysicalNodeMaterial;
  if (addMaterial) {
    targetMesh.material = host;
  }
  if (!targetMesh.geometry.hasAttribute("landmarkIndex")) {
    createFaceLandmarksIndexAttribute(targetMesh);
  }
  const clipInfo = [];
  const clipAspect = [];
  const clipFramesStartIndex = [];
  let cropRectIndex = 0;
  let landmarksIndex = 0;
  let totalFrames = 0;
  for (let i = 0;i < clips.length; i++) {
    const clip = clips[i];
    clipInfo.push(cropRectIndex, landmarksIndex, clip.frames.length, clip.fps);
    cropRectIndex += clip.frames.length;
    landmarksIndex += clip.frames.length * FACE_LANDMARKS_COUNT;
    totalFrames += clip.frames.length;
    clipAspect.push(clip.aspectRatio);
    clipFramesStartIndex.push(i == 0 ? 0 : clipFramesStartIndex[i - 1] + clips[i - 1].frames.length);
  }
  const clipAspectRatioNode = instancedArray(new Float32Array(clipAspect), "float");
  const cropRects = new Float32Array(clips.flatMap((clip) => clip.frames).reduce((acc, entry) => {
    acc.push(entry.frameUV.u, entry.frameUV.v, entry.frameUV.w, entry.frameUV.h);
    return acc;
  }, []));
  const landmarksCropUvs = new Float32Array(clips.flatMap((clip) => clip.frames.flatMap((frame) => [frame.cropUV.u, frame.cropUV.v, frame.cropUV.w, frame.cropUV.h])));
  const frames = clips.flatMap((clip) => clip.frames);
  const cropData = new Float32Array(frames.reduce((acc, entry) => {
    acc.push(entry.frameUV.u, entry.frameUV.v, entry.frameUV.w, entry.frameUV.h);
    return acc;
  }, []).concat(frames.reduce((acc, entry) => {
    acc.push(entry.cropUV.u, entry.cropUV.v, entry.cropUV.w, entry.cropUV.h);
    return acc;
  }, [])));
  const CROP_DATA_FRAMEUV_V = 0.25;
  const CROP_DATA_LANDMARKSCROPUV_V = 0.75;
  const cropDataTexture = new DataTexture(cropData, totalFrames, 2, RGBAFormat, FloatType);
  cropDataTexture.flipY = false;
  cropDataTexture.magFilter = NearestFilter;
  cropDataTexture.minFilter = NearestFilter;
  cropDataTexture.needsUpdate = true;
  const landmarks = new Float32Array(clips.flatMap((clip) => clip.landmarks.flatMap((marks) => marks.flatMap((m) => [m.x, m.y, m.z, 0]))));
  const width = FACE_LANDMARKS_COUNT;
  const height = totalFrames;
  const landmarkTexture = new DataTexture(landmarks, width, height, RGBAFormat, FloatType);
  landmarkTexture.flipY = false;
  landmarkTexture.magFilter = NearestFilter;
  landmarkTexture.minFilter = NearestFilter;
  landmarkTexture.needsUpdate = true;
  const atlasNode = texture(atlasTexture);
  const clipIndex = uniform(0);
  const clipFrame = uniform(0);
  const loop = uniform(true);
  const clipAspectRatio = clipAspectRatioNode.element(clipIndex);
  const clipFramesStartIndexStore = instancedArray(new Float32Array(clipFramesStartIndex), "float");
  const clipFrameIndex = clipFrame;
  const timelineFrameIndex = clipFramesStartIndexStore.element(clipIndex).add(clipFrameIndex);
  const cropRect = texture(cropDataTexture, vec2(timelineFrameIndex.add(0.5).div(totalFrames), CROP_DATA_FRAMEUV_V));
  const landmarkIndexAttr = attribute("landmarkIndex", "float").toInt();
  const landmarkIndex = varying(landmarkIndexAttr);
  const getLandmark = (landmarkIndex2) => {
    const lmIdx = nodeObject(landmarkIndex2).toFloat();
    const frameIdx = timelineFrameIndex.toFloat().add(0.5);
    const u = lmIdx.div(width).add(0.5 / width);
    const v = frameIdx.div(height).add(0.5 / height);
    const landmark = texture(landmarkTexture, vec2(u, v));
    return vec3(landmark.x, landmark.y, landmark.z);
  };
  const currentLandmark = getLandmark(landmarkIndex);
  const currentLandmarksCropCoords = texture(cropDataTexture, vec2(timelineFrameIndex.add(0.5).div(totalFrames), CROP_DATA_LANDMARKSCROPUV_V));
  const uvToUse = currentLandmark.xy.sub(currentLandmarksCropCoords.xy).div(currentLandmarksCropCoords.zw);
  const sampleUV = varying(cropRect.xy.add(uvToUse.mul(cropRect.zw)));
  const colorNode = texture(atlasNode, sampleUV);
  host.colorNode = colorNode;
  const A1 = getLandmark(234).xy;
  const A2 = getLandmark(93).xy;
  const B1 = getLandmark(454).xy;
  const B2 = getLandmark(323).xy;
  const A = A1.sub(A2).div(2).add(A2);
  const B = B1.sub(B2).div(2).add(B2);
  const center = B.sub(A).div(2).add(A);
  const geometry = targetMesh.geometry;
  const posAttr = geometry.attributes.position;
  const scaleRefIndexA = 116;
  const scaleRefIndexB = 346;
  const meshFaceReference = new Vector3().subVectors(new Vector3(posAttr.getX(scaleRefIndexA), posAttr.getY(scaleRefIndexA), posAttr.getZ(scaleRefIndexA)), new Vector3(posAttr.getX(scaleRefIndexB), posAttr.getY(scaleRefIndexB), posAttr.getZ(scaleRefIndexB))).lengthSq();
  const originA = 209;
  const originB = 429;
  const origin = uniform(new Vector3().addVectors(new Vector3(posAttr.getX(originA), posAttr.getY(originA), posAttr.getZ(originA)), new Vector3(posAttr.getX(originB), posAttr.getY(originB), posAttr.getZ(originB))).multiplyScalar(0.5));
  const geometryScaleReference = uniform(meshFaceReference);
  const landmarkScaleReference = getLandmark(scaleRefIndexB).sub(getLandmark(scaleRefIndexA)).lengthSq();
  const ratio = geometryScaleReference.div(landmarkScaleReference).sqrt();
  const positionNode = currentLandmark.sub(center).xzy.mul(vec3(1, -1, float(1).div(clipAspectRatio))).mul(ratio).add(origin);
  host.positionNode = select(landmarkIndexAttr.toUint().lessThanEqual(FACE_LANDMARKS_COUNT), positionNode, positionLocal);
  let currentClipTotalTime = 0;
  let currentClipTime = 0;
  let currentClip;
  let currentClipCallback;
  let currentFrames = clips[0].frames;
  let _play = false;
  let audiosAtlasHandler = audioAtlas ? createAudioAtlasPlayer(audioAtlas, clips) : undefined;
  let _lastKnownFaceTransform = undefined;
  const handler = {
    muted: false,
    clips,
    atlasTexture,
    material: host,
    getLastKnownFaceTransform: () => _lastKnownFaceTransform,
    goto(_clipID, _loop = true, _onEndReached, _playSound = true) {
      let _clipIndex = -1;
      if (typeof _clipID === "number") {
        _clipIndex = _clipID;
      } else {
        _clipIndex = clips.findIndex((clip2) => clip2.name === _clipID);
        if (_clipIndex === -1) {
          throw new Error(`Clip ${_clipID.toString()} not found`);
        }
      }
      loop.value = _loop;
      clipFrame.value = 0;
      clipIndex.value = _clipIndex;
      const clip = clips[_clipIndex];
      currentClip = clip;
      currentFrames = clip.frames;
      currentClipTotalTime = clip.duration;
      currentClipTime = 0;
      currentClipCallback = _onEndReached;
      _play = true;
      if (audiosAtlasHandler) {
        audiosAtlasHandler.stopCurrent();
        if (_playSound && !handler.muted && clip.audioSprite) {
          audiosAtlasHandler.playSprite(_clipIndex);
          handler.playClipAudioHook?.(_clipIndex, clip.audioSprite.start, clip.duration);
        }
      }
    },
    update(delta) {
      if (!_play)
        return;
      currentClipTime += delta;
      clipFrame.value = getFrameAtTime(currentFrames, currentClipTime, clipFrame.value);
      _lastKnownFaceTransform = currentFrames[clipFrame.value].transformMatrix;
      if (loop.value) {
        if (currentClipTime >= currentClipTotalTime) {
          currentClipTime -= currentClipTotalTime;
          clipFrame.value = 0;
          if (!handler.muted) {
            audiosAtlasHandler?.playSprite(clipIndex.value);
            if (currentClip?.audioSprite) {
              handler.playClipAudioHook?.(clipIndex.value, currentClip.audioSprite.start, currentClip.duration);
            }
          }
          currentClipCallback?.(currentClipTime);
        }
      } else {
        if (currentClipTime >= currentClipTotalTime) {
          const callback = currentClipCallback;
          currentClipCallback = undefined;
          callback?.(currentClipTotalTime);
        }
      }
    },
    dispose() {
      atlasTexture.dispose();
      host.dispose();
    },
    gotoAndLoop(clipID, _onLoop) {
      this.goto(clipID, true, _onLoop);
    },
    gotoAndPlay(clipID, _onEndReached) {
      this.goto(clipID, false, _onEndReached);
    },
    gotoAndStop(clipID, frame = 0) {
      this.goto(clipID, false, undefined, false);
      clipFrame.value = frame;
      _play = false;
    }
  };
  return handler;
}
function getFrameAtTime(frames, time, lastFrameIndex) {
  while (lastFrameIndex < frames.length - 1 && frames[lastFrameIndex + 1].startTime <= time) {
    lastFrameIndex++;
  }
  return lastFrameIndex;
}

// vendor/three-mediapipe-rig/runtime/src/meshcap/write-mcap-file.ts
async function atlasToMCap(atlas, useRelativeLandmarks = true) {
  const buffer = await atlasToMCapBuffer(atlas, useRelativeLandmarks);
  return new Promise((resolve, reject) => {
    deflate(new Uint8Array(buffer), { level: 9 }, (err2, result) => {
      if (err2)
        return reject(err2);
      const binBlob = new Blob([result], { type: "application/octet-stream" });
      resolve(binBlob);
    });
  });
}
async function atlasToMCapBuffer(atlas, useRelativeLandmarks = true) {
  const encoder = new TextEncoder;
  const totalClips = atlas.clips.length;
  const encodedIds = atlas.clips.map((clip) => encoder.encode(clip.name));
  const headerSize = 4 + 1 + 1 + 2 + 1;
  const entriesSize = encodedIds.reduce((sum, id, i) => {
    const frameCount = atlas.clips[i].frames.length;
    const idSize = 1 + id.byteLength;
    const frameCountSize = 2;
    const fpsSize = 1;
    const scaleSize = 1;
    const aspectRatioSize = 1;
    const frameCropInfoSize = (2 + 2 + 2 + 2) * 2;
    let landmarksSize = FACE_LANDMARKS_COUNT * (2 + 2 + 2);
    return sum + idSize + frameCountSize + fpsSize + scaleSize + aspectRatioSize + (useRelativeLandmarks && MCAP_FILE_VERSION < 3 ? frameCropInfoSize + landmarksSize + (frameCropInfoSize + FACE_LANDMARKS_COUNT * (1 + 1 + 1)) * (frameCount - 1) : (frameCropInfoSize + landmarksSize) * frameCount);
  }, 0);
  const audioDataSize = atlas.clips.reduce((sum, clip) => {
    return sum + 2 + 2;
  }, 0);
  const framesStartTimesSize = atlas.clips.reduce((sum, clip) => {
    return sum + clip.frames.length * 2;
  }, 0);
  const faceTransformMatricesSize = atlas.clips.reduce((sum, clip) => {
    return sum + clip.frames.length * 64;
  }, 0);
  const totalBeforeAlignmen = headerSize + entriesSize + audioDataSize + framesStartTimesSize;
  const alignedTotalBeforeAlignmen = totalBeforeAlignmen + 3 & ~3;
  const buffer = new ArrayBuffer(alignedTotalBeforeAlignmen + faceTransformMatricesSize);
  const view = new DataView(buffer);
  let offset = 0;
  view.setUint32(offset, MCAP_MAGIC);
  offset += 4;
  view.setUint8(offset, MCAP_FILE_VERSION);
  offset += 1;
  view.setUint8(offset, atlas.clips.length);
  offset += 1;
  view.setUint16(offset, atlas.atlasSize);
  offset += 2;
  view.setUint8(offset, atlas.padding);
  offset += 1;
  for (let i = 0;i < totalClips; i++) {
    view.setUint8(offset, encodedIds[i].byteLength);
    offset += 1;
    new Uint8Array(buffer, offset, encodedIds[i].byteLength).set(encodedIds[i]);
    offset += encodedIds[i].byteLength;
    view.setUint16(offset, atlas.clips[i].frames.length);
    offset += 2;
    view.setUint8(offset, atlas.clips[i].fps);
    offset += 1;
    view.setUint8(offset, Math.round(atlas.clips[i].scale * 100));
    offset += 1;
    view.setUint8(offset, Math.round(atlas.clips[i].aspectRatio * 100));
    offset += 1;
    const clipInfo = atlas.clips[i];
    for (let j = 0;j < clipInfo.frames.length; j++) {
      const landmarksCropUv = clipInfo.frames[j].cropUV;
      const frameAtlasCoords = clipInfo.frames[j].frameUV;
      const cropPrecision = 1e4;
      view.setUint16(offset, Math.round(frameAtlasCoords.u * cropPrecision));
      offset += 2;
      view.setUint16(offset, Math.round(frameAtlasCoords.v * cropPrecision));
      offset += 2;
      view.setUint16(offset, Math.round(frameAtlasCoords.w * cropPrecision));
      offset += 2;
      view.setUint16(offset, Math.round(frameAtlasCoords.h * cropPrecision));
      offset += 2;
      view.setUint16(offset, Math.round(landmarksCropUv.u * cropPrecision));
      offset += 2;
      view.setUint16(offset, Math.round(landmarksCropUv.v * cropPrecision));
      offset += 2;
      view.setUint16(offset, Math.round(landmarksCropUv.w * cropPrecision));
      offset += 2;
      view.setUint16(offset, Math.round(landmarksCropUv.h * cropPrecision));
      offset += 2;
      const landmarks = clipInfo.landmarks[j];
      const prevLandmarks = j > 0 ? clipInfo.landmarks[j - 1] : null;
      const maxZ = landmarks.reduce((max2, landmark) => Math.max(max2, Math.abs(landmark.z)), 0);
      for (let k = 0;k < FACE_LANDMARKS_COUNT; k++) {
        const x = Math.round(landmarks[k].x * 1000);
        const y = Math.round(landmarks[k].y * 1000);
        const z = Math.round(landmarks[k].z * 1000);
        if (useRelativeLandmarks) {
          if (prevLandmarks === null) {
            view.setUint16(offset, x);
            offset += 2;
            view.setUint16(offset, y);
            offset += 2;
            view.setInt16(offset, z);
            offset += 2;
          } else {
            const prevX = Math.round(prevLandmarks[k].x * 1000);
            const prevY = Math.round(prevLandmarks[k].y * 1000);
            const prevZ = Math.round(prevLandmarks[k].z * 1000);
            const dx = x - prevX;
            const dy = y - prevY;
            const dz = z - prevZ;
            view.setInt16(offset, dx);
            offset += 2;
            view.setInt16(offset, dy);
            offset += 2;
            view.setInt16(offset, dz);
            offset += 2;
          }
        } else {
          view.setUint16(offset, x);
          offset += 2;
          view.setUint16(offset, y);
          offset += 2;
          view.setInt16(offset, z);
          offset += 2;
        }
      }
    }
  }
  for (let i = 0;i < totalClips; i++) {
    const clipInfo = atlas.clips[i];
    view.setUint16(offset, Math.round(clipInfo.duration * 1000));
    offset += 2;
    if (clipInfo.audioSprite) {
      view.setUint16(offset, Math.round(clipInfo.audioSprite.start * 1000));
    } else {
      view.setUint16(offset, 1);
    }
    offset += 2;
  }
  for (let i = 0;i < totalClips; i++) {
    const clipInfo = atlas.clips[i];
    let lastTimestamp = 0;
    for (const frame of clipInfo.frames) {
      const delta = Math.floor((frame.startTime - lastTimestamp) * 1000);
      view.setUint16(offset, delta);
      offset += 2;
      lastTimestamp = frame.startTime;
    }
  }
  offset = offset + 3 & ~3;
  for (let i = 0;i < totalClips; i++) {
    const clipInfo = atlas.clips[i];
    for (const frame of clipInfo.frames) {
      if (frame.transformMatrix)
        frame.transformMatrix.toArray(new Float32Array(buffer, offset, 16));
      else
        new Float32Array(buffer, offset, 16).fill(0);
      offset += 64;
    }
  }
  return buffer;
}

// vendor/three-mediapipe-rig/runtime/src/meshcap/parse-mcap-file.ts
async function loadMeshCapFile(mcapFileSource) {
  if (typeof mcapFileSource === "string") {
    const response = await fetch(mcapFileSource);
    const buffer = await response.arrayBuffer();
    return deserializeMCapFile(buffer);
  } else {
    return new Promise((resolve, reject) => {
      const reader = new FileReader;
      reader.onload = (e) => {
        const buffer = e.target.result;
        resolve(deserializeMCapFile(buffer));
      };
      reader.onerror = (e) => {
        reject(e);
      };
      reader.readAsArrayBuffer(mcapFileSource);
    });
  }
}
async function deserializeMCapFile(compressedBuffer, decompress = true) {
  let usesAudioAtlas = false;
  const decompressed = decompress ? await new Promise((resolve, reject) => {
    inflate(new Uint8Array(compressedBuffer), (err2, result) => {
      if (err2)
        reject(err2);
      else
        resolve(result);
    });
  }) : new Uint8Array(compressedBuffer);
  const view = new DataView(decompressed.buffer);
  let offset = 0;
  const magic = view.getUint32(offset);
  offset += 4;
  if (magic !== MCAP_MAGIC)
    throw new Error("Invalid file: not a MCAP file");
  const version = view.getUint8(offset);
  offset += 1;
  const clipsCount = view.getUint8(offset);
  offset += 1;
  const atlasSize = view.getUint16(offset);
  offset += 2;
  const atlasPadding = view.getUint8(offset);
  offset += 1;
  const clips = [];
  for (let i = 0;i < clipsCount; i++) {
    const nameLength = view.getUint8(offset);
    offset += 1;
    const nameBytes = new Uint8Array(decompressed.buffer, offset, nameLength);
    const name = new TextDecoder().decode(nameBytes);
    offset += nameLength;
    const frameCount = version >= 3 ? view.getUint16(offset) : view.getUint8(offset);
    offset += version >= 3 ? 2 : 1;
    const fps = view.getUint8(offset);
    offset += 1;
    const scale = view.getUint8(offset) / 100;
    offset += 1;
    const aspectRatio = view.getUint8(offset) / 100;
    offset += 1;
    const frameCoords = [];
    const landmarks = [];
    const uvCrop = [];
    for (let j = 0;j < frameCount; j++) {
      const cropPrecision = version < 3 ? 1000 : 1e4;
      const atlasX = view.getUint16(offset) / cropPrecision;
      offset += 2;
      const atlasY = view.getUint16(offset) / cropPrecision;
      offset += 2;
      const atlasWidth = view.getUint16(offset) / cropPrecision;
      offset += 2;
      const atlasHeight = view.getUint16(offset) / cropPrecision;
      offset += 2;
      frameCoords.push({ u: atlasX, v: atlasY, w: atlasWidth, h: atlasHeight });
      const u = view.getUint16(offset) / cropPrecision;
      offset += 2;
      const v = view.getUint16(offset) / cropPrecision;
      offset += 2;
      const w = view.getUint16(offset) / cropPrecision;
      offset += 2;
      const h = view.getUint16(offset) / cropPrecision;
      offset += 2;
      uvCrop.push({ u, v, w, h });
      const frameLandmarks = [];
      const prevLandmarks = j > 0 ? landmarks[j - 1] : null;
      for (let k = 0;k < FACE_LANDMARKS_COUNT; k++) {
        if (prevLandmarks === null) {
          const x = view.getUint16(offset) / 1000;
          offset += 2;
          const y = view.getUint16(offset) / 1000;
          offset += 2;
          const z = view.getInt16(offset) / 1000;
          offset += 2;
          frameLandmarks.push({ x, y, z });
        } else {
          let dx, dy, dz;
          if (version < 3) {
            dx = view.getInt8(offset) / 1000;
            offset += 1;
            dy = view.getInt8(offset) / 1000;
            offset += 1;
            dz = view.getInt8(offset) / 1000;
            offset += 1;
            frameLandmarks.push({
              x: prevLandmarks[k].x + dx,
              y: prevLandmarks[k].y + dy,
              z: prevLandmarks[k].z + dz
            });
          } else {
            dx = view.getInt16(offset) / 1000;
            offset += 2;
            dy = view.getInt16(offset) / 1000;
            offset += 2;
            dz = view.getInt16(offset) / 1000;
            offset += 2;
            frameLandmarks.push({
              x: prevLandmarks[k].x + dx,
              y: prevLandmarks[k].y + dy,
              z: prevLandmarks[k].z + dz
            });
          }
        }
      }
      landmarks.push(frameLandmarks);
    }
    clips.push({
      name,
      fps,
      scale,
      aspectRatio,
      frames: uvCrop.map((cropUV, i2) => ({
        cropUV,
        frameUV: frameCoords[i2],
        startTime: i2 / fps
      })),
      landmarks,
      duration: frameCount / fps
    });
  }
  if (version >= 2) {
    for (let i = 0;i < clips.length; i++) {
      let clipDuration = view.getUint16(offset);
      offset += 2;
      clips[i].duration = clipDuration / 1000;
      let audioStart = view.getUint16(offset);
      offset += 2;
      if (audioStart === 1) {
        console.log("Clip " + i + " has no audio");
      } else {
        audioStart /= 1000;
        clips[i].audioSprite = { start: audioStart };
        usesAudioAtlas = true;
        console.log("MCAP AUDIO CLIP;", audioStart, "Duration: ", clipDuration / 1000);
      }
    }
    for (let i = 0;i < clips.length; i++) {
      const clipInfo = clips[i];
      let lastTimestamp = 0;
      for (let j = 0;j < clipInfo.frames.length; j++) {
        const delta = version < 3 ? view.getUint8(offset) : view.getUint16(offset);
        offset += version < 3 ? 1 : 2;
        const timestamp = lastTimestamp + delta / 1000;
        clipInfo.frames[j].startTime = timestamp;
        lastTimestamp = timestamp;
      }
    }
    if (version >= 3) {
      offset = offset + 3 & ~3;
      for (let i = 0;i < clips.length; i++) {
        const clipInfo = clips[i];
        for (let j = 0;j < clipInfo.frames.length; j++) {
          const matrix = new Float32Array(view.buffer, offset, 16);
          offset += 64;
          clipInfo.frames[j].transformMatrix = new Matrix42().fromArray(matrix);
        }
      }
    }
  }
  return {
    clips,
    version,
    atlasSize,
    atlasPadding,
    async unpackClips(atlasSource, audioAtlasSource) {
      let atlas;
      let disposeAfter = true;
      let audioAtlas = undefined;
      let atlasContext = undefined;
      if (atlasSource instanceof HTMLCanvasElement) {
        disposeAfter = false;
        atlas = atlasSource;
        atlasContext = atlas.getContext("2d");
      } else {
        let img = new Image;
        if (typeof atlasSource === "string") {
          img.src = atlasSource;
        } else if (atlasSource instanceof File || atlasSource instanceof Blob) {
          const url = URL.createObjectURL(atlasSource);
          img.src = url;
          await new Promise((resolve, reject) => {
            img.onload = () => {
              URL.revokeObjectURL(url);
              resolve();
            };
            img.onerror = reject;
          });
        } else if (atlasSource instanceof HTMLImageElement) {
          img = atlasSource;
        }
        if (!img.complete || !img.naturalWidth) {
          await new Promise((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = reject;
          });
        }
        atlas = document.createElement("canvas");
        atlas.width = img.width;
        atlas.height = img.height;
        atlasContext = atlas.getContext("2d");
        atlasContext.drawImage(img, 0, 0);
      }
      const recordedClips = clips.map((clip) => {
        return {
          ...clip,
          frames: clip.frames.map((frame) => {
            const frameCanvas = document.createElement("canvas");
            frameCanvas.width = frame.frameUV.w * atlas.width;
            frameCanvas.height = frame.frameUV.h * atlas.height;
            const frameCtx = frameCanvas.getContext("2d");
            frameCtx.drawImage(atlas, frame.frameUV.u * atlas.width, frame.frameUV.v * atlas.height, frame.frameUV.w * atlas.width, frame.frameUV.h * atlas.height, 0, 0, frameCanvas.width, frameCanvas.height);
            return {
              canvas: frameCanvas,
              cropUV: frame.cropUV,
              startTime: frame.startTime,
              transformMatrix: frame.transformMatrix
            };
          })
        };
      });
      if (disposeAfter) {
        atlas.remove();
      }
      if (usesAudioAtlas) {
        if (!audioAtlasSource) {
          console.warn("This mcap file uses an audio atlas, but no audio atlas file was provided.");
        } else {
          audioAtlas = await extractAudioSprites(audioAtlasSource, recordedClips);
        }
      }
      return {
        clips: recordedClips,
        audioAtlas
      };
    },
    createMaterialHandlerOnMesh(mesh, atlasTexture, host, audioAtlas) {
      const handler = createMeshCapMaterial(atlasTexture, clips, mesh, host, audioAtlas);
      return handler;
    }
  };
}
async function readAsMCapFile(atlas) {
  const buffer = await atlasToMCapBuffer(atlas);
  return deserializeMCapFile(buffer, false);
}
// vendor/three-mediapipe-rig/runtime/src/meshcap/atlas-builder.ts
import { Texture as Texture2, TextureLoader } from "three";
function packShelves(items) {
  const targetWidth = computeOptimalWidth(items);
  const shelves = [];
  const packed = [];
  let currentY = 0;
  const sorted = [...items].sort((a, b) => b.height - a.height);
  for (const item of sorted) {
    let placed = false;
    for (const shelf of shelves) {
      if (item.width <= targetWidth - shelf.currentX && item.height <= shelf.height) {
        packed.push({
          ...item,
          x: shelf.currentX,
          y: shelf.y
        });
        shelf.currentX += item.width;
        placed = true;
        break;
      }
    }
    if (!placed) {
      const newShelf = {
        y: currentY,
        height: item.height,
        currentX: item.width
      };
      shelves.push(newShelf);
      packed.push({
        ...item,
        x: 0,
        y: currentY
      });
      currentY += item.height;
    }
  }
  const actualWidth = shelves.length > 0 ? Math.max(...shelves.map((s) => s.currentX)) : 0;
  const actualHeight = currentY;
  return {
    packed,
    width: Math.max(actualWidth, targetWidth),
    height: actualHeight
  };
}
function computeOptimalWidth(items) {
  if (items.length === 0)
    return 1;
  const totalArea = items.reduce((sum, item) => sum + item.width * item.height, 0);
  let optimalWidth = Math.ceil(Math.sqrt(totalArea));
  const maxItemWidth = Math.max(...items.map((i) => i.width));
  optimalWidth = Math.max(optimalWidth, maxItemWidth);
  optimalWidth = nextPowerOf2(optimalWidth);
  return optimalWidth;
}
function nextPowerOf2(n) {
  return Math.pow(2, Math.ceil(Math.log2(n)));
}
var footerHeight = 20;
function buildMeshCapAtlas(clips, atlasSize, padding = 0) {
  const canvases = clips.flatMap((clip) => clip.frames.map((frame) => frame.canvas));
  const items = Array.from(canvases.entries()).map(([id, canvas]) => ({
    id,
    width: canvas.width + padding * 2,
    height: canvas.height + padding * 2
  }));
  const packed = packShelves(items);
  const initialHeight = packed.height;
  const initialWidth = packed.width;
  const scale = Math.min(1, atlasSize / initialWidth, atlasSize / initialHeight);
  const atlasWidth = Math.floor(initialWidth * scale);
  const atlasHeight = nextPowerOf2(Math.floor(initialHeight * scale) + footerHeight);
  const atlasCanvas = document.createElement("canvas");
  atlasCanvas.width = atlasWidth;
  atlasCanvas.height = atlasHeight;
  const ctx = atlasCanvas.getContext("2d");
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, atlasCanvas.width, atlasCanvas.height);
  const entries = [];
  for (const pack of packed.packed) {
    const sourceCanvas = canvases[pack.id];
    const x = pack.x + padding;
    const y = pack.y + padding;
    const width = sourceCanvas.width;
    const height = sourceCanvas.height;
    ctx.drawImage(sourceCanvas, x * scale, y * scale, width * scale, height * scale);
    entries[pack.id] = {
      u: x * scale / atlasWidth,
      v: y * scale / atlasHeight,
      w: width * scale / atlasWidth,
      h: height * scale / atlasHeight
    };
  }
  const mcapClips = [];
  let frameIndex = 0;
  for (const clip of clips) {
    const mcapClip = {
      ...clip,
      frames: []
    };
    for (const frame of clip.frames) {
      mcapClip.frames.push({
        frameUV: entries[frameIndex++],
        cropUV: frame.cropUV,
        startTime: frame.startTime,
        transformMatrix: frame.transformMatrix
      });
    }
    mcapClips.push(mcapClip);
  }
  ctx.font = `${Math.max(6, Math.floor(12))}px monospace`;
  ctx.fillStyle = "#ff0000";
  ctx.fillText("Created with MeshCap : https://bandinopla.github.io/three-mediapipe-rig/?editor=meshcap", 0, atlasHeight - 4);
  return {
    canvas: atlasCanvas,
    clips: mcapClips,
    padding,
    atlasSize,
    async save(downloadFile) {
      const binBlob = await atlasToMCap(this);
      if (downloadFile) {
        const binUrl = URL.createObjectURL(binBlob);
        const binLink = document.createElement("a");
        binLink.href = binUrl;
        binLink.download = `atlas.mcap`;
        binLink.click();
        URL.revokeObjectURL(binUrl);
        binLink.remove();
      }
      return binBlob;
    },
    async saveImageAtlas(phrase, asJpg) {
      const link = document.createElement("a");
      link.download = asJpg ? "atlas.jpg" : "atlas.png";
      let canvas = this.canvas;
      if (phrase) {
        return await downloadObfuscatedCanvas(canvas, phrase, asJpg);
      }
      link.href = canvas.toDataURL(asJpg ? "image/jpeg" : "image/png", asJpg ? 0.8 : 1);
      link.click();
    }
  };
}
function xorBuffer(buffer, pass) {
  const data = new Uint8Array(buffer);
  let key = 0;
  for (let i = 0;i < pass.length; i++) {
    key = key + pass.charCodeAt(i) & 255;
  }
  for (let i = 0;i < data.length; i++) {
    data[i] ^= key;
  }
  return data;
}
async function downloadObfuscatedCanvas(canvas, pass, asJpg) {
  const blob = await new Promise((res) => canvas.toBlob(res, asJpg ? "image/jpeg" : "image/png", asJpg ? 0.8 : 1));
  const buffer = await blob.arrayBuffer();
  const data = xorBuffer(buffer, pass);
  const outBlob = new Blob([data], { type: "application/octet-stream" });
  const url = URL.createObjectURL(outBlob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "atlas.mcatlas";
  a.click();
  URL.revokeObjectURL(url);
}
async function loadMeshcapAtlas(atlasSource, pass) {
  if (typeof atlasSource === "string") {
    if (atlasSource.endsWith(".mcatlas")) {
      const response = await fetch(atlasSource);
      const buffer = await response.arrayBuffer();
      return await deObfuscate(buffer, pass);
    } else {
      return new TextureLoader().loadAsync(atlasSource);
    }
  } else {
    if (atlasSource.name.endsWith(".mcatlas")) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader;
        reader.onload = (e) => {
          const buffer = e.target.result;
          resolve(deObfuscate(buffer, pass));
        };
        reader.onerror = (e) => {
          reject(e);
        };
        reader.readAsArrayBuffer(atlasSource);
      });
    }
    const url = URL.createObjectURL(atlasSource);
    return await new Promise((resolve, reject) => {
      new TextureLoader().load(url, resolve, undefined, reject);
    });
  }
}
async function deObfuscate(buffer, pass) {
  if (!pass) {
    throw new Error("No passphrase provided");
  }
  const data = xorBuffer(buffer, pass);
  const blob = new Blob([data], { type: "image/png" });
  const url = URL.createObjectURL(blob);
  const image = document.createElement("img");
  await new Promise((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = reject;
    image.src = url;
  });
  const texture2 = new Texture2(image);
  texture2.needsUpdate = true;
  return texture2;
}
async function obfuscateImage(image, pass) {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const buffer = await new Promise((resolve, reject) => {
    canvas.toBlob((jpgBlob) => {
      if (!jpgBlob) {
        reject(new Error("Failed to create blob"));
        return;
      }
      resolve(jpgBlob.arrayBuffer());
    }, "image/jpeg", 0.75);
  });
  const data = xorBuffer(buffer, pass);
  return new Blob([data], { type: "application/octet-stream" });
}
export {
  readAsMCapFile,
  obfuscateImage,
  loadMeshcapAtlas,
  loadMeshCapFile,
  extractAudioSprites,
  createMeshCapMaterial,
  createAudioAtlasPlayer,
  buildMeshCapAtlas,
  audioBufferToWav
};
