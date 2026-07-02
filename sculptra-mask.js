// sculptra-mask.js
// Client-side generator for the Sculptra hybrid edit mask. Given the patient
// photo, it finds the face and returns a PNG whose TRANSPARENT pixels are the
// Sculptra treatment region (lateral temple, lateral cheek, prejowl/jawline,
// and the nasolabial/marionette fold tubes) and whose OPAQUE pixels are
// everything to protect (eyes, brows, nose, lips, central face, hairline, neck,
// background). gpt-image-1's edit endpoint edits only the transparent region, so
// this physically prevents the global beautification leak.
//
// M10.5 (v65): CALIBRATION PASS after v64 results review.
// Male chin: mSigC raised 0.115W -> 0.130W (tip still read slightly tapered).
// Male submental mask: centralExt closed fully to 0.0 (from 0.04). Artifacts
// appeared at early slider values, proving the mask was the source not the warp.
// Warp field alone handles male chin projection; the mask must not open the
// submental zone at all.
// Male SUBMENT_FLOOR_F: 0.06 -> 0.03 in both compositor functions.
// Sculptra oblique discolouration: SCULPTRA_BRIGHT_CAP_FULL 18 -> 12.
//
// M10.5 (v66): MALE CHIN TIP EXCLUDED FROM AI MASK.
// v70 (Jun 15 2026): REAL-WORLD RECALIBRATION.
// Target: documented clinical Sculptra outcomes used as benchmark.
// Seven coordinated changes, all reversible with one constant each:
// CHROMA_LOCK 1.0->0.82: partial release to allow Sculptra collagen glow.
//   The skin quality improvement (tone evenness, brightness) is a documented
//   clinical effect. Full lock was preventing it entirely.
// SCULP_LIFT_SAT 0.60->0.75: warp saturation ceiling raised. Real-world
//   jowl correction requires more border suspension than 0.60 allowed.
// SCULP_ZYGOMA_OUT 0.018->0.026: more lateral zygomatic projection.
// SCULP_MIDFACE_ANT 0.034->0.044: more anterior ogee push, softens NLF.
// SCULPTRA_BRIGHT_CAP_FULL 12->16: recovers skin brightness from v65 cut.
// SCULPTRA_DARK_FLOOR 12->16: more shadow depth for 3D jowl correction.
// SCULPTRA_GLOW_APPLY 6->9: more collagen glow in treated zone.
// SCULPTRA_DELTA_GAIN stays at 1.0 -- prior calibration confirmed raising
//   it above 1.0 produces waxiness, not more form. Magnitude comes from
//   geometry and chroma, not post-hoc gain.
//
// M10.5 (v69): DARK BLOB FIX -- removed wrong mag>8 gate on undershoot correction.
// The gate was blocking the dark-undershoot reconciliation in the transition band
// where chin shadow pixels land on the neck zone -- exactly the pixels producing
// the dark blob artifact. The undershoot condition (Yo - MARGIN - Yr > 0) is the
// correct discriminator: it only fires when the destination was brighter than the
// arriving pixel, which is specific to the shadow-on-neck failure mode. No mag
// gate needed. WARP_SHADE_DARK_PULL raised 0.40 -> 0.55 to match bright correction.
//
// M10.5 (v68): FOUR TARGETED FIXES based on batch review.
// (1) Outline gate menton floor corrected: v67 used p152.y + |faceH|*factor but
//     faceH is a dot-product projection underestimating actual pixel height at
//     oblique. v68 uses the actual lowest image-y coordinate among all face oval
//     landmarks + 1.5%W margin. Pose-invariant; fixes persistent blob on tilted
//     head oblique cases.
// (2) applyWarpShadeFix now two-sided: added dark-undershoot correction for chin
//     shadow pixels arriving too dark on the neck zone (the dark patch artifact).
//     Gated on moderate displacement (mag<=8) and destination being lighter than
//     source; WARP_SHADE_DARK_PULL=0.40 is conservative.
// (3) SCULPTRA_DARK_FLOOR 20->12: reduces dark discolouration patches in the
//     lateral lower-cheek zone on lighter-skinned patients at oblique view.
// (4) NLF anterior push kernel added to oblique Sculptra buildLiftField: pushes
//     near-side ala-to-commissure zone anteriorly to shallow the NLF shadow.
//     SCULP_NLF_ANT=0.016W. Reinforces the prompt-level NLF constraint with
//     deterministic geometry.
//
// M10.5 (v67): OUTLINE GATE HARDENING -- fixes white blob artifacts at chin on
// oblique views for all sexes. Root cause: MediaPipe's face oval overshoots the
// real jaw-neck boundary at oblique angles, and the luma gate passed chin-shadow
// pixels (luma 40-80) as "plausible face." Two fixes: (1) GATE_LOWER_PULL_IN
// raised 0.015->0.040 so the gate polygon hugs the actual jawline more tightly.
// (2) Hard menton floor added to buildOutlineGate: any pixel below p152.y +
// 0.04*|faceH| is zeroed regardless of luma. The warp handles everything below
// the menton; the AI has no legitimate reason to paint there. Also: warp shade
// reconciliation WARP_SHADE_MARGIN tightened 10->6 to close the frontal warp
// seam visible as a bright patch at the chin body.
// Root cause diagnosis: after v64 and v65 the chin tip still read feminine.
// Every prompt and mask-sigma approach fights the model's visual prior because
// gpt-image-1 has a strong aesthetic bias toward tapered lower faces (the female
// ideal) and applies it to any chin region it can see, regardless of text
// instruction. The only reliable architectural fix: remove the chin tip from the
// AI's editable region entirely for male. The chin tip shape is now pure warp
// geometry -- buildChinProjectionField displaces the patient's own pixels
// anteriorly, so the tip carries correct male anatomy by construction (original
// face). The AI sees only the jaw border tube and jowl lobes for shading/
// definition; it cannot taper what it cannot see. Female path unchanged.
// taperScale for male effectively zeroed in the pixel loop (isMale guard).
// Re-enables applyJawDefinition shadow step at oblique only, with
// oblique-specific constants (JAWDEF_DARK_OBLIQUE). The frontal retirement
// (v44: drawn-stroke artifact) stands; at 45 degrees the border is viewed
// edge-on so the shadow reads as genuine underside shadow, not a painted line.
// Also raises CHINW_WARP_SAT_OBLIQUE from 0.45 to 0.50: with shadow now
// anchoring the junction, the penumbra failure is partly a shading problem
// rather than a pure silhouette physics limit. One-constant reversal if it
// fails: set CHINW_WARP_SAT_OBLIQUE back to 0.45 and JAWDEF_DARK_OBLIQUE to 0.
//
// M10.4 (v57): OVERFILL COMPOSITOR PATH.
// opts.overfill = true disables the outline gate (buildOutlineGate) and the
// deterministic warp in both compositeSculptra and makeSculptraCompositor, so
// the AI's overcorrected silhouette is not clipped or geometry-corrected.
// Chroma lock and texture restore are retained (identity and skin character
// survive). Used exclusively for the HA chin/jawline Overfilled education
// anchor; all other paths are unaffected.
//
// M10.3 (v55): HA ENHANCED CORRECTION RE-ENABLED.
// FILLER_BETA_MAX raised 69->79 in visualize.html (opens the 70-79 band).
// CHINW_WARP_SAT raised 0.45->0.60 so the chin/jaw warp reaches Enhanced
// amplitude. Gated on M10.2 mandibular border (v54). Clinical acceptance:
// chin tip passes 300%+ zoom at both 45s; one-constant reversal if it fails.
// Mobile bar max label and snap stop updated to reflect Enhanced as new top.
//
// M10.3 (v56): OBLIQUE-SPECIFIC WARP SAT CAP.
// Frontal Enhanced passed 300%+ zoom; oblique Enhanced failed (chin tip
// penumbra stretch). Fix: CHINW_WARP_SAT_OBLIQUE = 0.45 holds the oblique
// warp at the proven Balanced ceiling while frontal keeps 0.60 (Enhanced).
// angleId passed through opts from visualize.html; compositor selects the
// correct cap per angle. FILLER_BETA_MAX stays at 79 -- users can still
// slide to Enhanced and the frontal export shows it; oblique silhouette
// just saturates at Balanced geometry, which is clean.
//
// M10.2 (v54): mandibular border suspension kernels. M10.2 closed.
//
// M10.1 (v49): lateral cut, anterior and superior raised.
//
// M10.1 (v48): calibration pass. SCULP_ZYGOMA_OUT 0.022->0.032,
// SCULP_MIDFACE_ANT 0.014->0.020.
//
// M10.1 (v47): SCULPTRA OBLIQUE CHEEK / MIDFACE PROJECTION KERNELS.
// The M6 lift warp was gated to frontal only; obliques received AI shading with
// no geometry change, so the zygomatic arch could not move forward in the 45
// degree view regardless of slider position. M10.1 adds an oblique branch inside
// buildLiftField that fires when detectPose returns three_quarter.
//
// Two kernel groups per oblique side:
//   (1) Zygoma projection: capsule kernel anchored at lm[123] (right) / lm[352]
//       (left), the zygomatic arch apex -- the highest, most anterior point of the
//       cheekbone visible at a three-quarter angle. Vector is predominantly lateral
//       (outward, same sign as the near-side lateral axis) with a small superior
//       component. The capsule extends in the displacement direction (SCULP_CAPSULE
//       run factor), so the arch edge translates rigidly rather than smearing. The
//       oval guard is ON (face oval with blurred edge), so the silhouette cannot
//       actually move outward; only interior pixels shift, creating a new convex
//       highlight on the arch that matches the clinical before/afters (Cases A and C
//       uploaded June 13). Sigma SCULP_ZYGOMA_SIG ~0.10W; tight enough to be an
//       arch-specific highlight, wide enough not to read as a painted disc.
//   (2) Anterior midface: Gaussian kernel (no capsule) anchored midway on the ogee
//       curve between the zygion and the near-side ala, pointing anteriorly (toward
//       the far cheek, same sign derivation as the chin projection). Wider sigma
//       SCULP_MIDFACE_SIG ~0.16W. Fills the flat mid-cheek plane that deflation-
//       and-descent produces, matching Cases B and E.
//
// Calibration standard: every round judged against the four real Sculptra cases
// uploaded June 13, 2026. Andy is the clinical authority; Claude owns engineering.
// One lever per round; first tunable lever is SCULP_ZYGOMA_OUT (the lateral
// magnitude driving the arch highlight). Expect a v47-v50 arc matching v28-v34.
//
// The frontal lift (jowl + midface re-drape) is untouched; its vectors stay
// exactly as calibrated in M6.2. The oblique branch adds NEW kernels alongside;
// it does not reuse or modify the frontal ones. maybeBuildLift drops the
// frontal-only gate and calls buildLiftField for both views; the function now
// returns null on out_of_range (unchanged behavior for very steep profiles).
//
// M9.11 (v46): BETA RANGE STOP-LOSS. Clinical review at 338-507% zoom failed
// the chin tip at Enhanced: extending the silhouette stretches the original's
// chin-to-shadow gradient into a wide featureless penumbra, a junction-shading
// problem no resampling or band math can rebuild from a 2D photo. Per the
// agreed stop-loss, the filler consultation range ships as Subtle through
// Balanced (client caps the slider; see FILLER_BETA_MAX in visualize.html),
// and the warp ceiling drops to 0.45, the historically eye-passed amplitude.
// Enhanced returns on M10's spline silhouette with synthesized junction
// shading; Overfilled returns on the dedicated AI-heavy education anchor.
//
// M9.10 (v45): WARP SATURATION for chin_jaw (clinical: angular, faceted chin
// silhouette at Enhanced and above; zoom forensics show curvature kinks where
// the chin, notch-fill, and gonial kernels join, a vector-path chin). The
// silhouette is a union of capsule kernels, and above roughly 0.6 amplitude
// the kernel geometry reads through. Fix by construction, not tuning: the
// WARP's intensity saturates at CHINW_WARP_SAT (0.55, the amplitude that
// passed clinical review), while the AI shading/fill alpha continues scaling
// to 100. Enhanced and Overfilled therefore show the validated silhouette
// plus progressively stronger fill. A smooth, spline-based silhouette target
// that can carry full amplitude is M10 geometry work; a dedicated AI-heavy
// Overfilled anchor (education zone) is the agreed companion design. Set
// CHINW_WARP_SAT to 1.0 to restore exact v44 behavior.
//
// M9.9 (v44): EVIDENCE-DRIVEN RETIREMENT of the painted border light. Pixel
// forensics on a real v43 Enhanced export (signed diff + local-contrast map
// against the original panel) showed two things. (1) The jawdef pass renders
// as a literal drawn stroke: one isolated arc of ADDED contrast tracing the
// border on the contrast map, visible in the photo as a pale line. A
// hand-painted luminance band cannot pass a clinician's eye at consultation
// levels; credible border definition comes from geometry changing what real
// light does (proven by the chin arc, v31-v34, composite-then-warp), so that
// job moves to the M10 geometry stack. JAWDEF_BRIGHT and JAWDEF_DARK default
// to 0 (the pass and its levers remain for a possible overfill-education-only
// revival). The GEOMETRIC gonial squaring (GONW_DEF) stays: it is the
// legitimate mechanism and carries real pixels. (2) The simulated panel was
// globally softer than the original panel, including pipeline-untouched
// regions (forehead contrast ratio 0.93, blur-match sigma ~0.6px): the
// compositor's 1024 grid was being UPSCALED into the larger export panel and
// compared against the sharper original. That gap predates and underlies the
// whole v37-v43 softness chase. Fixed client-side: exports re-render each
// angle at maxDim 2048 (compositeSculptra already accepts maxDim; the high
// band comes from the original, so output crispness scales with the grid).
//
// M9.8 (v43): organic mid band + photographic border light (clinical: the
// Overfilled oblique still reads synthetically smooth between border and lower
// cheek, and the border light reads drawn). Two causes, two fixes:
// (1) THREE-BAND mid keep (chin_jaw only): the two-band restore preserves pore
// detail (high band) but hands everything coarser to the AI's smooth fill, so
// the patient's 8-30px organic skin variation vanishes at high alpha, which
// is the synthetic-smoothness read. The luma path now splits a MID band
// (between CHIN_JAW_TEX_RADIUS and CHIN_JAW_MID_RADIUS) and keeps
// CHIN_JAW_MID_KEEP of the patient's own mid variation, suppressed inside the
// jowl release lobes so the fold erasure is not undone. midKeep 0 reproduces
// the v42 path bit for bit; Sculptra passes no midKeep and is untouched.
// (2) LIGHT-MODULATED border pass: applyJawDefinition now samples the lit
// face just inside the border at each polyline vertex and scales both the lit
// band and the shadow step by that local illumination, so the structural light
// breathes with the photo's lighting instead of tracing a uniform line.
//
// M9.7 (v42): jaw shadow containment + layer attribution. (1) The v41 shadow
// step smeared: a 0.028W feather with no hard stop painted a soft dark band
// past the border onto the neck and clothing. Real border shadow is a thin
// crease hugging the border. JAWDEF_DARK 14 -> 10, JAWDEF_W_OUT 0.028 ->
// 0.014, and the dark side now has a HARD cutoff at 2.5 sigma, so the step is
// crisp and close and nothing below it is touched. (2) Post passes are now
// individually addressable from the client: opts.jawDef === false skips the
// border light, opts.warpSharpen === false skips the sharpen pass. Together
// with the existing warp/textureRestore/jowlTexRelease flags, this powers the
// client's ?debug=layers contact sheet (one generation rendered with each
// layer isolated), which replaces diagnosis-by-correspondence with evidence.
//
// M9.6 (v41): DETERMINISTIC JAWLINE DEFINITION (clinical: jawline never made
// stronger; structural rebuild is the point of chin/jawline HA in bone
// resorption, and the persistent "blur" reading in the jowl/jaw region).
// Re-diagnosis against the clinic's real before/afters: the treated jaw reads
// sharp because it has STRUCTURE, a lit border plane with a crisp shadow step
// below it running chin to gonion, not because of pore detail. Our composite
// preserves pores (v37-v40) but fills the region with featureless smooth
// brightness, and featureless reads as blurry; meanwhile the AI under-paints
// the border light, especially posteriorly. Fix, two parts:
// (1) applyJawDefinition: a photometric border pass on the FINISHED, warped
// composite. Along the displaced chin-to-gonion border polyline it lifts a
// narrow band just above the border (JAWDEF_BRIGHT over JAWDEF_W_IN) and
// deepens a band just below (JAWDEF_DARK over JAWDEF_W_OUT), luminance only,
// added equally to RGB (chroma locked), scaled by the slider, brightening
// gated to lit subject so hair and backdrop are never lifted. This is the
// light architecture of a structural jawline, drawn deterministically.
// (2) Gonial squaring at oblique: a small posterior-inferior kernel at the
// near gonion (GONW_DEF) restores the angle the way jawline filler does, so
// the border line has a corner to end at. Both lever-tunable; zero either to
// disable. Sculptra untouched (chin_jaw post-warp path only).
//
// M9.5 (v40): the two residual softeners at high intensity (clinical: "a bit
// better but still not enough" after v39 closed all three texture-swap paths).
// (1) STRETCH-AWARE sharpening: the warp's detail loss follows local
// MAGNIFICATION, not displacement; the plateau translates rigidly and loses
// almost nothing, while the decay zone stretches up to ~1.4x and thins detail.
// The sharpen pass now weights by the local stretch of the offset field (sum
// of absolute partial derivatives, the Jacobian deviation) with a small base
// term for plain fractional-offset translation, and the ceiling rises 0.45 ->
// 0.7. (2) MID-BAND tightening for chin_jaw only: detail coarser than the
// texture-restore cutoff lives in the low band and takes the AI's smooth
// version at high alpha, an airbrushed look at the 7px-and-coarser scale (fine
// lines, skin mottling) even with pores intact. CHIN_JAW_TEX_RADIUS drops the
// chin_jaw cutoff 0.016W -> 0.009W so that band stays the patient's own;
// treatment shading is far coarser than 0.009W and is unaffected, and Sculptra
// keeps 0.016W untouched. Attribution if any softness remains: ?warp=off at
// the top of the slider; sharp there means raise WARP_SHARP_AMOUNT, soft
// there means lower CHIN_JAW_TEX_RADIUS further.
//
// M9.4 (v39): micro-texture-PROTECTED guard, the third and final texture-
// replacement path in the chin/jaw region (clinical: chin still blurry at the
// top of the slider after v38). v37 fixed warp resampling, v38 fixed the
// release lobes; both were real, but the original M5.1 moved-edge guard was
// independently doing the same damage in a band along the jawline: the AI's
// strong border shadow and local brightening (demanded by prompt v9, permitted
// by the deep dark floor) create exactly the sharp low-band transition the
// guard triggers on, so g collapses along the border and the AI's soft,
// upscale-stretched high band replaces the patient's pores there, scaled by
// alpha (hence worse to the right of the slider). Fix, same amplitude
// separation as v38: the guard's fallback now only proceeds where there is
// real STRUCTURE at the pixel in either image (max(|origHigh|,|aiHigh|) above
// GUARD_DETAIL_LO..HI). Pore-scale pixels keep the original unconditionally.
// Both of the guard's legitimate jobs survive intact, because both involve
// structure: an old-edge ghost candidate has |origHigh| large (fallback still
// proceeds, no ghost), and the AI's new shadow line has |aiHigh| large
// (fallback still carries it). After this change, a pore pixel's luminance
// delta is mathematically pure low band at every slider position; the only
// remaining softener in the region is warp resampling, already bicubic plus
// sharpened (v37). Sculptra is untouched (forceOriginalTexture already pins
// its guard fully open).
//
// M9.3 (v38): crease-SELECTIVE lobe release (clinical: chin/jowl area still
// blurry at the high end of the slider after v37; conservative end good).
// That slider signature identifies the source: v36's release handed the WHOLE
// lobe's high band to the AI, and the AI's in-mask fill is soft, so as alpha
// climbed the patient's pore texture was progressively swapped for smooth AI
// skin. The fix separates what the release was for (erasing the fold line)
// from what it must never touch (pore-scale texture) by amplitude: a jowl or
// marionette fold is a dark high-frequency structure many luma levels below
// its local mean; pores are a few levels. The release now fires per pixel only
// on dark structures deeper than JOWL_CREASE_LO..HI, so the fold is still
// erased where the AI softened it while pores keep the original texture at
// EVERY slider value. Tradeoff, documented: a deep pigment spot inside the
// lobes (darker than JOWL_CREASE_HI below its surroundings) is treated like a
// crease and can fade at the top of the slider; raise both thresholds if a
// real spot visibly fades, at the cost of fold-erasure strength.
//
// M9.2 (v37): chin sharpness at oblique Strong (clinical: "blurry effects at
// the chin area at strong"). Mechanism, two compounding resampling losses in
// the chin_jaw post-warp, neither fixable by the texture restore because that
// runs BEFORE the warp and its output gets resampled too:
// (1) bilinear sampling averages 4 pixels at every fractional offset, and
// (2) in the kernel decay zone the backward map locally MAGNIFIES (the chin
// peak 0.06W over sigma 0.085W gives a local stretch up to ~1.4x), thinning
// pore detail exactly where displacement is largest. Largest displacement is
// the oblique chin at Strong, which is exactly where the blur was seen.
// Fixes: (a) Catmull-Rom bicubic resampling for the chin_jaw field only (the
// field carries bicubic:true; the approved Sculptra lift keeps its exact
// bilinear path, zero change there), and (b) a displacement-weighted,
// subject-gated self-unsharp pass on the warped result (luminance only, added
// equally to RGB so chroma is locked; scaled by local displacement so it does
// nothing outside the moved band; dark-gated so the backdrop and hair are
// never haloed). Levers: WARP_SHARP_AMOUNT (0 disables, isolating the bicubic
// change), WARP_SHARP_RADIUS, WARP_SHARP_DISP.
//
// M9.1 (v36): jowl-lobe TEXTURE RELEASE, the structural fix v35's lobes were
// missing. Diagnosis (settled by the composite math, not by tuning): the
// chroma-locked texture restore's high-frequency term reduces to
//   highTerm = (1 - g) * (aiHighLuma - origHighLuma)
// and on stationary skin the moved-edge guard gives g ~ 1, so highTerm ~ 0.
// The output is original + alpha * delta; the jowl fold's sharp crease line
// lives in the ORIGINAL's high band and therefore survives at full strength no
// matter how well the AI softens it. v35's lobes opened the ALPHA, but alpha
// multiplies a delta that structurally contains no crease correction. Only the
// low band (cutoff TEX_RADIUS_FRAC, roughly 10-16 px) passes, which is exactly
// why the broad frontal shadow mildly improved while the oblique fold (a sharp
// line at 45 degrees, almost entirely high frequency) did not move. Fix: a
// per-pixel RELEASE FIELD over the same v35 jowl lobes, passed into
// buildTextureDelta, where it scales the guard down (g *= 1 - release). Inside
// the lobes the high band becomes aiHigh - origHigh: where the original holds
// a dark crease line and the AI flattened it, that term is POSITIVE
// (brightening), passes the darkening gate untouched, and literally erases the
// crease. AI attempts to ADD dark detail there stay governed by the existing
// highDarkenScale. Chroma stays locked (luminance only, no invented pigment),
// and the field is zero outside the lobes, so chin/border moved-edge behavior
// is untouched. Lever: JOWL_TEX_RELEASE (0 restores v35 behavior); client
// hook ?jowltex=off for the A/B. Also: CHINW_NOTCH_FILL 0.012 -> 0.022. The
// undulating BORDER at oblique can only be the warp's (the outline gate zeroes
// AI paint outside the silhouette and the lobes are oval-contained), and the
// follower sum plus 0.012W still left a visible dip on a deep sulcus. Frontal
// notch fill unchanged (frontal mildly improved on the v35 run).
//
// M9.0 (v35): jowl blending for the aging lower face. Clinical mechanism
// (calibrated against real chin/jawline before/afters): on a jowled face the
// treatment reads as jowl SOFTENING because the prejowl sulcus is filled and
// the border becomes one continuous line from chin to gonion; the jowl is
// blended into the line, never enlarged, never excised. v34 missed this twice:
// (1) the treat alpha was a tube hugging the border, so the AI's softening of
// the marionette/prejowl shadow and jowl shadow ABOVE the border was thrown
// away at composite time; (2) the warp followers interpolate the border, so a
// concave notch stays concave. v35 adds (a) jowl-blend alpha lobes (marionette
// tube: mouth corner -> prejowl; jowl body tube: prejowl -> raised mid-jowl),
// oval-contained so they are shading-only and can never move the contour, and
// (b) a prejowl notch-fill kernel in the warp (anterior at oblique, outward at
// frontal) that overfills the sulcus so the silhouette line straightens.
// Levers: CHINW_NOTCH_FILL (oblique straightening), CHINW_NOTCH_FILL_FRONTAL
// (frontal, keep small, frontal is approved), JOWL_SCALE / LF_JOWL_SIGMA
// (how much AI shading the jowl region admits).
//
// M8.2 (v34): warp shading reconciliation. The one predictable residue of
// warping real pixels: the warp can slide brighter mid-chin skin forward over
// what used to be a darker zone (labiomental, under-jaw), so the moved band
// arrives a notch too bright for its new neighborhood and reads as a pale
// lighting patch (seen on the left-45 export). Fix: a ONE-SIDED reconciliation
// pass inside the warped band only. Where the warped result's luminance
// overshoots the location's ORIGINAL low-frequency light by more than a
// margin, it is pulled partway back, multiplicatively (chroma untouched).
// Gated to lit subject (original low-freq luma above the gate floor), so the
// projected chin against a dark backdrop is never darkened, and one-sided, so
// the AI's shadow line under the border (darker, not brighter) is never
// touched. Fires only on overshoot: a side that already matches passes
// through with factor ~1.
//
// M8.1 (v33): aesthetic shaping pass on confirmed-correct direction. (1)
// Witch-chin fix: v32 concentrated the advance at the tip while the
// supramental region lagged, so Strong led with a point and hooked. v33
// distributes the projection as a broad CONVEX unit: a new supramental kernel
// (between the labiomental area and the pogonion) carries the advance upward,
// the pogonion keeps the maximum, and the menton follows slightly less, so the
// profile reads as a strong rounded chin, never a point. (2) Jawline
// definition strengthened on clinical feedback ("drastically"): border
// followers up (prejowl 0.45 -> 0.60, mid 0.25 -> 0.40, gonion 0.10 -> 0.15),
// a small downward component on the prejowl and mid-border kernels deepens the
// border-to-neck step, and the chin_jaw dark floor rises 22 -> 26 so the AI
// can draw a stronger chroma-locked shadow line under the new border.
//
// M8.0 (v32): PROJECTION DIRECTION SIGN FIX (clinical bug report: sliding to
// Strong moved the chin BACKWARD). The anterior direction in image space at an
// oblique points toward the FAR cheek, the side the nose points, not toward
// the camera-facing near side; v28-v31 aimed the vector at the near side
// (toward the ear), which is posterior. v32 derives the anterior sign directly
// from anatomy: the nose tip is displaced anteriorly relative to the bridge at
// any oblique view, so its lateral offset gives the forward sign unambiguously
// (fallback: the opposite of the camera-facing side). The jaw kernels are also
// corrected to the same axis and restructured clinically: a projected chin
// straightens the chin-to-gonion line by ROTATING it around the gonion, so the
// prejowl follows the chin's advance strongly, mid-jaw moderately, and the
// gonion stays nearly anchored. NOTE: v31's lighting-integration verdict was
// contaminated by this bug (the warp ran backward in every oblique export);
// the composite-then-warp architecture gets its first fair test on v32.
//
// M7.9 (v31): composite-then-warp for chin_jaw. v30 proved the displacement
// fires, and also exposed the real remaining gap: the AI's light is computed in
// the ORIGINAL frame and gated to the ORIGINAL silhouette, so the tissue the
// warp moves outward arrives flat-lit on the dark neck with no form shadow
// under the new border; it reads as a pale sticker, not a projected chin. v31
// reorders the chin_jaw pipeline: build the full composite first (patient +
// the AI's jawline shading, including the under-border shadow the deep dark
// floor permits), THEN warp that finished image. Light now travels with the
// tissue: the AI's border shadow lands under the NEW border, the chin's leading
// edge carries its shading, and the moved band inherits exactly the appearance
// the model painted for "the jawline". Sculptra keeps the M6 warp-then-blend
// order untouched (calibrated and approved); this reorder is chin_jaw only.
//
// M7.8 (v30): projection axis corrected on clinical feedback. Chin filler has
// two distinct axes: vertical ELONGATION (menton travels down) and forward
// PROJECTION (pogonion travels anteriorly); v29's oblique vector was nearly
// diagonal (15px forward, 12px down), which reads as elongation, and it led
// with the menton. v30 makes the oblique vector projection-dominant (forward
// raised, drop cut to a small accompaniment) and anchors the leading capsule at
// the POGONION (estimated just above the menton on the anterior chin contour),
// with the menton following at reduced weight so the underside stays
// continuous. Frontal is untouched: head-on, vertical lengthening IS the
// correct visible expression and it is already signed off.
//
// M7.7 (v29): oblique chin/jaw pass two. (1) Warp kernels become CAPSULES:
// each anchor's displacement stays constant along a short run in the direction
// of motion before decaying, so the silhouette edge translates rigidly instead
// of stretching; the isotropic v28 Gaussians had a displacement gradient ACROSS
// the edge, which smeared the high-contrast skin-to-background boundary into
// the soft band visible on the oblique exports. (2) The outline gate stops
// trusting the landmark oval alone: at a three-quarter view MediaPipe's
// projected face oval spills past the true jaw-neck silhouette, letting AI
// paint through onto background and neck; the gate now also requires the
// ORIGINAL pixel to be plausibly lit subject (a dark-luma floor kills black
// backdrop, deep shadow, hair, and dark clothing), and the oval's lower-face
// vertices are pulled slightly inward. (3) Magnitudes up on clinical feedback:
// stronger oblique chin travel, wider jaw-out, a mid-jaw kernel for a straight
// continuous border, and a deeper chin_jaw dark floor so the AI can draw the
// sharp shadow line that makes a jawline read as defined (chroma stays locked).
//
// M7.6 (v28): chin/jaw projection moved to GEOMETRY. Three rounds of evidence
// (M5, M7.5 runway, M7.5 prompt) show the image model will not reliably extend
// a silhouette; it either under-delivers or leaves haze/blob artifacts at the
// boundary, and a decisiveness test cannot tell decisive tissue from decisive
// garbage. So the outline now moves the same way the M6 Sculptra lift does:
// a deterministic warp of the patient's own pixels (chin forward/down, near-side
// jaw outward at obliques; vertical chin lengthening frontally), with the AI
// confined to light and shading INSIDE the face. The luminance haze gate is
// replaced by a hard outline gate: for chin_jaw, zero AI contribution outside
// the original silhouette, ever. The M7.5 mask runway is reverted (no longer
// needed; it only invited the model to paint where we now discard).
//
// M7.5 (v27): HA chin/jawline oblique pass. (1) Background haze gate in the
// compositors: outside the original face silhouette the AI's pixels are kept
// only where the change is DECISIVE (real new chin/jaw tissue is an 80+ luma
// jump over the backdrop; the faint grey smudge the model sometimes paints in
// the projection runway is 10-30 and is snapped back to the exact original).
// (2) Pose-aware projection runway in the chin_jaw mask: at a three-quarter
// view the editable band extends toward the camera-side profile direction so
// the model has room to draw the new chin and jaw forward of the old outline.
//
// M7 (v26): jaw-margin feather added to the Sculptra mask (the lower-face
// alpha now dissolves over a wide band inside the jawline silhouette, fixing
// the faint tonal step at the jaw margin seen on oblique cases), and a new
// analyzePhoto() export that returns pose plus capture-quality metrics (face
// size in frame, mean luma, sharpness) for the upload gate in the M7 UI.
//
// M6.4 (v25): extrapolation retired after three calibration rounds; the gain is
// pinned at 1.0 and the slider is pure original-to-anchor interpolation. Strong
// now means the full anchor. Anchor magnitude is the upstream lever (projection
// setting / prompt), geometry is the structural lever.
//
// M6.3 (v24): the gain now shapes FORM, not brightness. Broad brightening is
// soft-capped inside the delta (SCULPTRA_BRIGHT_CAP_FULL), the glow moved out of
// the gained delta to a fixed apply-time term, the dark floor was widened for
// underside shadow, and the lift warp stepped up again. Fixes the flat waxy
// gold look of the first v23 Strong exports.
//
// M6.2 (v23): response gain added so the composite can EXCEED the AI's own
// magnitude (see SCULPTRA_DELTA_GAIN), warp and glow recalibrated against the
// first two real before/after pairs, and the lid-cheek roll opened.
//
// M6 (v22): this module now also hosts the geometry engine. The compositors
// apply a landmark-driven LIFT WARP to the frontal Sculptra base (jowl and
// midface re-drape using the patient's own pixels) before adding the AI's
// chroma-locked luminance delta. Geometry for displacement, AI for light. See
// the M6 section below for the gating (frontal + 'full' scope only) and the
// fail-safe (anything else is exactly the M5 pipeline).
//
// The PNG is generated at the SAME pixel size the client posts the photo at
// (long edge capped at maxDim), so image and mask dimensions match, which the
// edit endpoint requires.
//
// IMPORTANT: the geometry below mirrors the validator
// (skinday-visualize-hybrid-composite-test.html). If the validator's mask
// constants change, mirror them here. This file is the production source of
// truth for the mask; the validator is the calibration copy.

import { FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/vision_bundle.mjs";

// ---- geometry constants (mirror of the validator) ------------------------
// Sculptra full-scope coverage (v11 scaffold tuning). The earlier values gated
// the scaffold zones the real-world results depend on: a band-by-band diff of
// the oblique cases showed the temple essentially untouched and the lid-cheek
// barely moved. These open the zones the clinician expects Sculptra to rebuild:
//   - VOL_BANDS.lower_cheek lower bound dropped 0.27 -> 0.23 so prejowl / lower
//     lateral face is covered for jowl lift and jawline definition.
//   - VOL_LAT_MIN_TEMPLE 0.34 -> 0.27 so temple support reaches medially into
//     the temporal hollow instead of only the far lateral edge.
//   - CHEEK_UE_ROLL 0.7 -> 0.30 so the cheek mask climbs to the lid-cheek
//     junction (the protected eye discs still guard the lid and eyeball), giving
//     volume-driven under-eye support from below.
//   - APEX_SIGMA_CHEEK 0.15 -> 0.17 and APEX_SIGMA_TEMPLE 0.11 -> 0.135 for
//     broader, more convex lateral cheek and temple projection.
// To revert the scaffold strength, restore these six numbers; nothing else here
// changed.
const VOL_BANDS = { temple:[0.58,0.80], cheek:[0.42,0.64], lower_cheek:[0.23,0.42] };
const VOL_FB = 0.05;
const VOL_LAT_RAMP = 0.06;
const LAT_MIN = 0.12;
const VOL_LAT_MIN_CHEEK = 0.18;
const VOL_LAT_MIN_TEMPLE = 0.27;
const CHEEK_UE_LO = 0.56, CHEEK_UE_HI = 0.64, CHEEK_UE_ROLL = 0.18;
// CHEEK_UE_ROLL 0.30 -> 0.18 (M6.2 calibration): the real-case pairs show a
// clear lid-cheek junction improvement from restored midface volume that the
// sim was under-delivering; the protected eye discs still guard the lid itself.

// M7 jaw-margin feather. Along the lower-face silhouette the active band used
// to run to the same narrow (~0.02*W) oval fade as everywhere else, leaving the
// AI's luminance shift abutting the jawline with only a few pixels of falloff;
// on oblique cases that read as a faint tonal step (discoloration) at the jaw
// margin. The Sculptra scopes now additionally fade the alpha over a wide band
// inside the lower silhouette so volume shading always dissolves well before
// the jaw edge. Upper face (temple and cheek against hair) is untouched, and HA
// chin_jaw is untouched because it must reach and move the outline.
const JAW_EDGE_FEATHER = 0.055; // wide oval blur for the lower-face guard, fraction of W
const JAW_EDGE_TOP     = 0.26;  // guard fully active below this hF (chin=0)
const JAW_EDGE_FADE_TO = 0.38;  // guard fades out by this hF (mid-cheek unaffected)

// M7.6: the M7.5 "projection runway" (offset mask segments beyond the outline
// at obliques) is REVERTED. It only gave the model room to paint boundary
// artifacts we now discard; the outline is moved geometrically instead (see
// buildChinProjectionField), so the chin_jaw mask is back to its M7 footprint.

const ZYGION = { r:234, l:454 };
const TEMPLE_OVAL = { r:127, l:356 };
const CHEEK_APEX_UP = 0.03, CHEEK_APEX_IN = 0.02, TEMPLE_APEX_IN = 0.06;
const APEX_SIGMA_CHEEK = 0.20, APEX_SIGMA_TEMPLE = 0.135;

const FOLD_SIGMA = 0.026;
const COMMISSURE = { r:61, l:291 };
const ALA = { r:64, l:294 };

const FACE_OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
const LEFT_EYE = [263,249,390,373,374,380,381,382,362,466,388,387,386,385,384,398];
const RIGHT_EYE = [33,7,163,144,145,153,154,155,133,246,161,160,159,158,157,173];
const LEFT_BROW = [276,283,282,295,285,300,293,334,296,336];
const RIGHT_BROW = [46,53,52,65,55,70,63,105,66,107];
const LIPS = [61,146,91,181,84,17,314,405,321,375,291,185,40,39,37,0,267,269,270,409,78,95,88,178,87,14,317,402,318,324,308,191,80,81,82,13,312,311,310,415];
const NOSE = [1,2,98,327,168,6,197,195,5,4,45,275,440,220,134,236,3,51,281,248,419,456,344,440];
const PROTECTED = [...new Set([...LEFT_EYE,...RIGHT_EYE,...LEFT_BROW,...RIGHT_BROW,...LIPS,...NOSE])];

// ---- small helpers (mirror of the validator) ------------------------------
const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y});
const add=(a,b)=>({x:a.x+b.x,y:a.y+b.y});
const mul=(a,k)=>({x:a.x*k,y:a.y*k});
const dot=(a,b)=>a.x*b.x+a.y*b.y;
const len=a=>Math.hypot(a.x,a.y);
const norm=a=>{const L=len(a)||1;return{x:a.x/L,y:a.y/L};};
const lerp=(a,b,t)=>({x:a.x+(b.x-a.x)*t, y:a.y+(b.y-a.y)*t});
const clamp01=v=>v<0?0:v>1?1:v;
const smoothstep=(e0,e1,x)=>{ const t=clamp01((x-e0)/((e1-e0)||1e-6)); return t*t*(3-2*t); };

function distToSeg(px,py,A,B){
  const vx=B.x-A.x, vy=B.y-A.y, wx=px-A.x, wy=py-A.y;
  const c1=vx*wx+vy*wy; if(c1<=0) return Math.hypot(px-A.x,py-A.y);
  const c2=vx*vx+vy*vy; if(c2<=c1) return Math.hypot(px-B.x,py-B.y);
  const t=c1/c2; return Math.hypot(px-(A.x+t*vx), py-(A.y+t*vy));
}

// separable box blur on a Float32 alpha field, to soften the composite boundary
function blurAlpha(m,w,h,r){
  if(r<=0) return m;
  const cx=i=>i<0?0:(i>=w?w-1:i), cy=i=>i<0?0:(i>=h?h-1:i);
  const tmp=new Float32Array(m.length), out=new Float32Array(m.length), win=2*r+1;
  for(let y=0;y<h;y++){ const row=y*w; let s=0;
    for(let k=-r;k<=r;k++) s+=m[row+cx(k)];
    for(let x=0;x<w;x++){ tmp[row+x]=s/win; s+=m[row+cx(x+r+1)]-m[row+cx(x-r)]; }
  }
  for(let x=0;x<w;x++){ let s=0;
    for(let k=-r;k<=r;k++) s+=tmp[cy(k)*w+x];
    for(let y=0;y<h;y++){ out[y*w+x]=s/win; s+=tmp[cy(y+r+1)*w+x]-tmp[cy(y-r)*w+x]; }
  }
  return out;
}

// ---- M5.1 texture-restore composite ---------------------------------------
// gpt-image-1's in-mask fill is low-frequency: it lands the broad volume and
// contour but loses the skin's high-frequency texture and chroma, so at high
// intensity the treated region reads soft. The fix keeps the AI's LOW band (the
// volume) and restores the ORIGINAL's HIGH band (real pores, fine texture,
// chroma micro-detail). A moved-edge guard detects where the AI shifted the
// silhouette (chin tip, jaw) versus merely inflated stationary skin, and falls
// back to the AI's own high band only at those moved edges, so the old outline
// does not ghost through the new one.
//
// Everything collapses to out = original + alpha * delta, with delta precomputed
// once, so the live intensity slider stays a single multiply-add per channel
// (no extra cost vs the plain composite, and no regeneration).
//
// Tuning knobs (shared by HA chin/jaw and Sculptra; safe defaults below):
//   TEX_RADIUS_FRAC  frequency cutoff as a fraction of face width W. Smaller =
//                    restores finer detail only (more AI softness survives);
//                    larger = restores coarser detail (can start re-imposing the
//                    original's medium shading and fight the AI volume).
//   TEX_STRENGTH     0..1 how much original texture to swap in. 1 = full. Drop
//                    toward ~0.85 only if the result looks over-crisp/HDR.
//   GUARD_EDGE_LO/HI local low-band-difference variation (luma levels) where the
//                    moved-edge guard begins / fully falls back to AI detail.
//                    Raise both if a real moved silhouette still shows AI soft-
//                    ness; lower them if an old edge ghosts through.
//   CHROMA_LOCK      M5.2. 0..1. The AI restores volume as LUMINANCE (highlights,
//                    softened shadows), but it also invents skin COLOR inside the
//                    mask: at high intensity that surfaces as a warm brown cloud
//                    over the treated cheek/lower face. At 1.0 the composite keeps
//                    the AI luminance and locks chroma to the patient's original,
//                    so the volume shows but no pigment is invented. Mechanically
//                    this adds a single luminance delta equally to R,G,B, which
//                    cannot shift hue. Drop toward ~0.8 only if the restored
//                    volume looks flat or grey and you want a little AI warmth back.
//   LUMA_DARK_FLOOR  M5.3. Max levels the treated skin's broad tone may DARKEN.
//                    Real Sculptra lightens skin (the glow); it does not darken it,
//                    so this is 0 (treated skin is never broadly darker than the
//                    original). Skin texture and pigment spots are carried from the
//                    original separately, so they stay; only the broad tone is
//                    floored. Raise a few levels only if you want some contour
//                    shadow back under restored volume.
//   GLOW_LUMA        M5.3. Gentle luminance lift across the treated zone at full
//                    strength (the Sculptra glow), in luma levels. Chroma stays
//                    locked and texture/pigment are untouched, so this brightens
//                    without smoothing or evening out the skin. Scaled by mask and
//                    intensity, so at the 50% default it is about half this. Lower
//                    toward 0 to remove the glow, raise for a stronger one.
const TEX_RADIUS_FRAC  = 0.016;
const TEX_BLUR_PASSES  = 2;     // box passes -> approx gaussian
const TEX_STRENGTH     = 1.0;
const GUARD_RADIUS_FRAC= 0.016;
const GUARD_EDGE_LO    = 12;
const GUARD_EDGE_HI    = 40;
// v71: CHROMA_LOCK raised from 0.82 back to 0.96.
// At 0.82 the 18% chroma release caused visible warm/brown discoloration
// patches on lighter and more neutral skin tones (confirmed on real patient
// oblique views -- the patch sits exactly over the treatment mask zone).
// The Sculptra glow is a real clinical effect but it manifests as luminance
// (skin brightening), not chroma shift. Locking chroma tightly at 0.96 means
// the glow still shows as the GLOW_LUMA term (uniform luminance lift) while
// the brown warmth artifact is suppressed. 0.96 allows a tiny residual chroma
// for cases where the AI's colour delta is genuinely structural; 1.0 would
// be fully safe but may look flat on very dark skin tones.
const CHROMA_LOCK      = 0.96;
const LUMA_DARK_FLOOR  = 0;     // treated skin never darker than original (broad tone)
const GLOW_LUMA        = 4;     // M16: 6->4, trims the delta-path glow alongside
                                // back to 6, and for Sculptra the glow now lives
                                // OUTSIDE the gained delta (added at apply time,
                                // never multiplied by the response gain). The gained
                                // glow was lifting the whole treated zone ~12 levels
                                // at Strong, cancelling the underside shadows and
                                // flattening the volume into the waxy gold look.
// M5.4. 0..1. How much of the AI's high-frequency DARKENING is allowed through.
// The low-band floor stops broad darkening, but where the moved-edge guard is
// active (HA chin/jaw, which needs it to project the chin), the AI can paint a
// sharp fake shadow at the jaw or gonial corner that the guard passes through as
// dark detail. At 0 the composite adds no new shadow to skin: the patient's own
// shadows stay (they live in the untouched original), the AI may brighten, but it
// cannot deepen or invent a shadow. Raise toward ~0.3 only if you want some
// natural contour shadow back under a strongly projected chin.
const HIGH_DARKEN_SCALE = 0;

// M9.3 (v38): crease detector for the jowl-lobe texture release. The release
// (rel, from buildJowlReleaseField) only acts on dark high-frequency structure
// between these depths, in luma levels below the local mean: at or below LO
// nothing releases (pores, fine texture stay the patient's own at every
// intensity); at HI and deeper the release is fully open (the fold line is
// erased where the AI softened it). Raise both to protect deep pigment spots
// inside the lobes; lower LO if a shallow fold survives at full intensity.
const JOWL_CREASE_LO = 4;
const JOWL_CREASE_HI = 12;

// M9.4 (v39): structure detector for the moved-edge guard. The guard's
// fallback to AI high-frequency detail only proceeds where the pixel carries
// real structure in either image (max(|origHigh|,|aiHigh|), luma levels): at
// or below LO the original texture is kept unconditionally (pores can never be
// swapped for AI softness, at any slider value); at HI and above the guard
// behaves exactly as before (old-edge ghost protection and the AI's border
// shadow line both live above this). Raise LO if any AI softness still creeps
// into skin; lower HI if a moved edge ever ghosts.
const GUARD_DETAIL_LO = 4;
const GUARD_DETAIL_HI = 10;

// repeated separable box blur on a Float32 plane -> approximate gaussian
function blurPlane(src,w,h,r,passes){
  if(r<=0) return src.slice();
  let cur=src; const n=Math.max(1,passes|0);
  for(let k=0;k<n;k++) cur=blurAlpha(cur,w,h,r);
  return cur;
}

// Estimate face width W in pixels at (w,h) from the landmark set, using the same
// basis as buildTreatAlpha (zygion-to-zygion projected on the lateral axis), so
// the texture-restore radius scales with the face the same way the mask does.
function faceWidthPx(L,w,h){
  const a=L[10],bp=L[152],r=L[234],l=L[454];
  if(!a||!bp||!r||!l) return 0.4*w;
  const ux=(a.x-bp.x)*w, uy=(a.y-bp.y)*h; const ln=Math.hypot(ux,uy)||1;
  const nx=ux/ln, ny=uy/ln; const ox=-ny, oy=nx;
  const dx=(l.x-r.x)*w, dy=(l.y-r.y)*h;
  return Math.abs(dx*ox+dy*oy)||(0.4*w);
}

