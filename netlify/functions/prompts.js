// SkinDay Visualize: Treatment Prompt Library
// ---------------------------------------------------------------------------
// This file is the clinical brain of the generator. It turns the clinician's
// selections (treatment, area, goal, intensity) into the CORE instruction sent
// to the image model. The universal safety/identity constraints live separately
// in generate-visualization.js. Filler uses the strict localized base
// (SERVER_SAFETY); biostim uses the support-aware base (BIOSTIM_SAFETY).
//
// Design rules (learned from real patient output):
//   1. Lead with PROHIBITIONS. The model is fixed by what we forbid, not by
//      describing the desired outcome; words like "mild definition" get read
//      through its beautify-everything prior, so each module names the specific
//      drift to block (e.g. Sculptra over-lift, superhero jawline).
//   2. Keep the ASSEMBLED prompt tight. gpt-image-1 follows only a handful of
//      lines; a wall of text washes the important ones out.
//   3. Magnitude is set by the intensity/projection module, not by adjectives
//      scattered through the area modules. (Exception: Sculptra magnitude and
//      content co-vary, so its expected text is keyed by projection directly.)
//
// To tune a treatment: edit ONLY its entry below, bump the version note, redeploy.
// ---------------------------------------------------------------------------

const BASE_FRAMING =
  'Simulate a realistic aesthetic-medicine outcome for this consultation photo, ' +
  'consistent with a natural-looking, tasteful result from an experienced injector, ' +
  'at the magnitude specified below.';

// Oblique (three-quarter) Sculptra uses a separate, restrictive framing: at this
// angle gpt-image-1 rebuilds too much of the face, so the brief leads with
// preservation and asks for the smallest possible local contour edit (v10).
const OBLIQUE_BASE_FRAMING =
  'Produce a subtle, medically conservative Sculptra collagen-stimulation ' +
  'visualization from this three-quarter (oblique) consultation photograph, ' +
  'staying as close to the original photograph as possible.';

// Frontal Sculptra v9.1: a short, high-priority feature lock injected BEFORE the
// structural language. Image models weight the first lines most, and the long v9
// avoid block placed the lip/eye prohibitions too late to hold against the strong
// lift/narrow instructions, so the mouth, eyes, and brows were being beautified
// as the model "improved" the lower face. This clamps them up front.
const SCULPTRA_FRONTAL_HARD_LOCK =
  'Critical feature lock, applies before everything below: the lips and mouth, eyes, ' +
  'eyebrows, and nose are completely outside the treatment area. Do not change lip ' +
  'size, shape, volume, color, border, cupid\'s bow, or symmetry, and do not make the ' +
  'mouth fuller, smoother, glossier, more defined, more symmetrical, or more attractive. ' +
  'Do not enlarge or open the eyes, raise the eyelids, or darken or reshape the brows. ' +
  'These features stay pixel-close to the original except for shadow that shifts as a ' +
  'natural consequence of lateral soft-tissue support. The ONLY change is lateral support.';

// ---- Filler: per-area modules (v1) ----------------------------------------
// expected: the real change this area produces.  avoid: the drift to block.
// M14.1: lips and nose are delicate areas whose default `expected` text is
// deliberately conservative ("at most a small amount", "one small dorsal bump").
// That cap suppressed the moderate/enhanced tiers into near-invisibility on the
// main filler path. These per-intensity overrides let the tier actually scale the
// magnitude; the per-area `avoid` lists (unchanged) keep the result tasteful.
const FILLER_AREA_INTENSITY = {
  lips: {
    // Conservative: subtle but real, about 0.5 cc or less.
    conservative: 'a gentle, natural-looking increase in lip body: a touch more volume in both lips, a slightly more defined vermilion border, and a hint more shape -- subtle but real, consistent with a conservative 0.5 cc correction. Keep the natural upper-to-lower balance, cupid\'s bow, and mouth width.',
    // Moderate: clearly visible, about 0.5-1 cc, noticeable in comparison.
    moderate: 'a visibly fuller lip consistent with approximately 0.5 to 1 cc of HA filler: clearly more body in both the upper and lower lip, a more defined vermilion border, and a natural balanced enhancement that is noticeable in side-by-side comparison. Keep the natural upper-to-lower balance, the cupid\'s bow position, and the mouth width.',
    // Enhanced: clearly noticeable, 1-2 cc, definite with anatomy specifics.
    enhanced: 'a clearly and noticeably fuller lip consistent with approximately 1 to 2 cc of HA filler: substantially more body in both the upper and lower lip, clear vermilion show, a well-defined Cupid\'s bow, mild eversion of the lip body, and modest anterior projection. The result should be obviously fuller in side-by-side comparison -- a natural but definite correction. Keep the natural upper-to-lower balance and the mouth width. If uncertain, prefer a slightly more visible result rather than an overly subtle one.'
  },
  nose: {
    // Conservative: minimal refinement, barely-there change.
    conservative: 'very subtle non-surgical nasal refinement: gently soften a small dorsal bump or add a hint of radix or tip support so the profile reads barely smoother -- minimal but perceptible in comparison, consistent with a conservative liquid rhinoplasty.',
    // Moderate: clearly visible profile improvement.
    moderate: 'a visible non-surgical nasal refinement (liquid rhinoplasty): smooth the dorsal bump so the side profile reads clearly straighter, add modest bridge definition and gentle radix or tip support where this nose needs it -- a visible improvement that looks like a skilled non-surgical correction.',
    // Enhanced: clearly noticeable structural refinement with anatomy.
    enhanced: 'a clearly visible non-surgical nasal refinement: noticeably smooth the dorsal line so it reads distinctly straighter and more refined, with clear bridge definition, modest radix support, and subtle tip refinement where appropriate. The change should be obviously noticeable in side-by-side comparison -- clearly improved but still believable for HA filler, never surgical. If uncertain, prefer a slightly more visible result rather than an overly subtle one.'
  }
};
function fillerAreaExpected(a, intensity){
  const tier = FILLER_AREA_INTENSITY[a];
  if (tier && tier[intensity]) return tier[intensity];
  return FILLER_AREAS[a] ? FILLER_AREAS[a].expected : '';
}

const FILLER_AREAS = {
  chin: {
    expected: 'more chin projection and a better-balanced lower-face profile, treating the chin alone: bring the chin point gently forward and, where appropriate, slightly lower so the lower third reads stronger and better balanced with the upper face, keeping the chin width natural. The change comes only from added chin volume and structural support at the chin itself',
    avoid: 'do not over-lengthen into a long, narrow, pointed, jutting, or witch-like chin, and keep the chin width natural; this is chin filler only, so do not add lateral jawline definition, do not sharpen, square, or carve the mandibular border, and do not change the gonial angle or jaw width; do not slim or carve the cheeks; do not add a double chin and do not alter the neck below the new chin point; do not alter the lips or mouth'
  },
  jawline: {
    expected: 'cleaner definition along the lower mandibular border with slight prejowl support, treating the jawline alone: a smoother, more continuous border from the chin body back toward the gonial angle, with the prejowl hollow softened where present so the jaw line reads more defined. The change comes only from added structural support along the mandibular border',
    avoid: 'do not create a sharp, angular, or "superhero" jawline, do not slim the cheeks, do not change the neck; this is jawline filler only, so do not add chin projection, do not lengthen, lower, or strengthen the chin point, and do not change the pogonion position or the chin-to-lip distance; do not widen or square the chin'
  },
  nose: {
    expected: 'smooth one small dorsal bump on the nasal bridge and slightly straighten the side profile (liquid rhinoplasty)',
    avoid: 'do not narrow the nostrils, do not shorten or rotate the tip, do not reduce overall nose size'
  },
  lips: {
    expected: 'a natural-looking increase in lip body and a slightly more defined vermilion border, with at most a small, even amount of projection, keeping the existing lip shape, the natural upper-to-lower balance, and the position of the lip border and cupid\'s bow',
    avoid: 'do not add gloss, shine, a wet look, or any lip product; do not change the lip color, redness, or pigment, and do not add lipstick; do not over-fill, evert, shelf, or roll the lips out, and do not create a "duck" or sausage shape; do not move or reshape the vermilion border or cupid\'s bow; do not invert the natural upper-to-lower proportion; do not whiten the teeth; the lip change must stay strictly within the lip body and must not add chin projection, lengthen or strengthen the chin, change the chin point or pogonion, alter the mentolabial fold, or change the lower-lip-to-chin distance; the chin and lower face stay pixel-close to the original except where chin or jawline filler is separately and explicitly selected'
  },
  cheeks: {
    expected: 'restore a little midface and cheekbone volume so the cheek apex and the curve from the lower lid down to the cheek (the ogee curve) look gently fuller and better supported, with a natural, restorative apex rather than an exaggerated or sculpted cheekbone',
    avoid: 'this is volume and contour, not a skin or youth filter: do not smooth, brighten, even out tone, or reduce pigmentation anywhere on the cheek or midface, and do not reduce apparent age; do not over-fill into round "pillow" or "chipmunk" cheeks, and do not set the apex too high or too lateral (no wind-tunnel look); do not lift, pull, or tighten the face, and do not slim the lower face or jaw to exaggerate the cheeks; do not fully erase the nasolabial fold or tear trough, and do not change the eyes, brows, or smile'
  },
  tear_trough: {
    expected: 'slightly soften the under-eye hollow so the area looks a little less shadowed',
    avoid: 'do not erase the hollow completely, do not puff or overfill under the eye, do not brighten, smooth, or retouch away dark circles'
  },
  nasolabial_folds: {
    expected: 'soften the nasolabial fold a little so it looks shallower and less shadowed, while keeping a natural crease',
    avoid: 'do not erase or completely fill the fold, do not build an overfilled ridge or sausage along the fold, do not flatten the midface or change the cheek, do not alter the lips or mouth, do not smooth, brighten, or retouch the surrounding skin'
  }
};

// ---- Filler: combined lower-face module (v3) ------------------------------
// Chin + jawline are injected together in practice, so when both are selected
// we describe ONE integrated lower-third outcome instead of concatenating two
// independent area clauses (which made the model over-treat each area). v3: the
// PRIMARY frontal change is vertical chin elongation (lengthening the lower
// third), which is what chin filler reads as from the front; earlier wording
// forbade lengthening and so produced almost no visible frontal change.
// M11.1: split into male and female variants. The previous single prompt buried
// sex guidance in a subordinate clause; the model defaulted to female geometry
// (shorter, tapered, rounded chin) on male faces. Male chin filler has a
// fundamentally different aesthetic target: square mentum, preserved jaw width,
// taller and more projected chin, crisper border -- not a tapered V-line.
const FILLER_CHIN_JAWLINE_FEMALE = {
  expected: 'a clearly restructured, better-balanced and more defined lower third, treating the chin and jawline as one unit. ' +
            'The main change, clearly visible from the front, is a confident vertical lengthening and forward projection of the chin: ' +
            'bring the chin point clearly lower and forward so the lower third looks longer, stronger, and better balanced and the face reads distinctly more oval and defined, ' +
            'with clean definition along the mandibular border and clear prejowl support so the chin-to-jaw line is smooth and continuous. ' +
            'Where jowls or a prejowl hollow are present, fill the prejowl hollow and visibly soften the jowl shadow so it blends into a smooth, continuous jawline; the jowl itself is never enlarged. ' +
            'As the chin lengthens and projects, the soft tissue of the lower face follows it so the lateral lower-face contour tapers inward and the lower third reads more refined, elegant, and sculpted. ' +
            'Let the inward taper and softening read clearly: a softer, more tapered, more elegant lower face with a refined oval silhouette. ' +
            'The mid-cheek width and cheekbones are unchanged; only the lower face follows the chin. ' +
            'The change comes only from added chin volume and structural support',
  avoid: 'do not over-lengthen into a long, narrow, pointed, jutting, or witch-like chin, and keep the chin width natural; ' +
         'do not create a hard, angular, or square jawline; ' +
         'do not slim, hollow, or carve the cheeks or cheekbones to fake jaw definition; ' +
         'a clear but natural inward taper and refinement of the lower face as the chin lengthens is expected and good, but do not over-narrow or carve the lower face into a hard, sharply pointed V-line, and do not widen the lower face; ' +
         'do not add a double chin and do not alter the neck below the new chin point; ' +
         'keep it unmistakably the same person'
};

// M10.5 Track 2: hard negative gate front-loaded as the absolute first sentence,
// before any positive description. Mirrors the SCULPTRA_NLF_CONSTRAINT strategy:
// the model weights the first lines most, and the previous all-positive male prompt
// was losing to the model's aesthetic bias toward tapered, refined lower faces
// (the female ideal). The negative gate acts as a hard prohibition BEFORE the
// positive description can be read through that prior. Also added: a pixel-geometry
// reference anchor specifying that chin width in the output must not be less than
// chin width in the original photograph -- an empirical anchor, not a style word.
const FILLER_CHIN_JAWLINE_MALE = {
  expected: 'HARD CONSTRAINT -- MALE CHIN SHAPE: The result MUST NOT taper to a point, narrow into a V-shape, or read as feminine, soft, delicate, or androgynous in any way. If the simulated chin reads as a female chin at any angle, the result is wrong regardless of everything else. The chin tip in the simulated image must be at least as wide as the chin tip in the original photograph -- do not reduce chin width, do not reduce jaw width. ' +
            'With that constraint established: a clearly restructured, stronger, and better-balanced lower third on a male face, treating the chin and jawline as one unit. ' +
            'The main change, clearly visible from the front, is a confident forward projection and vertical strengthening of the chin: ' +
            'bring the chin point forward and slightly lower so the lower third reads stronger, more defined, and better balanced with the upper face. ' +
            'The chin should be wider and squarer at the mentum -- a male chin is broad and squared, never tapered or pointed -- with crisp, clean definition along the mandibular border and a strong, continuous chin-to-jaw arc. ' +
            'Preserve the full jaw width and gonial angle: do not narrow or taper the lower face -- the male aesthetic goal is structural definition, not an oval or V-line silhouette. ' +
            'The border from chin to gonion should read as a single, clean, confident line with clear prejowl support. ' +
            'At oblique angle: the chin projection reads as a squared, blunt chin tip advancing anteriorly, not a rounded or tapered tip; the near-side mandibular border is crisp and reads as a structural jawline; the chin tip should remain wide and squared even in three-quarter view. ' +
            'Where jowls or a prejowl hollow are present, fill the prejowl hollow so the chin-to-jaw line is smooth and continuous; the jowl itself is never enlarged. ' +
            'The change comes only from added chin volume and structural support; the cheeks, cheekbones, and mid-face are unchanged',
  avoid: 'do not produce a female or androgynous chin shape -- no tapered, pointed, rounded, soft, or V-shaped chin at any angle; ' +
         'do not narrow or slim the jaw; do not produce a long, jutting, or protruding chin; ' +
         'do not round the chin tip at oblique angle -- it must remain squared and blunt; ' +
         'do not slim, hollow, or carve the cheeks or cheekbones; ' +
         'do not create an artificial or "superhero" jawline; ' +
         'do not add a double chin and do not alter the neck below the new chin point; ' +
         'preserve the patient\'s ethnicity, facial hair, and overall identity; keep it unmistakably the same person'
};

// Legacy alias used by the overfill path (female default)
const FILLER_CHIN_JAWLINE = FILLER_CHIN_JAWLINE_FEMALE;

// ---- Filler: overfilled education anchor (M10.4) --------------------------
// Deliberately overcorrected lower-face result, fired lazily when the slider
// first enters the Overfilled zone (>= 80). The goal is to show the patient
// why more is not better: excess chin projection, a shelf-like jawline, an
// overdone look that no experienced injector would produce. The compositor
// path for this anchor is AI-heavy (outline gate loosened so the model may
// extend the silhouette; chroma lock and texture restore are retained so
// identity and skin character survive, but the border is not guarded).
// Deterministic warp is NOT applied; the AI carries the overcorrection.
const FILLER_CHIN_JAWLINE_OVERFILLED = {
  core: 'Simulate an overfilled hyaluronic acid result in the chin and jawline for patient education. ' +
        'This is INTENTIONALLY overcorrected to show why excessive filler is problematic. ' +
        'Show: a chin that projects too far forward and hangs lower than natural anatomy allows, reading as augmented and disproportionate; ' +
        'a jawline that reads as a hard, artificial shelf rather than a natural mandibular border, with the border too sharply defined and too linearly continuous from chin to gonion; ' +
        'prejowl overfill that smooths the jowl transition too aggressively so the lower face reads as swollen and unnatural; ' +
        'an overall lower third that reads as too long, too projected, too defined, and visibly filled rather than natural. ' +
        'The overcorrection should be obvious to a patient in a consultation setting and clearly read as "too much," but must remain anatomically coherent (no cartoon distortion, no grotesque result): ' +
        'the kind of overfilled outcome an inexperienced or aggressive injector might produce, not a caricature.',
  avoid: 'do not produce a natural or tasteful result; the point is that this looks overfilled and excessive. ' +
         'Do not change the eyes, brows, nose, skin texture, skin tone, hairstyle, expression, lighting, or background. ' +
         'Preserve identity, ethnicity, and apparent age; the result must be unmistakably the same person, just with too much filler in the lower face. ' +
         'Do not add text, labels, watermarks, or cartoon distortion. ' +
         'The overcorrection is confined to the chin, jawline, and lower-face contour: cheeks, midface, and upper face are unchanged.'
};

