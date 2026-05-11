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
Composite risk score: ${composite}/100 — ${ovrLabel}.
Individual hazard scores: ${scoreLines}.

Your summary must:
1. Explain the dominant climate hazard and WHY this location is exposed (geography, climate zone, history).
2. Name the top 1–2 specific risks and their practical impact.
3. Give a clear overall risk verdict for this area.

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

function buildNewsPrompt({ district, state, pin, topHazards }) {
  const hazardStr = Array.isArray(topHazards) && topHazards.length
    ? topHazards.join(' and ')
    : 'general climate hazards';

  const sys = `You are a climate news researcher for India. 
Return ONLY a valid JSON array — no markdown fences, no explanation, no preamble.
Each item must have exactly: headline (string), summary (string, 1–2 sentences), 
type (one of: flood/heat/cyclone/drought/storm/fire/other), date (string like "Mar 2025"), 
source (string), url (string, real or plausible news URL or empty string).`;

  const usr = `Find 4 recent (2024–2025) news items about climate or weather events relevant to ${district}, ${state}, India.
Focus on: ${hazardStr}.
Be specific to ${district} or ${state} — not generic India-wide news.

Return ONLY a JSON array like:
[
  {
    "headline": "...",
    "summary": "...",
    "type": "flood",
    "date": "Jul 2025",
    "source": "Times of India",
    "url": "https://timesofindia.indiatimes.com/..."
  }
]`;

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

    // ── News items ────────────────────────────────────────────────────────
    if (type === 'news') {
      const { sys, usr } = buildNewsPrompt(payload);
      const raw = await callGroq(sys, usr, { maxTokens: 900, temperature: 0.4 });

      // Strip possible markdown fences
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      let items;
      try {
        items = JSON.parse(cleaned);
        if (!Array.isArray(items)) throw new Error('Not an array');
      } catch (parseErr) {
        // Try to extract JSON array from anywhere in the response
        const match = cleaned.match(/\[[\s\S]*\]/);
        if (match) {
          items = JSON.parse(match[0]);
        } else {
          throw new Error('Could not parse news JSON: ' + parseErr.message);
        }
      }

      // Sanitise items
      items = items.slice(0, 4).map(item => ({
        headline: String(item.headline || 'Climate event').slice(0, 160),
        summary:  String(item.summary  || '').slice(0, 300),
        type:     ['flood','heat','cyclone','drought','storm','fire','other'].includes(item.type) ? item.type : 'other',
        date:     String(item.date   || '2025').slice(0, 20),
        source:   String(item.source || 'News').slice(0, 80),
        url:      String(item.url    || '').startsWith('http') ? item.url : '',
      }));

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ items }) };
    }

    // ── Infrastructure panel ──────────────────────────────────────────────
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