// Precompute the per-channel delta planes for the texture-restore composite.
// Given the original (b) and AI (a0) pixels as interleaved RGBA byte buffers and
// the face width W, returns {dR,dG,dB} such that, for any in-mask alpha al,
//   out_channel = original_channel + al * d_channel
// yields: low band = lerp(originalLow, aiLow, al)  (volume dials with the slider)
//         high band = original texture, except at AI-moved edges where it falls
//                     back to the AI's own high band (no ghost of the old outline).
// At al = 0 this is exactly the original; outside the mask al = 0 by construction.
function buildTextureDelta(b,a0,w,h,W,opts){
  const N=w*h;
  const r       = Math.max(2, Math.round((opts.texRadiusFrac   ?? TEX_RADIUS_FRAC )*W));
  const gr      = Math.max(2, Math.round((opts.guardRadiusFrac ?? GUARD_RADIUS_FRAC)*W));
  const passes  = opts.texPasses ?? TEX_BLUR_PASSES;
  const strength= (opts.texStrength==null ? TEX_STRENGTH : Math.max(0,Math.min(1,opts.texStrength)));
  const lo      = opts.guardLo ?? GUARD_EDGE_LO;
  const hi      = opts.guardHi ?? GUARD_EDGE_HI;
  const clock   = (opts.chromaLock==null ? CHROMA_LOCK : Math.max(0,Math.min(1,opts.chromaLock)));
  const darkFloor = (opts.darkFloor==null ? LUMA_DARK_FLOOR : Math.max(0,opts.darkFloor));
  const glow      = (opts.glowLuma==null ? GLOW_LUMA : opts.glowLuma);
  const brightCap = (opts.brightCap==null ? 0 : Math.max(0,opts.brightCap)); // 0 = uncapped
  const highDark  = (opts.highDarkenScale==null ? HIGH_DARKEN_SCALE : Math.max(0,Math.min(1,opts.highDarkenScale)));
  // For Sculptra (inflation, no moved silhouette) the moved-edge guard is not
  // needed and is actively harmful: where the AI paints a fake submalar/cheek
  // shadow, the guard reads the sharp shadow as a moved edge and passes the AI's
  // dark high-frequency through, darkening skin the low-band floor cannot catch.
  // Forcing the guard fully open (texture always from the original) means the AI
  // can no longer inject any darkening via the high band; combined with the
  // low-band dark floor, Sculptra skin can only hold or brighten. HA chin/jaw
  // keeps the guard (it has genuine moved edges) by leaving this false.
  const forceOrig = !!opts.forceOriginalTexture;
  // M9.1/M9.3: optional per-pixel texture-release field (0..1). Where it is
  // positive, the luma path's guard is scaled down crease-selectively (only on
  // dark high-frequency structure deeper than JOWL_CREASE_LO..HI), letting the
  // AI's flattened version replace the fold line while pores keep the original
  // texture. Built over the jowl-blend lobes for chin_jaw; null everywhere
  // else, so nothing outside the lobes changes.
  const rel = opts.releaseField || null;
  // M10.6: optional jaw-continuity feather (Sculptra 'full' only). Per-pixel
  // weight 0..1 that tightens the positive bright cap toward jawTightCap in the
  // lower-lateral cheek so the cheek-to-jaw tone stays continuous. Null = off.
  const jawFeather = opts.jawFeatherField || null;
  const jawTightCap = (opts.jawTightCap==null ? SCULPTRA_JAW_TIGHT_CAP : Math.max(0, opts.jawTightCap));
  // M9.8 (v43): optional three-band mid keep (see CHIN_JAW_MID_KEEP).
  const midK = (opts.midKeep==null ? 0 : Math.max(0, Math.min(1, opts.midKeep)));
  const midR = Math.max(0, Math.round((opts.midRadiusFrac ?? 0)*W));

  const bR=new Float32Array(N),bG=new Float32Array(N),bB=new Float32Array(N);
  const aR=new Float32Array(N),aG=new Float32Array(N),aB=new Float32Array(N);
  for(let i=0,p=0;i<N;i++,p+=4){
    bR[i]=b[p];bG[i]=b[p+1];bB[i]=b[p+2];
    aR[i]=a0[p];aG[i]=a0[p+1];aB[i]=a0[p+2];
  }
  const bRl=blurPlane(bR,w,h,r,passes), bGl=blurPlane(bG,w,h,r,passes), bBl=blurPlane(bB,w,h,r,passes);
  const aRl=blurPlane(aR,w,h,r,passes), aGl=blurPlane(aG,w,h,r,passes), aBl=blurPlane(aB,w,h,r,passes);
  // M9.8: deep-low luma planes for the mid split (luma commutes with blur, so
  // blurring the per-pixel luma equals the luma of the blurred channels).
  let YoM=null, YaM=null;
  if(midK>0 && midR>r){
    const Yo=new Float32Array(N), Ya=new Float32Array(N);
    for(let i=0;i<N;i++){
      Yo[i]=0.299*bRl[i]+0.587*bGl[i]+0.114*bBl[i];
      Ya[i]=0.299*aRl[i]+0.587*aGl[i]+0.114*aBl[i];
    }
    YoM=blurPlane(Yo,w,h,midR,1);
    YaM=blurPlane(Ya,w,h,midR,1);
  }

  // moved-edge guard: local variation of the low-band luma difference. A moved
  // silhouette produces a sharp transition in (aiLow - origLow); a broad volume
  // brightening over stationary skin does not, so dramatic-but-stationary
  // Sculptra volume keeps full sharp texture.
  const D=new Float32Array(N);
  for(let i=0;i<N;i++){
    const al=0.299*aRl[i]+0.587*aGl[i]+0.114*aBl[i];
    const bl=0.299*bRl[i]+0.587*bGl[i]+0.114*bBl[i];
    D[i]=al-bl;
  }
  const Dl=blurPlane(D,w,h,gr,1);

  const dR=new Float32Array(N),dG=new Float32Array(N),dB=new Float32Array(N);
  for(let i=0;i<N;i++){
    const edge=Math.abs(D[i]-Dl[i]);
    const g=forceOrig ? strength : (1-smoothstep(lo,hi,edge))*strength; // 1 = stationary skin -> full original texture
    // (M9.3: the lobe release no longer scales this shared guard wholesale; it
    // acts crease-selectively on the luma path below, so pores stay original.)
    const bHr=bR[i]-bRl[i], bHg=bG[i]-bGl[i], bHb=bB[i]-bBl[i];
    const aHr=aR[i]-aRl[i], aHg=aG[i]-aGl[i], aHb=aB[i]-aBl[i];
    const detHr=aHr+(bHr-aHr)*g, detHg=aHg+(bHg-aHg)*g, detHb=aHb+(bHb-aHb)*g;
    // per-channel (M5.1) delta: AI low band + guarded original texture, per RGB
    const cdR=(aRl[i]-bRl[i])+(detHr-bHr);
    const cdG=(aGl[i]-bGl[i])+(detHg-bHg);
    const cdB=(aBl[i]-bBl[i])+(detHb-bHb);
    if(clock<=0){
      dR[i]=cdR; dG[i]=cdG; dB[i]=cdB;
    } else {
      // M5.2 chroma-locked delta: the LUMINANCE version of the same frequency-
      // separation, added equally to R,G,B. Adding an equal scalar to all three
      // channels preserves Cb/Cr exactly, so the patient's skin colour is held
      // while the AI's volume (a luminance effect) still shows. (aLowLuma -
      // bLowLuma) is exactly D[i], already computed for the guard.
      const oYl=0.299*bRl[i]+0.587*bGl[i]+0.114*bBl[i];
      const aYl=0.299*aRl[i]+0.587*aGl[i]+0.114*aBl[i];
      const oY =0.299*bR[i] +0.587*bG[i] +0.114*bB[i];
      const aY =0.299*aR[i] +0.587*aG[i] +0.114*aB[i];
      const oYh=oY-oYl, aYh=aY-aYl;
      // M9.4 (v39): micro-texture-protected guard. The guard reduction (1-g)
      // only applies where the pixel carries real structure in either image;
      // pore-scale pixels (both high bands shallow) keep the original texture
      // unconditionally, so the AI's soft fill can never replace pores no
      // matter how hard the guard fires along the AI's border shading.
      const structW=smoothstep(GUARD_DETAIL_LO, GUARD_DETAIL_HI, Math.max(Math.abs(oYh), Math.abs(aYh)));
      let gY=1-(1-g)*structW;
      // M9.3 (v38): crease-selective lobe release. Inside the jowl lobes the
      // guard is scaled down ONLY on dark high-frequency structure (the fold
      // line), gated by depth via JOWL_CREASE_LO..HI. Pores and fine texture
      // (shallow |oYh|) keep the original at every intensity, which removes the
      // v36 high-slider softness; the fold is still erased where the AI
      // flattened it (release open -> detY ~ aYh ~ 0 -> the bright correction
      // -oYh passes the darkening gate and cancels the crease).
      if(rel && rel[i]>0 && oYh<0){
        const creaseW=smoothstep(JOWL_CREASE_LO, JOWL_CREASE_HI, -oYh);
        if(creaseW>0) gY*=(1-Math.min(1,rel[i])*creaseW);
      }
      const detY=aYh+(oYh-aYh)*gY;
      // Broad tone change from the AI volume. Real Sculptra lightens skin (glow)
      // and does not darken it, so floor any darkening of the broad tone and add
      // a gentle uniform glow lift. Texture (the high-band term below) and chroma
      // are untouched, so spots, pores, and pigment all stay; only the broad
      // luminance moves, and only upward.
      let lowShift = aYl - oYl;
      // M9.8: keep midK of the patient's own mid band (deep volume still moves
      // with the AI). kEff is suppressed inside the jowl release lobes so the
      // fold erasure is never undone. midK 0 leaves this line a no-op.
      if(YoM){
        const kEff = midK * (rel ? (1 - Math.min(1, rel[i])) : 1);
        if(kEff > 0) lowShift -= kEff * ((aYl - YaM[i]) - (oYl - YoM[i]));
      }
      if(lowShift < -darkFloor) lowShift = -darkFloor;
      // M6.3: soft-knee the broad brightening so the response gain amplifies
      // shading structure, not flat brightness (see SCULPTRA_BRIGHT_CAP_FULL).
      // M10.6: in the jaw-continuity band, tighten the cap toward jawTightCap so
      // the lower-lateral cheek cannot pull brighter than the jaw below it. The
      // tanh self-gates: a modest lift passes a tighter cap nearly unchanged; an
      // extreme lift is clamped. Upper/mid cheek (jawFeather 0) keeps full cap.
      else if(brightCap > 0 && lowShift > 0){
        let capEff = brightCap;
        if(jawFeather){
          const fw = jawFeather[i];
          if(fw > 0) capEff = brightCap + (jawTightCap - brightCap) * fw;
        }
        if(capEff <= 0) lowShift = 0;
        else lowShift = capEff*Math.tanh(lowShift/capEff);
      }
      lowShift += glow;
      // High-frequency band. Brightening passes; darkening (a fake shadow the
      // guard would otherwise paint at the jaw/edge) is scaled down. The
      // patient's real shadows are untouched because they live in the original
      // (b); this only governs what the AI is allowed to ADD.
      let highTerm = detY - oYh;
      if(highTerm < 0) highTerm *= highDark;
      const dY = lowShift + highTerm;  // floored+glowed low band + non-darkening high band
      dR[i]=cdR*(1-clock)+dY*clock;
      dG[i]=cdG*(1-clock)+dY*clock;
      dB[i]=cdB*(1-clock)+dY*clock;
    }
  }
  return {dR,dG,dB};
}

// ---- M6 geometry engine: frontal lift warp ---------------------------------
// First slice of the M6 warp-first geometry engine. Sculptra's most credible
// frontal change is a LIFT (reversal of descent): the jowl and lower lateral
// face re-drape upward and the midface regains support. A lift is pure 2D
// displacement, so it is done by moving the patient's OWN pixels: texture,
// pores, pigment, and the photo's real lighting travel with the tissue, which
// is the photographic credibility no painted or AI-invented shading can
// guarantee. Light and convexity (temple, glow, projection shading) remain the
// masked AI's job via the chroma-locked luminance delta; the warp only moves
// what already exists. Geometry for displacement, AI for light.
//
// Scope and gating (this slice):
//   - Sculptra 'full' scope only, FRONTAL view only (detectPose gate). Oblique
//     and HA chin/jaw keep M5 behavior untouched.
//   - Applied to the COMPOSITE BASE, not the image sent to the AI. The AI still
//     edits the unwarped photo; its smooth luminance delta is added on top. The
//     delta is low-frequency, so the few-pixel offset between the warped base
//     and the unwarped delta is invisible.
//   - The slider scales the warp and the AI delta together: one response
//     control dials geometry and light as a unit, and 0 is exactly the original.
//   - The face silhouette NEVER moves: displacement fades to zero inside the
//     face-oval edge band, so no background is ever pulled into the face and
//     the outline stays pixel-identical (M5b export alignment is preserved).
//   - Fail-safe everywhere: any error, missing landmark, or non-frontal pose
//     disables the warp and the pipeline behaves exactly as M5.
//
// Tuning (the clinical correction loop; magnitudes are at FULL strength, which
// the slider now reaches since the 70 cap was removed in M6.2):
//   WARP_JOWL_LIFT     upward jowl/prejowl re-drape, fraction of face height.
//   WARP_JOWL_IN       inward (toward midline) component at the jowl, fraction
//                      of face width: the lift-and-narrow read. Keep small.
//   WARP_MIDFACE_LIFT  upward midface/submalar re-drape, fraction of face height.
//   WARP_*_SIGMA       kernel breadth, fraction of face width.
//   WARP_EDGE_FADE     band inside the face oval over which displacement fades
//                      to zero, fraction of face width.
// M6.2 calibration pass: magnitudes roughly doubled in effective terms. The
// real before/after pairs show genuine contour change (jowl lift, midface
// re-drape) that the M6.1 values, further attenuated by the old 0.7 slider cap,
// could not reach. The slider now spans the full 0..1, so these are the true
// full-strength figures.
// v51 jowl fix: WARP_JOWL_SIGMA 0.085->0.115 (wider kernel reduces hard tonal
// edge at inferior boundary), WARP_JOWL_LIFT 0.026->0.020 (gentler magnitude
// so the re-drape reads as a natural lift rather than a puffed lower face).
// Root cause: tight sigma created a sharp pixel-displacement boundary at the
// jowl-shadow edge; AI shading across that boundary reads as an artifact arc
// at both frontal and oblique gonial angles.
const WARP_JOWL_LIFT     = 0.020; // v51: 0.026 -> 0.020
const WARP_JOWL_IN       = 0.011;
const WARP_JOWL_SIGMA    = 0.115; // v51: 0.085 -> 0.115
const WARP_MIDFACE_LIFT  = 0.017;
const WARP_MIDFACE_SIGMA = 0.12;
const WARP_EDGE_FADE     = 0.06;

// v53: Sculptra lift warp saturates at SCULP_LIFT_SAT so Strong-response
// artifacts (zygoma disc, gonial shadow) never reach the exported image.
// Expected band tops at ~0.62; cap at 0.60 keeps the full Expected range.
// One-constant reversal to restore Strong: set to 1.0.
// v70: raised 0.60 -> 0.75. Real-world results show significantly more jowl
// correction and border suspension than current warp produces. 0.60 was
// saturating the lift field too early, capping the Strong-response warp
// before it reached the clinical result level.
const SCULP_LIFT_SAT = 0.75;

// M10.2: mandibular border suspension kernels (oblique only).
// Three point kernels along the near-side prejowl-to-gonion polyline, each
// carrying a superior + slightly inward vector. Displaces pixels upward along
// the border so the jowl reads as suspended into the mandibular line --
// the chin-to-gonion arc that real Sculptra strong responders show.
// Narrow sigma (tight to the border) so the kernel does not bleed into the
// jowl shadow below. Superior vector means displacement moves away from the
// shadow, so no shade-discontinuity artifact (unlike the old frontal jowl
// kernel which displaced toward the shadow boundary).
const SCULP_BORDER_UP  = 0.018; // superior component, fraction of faceH
const SCULP_BORDER_IN  = 0.006; // inward component, fraction of W (slight medial)
const SCULP_BORDER_SIG = 0.055; // kernel breadth, fraction of W (tight to border)

// M10.1 (v47): oblique Sculptra cheek/midface projection kernels.
// FIRST CALIBRATION LEVER: SCULP_ZYGOMA_OUT -- the lateral magnitude that drives
// the zygomatic arch highlight. Increase to push the arch further; decrease if
// the highlight reads as a painted disc rather than a natural convex form.
// Other levers in order of expected need:
//   SCULP_MIDFACE_ANT  -- anterior fill in the ogee zone; increase if the
//                         mid-cheek plane still reads flat between arch and fold.
//   SCULP_ZYGOMA_UP    -- superior component; increase slightly if the arch
//                         highlight needs to shift higher toward the orbital rim.
//   SCULP_ZYGOMA_SIG   -- kernel breadth; increase if the highlight is too focal,
//                         decrease if it bleeds into the temple or eye zone.
//   SCULP_MIDFACE_SIG  -- midface kernel breadth; increase for a more diffuse fill.
//   SCULP_CAPSULE      -- capsule run; decrease toward 0 for a pure Gaussian.
// M10.1 (v48): SCULP_ZYGOMA_OUT 0.022->0.032, SCULP_MIDFACE_ANT 0.014->0.020.
// M10.1 (v49): lateral cut (0.032->0.018), superior raised (0.008->0.014),
//   anterior raised (0.020->0.026), midface sigma widened (0.16->0.20).
//   Clinical finding: Expected looked better than Strong -- lateral was dominant
//   and read as width not fullness. Anterior + superior are the real channels.
// M10.1 (v50): continuing anterior push. Real case comparison (Case A left 45)
//   shows arch highlight still too diffuse and midface fill still underweight vs
//   real Sculptra result. Raising SCULP_MIDFACE_ANT 0.026->0.034 and
//   SCULP_ZYGOMA_UP 0.014->0.018. Lateral held at 0.018 (no change).
//   Also: frontal temple kernel added to buildLiftField frontal branch (M10
//   scope, assessed as one-round addition). VIEW_TQ_MAX_DEG raised 50->60 so
//   photos at ~51 degrees are accepted (one-degree rejection was too tight).
const SCULP_ZYGOMA_OUT  = 0.026; // v70: 0.018->0.026 (real-world lateral projection recalibration)
const SCULP_ZYGOMA_UP   = 0.018; // v50: 0.014 -> 0.018 (more superior lift)
const SCULP_ZYGOMA_SIG  = 0.10;  // kernel breadth, fraction of W
const SCULP_MIDFACE_ANT = 0.044; // v70: 0.034->0.044 (real-world anterior midface recalibration)
const SCULP_MIDFACE_SIG = 0.20;  // midface kernel breadth, fraction of W
const SCULP_CAPSULE     = 0.80;  // capsule run factor for zygoma kernel

// Jowl kernel anchor landmarks: gonion and prejowl per side; the kernel sits
// between them, nudged up onto the jowl pad itself.
const GONION  = { r:172, l:397 };
const PREJOWL = { r:176, l:400 };

// Build the lift sample-offset field at FULL strength.
// Returns { sx, sy, x0, y0, x1, y1, maxPx } or null if landmarks are missing or
// the field is empty. sx/sy are BACKWARD-map offsets: the warped image at (x,y)
// samples the original at (x + sx*t, y + sy*t). Tissue moving up by v means the
// content came from below, so the offset is the inverse of the forward
// displacement (exact enough at these few-pixel magnitudes).
// M10.1: pose parameter added. At frontal the function builds the existing jowl +
// midface re-drape kernels (M6, untouched). At three_quarter it builds the new
// zygomatic arch projection + anterior midface kernels. At other views returns null.
function buildLiftField(L, w, h, pose){
  const lm = L.map(p=>({x:p.x*w, y:p.y*h}));
  const p10=lm[10], p152=lm[152], zr=lm[ZYGION.r], zl=lm[ZYGION.l];
  if(!p10||!p152||!zr||!zl) return null;
  const dirUp = norm(sub(p10, p152));
  const dirOut = { x:-dirUp.y, y:dirUp.x };
  const W = Math.abs(dot(sub(zl, zr), dirOut)) || 1;
  const faceH = (dot(sub(p10, p152), dirUp)) || 1;

  // Silhouette guard: filled face oval, blurred by the edge-fade band, so the
  // displacement is full in the interior and exactly zero at and beyond the
  // outline. The outline therefore cannot move.
  const fadePx = Math.max(2, WARP_EDGE_FADE*W);
  const oc=document.createElement("canvas"); oc.width=w; oc.height=h;
  const octx=oc.getContext("2d",{willReadFrequently:true});
  octx.fillStyle="#000"; octx.fillRect(0,0,w,h);
  octx.fillStyle="#fff"; octx.beginPath();
  FACE_OVAL.forEach((idx,k)=>{ const p=lm[idx]; if(!p) return; if(k===0) octx.moveTo(p.x,p.y); else octx.lineTo(p.x,p.y); });
  octx.closePath(); octx.fill();
  octx.filter="blur("+fadePx+"px)"; octx.drawImage(oc,0,0); octx.filter="none";
  const ovalA=octx.getImageData(0,0,w,h).data;

  // Feature guard: eyes, brows, nose, and lips must not be dragged by the lift.
  // Slightly larger discs and a wider blur than the mask's protection, because
  // a moved feature is worse than a slightly smaller lift footprint.
  const pc=document.createElement("canvas"); pc.width=w; pc.height=h;
  const pctx=pc.getContext("2d",{willReadFrequently:true});
  pctx.fillStyle="#000"; pctx.fillRect(0,0,w,h);
  pctx.fillStyle="#fff";
  const rDisc=0.026*W;
  for(const idx of PROTECTED){ const p=lm[idx]; if(!p) continue;
    pctx.beginPath(); pctx.arc(p.x,p.y,rDisc,0,7); pctx.fill(); }
  pctx.filter="blur("+(0.05*W)+"px)"; pctx.drawImage(pc,0,0); pctx.filter="none";
  const protA=pctx.getImageData(0,0,w,h).data;

  // Displacement kernels, both sides. Each kernel is a Gaussian bump carrying a
  // fixed displacement vector; the field is their sum, attenuated by the guards.
  const kernels=[];

  const isOblique = pose && pose.view === 'three_quarter'
    && (pose.nearSide === 'left' || pose.nearSide === 'right');

  if(isOblique){
    // M10.1: oblique branch. Kernels target the near-side (camera-facing) cheek
    // only -- that is where the arch highlight and anterior midface projection are
    // visible at a three-quarter view. The far side is foreshortened and the oval
    // guard suppresses out-of-oval displacement in any case.
    //
    // Anterior direction sign: same derivation as buildChinProjectionField (v32).
    // The nose tip is displaced anteriorly relative to the bridge; its lateral
    // offset gives the forward direction unambiguously.
    const tip = lm[1] || lm[4];
    const bridge = lm[168] || p10;
    let antSign = tip ? (Math.sign(dot(sub(tip, bridge), dirOut)) || 0) : 0;
    if(!antSign){
      const leftSign = Math.sign(dot(sub(lm[454], p152), dirOut)) || 1;
      antSign = (pose.nearSide === 'left') ? -leftSign : leftSign;
    }
    const antDir = mul(dirOut, antSign);

    // Near-side lateral sign (outward from midline on the camera-facing side).
    const nearSide = pose.nearSide;
    const nearZy = (nearSide === 'right') ? lm[ZYGION.r] : lm[ZYGION.l];
    const nearZyApex = (nearSide === 'right') ? lm[123] : lm[352]; // zygomatic arch apex
    if(!nearZy) return null;
    const latSign = Math.sign(dot(sub(nearZy, p152), dirOut)) || (nearSide === 'right' ? -1 : 1);
    const latDir = mul(dirOut, latSign);

    // (1) Zygoma arch projection kernel.
    // Anchor: the zygomatic arch apex (lm[123]/352). If the landmark is absent
    // (older MediaPipe models), fall back to the zygion with a small superior
    // and lateral nudge toward the arch apex position.
    const zyApexC = nearZyApex
      ? nearZyApex
      : add(nearZy, add(mul(dirUp, 0.04*faceH), mul(latDir, 0.02*W)));
    const zygomaV = add(mul(latDir, SCULP_ZYGOMA_OUT*W), mul(dirUp, SCULP_ZYGOMA_UP*faceH));
    const sigZ = SCULP_ZYGOMA_SIG*W;
    // Capsule: extend in the displacement direction so the plateau translates
    // rigidly through and past the arch, not as a feathered dome.
    const vLen = Math.hypot(zygomaV.x, zygomaV.y) || 1e-6;
    const runZ = vLen * SCULP_CAPSULE;
    kernels.push({
      ax: zyApexC.x, ay: zyApexC.y,
      bx: zyApexC.x + (zygomaV.x/vLen)*runZ,
      by: zyApexC.y + (zygomaV.y/vLen)*runZ,
      twoSig: 2*sigZ*sigZ, vx: zygomaV.x, vy: zygomaV.y,
      capsule: true
    });

    // (2) Anterior midface kernel (ogee zone fill).
    // Anchor: midpoint between the near-side zygion and the near-side ala,
    // approximating the ogee inflection where anterior projection is most
    // visible on a deflated face.
    const nearAla = (nearSide === 'right') ? lm[ALA.r] : lm[ALA.l];
    const ogeeC = nearAla
      ? lerp(nearZy, nearAla, 0.55)
      : add(nearZy, add(mul(dirUp, -0.12*faceH), mul(antDir, 0.03*W)));
    const midfaceV = mul(antDir, SCULP_MIDFACE_ANT*W);
    const sigM = SCULP_MIDFACE_SIG*W;
    kernels.push({
      ax: ogeeC.x, ay: ogeeC.y, bx: ogeeC.x, by: ogeeC.y, // point kernel (no capsule run)
      twoSig: 2*sigM*sigM, vx: midfaceV.x, vy: midfaceV.y,
      capsule: false
    });

    // (3) M10.2: mandibular border suspension kernels.
    // Three point kernels at 25/50/75% along the near-side prejowl-to-gonion
    // polyline. Vector: superior + slightly inward. Displaces border pixels
    // upward so the jowl reads as lifted into the mandibular line.
    // Superior vector moves away from the jowl shadow below, so no shade
    // discontinuity (safe unlike the old frontal jowl kernel).
    const nearGonion  = (nearSide === 'right') ? lm[GONION.r]  : lm[GONION.l];
    const nearPrejowl = (nearSide === 'right') ? lm[PREJOWL.r] : lm[PREJOWL.l];
    if(nearGonion && nearPrejowl){
      const inwB = { x: -latSign*dirOut.x, y: -latSign*dirOut.y }; // toward midline
      const borderV = {
        x: dirUp.x*SCULP_BORDER_UP*faceH + inwB.x*SCULP_BORDER_IN*W,
        y: dirUp.y*SCULP_BORDER_UP*faceH + inwB.y*SCULP_BORDER_IN*W
      };
      const sigB = SCULP_BORDER_SIG*W;
      const twoSigB = 2*sigB*sigB;
      for(const frac of [0.25, 0.50, 0.75]){
        const bc = lerp(nearPrejowl, nearGonion, frac);
        kernels.push({
          ax: bc.x, ay: bc.y, bx: bc.x, by: bc.y,
          twoSig: twoSigB, vx: borderV.x, vy: borderV.y,
          capsule: false
        });
      }
    }

    // (4) M10.5 v68: NLF anterior push kernel.
    // The nasolabial fold at oblique view is a shadow crease running from the
    // near-side ala down toward the commissure. Pushing the midpoint of this
    // zone anteriorly (toward the camera) shallows the crease shadow by bringing
    // the fold wall forward -- the same mechanism as real Sculptra lateral support
    // softening the fold secondarily. The kernel anchors at the midpoint between
    // the near-side ala and near-side commissure. Vector is anterior only (no
    // superior component -- the fold softens by advancing, not by lifting).
    // SCULP_NLF_ANT: conservative magnitude. The NLF constraint in the prompt
    // prohibits deepening; this kernel ensures the warp reinforces that by
    // physically moving the fold zone forward.
    // One-constant reversal: set SCULP_NLF_ANT to 0.
    const SCULP_NLF_ANT = 0.016; // fraction of W, anterior push at the NLF midpoint
    const SCULP_NLF_SIG = 0.12;  // kernel breadth, fraction of W
    const nearCom = (nearSide === 'right') ? lm[COMMISSURE.r] : lm[COMMISSURE.l];
    if(nearAla && nearCom){
      const nlfC = lerp(nearAla, nearCom, 0.45); // slightly above midpoint, where shadow is deepest
      const nlfV = mul(antDir, SCULP_NLF_ANT*W);
      const sigNLF = SCULP_NLF_SIG*W;
      kernels.push({
        ax: nlfC.x, ay: nlfC.y, bx: nlfC.x, by: nlfC.y,
        twoSig: 2*sigNLF*sigNLF, vx: nlfV.x, vy: nlfV.y,
        capsule: false
      });
    }

  } else {
    // Frontal branch: midface re-drape and temple convexity kernels.
    // v52: jowl re-drape kernel REMOVED from frontal. The kernel was creating
    // a tonal discontinuity artifact at the inferior jowl boundary on frontal
    // because the AI shadow and the warp displacement were operating on the same
    // zone with contradictory assumptions. The midface and temple kernels are
    // retained -- they do not cross a shadow boundary and are artifact-free.
    // If the frontal jowl improvement reads as clinically insufficient without
    // the kernel, shade reconciliation (option 2) is the next step.
    const SCULP_TEMPLE_UP  = 0.014;
    const SCULP_TEMPLE_OUT = 0.008;
    const SCULP_TEMPLE_SIG = 0.13;
    for(const s of ["r","l"]){
      const zy=lm[ZYGION[s]];
      if(!zy) continue;
      const sgn=Math.sign(dot(sub(zy,p152),dirOut)) || (s==="r"?-1:1);
      const inw={ x:-sgn*dirOut.x, y:-sgn*dirOut.y };
      const outw={ x:sgn*dirOut.x, y:sgn*dirOut.y };
      // Midface/submalar re-drape: straight up, centered below the cheek apex.
      const midC=add(add(zy, mul(dirUp, -0.10*faceH)), mul(inw, 0.02*W));
      const sigM=WARP_MIDFACE_SIGMA*W;
      kernels.push({ ax:midC.x, ay:midC.y, bx:midC.x, by:midC.y, twoSig:2*sigM*sigM,
        vx: dirUp.x*WARP_MIDFACE_LIFT*faceH,
        vy: dirUp.y*WARP_MIDFACE_LIFT*faceH, capsule:false });
      // Temple convexity kernel: upward + slight lateral at the temporal oval.
      const to=lm[TEMPLE_OVAL[s]];
      if(to){
        const tempC=add(to, mul(inw, 0.01*W));
        const sigT=SCULP_TEMPLE_SIG*W;
        kernels.push({ ax:tempC.x, ay:tempC.y, bx:tempC.x, by:tempC.y, twoSig:2*sigT*sigT,
          vx: dirUp.x*SCULP_TEMPLE_UP*faceH + outw.x*SCULP_TEMPLE_OUT*W,
          vy: dirUp.y*SCULP_TEMPLE_UP*faceH + outw.y*SCULP_TEMPLE_OUT*W, capsule:false });
      }
    }
  }

  if(!kernels.length) return null;

  const N=w*h;
  const sx=new Float32Array(N), sy=new Float32Array(N);
  let x0=w, y0=h, x1=-1, y1=-1, maxPx=0;
  for(let y=0,i=0;y<h;y++){
    for(let x=0;x<w;x++,i++){
      const guard=(ovalA[i*4]/255)*(1-(protA[i*4]/255));
      if(guard<=0.01) continue;
      let dx=0, dy=0;
      for(let k=0;k<kernels.length;k++){
        const K=kernels[k];
        // Capsule kernels use distance-to-segment; point kernels use distance-to-point.
        const ex=x-K.ax, ey=y-K.ay;
        let gv;
        if(K.capsule && (K.bx !== K.ax || K.by !== K.ay)){
          const dd=distToSeg(x, y, {x:K.ax, y:K.ay}, {x:K.bx, y:K.by});
          gv=Math.exp(-(dd*dd)/K.twoSig);
        } else {
          gv=Math.exp(-(ex*ex+ey*ey)/K.twoSig);
        }
        dx+=K.vx*gv; dy+=K.vy*gv;
      }
      // (dx,dy) is the forward tissue displacement; the backward sample offset
      // is its inverse, attenuated by the guards.
      const ox=-dx*guard, oy=-dy*guard;
      const mag=Math.hypot(ox,oy);
      if(mag<0.25) continue;
      sx[i]=ox; sy[i]=oy;
      if(mag>maxPx) maxPx=mag;
      if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y;
    }
  }
  if(x1<0) return null;
  const pad=Math.ceil(maxPx)+2;
  x0=Math.max(0,x0-pad); y0=Math.max(0,y0-pad);
  x1=Math.min(w-1,x1+pad); y1=Math.min(h-1,y1+pad);
  return { sx, sy, x0, y0, x1, y1, maxPx };
}