// ---- Filler: goal modifiers (v1) ------------------------------------------
const GOALS = {
  natural_refinement: 'Keep the overall effect minimal and natural.',
  facial_balancing:   'Aim only for slightly improved proportion between the treated areas.',
  masculinization:    'Bias the treated areas toward a slightly more angular, defined contour.',
  feminization:       'Bias the treated areas toward a slightly softer contour.',
  rejuvenation:       'Aim only for the structural support the selected filler areas add; do not change skin texture, tone, under-eye shadows, or apparent age.'
};

// ---- Filler: intensity = magnitude anchor (v1) ----------------------------
const INTENSITY = {
  natural:  'Magnitude: barely perceptible, the most conservative result a cautious injector would show. When in doubt, do less.',
  moderate: 'Magnitude: clearly visible but still conservative -- the typical outcome most patients see, equivalent to an expected single-session result.',
  enhanced: 'Magnitude: the upper end of a realistic single-session result -- clearly noticeable in side-by-side comparison, clinically plausible and natural-looking. If uncertain about magnitude, prefer a more visible result over an overly subtle one.'
};

// ---- Biostimulation: per-product modules ----------------------------------
// SHAPE (filler) vs SUPPORT (biostim). Sculptra restores diffuse soft-tissue
// SUPPORT and works by improving facial transition zones, not by reshaping
// features. Its `expected` is keyed by projection so magnitude and content
// co-vary (the generic PROJECTION clause is skipped for Sculptra; see build).
// v9: a round/full FRONT is read as deflation and descent (lost lateral support,
//      tissue slid down and pooled centrally), so it triggers MORE lateral lift that
//      draws the fullness up and out and narrows the front, never central fill. The
//      deficit floor applies to lean, well-supported faces. v9.2: the descent
//      reading is qualified by SIGNS OF DESCENT (older face, jowl, lateral/temporal
//      hollowing); a young or well-supported full face is youthful fullness, not
//      descent, so it falls to the floor and stays near baseline rather than being
//      narrowed or lifted.
const BIOSTIM = {
  sculptra: {
    expected: {
      conservative: 'the just-noticeable floor of a Sculptra response: a very subtle collagen-driven firming along the LATERAL face only, a hint more support in the lateral temple and lateral cheek fat pads giving a barely-there upward and outward lift along the line of ligaments that just begins to lift the jowl and tidy the jawline, so faint that without the before photo a viewer might not be sure anything changed. If the face looks round or full from the front WITH signs of descent (flattened temples and lateral cheeks, a jowl, an older face), that roundness is descended tissue and even this subtle lift should begin to draw it up and outward and very slightly narrow the front, never add to it; but a young, well-supported full face is youthful fullness, not descent, and stays at baseline. The central midface, anterior cheek, and under-eye are left unchanged, and facial proportions, apparent age, and skin are unchanged',
      expected: 'a clearly visible but still moderate Sculptra response driven by LATERAL support: subtle collagen-driven volumization of the lateral temple and lateral cheek fat pads that lifts the face upward and outward along the line of ligaments (orbital retaining, zygomatic-cutaneous, mandibular). A face that looks round, full, or heavy from the front WITH SIGNS OF DESCENT (an older face, flattened or hollow temples and lateral cheeks, a jowl, mid-lower-face volume slid downward and centrally) is showing deflation and descent, so the correct response is MORE lateral support that draws that central fullness up and outward: the front becomes narrower, more lifted, and more defined, and the roundness visibly decreases. A young, well-supported full face with no jowl and no lateral hollowing is youthful or constitutional fullness, NOT descent: Sculptra would barely change it, so keep it near baseline and do not narrow or lift it (see the volume-deficit floor). The lower face reads more lifted and supported, the lateral lift travels down the mandibular ligament so the jowl is lifted up and back and visibly but subtly reduced, leaving a cleaner, smoother jawline (not a sharpened or carved one), and the nasolabial and marionette folds soften secondarily from that lateral support, not from being filled. The central midface, anterior cheek, and under-eye stay essentially unchanged. Unmistakably the same person at the same age, never looking filled, puffy, or rounded in front',
      optimistic: 'the strong end of a realistic Sculptra response (the upper 20 to 25% of responders), still a LATERAL lift: more collagen-driven support in the lateral temple and lateral cheek fat pads producing an obvious upward and outward lift along the line of ligaments, with the jowl clearly lifted and reduced and a cleaner, smoother jawline (never sharpened or carved) and a more lifted lower face. A round or full front WITH signs of descent (jowl, lateral and temporal hollowing, an older face) is descended tissue, so at this strength the central and lower-face fullness is drawn clearly up and outward and the front reads distinctly narrower and more lifted, never fuller; a young, well-supported full face is youthful fullness and stays near baseline. The extra strength appears as more lateral lift and support, never as central midface or under-eye volume, never as a fuller, rounder, or puffier front of the face, and never as smoothed skin or a younger look. Identity, bone structure, and natural aging are preserved'
    },
    avoid: 'this is collagen-driven SUPPORT, not filler SHAPE and not a beauty filter, so keep every feature outside soft-tissue volume identical to the original. These prohibitions are absolute and apply equally at every timeframe and every projection: a longer timeframe or stronger projection increases ONLY soft-tissue support and never relaxes any rule below. ' +
           'Eyebrows (strictest rule, most often violated): keep the brows exactly as in the original. Do not darken, thicken, fill, define, reshape, raise, sharpen, or groom them. Brow shape, density, color, and position must be identical. ' +
           'Pigment and tone: do not even out, lighten, or brighten skin, and do not fade or remove melasma, sun spots, redness, or freckles; match the original skin tone. ' +
           'Texture: do not smooth skin, do not reduce pore visibility, do not reduce fine surface texture, do not apply any cosmetic-retouching or beauty-filter effect; skin texture must remain substantially unchanged. ' +
           'Eyes: do not enlarge the eyes, do not alter eye scale or shape, do not increase iris or scleral visibility, do not raise or alter eyelid position, and do not make the eyes look larger, wider, brighter, or more youthful. ' +
           'Under-eye: do not retouch or erase under-eye hollows, bags, or dark circles; only the upper cheek may show subtle volume-driven support. ' +
           'Lips: do not change lip color, fullness, shape, definition, liner, or gloss. ' +
           'Grooming: do not add or enhance makeup, lashes, or hair grooming. ' +
           'Age: do not reduce apparent age; forehead lines, crow\'s feet, perioral lines, and the neck stay unchanged unless diffuse support naturally softens a fold. ' +
           'Symmetry: do not correct facial symmetry beyond the volume effect. ' +
           'Placement and shape: the support is LATERAL (lateral temple and lateral cheek fat pads) and produces an upward, outward lift, not central fill. Do not add volume to the central midface, anterior cheek, under-eye, or tear trough. Round or full front: a face that reads round, full, or heavy from the front WITH signs of descent (an older face, flattened temples and lateral cheeks, a jowl, volume slid downward and centrally) is showing deflation and descent, not excess volume, so it is a strong candidate for more lateral lift, not a reason to hold back; a young or well-supported full face with no jowl and no lateral hollowing is youthful or constitutional fullness, not descent, and must stay near baseline (do not narrow, lift, or slim it); restore lateral support so the descended central and lower-face fullness is drawn up and outward and the front becomes narrower, more lifted, and more defined. That central and lower-face fullness must DECREASE only as a consequence of the lateral lift, never from actively deflating, hollowing, slimming, carving, or skin-tightening the front. Never read a full face as needing central volume: adding central volume is the exact opposite of this treatment. Do not add filler-like or localized volume; the jowl should subtly REDUCE and the jawline read cleaner and smoother as a result of the lateral lift, but do not carve a sharp, angular, V-shaped, or superhero jawline, and never leave the jowl unchanged or make it heavier or more pronounced. Do not enlarge or round the cheeks or change facial shape, do not lift, pull, or tighten like a facelift. Never make the front of the face look fuller, rounder, swollen, or puffy: support should read as firmer and lifted, and if the choice is between too much and too little, choose less. Soften folds only partially and never fully erase nasolabial folds, marionette lines, or under-eye hollows. ' +
           'Projection scaling: the ONLY thing that changes between Early, 3 months, and 6 months is the amount of diffuse subcutaneous soft-tissue support in the temples, midface, and prejowl; more support means more restored volume and softer folds, nothing else. Do not increase brightness, smoothness, symmetry, eye openness, brow definition, lip color, grooming, or apparent youth at any level. At 6 months the extra strength shows as more support only, and must NOT bring back any skin smoothing, brightening, pigment or melasma fading, brow change, eye change, lip change, or de-aging that the lower settings correctly avoided. ' +
           'Volume-deficit floor (applies at every timeframe, including 12 months): the floor is for genuinely LEAN, well-supported faces only. If the face already shows good lateral support with minimal temple, lateral cheek, and lower-face volume loss, the result should stay very close to the original; do not invent improvements just to produce a visible change, and a longer timeframe is never a reason to add more volume than the face needs. When little deficit exists, the correct output may be nearly indistinguishable from the original, and this includes a young or well-supported full face whose fullness is youthful or constitutional rather than descended: it stays near baseline and is not narrowed or lifted. Only a full face that ALSO shows descent (jowl, lateral and temporal hollowing, an older face, volume slid downward) is the opposite case: that fullness is descent, not good support, so it is not held at baseline and instead receives more lateral lift to draw the fullness up and outward and narrow the front. ' +
           'Any firmer look or better light reflection must come from the restored support underneath, never from retouching the skin',
    // ---- Oblique (three-quarter) skin-locked, contour-only variant (v10) -----
    // The frontal expected/avoid above stay FROZEN at v9. This branch is used only
    // when the view is oblique, where the model over-reconstructs and reapplies a
    // beauty-portrait prior, so it leads with preservation and an anti-rebuild
    // instruction and permits NO skin change at any projection.
    oblique: {
      conservative: 'the just-noticeable floor of a Sculptra response at three-quarter view: a barely-there gain in lateral cheek and temple support and a slightly more continuous cheek-to-temple transition, so faint it could be missed without the before photo. Soft-tissue contour only',
      expected: 'a modest but real Sculptra response at three-quarter view, about 10 to 20 percent of contour improvement: gentle lateral cheek support, a slightly more continuous temple-to-cheek and lid-to-cheek transition (a smoother ogee curve), mild softening of midface hollowing, and a slight reduction of nasolabial and prejowl shadow. Soft-tissue contour only. The same person after gradual collagen support, not a makeover',
      optimistic: 'the strong end of a realistic Sculptra response at three-quarter view, about 20 to 35 percent of contour improvement: clearer lateral cheek and temple support, a more continuous temple-cheek-lid transition, more obvious but still natural midface support, and softer nasolabial and prejowl shadow. The extra strength is more contour support only; even here there is no skin change and no de-aging'
    },
    obliqueAvoid: 'This is a three-quarter (oblique) medical consultation photograph. At this angle the model tends to rebuild the whole face and apply a beauty-portrait look: do NOT do that. Treat the task as a minimal local contour adjustment laid over the ORIGINAL photograph, redrawing as little as possible; do not regenerate, repaint, or re-render the face or the skin. ' +
           'Skin lock, absolute at every projection and timeframe: keep pigment, melasma, sun and age spots, freckles, redness, pores, fine lines, surface texture, skin tone, brightness, and apparent age exactly as photographed. Do not smooth, brighten, whiten, even out, retouch, or de-age the skin in any way, and never apply a laser-resurfacing or beauty-filter look. A longer timeframe or stronger projection adds soft-tissue contour support ONLY, never any skin change. ' +
           'Photographic conditions: keep the original exposure, brightness, contrast, white balance, color temperature, lighting direction and softness, and the skin\'s natural sheen and reflectance unchanged; do not brighten, warm, soften, or otherwise flatter the lighting. A result can read as falsely improved from light and exposure alone even when pigment and texture survive. ' +
           'Identity and features: do not enlarge or open the eyes, raise the eyelids, darken or reshape the brows, change the lips, refine or narrow the nose, slim the face into a V-line, or alter hair, clothing, jewellery, or expression. ' +
           'Pose and framing: preserve the exact head angle, three-quarter orientation, camera angle, and crop; do not rotate the face toward frontal and do not re-pose. ' +
           'Shape: the only change is gentle lateral soft-tissue support (lateral cheek, temple-to-cheek continuity, midface hollowing, nasolabial and prejowl shadow), with no central or filler-like fill, no facelift pull, no jaw carving, and no surgery or makeup effect. If the choice is between too much and too little, choose too little: an honest, conservative, even underwhelming result is correct, and a prettier but fake-looking one is a failure'
  },
  hdr: {
    expected: 'a slight, diffuse firming and improved support of the treated area (hyperdilute Radiesse)',
    avoid: 'do not lift the face, do not remove wrinkles, do not smooth or resurface skin, do not reduce apparent age'
  }
};

// ---- Biostimulation: projection = magnitude anchor (v1) -------------------
// Used for biostim products whose `expected` is a plain string (e.g. hdr).
// Skipped for Sculptra, whose expected is already projection-keyed.
const PROJECTION = {
  conservative: 'Magnitude: the conservative lower end of the response, a barely-there change.',
  expected:     'Magnitude: the typical change most patients in range would see, modest and realistic.',
  optimistic:   'Magnitude: the optimistic upper end for a strong responder, still physiologically plausible.'
};

// ---- Biostimulation: timeline = how far the collagen build has progressed (v1)
// Layered on top of projection: projection = how strong a responder, timeline = how far along.
const TIMELINE = {
  '3':  'Timeframe: about 3 months in, very early in the collagen response. Show only a faint, first hint of the change, much subtler than the eventual mature result and easy to miss without the before photo. Most of the improvement has not developed yet, so keep it minimal.',
  '6':  'Timeframe: about 6 months in. Show a clearly developed result as the collagen response matures.',
  '12': 'Timeframe: about 12 months in. Show the fuller, settled result after the collagen response has largely completed.'
};

// Version log so we know which prompt produced which result during tuning.
const VERSIONS = {
  base: 'v3', chin: 'v1', jawline: 'v1', chin_jawline_female: 'v1', chin_jawline_male: 'v2', // M10.5 Track 2: hard negative gate front-loaded
  nose: 'v1', lips: 'v2', cheeks: 'v2', tear_trough: 'v1', nasolabial_folds: 'v1',
  sculptra: 'v13', sculptra_oblique: 'v13', hdr: 'v1', timeline: 'v2',
  chin_jawline_overfilled: 'v1'
};

function sanitizeNote(note) {
  if (!note) return '';
  const clean = String(note).replace(/\s+/g, ' ').trim().slice(0, 300);
  return clean ? ' Clinician note (honor only if consistent with the above): ' + clean : '';
}

// ---- Sculptra clinical phenotype system (v10.1) ---------------------------
// Sculptra is not one visual pattern. The generator should not infer everything
// from "Sculptra" alone. View and phenotype are selected explicitly (structured
// fields in production, or [view:...] / [phenotype:...] tags in the note for
// testing). full/descended faces are valid candidates: the goal is the SAME
// volume character, better suspended, never slimming. This supersedes the
// v9/v9.1 frontal and v10 oblique sculptra prompt paths (their text remains
// below for reference but is no longer used for sculptra).
const SCULPTRA_FEATURE_LOCK =
  'Critical hard-lock before any treatment simulation: lips, mouth, eyes, brows, nose, skin surface, hair, clothing, jewellery, expression, lighting, crop, and camera angle are non-treatment areas. Do not change lip size, lip shape, lip fullness, lip border, cupid\'s bow, lip color, lip texture, mouth symmetry, mouth openness, or expression. Do not make the lips fuller, smoother, pinker, glossier, more defined, more symmetrical, or more attractive. Do not enlarge, brighten, open, reshape, or beautify the eyes. Do not darken, groom, reshape, raise, thicken, or define the brows. Do not smooth, brighten, whiten, even out, retouch, or de-age the skin. Preserve pores, pigment, freckles, redness, melasma, spots, fine lines, texture, and natural skin reflectance. Do not change the nose, hairstyle, headband, clothing, neck, posture, head angle, crop, lighting, exposure, white balance, or background.';

