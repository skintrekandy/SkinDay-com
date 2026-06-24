// netlify/functions/log-generation.js
// Logs one OpenAI image generation attempt to generation_logs.
// Called from visualize-generate.js (and any future generate functions)
// after the OpenAI response returns, whether success or failure.
//
// Usage:
//   const { logGeneration } = require('./log-generation');
//   await logGeneration({ jobId, userId, ... openAIResponse });
//
// Never throws -- cost logging must never block the generation response.

const { createClient } = require('@supabase/supabase-js');

// OpenAI image pricing constants (update here when OpenAI changes pricing).
// Source: https://openai.com/api/pricing (gpt-image-1 as of June 2026)
const PRICE_INPUT_PER_M      = parseFloat(process.env.OPENAI_PRICE_INPUT_PER_M      || '5.00');
const PRICE_CACHED_PER_M     = parseFloat(process.env.OPENAI_PRICE_CACHED_PER_M     || '1.25');
const PRICE_OUTPUT_PER_M     = parseFloat(process.env.OPENAI_PRICE_OUTPUT_PER_M     || '40.00');

function estimateCost(usage){
  if(!usage) return null;
  const inputTokens  = usage.input_tokens  || 0;
  const cachedTokens = (usage.input_tokens_details && usage.input_tokens_details.cached_tokens) || 0;
  const outputTokens = usage.output_tokens || 0;
  // Cached tokens are billed at the cached rate; non-cached input at full rate.
  const billableInput = Math.max(0, inputTokens - cachedTokens);
  return (
    (billableInput  / 1_000_000) * PRICE_INPUT_PER_M  +
    (cachedTokens   / 1_000_000) * PRICE_CACHED_PER_M +
    (outputTokens   / 1_000_000) * PRICE_OUTPUT_PER_M
  );
}

async function logGeneration({
  jobId,
  userId          = null,
  betaKeyUsed     = false,
  treatmentType   = null,   // 'filler' | 'biostim'
  angle           = null,   // 'frontal' | 'l45' | 'r45'
  isRegen         = false,
  model           = 'gpt-image-1',
  imageSize       = null,
  imageQuality    = null,
  openAIUsage     = null,   // response.usage object from OpenAI
  creditsCharged  = null,
  status          = 'success',  // 'success' | 'failed' | 'blocked' | 'refunded' | 'timeout'
  failureReason   = null,
}){
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const inputTokens  = openAIUsage ? (openAIUsage.input_tokens  || 0) : null;
    const cachedTokens = openAIUsage
      ? ((openAIUsage.input_tokens_details && openAIUsage.input_tokens_details.cached_tokens) || 0)
      : null;
    const outputTokens = openAIUsage ? (openAIUsage.output_tokens || 0) : null;
    const estimatedCost = estimateCost(openAIUsage);

    const { error } = await supabase.from('generation_logs').insert({
      job_id:               jobId      || null,
      user_id:              userId     || null,
      beta_key_used:        betaKeyUsed,
      treatment_type:       treatmentType,
      angle,
      is_regen:             isRegen,
      model,
      image_size:           imageSize,
      image_quality:        imageQuality,
      input_tokens:         inputTokens,
      cached_input_tokens:  cachedTokens,
      output_tokens:        outputTokens,
      estimated_cost_usd:   estimatedCost,
      credits_charged:      creditsCharged,
      status,
      failure_reason:       failureReason || null,
    });

    if(error){
      console.error('[logGeneration] Supabase insert error:', error.message);
    }
  } catch(err){
    // Never let logging block the main response
    console.error('[logGeneration] Unexpected error:', err.message);
  }
}

module.exports = { logGeneration, estimateCost };