// Re-sample the warped base wb from the original b inside the field's bounding
// box at strength t (0..1). wb starts as a copy of b, and every bbox pixel is
// rewritten each call (offset scaled by t, bilinear), so any t, including 0 and
// going back DOWN the slider, is exact with no residue. Pixels outside the bbox
// are untouched originals by construction.
function applyLiftWarp(wb, b, w, h, f, t){
  if(!f) return;
  if(f.bicubic) return applyLiftWarpBicubic(wb, b, w, h, f, t); // M9.2: chin_jaw
  const s = Math.max(0, Math.min(1, t));
  const sx=f.sx, sy=f.sy;
  for(let y=f.y0; y<=f.y1; y++){
    const row=y*w;
    for(let x=f.x0; x<=f.x1; x++){
      const i=row+x, p=i*4;
      const ox=sx[i], oy=sy[i];
      if(ox===0 && oy===0){ wb[p]=b[p]; wb[p+1]=b[p+1]; wb[p+2]=b[p+2]; continue; }
      let fx=x+ox*s, fy=y+oy*s;
      if(fx<0) fx=0; else if(fx>w-1) fx=w-1;
      if(fy<0) fy=0; else if(fy>h-1) fy=h-1;
      const xi=fx|0, yi=fy|0;
      const x2=xi+1<w?xi+1:xi, y2=yi+1<h?yi+1:yi;
      const ax=fx-xi, ay=fy-yi;
      const w00=(1-ax)*(1-ay), w10=ax*(1-ay), w01=(1-ax)*ay, w11=ax*ay;
      const p00=(yi*w+xi)*4, p10=(yi*w+x2)*4, p01=(y2*w+xi)*4, p11=(y2*w+x2)*4;
      wb[p]  =b[p00]*w00+b[p10]*w10+b[p01]*w01+b[p11]*w11;
      wb[p+1]=b[p00+1]*w00+b[p10+1]*w10+b[p01+1]*w01+b[p11+1]*w11;
      wb[p+2]=b[p00+2]*w00+b[p10+2]*w10+b[p01+2]*w01+b[p11+2]*w11;
    }
  }
}

// M9.2 (v37): Catmull-Rom bicubic variant of applyLiftWarp, used when the
// field carries bicubic:true (the chin_jaw projection warp). Bilinear averages
// 4 pixels at every fractional offset, which compounds with the decay zone's
// local magnification into the chin softness seen at oblique Strong; the
// 16-tap Catmull-Rom kernel preserves edges and pore-scale detail through the
// same map. Overshoot is clamped by the Uint8ClampedArray write. The Sculptra
// lift never sets the flag, so its approved output is bit-identical to v36.
function applyLiftWarpBicubic(wb, b, w, h, f, t){
  const s = Math.max(0, Math.min(1, t));
  const sx=f.sx, sy=f.sy;
  for(let y=f.y0; y<=f.y1; y++){
    const row=y*w;
    for(let x=f.x0; x<=f.x1; x++){
      const i=row+x, p=i*4;
      const ox=sx[i], oy=sy[i];
      if(ox===0 && oy===0){ wb[p]=b[p]; wb[p+1]=b[p+1]; wb[p+2]=b[p+2]; continue; }
      let fx=x+ox*s, fy=y+oy*s;
      if(fx<0) fx=0; else if(fx>w-1) fx=w-1;
      if(fy<0) fy=0; else if(fy>h-1) fy=h-1;
      const xi=Math.floor(fx), yi=Math.floor(fy);
      const ax=fx-xi, ay=fy-yi;
      const ax2=ax*ax, ax3=ax2*ax;
      const wx0=-0.5*ax3+ax2-0.5*ax, wx1=1.5*ax3-2.5*ax2+1,
            wx2=-1.5*ax3+2*ax2+0.5*ax, wx3=0.5*ax3-0.5*ax2;
      const ay2=ay*ay, ay3=ay2*ay;
      const wy0=-0.5*ay3+ay2-0.5*ay, wy1=1.5*ay3-2.5*ay2+1,
            wy2=-1.5*ay3+2*ay2+0.5*ay, wy3=0.5*ay3-0.5*ay2;
      const xA=xi-1<0?0:xi-1, xB=xi, xC=xi+1>w-1?w-1:xi+1, xD=xi+2>w-1?w-1:xi+2;
      const yA=yi-1<0?0:yi-1, yB=yi, yC=yi+1>h-1?h-1:yi+1, yD=yi+2>h-1?h-1:yi+2;
      let r=0, g=0, bb=0;
      const rows=[yA,yB,yC,yD], wys=[wy0,wy1,wy2,wy3];
      for(let k=0;k<4;k++){
        const ro=rows[k]*w;
        const pA=(ro+xA)*4, pB=(ro+xB)*4, pC=(ro+xC)*4, pD=(ro+xD)*4;
        const wy=wys[k];
        r +=wy*(wx0*b[pA]  +wx1*b[pB]  +wx2*b[pC]  +wx3*b[pD]);
        g +=wy*(wx0*b[pA+1]+wx1*b[pB+1]+wx2*b[pC+1]+wx3*b[pD+1]);
        bb+=wy*(wx0*b[pA+2]+wx1*b[pB+2]+wx2*b[pC+2]+wx3*b[pD+2]);
      }
      wb[p]=r; wb[p+1]=g; wb[p+2]=bb; // clamped by the typed array
    }
  }
}

// Gate + build the lift field for a compositor run. M10.1: fires for both
// frontal and three_quarter views. out_of_range returns null (unchanged).
// opts.warp === false is the A/B escape hatch. Never throws.
async function maybeBuildLift(beforeImg, landmarks, w, h, scope, opts){
  if(scope !== 'full') return null;
  if(opts && opts.warp === false) return null;
  try {
    const pose = await detectPose(beforeImg);
    if(!pose || (pose.view !== 'frontal' && pose.view !== 'three_quarter')){
      console.log('%c[Visualize] M6/M10.1 lift warp skipped: view is ' + ((pose && pose.view) || 'unknown') + ' (frontal and three_quarter only).', 'color:#888');
      return null;
    }
    const f = buildLiftField(landmarks, w, h, pose);
    if(f){
      console.log('%c[Visualize] M10.1 lift warp ACTIVE (' + pose.view + (pose.view === 'three_quarter' ? ', near side ' + pose.nearSide : '') + '): max displacement ' + f.maxPx.toFixed(1) + 'px at full strength.', 'color:#2e7d32;font-weight:bold');
    } else {
      console.warn('[Visualize] M10.1 lift warp unavailable (landmarks incomplete); compositing without it.');
    }
    return f;
  } catch(e){
    console.warn('[Visualize] M10.1 lift warp failed to build; compositing without it.', e);
    return null;
  }
}

// M8.2: low-frequency luminance of the ORIGINAL, the reference light field for
// the warp shading reconciliation. Built once per compositor (reuses blurAlpha).
function buildLowLuma(b, w, h, W){
  const N=w*h, m=new Float32Array(N);
  for(let i=0,p4=0;i<N;i++,p4+=4){ m[i]=0.299*b[p4]+0.587*b[p4+1]+0.114*b[p4+2]; }
  return blurAlpha(m, w, h, Math.max(2, Math.round(WARP_SHADE_BLUR*W)));
}

// M8.2: two-sided shading reconciliation inside the warped band.
// o = composited+warped pixels (mutated), lowY = buildLowLuma of the original,
// f = the warp field (its sx/sy mark moved destinations, its bbox bounds the pass).
// M10.5 v68: added symmetric dark-undershoot correction. The original pass only
// corrected pixels that arrived too bright (chin skin displacing over a darker
// zone). The oblique chin artifact (dark patch below chin tip) is the inverse:
// chin shadow pixels displacing over a lighter neck zone and arriving too dark.
// The undershoot correction brightens these back toward the destination light
// field, gated on the destination being lighter than the arriving pixel by more
// than WARP_SHADE_MARGIN. Both directions are one-sided and pull-rate controlled.
// M12.1: applyWarpShadeFix gets its own luma gate, separate from GATE_LUMA_LO/HI
// (10/26). The outline gate correctly prevents AI painting on dark background
// pixels. But applyWarpShadeFix was reusing it -- so when warped bright chin
// skin landed on the dark neck zone (luma < 26), subj evaluated to ~0 and the
// bright overshoot correction was silently skipped. That uncorrected bright patch
// on the dark neck is the blurry rectangular artifact confirmed by Test 4.
// Lowering the shade fix gate to 4/14 fires the correction on dark-destination
// pixels too. Sculptra is unaffected: its lift warp never displaces chin skin
// onto a dark background zone.
const WARP_SHADE_GATE_LO = 4;   // dedicated shade-fix gate (was: GATE_LUMA_LO=10)
const WARP_SHADE_GATE_HI = 14;  // dedicated shade-fix gate (was: GATE_LUMA_HI=26)
const WARP_SHADE_DARK_PULL = 0.55;
function applyWarpShadeFix(o, lowY, f, w){
  for(let y=f.y0; y<=f.y1; y++){
    const row=y*w;
    for(let x=f.x0; x<=f.x1; x++){
      const i=row+x;
      const mag=Math.abs(f.sx[i])+Math.abs(f.sy[i]);
      if(mag<0.5) continue;                       // outside the moved band
      const Yo=lowY[i];
      const subj=smoothstep(WARP_SHADE_GATE_LO, WARP_SHADE_GATE_HI, Yo);
      if(subj<=0) continue;                       // pure black backdrop: skip
      const p4=i*4;
      const Yr=0.299*o[p4]+0.587*o[p4+1]+0.114*o[p4+2];
      const band=Math.min(1, mag/2);              // feather at the band edge
      const excess=Yr-(Yo+WARP_SHADE_MARGIN);
      if(excess>0){
        // Bright correction: displaced pixels too bright for destination
        const target=Yr - WARP_SHADE_PULL*excess*subj*band;
        const fct=target/Math.max(1, Yr);
        o[p4]*=fct; o[p4+1]*=fct; o[p4+2]*=fct;
      } else {
        // Dark correction: displaced pixels too dark for destination (chin shadow on neck).
        // Only fires when destination Yo was appreciably brighter than arrived pixel Yr --
        // i.e., chin shadow landed on a zone that was lighter in the original. This
        // discriminates the artifact without a mag gate (the condition itself is specific).
        // M10.5 v69: removed the mag>8 gate (was wrong -- it blocked correction in the
        // transition band where the artifact actually lives) and raised pull to 0.55.
        const undershoot=Yo - WARP_SHADE_MARGIN - Yr;
        if(undershoot <= 0) continue;
        const addv = WARP_SHADE_DARK_PULL * undershoot * subj * band;
        o[p4]+=addv; o[p4+1]+=addv; o[p4+2]+=addv;
      }
    }
  }
}

// M9.2/M9.5: displacement-band self-unsharp on the warped result, weighted by
// the LOCAL STRETCH of the map (v40). Bicubic preserves detail through rigid
// translation; what thins detail is magnification in the kernel decay zone, so
// the weight is the offset field's Jacobian deviation (sum of absolute partial
// derivatives), with a small base term for plain fractional-offset softening.
// Luminance only, added equally to RGB (chroma locked). Zero outside the moved
// band; gated by blurred subject luma (backdrop, hair, and deep shadow are
// never haloed). WARP_SHARP_AMOUNT 0 disables for the A/B.
const WARP_SHARP_AMOUNT  = 0.7;   // ceiling; 0 = off (v40: 0.45 -> 0.7)
const WARP_SHARP_RADIUS  = 0.0035; // high-band cutoff, fraction of W (pore scale)
const WARP_SHARP_STRETCH = 0.25;  // local stretch at which the effect saturates
const WARP_SHARP_BASE    = 0.2;   // fraction applied at zero stretch inside the band
const WARP_SHARP_LUMA_LO = 22;    // blurred-luma dark gate: 0 at or below
const WARP_SHARP_LUMA_HI = 48;    // fully open above

function applyWarpSharpen(o, w, h, f, t, Wpx){
  if(!f || WARP_SHARP_AMOUNT <= 0 || !Wpx) return;
  const s = Math.max(0, Math.min(1, t));
  if(s <= 0) return;
  const N = w*h;
  const Y = new Float32Array(N);
  for(let i=0,p=0;i<N;i++,p+=4) Y[i]=0.299*o[p]+0.587*o[p+1]+0.114*o[p+2];
  const r = Math.max(1, Math.round(WARP_SHARP_RADIUS*Wpx));
  const Yl = blurAlpha(Y, w, h, r);
  const sx=f.sx, sy=f.sy;
  for(let y=f.y0; y<=f.y1; y++){
    const row=y*w;
    const yU=(y>f.y0? y-1 : y), yD=(y<f.y1? y+1 : y);
    for(let x=f.x0; x<=f.x1; x++){
      const i=row+x;
      const d=(Math.abs(sx[i])+Math.abs(sy[i]))*s;
      if(d < 0.75) continue;                      // outside the moved band
      const subj=smoothstep(WARP_SHARP_LUMA_LO, WARP_SHARP_LUMA_HI, Yl[i]);
      if(subj <= 0) continue;
      // Local stretch of the backward map (central differences, clamped at
      // the bounding box; the one-sided halving at the rim is harmless).
      const iL=row+(x>f.x0? x-1 : x), iR=row+(x<f.x1? x+1 : x);
      const iU=yU*w+x, iD=yD*w+x;
      const stretch=s*0.5*(Math.abs(sx[iR]-sx[iL])+Math.abs(sy[iD]-sy[iU])
                          +0.5*(Math.abs(sy[iR]-sy[iL])+Math.abs(sx[iD]-sx[iU])));
      const wS=WARP_SHARP_BASE+(1-WARP_SHARP_BASE)*Math.min(1, stretch/WARP_SHARP_STRETCH);
      const addv=WARP_SHARP_AMOUNT*wS*subj*(Y[i]-Yl[i]);
      if(addv===0) continue;
      const p4=i*4;
      o[p4]+=addv; o[p4+1]+=addv; o[p4+2]+=addv;  // clamped by the typed array
    }
  }
}

// M9.6 (v41): deterministic jawline definition. Draws the light architecture
// of a structural jawline onto the finished, warped composite: a narrow lit
// band just above the chin-to-gonion border and a shadow step just below it.
// The border polyline is taken from the landmarks and displaced by the warp
// field (first order: a point at q lands at q - s*offset(q)), so the light
// lands on the NEW border. Luminance only, added equally to RGB (chroma
// locked). Brightening is gated to lit subject (hair, backdrop, deep shadow
// never lifted); the shadow step is allowed to deepen the under-border region,
// which is exactly the step that makes a jawline read as rebuilt. Levers
// below; zero JAWDEF_BRIGHT and JAWDEF_DARK to disable the pass entirely.
const JAWDEF_BRIGHT  = 0;     // v44: retired at consultation levels (see header); was 9
const JAWDEF_DARK    = 0;     // v44: retired at consultation levels (see header); was 10
// M11.1 (v58): oblique-specific shadow step. At 45 degrees the border is
// viewed edge-on; the shadow reads as genuine underside shadow (not a drawn
// line), so the frontal retirement does not apply here. JAWDEF_BRIGHT_OBLIQUE
// stays 0 (brightening above the border still reads as a stroke at oblique);
// only the shadow below the new border is enabled. Levers: set
// JAWDEF_DARK_OBLIQUE to 0 to disable oblique shadow entirely (one-constant
// reversal), or raise toward 18 for a more defined step.
const JAWDEF_DARK_OBLIQUE  = 10;  // M11.1: shadow step below the displaced oblique border
const JAWDEF_BRIGHT_OBLIQUE = 0;  // stays 0: brightening above border reads as stroke even at oblique
const JAWDEF_W_IN    = 0.018; // bright band width above the border, fraction of W
const JAWDEF_W_OUT   = 0.014; // shadow band width below the border, fraction of W (v42: 0.028 -> 0.014,
                              // plus a hard 2.5 sigma cutoff so the step never smears onto neck/clothing)
const JAWDEF_GATE_LO = 14;    // brightening gate on current luma: 0 at or below
const JAWDEF_GATE_HI = 40;    // fully open above
// M9.8 (v43): illumination modulation. The pass samples the lit face just
// inside the border at each polyline vertex and scales the whole step by that
// local light, so the border light follows the photo's illumination instead of
// tracing a uniform drawn line. Below LIGHT_LO the step vanishes; above
// LIGHT_HI it runs at full strength.
const JAWDEF_LIGHT_LO = 35;
const JAWDEF_LIGHT_HI = 95;
const JAWDEF_LIGHT_IN = 2.2;  // sampling point: this many bright-sigmas inside the border
const JAWDEF_IDX     = [397,365,379,378,400,377,152,148,176,149,150,136,172]; // gonion -> chin -> gonion

function applyJawDefinition(o, w, h, L, f, t, Wpx, isOblique){
  // M11.1: at oblique, use oblique-specific constants (shadow only, no brightening).
  // At frontal both are 0 (retired v44); early-exit if both are zero.
  const dark   = isOblique ? JAWDEF_DARK_OBLIQUE   : JAWDEF_DARK;
  const bright = isOblique ? JAWDEF_BRIGHT_OBLIQUE : JAWDEF_BRIGHT;
  if((bright<=0 && dark<=0) || !f || !Wpx) return;
  const s=Math.max(0, Math.min(1, t));
  if(s<=0) return;
  const lm=L.map(p=>({x:p.x*w, y:p.y*h}));
  const p10=lm[10], p152=lm[152];
  if(!p10||!p152) return;
  const cFace={x:(p10.x+p152.x)/2, y:(p10.y+p152.y)/2};
  // Border polyline, displaced onto the warped border.
  const pts=[];
  for(const idx of JAWDEF_IDX){
    const p=lm[idx]; if(!p) continue;
    const xi=Math.max(0, Math.min(w-1, Math.round(p.x)));
    const yi=Math.max(0, Math.min(h-1, Math.round(p.y)));
    const i=yi*w+xi;
    pts.push({x:p.x - s*f.sx[i], y:p.y - s*f.sy[i]});
  }
  if(pts.length<2) return;
  const sigA=JAWDEF_W_IN*Wpx, sigB=JAWDEF_W_OUT*Wpx;
  // M9.8: per-vertex illumination of the face just inside the border (small
  // cross average on the warped composite), interpolated per pixel below.
  const vLum=new Float32Array(pts.length);
  for(let k=0;k<pts.length;k++){
    const p=pts[k];
    let ix=p.x+(cFace.x-p.x)/ (Math.hypot(cFace.x-p.x, cFace.y-p.y)||1) * JAWDEF_LIGHT_IN*sigA;
    let iy=p.y+(cFace.y-p.y)/ (Math.hypot(cFace.x-p.x, cFace.y-p.y)||1) * JAWDEF_LIGHT_IN*sigA;
    ix=Math.max(1, Math.min(w-2, Math.round(ix)));
    iy=Math.max(1, Math.min(h-2, Math.round(iy)));
    let acc=0;
    for(const [ox,oy] of [[0,0],[1,0],[-1,0],[0,1],[0,-1]]){
      const q4=((iy+oy)*w+(ix+ox))*4;
      acc+=0.299*o[q4]+0.587*o[q4+1]+0.114*o[q4+2];
    }
    vLum[k]=acc/5;
  }
  const twoSigA=2*sigA*sigA||1e-6, twoSigB=2*sigB*sigB||1e-6;
  const cutB=(2.5*sigB)*(2.5*sigB); // v42: hard stop for the shadow step
  const pad=3*Math.max(sigA, sigB);
  let x0=w, y0=h, x1=0, y1=0;
  for(const p of pts){
    if(p.x<x0)x0=p.x; if(p.x>x1)x1=p.x;
    if(p.y<y0)y0=p.y; if(p.y>y1)y1=p.y;
  }
  x0=Math.max(0,Math.floor(x0-pad)); x1=Math.min(w-1,Math.ceil(x1+pad));
  y0=Math.max(0,Math.floor(y0-pad)); y1=Math.min(h-1,Math.ceil(y1+pad));
  const pad2=pad*pad;
  for(let y=y0;y<=y1;y++){
    for(let x=x0;x<=x1;x++){
      // nearest border segment: distance, closest point, and direction
      let best=1e18, qx=0, qy=0, dirx=0, diry=0, segK=0, segU=0;
      for(let k=0;k+1<pts.length;k++){
        const A=pts[k], B=pts[k+1];
        const vx=B.x-A.x, vy=B.y-A.y;
        const L2=vx*vx+vy*vy||1e-6;
        let u=((x-A.x)*vx+(y-A.y)*vy)/L2;
        if(u<0)u=0; else if(u>1)u=1;
        const cx2=A.x+u*vx, cy2=A.y+u*vy;
        const dx=x-cx2, dy=y-cy2;
        const d2=dx*dx+dy*dy;
        if(d2<best){ best=d2; qx=cx2; qy=cy2; dirx=vx; diry=vy; segK=k; segU=u; }
      }
      if(best > pad2) continue;
      // signed side: normal oriented away from the face center = below border
      let nx=-diry, ny=dirx;
      if(nx*(qx-cFace.x)+ny*(qy-cFace.y) < 0){ nx=-nx; ny=-ny; }
      const sd=(x-qx)*nx+(y-qy)*ny;
      // M9.8: local illumination scale, interpolated along the border.
      const lum=vLum[segK]+(vLum[Math.min(segK+1, pts.length-1)]-vLum[segK])*segU;
      const light=smoothstep(JAWDEF_LIGHT_LO, JAWDEF_LIGHT_HI, lum);
      if(light<=0) continue;
      const p4=(y*w+x)*4;
      let addv;
      if(sd>=0){
        if(best > cutB) continue; // v42: the step hugs the border, never the neck
        addv = -dark*Math.exp(-best/twoSigB)*s*light;
      } else {
        const Y=0.299*o[p4]+0.587*o[p4+1]+0.114*o[p4+2];
        const subj=smoothstep(JAWDEF_GATE_LO, JAWDEF_GATE_HI, Y);
        if(subj<=0) continue;
        addv = bright*Math.exp(-best/twoSigA)*s*subj*light;
      }
      if(addv===0) continue;
      o[p4]+=addv; o[p4+1]+=addv; o[p4+2]+=addv;  // clamped by the typed array
    }
  }
}