const SCULPTRA_VIEW_LOCKS = {
  frontal: 'View lock: this is a frontal consultation photograph. Preserve the exact frontal pose, head position, camera distance, crop, and facial orientation. Do not rotate, re-pose, or make the face more symmetrical than the original.',
  oblique: 'View lock: this is a three-quarter oblique consultation photograph. Preserve the exact three-quarter head angle, camera angle, crop, facial orientation, visible ear position, neck angle, and perspective. Do not rotate the face toward frontal, do not re-pose, and do not rebuild the face.',
  oblique_left: 'View lock: this is a left three-quarter oblique consultation photograph. Preserve the exact left oblique angle, camera angle, crop, visible ear position, neck angle, and perspective. Do not rotate the face toward frontal, do not re-pose, and do not rebuild the face.',
  oblique_right: 'View lock: this is a right three-quarter oblique consultation photograph. Preserve the exact right oblique angle, camera angle, crop, visible ear position, neck angle, and perspective. Do not rotate the face toward frontal, do not re-pose, and do not rebuild the face.'
};

const SCULPTRA_ALLOWED_ZONES =
  'Allowed Sculptra change zones: the lateral temple and temporal hollow, the lateral cheek and zygomatic body, the temple-to-cheek transition, the lid-cheek junction and upper medial cheek as volume-driven support from below so the under-eye to cheek transition looks better supported, the lower lateral cheek and prejowl, and the nasolabial, marionette, and jowl shadows as they soften from restored lateral support. Project the lateral cheek and zygomatic body FORWARD as a fuller, lighter convexity: the lateral cheek and the area just in front of the ear must look filled, lifted, and supported, never darkened, hollowed, recessed, or shadowed to imitate a cheekbone. The jowl should clearly lighten and the lower mandibular border (jawline) read cleaner, firmer, and more defined as the jowl is lifted and the prejowl is supported. Do NOT carve, sharpen into a hard angular, V-line, or superhero jaw, do not directly fill the jaw angle, do not inflate the central anterior cheek into a pillow, do not paint over or fill under-eye bags or dark circles, and do not deposit filler-like volume into the tear trough: the under-eye improves only because the midface beneath it is better supported. Do not touch the lips, chin, nose, or the eye itself.';

const SCULPTRA_PHENOTYPES = {
  hollow_deflated: {
    label: 'hollow/deflated',
    clinicalLogic: 'Clinical pattern: this face shows visible volume loss or hollowing, especially around the temple, lateral cheek, midface, or lower-face transition zones. The correct Sculptra visualization is a confident, diffuse collagen-driven rebuild of the lateral scaffold that restores the depleted transition zones, without making the face round, puffy, overfilled, or younger-looking.',
    conservative: 'Magnitude: gentle but real. Add clear lateral temple and lateral cheek support that begins to fill the hollows and improve the transition zones, staying close to the original.',
    expected: 'Magnitude: a modest, partial structural restoration at the level of a typical responder, not a full rebuild. Gently support the lateral scaffold: some lateral temple and temporal-hollow support that begins to restore temple convexity, moderate lateral cheek and zygomatic support, a somewhat more continuous temple-to-cheek-to-lid transition (a partially restored ogee curve) so the lid-cheek junction and under-eye look a little better supported from below, and mild lower-face and prejowl suspension that lightens the jowl and leaves a slightly cleaner jawline. Nasolabial and marionette shadows soften modestly from the support. Clearly visible on comparison but understated, with room left for a stronger response. This should read as soft-tissue support returning, not as smoothed skin.',
    optimistic: 'Magnitude: a strong, fully realized Sculptra scaffold restoration at the upper end of real responders: pronounced temple convexity filling the temporal hollow, strong lateral cheek and zygomatic projection, a clearly continuous and well-supported lid-cheek-to-cheek transition, obvious lower-face and prejowl suspension with the jowl markedly lifted and lightened and a clean, defined jawline, and clearly softened folds, all from restored soft-tissue volume and never from smoothing, brightening, or de-aging the skin.'
  },
  full_descended: {
    label: 'full/descended',
    clinicalLogic: 'Clinical pattern: this face retains natural fullness, but the fullness appears insufficiently supported, with visual weight sitting lower or more centrally than ideal. This is a strong Sculptra candidate. The correct Sculptra visualization is NOT slimming, deflating, carving, V-line shaping, or making the face smaller. Preserve the patient\'s natural facial width, fullness, softness, and identity. The goal is the same facial volume character, confidently re-suspended by lateral support. Fullness should look clearly better held, not removed.',
    conservative: 'Magnitude: gentle but real. Preserve natural fullness and face width. Add clear lateral support so the lower and central fullness looks better suspended upward and laterally, without slimming or changing the mouth.',
    expected: 'Magnitude: a modest, partial re-suspension at the level of a typical responder, not a full rebuild. Preserve natural fullness and face width. Add moderate lateral cheek and temple support so facial weight is somewhat better carried upward and laterally instead of pooling low, partially restore temple convexity and a more continuous lid-cheek-to-cheek transition, and mildly lift and lighten the jowl with prejowl support so the lower face looks a little better suspended and the jawline reads slightly cleaner. Clearly visible on comparison but understated, with room left for a stronger response. Do not make the face thinner; make the same face look modestly better supported.',
    optimistic: 'Magnitude: a strong, fully realized re-suspension. Preserve natural fullness and face width. Add pronounced lateral support so the face looks clearly more suspended and far less downwardly pooled, with strong temple convexity, strong lateral cheek projection, a well-supported lid-cheek transition, and the jowl markedly lifted and lightened over a clean, defined jawline. Do not slim, hollow, carve, sharpen into a hard jaw, V-line, or beautify the face.'
  },
  mixed: {
    label: 'mixed hollowing/descent',
    clinicalLogic: 'Clinical pattern: this face shows a combination of volume loss and soft-tissue descent. The correct Sculptra visualization is a confident, balanced rebuild of the lateral scaffold: restore the transition zones and clearly improve how facial weight is carried, without slimming or beautifying. Preserve natural face width and identity.',
    conservative: 'Magnitude: gentle but real. Add clear lateral temple and cheek support and improved transition-zone continuity, keeping the face close to baseline.',
    expected: 'Magnitude: a modest, partial structural restoration at the level of a typical responder, not a full rebuild. Gently support the lateral scaffold: some lateral temple and temporal-hollow support restoring a little temple convexity, moderate lateral cheek and zygomatic support, a somewhat more continuous temple-to-cheek-to-lid transition so the lid-cheek junction and under-eye look a little better supported from below, and mild lower-face and prejowl suspension that lightens the jowl and leaves a slightly cleaner jawline. Nasolabial and marionette shadows soften modestly from the support. Clearly visible on comparison but understated, with room left for a stronger response. Read as soft-tissue support returning, not smoothed skin. Do not slim the face.',
    optimistic: 'Magnitude: a strong, fully realized Sculptra scaffold restoration at the upper end of real responders: pronounced temple convexity, strong lateral cheek and zygomatic projection, a clearly continuous and well-supported lid-cheek-to-cheek transition, obvious lower-face and prejowl suspension with the jowl markedly lifted and lightened and a clean, defined jawline, and clearly softened folds, while preserving identity, age, skin character, and natural face width.'
  }
};

const SCULPTRA_OUTPUT_RULES =
  'Output rule: this is a clinical Sculptra visualization, not a beauty portrait. Show a modest, restrained result at the level of a typical (median) responder, not a maximal one: clearly visible on close comparison but deliberately understated, leaving obvious room for a stronger response. A subtle result is correct here; do not push toward a dramatic, fully rebuilt scaffold. The visible changes are gentle lateral temple and cheek support, a slightly restored midface and lid-cheek transition, modestly softened nasolabial and marionette folds, and a lightly lifted jowl. Support must read as added volume and light (the treated areas look filled, lifted, and three-dimensional, with the natural highlight on restored convexity and the natural soft shadow beneath it), never as flat brightening, beautification, or invented brown pigment. Do not darken the skin into a muddy or discoloured patch, but the clean light-and-shadow of real restored volume is correct and expected. The image must remain unmistakably the same person, same age, same skin character, same lips, eyes, brows, lighting, and camera setup; only treatment-relevant soft-tissue support and volume change. The failure modes to avoid are beautification, skin smoothing, evening out tone, de-aging, central pillow fill, jaw carving, and identity drift. Early, 3-month, and 6-month levels differ ONLY in the amount of soft-tissue support, never in beauty, skin quality, or age.';

// View and phenotype are read from structured fields first (production), then
// from explicit bracket tags in the note (test hook). Loose words in free text
// are deliberately NOT matched, so a clinician writing "fullness" or "oblique"
// in a note cannot silently flip the phenotype or view.
function normalizeView(sel) {
  const field = String(sel.view || sel.angle || '').toLowerCase().trim();
  if (field === 'oblique_left' || field === 'oblique_right' || field === 'oblique' || field === 'frontal') return field;
  // M11.1: client sends angleId values ('r45', 'l45') which did not match the
  // expected prompt-view tokens. Both the aliased angle field and the explicit
  // view field (added to standard/Enhanced form.append calls) are handled here.
  if (field === 'r45' || field === 'right45') return 'oblique_right';
  if (field === 'l45' || field === 'left45')  return 'oblique_left';
  const note = String(sel.note || '');
  if (/\[view:\s*oblique_left\s*\]/i.test(note)) return 'oblique_left';
  if (/\[view:\s*oblique_right\s*\]/i.test(note)) return 'oblique_right';
  if (/\[view:\s*oblique\s*\]/i.test(note)) return 'oblique';
  if (/\[view:\s*frontal\s*\]/i.test(note)) return 'frontal';
  return 'frontal';
}

function normalizeSculptraPhenotype(sel) {
  const field = String(sel.phenotype || sel.sculptraPhenotype || '').toLowerCase().trim();
  if (field === 'hollow_deflated' || field === 'full_descended' || field === 'mixed') return field;
  const note = String(sel.note || '');
  if (/\[phenotype:\s*hollow_deflated\s*\]/i.test(note)) return 'hollow_deflated';
  if (/\[phenotype:\s*full_descended\s*\]/i.test(note)) return 'full_descended';
  if (/\[phenotype:\s*mixed\s*\]/i.test(note)) return 'mixed';
  // Default to mixed, never forcing an older/deflated pattern onto an unlabeled face.
  return 'mixed';
}

