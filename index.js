const functions = require('firebase-functions');
const https     = require('https');

const AIRKOREA_KEY = 'e40ebfa9e37fa69a20c7fb7cefc1bd3fb5e871a9ee85eb17b82ec3eb695888a5';

const cache = {};
const CACHE_TTL = 30 * 60 * 1000;
function getCached(k) { const e=cache[k]; return(e&&Date.now()-e.ts<CACHE_TTL)?e.data:null; }
function setCache(k,d) { cache[k]={data:d,ts:Date.now()}; }

function setCORS(res) {
  res.set('Access-Control-Allow-Origin','*');
  res.set('Access-Control-Allow-Methods','GET,OPTIONS');
  res.set('Access-Control-Allow-Headers','Content-Type');
}

function wgs84ToTmMiddle(lat, lon) {
  const a  = 6378137.0;
  const f  = 1/298.257222101;
  const b  = a*(1-f);
  const e2 = (a*a-b*b)/(a*a);

  const lon0 = 127.0 * Math.PI/180;
  const lat0 = 38.0  * Math.PI/180;
  const k0   = 1.0;
  const FE   = 200000.0;
  const FN   = 500000.0;

  const latR = lat * Math.PI/180;
  const lonR = lon * Math.PI/180;

  const N = a / Math.sqrt(1 - e2*Math.sin(latR)**2);
  const T = Math.tan(latR)**2;
  const C = e2/(1-e2) * Math.cos(latR)**2;
  const A = Math.cos(latR)*(lonR - lon0);

  const M0 = a*((1 - e2/4 - 3*e2**2/64 - 5*e2**3/256)*lat0
    - (3*e2/8 + 3*e2**2/32 + 45*e2**3/1024)*Math.sin(2*lat0)
    + (15*e2**2/256 + 45*e2**3/1024)*Math.sin(4*lat0)
    - (35*e2**3/3072)*Math.sin(6*lat0));

  const M = a*((1 - e2/4 - 3*e2**2/64 - 5*e2**3/256)*latR
    - (3*e2/8 + 3*e2**2/32 + 45*e2**3/1024)*Math.sin(2*latR)
    + (15*e2**2/256 + 45*e2**3/1024)*Math.sin(4*latR)
    - (35*e2**3/3072)*Math.sin(6*latR));

  const x = FE + k0*N*(A + (1-T+C)*A**3/6 + (5-18*T+T**2+72*C-58*e2/(1-e2))*A**5/120);
  const y = FN + k0*(M - M0 + N*Math.tan(latR)*(A**2/2 + (5-T+9*C+4*C**2)*A**4/24
    + (61-58*T+T**2+600*C-330*e2/(1-e2))*A**6/720));

  return { x: Math.round(x), y: Math.round(y) };
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    console.log('[GET]', url);
    https.get(url, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        console.log('[RES]', r.statusCode, d.slice(0,200));
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error('parse: '+d.slice(0,100))); }
      });
    }).on('error', reject);
  });
}

function airkoreaGet(endpoint, params) {
  const qs = new URLSearchParams({
    ...params,
    serviceKey: AIRKOREA_KEY,
    returnType: 'json',
    numOfRows:  '5',
    pageNo:     '1',
  }).toString();
  return httpsGet(`https://apis.data.go.kr/B552584/ArpltnInforInqireSvc/${endpoint}?${qs}`);
}

exports.getAQI = functions.https.onRequest(async (req, res) => {
  setCORS(res);
  if (req.method==='OPTIONS') { res.status(204).send(''); return; }

  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (!lat||!lon) { res.status(400).json({error:'lat,lon required'}); return; }

  const cacheKey = `aqi_${lat.toFixed(2)}_${lon.toFixed(2)}`;
  const cached = getCached(cacheKey);
  if (cached) { res.json({...cached,cached:true}); return; }

  try {
    const tm = wgs84ToTmMiddle(lat, lon);
    console.log('[TM]', tm.x, tm.y);

    const sd = await airkoreaGet('getNearbyMsrstnList', { tmX: tm.x, tmY: tm.y, ver: '1.1' });
    const station = sd?.response?.body?.items?.[0];
    if (!station) throw new Error('측정소없음: '+JSON.stringify(sd?.response?.header));
    console.log('[STATION]', station.stationName);

    const ad = await airkoreaGet('getMsrstnAcctoRltmMesureDnsty', {
      stationName: station.stationName,
      dataTerm: 'DAILY', ver: '1.4',
    });
    const item = ad?.response?.body?.items?.[0];
    if (!item) throw new Error('데이터없음: '+JSON.stringify(ad?.response?.header));

    const result = {
      success: true,
      pm25: parseFloat(item.pm25Value) || 0,
      pm10: parseFloat(item.pm10Value) || 0,
      station: station.stationName,
      addr:    station.addr,
      o3:   parseFloat(item.o3Value)  || 0,
      no2:  parseFloat(item.no2Value) || 0,
      khai: item.khaiValue || '-',
      updatedAt: item.dataTime,
    };

    setCache(cacheKey, result);
    res.json(result);

  } catch(err) {
    console.error('[ERR]', err.message);
    res.status(500).json({error: err.message});
  }
});

// ── Claude 번역/설명 생성 프록시 ──
exports.claudeTranslate = functions.https.onRequest(async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const { text, name, addr, type } = req.body || {};

  let prompt = '';
  if (type === 'translate' && text) {
    prompt = 'Translate this Korean tourism description to natural English in 2-3 sentences. Return only the translation: ' + text.slice(0, 500);
  } else if (type === 'generate' && name) {
    const catLabels = { '76':'tourist attraction','78':'cultural facility','79':'shopping destination','80':'leisure spot','82':'accommodation','85':'festival or event' };
    const catLabel = catLabels[String(req.body.catType || '')] || 'place';
    prompt = 'Write a 2-3 sentence English description for this Korean ' + catLabel + '. Name: ' + name + ', Address: ' + (addr||'') + '. Write naturally as if for a travel guide. Return only the description.';
  } else {
    res.status(400).json({ error: 'invalid params' }); return;
  }

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });
    const result = message.content[0].text.trim();
    res.json({ result });
  } catch(e) {
    console.error('Claude error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