// ---- M7.6 chin/jaw projection warp ------------------------------------------
// Deterministic silhouette displacement for HA chin/jawline, built on the same
// field format and backward-mapping resampler as the M6 Sculptra lift. The
// decisive difference from the lift: there is NO oval guard, because moving the
// outline is the whole point. The patient's own pixels are re-draped outward,
// so the projected chin and jaw carry real skin texture with a crisp edge
// against any background by construction; backward mapping means pixels beyond
// the old outline sample from inside it (skin), never invented tissue.
//
// Magnitudes at full strength (slider = 100), as fractions of face width W or
// face height faceH. Calibrated to read as a strong 3-4 syringe lower-face
// result at typical consult framing (about 10-14 px of chin travel on a 1024px
// photo); CHINW_FWD / CHINW_DOWN are the first levers if calibration against
// real before/afters asks for more or less.
// v30 calibration (clinical: PROJECTION, not elongation, at obliques): FWD
// 0.045 -> 0.060 and DOWN 0.028 -> 0.012, so the oblique vector is ~14 degrees
// below horizontal instead of ~38, and the pogonion leads (see field builder).
// v29 had raised both axes together, which read as diagonal lengthening.
// These remain the first levers either direction.
const CHINW_FWD          = 0.060; // oblique: pogonion toward the camera-side profile direction (anterior)
const CHINW_DOWN         = 0.012; // oblique: small accompanying drop only (elongation is NOT the goal here)
const CHINW_DOWN_FRONTAL = 0.025; // frontal: pure vertical lengthening (projection is invisible head-on)
// Jawline at oblique (v32): the border straightens by rotating around the
// gonion as the chin advances, so the jaw kernels carry graded fractions of the
// chin vector along the SAME anterior axis. (The v29-v31 lateral "jaw out"
// pushed toward the ear, the same wrong axis as the chin bug, and is removed;
// male jaw WIDTH is a frontal attribute and returns as a frontal feature later.)
const CHINW_PREJOWL_F    = 0.60;  // prejowl follows the chin's advance strongly (v33)
const CHINW_MIDJAW_F     = 0.40;  // mid-border follows (v33)
const CHINW_GONION_F     = 0.15;  // gonion nearly anchored (the rotation pivot)
const CHINW_JAW_DROP     = 0.006; // small extra drop on prejowl/mid kernels: deepens the border-to-neck step
// Witch-chin prevention (v33): distribute the advance as a convex unit.
const CHINW_SUPRA_F      = 0.55;  // supramental follows: fills the step above the pogonion so the chin never hooks
const CHINW_SUPRA_UP     = 0.115; // supramental anchor height above the menton, fraction of faceH
const CHINW_MENTON_F     = 0.68;  // menton follows slightly less than v32 (0.75): the tip must not lead
const CHINW_SIG_CHIN     = 0.085; // kernel radius of the chin kernels, fraction of W
const CHINW_POGO_UP      = 0.055; // pogonion estimate: above the menton along the face axis, fraction of faceH
const CHINW_POGO_OUT     = 0.015; // and slightly toward the near-side profile line, fraction of W
const CHINW_SIG_JAW      = 0.055; // kernel radius of the jaw kernels, fraction of W
// Capsule run factor: displacement stays at full strength from the anchor along
// the motion direction for |v|*CHINW_CAPSULE before decaying, so the moved
// silhouette edge translates rigidly (sharp) instead of stretching (smear).
const CHINW_CAPSULE      = 1.25;

// M9.0 (v35) prejowl notch fill: the followers interpolate the border, which
// preserves a concave prejowl sulcus; these kernels OVERFILL the notch so the
// chin-to-gonion silhouette reads as one straight, continuous line (the visual
// mechanism of jowl softening). Oblique pushes the notch anterior; frontal
// pushes both notches slightly outward. Zero either constant to disable.
const CHINW_NOTCH_FILL         = 0.022; // oblique: extra anterior fill at the near prejowl, fraction of W
                                        // (v36: 0.012 -> 0.022; the follower sum plus 0.012W still left a
                                        // visible dip on a deep sulcus at 45 degrees)
const CHINW_NOTCH_FILL_FRONTAL = 0.008; // frontal: outward fill at both prejowl points, fraction of W
const CHINW_NOTCH_DOWN         = 0.004; // small accompanying drop, fraction of faceH
// M9.6 (v41): gonial squaring at oblique. Jawline filler at the angle restores
// the corner bone resorption took; in 2D at 45 degrees that reads as the
// gonion moving slightly posterior and inferior, giving the border line a
// defined corner to end at. Small on purpose; zero to disable.
const GONW_DEF                 = 0.007; // posterior-inferior gonial move, fraction of W
// M9.10 (v45): the chin_jaw warp's intensity ceiling. Silhouette amplitude
// saturates here while AI shading continues to scale; 1.0 restores v44.
const CHINW_WARP_SAT           = 0.60; // M10.3: 0.45 -> 0.60, opens Enhanced band (70-79)
const CHINW_WARP_SAT_OBLIQUE   = 0.45; // M11.1 reverting 0.50 -> 0.45: oblique artifact on male
                                       // anatomy confirmed. Male chin geometry (taller mentum,
                                       // wider gonial arc) causes warp kernel to overshoot at
                                       // Enhanced oblique. Re-raise after male calibration.

function buildChinProjectionField(L, w, h, pose, sex){
  const lm = L.map(p=>({x:p.x*w, y:p.y*h}));
  const p10=lm[10], p152=lm[152], zr=lm[ZYGION.r], zl=lm[ZYGION.l];
  if(!p10||!p152||!zr||!zl) return null;
  const dirUp = norm(sub(p10, p152));
  const dirOut = { x:-dirUp.y, y:dirUp.x };
  const W = Math.abs(dot(sub(zl, zr), dirOut)) || 1;
  const faceH = (dot(sub(p10, p152), dirUp)) || 1;
  const down = { x:-dirUp.x, y:-dirUp.y };
  // M10.5 Track 1: sex is now active in this function.
  // Male chin geometry has a fundamentally different warp target: the editable
  // region must be wider and flatter so the AI is forced to work within a
  // geometry that biases toward male chin anatomy even when it fights the prompt.
  // For oblique: sigC is widened (more lateral sigma) and the inferior component
  // of chinV is zeroed for male (CHINW_DOWN drives the tapered-tip shape by
  // pulling the warp field downward at the menton; removing it keeps the
  // projection horizontal and biases the warp footprint wider).
  // For frontal: additional lateral kernels at commissure-width points flanking
  // the chin push the warp footprint wide so the AI cannot narrow the lower third
  // into a V-line while filling the moved region.
  const isMaleWarp = (sex === 'male');

  // Capsule kernel: the field is exp(-d^2/twoSig) of the distance to a short
  // SEGMENT from the anchor along the displacement direction (length
  // |v|*CHINW_CAPSULE). Along the motion the displacement therefore plateaus
  // through and past the silhouette edge (rigid translation, crisp edge);
  // perpendicular to it, and back toward the lips, falloff stays Gaussian.
  function capsule(c, v, sig, scale){
    const vx=v.x*(scale==null?1:scale), vy=v.y*(scale==null?1:scale);
    const len=Math.hypot(vx,vy)||1e-6;
    const run=len*CHINW_CAPSULE;
    return { ax:c.x, ay:c.y,
             bx:c.x+(vx/len)*run, by:c.y+(vy/len)*run,
             twoSig:2*sig*sig, vx, vy };
  }
  const kernels=[];
  if(pose && pose.view === 'three_quarter' && (pose.nearSide === 'left' || pose.nearSide === 'right') && lm[454] && lm[234]){
    // Oblique: project along the ANTERIOR direction. In image space at an
    // oblique, anterior is toward the FAR cheek (the side the nose points),
    // NOT toward the camera-facing side; v28-v31 had this backwards. The sign
    // is measured from anatomy: the nose tip is displaced anteriorly relative
    // to the bridge, so its lateral offset gives the forward direction
    // unambiguously. Fallback: the opposite of the camera-facing side.
    const tip = lm[1] || lm[4];
    const bridge = lm[168] || p10;
    let antSign = tip ? (Math.sign(dot(sub(tip, bridge), dirOut)) || 0) : 0;
    if(!antSign){
      const leftSign = Math.sign(dot(sub(lm[454], p152), dirOut)) || 1;
      antSign = (pose.nearSide === 'left') ? -leftSign : leftSign;
    }
    const antDir = mul(dirOut, antSign);
    // M10.5 Track 1: for male, zero the inferior component. The downward
    // component biases the warp field inferiorly, which the AI reads as space
    // to taper the chin downward (toward a point). Removing it forces the
    // projection to be purely anterior, keeping the warp footprint wide and
    // preventing the tapered-tip bias. Female retains the original drop.
    const chinDown = isMaleWarp ? 0 : CHINW_DOWN;
    const chinV = add(mul(antDir, CHINW_FWD*W), mul(down, chinDown*faceH));
    const paraNear = (pose.nearSide === 'right') ? lm[148] : lm[377];
    const pjNear   = (pose.nearSide === 'right') ? lm[PREJOWL.r] : lm[PREJOWL.l];
    const goNear   = (pose.nearSide === 'right') ? lm[GONION.r]  : lm[GONION.l];
    // M10.5 Track 1: for male, widen sigC (lateral sigma of the chin kernels).
    // A wider sigma increases the editable region's lateral extent, which forces
    // the AI to fill a geometry that is already wide and flat at the mentum.
    // Female retains the standard CHINW_SIG_CHIN. Lever: 0.085 -> 0.130 for male.
    // v64 used 0.115; raised to 0.130 (v65) after first calibration showed chin
    // tip still reading slightly tapered -- more lateral sigma needed.
    // One-constant reversal if it over-widens: set mSigC back to CHINW_SIG_CHIN.
    const mSigC = isMaleWarp ? 0.130*W : CHINW_SIG_CHIN*W;
    const sigC=mSigC, sigJ=CHINW_SIG_JAW*W;
    // Pogonion leads the projection: anchored just above the menton on the
    // anterior chin contour. The menton follows at reduced weight (continuous
    // underside, no independent downward slide), para-menton carries the front
    // face of the chin with it.
    const pogo = add(add(p152, mul(dirUp, CHINW_POGO_UP*faceH)), mul(antDir, CHINW_POGO_OUT*W));
    // Convex chin unit (v33 witch-chin fix): maximum advance at the pogonion,
    // the supramental region above carries most of it (no step, no hook), the
    // menton and para-menton follow below at reduced weight (tip never leads).
    const supra = add(add(p152, mul(dirUp, CHINW_SUPRA_UP*faceH)), mul(antDir, CHINW_POGO_OUT*0.6*W));
    kernels.push(capsule(pogo, chinV, sigC));
    kernels.push(capsule(supra, chinV, sigC*0.75, CHINW_SUPRA_F));
    kernels.push(capsule(p152, chinV, sigC*0.9, CHINW_MENTON_F));
    if(paraNear) kernels.push(capsule(paraNear, chinV, sigC*0.8, 0.72));
    // Jawline: straightens by rotating around the gonion. Border kernels move
    // along the SAME anterior axis as the chin at graded weights; prejowl and
    // mid-border also carry a small drop that deepens the border-to-neck step.
    const jawDrop = mul(down, CHINW_JAW_DROP*faceH);
    if(pjNear) kernels.push(capsule(pjNear, add(mul(chinV, CHINW_PREJOWL_F), jawDrop), sigJ));
    // M9.0: prejowl notch fill (sums with the follower above): straighten the
    // chin-to-jowl silhouette line by overfilling the sulcus.
    if(pjNear && CHINW_NOTCH_FILL > 0){
      const fillV = add(mul(antDir, CHINW_NOTCH_FILL*W), mul(down, CHINW_NOTCH_DOWN*faceH));
      kernels.push(capsule(pjNear, fillV, sigJ*0.85));
    }
    if(pjNear && goNear){
      const mid = lerp(pjNear, goNear, 0.5);
      kernels.push(capsule(mid, add(mul(chinV, CHINW_MIDJAW_F), jawDrop), sigJ));
    }
    if(goNear) kernels.push(capsule(goNear, chinV, sigJ, CHINW_GONION_F));
    // M9.6: gonial squaring, posterior-inferior, restoring the angle's corner.
    if(goNear && GONW_DEF > 0){
      const v = add(mul(antDir, -GONW_DEF*W), mul(down, GONW_DEF*0.8*W));
      kernels.push(capsule(goNear, v, sigJ*0.7));
    }
  } else if(pose && pose.view === 'frontal'){
    // Frontal: projection toward the camera is invisible head-on; what reads is
    // vertical lengthening of the lower third. Chin point plus both para-menton
    // points travel down; jaw width is untouched (the AI taper handles shape).
    const chinV = mul(down, CHINW_DOWN_FRONTAL*faceH);
    const sigC=CHINW_SIG_CHIN*W;
    kernels.push(capsule(p152, chinV, sigC));
    for(const idx of [148, 377]){
      const p=lm[idx]; if(!p) continue;
      kernels.push(capsule(p, chinV, sigC*0.8, 0.7));
    }
    // M10.5 Track 1: for male, add lateral chin-widening kernels at the
    // commissure-width points flanking the chin (lm[61] right commissure,
    // lm[291] left commissure, lowered onto the chin body). These push the warp
    // footprint outward at the chin level so the AI cannot narrow the lower third
    // into a V-line while filling the moved region. The vector is purely downward
    // (matching chinV direction) -- no lateral displacement into the background --
    // so the outline gate still governs the boundary; this just widens the moved
    // region so the AI's fill reads as a broad, flat mentum rather than a taper.
    // Female: these kernels are skipped (female taper is correct and approved).
    if(isMaleWarp){
      const comR = lm[61], comL = lm[291]; // oral commissure landmarks
      for(const [com, sideSign] of [[comR, -1],[comL, 1]]){
        if(!com) continue;
        // Anchor the lateral kernel at the commissure x-position but dropped
        // to chin-body level (p152 y) so it displaces chin-level tissue, not
        // mouth tissue. Feature guard zeroes it above the lips already.
        const lateralChin = { x: com.x, y: p152.y + 0.01*faceH };
        // Mild lateral component (sideSign*outward) keeps the flat bottom wide;
        // primary component is still downward (chinV) to match the chin extension.
        // CHINW_MALE_LAT_FRONTAL: fraction of W for the lateral nudge.
        // 0.015 is conservative -- raise toward 0.025 if the chin still tapers.
        const CHINW_MALE_LAT_FRONTAL = 0.015;
        const lateralV = add(chinV, mul(dirOut, sideSign*CHINW_MALE_LAT_FRONTAL*W));
        kernels.push(capsule(lateralChin, lateralV, sigC*0.7, 0.6));
      }
    }
    // M9.0: frontal prejowl notch fill, both sides slightly outward so the
    // border under the jowls straightens. Deliberately small (the approved
    // frontal must not change character); zero CHINW_NOTCH_FILL_FRONTAL to disable.
    if(CHINW_NOTCH_FILL_FRONTAL > 0){
      for(const idx of [176, 400]){
        const p=lm[idx]; if(!p) continue;
        const sideSign = (dot(sub(p, p152), dirOut) >= 0) ? 1 : -1;
        const v = add(mul(dirOut, sideSign*CHINW_NOTCH_FILL_FRONTAL*W), mul(down, CHINW_NOTCH_DOWN*faceH));
        kernels.push(capsule(p, v, CHINW_SIG_JAW*W*0.9));
      }
    }
  } else {
    return null; // out_of_range or no pose: no geometric projection
  }
  if(!kernels.length) return null;

  // Feature guard only (lips, nose, eyes, brows must not be dragged); NO oval
  // guard, the silhouette is supposed to move. Same disc/blur recipe as the lift.
  const pc=document.createElement("canvas"); pc.width=w; pc.height=h;
  const pctx=pc.getContext("2d",{willReadFrequently:true});
  pctx.fillStyle="#000"; pctx.fillRect(0,0,w,h);
  pctx.fillStyle="#fff";
  const rDisc=0.026*W;
  for(const idx of PROTECTED){ const p=lm[idx]; if(!p) continue;
    pctx.beginPath(); pctx.arc(p.x,p.y,rDisc,0,7); pctx.fill(); }
  pctx.filter="blur("+(0.05*W)+"px)"; pctx.drawImage(pc,0,0); pctx.filter="none";
  const protA=pctx.getImageData(0,0,w,h).data;

  // Evaluate only a window around the kernels (3.5 sigma around both capsule
  // ends + travel), not the whole frame; the field is zero elsewhere.
  let kx0=w, ky0=h, kx1=0, ky1=0, travel=0;
  for(const K of kernels){
    const r=3.5*Math.sqrt(K.twoSig/2), t=Math.hypot(K.vx,K.vy);
    if(t>travel) travel=t;
    kx0=Math.min(kx0, K.ax-r, K.bx-r); kx1=Math.max(kx1, K.ax+r, K.bx+r);
    ky0=Math.min(ky0, K.ay-r, K.by-r); ky1=Math.max(ky1, K.ay+r, K.by+r);
  }
  const padK=Math.ceil(travel)+2;
  const wx0=Math.max(0, Math.floor(kx0-padK)), wy0=Math.max(0, Math.floor(ky0-padK));
  const wx1=Math.min(w-1, Math.ceil(kx1+padK)), wy1=Math.min(h-1, Math.ceil(ky1+padK));

  // M11.1: mentum floor clamp. Zero the warp field below a landmark-relative
  // y-threshold so it never reaches the neck zone. The artifact on male faces
  // (fringe below the chin at oblique Enhanced) is the warp kernel's lower tail
  // reaching past the menton into the neck. The floor is set at CHIN_FLOOR_F
  // face-heights below p152 (the menton landmark), with a soft blend zone of
  // CHIN_FLOOR_BLEND face-heights so the zeroing is not a hard step.
  // Female anatomy: the shorter chin sits higher so the 0.12F floor has headroom.
  // Male anatomy: the taller mentum needed more room -- 0.16F gives the same
  // physical clearance. Both are clamped well above the neck.
  const CHIN_FLOOR_F     = (sex === 'male') ? 0.16 : 0.12; // fraction of faceH below p152
  const CHIN_FLOOR_BLEND = 0.04; // soft blend zone, fraction of faceH
  const yFloor    = p152.y + CHIN_FLOOR_F * faceH;
  const yFloorTop = p152.y + (CHIN_FLOOR_F - CHIN_FLOOR_BLEND) * faceH;

  const N=w*h;
  const sx=new Float32Array(N), sy=new Float32Array(N);
  let x0=w, y0=h, x1=-1, y1=-1, maxPx=0;
  for(let y=wy0;y<=wy1;y++){
    // Floor clamp: below yFloor the warp is fully zeroed; between yFloorTop and
    // yFloor it fades linearly to zero. This is landmark-relative so it adapts
    // to the patient's anatomy rather than a fixed pixel constant.
    const floorGate = (y <= yFloorTop) ? 1 :
                      (y >= yFloor)    ? 0 :
                      1 - (y - yFloorTop) / (yFloor - yFloorTop);
    if(floorGate <= 0) continue;
    for(let x=wx0;x<=wx1;x++){
      const i=y*w+x;
      let dx=0, dy=0;
      for(let k=0;k<kernels.length;k++){
        const K=kernels[k];
        const dd=distToSeg(x, y, {x:K.ax, y:K.ay}, {x:K.bx, y:K.by});
        const gv=Math.exp(-(dd*dd)/K.twoSig);
        dx+=K.vx*gv; dy+=K.vy*gv;
      }
      const guard=1-(protA[i*4]/255);
      const ox=-dx*guard*floorGate, oy=-dy*guard*floorGate;
      const mag=Math.hypot(ox,oy);
      if(mag<0.25) continue;
      sx[i]=ox; sy[i]=oy;
      if(mag>maxPx) maxPx=mag;
      if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y;
    }
  }
  if(x1<0) return null;
  const pad=Math.ceil(maxPx)+2;
  x0=Math.max(0,x0-pad); y0=Math.max(0,y0-pad);
  x1=Math.min(w-1,x1+pad); y1=Math.min(h-1,y1+pad);
  return { sx, sy, x0, y0, x1, y1, maxPx, bicubic:true }; // M9.2: chin_jaw resamples bicubic
}

// Gate + build the chin/jaw projection field. chin_jaw scope only; opts.warp
// === false is the same A/B escape hatch as the Sculptra lift (?warp=off).
// Never throws.
async function maybeBuildChinWarp(beforeImg, landmarks, w, h, sex, opts){
  if(opts && opts.warp === false) return null;
  try {
    const pose = await detectPose(beforeImg);
    if(!pose || !pose.view || pose.view === 'out_of_range'){
      console.log('%c[Visualize] M7.6 chin warp skipped: view is ' + ((pose && pose.view) || 'unknown') + '.', 'color:#888');
      return null;
    }
    const f = buildChinProjectionField(landmarks, w, h, pose, sex);
    if(f){
      console.log('%c[Visualize] M7.6 chin/jaw projection warp ACTIVE (' + pose.view + (pose.view === 'three_quarter' ? ', near side ' + pose.nearSide : '') + '): max displacement ' + f.maxPx.toFixed(1) + 'px at full strength.', 'color:#2e7d32;font-weight:bold');
    } else {
      console.warn('[Visualize] M7.6 chin warp unavailable (landmarks incomplete); compositing without it.');
    }
    return f;
  } catch(e){
    console.warn('[Visualize] M7.6 chin warp failed to build; compositing without it.', e);
    return null;
  }
}

// One warp per scope: Sculptra 'full' gets the frontal lift, HA chin_jaw gets
// the projection warp, everything else composites without geometry.
async function buildWarpForScope(beforeImg, landmarks, w, h, scope, sex, opts){
  if(scope === 'full') return maybeBuildLift(beforeImg, landmarks, w, h, scope, opts);
  if(scope === 'chin_jaw') return maybeBuildChinWarp(beforeImg, landmarks, w, h, sex, opts);
  return null;
}