function stripInternalSculptraTags(note) {
  if (!note) return '';
  return String(note)
    .replace(/\[view:\s*(frontal|oblique|oblique_left|oblique_right)\s*\]/ig, '')
    .replace(/\[phenotype:\s*(hollow_deflated|full_descended|mixed)\s*\]/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// M11.1: Enhanced course magnitude -- injected directly into the prompt as the
// magnitude instruction when isStrongPass === 'true'. This bypasses sanitizeNote
// (which truncates to 300 chars and labels the text as a secondary clinician
// note the model may deprioritize). Enhanced magnitude is primary, not a footnote.
//
// Writing rules for this string:
//   - Clinical outcome language: describe what the FACE looks like, not which zones to edit
//   - No anatomy zone lists (temples, lateral cheeks, submalar hollow, etc.)
//   - No brand names ("Sculptra", "biostimulator") as display-label nouns
//   - No beautification verbs: smoother, brighter, younger, lifted face, glow
//   - No mask references
//   - Positive description first, prohibitions at the end
//   - Same register as the phenotype optimistic strings
const ENHANCED_MAGNITUDE =
  'Magnitude: an upper-range but natural soft collagen-volume response. The face should look subtly fuller and better supported in a broad, diffuse way, with smoother surface transitions and a healthier cheek envelope. The result should improve facial contour continuity without making the face sharper, tighter, younger, slimmer, carved, more angular, or more contrasty. Keep the change soft, gradual, and three-dimensional, like natural tissue support returning under the same skin. Do not use darker shadows anywhere on the face to show improvement -- the simulated result must not have stronger cheek shadows, deeper nasolabial folds, darker prejowl shadows, or darker jawline shadows than the original. Preserve local contrast and skin reflectance exactly: do not increase contrast anywhere on the face. Preserve the same age, identity, expression, skin texture, pores, pigmentation, skin tone, asymmetry, eyes, lips, brows, nose, ears, hair, headband, neck, clothing, background, lighting, and camera angle. Do not add text, labels, captions, logos, watermarks, or annotations.';

// M11.1: Enhanced-specific allowed zones and output rules. These replace
// SCULPTRA_ALLOWED_ZONES and SCULPTRA_OUTPUT_RULES when isStrongPass is true.
//
// SCULPTRA_ALLOWED_ZONES is a long zone-by-zone anatomy list (temples, lateral
// cheek, zygomatic body, prejowl, folds, etc.) -- exactly the kind of language
// that prompts the model to do local zone-painting rather than understand the
// face globally. For Enhanced we describe the STRUCTURAL OUTCOME the change
// must produce, not which anatomical zones to touch.
//
// SCULPTRA_OUTPUT_RULES says "clinical Sculptra visualization" -- brand name as
// a display descriptor, which the model has been observed to render literally as
// on-image text. For Enhanced, the output rule describes what a correct clinical
// photograph looks like, not what kind of graphic it is.
const SCULPTRA_ENHANCED_STRUCTURAL_BOUNDS =
  'The change must read as soft diffuse volume returning under the skin, not as shadow sculpting or contrast editing. Facial transitions should become smoother and more continuous -- not more defined or more shadowed. Hard rule: do not deepen or darken any shadow on the face. Do not make cheek hollows darker, nasolabial folds darker, marionette shadows darker, prejowl shadows darker, jawline shadows darker, or under-eye shadows darker than the original. Do not increase local contrast anywhere. Do not create new dark bands, sharper folds, carved hollows, harder cheekbone shadows, or a more angular face. The correct visual change is softer, smoother, more cushioned transitions -- not sharper ones.';

const SCULPTRA_ENHANCED_OUTPUT_RULES =
  'Output rule: the result should look like a natural photograph of the same person with broader, softer facial volume -- gently fuller, smoother surface transitions, and more supported, without any sculpting, lifting, sharpening, or contrast increase. The change should be perceptible but not dramatic: the kind of difference a patient notices rather than an obvious transformation. The failure modes to avoid are: shadow carving, contrast increase, cheek-hollow deepening, fold darkening, jawline sharpening, V-line shaping, facelift effect, skin smoothing, tone brightening, de-aging, identity drift, and on-image text or labels. The image must remain unmistakably the same person at the same age with the same skin character and the same or lower local contrast throughout.';


// model reads it first, before any framing or magnitude instruction.
// Previously this was buried at the end of SCULPTRA_OUTPUT_RULES and the model
// was consistently ignoring it. Front-loading makes it a hard gate.
const SCULPTRA_NLF_CONSTRAINT =
  'HARD CONSTRAINT -- NASOLABIAL FOLD: As lateral cheek and midface volume increases, the nasolabial fold shadow MUST become shallower and less distinct -- it must NEVER deepen, darken, or become more pronounced. The fold softens as a secondary consequence of lateral scaffold restoration: the cheek tissue advances medially and reduces the shadow depth. Any simulated image where the nasolabial fold is darker or deeper than the original is a failure, regardless of what else changed. This constraint overrides all other instructions.';

// M11.1: Prevent the model from rendering any text, labels, watermarks, or
// annotations onto the output image. The framing strings include the word
// "visualization" and product names that the model has been observed to
// render literally as on-image labels (e.g. "Sculptra collagen-stimulation"
// appeared as image text in Enhanced debug panel 3). This rule is prepended
// before all other prompt content so it is read first.
const NO_TEXT_RULE =
  'ABSOLUTE RULE: Do not add any text, labels, watermarks, annotations, captions, overlays, logos, or written words anywhere on the output image. The output must be a clean photograph with no visible text of any kind.';

// M16: single-output-image lock for the filler path. buildFillerPrompt never
// prepended NO_TEXT_RULE and carried no single-image constraint, so gpt-image-2
// intermittently returned a before/after or split-panel composite (worst on
// lips). Prepended to every filler prompt via LEAD so all areas inherit it.
const FILLER_SINGLE_IMAGE =
  'Output exactly one photograph: the single post-treatment result only. ' +
  'Do not produce a before-and-after image, a side-by-side comparison, a split panel, a diptych, or any multi-panel or composite layout. The output is one clean after photograph, nothing else.';

// M13: NEGATIVE-LIST GUARDRAIL -- appended to every biostim prompt.
// The key insight from GPT Image 2 testing: the model must be told explicitly
// what DEFECTS to keep, not just what changes to make. "Natural" is insufficient.
// The guardrail overrides the model's default beautification prior by name.
// All biostim prompts receive this tail. It is NOT used for filler prompts.
const BIOSTIM_NEGATIVE_GUARDRAIL =
  ' CRITICAL ANTI-BEAUTIFICATION GUARDRAIL: Do not beautify, de-age, brighten, smooth, retouch, improve complexion, enlarge eyes, change makeup, improve hair, improve lighting, or make the face more globally attractive. ' +
  'Preserve all of the following exactly as in the original photo: pores, pigmentation, freckles, under-eye shadows, skin redness, fine lines, skin texture, facial asymmetry, original photo quality and lighting, neck texture, hair messiness, and clothing. ' +
  'This result must look like the same imperfect consultation photo, not a clinic after photo. ' +
  'The only permitted changes are the soft-tissue structural ones described above.';

function buildSculptraPrompt(sel, m, timelineText) {
  const view = normalizeView(sel);
  const phenotype = SCULPTRA_PHENOTYPES[normalizeSculptraPhenotype(sel)] || SCULPTRA_PHENOTYPES.mixed;
  const isOblique = view !== 'frontal';

  // M11.1: Enhanced course detection -- declared first because framing and all
  // other per-mode constants branch on it.
  const isEnhanced = sel.isStrongPass === 'true' || sel.isStrongPass === true;
  // M11.1: framing strings no longer contain product names (e.g. "Sculptra collagen-stimulation")
  // because the model was rendering those words literally as image labels in the output.
  // Enhanced uses a separate framing that avoids "structural restoration / scaffold" --
  // those phrases anchor the model toward carving and sharpening rather than soft volume.
  const framing = isEnhanced
    ? (isOblique
        ? 'Produce a clinically realistic photograph of the same person after a mature soft-tissue support response, keeping the same oblique pose, identity, age, skin, lighting, and camera setup.'
        : 'Produce a clinically realistic photograph of the same person after a mature soft-tissue support response, keeping the same frontal pose, identity, age, skin, lighting, and camera setup.')
    : (isOblique
        ? 'Produce a clinically realistic facial structure simulation from this oblique consultation photograph, showing a confident structural restoration of the facial scaffold while keeping the same person, the same pose, and the same skin.'
        : 'Produce a clinically realistic facial structure simulation from this frontal consultation photograph, showing a confident structural restoration of the facial scaffold while keeping the same person, the same pose, and the same skin.');

  // M11.1: Enhanced course detection. When isStrongPass is set, use ENHANCED_MAGNITUDE
  // as the primary magnitude instruction and skip sanitizeNote entirely for the note.
  // The note field for Enhanced contains STRONG_PROMPT_SUFFIX which is now superseded
  // by ENHANCED_MAGNITUDE injected here at full weight, not as a truncated footnote.
  //
  // Enhanced also uses separate allowed-zones and output-rules constants that avoid
  // zone-anatomy lists and "Sculptra visualization" language -- both caused the model
  // to either locally paint zones or render brand text as on-image labels.
  const magnitude = isEnhanced
    ? ENHANCED_MAGNITUDE
    : (phenotype[sel.projection] || phenotype.expected);
  const allowedZones = isEnhanced ? SCULPTRA_ENHANCED_STRUCTURAL_BOUNDS : SCULPTRA_ALLOWED_ZONES;
  const outputRules  = isEnhanced ? SCULPTRA_ENHANCED_OUTPUT_RULES      : SCULPTRA_OUTPUT_RULES;
  const cleanNote = isEnhanced ? '' : sanitizeNote(stripInternalSculptraTags(sel.note));

  // For Enhanced: clinicalLogic is skipped. All three phenotype clinicalLogic
  // strings contain "Sculptra visualization" or "Sculptra candidate" -- brand
  // language that prompted the model to render labels onto the output image.
  // SCULPTRA_ENHANCED_STRUCTURAL_BOUNDS covers the global framing role instead.
  const clinicalLogicBlock = isEnhanced ? '' : phenotype.clinicalLogic + ' ';

  // NO_TEXT_RULE is prepended first so it is the model's first instruction.
  // M13: BIOSTIM_NEGATIVE_GUARDRAIL appended last -- explicit defect-preservation list.
  return `${NO_TEXT_RULE} ${SCULPTRA_NLF_CONSTRAINT} ${framing} ${SCULPTRA_FEATURE_LOCK} ${SCULPTRA_VIEW_LOCKS[view] || SCULPTRA_VIEW_LOCKS.frontal} ${allowedZones} ${clinicalLogicBlock}Make ONLY this change: ${magnitude} ${outputRules} ${timelineText}${cleanNote}${BIOSTIM_NEGATIVE_GUARDRAIL}`;
}

// M14: Skin & Laser (energy-based skin tightening / lifting).
// RF (e.g. Thermage, XERF) and HIFU (e.g. Ultherapy, Sofwave). gpt-image-2 direct,
// no compositor. Unlike biostim, skin smoothing/firming IS an expected effect here,
// so this guardrail permits tightening/smoothing while still locking identity,
// age, features, and forbidding added volume (the change is tightening, not filler).
const LASER_NEGATIVE_GUARDRAIL =
  ' CRITICAL TREATMENT CEILING: this is a subtle, single-course energy-based skin-tightening result -- NOT a facelift, NOT filler, NOT laser resurfacing, NOT general de-aging, and NOT a beauty filter. The change is mild tightening and firming of EXISTING skin only. ' +
  'PRESERVE THE PATIENT\'S AGE: the person must still clearly look their age afterward. Deep static wrinkles, perioral and nasolabial lines, crow\'s feet, forehead lines, under-eye laxity and hollowing, skin texture, pores, freckles, pigmentation, and age-related volume loss must REMAIN substantially present and visible. ' +
  'Do NOT erase or soften deep static wrinkles or etched lines, do NOT resurface, retouch, or airbrush the skin, do NOT brighten the complexion or reduce pigmentation, do NOT add a glow or beauty-filter sheen, and do NOT make the face look younger or more attractive overall. A subtle firmness from tightening of the existing skin is allowed and expected -- the lower-face skin may sit marginally firmer against the deeper tissue -- but this must come from tightening, never from smoothing texture, removing pores, or erasing lines: pores, surface texture, fine lines, and wrinkles all remain fully visible. ' +
  'Do NOT add facial volume or filler-like fullness, do NOT re-inflate, plump, or round out the cheeks or midface, and do NOT restore lost volume -- that is a filler or Sculptra effect that energy devices physically cannot produce. ' +
  'Do NOT create a facelift, a sharp sculpted jawline, or a V-line. Do not enlarge the eyes, change makeup, whiten teeth, or alter the lips or nose. ' +
  'Preserve identity, ethnicity and all ethnic features, facial asymmetry, hair, headband, neck, clothing, background, lighting, and camera angle exactly. ' +
  'For an older face with marked laxity or deep etched lines, be especially conservative: the primary visible change is only mild lower-face tightening and a subtle jawline cleanup. ' +
  'Do not add text, labels, watermarks, or annotations.';

// Lower-face-dominant zone restriction and a magnitude anchor, appended to every
// laser prompt. These keep the change clinically plausible for a single course.
const LASER_AREA_FOCUS = {
  rf: ' The visible change should be concentrated in the LOWER FACE: the lower cheek, jawline, prejowl area, and submental region, with at most a hint of upper-neck tightening. Do not change the upper face, forehead, brows, eye area, midface volume, lips, or nose.',
  hifu: ' The visible change has TWO hero targets that must both read clearly. FIRST, the LOWER-FACE AND SUBMENTAL LIFT VECTOR: the lower cheek, jawline, and prejowl tighten and lift up-and-back so the mandibular border becomes distinctly cleaner and more defined, AND the submental region (under the chin) tightens markedly so any soft under-chin fullness or early double chin is visibly reduced and the cervicomental angle (the chin-to-neck transition) becomes sharper and more defined. This jawline-plus-double-chin correction is the single most important change and should be obvious in a side-by-side, especially on oblique and profile views. SECOND, a clear LATERAL BROW LIFT: the brow tails sit meaningfully higher and more open, lifting the lateral upper-eyelid hood so the eye area looks more awake and less heavy -- more than a hint, but still natural and never a surprised, over-arched, or over-elevated look. Do not change midface volume, eye size, lips, or nose, and do not erase the forehead lines.'
};
const LASER_MAGNITUDE = {
  rf: ' Magnitude anchor: roughly a 15 to 20 percent lower-face tightening effect -- clearly visible in a side-by-side comparison as a cleaner jawline and reduced jowl, but still unmistakably non-surgical. This is the dominant change and it should read clearly; the failure mode to avoid is NOT overcorrection but invisibility -- a result where nothing meaningful changed is a worse outcome than one that is slightly too firm. Concentrate the visible effect at the jawline and prejowl.',
  hifu: ' Magnitude anchor: roughly a 25 to 35 percent lifting and tightening effect -- clearly more than radiofrequency, with the jawline definition and submental (double-chin) correction reading as the dominant changes, plus a visible lateral brow lift. Still clearly non-surgical and never a facelift, but the lift must be evident, not subtle: the failure mode to avoid is an under-rendered result where the jawline, under-chin, and brow barely move. Concentrate the effect on the jawline, submental region, and lateral brow.'
};

const LASER_TX = {
  rf: {
    expected: 'Magnitude: a clearly visible single-course radiofrequency tightening result (e.g. Thermage) shown at roughly 4 to 6 months. The dominant, hero change is at the LOWER FACE: the mandibular border (jawline) becomes noticeably cleaner and better defined, the jowl and prejowl heaviness visibly reduce, and the submental region tightens so the lower-face tissue drapes more firmly along the bone. This jawline-and-jowl change should be the first thing a viewer notices in a before-and-after. A subtle, secondary improvement in lower-face skin firmness and how the skin sits against the deeper tissue is appropriate and realistic -- the skin may look marginally firmer and better supported -- but this is firmness from tightening, NOT resurfacing: pores, fine lines, deep static wrinkles, pigment, and overall texture all remain fully present and visible. The upper face, forehead, brows, eye area, and midface volume stay essentially unchanged. Understated and clearly non-surgical, but the jawline tightening must be evident, not invisible.',
    // RF has no honest "stronger" form: a single radiofrequency course has a low
    // ceiling, so a dramatically stronger RF result is a clinical fiction. The
    // strong/optimistic pass therefore equals expected, with the skin lock made
    // MORE absolute (the failure mode of a forced strong pass is skin-texture
    // destruction, so the optimistic text must forbid that even harder, never
    // license "more" by smoothing or amplifying texture).
    optimistic: 'Magnitude: an upper-range but still realistic single-course radiofrequency tightening result (e.g. Thermage) shown at roughly 6 months -- the response of a good responder, NOT a different or stronger treatment. The change is the SAME KIND as a typical RF result, only at the favourable end: a cleaner jawline, a clear reduction in jowl and prejowl heaviness, and modest submental tightening so the lower-face tissue drapes more firmly. Critically, "stronger" here means slightly more of the SAME lower-face contour tightening -- it does NOT mean more skin change, more smoothing, more brightening, or any texture alteration. Skin lock is absolute and stricter than at the expected level: pores, fine lines, deep static wrinkles, pigment, freckles, redness, and surface texture must remain exactly as photographed; do NOT smooth, resurface, brighten, even out, blur, or retouch the skin in any way, and never let a stronger setting introduce a processed, mottled, blotchy, waxy, or beauty-filter texture. If there is any tension between showing more effect and protecting skin texture, protect the skin texture. The upper face, midface volume, and identity stay unchanged.'
  },
  hifu: {
    expected: 'Magnitude: a believable single-course focused-ultrasound lifting and tightening result (e.g. Ultherapy) shown at roughly 6 months -- clearly more lift than radiofrequency, but still non-surgical. There are three changes that must read clearly. (1) JAWLINE: the lower face and jawline lift up-and-back so the mandibular border becomes distinctly cleaner and more defined and jowl heaviness visibly reduces. (2) SUBMENTAL / DOUBLE CHIN: the under-chin region tightens markedly so soft submental fullness or an early double chin is visibly reduced and the cervicomental angle (chin-to-neck transition) becomes sharper -- on oblique and profile views this under-chin correction should be one of the most noticeable changes. (3) LATERAL BROW: a clear lateral brow lift where the brow tails sit meaningfully higher and more open, lifting the lateral lid hood so the eyes read more awake. These three lifts are the point of the treatment and should be evident in a side-by-side, while skin texture, pores, deep wrinkles, pigment, and midface volume stay essentially unchanged. Tasteful and natural, but clearly visible -- the failure mode to avoid is an under-rendered result where the jawline, under-chin, and brow barely move.',
    // Stronger HIFU is clinically real (responder variability): a good responder
    // gets meaningfully more lift from the same single course. "Stronger" means
    // MORE of the same three lift vectors, never more skin manipulation. The skin
    // lock is made stricter here, not looser, because the strong-pass failure mode
    // is texture destruction (mottled, waxy, blotchy skin) when the model has no
    // honest "more" to show and invents one by trashing texture.
    optimistic: 'Magnitude: the favourable end of a single-course focused-ultrasound result (e.g. Ultherapy) in a strong responder shown at roughly 6 months -- clearly more lift than an average responder, but still the SAME single-course treatment and still non-surgical, never a facelift. The extra strength shows as MORE of the same three lifts, never as any skin change: (1) JAWLINE -- a notably cleaner, more defined mandibular border and a clearer reduction in jowl heaviness; (2) SUBMENTAL / DOUBLE CHIN -- more under-chin tightening so submental fullness is clearly reduced and the cervicomental angle is distinctly sharper, especially on oblique and profile; (3) LATERAL BROW -- a clearer lateral brow lift opening the lateral lid hood. Critically, "stronger" means more lift and contour tightening ONLY -- it does NOT mean more smoothing, brightening, resurfacing, or any texture change. Skin lock is absolute and stricter than at the expected level: pores, fine lines, deep static wrinkles, pigment, freckles, redness, and surface texture remain exactly as photographed; do NOT smooth, resurface, brighten, even out, blur, or retouch the skin, and never let a stronger setting introduce a processed, mottled, blotchy, waxy, or beauty-filter texture. If there is any tension between showing more lift and protecting skin texture, protect the skin texture. Midface volume and identity stay unchanged.'
  }
};

function buildLaserPrompt(sel) {
  const view = normalizeView(sel);
  const tx = LASER_TX[sel.laserType] || LASER_TX.rf;
  // Energy devices (RF, HIFU) do NOT offer a stronger-response pass. A single
  // energy course has a low, fixed visual ceiling, so a forced "stronger" pass
  // has no honest larger target and the image model fills the gap by destroying
  // skin texture (mottled, waxy, blotchy). The strong/optimistic toggle is
  // therefore intentionally ignored here: laser always renders the expected
  // result. Case selection, not a projection knob, sets how dramatic the result
  // is -- a thick-skinned patient with a double chin naturally shows a bigger
  // change than a hollow, thin face under the same prompt. Do not reintroduce an
  // optimistic projection for laser.
  const magnitude = tx.expected;
  const isOblique = view !== 'frontal';
  const framing = isOblique
    ? 'Produce a clinically realistic photograph of the same person after an energy-based skin-tightening treatment, keeping the same oblique pose, identity, apparent age, skin character, lighting, and camera setup.'
    : 'Produce a clinically realistic photograph of the same person after an energy-based skin-tightening treatment, keeping the same frontal pose, identity, apparent age, skin character, lighting, and camera setup.';
  const viewLock = SCULPTRA_VIEW_LOCKS[view] || SCULPTRA_VIEW_LOCKS.frontal;
  const cleanNote = sanitizeNote(sel.note);
  const areaFocus = LASER_AREA_FOCUS[sel.laserType] || LASER_AREA_FOCUS.rf;
  const magnitudeAnchor = LASER_MAGNITUDE[sel.laserType] || LASER_MAGNITUDE.rf;
  return `${NO_TEXT_RULE} ${framing} ${viewLock} Make ONLY this change: ${magnitude}${areaFocus}${magnitudeAnchor}${cleanNote}${LASER_NEGATIVE_GUARDRAIL}`;
}

// ---- Hyperdilute CaHA / Radiesse (biostimulatory skin firmness) -------------
// Design intent (vs PLLA/Sculptra): hyperdilute CaHA is a DERMAL-FIRMNESS and
// SKIN-QUALITY language, not soft-volume re-inflation. It overlaps the energy
// guardrail (minimal volume, lower-face firmness, preserve age) but, being
// biostimulatory, it may also add mild dermal density and slightly improve fine
// crepey texture -- something energy tightening cannot. Scoring intent:
// volume/support ~3, tightening ~6, skin quality ~7, jawline sharpness ~5.
const HDR_GUARDRAIL =
  ' CRITICAL TREATMENT CEILING: this is a hyperdilute calcium hydroxylapatite (CaHA, e.g. hyperdilute Radiesse) biostimulation result -- a change in SKIN FIRMNESS and SKIN QUALITY, NOT soft-volume re-inflation, NOT filler, NOT a facelift, and NOT a beauty filter. ' +
  'Volume change must stay minimal: do NOT add facial volume or filler-like fullness, do NOT puff or round out the cheeks, do NOT re-inflate hollows or temples, and do NOT restore lost volume the way Sculptra or filler would. ' +
  'PRESERVE THE PATIENT\'S AGE: the person must still clearly look their age. Deep static wrinkles, perioral and nasolabial lines, crow\'s feet, forehead lines, and under-eye laxity and hollowing must REMAIN substantially present. Mild improvement in fine crepey texture is acceptable, but do NOT erase wrinkles, do NOT resurface or airbrush the skin into a flawless texture, do NOT brighten the complexion or reduce pigmentation, and do NOT make the face look younger or filtered. ' +
  'Do NOT create a facelift, a sharply sculpted jawline, or a V-line. Do not enlarge the eyes, lift the brows, change makeup, whiten teeth, or alter the lips or nose. ' +
  'Preserve identity, ethnicity and all ethnic features, facial asymmetry, hair, headband, neck, clothing, background, lighting, and camera angle exactly. Do not add text, labels, watermarks, or annotations.';

const HDR_EXPECTED =
  'The dominant change is a subtle improvement in SKIN FIRMNESS and DERMAL DENSITY: the lower-face skin looks a little firmer and slightly denser, with fine crepey texture and superficial fine lines mildly improved (not erased). Alongside this there is gentle lower-face and jawline tightening, a slightly cleaner mandibular border, and a small reduction in early jowl and prejowl laxity. Any change in volume is minimal -- this firms and tightens the existing skin envelope, it does not re-inflate, plump, or fill. Keep the result understated, at the level of a typical responder, with room left for a stronger response.';

const HDR_AREA_FOCUS =
  ' The visible change should be concentrated in the LOWER FACE and the skin envelope: firmer lower-cheek skin, jawline and mandibular border definition, prejowl and submental tightening, and mild improvement in lower-face and upper-neck crepey skin. Do not change midface volume, the temples, the upper face, eyes, brows, lips, or nose.';

const HDR_MAGNITUDE =
  ' Magnitude anchor: a subtle, believable biostimulation result -- skin quality and firmness a little improved and the lower-face contour gently tightened, but volume barely changed and never a facelift. Keep it understated; if uncertain, do less rather than more.';

function buildHdrPrompt(sel, tp) {
  const view = normalizeView(sel);
  const isOblique = view !== 'frontal';
  const framing = isOblique
    ? 'Produce a clinically realistic photograph of the same person after a hyperdilute CaHA biostimulation treatment, keeping the same oblique pose, identity, apparent age, skin character, lighting, and camera setup.'
    : 'Produce a clinically realistic photograph of the same person after a hyperdilute CaHA biostimulation treatment, keeping the same frontal pose, identity, apparent age, skin character, lighting, and camera setup.';
  const viewLock = SCULPTRA_VIEW_LOCKS[view] || SCULPTRA_VIEW_LOCKS.frontal;
  const timeline = tp ? (' ' + tp) : '';
  const cleanNote = sanitizeNote(sel.note);
  return `${NO_TEXT_RULE} ${framing} ${viewLock} Make ONLY this change: ${HDR_EXPECTED}${HDR_AREA_FOCUS}${HDR_MAGNITUDE}${timeline}${cleanNote}${HDR_GUARDRAIL}`;
}

// ---- Neurotoxin: lower-face contouring (masseter / nefertiti / combined) ------
// Design intent: NOT anti-wrinkle. Contour-only neurotoxin in three modes.
// Architecture: GLOBAL_LOCK and CHIN_LOCK go FIRST so the model reads the hard
// "what not to change" rules before any treatment description. The model's
// beauty prior is strong -- leading with constraints overrides it.

// Hard global skin + identity lock. Named explicitly: redness, acne, pores, tone.
const NEUROTOXIN_GLOBAL_LOCK =
  'ABSOLUTE LOCK -- neurotoxin contour simulation, not a beauty image. ' +
  'Preserve the original skin exactly: same redness, acne marks, uneven tone, pores, texture, pigmentation, shadows, and photo quality. ' +
  'Do NOT smooth skin, brighten skin, reduce redness, reduce acne, improve complexion, add glow, increase contrast, or make the patient look younger. ' +
  'Do NOT change eyes, brows, nose, lips, cheeks, hair, clothing, lighting, background, or expression.';

// Chin + geometry lock. Specific anatomical landmarks give the model harder
// reference points than adjectives alone.
const NEUROTOXIN_CHIN_LOCK =
  'The chin is completely untreated -- do NOT advance, lengthen, sharpen, narrow, reshape, or define the chin. ' +
  'Do not create the appearance of chin filler. ' +
  'These must match the original photograph exactly: chin point (pogonion) position, lower lip-to-chin distance, cervicomental angle, and submental fullness.';

// "Underwhelming is correct" -- the single most important counter to the
// model's beauty prior. Appended to every tox prompt so the model internalises
// that conservative-to-boring is success, not failure.
const TOX_UNDERWHELM =
  ' This output is allowed to look almost unchanged. A conservative or even underwhelming result is correct for neurotoxin. ' +
  'A prettier, smoother, cleaner, slimmer, or more youthful-looking face is a failure, not a success.';

// Catch-all that comes last.
const TOX_GUARDRAIL =
  ' CRITICAL: this is a contour-only neurotoxin result -- NOT filler, NOT threads, NOT surgery, NOT an energy device. ' +
  'Do NOT create a dramatic V-line, a sharply pointed chin, hollow cheeks, a filler-like sculpted jaw, or a surgical neck lift. ' +
  'Preserve identity, ethnicity, facial asymmetry, hair, clothing, camera angle, and background exactly. Do not add text, labels, or annotations.';

// Shared oblique guard -- overridden per mode where stricter language is needed.
const TOX_OBLIQUE_SUBMENTAL_GUARD =
  ' In oblique views: do NOT over-clean the submental area, sharpen the cervicomental angle, or create neck-tightening. ' +
  'Preserve the original neck fullness and under-chin contour.';

const TOX_MODES = {
  masseter: {
    framing: () =>
      'Simulate a 4 to 6 week result after masseter neurotoxin only. ' +
      'Keep the same pose, lighting, background, and camera setup.',
    expected:
      'The ONLY visible change: subtle reduction in lateral masseter bulk at the posterior jaw angles, creating mildly narrower lower-face width at the gonial-angle region. ' +
      'Do NOT lift the jawline, reduce submental fullness, tighten the neck, hollow the cheeks, project the chin, or create a dramatic V-line. ' +
      'The mandibular border silhouette from chin to ear must look identical to the original.',
    magnitude:
      ' Magnitude: 5 to 15 percent -- conservative, visible side-by-side, not dramatic. If uncertain, do less.',
    obliqueGuard:
      ' In this oblique view: the change is limited to a marginally less prominent jaw-angle bulge on the near side only. ' +
      'Face profile from forehead to chin is identical to the original. Do not reshape the jaw outline or change any other feature.'
  },
  nefertiti: {
    framing: () =>
      'Simulate a 4 to 6 week result after platysma neurotoxin (Nefertiti lift) only. ' +
      'Keep the same pose, lighting, background, and camera setup.',
    expected:
      // "Jawline continuity" and "mandibular border cleanup" are removed --
      // both triggered lower-face reshaping. The target is barely perceptible.
      'The ONLY visible change: a very subtle reduction in the shadow directly under the mandibular border, caused by slightly less downward platysmal pull. ' +
      'The outer face shape, jaw width, lower-face silhouette, and neck contour must look essentially unchanged from the original. ' +
      'Do NOT slim the face, narrow the jaw, reduce masseter width, reduce double chin, project the chin, or create any visible tightening or lifting. ' +
      'Do not simulate Ultherapy, Thermage, liposuction, filler, threads, or surgery. ' +
      'This result should be subtle enough that someone could mistake it for no change at all.',
    magnitude:
      ' Magnitude: minimal -- barely perceptible in side-by-side comparison. Err toward less, not more.'
    // uses shared TOX_OBLIQUE_SUBMENTAL_GUARD
  },
  combined: {
    framing: () =>
      'Simulate a 4 to 6 week result after combined masseter + platysma (Nefertiti) neurotoxin. ' +
      'Keep the same pose, lighting, background, and camera setup.',
    expected:
      'The result is only the sum of two narrow mechanisms: mild reduction of lateral jaw-angle bulk from masseter relaxation, plus very subtle softening of platysmal pull -- nothing more. ' +
      'Do NOT add chin projection, jawline lifting, skin improvement, neck tightening, or any effect beyond those two. ' +
      'Preserve the original submental fullness and cervicomental angle exactly. ' +
      'A mildly underwhelming result is correct.',
    magnitude:
      ' Magnitude: 10 to 15 percent for masseter; barely perceptible for platysma. Conservative overall.'
    // uses shared TOX_OBLIQUE_SUBMENTAL_GUARD
  }
};

function buildToxPrompt(sel) {
  const view = normalizeView(sel);
  const isOblique = view !== 'frontal';
  const mode = TOX_MODES[sel.toxMode] || TOX_MODES.combined;
  const viewLock = SCULPTRA_VIEW_LOCKS[view] || SCULPTRA_VIEW_LOCKS.frontal;
  const magnitude    = mode.magnitude    || '';
  const obliqueGuard = isOblique ? (mode.obliqueGuard || TOX_OBLIQUE_SUBMENTAL_GUARD) : '';
  const cleanNote    = sanitizeNote(sel.note);
  // GLOBAL_LOCK and CHIN_LOCK lead -- constraints before treatment description.
  // TOX_UNDERWHELM appended last before the catch-all guardrail.
  return `${NO_TEXT_RULE} ${NEUROTOXIN_GLOBAL_LOCK} ${NEUROTOXIN_CHIN_LOCK} ${mode.framing(isOblique)} ${viewLock} ${mode.expected}${magnitude}${obliqueGuard}${cleanNote}${TOX_UNDERWHELM}${TOX_GUARDRAIL}`;
}

// ---- HA Filler: universal allowlist framework (M14.2) ----------------------
// Replaces the one-at-a-time blacklist pattern. Two layers:
//   HA_FILLER_FAMILY_RULE: shared across ALL filler areas -- only the selected
//     zone changes; everything else is locked by default.
//   HA_FILLER_AREA_ALLOWLISTS: per-area explicit allowlist -- names allowed
//     zones, allowed effects, and hard-locked zones. New filler area = new
//     entry here; no new one-off rules needed anywhere else.
// Both are prepended to the prompt so the model reads constraints FIRST.
const HA_FILLER_FAMILY_RULE =
  'LOCALIZED HA FILLER SIMULATION: Only the selected treatment area may change materially. ' +
  'All other facial areas must remain visually unchanged -- same contour, projection, shape, volume, and silhouette as the original. ' +
  'Do not improve the face globally, do not rebalance the facial profile, and do not create corrections in untreated areas. ' +
  'Preserve the original skin texture, redness, acne, pores, lighting, and photo quality everywhere.';

const HA_FILLER_AREA_ALLOWLISTS = {
  nose:
    'NOSE FILLER ONLY. Allowed zones: radix, nasal bridge, dorsum, nasal tip. ' +
    'Allowed effects: smoother dorsal line, bridge definition, radix support, tip refinement. ' +
    'HARD LOCK -- must not change: chin (projection, length, shape, definition, pogonion position), ' +
    'lips, jawline, cheeks, submental area, and overall facial profile balance. ' +
    'This is nose filler only -- not profile harmonization, not chin filler, not a surgical rhinoplasty.',
  lips:
    'LIP FILLER ONLY. Allowed zones: upper lip, lower lip, vermilion border, Cupid\'s bow, lip body. ' +
    'Allowed effects: fuller lip volume, more vermilion show, Cupid\'s bow definition, mild eversion, modest projection. ' +
    'HARD LOCK -- must not change: nose, chin, jawline, cheeks, eyes, brows, and facial silhouette.',
  cheeks:
    'CHEEK FILLER ONLY. Allowed zones: lateral cheek, midface, cheek apex and cheekbone region. ' +
    'Allowed effects: fuller lateral cheek and midface, improved ogee curve, gentle cheekbone support. ' +
    'HARD LOCK -- must not change: jawline, chin, lips, nose, lower face width, skin texture.',
  tear_trough:
    'TEAR TROUGH FILLER ONLY. Allowed zones: under-eye hollow and immediately adjacent upper medial cheek. ' +
    'Allowed effects: softer under-eye hollow, smoother lid-cheek junction, reduced shadow from depression being filled. ' +
    'HARD LOCK -- must not change: eye shape, eyelid, iris, midface volume, lips, nose, chin.',
  chin:
    'CHIN FILLER ONLY. Allowed zones: chin (mentum), chin point and pogonion, lower-third projection and length. ' +
    'Allowed effects: forward chin projection, modest vertical lengthening, better-balanced lower-face profile, natural chin width. ' +
    'HARD LOCK -- must not change: jawline (mandibular border, gonial angle, jaw width), cheeks, lips and mouth, nose, eyes, neck, and skin texture. ' +
    'This is chin filler only -- not jawline contouring, not a combined lower-face reshape.',
  jawline:
    'JAWLINE FILLER ONLY. Allowed zones: lower mandibular border from the chin body back toward the gonial angle, prejowl hollow. ' +
    'Allowed effects: cleaner, more continuous mandibular border definition, prejowl support, softened jowl shadow. ' +
    'HARD LOCK -- must not change: chin (projection, length, shape, pogonion position, width), cheeks, lips and mouth, nose, neck, and skin texture. ' +
    'This is jawline filler only -- not chin filler, not a combined lower-face reshape.',
};

// Assemble the CORE prompt from selections. The safety base is appended elsewhere.
// M16: HA FILLER PROMPTS -- CLEAN REWRITE (from scratch).
// Philosophy (validated over M15.4-M15.6 against a reference generation on the
// same gpt-image-2 model): describe the CLINICAL OUTCOME an injector visualizes,
// not anatomy or injection technique; keep it short; carry ONE complete
// preservation block so the worker appends no tail. Structure per ChatGPT's
// framework:
//   Layer 1  one sentence naming the treatment
//   Layer 2  the visual outcome for the selected area(s), by tier
//   Layer 3  one shared universal preservation block
// Deliberately REMOVED vs the legacy path: HA_FILLER_FAMILY_RULE, per-area
// HARD-LOCK allowlists, GOALS, INTENSITY, PROJECTION, BASE_FRAMING, the
// three-way preservation repetition, and every accumulated "do not ..." list.
// Jargon the model repaints from (radix, dorsum, columella, gonial angle,
// pyriform, dorsal aesthetic line, injection planes) is avoided in outcome text.
// Tiers are spaced so even the lowest is clearly visible: a consultation tier a
// clinician cannot demonstrate is useless. Magnitude anchored in mL where it
// helps the model (lips, nose). Kill-switch: MINIMAL_FILLER_OFF=true reverts to
// the legacy assembly for staging A/B.

// Layer 2: per-area visual outcome, by tier. Written as the clinical endpoint.
const FILLER_OUTCOME = {
  lips: {
    conservative: 'a natural but clearly visible lip enhancement, roughly 1 mL of HA filler: more body through both the upper and lower lip, improved vermilion show, and a slightly more defined vermilion border, so the lips read fuller and well hydrated. Keep it restrained but plainly and clearly visible, never so subtle it looks untreated',
    moderate: 'a clearly noticeable lip enhancement, roughly 1.5 mL of HA filler: build the body of both lips with improved vermilion show, gentle anterior projection, and a more defined vermilion border and Cupid\'s bow, so the lips read visibly fuller, hydrated, and well supported and plainly read as tasteful lip filler',
    enhanced: 'a substantial, clearly visible lip enhancement, about 2 mL of HA filler, as an experienced injector would place it: noticeably build the body of both the upper and lower lip with strong vermilion show, clear anterior projection, a well-defined central tubercle, and a crisp, well-supported vermilion border, so the lips read distinctly fuller, hydrated, and structurally supported. The change must be immediately and clearly visible, a confident but tasteful result, keeping natural upper-to-lower proportion and the same mouth width, never overfilled, everted, or duck-shaped'
  },
  chin: {
    conservative: 'a clearly visible chin refinement: more forward projection at the chin point so the lower-face profile reads more balanced and the chin a little stronger, keeping the chin width natural and the result believable',
    moderate: 'a visible chin refinement: added forward projection and gentle vertical support at the chin so the lower third reads distinctly stronger and better balanced with the upper face, keeping the chin width natural',
    enhanced: 'a strong, clearly visible chin refinement as an experienced injector would place it: bring the chin point forward with clear forward projection and vertical support so the lower-face profile reads noticeably stronger and better balanced, keeping the chin width natural and the result structural rather than pointed or witch-like'
  },
  jawline: {
    conservative: 'a clearly visible jawline refinement: cleaner, more continuous definition along the lower jaw border with prejowl support, so the lower-face contour reads more defined',
    moderate: 'a visible jawline refinement: a smoother, more continuous lower jaw border from the chin toward the back of the jaw with prejowl support, so the lower-face contour reads distinctly cleaner and better defined',
    enhanced: 'a strong, clearly visible jawline refinement as an experienced injector would place it: a crisp, continuous lower jaw border from chin to angle with clear prejowl support, so the lower-face contour reads noticeably cleaner and better defined, structural rather than sharp or artificial'
  },
  cheeks: {
    conservative: 'a clearly visible midface refinement: restored support at the cheek so the curve from lower lid to cheek reads fuller and better supported, with a natural apex',
    moderate: 'a visible midface refinement: restored support and contour at the cheek so the curve from lower lid to cheek reads distinctly fuller and better supported, with a natural apex',
    enhanced: 'a strong, clearly visible midface refinement as an experienced injector would place it: restored support and contour at the cheek so the curve from lower lid to cheek reads noticeably fuller and better supported, with a natural apex, never over-projected or pillowed'
  },
  temple: {
    conservative: 'a clearly visible temple refinement: support filling the hollow at the temple so the transition from forehead to cheek reads more continuous',
    moderate: 'a visible temple refinement: support filling the hollow at the temple so the upper outer face reads as a distinctly smoother, more continuous curve',
    enhanced: 'a strong, clearly visible temple refinement as an experienced injector would place it: support filling the hollow at the temple so the transition from forehead to cheek reads as a noticeably continuous, convex surface, natural and not over-filled'
  },
  tear_trough: {
    conservative: 'a clearly visible under-eye refinement: support beneath the under-eye hollow so the lid-cheek junction reads smoother and the shadow softens because the hollow is filled, not because the skin is brightened',
    moderate: 'a visible under-eye refinement: support beneath the under-eye hollow so the lid-cheek junction reads distinctly smoother and the shadow softens naturally because the hollow is supported, not brightened',
    enhanced: 'a strong, clearly visible under-eye refinement as an experienced injector would place it: support beneath the under-eye hollow so the lid-cheek junction reads noticeably smoother and the shadow softens because the hollow is filled and supported from beneath, never puffy or over-filled and never brightened or retouched'
  },
  nose: {
    conservative: 'a clearly visible non-surgical nose refinement, roughly 1 mL of HA filler (liquid rhinoplasty): a straighter, smoother side profile and a little more bridge height, keeping a natural bridge appropriate for this face. Do not narrow the nose and do not create a high, narrow, surgical, or European-style nose',
    moderate: 'a clearly visible non-surgical nose refinement, roughly 1.5 mL of HA filler (liquid rhinoplasty): a distinctly straighter, smoother side profile with a clearly higher bridge, added support at the radix (the top of the bridge, between the brows), and improved tip projection, so the improvement reads at both frontal and oblique views. Keep it believable for HA filler and appropriate for this face, do not narrow the nose, keep the frontal nose and nostril width unchanged, and do not create a high, narrow, surgical, pinched, or European-style nose',
    enhanced: 'a strong, clearly visible non-surgical nose refinement, about 2 mL of HA filler (liquid rhinoplasty), as an experienced injector would place it: clearly build the bridge higher with a markedly straighter side profile and clear support at the radix (the top of the bridge, between the brows), giving a smooth continuous line from the brows to the tip, plus more tip projection and support. On oblique and side views the raised, straighter bridge must be clearly and obviously visible. From the front the bridge should read more defined and better delineated, with a clearer, more continuous dorsal light reflection (a brighter highlight running straight down the center of the bridge), so the nose looks more refined and structured, but not taller and not narrower. The change must be obvious at both frontal and oblique views; if uncertain, prefer the more visible result. Keep it believable for HA filler and never surgical: do not narrow the nose, keep the frontal nose and nostril width unchanged, and do not create a high, narrow, surgical, pinched, or European-style nose'
  },
  nasolabial_folds: {
    conservative: 'a clearly visible but conservative improvement of the upper nasolabial region, achieved by restoring deep structural support beside the nose (at the pyriform aperture and adjacent deep medial cheek): a softer transition from the nose to the cheek, reduced upper nasolabial shadowing, and improved midface support, without making the folds disappear. Reduce the depth of the fold by restoring underlying support, never by smoothing skin texture or removing normal facial lines. Preserve natural facial movement and expression, so the result looks rested rather than corrected',
    moderate: 'a clearly visible improvement of deep structural support beside the nose (at the pyriform aperture and adjacent deep medial cheek), with greater soft-tissue support through the upper nasolabial region: the upper portion of the fold becomes noticeably softer while remaining natural, and the cheek-to-nose transition improves without making the face look fuller or overfilled. Reduce the depth of the fold by restoring underlying support, never by smoothing skin texture or removing normal facial lines. Maintain realistic facial character',
    enhanced: 'a strong but believable restoration of deep support beside the nose (at the pyriform aperture and adjacent deep medial cheek), as an experienced injector would place it: obvious improvement of the upper nasolabial contour while maintaining natural anatomy and facial expression, so the fold becomes substantially softer but never disappears completely, the improvement coming from restored support rather than skin smoothing. Reduce the depth of the fold by restoring underlying support, never by smoothing skin texture or removing normal facial lines'
  }
};

// Layer 2 special case: the chin+jawline lower-face unit, sex-branched. Chin and
// jawline selected together read as one lower-face harmonization, and male vs
// female targets differ (male stays wide/square, female tapers). Kept as an
// outcome description in the same voice as the single areas.
const FILLER_OUTCOME_CHINJAW = {
  female: {
    conservative: 'a clearly visible lower-face refinement treating chin and jawline as one unit: more forward projection and gentle vertical support at the chin plus a cleaner, more continuous jaw border with prejowl support, so the lower third reads more balanced and defined and tapers gently toward a refined oval, keeping the chin width natural',
    moderate: 'a visible lower-face refinement treating chin and jawline as one unit: forward chin projection and vertical support plus a smoother, more continuous jaw border with prejowl support, so the lower third reads distinctly stronger, more balanced, and more defined, tapering toward a refined oval, keeping the chin width natural',
    enhanced: 'a strong, clearly visible lower-face refinement treating chin and jawline as one unit, as an experienced injector would place it: clear forward chin projection and vertical support plus a crisp, continuous jaw border with prejowl support, so the lower third reads noticeably stronger, balanced, and defined and tapers toward a refined oval, keeping the chin width natural and never over-narrowed into a hard, pointed V'
  },
  male: {
    conservative: 'a clearly visible lower-face refinement on a male face treating chin and jawline as one unit: more forward projection at the chin with the chin kept wide and squared, plus a cleaner, more continuous jaw border with prejowl support, so the lower third reads stronger and better defined. Keep the chin and jaw wide, never tapered, pointed, or feminine',
    moderate: 'a visible lower-face refinement on a male face treating chin and jawline as one unit: forward chin projection with a wide, squared chin, plus a smoother, more continuous jaw border with prejowl support, so the lower third reads distinctly stronger and structurally defined. Keep the full jaw width, never tapered, pointed, or feminine',
    enhanced: 'a strong, clearly visible lower-face refinement on a male face treating chin and jawline as one unit, as an experienced injector would place it: clear forward projection with a wide, squared chin, plus a crisp, continuous jaw border with prejowl support, so the lower third reads noticeably stronger and structurally defined. Keep the full jaw width and squared chin, never tapered, pointed, feminine, or a superhero jaw'
  }
};

// Layer 3: the single universal preservation block. Everything not in the
// treatment area is locked here, once. This is the ONLY preservation text; the
// worker appends no tail for filler (see generate-visualization-background.js).
const FILLER_PRESERVE =
  'Everything outside the treated area must remain exactly as photographed. ' +
  'Preserve the patient\'s identity, age, skin texture, pores, wrinkles, pigmentation, expression, facial proportions, hairstyle, clothing, camera angle, lighting, and background unchanged. ' +
  'The result must read as the same clinical photograph, not a beauty filter or glamour retouch, and must not smooth skin, reduce apparent age, or beautify any untreated feature.';

// Overfilled education anchor: intentionally overcorrected lower face, shown so a
// patient sees why more is not better. Kept from the legacy path (its exaggerated
// magnitude is the point). Only fires for the chin+jawline unit at 'overfilled'.
const FILLER_OUTCOME_OVERFILLED =
  'an intentionally OVERCORRECTED lower-face filler result, treating chin and jawline as one unit, to demonstrate why excessive filler looks unnatural: too much chin projection and an over-sharp, shelf-like jaw that reads clearly overdone, the kind of result no experienced injector would want. Make the overcorrection obvious while keeping it the same person';

function buildFillerPrompt(sel){
  const areas = sel.areas;
  const tier = (sel.intensity === 'enhanced' || sel.intensity === 'moderate' || sel.intensity === 'conservative')
    ? sel.intensity : 'moderate';
  const isChinJawUnit = areas.includes('chin') && areas.includes('jawline');

  const LEAD = NO_TEXT_RULE + ' ' + FILLER_SINGLE_IMAGE + ' ' +
    'Simulate the expected result of a hyaluronic acid filler treatment performed by an experienced aesthetic injector. Create ';

  // Overfilled education anchor (chin+jawline unit only).
  if (sel.intensity === 'overfilled' && isChinJawUnit) {
    return LEAD + FILLER_OUTCOME_OVERFILLED + '. ' + FILLER_PRESERVE;
  }

  let outcome;
  if (isChinJawUnit) {
    const branch = (sel.sex === 'male') ? FILLER_OUTCOME_CHINJAW.male : FILLER_OUTCOME_CHINJAW.female;
    outcome = branch[tier];
    // Any additional areas selected alongside the unit append as their own clause.
    const extra = areas.filter(a => a !== 'chin' && a !== 'jawline' && FILLER_OUTCOME[a]);
    if (extra.length) {
      outcome += '; and ' + extra.map(a => FILLER_OUTCOME[a][tier]).join('; and ');
    }
  } else {
    const clauses = areas.map(a => FILLER_OUTCOME[a] && FILLER_OUTCOME[a][tier]).filter(Boolean);
    if (!clauses.length) return null;
    outcome = clauses.join('; and ');
  }

  return LEAD + outcome + '. ' + FILLER_PRESERVE;
}

function buildCorePrompt(sel) {
  const sel_ = sel || {};
  const note = sanitizeNote(sel_.note);

  if (sel_.type === 'laser') {
    return buildLaserPrompt(sel_);
  }

  if (sel_.type === 'tox') {
    return buildToxPrompt(sel_);
  }

  if (sel_.type === 'biostim') {
    const product = BIOSTIM[sel_.product] ? sel_.product : 'sculptra';
    const m = BIOSTIM[product];
    const tp = TIMELINE[sel_.timeline] || TIMELINE['6'];

    // Sculptra v10.1: structured clinical phenotype + view-aware builder. This
    // supersedes the v9/v9.1 frontal and v10 oblique sculptra prompt paths (their
    // text remains in the constants/BIOSTIM for reference but is no longer used
    // for sculptra). Phenotype and view come from structured fields or explicit
    // [view:...] / [phenotype:...] tags in the note (test hook).
    if (product === 'sculptra') {
      return buildSculptraPrompt(sel_, m, tp);
    }

    // Hyperdilute CaHA / Radiesse: dedicated firmness + skin-quality module
    // (distinct visual language from Sculptra's soft-volume re-inflation).
    if (product === 'hdr') {
      return buildHdrPrompt(sel_, tp);
    }

    // Any other/legacy biostim product falls back to the string-expected path.
    let expected, mag;
    if (m.expected && typeof m.expected === 'object') {
      expected = m.expected[sel_.projection] || m.expected.expected;
      mag = '';
    } else {
      expected = m.expected;
      mag = ' ' + (PROJECTION[sel_.projection] || PROJECTION.expected);
    }
    return `${BASE_FRAMING} Make ONLY this change: ${expected}. Avoid: ${m.avoid}. ${tp}${mag}${note}`;
  }

  // default: filler
  let areas = Array.isArray(sel_.areas) ? sel_.areas : String(sel_.areas || '').split(',');
  areas = areas.map(a => a.trim()).filter(a => FILLER_AREAS[a]);
  if (!areas.length) areas = ['chin'];

  // M16: HA filler uses the clean rewrite (buildFillerPrompt) by default. It is
  // self-contained -- it carries its own complete preservation block, so the
  // worker appends NO safety tail for filler (see generate-visualization-background.js,
  // where filler tail is now ''). Kill-switch MINIMAL_FILLER_OFF=true drops to the
  // legacy assembly below for staging A/B (the legacy path still expects the
  // worker's SERVER_SAFETY/CHIN_JAW_SAFETY tail, so the worker keys the tail off
  // the same env var).
  const minimalFillerOff = (typeof process !== 'undefined' && process.env && process.env.MINIMAL_FILLER_OFF === 'true');
  if (!minimalFillerOff) {
    const fp = buildFillerPrompt({ areas, intensity: sel_.intensity, sex: sel_.sex });
    if (fp) return fp + (note || '');
  }

  // ===== LEGACY FILLER ASSEMBLY (kill-switch only: MINIMAL_FILLER_OFF=true) =====
  // Retained for staging A/B against M16. Expects the worker to append
  // SERVER_SAFETY (or CHIN_JAW_SAFETY for the chin+jawline unit) as the tail.
  if (sel_.intensity === 'overfilled' && areas.includes('chin') && areas.includes('jawline')) {
    const ov = FILLER_CHIN_JAWLINE_OVERFILLED;
    return `${BASE_FRAMING} ${ov.core} Avoid: ${ov.avoid}`;
  }

  const intensityKey = sel_.intensity || 'natural';
  let expected, avoid;
  if (areas.includes('chin') && areas.includes('jawline')) {
    const isMale = sel_.sex === 'male';
    const cjPrompt = isMale ? FILLER_CHIN_JAWLINE_MALE : FILLER_CHIN_JAWLINE_FEMALE;
    expected = cjPrompt.expected;
    avoid = cjPrompt.avoid;
    const extra = areas.filter(a => a !== 'chin' && a !== 'jawline');
    if (extra.length) {
      expected += '; ' + extra.map(a => fillerAreaExpected(a, intensityKey)).join('; ');
      avoid += '; ' + extra.map(a => FILLER_AREAS[a].avoid).join('; ');
    }
  } else {
    expected = areas.map(a => fillerAreaExpected(a, intensityKey)).join('; ');
    avoid = areas.map(a => FILLER_AREAS[a].avoid).join('; ');
  }

  const goal = GOALS[sel_.goal] || GOALS.natural_refinement;
  const mag = INTENSITY[sel_.intensity] || INTENSITY.natural;

  const isOblique = (sel_.view === 'oblique_left' || sel_.view === 'oblique_right' || sel_.view === 'oblique');
  const chinJawFraming = isOblique ? CHIN_JAW_OBLIQUE_FRAMING : BASE_FRAMING;

  const areaAllowlist = (areas.length === 1 && HA_FILLER_AREA_ALLOWLISTS[areas[0]])
    ? HA_FILLER_AREA_ALLOWLISTS[areas[0]] + ' '
    : '';
  return `${HA_FILLER_FAMILY_RULE} ${areaAllowlist}${chinJawFraming} ${mag} Make ONLY this change: add hyaluronic acid filler to achieve ${expected}. ` +
         `Avoid: ${avoid}. ${goal} ` +
         `Judge the result by facial contour alone: the added projection and support must be visible in the silhouette, while skin appearance stays exactly as photographed.${note}`;
}

// ---- Chin/jawline safety base (v7) -----------------------------------------
// M7.5: chin/jawline filler drops the generic SERVER_SAFETY tail the same way
// Sculptra did in M4. The generic tail says "do NOT slim the face or jaw" and
// "the result must read as the SAME photograph with only the treated area
// subtly adjusted", which directly contradicts the v6/v7 chin_jawline content
// (inward taper, jowl reduction, decisive projection) and caps the anchor at a
// conservative magnitude; on this model the prohibition voice wins, which is why
// oblique chin/jaw anchors came out timid. This base keeps every protection the
// generic tail provides (skin texture, identity, framing, no beautification)
// while making the lower-face contour change explicitly IN-SCOPE.
// M12: Oblique-specific framing for chin/jaw filler.
// At oblique angles gpt-image-1 rebuilds the whole face the same way it does
// for Sculptra. The fix is identical: lead with a preservation-first brief
// that tells the model this is a minimal local contour edit, not a makeover.
const CHIN_JAW_OBLIQUE_FRAMING =
  'Produce a minimal, medically conservative chin and jawline filler visualization ' +
  'from this three-quarter (oblique) consultation photograph, ' +
  'staying as close to the original photograph as possible. ' +
  'This is a local lower-face contour adjustment ONLY. ' +
  'Do not rebuild, repaint, re-render, or relight the face. ' +
  'The ONLY permitted change is lower-face contour: chin projection and jawline definition. ' +
  'Everything above the lower face -- cheeks, midface, eyes, brows, skin, nose, forehead -- stays pixel-identical to the original. ' +
  'Keep the exact three-quarter head angle, orientation, crop, and perspective unchanged.';
const CHIN_JAW_SAFETY =
  " CRITICAL: this is a medical consultation photograph, not a beauty image. The ONLY region that changes is the chin, jawline, and lower-face contour described above; every other pixel stays faithful to the original. " +
  "Do NOT smooth or retouch skin anywhere, remove or soften wrinkles, even out skin tone, brighten the image, raise contrast, enlarge the eyes, lift the brows, or apply any beautifying, younger-looking, or filter-like effect. " +
  "Keep ALL skin texture (pores, fine lines, blemishes) exactly as in the original, including on the treated lower face: the new contour carries the same real skin. " +
  "Do NOT change the eyes, brows, nose, lips, cheekbones, mid-face width, hairstyle, ears, clothing, jewellery, expression, head angle and pose, camera framing and crop, lighting, or background. " +
  "The chin projection and jawline definition must be visible as a real structural change in the lower-face contour at the specified magnitude. Show the change clearly in the silhouette and shadow architecture of the lower face. " +
  "Preserve identity, ethnicity and ethnic features, and apparent age; the result must be unmistakably the same person with only the lower-face contour treated. Do not add text, labels, or watermarks.";

// True when the request is the chin+jawline lower-face unit (the client posts
// chin_jawline expanded to 'chin,jawline'). Used by the Netlify functions to
// pick the safety tail; keep this predicate in lockstep with the
// FILLER_CHIN_JAWLINE selection logic in buildCorePrompt above.
function usesChinJawSafety(type, areasField){
  if(type !== 'filler') return false;
  const areas = (Array.isArray(areasField) ? areasField : String(areasField || '').split(','))
    .map(a => a.trim());
  return areas.includes('chin') && areas.includes('jawline');
}

// ---- M12.2 / M12.6: Scenario Exploration prompts ---------------------------------
// Architecture (M12.6 rebuild): scenarios now generate from the ORIGINAL patient
// photo, not the Visualize baseline. The planner receives both images as context
// and writes a prompt describing the full combined treatment from scratch.
// The scenario result is then composited through the standard Sculptra/chin-jaw
// mask pipeline client-side, giving the same pixel-level identity lock the
// baseline enjoys. This produces cleaner one-pass results without the compositor
// degradation and identity drift that came from chaining two AI generations.
//
// Static prompts (used as planner fallback): rewritten for original-photo-first.
// The planner overrides these with case-specific prompts when enabled.

const SCENARIO_PROMPT_BASE =
  'This is an original medical consultation photograph. ' +
  'Simulate the result of the combined treatment plan described below as a single generation from this original photo. ' +
  'A Sculptra biostimulator baseline response has already been established for this patient as context. ' +
  'Show the full combined treatment result in one pass, starting from this original photo. ';

const SCENARIO_SAFETY =
  ' ABSOLUTE PROHIBITIONS: ' +
  'Do not smooth or retouch skin anywhere. Do not brighten, whiten, raise contrast, or apply any filter or beauty effect. ' +
  'Do not enlarge, open, or alter the eyes in any way. Do not raise, darken, or reshape the brows. ' +
  'Do not change lip size, shape, color, fullness, or border. Do not alter the nose, mouth, or expression. ' +
  'Do not change hairstyle, hair color, clothing, jewellery, head angle, camera crop, lighting, or background. ' +
  'Do not reduce apparent age or add any de-aging effect. ' +
  'Preserve identity, skin tone, ethnicity, and all ethnic features exactly as in the original photo. ' +
  'In treated structural zones only, natural shadow redistribution from volume change is permitted. ' +
  'The result must be unmistakably the same person. ' +
  'Do not add text, labels, watermarks, or annotations.';

// M12.7: Fixed proven base prompt for the stronger_sculptra scenario.
// Framed as "create a believable 6-month after-photo" not "stronger than baseline."
// The planner adds only a short patient-specific emphasis line at the end.
// Do not let the planner rewrite this prompt -- it overthinks and writes cautious
// clinical language that produces timid results.
const SCULPTRA_SCENARIO_BASE =
  'Create a realistic clinical-style after-photo simulating an upper-range 6-month Sculptra result. ' +
  'Use the original patient photo as the direct edit target. Keep the same head angle, head position, gaze direction, neutral expression, lighting, clothing, hair, background, and camera framing. ' +
  'This is a strong but believable collagen-stimulator response, not filler augmentation and not surgery. ' +
  'The improvement must be strong and unmistakable compared with the original photo, clearly more than a typical result. Show a strong, clearly visible restoration of the lateral facial scaffold: fill the temple hollows so the temples look convex and full, and rebuild lateral cheek and zygomatic volume so the lateral cheek soft tissue sits visibly higher and fuller on the cheekbone framework, with a brighter, more present, more continuous zygomatic-to-lateral-cheek highlight. ' +
  'Restore a clear, continuous temple-to-cheek transition and a supported lid-cheek junction. Fill the submalar hollow and smooth the cheek-to-jaw transition. Support the prejowl and lift the jowl so the lower face reads distinctly cleaner, tighter, and better suspended and the jawline is more defined. ' +
  'The dominant, unmistakable change is this lateral midface lift: the face should look clearly fuller and lifted from the sides, with a smooth continuous contour from temple to cheek to jawline. The result should read as a real upper-range Sculptra responder after several months: strong collagen support, better suspension, and softer shadows, obviously stronger than a typical result while still natural and not overfilled. ' +
  'Preserve identity exactly. Do not change ethnicity, eye shape, nose, lips, hairstyle, clothing, background, pose, or expression. Do not add makeup. Do not create a beauty-filter look. Preserve natural skin texture, pores, pigmentation, and lighting. Avoid global skin smoothing, brightening, face slimming, teeth changes, or unrelated beautification. ' +
  'The result should look like the same patient photographed in the same setup, only with a clearly visible upper-range 6-month Sculptra improvement.' +
  BIOSTIM_NEGATIVE_GUARDRAIL;

// Lip-specific safety block. Unlike SCENARIO_SAFETY (which locks the lips),
// this EXPLICITLY permits lip volume/shape/border enhancement within the lips,
// while still forbidding lip color/gloss/makeup/teeth and every other region.
// Used only by add_lips_filler.
const LIP_SAFETY =
  ' ABSOLUTE PROHIBITIONS: ' +
  'Lip volume, fullness, shape, and vermilion border MAY be enhanced -- but only within the lips themselves. ' +
  'Do not change lip color. Do not add gloss, shine, lipstick, or any makeup. Do not whiten, change, or reveal more teeth. ' +
  'Do not change the mouth width or the expression. ' +
  'Do not smooth or retouch skin anywhere. Do not brighten, whiten, raise contrast, or apply any filter or beauty effect. ' +
  'Do not enlarge, open, or alter the eyes in any way. Do not raise, darken, or reshape the brows. ' +
  'Do not alter the nose, chin, jaw, or cheeks. ' +
  'Do not change hairstyle, hair color, clothing, jewellery, head angle, camera crop, lighting, or background. ' +
  'Do not reduce apparent age or add any de-aging effect. ' +
  'Preserve identity, skin tone, ethnicity, and all ethnic features exactly as in the original photo. ' +
  'The result must be unmistakably the same person. ' +
  'Do not add text, labels, watermarks, or annotations.';

const SCENARIO_PROMPTS = {

  stronger_sculptra: {
    label: 'Stronger Sculptra response',
    description: 'Upper-range 6-month collagen response',
    // M12.7: uses fixed proven base prompt. Planner adds patient-specific line only.
    // NO_TEXT_RULE is prepended by buildScenarioPrompt(), so not included here.
    prompt: SCULPTRA_SCENARIO_BASE
  },

  add_chin_jaw_filler: {
    label: 'Add chin + jawline filler',
    description: 'Sculptra baseline + 2 syringes HA chin/jaw filler',
    prompt: SCENARIO_PROMPT_BASE +
      'Treatment to simulate: Sculptra biostimulator (baseline level) PLUS 2 syringes HA filler to the chin and jawline. ' +
      'Show: the expected Sculptra lateral scaffold support AND a clearly visible lower-face structural change: ' +
      'more chin projection and vertical chin height; clean, continuous mandibular border definition; prejowl support. ' +
      'For a female patient: the lower third reads more refined and oval, the chin elongates forward, the face tapers gently. ' +
      'For a male patient: the chin is wider and squared at the mentum, the mandibular border is structural and defined. ' +
      'The lower-face change must be visible in the silhouette and shadow architecture. ' +
      'Do not change the midface, cheekbones, upper face, eyes, or brows.' +
      SCENARIO_SAFETY
  },

  add_chin_filler: {
    label: 'Add chin filler',
    description: 'Sculptra baseline + HA chin filler (chin only)',
    prompt: SCENARIO_PROMPT_BASE +
      'Treatment to simulate: Sculptra biostimulator (baseline level) PLUS HA filler to the chin ONLY. ' +
      'Show: the expected Sculptra lateral scaffold support AND a chin-only change: ' +
      'gently bring the chin point forward and, where appropriate, slightly lower so the lower third reads stronger and better balanced, keeping the chin width natural. ' +
      'For a female patient: the chin elongates forward and the lower third reads more balanced. ' +
      'For a male patient: the chin is wider and squared at the mentum, never tapered or pointed. ' +
      'This is chin filler only: do NOT add lateral jawline definition, do NOT sharpen, square, or carve the mandibular border, and do NOT change the gonial angle or jaw width. ' +
      'Do not change the midface, cheekbones, upper face, eyes, or brows.' +
      SCENARIO_SAFETY
  },

  add_jawline_filler: {
    label: 'Add jawline filler',
    description: 'Sculptra baseline + HA jawline filler (jawline only)',
    prompt: SCENARIO_PROMPT_BASE +
      'Treatment to simulate: Sculptra biostimulator (baseline level) PLUS HA filler to the jawline ONLY. ' +
      'Show: the expected Sculptra lateral scaffold support AND a jawline-only change: ' +
      'a smoother, more continuous mandibular border from the chin body back toward the gonial angle, with the prejowl hollow softened where present, so the jaw line reads more defined. ' +
      'This is jawline filler only: do NOT add chin projection, do NOT lengthen, lower, or strengthen the chin point, and do NOT change the pogonion position or the chin-to-lip distance. ' +
      'Do not change the midface, cheekbones, upper face, eyes, or brows.' +
      SCENARIO_SAFETY
  },

  add_temple_support: {
    label: 'Add temple support',
    description: 'Sculptra baseline + focused temple volume',
    prompt: SCENARIO_PROMPT_BASE +
      'Treatment to simulate: Sculptra biostimulator (baseline level) PLUS focused HA or Sculptra volume to the temples. ' +
      'Show: the expected Sculptra lateral scaffold AND improved temporal hollow fill: ' +
      'the temporal hollow fills in so the forehead-to-cheek transition reads as a more continuous convex surface; ' +
      'the upper lateral face reads as a smooth connected arc from the lateral brow tail down into the zygomatic arch. ' +
      'The temple change is strictly the temporal hollow and immediately adjacent tissue. ' +
      'Do not touch the midface, lower face, jawline, eyes, brows, or upper eyelid.' +
      SCENARIO_SAFETY
  },

  add_tear_trough: {
    label: 'Add under-eye (tear trough) support',
    description: 'Baseline + under-eye hollow correction',
    prompt: SCENARIO_PROMPT_BASE +
      'Treatment to simulate: the baseline collagen response PLUS hyaluronic acid correction of the under-eye (tear trough) hollow. ' +
      'Show: the under-eye hollow and tear trough groove softened so the lid-cheek junction reads as a smooth, continuous, well-supported transition. ' +
      'The dark shadow cast by the hollow is reduced because the depression is filled and supported from beneath, not because the skin is brightened or the dark circle is painted over. ' +
      'The change is strictly the tear trough and the immediately adjacent upper medial cheek that supports it. ' +
      'Keep it subtle and natural -- a refreshed, less tired appearance, never puffy, never over-filled, never a smooth featureless under-eye. ' +
      'Do not change the eye shape, eye size, eyelid, lashes, or iris. Do not brighten or erase pigmentation. Do not touch the lower face, jawline, lips, nose, or brows.' +
      SCENARIO_SAFETY
  },

  add_nose_filler: {
    label: 'Add nose filler',
    description: 'Baseline + liquid rhinoplasty (nasal HA filler)',
    prompt: SCENARIO_PROMPT_BASE +
      'Treatment to simulate: the Sculptra baseline PLUS hyaluronic acid filler to the nose (liquid rhinoplasty). ' +
      'Show: a subtle, natural-looking nasal refinement consistent with a skilled injector. ' +
      'The specific change depends on what this nose needs: smooth a dorsal hump so the nasal profile reads straighter; ' +
      'or gently refine and lift the nasal tip so the tip reads slightly more defined and the nasolabial angle looks improved; ' +
      'or improve subtle asymmetry where visible. Do only what this specific nose needs -- do not apply all changes if only one is indicated. ' +
      'The change must be subtle: a perceptible refinement, never a dramatic reshape, never a surgical result. ' +
      'The nose must still look like the same nose, only slightly more refined. ' +
      'Do not narrow the nostrils, do not shorten or lengthen the nose, do not change the nose width from the front, ' +
      'do not change the skin texture of the nose. ' +
      'Do not touch the lips, chin, jawline, eyes, cheeks, or any other area.' +
      ' ABSOLUTE PROHIBITIONS: ' +
      'Do not smooth or retouch skin anywhere. Do not brighten, whiten, raise contrast, or apply any filter or beauty effect. ' +
      'Do not enlarge, open, or alter the eyes in any way. Do not raise, darken, or reshape the brows. ' +
      'Do not change lip size, shape, color, fullness, or border. ' +
      'Do not change hairstyle, hair color, clothing, jewellery, head angle, camera crop, lighting, or background. ' +
      'Do not reduce apparent age or add any de-aging effect. ' +
      'Preserve identity, skin tone, ethnicity, and all ethnic features exactly as in the original photo. ' +
      'The result must be unmistakably the same person. ' +
      'Do not add text, labels, watermarks, or annotations.'
  },

  add_lips_filler: {
    label: 'Add lip filler',
    description: 'Baseline + natural lip volume enhancement',
    prompt: SCENARIO_PROMPT_BASE +
      'Treatment to simulate: the baseline PLUS hyaluronic acid lip filler. ' +
      'This is a lip augmentation: the lips MUST end up clearly fuller than in the original photo, while still natural and tasteful. ' +
      'Show a visible, believable increase in lip volume and projection. Both the upper and lower lip are fuller and better defined, ' +
      'the vermilion border reads more defined, and the lips look hydrated and healthy. ' +
      'Keep a natural upper-to-lower proportion (the lower lip stays slightly fuller than the upper), keep the cupid\'s bow shape and position, ' +
      'and keep the mouth width unchanged. The result is a refined, natural lip enhancement -- never duck-shaped, shelf-like, everted, or over-filled, ' +
      'but the increase in fullness must be plainly visible when compared to the original.' +
      LIP_SAFETY
  },

  combination_plan: {
    label: 'Full combination plan',
    description: 'Sculptra + chin/jaw filler + temple support',
    prompt: SCENARIO_PROMPT_BASE +
      'Treatment to simulate: a full multi-modality combination plan -- ' +
      'Sculptra biostimulator at strong lateral scaffold level, PLUS HA chin and jawline filler, PLUS temple volume support. ' +
      'Show all three simultaneously as a single coherent result: ' +
      '(1) Strong lateral cheek and temple support: fuller lateral cheek convexity, more continuous temple-to-cheek arc, cleaner jowl suspension. ' +
      '(2) Chin and jawline filler: clearly more chin projection and height, clean mandibular border, prejowl support. ' +
      'For female: tapered oval lower third. For male: wide squared mentum and structural jaw border. ' +
      '(3) Temple volume: temporal hollow filled, forehead-to-cheek arc more continuous. ' +
      'All three must read as one integrated clinical result: same person, comprehensively supported, not operated on. ' +
      'Each change is localized to its anatomical zone. Skin, eyes, lips, nose, hair, lighting, expression are locked.' +
      SCENARIO_SAFETY
  }
};

// Build a complete scenario prompt for a given scenario key and view.
// Used as the static fallback when the planner is disabled or fails.
// NO_TEXT_RULE is prepended first (same pattern as buildSculptraPrompt).
// M14: CROSS-TYPE ADD-ON SCENARIOS.
// Used when the baseline is a HA filler or RF/HIFU result (not Sculptra). Unlike
// the Sculptra scenarios -- which edit the ORIGINAL photo and re-describe the whole
// plan via the (Sculptra-locked) planner -- these edit the BASELINE image directly,
// adding ONE area on top of what is already shown so add-ons stack correctly.
// No planner, gpt-image-2 direct.
// M16: SCENARIO ADD-ON PROMPTS -- CLEAN REWRITE.
// Same philosophy as the primary filler path (buildFillerPrompt): describe the
// clinical outcome, keep it short, carry ONE preservation block. The only
// structural difference from the primary path is that these edit an ALREADY-
// TREATED baseline, so the preservation block preserves the existing result too
// (not just identity), and the lead frames the image as mid-plan so the model
// adds rather than restarts. Clinical ceilings are retained verbatim in intent:
// energy devices (RF/HIFU/stronger_laser) tighten, never add volume, never
// de-age; neurotoxin slims muscle / refines contour, never adds volume; nose
// carries the anti-European-nose constraint for the TW/HK caseload.
// The dropped legacy scaffolding: per-scenario addonSafety() blocks, the
// "FAILED edit" framing, and the long ABSOLUTE PROHIBITIONS lists.

// Shared stacking lead: names the mid-plan context in one sentence.
const ADDON_LEAD =
  'This image shows a patient part-way through a multi-step aesthetic treatment plan; the earlier steps are already visible. The plan is not finished. Add the next step below as one natural, integrated result. Create ';

// Shared preservation block for add-ons: keeps the EXISTING result plus identity.
const ADDON_PRESERVE =
  'Keep every improvement already visible in this photo fully intact; do not reduce, undo, or reinterpret it. ' +
  'Everything outside the treated area must remain exactly as photographed: preserve the patient\'s identity, age, skin texture, pores, wrinkles, pigmentation, expression, hair, clothing, camera angle, lighting, and background unchanged. ' +
  'The result must read as the same clinical photograph with the prior result intact plus this one added step, never a beauty filter, and must not smooth skin, de-age, or beautify any untreated feature.';

const CROSS_ADDON_PROMPTS = {
  // Sculptra intensification: builds on the response shown, never shows less.
  stronger_sculptra:
    ADDON_LEAD +
    'a clearly stronger biostimulator (collagen-stimulator) response than the one already visible: more broad, soft, three-dimensional lateral support across the temples, lateral cheeks, preauricular and submalar area, lower cheek, and prejowl region, so the face reads visibly better lifted and more laterally supported than it does now, with stronger lateral cheek highlight and a cleaner jowl. The direction is lift and lateral support, a soft diffuse collagen response, never central or filler-like fullness and never rounding or widening the face centrally. ' +
    ADDON_PRESERVE,
  combination_plan:
    ADDON_LEAD +
    'a full combination result on top of the biostimulator response already visible: clear chin and jawline HA filler (more forward chin projection and vertical height, a clean continuous jaw border with prejowl support; for a female patient the lower third tapers toward a refined oval, for a male patient the chin stays wide and squared) plus focused temple support so the forehead-to-cheek transition reads continuous. The existing lateral response stays fully intact beneath these additions, read as one integrated result. ' +
    ADDON_PRESERVE,
  add_chin_jaw_filler:
    ADDON_LEAD +
    'a clearly visible chin and jawline HA filler result, about 2 syringes, added on top of what is already shown: more forward chin projection with vertical height plus a clean continuous jaw border from chin to angle with prejowl support, so the lower-face contour reads distinctly stronger and better defined in the silhouette, natural and structural rather than surgical. ' +
    ADDON_PRESERVE,
  add_chin_filler:
    ADDON_LEAD +
    'a clearly visible chin-only HA filler result added on top of what is already shown: the chin point moves distinctly forward, and slightly lower where appropriate, so the profile reads stronger and better balanced, keeping the chin width natural. This is chin filler only: do not add jawline definition or change the jaw width. ' +
    ADDON_PRESERVE,
  add_jawline_filler:
    ADDON_LEAD +
    'a clearly visible jawline-only HA filler result added on top of what is already shown: a smoother, more continuous, better-defined lower jaw border from the chin toward the angle, with the prejowl hollow softened, so the lower-face contour reads distinctly cleaner. This is jawline filler only: do not add chin projection or change the chin position. ' +
    ADDON_PRESERVE,
  add_cheek_filler:
    ADDON_LEAD +
    'a clearly visible cheek (midface) HA filler result added on top of what is already shown: restored support at the cheek so the curve from lower lid to cheek reads distinctly fuller and better supported, with a natural apex and a smooth transition into the midface, never over-projected or pillowed. ' +
    ADDON_PRESERVE,
  add_temple_support:
    ADDON_LEAD +
    'a clearly visible temple result added on top of what is already shown: support filling the hollow at the temple so the transition from forehead to cheek reads as a distinctly continuous convex surface and the upper outer face reads as a smooth connected curve, natural and not over-filled. ' +
    ADDON_PRESERVE,
  add_tear_trough:
    ADDON_LEAD +
    'a clearly visible under-eye result added on top of what is already shown: support beneath the under-eye hollow so the lid-cheek junction reads distinctly smoother and the shadow softens because the hollow is filled from beneath, not because the skin is brightened. Subtle and natural, never puffy or over-filled; do not change eye shape, size, eyelid, lashes, or iris, and do not brighten or retouch the skin. ' +
    ADDON_PRESERVE,
  add_nasolabial_filler:
    ADDON_LEAD +
    'a clearly visible improvement of the nasolabial fold added on top of what is already shown, achieved by restoring deep structural support beside the nose (at the pyriform aperture and adjacent deep medial cheek): the fold reads distinctly softer and less shadowed and the cheek-to-nose transition improves, so the midface looks better supported, without the face looking fuller or overfilled. Reduce the depth of the fold by restoring underlying support, never by smoothing skin texture or removing normal facial lines; preserve natural facial movement and expression. ' +
    ADDON_PRESERVE,
  add_nose_filler:
    ADDON_LEAD +
    'a clearly visible non-surgical nose HA filler result (liquid rhinoplasty) added on top of what is already shown: a distinctly straighter, smoother side profile, a higher but natural bridge with clear radix (top-of-bridge) support, and improved tip projection and support, staying believable for HA filler and never surgical. On oblique and side views the raised, straighter bridge must be clearly visible; from the front the bridge should read more defined with a clearer, continuous dorsal light reflection down its center, more refined but not taller and not narrower. Keep the nose width from the front unchanged, keep the result soft and appropriate for this face, and do not narrow the nose or create a high, narrow, surgical, or European-style nose. ' +
    ADDON_PRESERVE,
  add_lips_filler:
    ADDON_LEAD +
    'a substantial, clearly visible lip HA filler result, about 2 mL, added on top of what is already shown: noticeably build the body of both the upper and lower lip with strong vermilion show, clear anterior projection, a well-defined central tubercle, and a crisp vermilion border, so the lips read distinctly fuller, hydrated, and structurally supported. Keep natural upper-to-lower proportion, the Cupid\'s bow, and the same mouth width, never overfilled, everted, or duck-shaped. ' +
    ADDON_PRESERVE,
  add_biostim_lift:
    ADDON_LEAD +
    'a clearly visible biostimulator lateral-lift result added on top of what is already shown: broader, softer collagen-based support across the lateral cheek and temple so the midface reads distinctly lifted and the jawline cleaner, a diffuse soft-tissue improvement under the skin, not filler fullness and not shadow sculpting. Keep it soft, gradual, and three-dimensional, and do not deepen or darken any facial shadow. ' +
    ADDON_PRESERVE,
  // Energy devices: clinical ceiling retained. Tighten, never add volume, stay
  // below filler/biostim, never de-age.
  add_rf:
    ADDON_LEAD +
    'a modest radiofrequency (RF) skin-tightening result added on top of the existing result: the skin envelope of the lower face and jawline reads a little firmer, smoother, and more taut and the jaw line a little cleaner. This is energy-based tightening, NOT volume: do not add, restore, or re-inflate any volume, do not plump or round the face, and do not change the existing result. Keep the change subtle and clearly below what filler or a biostimulator can do, and do not de-age the patient or erase wrinkles, texture, or pigmentation. ' +
    ADDON_PRESERVE,
  add_hifu:
    ADDON_LEAD +
    'a modest HIFU (focused ultrasound) lifting result added on top of the existing result: a subtle lift and tightening of the lower face and jawline, with a slightly crisper mandibular line and a cleaner transition into the neck. This is energy-based lifting and tightening, NOT volume: do not add, restore, or re-inflate any volume, do not plump or round the face, and do not change the existing result. Keep the change subtle and clearly below what filler or a biostimulator can do, and do not de-age the patient or erase wrinkles, texture, or pigmentation. ' +
    ADDON_PRESERVE,
  // Neurotoxin: clinical ceiling retained. Muscle/contour, never volume.
  add_masseter:
    ADDON_LEAD +
    'a neurotoxin masseter-slimming result added on top of the existing result: the masseter muscle at the back lateral lower face becomes slimmer, so the lower face reads narrower and softer and the cheek-to-jaw transition smoother, with less fullness at the jaw angle. This is muscle slimming from neurotoxin, NOT volume and NOT bone change: do not add filler volume, do not change the chin, do not carve the jawline bone, and do not change the existing result. Keep it subtle, natural, and symmetric. ' +
    ADDON_PRESERVE,
  add_nefertiti:
    ADDON_LEAD +
    'a neurotoxin Nefertiti-lift result added on top of the existing result: relaxing the downward pull along the jawline and upper neck so the jawline reads cleaner and slightly more lifted and the jaw-to-neck transition sharper. This is a neurotoxin contour refinement, NOT volume: do not add filler volume, do not change chin projection, do not carve the jaw bone, and do not change the existing result. Keep it subtle and natural. ' +
    ADDON_PRESERVE,
  // Energy intensification: clinical ceiling retained, strongest wording.
  stronger_laser:
    ADDON_LEAD +
    'a stronger energy-based skin-tightening result than the one already visible, representing an excellent biological responder over a full course, not a different or higher-energy treatment. Show MORE of the same lower-face tightening already present: a bit more firmness in the lower-face skin envelope and a slightly cleaner, more defined jawline and mandibular border, with a marginally sharper jaw-to-neck transition. The stronger result must increase ONLY the magnitude of the tissue tightening already visible and must not introduce any new kind of change. ' +
    'Critically, "stronger" here means more contour tightening ONLY, never any skin-surface change: do NOT smooth, resurface, brighten, even out, blur, or retouch the skin, and never let a stronger setting introduce a processed, mottled, blotchy, waxy, or beauty-filter texture. If there is any tension between showing more effect and protecting skin texture, protect the skin texture. ' +
    'This is still an energy-device result and must stay clearly below what filler or a biostimulator can do: do not add any cheek or midface fullness, do not re-inflate, plump, or round the face, do not restore lost volume, do not reduce facial width or slim the face, and do not produce a facelift. Energy-based treatment improves tissue quality and support but does not replace the structural restoration achieved with injectables. ' +
    'Do not de-age the patient: deep static wrinkles, perioral lines, crow\'s feet, forehead lines, under-eye laxity, skin texture, and pigmentation must remain substantially present. Do not modify any untreated facial region. ' +
    ADDON_PRESERVE
};

function buildScenarioPrompt(scenarioKey, view, baselineType) {
  // M15: ALL known baseline types now use the incremental add-on prompts, which
  // edit the already-treated baseline image directly so add-ons stack on top of
  // the result already shown. This includes Sculptra ('biostim'), which
  // previously re-generated from the original photo and could land visibly
  // worse than the baseline it claimed to build on.
  // The legacy SCENARIO_PROMPTS path below is kept ONLY for backward
  // compatibility with jobs that arrive without a baselineType.
  const isCrossType = baselineType === 'filler' || baselineType === 'laser' ||
                      baselineType === 'tox'    || baselineType === 'biostim';
  if (isCrossType) {
    const cp = CROSS_ADDON_PROMPTS[scenarioKey];
    if (!cp) throw new Error('Unknown cross-type scenario key: ' + scenarioKey);
    const isOblique = (view === 'oblique_left' || view === 'oblique_right' || view === 'oblique' ||
                       view === 'l45' || view === 'r45');
    // Oblique insurance: on three-quarter views the model tends to "resolve" the
    // busier, more-shadowed side (deeper lid-cheek junction, tear-trough shadow,
    // more visible laxity) by rebuilding its skin, which reads as degraded or
    // over-smoothed texture relative to the original on that side. This lock fires
    // only on obliques and forbids that, independent of the general skin lock in
    // addonSafety, so the harder oblique side keeps its true texture.
    const viewLead = isOblique
      ? 'IMPORTANT: this is a three-quarter (oblique) photograph. Preserve the exact head angle, crop, perspective, and facial orientation. Do not rotate the face toward frontal. ' +
        'Oblique skin-texture lock: at this angle, do NOT rebuild, repaint, smooth, even out, or re-render the skin on the more-shadowed or more-complex side of the face (the lid-cheek junction, tear-trough, under-eye, and lateral cheek). Keep pores, fine lines, surface texture, pigment, freckles, and natural shadow on BOTH sides exactly as in the original photograph; the treated result must not show smoother, cleaner, or more uniform skin texture on one oblique side than the other. Any permitted change is soft-tissue contour or support only, never a change in skin surface texture. '
      : '';
    return NO_TEXT_RULE + ' ' + viewLead + cp;
  }

  const s = SCENARIO_PROMPTS[scenarioKey];
  if (!s) throw new Error('Unknown scenario key: ' + scenarioKey);

  const isOblique = (view === 'oblique_left' || view === 'oblique_right' || view === 'oblique' ||
                     view === 'l45' || view === 'r45');

  // stronger_sculptra needs an oblique lead that preserves pose WITHOUT saying
  // "minimum change" -- that phrasing suppresses the Sculptra magnitude we want.
  // Other scenarios keep the conservative minimum-change lead.
  let viewLead = '';
  if (isOblique) {
    if (scenarioKey === 'stronger_sculptra') {
      viewLead = 'IMPORTANT: this is a three-quarter oblique consultation photograph. ' +
        'Preserve the exact head angle, crop, perspective, and facial orientation. ' +
        'Do not rotate the face toward frontal. ' +
        'Keep identity, lighting, hair, expression, and background unchanged. ';
    } else {
      viewLead = 'IMPORTANT: this is a three-quarter (oblique) consultation photograph. ' +
        'Preserve the exact head angle, crop, perspective, and facial orientation exactly. ' +
        'Do not rotate the face toward frontal. Do not rebuild, repaint, or re-render the face. ' +
        'Make the minimum change consistent with the treatment plan below. ';
    }
  }

  return NO_TEXT_RULE + ' ' + viewLead + s.prompt;
}

module.exports = { buildCorePrompt, VERSIONS, CHIN_JAW_SAFETY, usesChinJawSafety, FILLER_CHIN_JAWLINE_OVERFILLED, SCENARIO_PROMPTS, buildScenarioPrompt, BIOSTIM_NEGATIVE_GUARDRAIL };