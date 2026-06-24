// Netlify Function: /.netlify/functions/generate-visualization
// Required environment variables:
//   OPENAI_API_KEY        - OpenAI key with gpt-image-1 access
//   BETA_ACCESS_PASSWORD  - shared beta password (M1 access gate)
// Required package: npm install openai busboy

const OpenAI = require('openai');
const Busboy = require('busboy');
const { Readable } = require('stream');
const { buildCorePrompt, CHIN_JAW_SAFETY, usesChinJawSafety } = require('./prompts');
const { logGeneration } = require('./log-generation');

// Non-negotiable constraints appended to EVERY prompt server-side, so a tampered
// client cannot strip identity/ethnicity preservation or push the model to over-promise.
const SERVER_SAFETY =
  " CRITICAL: this is a medical consultation photograph, not a beauty image. Apply ONLY the single localized change described above and change nothing else. " +
  "Do NOT smooth or retouch skin, remove or soften wrinkles, even out skin tone, brighten the image, raise contrast, slim the face or jaw, " +
  "enlarge the eyes, lift the brows, change the hairstyle, or apply any beautifying, younger-looking, or filter-like effect. " +
  "Keep the apparent age and ALL age-appropriate skin texture (pores, fine lines, folds) exactly as in the original. " +
  "Preserve unchanged: identity, ethnicity and ethnic features, bone structure, hair, clothing, jewellery, expression, head angle and pose, " +
  "camera framing and crop, and lighting and background. The result must read as the SAME photograph with only the treated area subtly adjusted. " +
  "Do not add text, labels, or watermarks.";

function unauthorized(msg) {
  return {
    statusCode: 401,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: msg || 'Invalid beta access password', code: 'INVALID_KEY' })
  };
}

function checkKey(event) {
  const expected = process.env.BETA_ACCESS_PASSWORD;
  if (!expected) return false; // fail closed if the env var is not configured
  const provided = event.headers['x-beta-key'] || event.headers['X-Beta-Key'] || '';
  return provided === expected;
}

function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = {};
    const busboy = Busboy({ headers: event.headers });

    busboy.on('field', (name, value) => { fields[name] = value; });
    busboy.on('file', (name, file, info) => {
      const chunks = [];
      file.on('data', chunk => chunks.push(chunk));
      file.on('end', () => {
        files[name] = {
          buffer: Buffer.concat(chunks),
          filename: info.filename || 'image.png',
          mimeType: info.mimeType || 'image/png'
        };
      });
    });
    busboy.on('error', reject);
    busboy.on('finish', () => resolve({ fields, files }));

    const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body || '');
    Readable.from(body).pipe(busboy);
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Gate everything on the beta password first.
  if (!checkKey(event)) return unauthorized();

  const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';

  // Lightweight verify call from the lock screen: { action: 'verify' }
  if (contentType.includes('application/json')) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true })
    };
  }

  try {
    const { fields, files } = await parseMultipart(event);
    const imageFile = files.image;
    if (!imageFile) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Missing image file' }) };
    }

    // Prompt is assembled SERVER-SIDE from the clinician's selections (the
    // treatment library lives in prompts.js). Falls back to a legacy pre-built
    // prompt field if an older client posts during a deploy window.
    // M7.5: safety-tail policy kept in LOCKSTEP with the background function
    // (which is the live generation path): Sculptra uses its own safety base
    // (none appended here; this also fixes an old drift where this legacy path
    // still appended the generic tail to Sculptra), chin/jawline filler uses
    // CHIN_JAW_SAFETY, everything else keeps the generic tail. The
    // [safety:server] note hook forces the generic tail for staging A/B and is
    // stripped before the prompt is built.
    const rawNote = (fields.note != null) ? String(fields.note) : '';
    const forceServerSafety = /\[safety:server\]/i.test(rawNote);
    const cleanNote = rawNote.replace(/\[safety:(server|none)\]/ig, '').replace(/\s{2,}/g, ' ').trim();

    const product = (fields.type === 'biostim')
      ? (['sculptra', 'hdr'].includes(fields.product) ? fields.product : 'sculptra')
      : null;
    const isSculptra = product === 'sculptra';
    const isChinJaw = usesChinJawSafety(fields.type, fields.areas);

    let core;
    if (fields.type) {
      core = buildCorePrompt({
        type: fields.type,
        areas: fields.areas,
        goal: fields.goal,
        intensity: fields.intensity,
        product: fields.product,
        projection: fields.projection,
        timeline: fields.timeline,
        note: cleanNote
      });
    } else {
      core = fields.prompt || 'Create a subtle, realistic aesthetic treatment visualization.';
    }
    let tail;
    if (forceServerSafety) tail = SERVER_SAFETY;
    else if (isSculptra) tail = '';
    else if (isChinJaw) tail = CHIN_JAW_SAFETY;
    else tail = SERVER_SAFETY;
    const prompt = core + tail;

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const file = await OpenAI.toFile(imageFile.buffer, imageFile.filename, { type: imageFile.mimeType });

    const result = await client.images.edit({
      model: 'gpt-image-1',
      image: file,
      prompt,
      size: 'auto',
      input_fidelity: 'high',
      output_format: 'jpeg',
      output_compression: 85
    });

    const b64 = result.data && result.data[0] && result.data[0].b64_json;
    if (!b64) throw new Error('No image returned by model');

    await logGeneration({
      betaKeyUsed:    true,
      treatmentType:  fields.type || null,
      angle:          fields.angle || null,
      model:          'gpt-image-1',
      imageSize:      'auto',
      imageQuality:   'high',
      openAIUsage:    result.usage || null,
      status:         'success',
    }).catch(() => {});

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: `data:image/jpeg;base64,${b64}` })
    };
  } catch (err) {
    const status = err && (err.status || err.statusCode);
    const code = err && (err.code || (err.error && err.error.code));
    const msg = (err && err.message) || '';
    console.error('generate-visualization failed:', JSON.stringify({ status, code, msg }));

    const blocked = code === 'moderation_blocked' || /safety system|moderation|not allowed/i.test(msg);
    await logGeneration({
      betaKeyUsed:   true,
      model:         'gpt-image-1',
      status:        blocked ? 'blocked' : 'failed',
      failureReason: code || msg || 'unknown',
    }).catch(() => {});

    if (blocked) {
      return {
        statusCode: 422,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'The AI provider blocked this specific edit under its safety system (the image-edit endpoint is strict and this cannot be turned down). Lip edits are a frequent trigger. Try a different area, or adjust the wording of the custom note.',
          code: 'moderation_blocked'
        })
      };
    }
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: msg || 'Image generation failed', code: code || 'error' })
    };
  }
};