// ---- M7.6/M7.7 outline gate ---------------------------------------------------
// chin_jaw scope only. History: M7.5 tried a luminance "decisiveness" gate here
// (keep out-of-silhouette AI pixels only where |delta luma| was large), which
// killed the faint grey haze but waved through the bright white blobs the model
// painted once the prompt demanded decisive edges; decisive garbage passes a
// decisiveness test. v28 ended the arms race: the silhouette is moved
// GEOMETRICALLY (buildChinProjectionField), so the AI has no legitimate
// business outside the face, and the gate became a hard outline lock.
// v29 hardened it further: at a three-quarter view MediaPipe's projected face
// oval spills past the true jaw-neck silhouette, so a landmark-only lock still
// let AI paint through onto background and neck in that strip. The gate now
// also requires the ORIGINAL pixel to be plausibly lit subject: a dark-luma
// floor (GATE_LUMA_LO..HI) zeroes the black backdrop, deep shadow, hair, and
// dark clothing (none of which the AI should repaint anyway), and the oval's
// lower-face vertices are pulled inward by GATE_LOWER_PULL_IN so the polygon
// hugs the real jawline. Light walls are still covered by the oval term.
const GATE_LUMA_LO = 10;       // original luma at or below this: gate 0
const GATE_LUMA_HI = 26;       // fully open above this
// M10.5 v67: GATE_LOWER_PULL_IN raised 0.015 -> 0.040. The previous value gave
// ~6-9px inward pull at 1024px framing -- not enough when the face oval at an
// oblique view overshoots the real jaw-neck boundary by 20-40px. The larger pull
// keeps the gate polygon tight to the actual jawline. One-constant reversal: 0.015.
const GATE_LOWER_PULL_IN = 0.040; // lower-face oval vertices toward centroid, fraction of W
// M10.5 v67: hard menton floor. Any pixel more than GATE_MENTON_FLOOR_F face-
// heights below p152 (the menton landmark) gets gate = 0 regardless of luma.
// This is the chin projection zone where AI blobs have been appearing: the warp
// handles everything below the menton, so the AI has no legitimate reason to
// paint there. GATE_MENTON_FLOOR_F = 0.04 allows a small margin for the warp's
// own displaced pixels to blend; below that is pure neck/background.
const GATE_MENTON_FLOOR_F = 0.04; // fraction of faceH below p152: hard gate zero

// M8.2 warp shading reconciliation (chin_jaw post-warp pass; see header).
// M10.5 v67: WARP_SHADE_MARGIN tightened 10 -> 6. The 10-level overshoot
// allowance was producing a visible brightening step (warp seam) at the chin
// body on frontal views with normal skin tone. 6 levels catches the overshoot
// earlier without fighting legitimate warp-displaced skin.
const WARP_SHADE_MARGIN = 6;   // luma overshoot allowed before correction starts
const WARP_SHADE_PULL   = 0.55; // fraction of the excess pulled back
const WARP_SHADE_BLUR   = 0.04; // low-frequency reference blur radius, fraction of W

function buildOutlineGate(L, w, h, b){
  const lm = L.map(p=>({x:p.x*w, y:p.y*h}));
  const p152 = lm[152];
  const dirUp = norm(sub(lm[10], p152));
  const dirOut = { x:-dirUp.y, y:dirUp.x };
  const W = Math.abs(dot(sub(lm[454], lm[234]), dirOut)) || 1;
  const faceH = (dot(sub(lm[10], p152), dirUp)) || 1;
  // M10.5 v68: hard menton floor, corrected computation.
  // v67 used p152.y + |faceH|*factor, but faceH is a projected dot-product
  // (not raw pixel height) and at oblique angles it significantly underestimates
  // the actual pixel distance, making the floor too conservative.
  // Fix: find the actual lowest image-y coordinate among all face oval landmarks
  // (largest y value = lowest pixel on screen), then add a fixed pixel margin
  // scaled from W. This is pose-invariant and works correctly at any head tilt.
  // The AI has no legitimate reason to paint below the oval's lowest vertex;
  // the warp handles chin projection deterministically in that zone.
  let ovalLowestY = p152.y;
  for(const idx of FACE_OVAL){ const p=lm[idx]; if(p && p.y > ovalLowestY) ovalLowestY = p.y; }
  // Add a small margin (1.5% of W) below the lowest oval point as a soft buffer
  // for the warp's displaced pixels; anything below that is neck/background.
  const mentonFloorY = ovalLowestY + 0.015 * W;

  // Oval polygon with the lower-face vertices pulled slightly inward.
  const pts = [];
  let cxm=0, cym=0, n=0;
  for(const idx of FACE_OVAL){ const p=lm[idx]; if(!p) continue; cxm+=p.x; cym+=p.y; n++; }
  cxm/=Math.max(1,n); cym/=Math.max(1,n);
  for(const idx of FACE_OVAL){
    const p=lm[idx]; if(!p) continue;
    const hF = dot(sub(p, p152), dirUp)/faceH;
    if(hF < 0.30){
      const pull = GATE_LOWER_PULL_IN*W * (1 - smoothstep(0.18, 0.30, hF));
      const d = norm(sub({x:cxm,y:cym}, p));
      pts.push(add(p, mul(d, pull)));
    } else {
      pts.push(p);
    }
  }
  const oc=document.createElement("canvas"); oc.width=w; oc.height=h;
  const octx=oc.getContext("2d",{willReadFrequently:true});
  octx.fillStyle="#000"; octx.fillRect(0,0,w,h);
  octx.fillStyle="#fff"; octx.beginPath();
  pts.forEach((p,k)=>{ if(k===0) octx.moveTo(p.x,p.y); else octx.lineTo(p.x,p.y); });
  octx.closePath(); octx.fill();
  octx.filter="blur("+(0.015*W)+"px)"; octx.drawImage(oc,0,0); octx.filter="none";
  const oval=octx.getImageData(0,0,w,h).data;

  const N=w*h, g=new Float32Array(N);
  for(let i=0,p4=0;i<N;i++,p4+=4){
    const ov=oval[p4]/255;
    if(ov<=0){ g[i]=0; continue; }
    // M10.5 v67: hard menton floor. The AI has no legitimate reason to paint
    // below the menton; the warp handles chin projection geometrically.
    // Pixels below mentonFloorY are zeroed regardless of luma or oval membership.
    const py = (i/w)|0; // pixel row
    if(py > mentonFloorY){ g[i]=0; continue; }
    const Y=0.299*b[p4]+0.587*b[p4+1]+0.114*b[p4+2];
    g[i]=ov*smoothstep(GATE_LUMA_LO, GATE_LUMA_HI, Y);
  }
  return g;
}

// ---- model singleton ------------------------------------------------------
let _landmarker = null;
async function ensureModel(){
  if(_landmarker) return _landmarker;
  const fileset = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm");
  _landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions:{ modelAssetPath:"https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task" },
    runningMode:"IMAGE", numFaces:1, outputFacialTransformationMatrixes:true
  });
  return _landmarker;
}

// Detect once per image element and memoize, so mask generation and the later
// composite do not run the model twice on the same photo. We also memoize the
// facial transformation matrix (column-major 4x4) for pose readout.
let _lastDetectEl = null, _lastDetect = null, _lastMatrix = null;
async function detectFace(imgEl){
  if(_lastDetectEl === imgEl && _lastDetect) return _lastDetect;
  const landmarker = await ensureModel();
  const res = landmarker.detect(imgEl);
  const out = (res && res.faceLandmarks && res.faceLandmarks.length) ? res.faceLandmarks[0] : null;
  const mtx = (res && res.facialTransformationMatrixes && res.facialTransformationMatrixes.length)
            ? res.facialTransformationMatrixes[0].data : null;
  _lastDetectEl = imgEl; _lastDetect = out; _lastMatrix = mtx;
  return out;
}

// ---- M-obl spike: head-pose readout --------------------------------------
// Classifies the view as frontal / three_quarter / out_of_range and reports the
// near (camera-facing) side, so the oblique-Sculptra shakedown can confirm pose
// and near-side detection with no change to the mask math. Shares detectFace's
// memoized result, so it adds no extra model run on a photo already masked.
//
// Yaw magnitude: primary source is the facial transformation matrix (the
// horizontal tilt of the face-forward axis, taken as a magnitude so it is robust
// to the canonical model's forward-sign convention). If the matrix is missing we
// fall back to a 2D half-width-ratio proxy. Near side: always the 2D rule (the
// wider projected half-face is the one turned toward the camera), unambiguous in
// image space; we do not trust the matrix sign for side. Both yaw figures are
// returned so the shakedown can confirm the matrix path agrees with the proxy
// before HA-oblique leans on the matrix for the projection axis.
const VIEW_FRONTAL_MAX_DEG = 15;   // |yaw| at or below this = frontal
const VIEW_TQ_MAX_DEG      = 60;   // frontal..this = three_quarter; above = out_of_range (raised from 50 in v50)

export async function detectPose(imgEl){
  const lm = await detectFace(imgEl);
  if(!lm) return { ok:false, reason:'no_face', view:null, yawDeg:null, nearSide:null, matrixYawDeg:null, proxyYawDeg:null, source:null };

  // 2D half-width proxy + near side (normalized coords; the ratio is scale-free).
  const up = norm(sub(lm[10], lm[152]));
  const out = { x:-up.y, y:up.x };
  const latOf = p => p.x*out.x + p.y*out.y;
  const mid = latOf(lm[168]);                    // nose-bridge lateral position
  const halfR = Math.abs(latOf(lm[234]) - mid);  // right zygion to midline
  const halfL = Math.abs(latOf(lm[454]) - mid);  // left zygion to midline
  const lo = Math.min(halfR, halfL), hi = Math.max(halfR, halfL) || 1e-6;
  const proxyYawDeg = Math.acos(Math.max(0, Math.min(1, lo/hi))) * 180/Math.PI;
  const nearSide = halfL >= halfR ? 'left' : 'right'; // wider half = camera-facing

  // Matrix yaw: horizontal tilt of the rotated face-forward axis (3rd column of
  // the rotation), as a magnitude in [0,90] so the forward-sign convention does
  // not flip a frontal face to 180 degrees.
  let matrixYawDeg = null;
  if(_lastMatrix && _lastMatrix.length >= 11){
    const fx = _lastMatrix[8], fz = _lastMatrix[10];
    matrixYawDeg = Math.atan2(Math.abs(fx), Math.abs(fz)) * 180/Math.PI;
  }

  const source = (matrixYawDeg != null) ? 'matrix' : 'proxy';
  const yawDeg = (matrixYawDeg != null) ? matrixYawDeg : proxyYawDeg;
  let view;
  if(yawDeg <= VIEW_FRONTAL_MAX_DEG) view = 'frontal';
  else if(yawDeg <= VIEW_TQ_MAX_DEG) view = 'three_quarter';
  else view = 'out_of_range';

  return {
    ok: view !== 'out_of_range',
    reason: view === 'out_of_range' ? ('yaw_gt_' + VIEW_TQ_MAX_DEG) : 'ok',
    view, yawDeg, source,
    nearSide: view === 'frontal' ? 'center' : nearSide,
    matrixYawDeg, proxyYawDeg
  };
}

// ---- M7 capture-quality readout -------------------------------------------
// Pose plus capture-quality metrics for the upload gate. Shares the memoized
// face detection (no extra model run on a photo that will be masked anyway).
// Returns all detectPose fields plus:
//   faceFrac  - face-oval bounding box area as a fraction of the frame (0..1);
//               small values mean the patient is too far from the camera.
//   meanLuma  - mean luma (0..255) of the face crop; exposure sanity check.
//   sharpness - Laplacian variance of a fixed-size grayscale face crop; low
//               values suggest blur. Scale depends on the fixed 160px sampling,
//               so thresholds belong to the caller, not here.
// Metric failures degrade to null fields, never throw past the pose result.
export async function analyzePhoto(imgEl){
  const pose = await detectPose(imgEl);
  if(!pose || !pose.view) return { ...pose, faceFrac:null, meanLuma:null, sharpness:null };
  try {
    const lm = await detectFace(imgEl); // memoized
    let x0=1,y0=1,x1=0,y1=0;
    for(const idx of FACE_OVAL){ const p=lm[idx]; if(!p) continue;
      if(p.x<x0)x0=p.x; if(p.x>x1)x1=p.x; if(p.y<y0)y0=p.y; if(p.y>y1)y1=p.y; }
    const faceFrac = Math.max(0,(x1-x0))*Math.max(0,(y1-y0));
    const iw=imgEl.naturalWidth||imgEl.width, ih=imgEl.naturalHeight||imgEl.height;
    const bx=Math.max(0,Math.floor(x0*iw)), by=Math.max(0,Math.floor(y0*ih));
    const bw=Math.max(1,Math.ceil((x1-x0)*iw)), bh=Math.max(1,Math.ceil((y1-y0)*ih));
    const S=160, sc=Math.min(1, S/Math.max(bw,bh));
    const cw=Math.max(8,Math.round(bw*sc)), ch=Math.max(8,Math.round(bh*sc));
    const c=document.createElement('canvas'); c.width=cw; c.height=ch;
    const cx2=c.getContext('2d',{willReadFrequently:true});
    cx2.drawImage(imgEl,bx,by,bw,bh,0,0,cw,ch);
    const d=cx2.getImageData(0,0,cw,ch).data;
    const g=new Float32Array(cw*ch); let sum=0;
    for(let i=0,p=0;i<g.length;i++,p+=4){ const Y=0.299*d[p]+0.587*d[p+1]+0.114*d[p+2]; g[i]=Y; sum+=Y; }
    const meanLuma=sum/g.length;
    let lsum=0,l2=0,n=0;
    for(let y=1;y<ch-1;y++){ for(let x=1;x<cw-1;x++){ const i=y*cw+x;
      const L=4*g[i]-g[i-1]-g[i+1]-g[i-cw]-g[i+cw]; lsum+=L; l2+=L*L; n++; } }
    const meanL=lsum/n, sharpness=l2/n-meanL*meanL;
    return { ...pose, faceFrac, meanLuma, sharpness,
             faceBbox: { x0, y0, x1, y1 } }; // M11.1: normalized face oval bbox for display crop
  } catch(err){
    console.warn('[Visualize] analyzePhoto metrics failed; returning pose only.', err);
    return { ...pose, faceFrac:null, meanLuma:null, sharpness:null };
  }
}

function buildFoldSegs(lm, p152, dirUp, dirOut, faceH, W){
  const segs=[];
  for(const s of ["r","l"]){
    const C0=lm[COMMISSURE[s]], ala=lm[ALA[s]];
    if(!C0||!ala) continue;
    const sgn=Math.sign(dot(sub(C0,p152),dirOut)) || (s==="r"?-1:1);
    const lat=v=>mul(dirOut, sgn*v*W);
    const upv=v=>mul(dirUp, v*faceH);
    const nlfBot=add(add(C0, upv(0.020)), lat(0.012));
    const nlfMid=add(lerp(ala,nlfBot,0.5), lat(0.018));
    segs.push([ala,nlfMid],[nlfMid,nlfBot]);
    const marTop=add(C0, upv(-0.010));
    const marBot=add(add(C0, upv(-0.130)), lat(0.030));
    segs.push([marTop,marBot]);
  }
  return segs;
}

// Build the feathered treatment-region alpha (0..1, 1 = fully editable).
// scope: 'full' = temple+cheek+lower+folds+apex; 'temple_fold' = temporal fossa +
// temporal apex + nasolabial/marionette folds only (cheeks/midface/under-eye stay
// original); 'temple' = fossa + temporal apex only; 'chin_jaw' = HA filler chin pad
// + mandibular border only (lips/nose/eyes/brows/cheeks/midface/neck protected).
function buildTreatAlpha(L, w, h, scope, sex){
  const lm = L.map(p=>({x:p.x*w, y:p.y*h}));
  const p152 = lm[152];
  const dirUp = norm(sub(lm[10], lm[152]));
  const dirOut = { x:-dirUp.y, y:dirUp.x };
  const W = Math.abs(dot(sub(lm[454], lm[234]), dirOut)) || 1;
  const faceH = (dot(sub(lm[10], lm[152]), dirUp)) || 1;

  // protected exclusion: discs over protected landmarks, blurred
  const pc=document.createElement("canvas"); pc.width=w; pc.height=h;
  const pctx=pc.getContext("2d",{willReadFrequently:true});
  pctx.fillStyle="#000"; pctx.fillRect(0,0,w,h);
  pctx.fillStyle="#fff";
  const rDisc=0.020*W;
  for(const idx of PROTECTED){ const p=lm[idx]; if(!p) continue;
    pctx.beginPath(); pctx.arc(p.x,p.y,rDisc,0,7); pctx.fill(); }
  // Perioral protection: the cutaneous upper lip / philtrum sits in a gap
  // between the nose-base discs and the vermilion discs, and the nasolabial fold
  // tubes bleed into it, which lets the model smear that strip into a faint
  // shadow. Protect it explicitly with a filled band from the alar bases and
  // subnasale down to the central upper vermilion, kept medial of the mouth
  // corners so the lateral fold softening is preserved.
  pctx.beginPath();
  [98,2,327,270,267,0,37,40].forEach((idx,k)=>{ const p=lm[idx]; if(!p) return; if(k===0) pctx.moveTo(p.x,p.y); else pctx.lineTo(p.x,p.y); });
  pctx.closePath(); pctx.fill();
  { const pf=lm[164]; if(pf){ pctx.beginPath(); pctx.arc(pf.x,pf.y,rDisc,0,7); pctx.fill(); } }
  pctx.filter="blur("+(0.028*W)+"px)"; pctx.drawImage(pc,0,0); pctx.filter="none";
  const protA=pctx.getImageData(0,0,w,h).data;

  // face-oval containment
  const oc=document.createElement("canvas"); oc.width=w; oc.height=h;
  const octx=oc.getContext("2d",{willReadFrequently:true});
  octx.fillStyle="#000"; octx.fillRect(0,0,w,h);
  octx.fillStyle="#fff"; octx.beginPath();
  FACE_OVAL.forEach((idx,k)=>{ const p=lm[idx]; if(k===0) octx.moveTo(p.x,p.y); else octx.lineTo(p.x,p.y); });
  octx.closePath(); octx.fill();
  octx.filter="blur("+(0.02*W)+"px)"; octx.drawImage(oc,0,0); octx.filter="none";
  const ovalA=octx.getImageData(0,0,w,h).data;

  // M7: a second, wide-feathered oval drives the jaw-margin guard below.
  octx.fillStyle="#000"; octx.fillRect(0,0,w,h);
  octx.fillStyle="#fff"; octx.beginPath();
  FACE_OVAL.forEach((idx,k)=>{ const p=lm[idx]; if(k===0) octx.moveTo(p.x,p.y); else octx.lineTo(p.x,p.y); });
  octx.closePath(); octx.fill();
  octx.filter="blur("+(JAW_EDGE_FEATHER*W)+"px)"; octx.drawImage(oc,0,0); octx.filter="none";
  const ovalWideA=octx.getImageData(0,0,w,h).data;

  // apex centers anchored to lateral landmarks
  const cC=[], cT=[];
  for(const s of ["r","l"]){
    const zy=lm[ZYGION[s]];
    const zside=Math.sign(dot(sub(zy,p152), dirOut))||1;
    const cheekC=add(add(zy, mul(dirUp, CHEEK_APEX_UP*faceH)), mul(dirOut, -zside*CHEEK_APEX_IN*W));
    cC.push(cheekC);
    const to=lm[TEMPLE_OVAL[s]];
    const tside=Math.sign(dot(sub(to,p152), dirOut))||1;
    const tempC=add(to, mul(dirOut, -tside*TEMPLE_APEX_IN*W));
    cT.push(tempC);
  }
  const twoSigC=2*(APEX_SIGMA_CHEEK*W)*(APEX_SIGMA_CHEEK*W);
  const twoSigT=2*(APEX_SIGMA_TEMPLE*W)*(APEX_SIGMA_TEMPLE*W);

  const foldSegs=buildFoldSegs(lm, p152, dirUp, dirOut, faceH, W);
  const twoSigFold=2*(FOLD_SIGMA*W)*(FOLD_SIGMA*W);

  // HA filler lower-face anchors (chin + mandibular border), sex-aware.
  // Female: chin tapers to a narrow central point at alar width, gonial angle
  // stays closed (never widen/lower a woman's jaw, the common masculinising
  // error). Male: wider, squarer chin at oral-commissure width, and the gonial
  // angle is opened so the jaw can be widened/straightened from the front. The
  // central column below the chin is reopened for vertical lengthening either way.
  const isMale = sex === 'male';
  const LF_JAW_SIGMA=0.035*W, LF_TOP=0.32;
  const twoSigJaw=2*LF_JAW_SIGMA*LF_JAW_SIGMA||1e-6;
  const chinC=add(p152, mul(dirUp, 0.02*faceH)); // near the menton, biased toward the chin point and the elongation column
  // chin width by landmark: female ~ alar (nostril) width, male ~ oral-commissure width
  const alaHalf = (lm[ALA.l]&&lm[ALA.r]) ? Math.abs(dot(sub(lm[ALA.l], lm[ALA.r]), dirOut))/2 : 0.08*W;
  const comHalf = (lm[COMMISSURE.l]&&lm[COMMISSURE.r]) ? Math.abs(dot(sub(lm[COMMISSURE.l], lm[COMMISSURE.r]), dirOut))/2 : 0.14*W;
  const chinHalf = isMale ? comHalf*0.95 : alaHalf*0.45; // male: square flat bottom; female: taper to near-central point
  const chinA = sub(chinC, mul(dirOut, chinHalf));
  const chinB = add(chinC, mul(dirOut, chinHalf));
  const LF_CHIN_SIGMA=(isMale?0.11:0.12)*W;
  const twoSigChin=2*LF_CHIN_SIGMA*LF_CHIN_SIGMA||1e-6;
  // male only: open the gonial angle for jaw width; empty for female
  const twoSigGonial=2*(0.065*W)*(0.065*W)||1e-6;
  const gonialPts = isMale ? [lm[172], lm[397]].filter(Boolean) : [];
  const JAW_POLY=[397,365,379,378,400,377,152,148,176,149,150,136,172]; // right gonion -> chin -> left gonion
  const jawSegs=[];
  for(let k=0;k+1<JAW_POLY.length;k++){ const A=lm[JAW_POLY[k]], B=lm[JAW_POLY[k+1]]; if(A&&B) jawSegs.push([A,B]); }

  // Lateral lower-face taper. As the chin lengthens and projects, the soft lower
  // third follows it down and the lateral contour tapers slightly inward; locking
  // that contour makes the chin look stretched rather than refined. Unlock a
  // feathered band straddling the lower-lateral silhouette (jaw-near-chin ->
  // gonion -> jaw angle), wide enough to sit a little outside the outline so the
  // edit can pull it in. Sex-aware: a woman's lower face may taper (feminising);
  // a man's jaw width is preserved, so the band is mostly off. Kept below the
  // cheekbone (the topTaper above still fades it) so the mid-cheek is untouched.
  const LF_TAPER_SIGMA=0.045*W;
  const twoSigTaper=2*LF_TAPER_SIGMA*LF_TAPER_SIGMA||1e-6;
  const taperScale = isMale ? 0.4 : 0.85;
  const taperSegs=[];
  if(taperScale>0){
    for(const POLY of [[365,397,288],[136,172,58]]){ // right side, left side
      for(let k=0;k+1<POLY.length;k++){ const A=lm[POLY[k]], B=lm[POLY[k+1]]; if(A&&B) taperSegs.push([A,B]); }
    }
  }

  // M9.0 (v35) jowl-blend lobes: open the alpha over the marionette/prejowl
  // shadow and the jowl body so the AI's softening of those shadows survives
  // the composite (v34's border tubes discarded it). Two tubes per side:
  // mouth corner (dropped) -> prejowl, and prejowl -> raised mid-jowl point.
  // Oval-contained in the pixel loop, so this is SHADING-ONLY coverage; the
  // contour itself stays owned by the warp. Levers: JOWL_SCALE, LF_JOWL_SIGMA.
  const LF_JOWL_SIGMA=0.060*W, JOWL_SCALE=0.9;
  const twoSigJowl=2*LF_JOWL_SIGMA*LF_JOWL_SIGMA||1e-6;
  const jowlSegs=[];
  for(const pair of [[400,397],[176,172]]){ // [prejowl, gonion] per side
    const pj=lm[pair[0]], go=lm[pair[1]];
    if(!pj||!go) continue;
    const cR=lm[COMMISSURE.r], cL=lm[COMMISSURE.l];
    let corner=null;
    if(cR&&cL) corner = (Math.hypot(cR.x-pj.x,cR.y-pj.y) <= Math.hypot(cL.x-pj.x,cL.y-pj.y)) ? cR : cL;
    else corner = cR || cL;
    if(corner){
      const cDrop = add(corner, mul(dirUp, -0.04*faceH));
      jowlSegs.push([cDrop, pj]);
    }
    const mid = { x:(pj.x+go.x)/2, y:(pj.y+go.y)/2 };
    const jowlMid = add(mid, mul(dirUp, 0.05*faceH));
    jowlSegs.push([pj, jowlMid]);
  }


  const N=w*h, m=new Float32Array(N);
  for(let y=0,i=0;y<h;y++){
    for(let x=0;x<w;x++,i++){
      const relx=x-p152.x, rely=y-p152.y;
      const along=relx*dirUp.x+rely*dirUp.y;
      const latd =relx*dirOut.x+rely*dirOut.y;
      const hF=along/faceH, alat=Math.abs(latd)/W;

      // HA filler chin_jaw scope: chin pad + mandibular border only. Computed
      // before the oval early-out so it can sit on and just beyond the lower
      // silhouette (chin projection extends the outline; Sculptra zones never do).
      // Protected buffer keeps lips/nose/eyes/brows out; tapers give a hard stop
      // at the jaw (no neck/submental) and a fade toward the mid-cheek above.
      if(scope==="chin_jaw"){
        if(hF <= LF_TOP+0.12 && hF >= -0.16){
          const protOnly=1-(protA[i*4]/255);
          // M10.5 v66: for male, exclude the chin tip from the AI's editable
          // region entirely. The chin tip shape is now pure warp geometry --
          // the patient's own pixels displaced anteriorly by buildChinProjectionField.
          // Those pixels carry the correct anatomy by construction (original face).
          // The AI's trained prior tapers any chin region it sees regardless of
          // prompt or mask sigma; the only reliable fix is to not show it the chin
          // tip at all. Male mask opens ONLY jaw border tube and jowl lobes.
          // Female retains the full chin tip capsule (female taper is correct).
          let lf = 0;
          if(!isMale){
            const dc=distToSeg(x,y,chinA,chinB);
            lf=Math.exp(-(dc*dc)/twoSigChin);
          }
          for(let k=0;k<jawSegs.length;k++){ const sg=jawSegs[k]; const dd=distToSeg(x,y,sg[0],sg[1]); const g=Math.exp(-(dd*dd)/twoSigJaw); if(g>lf) lf=g; }
          for(let k=0;k<gonialPts.length;k++){ const gp=gonialPts[k]; const dx=x-gp.x, dy=y-gp.y; const g=Math.exp(-(dx*dx+dy*dy)/twoSigGonial); if(g>lf) lf=g; }
          const ovalInside = ovalA[i*4]/255;
          // Lateral taper: male = 0 (AI must not touch lateral jaw contour;
          // warp owns the border). Female = 0.85 (feminising taper is correct).
          if(!isMale && taperScale>0){
            let taperVal=0;
            for(let k=0;k<taperSegs.length;k++){ const sg=taperSegs[k]; const dd=distToSeg(x,y,sg[0],sg[1]); const g=taperScale*Math.exp(-(dd*dd)/twoSigTaper); if(g>taperVal) taperVal=g; }
            taperVal*=ovalInside;
            if(taperVal>lf) lf=taperVal;
          }
          // M9.0 jowl-blend lobes (shading-only: oval-contained; both sexes)
          let jowlVal=0;
          for(let k=0;k<jowlSegs.length;k++){ const sg=jowlSegs[k]; const dd=distToSeg(x,y,sg[0],sg[1]); const g=JOWL_SCALE*Math.exp(-(dd*dd)/twoSigJowl); if(g>jowlVal) jowlVal=g; }
          jowlVal*=ovalInside;
          if(jowlVal>lf) lf=jowlVal;
          const topTaper=1-smoothstep(LF_TOP,LF_TOP+0.08,hF);
          const centralExt = (sex === 'male') ? 0.0 : 0.12;
          const central=1-smoothstep(0.10,0.22,alat);
          const floor=-0.02 - centralExt*central;
          const neckTaper=smoothstep(floor, floor+0.05, hF);
          m[i]=Math.min(1, lf*topTaper*neckTaper*protOnly);
        }
        continue;
      }

      const oval=ovalA[i*4]/255;
      const prot=1-(protA[i*4]/255);
      const base=oval*prot;
      if(base<=0.003) continue;

      // M7 jaw-margin guard (see JAW_EDGE_FEATHER): fade the alpha over a wide
      // band inside the lower-face silhouette so shading never abuts the jaw.
      let edgeG=1;
      if(hF < JAW_EDGE_FADE_TO){
        const wide=smoothstep(0.45,0.95, ovalWideA[i*4]/255);
        const wLow=1-smoothstep(JAW_EDGE_TOP, JAW_EDGE_FADE_TO, hF);
        edgeG=1-wLow*(1-wide);
      }

      let templeFrac=0;
      if(scope==="temple" || scope==="temple_fold"){
        // fossa membership
        const lo=VOL_BANDS.temple[0], hi=VOL_BANDS.temple[1];
        const band=smoothstep(lo-VOL_FB,lo,hF)*(1-smoothstep(hi,hi+VOL_FB,hF));
        if(band>0){
          const wlat=smoothstep(VOL_LAT_MIN_TEMPLE,VOL_LAT_MIN_TEMPLE+VOL_LAT_RAMP,alat);
          templeFrac=clamp01(band*wlat);
        }
        let v=templeFrac*base;
        // temporal apex
        let axt=0; for(let k=0;k<cT.length;k++){ const dx=x-cT[k].x, dy=y-cT[k].y; const g=Math.exp(-(dx*dx+dy*dy)/twoSigT); if(g>axt) axt=g; }
        const t=axt*base; if(t>v) v=t;
        // nasolabial / marionette fold tubes (temple_fold only); cheeks stay original
        if(scope==="temple_fold"){
          let fw=0;
          for(let k=0;k<foldSegs.length;k++){ const sg=foldSegs[k]; const dd=distToSeg(x,y,sg[0],sg[1]); const g=Math.exp(-(dd*dd)/twoSigFold); if(g>fw) fw=g; }
          fw*=base; if(fw>v) v=fw;
        }
        m[i]=Math.min(1,v)*edgeG;
        continue;
      }

      // full scope: dominant dodge zone + folds + both apexes
      let bestW=0;
      for(const z in VOL_BANDS){
        const lo=VOL_BANDS[z][0], hi=VOL_BANDS[z][1];
        let band=smoothstep(lo-VOL_FB,lo,hF)*(1-smoothstep(hi,hi+VOL_FB,hF));
        if(band<=0) continue;
        if(z==="cheek") band *= 1 - CHEEK_UE_ROLL*smoothstep(CHEEK_UE_LO, CHEEK_UE_HI, hF);
        const latMin = z==="temple"?VOL_LAT_MIN_TEMPLE : z==="cheek"?VOL_LAT_MIN_CHEEK : LAT_MIN;
        const wlat=smoothstep(latMin,latMin+VOL_LAT_RAMP,alat);
        const wz=band*wlat*base;
        if(wz>bestW) bestW=wz;
      }
      let v=bestW;

      let fw=0;
      for(let k=0;k<foldSegs.length;k++){ const sg=foldSegs[k]; const dd=distToSeg(x,y,sg[0],sg[1]); const g=Math.exp(-(dd*dd)/twoSigFold); if(g>fw) fw=g; }
      fw*=base; if(fw>v) v=fw;

      let axc=0; for(let k=0;k<cC.length;k++){ const dx=x-cC[k].x, dy=y-cC[k].y; const g=Math.exp(-(dx*dx+dy*dy)/twoSigC); if(g>axc) axc=g; }
      const ac=axc*base; if(ac>v) v=ac;
      let axt=0; for(let k=0;k<cT.length;k++){ const dx=x-cT[k].x, dy=y-cT[k].y; const g=Math.exp(-(dx*dx+dy*dy)/twoSigT); if(g>axt) axt=g; }
      const at=axt*base; if(at>v) v=at;

      m[i]=Math.min(1,v)*edgeG;
    }
  }
  return blurAlpha(m, w, h, 3);
}

