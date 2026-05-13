// netlify/functions/ai.js
// Handles all AI requests: hero summary, drawer assessment, news, infrastructure
// Uses Groq API (set GROQ_API_KEY in Netlify environment variables)

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'llama-3.3-70b-versatile'; // fast, capable Groq model

// ─── CORS headers ──────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

// ─── Groq caller ────────────────────────────────────────────────────────────
async function callGroq(systemPrompt, userPrompt, opts = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY environment variable is not set');

  const body = {
    model: MODEL,
    max_tokens: opts.maxTokens || 600,
    temperature: opts.temperature ?? 0.55,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
  };

  const resp = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Groq API error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// ─── Prompt builders ────────────────────────────────────────────────────────

function buildHeroPrompt({ pin, district, state, scoreLines, composite, ovrLabel }) {
  const sys = `You are a concise, expert physical climate risk analyst specialising in India. 
Write factual, location-specific assessments — never generic. 
Respond in 3–5 plain sentences, no JSON, no bullet points, no preamble.`;

  const usr = `Summarise the overall physical climate risk profile for PIN code ${pin} (${district}, ${state}, India).
Overall IPCC composite risk score (Hazard + Exposure + Vulnerability, equal thirds): ${composite}/100 — ${ovrLabel}.
Scores: ${scoreLines}.

Your summary must:
1. State the overall risk level and what combination of hazard, exposure, and vulnerability drives it.
2. Name the dominant hazard and WHY this location is exposed (geography, climate zone, history).
3. Comment on exposure (population/asset density) and vulnerability (social fragility) if they meaningfully raise or lower risk.
4. Give a clear, actionable overall risk verdict.

Return only plain text, 3–5 sentences.`;

  return { sys, usr };
}

function buildDrawerPrompt({ pin, district, state, key, label, score, rLabel, otherScores }) {
  const sys = `You are a physical climate risk analyst writing specific, location-aware hazard assessments for India.
Always be specific to the named district and state. Never be generic. 3–4 sentences maximum.
Return only plain assessment text — no JSON, no bullet points, no preamble.`;

  const usr = `Write a ${label} risk assessment for PIN code ${pin} (${district}, ${state}, India).
Score: ${typeof score === 'number' ? score.toFixed(1) : score}/100, classified as "${rLabel}".
${otherScores ? `Other hazard context: ${otherScores}.` : ''}

Explain:
1. WHY this specific area has this score (geography, proximity to coasts/rivers/deserts, climate zone, historical events).
2. What this means practically — what events, how often, what impact.

3–4 sentences, crisp and professional. No bullet points, no preamble.`;

  return { sys, usr };
}


function buildInfraPrompt({ prompt }) {
  // The prompt is pre-built by the frontend
  const sys = `You are an infrastructure analyst for India. 
Return ONLY a valid JSON object — no markdown, no explanation, no preamble.
Keys must be exactly: road, rail, power, water, telecom, hospital, bank, market, school, warehouse.
Each key: { "status": "Available"|"Limited"|"Unavailable", "note": "one short sentence max 12 words" }.`;

  return { sys, usr: prompt };
}

// ─── Mappls API config ────────────────────────────────────────────────────────
// Uses Static Key authentication (from Mappls portal → Credentials tab).
// Optionally set MAPPLS_STATIC_KEY in Netlify environment variables.
const MAPPLS_STATIC_KEY = process.env.MAPPLS_STATIC_KEY || 'yyvgiufeqoyigxenycwsusmrawmkhsdurweg';

// ─── Handler ─────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { type } = payload;

  try {
    // ── Mappls Places Autocomplete (server-side proxy — no CORS) ─────────────
    if (type === 'places') {
      const { query } = payload;
      if (!query || query.length < 2) {
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ results: [] }) };
      }
      try {
        const siteUrl = process.env.URL || process.env.DEPLOY_URL || 'https://localhost';
        const url = `https://atlas.mappls.com/api/places/search/json?query=${encodeURIComponent(query)}&region=IND&itemCount=8&rest_key=${MAPPLS_STATIC_KEY}`;
        const resp = await fetch(url, {
          headers: { 'Referer': siteUrl, 'Origin': siteUrl },
        });
        if (!resp.ok) throw new Error(`Mappls search ${resp.status}`);
        const data = await resp.json();
        const results = (data.suggestedLocations || []).map(s => ({
          type:     'mappls',
          eLoc:     s.eLoc || '',
          label:    s.placeName || '',
          sublabel: s.placeAddress || '',
          pincode:  s.pincode ? String(s.pincode) : null,
          lat:      s.latitude  ? parseFloat(s.latitude)  : null,
          lon:      s.longitude ? parseFloat(s.longitude) : null,
        }));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ results }) };
      } catch (e) {
        // Return empty — frontend will fall back to India Post + Photon
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ results: [] }) };
      }
    }

    // ── Mappls eLoc → PIN resolver (server-side proxy) ────────────────────
    if (type === 'eloc') {
      const { eLoc } = payload;
      if (!eLoc) return { statusCode: 200, headers: CORS, body: JSON.stringify({ pin: null }) };
      try {
        const siteUrl2 = process.env.URL || process.env.DEPLOY_URL || 'https://localhost';
        const resp = await fetch(`https://atlas.mappls.com/api/places/place-details?placeId=${eLoc}&rest_key=${MAPPLS_STATIC_KEY}`, {
          headers: { 'Referer': siteUrl2, 'Origin': siteUrl2 },
        });
        if (!resp.ok) throw new Error(`Mappls eloc ${resp.status}`);
        const data = await resp.json();
        const place = data.place || data;
        const pc = String(place.pincode || place.pin || '');
        if (/^\d{6}$/.test(pc)) {
          return { statusCode: 200, headers: CORS, body: JSON.stringify({ pin: pc }) };
        }
        const lat = parseFloat(place.latitude || place.lat || 0);
        const lon = parseFloat(place.longitude || place.lon || 0);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ pin: null, lat, lon }) };
      } catch (e) {
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ pin: null }) };
      }
    }

    // ── Hero summary ──────────────────────────────────────────────────────
    if (type === 'hero') {
      const { sys, usr } = buildHeroPrompt(payload);
      const text = await callGroq(sys, usr, { maxTokens: 400, temperature: 0.5 });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ text }) };
    }

    // ── Drawer hazard assessment ──────────────────────────────────────────
    if (type === 'drawer') {
      const { sys, usr } = buildDrawerPrompt(payload);
      const text = await callGroq(sys, usr, { maxTokens: 350, temperature: 0.5 });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ text }) };
    }

    // ── Climate news via Google News RSS — district-locked, tiered queries ───
    if (type === 'rss') {
      const { district, state } = payload;
      if (!district || !state) return { statusCode: 200, headers: CORS, body: JSON.stringify({ items: [] }) };

      // ── IPCC framework keyword sets ─────────────────────────────────────────
      const hazardKeywords = [
        'flood','cyclone','drought','heatwave','heat wave','landslide','heavy rain',
        'extreme rain','inundat','disaster','submerged','casualt','deaths',
        'ndrf','red alert','orange alert','cloudburst','waterlog','storm surge',
        'evacuate','relief camp','crop loss','dam overflow','flash flood',
      ];
      const vulnerabilityKeywords = [
        'slum','informal settlement','migrant worker','climate migrant','climate refugee',
        'food insecurity','water scarcity','water crisis','drought-hit farmer',
        'displaced','homeless','urban poor','rural poor','marginalised',
        'heat illness','heat stroke','heat death','vector-borne',
        'dengue outbreak','malaria surge','hospital overwhelm',
      ];
      const exposureKeywords = [
        'coastal erosion','sea level','river bank erosion','flood plain',
        'flood zone','flood-prone','risk zone','agricultural loss','crop damage',
        'infrastructure damage','bridge collapse','road damage','power outage',
        'village submerged','homes destroyed','houses damaged','population affected',
        'lakh affected','thousand affected','displaced families',
      ];

      const rejectKeywords = [
        'crop variet','seed variet','icar','election','poll','budget','subsid',
        'inaugurate','scheme','yojana','tender','contract','gdp','stock','sensex',
      ];

      const fiveYearsAgo = new Date();
      fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
      const afterDate = fiveYearsAgo.toISOString().split('T')[0];

      const hazardTiers = [
        { q: `"${district}" flood OR cyclone OR landslide OR heatwave OR drought disaster after:${afterDate}`, mustMentionDistrict: true },
        { q: `"${district}" "heavy rain" OR "red alert" OR inundated OR cloudburst OR NDRF after:${afterDate}`, mustMentionDistrict: true },
        { q: `${district} ${state} flood OR cyclone OR landslide OR heatwave OR disaster after:${afterDate}`, mustMentionDistrict: true },
        { q: `${state} flood OR cyclone OR landslide OR heatwave disaster casualty after:${afterDate}`, mustMentionDistrict: false },
      ];
      const vulnExposureTiers = [
        { q: `"${district}" "crop damage" OR "houses damaged" OR "village submerged" OR "flood plain" OR "coastal erosion" after:${afterDate}`, mustMentionDistrict: true },
        { q: `"${district}" "heat stroke" OR "water crisis" OR "water scarcity" OR "climate migrant" OR displaced after:${afterDate}`, mustMentionDistrict: true },
        { q: `${district} ${state} "crop damage" OR "houses damaged" OR "water scarcity" OR displaced after:${afterDate}`, mustMentionDistrict: true },
        { q: `${state} "crop damage" OR "water crisis" OR "heat stroke" OR displaced disaster after:${afterDate}`, mustMentionDistrict: false },
      ];

      const districtLower = district.toLowerCase();
      const normalise = t => t.toLowerCase().replace(/[^a-z\s]/g,'').replace(/\s+/g,' ').trim().slice(0,60);
      const seenTitles = new Set();

      const cleanDesc = raw => raw
        .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/https?:\/\/[^\s"<>]+/g, '')
        .replace(/href\s*=\s*["'][^"']*["']/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 220);

      const fetchTier = async (tier, allowedKeywords) => {
        const results = [];
        try {
          const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(tier.q)}&hl=en-IN&gl=IN&ceid=IN:en`;
          const resp = await fetch(rssUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClimateRiskBot/1.0)' } });
          if (!resp.ok) return results;
          const xml = await resp.text();

          const itemRx = /<item>([\s\S]*?)<\/item>/g;
          let m;
          while ((m = itemRx.exec(xml)) !== null) {
            const b = m[1];
            const get = tag => {
              const r = b.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
              return r ? (r[1]||r[2]||'').trim() : '';
            };
            const rawTitle = get('title');
            const link     = (b.match(/<link>([^<]+)/) || [])[1] || get('link') || '';
            const pubDate  = get('pubDate');
            const desc     = cleanDesc(get('description'));
            const srcMatch = rawTitle.match(/ - ([^-]+)$/);
            const title  = srcMatch ? rawTitle.slice(0, rawTitle.lastIndexOf(' - ')).trim() : rawTitle;
            const source = srcMatch ? srcMatch[1].trim() : '';
            if (!title) continue;
            const fullText = (title + ' ' + desc).toLowerCase();
            if (!allowedKeywords.some(kw => fullText.includes(kw))) continue;
            if (rejectKeywords.some(kw => fullText.includes(kw))) continue;
            if (tier.mustMentionDistrict && !fullText.includes(districtLower)) continue;
            const norm = normalise(title);
            if ([...seenTitles].some(s => {
              const wa = new Set(norm.split(' ')), wb = s.split(' ');
              return wb.filter(w => wa.has(w)).length / Math.max(wb.length,1) > 0.6;
            })) continue;
            const pillar = hazardKeywords.some(kw => fullText.includes(kw)) ? 'hazard'
              : exposureKeywords.some(kw => fullText.includes(kw)) ? 'exposure'
              : 'vulnerability';
            seenTitles.add(norm);
            results.push({ title, link, pubDate, description: desc, source, pillar });
          }
        } catch(e) {}
        return results;
      };

      // ── Collect hazard pool (up to 8 candidates) ───────────────────────────
      let hazardPool = [];
      for (const tier of hazardTiers) {
        if (!tier.mustMentionDistrict && hazardPool.length >= 3) continue;
        if (hazardPool.length >= 8) break;
        hazardPool.push(...await fetchTier(tier, hazardKeywords));
      }
      hazardPool.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));

      // ── Collect vuln/exposure pool (up to 4 candidates) ───────────────────
      let vulnPool = [];
      const vulnAllowed = [...vulnerabilityKeywords, ...exposureKeywords];
      for (const tier of vulnExposureTiers) {
        if (!tier.mustMentionDistrict && vulnPool.length >= 1) continue;
        if (vulnPool.length >= 4) break;
        vulnPool.push(...await fetchTier(tier, vulnAllowed));
      }
      vulnPool.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));

      // ── Merge: hazard always fills slots 1-3; slots 4-5 go to whichever
      //    pool has the more recent article — but vuln/exposure capped at 2 ──
      const top3Hazard = hazardPool.slice(0, 3);
      const remaining = hazardPool.slice(3); // leftover hazard candidates for slots 4-5
      const topVuln   = vulnPool.slice(0, 2);

      // Interleave remaining hazard vs vuln/exposure by recency for slots 4-5
      const candidates45 = [...remaining, ...topVuln]
        .sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));

      // Cap vuln/exposure at 2 in final 5
      let vulnCount = 0;
      const slots45 = [];
      for (const item of candidates45) {
        if (slots45.length >= 2) break;
        if (item.pillar !== 'hazard') {
          if (vulnCount >= 2) continue;
          vulnCount++;
        }
        slots45.push(item);
      }

      const finalItems = [...top3Hazard, ...slots45];

      // ── Generate AI summaries ───────────────────────────────────────────────
      if (finalItems.length > 0) {
        try {
          const titlesJson = JSON.stringify(finalItems.map((it, i) => ({ i, title: it.title })));
          const summaryRaw = await callGroq(
            `You are a climate news summariser for India. Given news headlines, write one informative sentence (25-35 words) per headline capturing: what disaster or event occurred, exactly where, and its key impact or scale such as deaths, villages affected, or alerts issued. Be specific, never vague or generic. Return ONLY a JSON array with keys "i" (number) and "summary" (string). No markdown, no preamble.`,
            `Headlines: ${titlesJson}`,
            { maxTokens: 800, temperature: 0.3 }
          );
          const cleanedS = summaryRaw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
          const arrMatch = cleanedS.match(/\[[\s\S]*\]/);
          if (arrMatch) {
            const parsed = JSON.parse(arrMatch[0]);
            parsed.forEach(({ i, summary }) => {
              if (finalItems[i]) finalItems[i].description = summary || '';
            });
          }
        } catch(e) {
          finalItems.forEach(it => { it.description = ''; });
        }
      }

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ items: finalItems }) };
    }

        // ── Infrastructure panel ────────────────────────────────────────────── ──────────────────────────────────────────────
    if (type === 'infra') {
      const { sys, usr } = buildInfraPrompt(payload);
      const raw = await callGroq(sys, usr, { maxTokens: 700, temperature: 0.3 });
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch (e) {
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) { parsed = JSON.parse(match[0]); }
        else throw new Error('Could not parse infra JSON');
      }

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ text: JSON.stringify(parsed) }) };
    }

    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: `Unknown request type: "${type}". Expected: hero, drawer, news, infra` }),
    };

  } catch (err) {
    console.error('[ai function error]', err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