// Texture-delta profile by scope. HA chin/jaw stays clean and shadow-free (the
// jaw must not gain an invented shadow). Sculptra is BOLD: it allows real 3D form
// by letting the broad luminance darken on the underside of restored volume (the
// shadow that makes a filled cheek read as projecting rather than just brighter).
// Colour stays locked at all times, so allowing this luminance shadow cannot
// bring back the brown discoloration; that was a chroma problem and the chroma
// lock handles it independently. SCULPTRA_DARK_FLOOR is the single lever for how
// much 3D form the volume is allowed: raise for bolder projection, lower toward 0
// if a case ever reads hollow instead of full.
// M10.5 v68: SCULPTRA_DARK_FLOOR reduced 20 -> 12. The 20-level allowance was
// producing visible dark discolouration patches in the lateral lower-cheek zone
// on lighter-skinned patients at oblique view (image 10 red rectangle). The AI's
// broad darkening in the lower_cheek zone with normal skin tone reads as a muddy
// shadow patch rather than volume. At 12 levels the 3D form shading is still
// present and clinically readable but the worst-case darkening on light skin is
// halved. Chroma stays locked so no brown/colour shift is possible; this governs
// only the luminance floor. Reversal: restore to 20 if volume reads flat on a
// well-lit darker-skin case.
// v70: 12 -> 16. Real-world jowl correction shows significant shadow
// depth change as the prejowl hollow fills. More dark floor allowance
// lets the volume shading read as structural correction, not flat lift.
const SCULPTRA_DARK_FLOOR = 16;
//
// M6.3 BRIGHT CAP. Broad brightening SATURATES perceptually: past a ceiling it
// stops reading as restored volume and starts erasing the natural shading
// gradient, which is the flat, waxy, lit-from-within look the first v23 Strong
// exports showed. The cap soft-knees (tanh) the POSITIVE broad-tone shift inside
// the delta so that the response gain amplifies structure (the spatial variation
// of the volume shading, and the floored underside shadow) while the flat
// brightening component levels off. Defined as the maximum broad brightening in
// luma levels reachable at the TOP of the slider; the pre-gain cap is derived
// from it so retuning the gain does not silently change the ceiling.
// v70: 12 -> 16. v65 cut from 18->12 to fix discolouration on poorly-lit
// photos. Real-world results show the skin brightness lift is a legitimate
// clinical outcome (collagen glow). 16 recovers most of it while staying
// below the 18 that caused patchy artefacts on clinic snapshots.
// v72: 16 -> 13. The 16 value reintroduced a faint warm/tan patch in the
// lateral cheek zone on oblique views of poorly-lit photos (the exact failure
// mode the v65 12-cap fixed). 13 is a compromise: most of the v70 glow recovery
// is retained, but the flat-brightness lift soft-knees earlier so the patch is
// suppressed. Well-lit cases are nearly unaffected (typical deltas of 8-12 sit
// below both caps). Reversal: restore to 16 if collagen glow reads flat on a
// well-lit case, or to 12 if the patch persists on poorly-lit obliques.
const SCULPTRA_BRIGHT_CAP_FULL = 13;
// ─────────────────────────────────────────────────────────────────────────
// M10.6 (v73): JAW-CONTINUITY FEATHER. Diagnosis (R45 patch, L45 clean):
// the offense is not hue/chroma drift, it is a cheek-to-jaw LUMINANCE
// CONTINUITY break. On the larger-warp oblique the near-side lower-lateral
// cheek brightens while the jawline below stays dark, so the cheek-to-jaw
// tonal gap exceeds the original photo's and the bright zone reads as a
// pasted-on oval. The global bright cap (13) cannot fix this: lowering it
// dims every angle and every patient (the L45 that is already perfect).
//
// Fix: in the lower-lateral-cheek-to-jaw band ONLY, tighten the bright cap
// from SCULPTRA_BRIGHT_CAP_FULL toward SCULPTRA_JAW_TIGHT_CAP. The upper and
// mid cheek (the zygomatic lift + glow, the actual Sculptra effect) keep the
// full cap and are untouched. Self-gating: the existing tanh soft-knee means
// a modest lift (L45's lower cheek) passes a tighter cap nearly unchanged,
// while an extreme lift (R45's blown patch) is clamped hard. So the patch is
// pulled down toward jaw-continuous tone without dimming the good angle and
// without hard-coding which side is the near side. Kill switch: pass
// jawContinuity:false (visualize.html ?jawcont=off) to A/B or disable.
// Tuning: SCULPTRA_JAW_TIGHT_CAP lower (5) = stronger continuity / flatter
// lower cheek; higher (8) = gentler, less effect on the clean angle.
const SCULPTRA_JAW_TIGHT_CAP   = 7;     // tightened bright cap at the jaw border
const SCULPTRA_JAW_FEATHER_LO  = 0.45;  // ramp start: fraction of the zygion->jaw drop (0=zygion, 1=jaw)
const SCULPTRA_JAW_FEATHER_LAT_LO = 0.16; // lateral gate inner edge (fraction of face width from midline)
const SCULPTRA_JAW_FEATHER_LAT_HI = 0.40; // lateral gate outer edge (full feather beyond this)
// ─────────────────────────────────────────────────────────────────────────
// 18 -> 12 (M10.5 v65): Sculptra oblique discolouration on poorly-lit clinic photos.
// The AI's broad brightening was exceeding the local light field of the original face,
// creating a warm/tan patch in the lateral cheek zone that reads as colour shift
// even though chroma is locked. The soft-knee (tanh) cap at 12 limits flat brightness
// lift earlier. Well-lit cases are unaffected: at typical bright deltas of 8-12 levels
// the 12 and 18 caps produce nearly identical output. The 12 cap only bites when the
// AI overbrightens on a poorly-lit region, which is the exact failure mode seen in
// clinic snapshots with uneven lighting. Reversal: restore to 18 if volume reads
// flat or insufficiently bright on a well-lit case.
//
// M6.4: EXTRAPOLATION RETIRED. The M6.2/M6.3 response gain (1.45, then 1.45
// with form shaping) was tested against real before/after pairs across three
// calibration rounds, and the finding was consistent: rendering at 0.7..1.0 of
// the AI anchor's own magnitude reads clinical and believable; rendering BEYOND
// the anchor degrades into flat, waxy brightness at the top of the slider no
// matter how the delta is shaped, because gain can only inflate the amplitude
// of information the anchor already contains; it cannot synthesize the form it
// lacks. The gain therefore returns to 1.0 and stays: the slider is now pure
// interpolation between the original and the anchor, which cannot produce that
// failure mode. Magnitude ambition belongs UPSTREAM in the anchor itself (the
// projection setting and the prompt magnitude) and in the geometry engine, not
// in post-hoc amplification. Do not raise this above 1.0 again.
const SCULPTRA_DELTA_GAIN = 1.0;
const CHIN_JAW_DELTA_GAIN = 1.0;
// M9.5 (v40): chin_jaw texture-restore cutoff, tighter than the shared
// TEX_RADIUS_FRAC (0.016). Detail coarser than the cutoff lives in the low
// band and takes the AI's smooth version at high alpha; at 0.016W that
// includes 7px-and-coarser skin character (fine lines, mottling), which read
// as an airbrushed band at the top of the slider even with pores intact.
// 0.009W keeps that band the patient's own. Treatment shading (border shadow
// gradient, broad brightening) is far coarser than 0.009W and unaffected.
// Sculptra keeps the shared 0.016 untouched. Raise back toward 0.016 only if
// the AI's intended chin/jaw shading ever looks visibly band-limited.
const CHIN_JAW_TEX_RADIUS = 0.009;
// M9.8 (v43): three-band mid keep. The band between CHIN_JAW_TEX_RADIUS and
// CHIN_JAW_MID_RADIUS carries the patient's organic mid-scale skin variation;
// CHIN_JAW_MID_KEEP of it is kept (0 = the AI's smooth fill replaces it, the
// v42 behavior; 1 = fully the patient's own). Suppressed inside the jowl
// release lobes so fold erasure still wins there. Raise toward 0.75 if the
// treated zone still reads synthetically smooth; lower toward 0.4 if the
// patient's own shadows fight the volume change.
const CHIN_JAW_MID_RADIUS = 0.022;
const CHIN_JAW_MID_KEEP   = 0.6;
// Sculptra glow applied at composite time, scaled by mask and slider but NOT by
// the gain (see GLOW_LUMA note). Equal add to R,G,B, so chroma-exact.
// v70: 6 -> 9. Combined with CHROMA_LOCK=0.82, raises the collagen glow
// effect toward what real-world results show. The glow is never gained
// (see compositor), so this is a ceiling raise not an amplification.
// M16: 9 -> 5. The v70 bump to 9 was calibrated against CHROMA_LOCK=0.82,
// which was later reverted to 0.96 (see line ~669) WITHOUT dropping the glow
// back -- so the glow was over-set relative to its own premise and read as skin
// beautification (brighter, glowier skin) on staging. 5 keeps a subtle real
// glow. Raise back toward 6-7 if collagen glow reads flat; do not return to 9.
const SCULPTRA_GLOW_APPLY = 5;
// HA chin/jaw: a defined jawline is created by the clean shadow line along the
// mandibular border, so the path needs SOME darkening to read as definition
// rather than flat. Colour is locked, so this clean luminance shadow cannot turn
// muddy or brown the way the earlier artifact did. Bounded and tunable: raise for
// a crisper, more sculpted jaw and chin, lower toward 0 if a case reads shadowed
// or harsh instead of defined.
const CHIN_JAW_DARK_FLOOR = 26;
// 14 -> 22 (M7.7) -> 26 (M8.1, "jawline definition drastically"): the shadow
// line under the border is what makes definition read; chroma stays locked so
// this cannot discolor. Drop back toward 22 if a case reads harsh or dirty.
// M9.1 (v36): jowl-lobe texture-release field for chin_jaw. Same geometry as
// the v35 alpha lobes in buildTreatAlpha (marionette tube: dropped mouth
// corner -> prejowl; jowl body tube: prejowl -> raised mid-jowl), rebuilt here
// as a standalone Float32 plane so the composite can scale the moved-edge
// guard down inside the lobes (see buildTextureDelta). Peak value is
// JOWL_TEX_RELEASE: 1 means the AI's high-frequency luminance fully replaces
// the original's at the lobe core (the crease line is erased where the AI
// softened it); 0 disables and restores exact v35 behavior. Not oval-gated:
// the field only acts through the delta, which the treat alpha (itself
// oval-contained at the lobes) already gates.
const JOWL_TEX_RELEASE = 0.9;
function buildJowlReleaseField(L, w, h){
  if(JOWL_TEX_RELEASE <= 0) return null;
  const lm = L.map(p=>({x:p.x*w, y:p.y*h}));
  const p10=lm[10], p152=lm[152], zr=lm[234], zl=lm[454];
  if(!p10||!p152||!zr||!zl) return null;
  const dirUp = norm(sub(p10, p152));
  const dirOut = { x:-dirUp.y, y:dirUp.x };
  const W = Math.abs(dot(sub(zl, zr), dirOut)) || 1;
  const faceH = (dot(sub(p10, p152), dirUp)) || 1;
  const sig = 0.060*W, twoSig = 2*sig*sig || 1e-6; // mirrors LF_JOWL_SIGMA
  const segs=[];
  for(const pair of [[400,397],[176,172]]){ // [prejowl, gonion] per side
    const pj=lm[pair[0]], go=lm[pair[1]];
    if(!pj||!go) continue;
    const cR=lm[COMMISSURE.r], cL=lm[COMMISSURE.l];
    let corner=null;
    if(cR&&cL) corner = (Math.hypot(cR.x-pj.x,cR.y-pj.y) <= Math.hypot(cL.x-pj.x,cL.y-pj.y)) ? cR : cL;
    else corner = cR || cL;
    if(corner) segs.push([add(corner, mul(dirUp, -0.04*faceH)), pj]);
    const mid = { x:(pj.x+go.x)/2, y:(pj.y+go.y)/2 };
    segs.push([pj, add(mid, mul(dirUp, 0.05*faceH))]);
  }
  if(!segs.length) return null;
  const f=new Float32Array(w*h);
  let minX=w, minY=h, maxX=0, maxY=0;
  for(const sg of segs){ for(const p of sg){
    if(p.x<minX)minX=p.x; if(p.x>maxX)maxX=p.x;
    if(p.y<minY)minY=p.y; if(p.y>maxY)maxY=p.y;
  } }
  const pad=3*sig;
  minX=Math.max(0,Math.floor(minX-pad)); maxX=Math.min(w-1,Math.ceil(maxX+pad));
  minY=Math.max(0,Math.floor(minY-pad)); maxY=Math.min(h-1,Math.ceil(maxY+pad));
  for(let y=minY;y<=maxY;y++){
    for(let x=minX;x<=maxX;x++){
      let v=0;
      for(let k=0;k<segs.length;k++){ const sg=segs[k]; const dd=distToSeg(x,y,sg[0],sg[1]); const g=Math.exp(-(dd*dd)/twoSig); if(g>v) v=g; }
      f[y*w+x]=JOWL_TEX_RELEASE*v;
    }
  }
  return f;
}

// M10.6 (v73): build the jaw-continuity feather field for Sculptra ('full').
// Returns a Float32Array(w*h) of tightening weights 0..1, where 0 = keep the
// full bright cap (upper/mid cheek, lift preserved) and 1 = tightest cap (at
// the mandibular border, lower-lateral cheek). Two gates multiply:
//   vertical: 0 above the submalar, ramping to 1 from SCULPTRA_JAW_FEATHER_LO
//             of the zygion->jaw drop down to the jaw line.
//   lateral:  0 near the midline (chin/perioral untouched), ramping to 1 out
//             on the lateral cheek. So only the lower-LATERAL cheek is feathered.
// Bilateral and pose-agnostic: the mask and the tanh self-gating decide where
// it actually bites, so the clean angle is left alone without a side hard-code.
function buildJawContinuityFeather(L, w, h){
  const lm = L.map(p=>({x:p.x*w, y:p.y*h}));
  const p10=lm[10], p152=lm[152];
  const zr=lm[ZYGION.r], zl=lm[ZYGION.l];
  if(!p10||!p152||!zr||!zl) return null;
  const dirUp = norm(sub(p10, p152));          // up the face (menton -> glabella)
  const dirOut = { x:-dirUp.y, y:dirUp.x };    // lateral axis
  const W = Math.abs(dot(sub(zl, zr), dirOut)) || (0.4*w);
  const faceH = dot(sub(p10, p152), dirUp) || 1;

  // Heights (along dirUp) above the menton.
  const heightOf = (pt) => (pt.x - p152.x)*dirUp.x + (pt.y - p152.y)*dirUp.y;
  const zygY = (heightOf(zr) + heightOf(zl)) / 2;   // upper-cheek level (weight 0)
  // Jaw line level: gonion+prejowl midpoints if present, else a low fallback.
  const gr=lm[GONION.r], gl=lm[GONION.l], pr=lm[PREJOWL.r], pl=lm[PREJOWL.l];
  let jawY;
  if(gr&&gl&&pr&&pl){
    jawY = (heightOf(gr)+heightOf(gl)+heightOf(pr)+heightOf(pl)) / 4;
  } else {
    jawY = 0.18*faceH;
  }
  const span = (zygY - jawY) || 1;             // vertical drop, zygion -> jaw

  const latLo = SCULPTRA_JAW_FEATHER_LAT_LO * W;
  const latHi = SCULPTRA_JAW_FEATHER_LAT_HI * W;

  const f = new Float32Array(w*h);
  for(let y=0;y<h;y++){
    const ry = y - p152.y;
    for(let x=0;x<w;x++){
      const rx = x - p152.x;
      const heightAbove = rx*dirUp.x + ry*dirUp.y;     // along dirUp, 0 at menton
      // vertical: 0 at/above zygion, 1 at/below jaw, ramp starts partway down
      const vt = (zygY - heightAbove) / span;          // 0 at zygion, 1 at jaw
      const vWeight = smoothstep(SCULPTRA_JAW_FEATHER_LO, 1.0, vt);
      if(vWeight <= 0) continue;
      // lateral: 0 near midline, 1 out on the cheek
      const lat = Math.abs(rx*dirOut.x + ry*dirOut.y);
      const latWeight = smoothstep(latLo, latHi, lat);
      const wgt = vWeight * latWeight;
      if(wgt > 0) f[y*w+x] = wgt;
    }
  }
  return f;
}

function sculptraTexOpts(scope, opts){
  const isHA = (scope === 'chin_jaw');
  const profile = isHA
    ? { forceOriginalTexture:false, darkFloor:CHIN_JAW_DARK_FLOOR, highDarkenScale:0.5, deltaGain:CHIN_JAW_DELTA_GAIN,
        glowLuma:GLOW_LUMA, glowApply:0, brightCap:0, texRadiusFrac:CHIN_JAW_TEX_RADIUS,
        midRadiusFrac:CHIN_JAW_MID_RADIUS, midKeep:CHIN_JAW_MID_KEEP }
    : { forceOriginalTexture:true,  darkFloor:SCULPTRA_DARK_FLOOR, highDarkenScale:0, deltaGain:SCULPTRA_DELTA_GAIN,
        glowLuma:0, glowApply:SCULPTRA_GLOW_APPLY,
        brightCap:SCULPTRA_BRIGHT_CAP_FULL/SCULPTRA_DELTA_GAIN };
  return Object.assign(profile, opts || {});
}

/**
 * Build the Sculptra edit-mask PNG for a photo.
 * @param {HTMLImageElement} imgEl  loaded image (the exact photo being posted)
 * @param {object} [opts]
 * @param {number} [opts.maxDim=1024] long-edge cap; MUST match the posted image
 * @param {string} [opts.scope='full'] 'full' or 'temple'
 * @returns {Promise<Blob|null>} PNG blob (treated = transparent), or null if no face
 */
export async function buildSculptraMaskBlob(imgEl, opts){
  const o = opts || {};
  const maxDim = o.maxDim || 1024;
  const scope = o.scope || 'full';
  const sex = o.sex || 'female';

  const landmarks = await detectFace(imgEl);
  if(!landmarks) return null;

  // target dims: identical formula to the client's resizeToUpload
  const scale = Math.min(1, maxDim / Math.max(imgEl.naturalWidth, imgEl.naturalHeight));
  const w = Math.round(imgEl.naturalWidth * scale);
  const h = Math.round(imgEl.naturalHeight * scale);

  const m = buildTreatAlpha(landmarks, w, h, scope, sex);

  // rasterize: treated region transparent (alpha 0), protected opaque. RGB is
  // ignored by the edit endpoint; we paint white in the treated region so the
  // file is also human-inspectable.
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const cx = c.getContext("2d");
  const im = cx.createImageData(w, h), d = im.data;
  for(let i=0,p=0;i<m.length;i++,p+=4){
    const mm = Math.min(1, m[i]);
    const v = Math.round(255*mm);
    d[p]=v; d[p+1]=v; d[p+2]=v;
    d[p+3]=Math.round(255*(1-mm)); // alpha 0 = editable, 255 = protected
  }
  cx.putImageData(im, 0, 0);
  return await new Promise(resolve => c.toBlob(b => resolve(b), "image/png"));
}

export default buildSculptraMaskBlob;

/**
 * Composite the AI result against the original so that ONLY the treatment region
 * carries the AI change and everything else is the original photo, pixel for
 * pixel. This is the deterministic guarantee against the model beautifying skin,
 * under-eye, complexion, or background: those pixels become the original again.
 * @param {HTMLImageElement} beforeImg  the original photo that was sent
 * @param {HTMLImageElement} aiImg      the AI-edited result
 * @param {object} [opts] { scope:'full'|'temple_fold'|'temple', intensity:0..1 }
 * @returns {Promise<string|null>} a JPEG data URL, or null if no face (caller keeps the raw AI)
 */
export async function compositeSculptra(beforeImg, aiImg, opts){
  const scope = (opts && opts.scope) || 'full';
  const sex = (opts && opts.sex) || 'female';
  const textureRestore = !(opts && opts.textureRestore === false);
  const intensity = (opts && typeof opts.intensity === "number") ? Math.max(0, Math.min(1, opts.intensity)) : 1;
  const landmarks = await detectFace(beforeImg);
  if(!landmarks) return null;

  // M5b: composite on the ORIGINAL's grid, not the AI's. gpt-image-1 returns a
  // fixed supported size (often square) regardless of the input aspect, so the AI
  // result is the original non-uniformly resized into that size. Working on the AI
  // grid squished the original and emitted a squished-aspect result that no longer
  // lined up with the true original in the side-by-side export. Drawing the
  // original at its own aspect (uniform downscale, no distortion) and stretching
  // the AI back onto that grid reverses the API resize, so the AI content
  // re-aligns and the output matches the original framing.
  const maxDim = (opts && opts.maxDim) || 1024;
  const gs = Math.min(1, maxDim / Math.max(beforeImg.naturalWidth, beforeImg.naturalHeight));
  const w = Math.round(beforeImg.naturalWidth * gs), h = Math.round(beforeImg.naturalHeight * gs);
  const m = buildTreatAlpha(landmarks, w, h, scope, sex);

  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const cx = c.getContext("2d",{willReadFrequently:true});

  cx.drawImage(beforeImg, 0, 0, w, h);
  const before = cx.getImageData(0, 0, w, h), b = before.data;
  cx.drawImage(aiImg, 0, 0, w, h);
  const ai = cx.getImageData(0, 0, w, h), a = ai.data;

  // M7.6/7.7: outline gate (chin_jaw only): zero AI contribution outside the
  // true silhouette; the projected outline comes from the warp instead.
  // M10.4: overfill mode loosens the gate so the AI may extend the silhouette
  // itself (the overcorrection IS the visualization -- excess projection is the point).
  const isOverfill = !!(opts && opts.overfill);
  const outlineGate = (scope === 'chin_jaw' && !isOverfill) ? buildOutlineGate(landmarks, w, h, b) : null;

  // Geometry layer. Sculptra 'full': the M6 frontal lift (jowl + midface
  // re-drape, silhouette locked), applied to the BASE before blending. HA
  // chin_jaw: the M7.6 projection warp, applied AFTER blending (M7.9,
  // composite-then-warp) so the AI's shading travels with the moved tissue.
  // M10.4: overfill path skips the deterministic warp entirely (AI-heavy).
  // Null (other scopes, opts.warp false, or any error) means this is exactly
  // the M5 composite.
  const lift = (isOverfill) ? null : await buildWarpForScope(beforeImg, landmarks, w, h, scope, sex, opts);
  const postWarp = (scope === 'chin_jaw');
  const wb = (lift && !postWarp) ? new Uint8ClampedArray(b) : b;
  const liftSat = (opts && opts.liftSat != null) ? Math.max(0, Math.min(1, opts.liftSat)) : SCULP_LIFT_SAT;
  if(lift && !postWarp) applyLiftWarp(wb, b, w, h, lift, Math.min(intensity, liftSat));

  if(textureRestore){
    // Keep the AI low band (volume), restore the original high band (texture);
    // out = warpedOriginal + al * delta. Identical math to makeSculptraCompositor.
    // M6.2: al carries the response gain, so the top of the slider extrapolates
    // the (chroma-locked, floored) delta beyond the AI's own magnitude.
    const a0 = new Uint8ClampedArray(a);
    const W = faceWidthPx(landmarks, w, h);
    const tdOpts = sculptraTexOpts(scope, opts);
    // M9.1: jowl-lobe texture release (chin_jaw only; ?jowltex=off sets
    // jowlTexRelease false for the v35 A/B).
    if(scope === 'chin_jaw' && !(opts && opts.jowlTexRelease === false)){
      try { tdOpts.releaseField = buildJowlReleaseField(landmarks, w, h); } catch(e){ /* release is optional */ }
    }
    // M10.6: jaw-continuity feather (Sculptra 'full' only; ?jawcont=off disables).
    if(scope === 'full' && !(opts && opts.jawContinuity === false)){
      try { tdOpts.jawFeatherField = buildJawContinuityFeather(landmarks, w, h); } catch(e){ /* feather is optional */ }
    }
    const gain = tdOpts.deltaGain || 1;
    const glowApply = tdOpts.glowApply || 0;
    const { dR, dG, dB } = buildTextureDelta(b, a0, w, h, W, tdOpts);
    for(let i=0,p=0;i<m.length;i++,p+=4){
      const alm = Math.min(1, m[i]) * intensity * (outlineGate ? outlineGate[i] : 1);
      const al = alm * gain;
      const gl = alm * glowApply; // M6.3: glow is never gained
      a[p]   = wb[p]   + al*dR[i] + gl;
      a[p+1] = wb[p+1] + al*dG[i] + gl;
      a[p+2] = wb[p+2] + al*dB[i] + gl;
      a[p+3] = 255;
    }
  } else {
    for(let i=0,p=0;i<m.length;i++,p+=4){
      const al = Math.min(1, m[i]) * intensity * (outlineGate ? outlineGate[i] : 1);
      a[p]   = a[p]*al   + wb[p]*(1-al);
      a[p+1] = a[p+1]*al + wb[p+1]*(1-al);
      a[p+2] = a[p+2]*al + wb[p+2]*(1-al);
      a[p+3] = 255;
    }
  }
  // M7.9: chin_jaw warps the FINISHED composite so light moves with tissue.
  // M8.2: then reconcile the moved band's shading with the local light field.
  if(lift && postWarp){
    const src = new Uint8ClampedArray(a);
    const Wpx = faceWidthPx(landmarks, w, h);
    const isOblique45 = opts && (opts.angleId === 'l45' || opts.angleId === 'r45');
    const warpCap = isOblique45 ? CHINW_WARP_SAT_OBLIQUE : CHINW_WARP_SAT;
    const warpT = Math.min(intensity, warpCap); // M9.10 / M10.3 v56: oblique cap differs from frontal
    applyLiftWarp(a, src, w, h, lift, warpT);
    applyWarpShadeFix(a, buildLowLuma(b, w, h, Wpx), lift, w);
    if(!(opts && opts.warpSharpen === false))
      applyWarpSharpen(a, w, h, lift, warpT, Wpx); // M9.2: restore pore-scale crispness in the moved band
    if(!(opts && opts.jawDef === false))
      applyJawDefinition(a, w, h, landmarks, lift, warpT, Wpx, isOblique45); // M11.1: angle-aware shadow
  }
  // M11.1 LAYER 2: Submental forced restore (ChatGPT layer-2 defence).
  // Even after mask tightening the AI can paint cream/light artifacts below the
  // menton. This pass restores original pixels in the submental zone AFTER all
  // compositing and warping, guaranteeing the neck/submental core is never
  // modified regardless of what the mask or AI produced.
  // Only active for chin_jaw scope (submental leakage is only a chin/jaw issue).
  // The protected zone: a soft band below p152 (menton), derived from anatomy,
  // not a hard horizontal line. The central column (under the chin tip) starts
  // at SUBMENT_FLOOR_F below p152 and feathers upward over SUBMENT_BLEND_F.
  // Lateral regions are fully restored at the jawline (hF = -0.02).
  if(scope === 'chin_jaw' && !isOverfill){
    const p152 = landmarks[152];
    const faceH = (landmarks[10].y - landmarks[152].y) * h; // negative: 10 is top, 152 is bottom
    const absH = Math.abs(faceH) || (h * 0.35);
    const cx0 = landmarks[234].x * w; // left cheek landmark
    const cx1 = landmarks[454].x * w; // right cheek landmark
    const faceW = Math.abs(cx1 - cx0) || (w * 0.4);
    const mentonY = p152.y * h;
    const mentonX = p152.x * w;
    const SUBMENT_FLOOR_F = (sex === 'male') ? 0.03 : 0.09; // M10.5 v65: 0.06 -> 0.03 for male (artifacts at early slider) // tighter for male
    const SUBMENT_BLEND_F = 0.07;
    for(let y=0; y<h; y++){
      if(y < mentonY) continue; // above menton: never restore
      const dy = y - mentonY;
      const dyF = dy / absH;
      for(let x=0; x<w; x++){
        const dx = Math.abs(x - mentonX) / faceW;
        // Central column (under chin tip): restore below SUBMENT_FLOOR_F
        // Lateral (toward jaw): restore below 0.02 (at the jawline)
        const lateralFactor = smoothstep(0.10, 0.30, dx);
        const floorF = SUBMENT_FLOOR_F * (1 - lateralFactor) + 0.02 * lateralFactor;
        const blendF = SUBMENT_BLEND_F * (1 - lateralFactor) + 0.02 * lateralFactor;
        if(dyF >= floorF){
          // Fully restore original pixels in protected submental zone
          const restoreAlpha = smoothstep(floorF - blendF, floorF, dyF);
          const idx = (y * w + x) * 4;
          a[idx]   = Math.round(b[idx]   * restoreAlpha + a[idx]   * (1 - restoreAlpha));
          a[idx+1] = Math.round(b[idx+1] * restoreAlpha + a[idx+1] * (1 - restoreAlpha));
          a[idx+2] = Math.round(b[idx+2] * restoreAlpha + a[idx+2] * (1 - restoreAlpha));
        }
      }
    }
  }
  cx.putImageData(ai, 0, 0);
  return c.toDataURL("image/jpeg", 0.92);
}

/**
 * mask build, and pixel reads ONCE, then returns an apply(intensity) function
 * that only re-blends, so an intensity slider can update the image live with no
 * regeneration and no MediaPipe re-run. intensity scales the in-mask alpha:
 * 0 returns the original photo, 1 returns the full treatment-region AI volume.
 * @returns {Promise<((intensity:number)=>string)|null>} apply fn, or null if no face.
 */
export async function makeSculptraCompositor(beforeImg, aiImg, opts){
  const scope = (opts && opts.scope) || 'full';
  const sex = (opts && opts.sex) || 'female';
  const textureRestore = !(opts && opts.textureRestore === false);
  const landmarks = await detectFace(beforeImg);
  if(!landmarks) return null;
  // M5b: work on the ORIGINAL's grid, not the AI's (see compositeSculptra). The AI
  // is stretched back onto the original aspect so its content re-aligns and the
  // emitted result matches the original framing for a clean side-by-side export.
  const maxDim = (opts && opts.maxDim) || 1024;
  const gs = Math.min(1, maxDim / Math.max(beforeImg.naturalWidth, beforeImg.naturalHeight));
  const w = Math.round(beforeImg.naturalWidth * gs), h = Math.round(beforeImg.naturalHeight * gs);
  const m = buildTreatAlpha(landmarks, w, h, scope, sex);

  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const cx = c.getContext("2d",{willReadFrequently:true});
  cx.drawImage(beforeImg, 0, 0, w, h);
  const before = cx.getImageData(0, 0, w, h);
  const b = before.data;                          // pristine original pixels
  cx.drawImage(aiImg, 0, 0, w, h);
  const out = cx.getImageData(0, 0, w, h);
  const a0 = new Uint8ClampedArray(out.data);     // pristine AI pixels
  const o = out.data;

  // M7.6/7.7: outline gate (chin_jaw only): zero AI contribution outside the
  // true silhouette; the projected outline comes from the warp instead.
  // M10.4: overfill mode loosens the gate so the AI may extend the silhouette
  // itself (the overcorrection IS the visualization -- excess projection is the point).
  const isOverfill = !!(opts && opts.overfill);
  const outlineGate = (scope === 'chin_jaw' && !isOverfill) ? buildOutlineGate(landmarks, w, h, b) : null;

  // M5.1: precompute the texture-restore delta once. apply() then writes
  // out = original + al*delta, which dials the AI volume with the slider while
  // holding the original's high-frequency texture sharp at every intensity.
  let dR=null, dG=null, dB=null, gain=1, glowApply=0;
  if(textureRestore){
    const W = faceWidthPx(landmarks, w, h);
    const tdOpts = sculptraTexOpts(scope, opts);
    // M9.1: jowl-lobe texture release (chin_jaw only; ?jowltex=off sets
    // jowlTexRelease false for the v35 A/B).
    if(scope === 'chin_jaw' && !(opts && opts.jowlTexRelease === false)){
      try { tdOpts.releaseField = buildJowlReleaseField(landmarks, w, h); } catch(e){ /* release is optional */ }
    }
    // M10.6: jaw-continuity feather (Sculptra 'full' only; ?jawcont=off disables).
    if(scope === 'full' && !(opts && opts.jawContinuity === false)){
      try { tdOpts.jawFeatherField = buildJawContinuityFeather(landmarks, w, h); } catch(e){ /* feather is optional */ }
    }
    gain = tdOpts.deltaGain || 1;
    glowApply = tdOpts.glowApply || 0;
    const d = buildTextureDelta(b, a0, w, h, W, tdOpts);
    dR=d.dR; dG=d.dG; dB=d.dB;
  }

  // Geometry layer, precomputed once (M6 Sculptra lift or M7.6 chin/jaw
  // projection warp by scope). apply() re-samples only the field's bounding box
  // per call (bilinear, offsets scaled by t), so the slider dials geometry and
  // light together in real time. Null = exact M5 composite.
  // M7.9: order is scope-dependent. Sculptra warps the BASE then blends (M6,
  // calibrated, untouched). chin_jaw blends in the original frame then warps
  // the FINISHED composite, so the AI's border shadow and edge shading travel
  // outward with the projected tissue instead of staying at the old outline.
  // M10.4: overfill path skips the deterministic warp entirely (AI-heavy).
  const lift = isOverfill ? null : await buildWarpForScope(beforeImg, landmarks, w, h, scope, sex, opts);
  const postWarp = (scope === 'chin_jaw');
  const wb = (lift && !postWarp) ? new Uint8ClampedArray(b) : b;
  const warpSrc = (lift && postWarp) ? new Uint8ClampedArray(b.length) : null;
  // M8.2: reference light field for the post-warp shading reconciliation.
  const lowY = (lift && postWarp) ? buildLowLuma(b, w, h, faceWidthPx(landmarks, w, h)) : null;
  const sharpW = (lift && postWarp) ? faceWidthPx(landmarks, w, h) : 0; // M9.2

  // M11.1 LAYER 2: precompute submental geometry for the forced restore in apply().
  // These are closed over by the returned apply() function.
  const mentonY   = landmarks[152].y * h;
  const mentonX   = landmarks[152].x * w;
  const faceH_abs = Math.abs((landmarks[10].y - landmarks[152].y) * h) || (h * 0.35);
  const faceW_abs = Math.abs((landmarks[454].x - landmarks[234].x) * w) || (w * 0.4);
  // rename to avoid shadowing outer scope 'absH' / 'faceW' if they exist
  const absH  = faceH_abs;
  const faceW = faceW_abs;

  // M11 Enhanced: liftSat is opts-overridable so Enhanced course can run the
  // geometry warp at higher intensity than the standard slider cap. The warp
  // uses the patient's own pixels displaced -- no AI artifacts. Raising this
  // for Enhanced gives visible structural support without luminance blobs.
  const liftSat = (opts && opts.liftSat != null) ? Math.max(0, Math.min(1, opts.liftSat)) : SCULP_LIFT_SAT;

  return function apply(intensity){
    const t = Math.max(0, Math.min(1, (typeof intensity === "number" ? intensity : 1)));
    if(lift && !postWarp) applyLiftWarp(wb, b, w, h, lift, Math.min(t, liftSat));
    if(textureRestore){
      // M6.2: al carries the response gain (delta extrapolation at the top).
      // M6.3: the glow term is scaled by mask and slider only, never by gain.
      // M7.6: the outline gate zeroes all out-of-silhouette AI paint.
      for(let i=0,p=0;i<m.length;i++,p+=4){
        const alm = Math.min(1, m[i]) * t * (outlineGate ? outlineGate[i] : 1);
        const al = alm * gain;
        const gl = alm * glowApply;
        o[p]   = wb[p]   + al*dR[i] + gl;
        o[p+1] = wb[p+1] + al*dG[i] + gl;
        o[p+2] = wb[p+2] + al*dB[i] + gl;
        o[p+3] = 255;
      }
    } else {
      for(let i=0,p=0;i<m.length;i++,p+=4){
        const al = Math.min(1, m[i]) * t * (outlineGate ? outlineGate[i] : 1);
        o[p]   = a0[p]*al   + wb[p]*(1-al);
        o[p+1] = a0[p+1]*al + wb[p+1]*(1-al);
        o[p+2] = a0[p+2]*al + wb[p+2]*(1-al);
        o[p+3] = 255;
      }
    }
    // M7.9: chin_jaw warps the finished composite (light travels with tissue).
    // M8.2: then reconcile the moved band's shading with the local light field.
    if(lift && postWarp){
      warpSrc.set(o);
      const isOblique45 = opts && (opts.angleId === 'l45' || opts.angleId === 'r45');
      const warpCap = isOblique45 ? CHINW_WARP_SAT_OBLIQUE : CHINW_WARP_SAT;
      const warpT = Math.min(t, warpCap); // M9.10 / M10.3 v56: oblique cap differs from frontal
      applyLiftWarp(o, warpSrc, w, h, lift, warpT);
      applyWarpShadeFix(o, lowY, lift, w);
      if(!(opts && opts.warpSharpen === false))
        applyWarpSharpen(o, w, h, lift, warpT, sharpW); // M9.2: restore pore-scale crispness in the moved band
      if(!(opts && opts.jawDef === false))
        applyJawDefinition(o, w, h, landmarks, lift, warpT, sharpW, isOblique45); // M11.1: angle-aware shadow
    }
    // M11.1 LAYER 2: Submental forced restore in the live compositor.
    // Mirrors the same protection in compositeSculptra. Precomputed geometry
    // values (mentonY, mentonX, absH, faceW) are closed over from setup.
    if(scope === 'chin_jaw' && !isOverfill){
      const SUBMENT_FLOOR_F = (sex === 'male') ? 0.03 : 0.09; // M10.5 v65: 0.06 -> 0.03 for male (artifacts at early slider)
      const SUBMENT_BLEND_F = 0.07;
      for(let y=0; y<h; y++){
        if(y < mentonY) continue;
        const dy = y - mentonY;
        const dyF = dy / absH;
        for(let x=0; x<w; x++){
          const dx = Math.abs(x - mentonX) / faceW;
          const lateralFactor = smoothstep(0.10, 0.30, dx);
          const floorF = SUBMENT_FLOOR_F * (1 - lateralFactor) + 0.02 * lateralFactor;
          const blendF = SUBMENT_BLEND_F * (1 - lateralFactor) + 0.02 * lateralFactor;
          if(dyF >= floorF){
            const restoreAlpha = smoothstep(floorF - blendF, floorF, dyF);
            const idx = (y * w + x) * 4;
            o[idx]   = Math.round(b[idx]   * restoreAlpha + o[idx]   * (1 - restoreAlpha));
            o[idx+1] = Math.round(b[idx+1] * restoreAlpha + o[idx+1] * (1 - restoreAlpha));
            o[idx+2] = Math.round(b[idx+2] * restoreAlpha + o[idx+2] * (1 - restoreAlpha));
          }
        }
      }
    }
    cx.putImageData(out, 0, 0);
    return c.toDataURL("image/jpeg", 0.92);
  };
}

// ---- M16: feature add-on skin preservation (approach B) --------------------
// Lip/nose filler add-ons are a SECOND gpt-image edit of the baseline. A large,
// salient feature change (e.g. drastic lips) makes the model re-render the whole
// frame, degrading skin texture everywhere -- while a subtle edit (tear trough)
// barely re-renders and leaves skin intact. This composite keeps the baseline's
// real skin over the ENTIRE face and takes ONLY the feathered feature region
// (lips or nose) from the add-on, so the drastic feature change survives while
// pores/texture outside it stay pixel-identical to the baseline. The mask is
// built from landmarks detected on the ADD-ON (the fuller feature), so added
// volume is not clipped. Fails safe: any error / missing face returns null and
// the caller falls back to the raw add-on.
function convexHull(points){
  const pts = points.slice().sort((a,b)=> a[0]-b[0] || a[1]-b[1]);
  if(pts.length < 3) return pts;
  const cross=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);
  const lower=[]; for(const p of pts){ while(lower.length>=2 && cross(lower[lower.length-2],lower[lower.length-1],p)<=0) lower.pop(); lower.push(p); }
  const upper=[]; for(let i=pts.length-1;i>=0;i--){ const p=pts[i]; while(upper.length>=2 && cross(upper[upper.length-2],upper[upper.length-1],p)<=0) upper.pop(); upper.push(p); }
  lower.pop(); upper.pop(); return lower.concat(upper);
}

export async function compositeFeatureAddon(baselineImg, addonImg, feature, opts){
  try {
    if(!baselineImg || !addonImg) return null;
    const idx        = (feature === 'nose') ? NOSE : LIPS;
    const expand     = (feature === 'nose') ? 1.18 : 1.24;   // grow hull outward from centroid
    const featherFrac= (feature === 'nose') ? 0.018 : 0.024; // blur radius as fraction of face width

    // Landmarks from the ADD-ON (fuller feature) so added volume is not clipped.
    const lm = await detectFace(addonImg);
    if(!lm) return null;

    // Composite on the baseline's grid (uniform downscale), matching the other paths.
    const maxDim = (opts && opts.maxDim) || 1024;
    const gs = Math.min(1, maxDim / Math.max(baselineImg.naturalWidth, baselineImg.naturalHeight));
    const w = Math.round(baselineImg.naturalWidth * gs), h = Math.round(baselineImg.naturalHeight * gs);
    const W = faceWidthPx(lm, w, h);

    // Feature landmarks -> pixels, expanded outward from their centroid.
    let pts = idx.map(i => lm[i]).filter(Boolean).map(p => [p.x*w, p.y*h]);
    if(pts.length < 3) return null;
    const cx0 = pts.reduce((s,p)=>s+p[0],0)/pts.length, cy0 = pts.reduce((s,p)=>s+p[1],0)/pts.length;
    pts = pts.map(p => [cx0 + (p[0]-cx0)*expand, cy0 + (p[1]-cy0)*expand]);
    const hull = convexHull(pts);
    if(hull.length < 3) return null;

    // Mask: white feature hull on black.
    const mk = document.createElement("canvas"); mk.width=w; mk.height=h;
    const mkx = mk.getContext("2d");
    mkx.fillStyle="#000"; mkx.fillRect(0,0,w,h);
    mkx.fillStyle="#fff"; mkx.beginPath(); mkx.moveTo(hull[0][0], hull[0][1]);
    for(let i=1;i<hull.length;i++) mkx.lineTo(hull[i][0], hull[i][1]);
    mkx.closePath(); mkx.fill();

    // Feather the mask edge for a seamless blend.
    const fb = document.createElement("canvas"); fb.width=w; fb.height=h;
    const fbx = fb.getContext("2d");
    fbx.filter = "blur(" + Math.max(1, featherFrac*W) + "px)"; fbx.drawImage(mk, 0, 0); fbx.filter="none";

    // Add-on restricted to the feathered feature region.
    const feat = document.createElement("canvas"); feat.width=w; feat.height=h;
    const fx = feat.getContext("2d");
    fx.drawImage(addonImg, 0, 0, w, h);
    fx.globalCompositeOperation = "destination-in"; fx.drawImage(fb, 0, 0);

    // Baseline skin everywhere; add-on feature composited on top.
    const out = document.createElement("canvas"); out.width=w; out.height=h;
    const ox = out.getContext("2d");
    ox.drawImage(baselineImg, 0, 0, w, h);
    ox.drawImage(feat, 0, 0);

    return out.toDataURL("image/jpeg", 0.92);
  } catch(e){
    console.warn('[Visualize] M16 feature composite failed; using raw add-on.', e);
    return null;
  }
}
