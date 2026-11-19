/* ij-proc-fiji.js — worker-side operations of package fiji (wave 3): Curve Fitting, Fractal Box Count,
 * Analyze Skeleton, Local Thickness. Page AND worker; pure (no DOM, no engine globals); every operation is
 * registered with IJOpRegistry.define (ij-core.js).
 *
 *   curveFit          compute  ij.measure.CurveFitter + ij.measure.Minimizer, ported line by line (ImageJ 1.54p, public domain)
 *   fractalBoxCount   compute  ij.plugin.filter.FractalBoxCounter (box counts of a binary image + the log-log line)
 *   analyzeSkeleton   compute  Arganda-Carreras et al. 2010 (paper definitions), 2D
 *   skeletonTagged    newdoc   the tagged skeleton image of the same analysis (end-point 30, junction 70, slab 127)
 *   localThickness    newdoc   Hildebrand & Rüegsegger 1997, 32-bit "<name>_LocThk"
 *
 * Reference. CurveFitter / Minimizer / FractalBoxCounter / IJMath: ImageJ 1.54p source (public domain), cited by file and
 * line below. Analyze Skeleton and Local Thickness are Fiji plugins under the GPL: their code was never read, the
 * algorithms follow the two papers and are compared to the numbers a real Fiji printed (tests/fixtures/ij-wave3/fiji/
 * skeleton, localthickness — the tolerances are stated in tests/js/test_ij_fiji_skeleton.mjs / _thickness.mjs).
 *
 * Determinism. Nothing here reads the clock or Math.random: the Minimizer's seeds come from `randomSeed` and the
 * ported java.util.Random (IJShared.JavaRandom); a cancel or a progress tick never changes a number.
 */
(function (root) {
  'use strict';
  const R = root.IJOpRegistry;
  const S = root.IJShared;

  function ijError(code, message) { const e = new Error(message || code); e.code = code; return e; }
  const noop = () => {};
  const noopAsync = async () => {};

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // 1. Curve fitting — ij.measure.Minimizer + ij.measure.CurveFitter + ij.util.IJMath.erf
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  // ij/util/IJMath.java:17-27 — "maximum absolute and relative errors below 1e-12"
  const ERF_A = 0.05857895078654250866288, ERF_B = -0.00626245895772819579, ERF_C = -0.00299946450696036814,
    ERF_D = 0.289389696496082416, ERF_E = 0.0539962589851632982, ERF_F = 0.00508516909930653109,
    ERF_G = 0.000215969713046142876, ERF_H = -0.000225663858340491571, ERF_I = -3.06833213472529049e-7;
  function erf(x) {
    const x2 = x * x;
    if (x2 < 1e-8) return (2 / Math.sqrt(Math.PI)) * x * (1 + x2 * (-1 / 3 + x2 * (1 / 10)));   // Taylor series for low x
    // "the polynomials go crazy for some large x2; erf(6) is 1 - 2e-17, less than ulp from 1"
    let e;
    if (x2 > 36) e = 1;
    else {
      const t = x * ((2 / Math.sqrt(Math.PI) - ERF_A) + ERF_A * (1 + x2 * x2 * (ERF_B + x2 * (ERF_C + x2 * (ERF_H + x2 * ERF_I)))) /
        (1 + x2 * (ERF_D + x2 * (ERF_E + x2 * (ERF_F + x2 * ERF_G)))));
      e = Math.sqrt(1 - Math.exp(-(t * t)));
    }
    return x > 0 ? e : -e;
  }

  // ---- Minimizer.java (Nelder-Mead, Lagarias et al. 1998). ImageJ runs two threads unless setMaximumThreads(1); the Studio
  // runs ONE (deterministic): `useSingleThread` of the source (`maxLoopCount*=2`, only the main-thread minimizeOnce). ----
  const M_SUCCESS = 0, M_INITIALIZATION_FAILURE = 1, M_ABORTED = 2, M_REINITIALIZATION_FAILURE = 3, M_MAX_ITERATIONS_EXCEEDED = 4, M_MAX_RESTARTS_EXCEEDED = 5;
  // Minimizer.java:62-67
  const STATUS_STRING = ['Success', 'Initialization failure; no result', 'Aborted', 'Re-initialization failure (inaccurate result?)',
    'Max. no. of iterations reached (inaccurate result?)', 'Max. no. of restarts reached (inaccurate result?)'];
  const C_REFLECTION = 1.0, C_CONTRACTION = 0.5, C_EXPANSION = 2.0, C_SHRINK = 0.5, ITER_FACTOR = 750;   // Minimizer.java:70-74
  const WORST = 0, NEXT_WORST = 1, BEST = 2;
  const YIELD_EVERY = 16;   // iterations between two cooperative yields (a cancel / progress point; never changes a number)

  class Minimizer {
    constructor(hooks) {
      this.hooks = Object.assign({ check: noop, tick: noopAsync }, hooks || {});
      this.numParams = 0; this.numVertices = 0; this.numExtraArrayElements = 0; this.userFunction = null;
      this.maxRelError = 1e-10; this.maxAbsError = 1e-100; this.paramResolutions = null;
      this.maxIter = 0; this.totalNumIter = 0; this.numCompletedMinimizations = 0; this.maxRestarts = 2; this.randomSeed = 0;
      this.status = M_SUCCESS; this.wasInitialized = false; this.result = null; this.resultsVector = null;
      this.evals = 0;
    }

    setFunction(userFunction, numParams) {
      if (this.maxIter <= 0) {   // Minimizer.java:112-117
        this.maxIter = ITER_FACTOR * numParams * numParams;
        if (this.maxRestarts > 0) this.maxIter *= 2;
      }
      this.userFunction = userFunction; this.numParams = numParams; this.numVertices = numParams + 1;
    }
    setMaxIterations(x) { this.maxIter = x; }
    setMaxRestarts(n) { this.maxRestarts = n; }
    setRandomSeed(n) { this.randomSeed = n | 0; }
    setMaxError(rel, abs) { this.maxRelError = rel; if (abs !== undefined) this.maxAbsError = abs; }
    setExtraArrayElements(n) { this.numExtraArrayElements = n; }
    getIterations() { return this.totalNumIter; }

    getParams() {   // Minimizer.java:354-361
      if (this.result === null) {
        this.result = new Array(this.numParams + 1 + this.numExtraArrayElements).fill(NaN);
      }
      return this.result;
    }

    value(v) { return v[this.numParams]; }
    evaluate(vertex) {
      if ((++this.evals & 255) === 0) this.hooks.check();
      vertex[this.numParams] = this.userFunction.userFunction(vertex, 0);
    }

    // Minimizer.java:158-195 (Minimizer.minimize(double[], double[]) with useSingleThread = true)
    async minimize(initialParams, initialParamVariations) {
      this.status = M_SUCCESS;
      this.resultsVector = [];
      let maxLoopCount = this.maxRestarts + 1;
      maxLoopCount *= 2;   // "if (useSingleThread) maxLoopCount*=2;  // if we have only one thread, loop twice as many times"
      for (let i = 0; i < maxLoopCount; i++) {
        await this.minimizeOnce(initialParams, initialParamVariations, this.randomSeed + i);
        if (this.resultsVector.length === 0 && this.result === null) return this.status;
        if (this.result === null) this.result = this.resultsVector[0];
        for (const r of this.resultsVector) if (this.value(r) < this.value(this.result)) this.result = r;
        if (this.status !== M_SUCCESS && this.status !== M_REINITIALIZATION_FAILURE && this.status !== M_MAX_ITERATIONS_EXCEEDED) return this.status;
        if (this.totalNumIter >= this.maxIter) return M_MAX_ITERATIONS_EXCEEDED;
        for (let ir = 0; ir < this.resultsVector.length; ir++) {
          if (!this.belowErrorLimit(this.value(this.resultsVector[ir]), this.value(this.result), 1.0)) {
            this.resultsVector.splice(ir, 1);   // discard results that are significantly worse
            ir--;
          }
        }
        if (this.resultsVector.length >= 2) return M_SUCCESS;   // two (almost) equal results: enough
      }
      return this.maxRestarts > 0 ? M_MAX_RESTARTS_EXCEEDED : this.status;
    }

    // Minimizer.java:425-455
    async minimizeOnce(initialParams, initialParamVariations, seed) {
      const random = new S.JavaRandom(seed);
      const simp = this.makeSimplex(initialParams, initialParamVariations, random);
      if (simp === null) {
        this.status = this.wasInitialized ? M_REINITIALIZATION_FAILURE : M_INITIALIZATION_FAILURE;
        return;
      }
      this.wasInitialized = true;
      let bestVertexNumber = await this.minimizeSimplex(simp);   // first minimization
      let bestValueSoFar = this.value(simp[bestVertexNumber]);
      let reinitialisationFailure = false;
      while (this.status === M_SUCCESS || this.status === M_REINITIALIZATION_FAILURE) {
        const paramVariations = this.makeNewParamVariations(simp, bestVertexNumber, initialParams, initialParamVariations);
        if (!this.reInitializeSimplex(simp, bestVertexNumber, paramVariations, random)) { reinitialisationFailure = true; break; }
        bestVertexNumber = await this.minimizeSimplex(simp);     // minimize with reinitialized simplex
        if (this.belowErrorLimit(this.value(simp[bestVertexNumber]), bestValueSoFar, 2.0)) break;
        bestValueSoFar = this.value(simp[bestVertexNumber]);
      }
      if (reinitialisationFailure) this.status = M_REINITIALIZATION_FAILURE;
      else if (this.status === M_SUCCESS || this.status === M_REINITIALIZATION_FAILURE) this.numCompletedMinimizations++;
      this.resultsVector.push(simp[bestVertexNumber]);
    }

    // Minimizer.java:462-566. "Note that one call to this function never does more than 0.4*maxIter iterations."
    async minimizeSimplex(simp) {
      const nv = this.numParams + 1 + this.numExtraArrayElements;
      const wnb = [0, 0, 0];
      const center = new Array(nv).fill(0), reflected = new Array(nv).fill(0), secondTry = new Array(nv).fill(0);
      const value = (v) => v[this.numParams];
      this.order(simp, wnb);
      let worst = wnb[WORST], nextWorst = wnb[NEXT_WORST], best = wnb[BEST];
      let thisNumIter = 0;
      for (;;) {
        this.totalNumIter++;
        thisNumIter++;
        if ((thisNumIter & (YIELD_EVERY - 1)) === 0) {
          this.hooks.check();
          await this.hooks.tick(Math.min(1, this.totalNumIter / this.maxIter));
        }
        iteration: {
          this.getCenter(simp, worst, center);   // centroid of vertices except worst
          // Reflect worst vertex through centroid of not-worst
          this.getVertexAndEvaluate(center, simp[worst], -C_REFLECTION, reflected);
          if (value(reflected) <= value(simp[best])) {   // if it's better than the best, try expanding it
            this.getVertexAndEvaluate(center, simp[worst], -C_EXPANSION, secondTry);
            if (value(secondTry) <= value(reflected)) { this.copyVertex(secondTry, simp[worst]); break iteration; }
          }
          if (value(reflected) < value(simp[nextWorst])) {
            this.copyVertex(reflected, simp[worst]);   // keep reflected if better than 2nd worst
            break iteration;
          } else if (value(reflected) < value(simp[worst])) {
            // try outer contraction
            this.getVertexAndEvaluate(center, simp[worst], -C_CONTRACTION, secondTry);
            if (value(secondTry) <= value(reflected)) { this.copyVertex(secondTry, simp[worst]); break iteration; }
          } else if (value(reflected) > value(simp[worst]) || Number.isNaN(value(reflected))) {
            // else inner contraction
            this.getVertexAndEvaluate(center, simp[worst], C_CONTRACTION, secondTry);
            if (value(secondTry) < value(simp[worst])) { this.copyVertex(secondTry, simp[worst]); break iteration; }
          }
          // "if everything else has failed, contract simplex in on best"
          this.shrinkSimplexAndEvaluate(simp, best);
          break iteration;
        }
        const checkParamResolution = this.paramResolutions !== null && this.belowResolutionLimit2(simp[worst], simp[best]);
        this.order(simp, wnb);
        worst = wnb[WORST]; nextWorst = wnb[NEXT_WORST]; best = wnb[BEST];
        if (checkParamResolution && this.belowResolutionLimit(simp, best)) break;
        if (this.belowErrorLimit(value(simp[best]), value(simp[worst]), 4.0)) {   // make sure we are at the minimum:
          this.getCenter(simp, -1, secondTry);   // check center of the simplex
          this.evaluate(secondTry);
          if (value(secondTry) < value(simp[best])) this.copyVertex(secondTry, simp[best]);   // better than best: keep
        }
        if (this.belowErrorLimit(value(simp[best]), value(simp[worst]), 4.0)) break;   // no large spread of values
        // "thisNumIter>4*(maxIter/10)": Java int division
        if (this.totalNumIter > this.maxIter || thisNumIter > 4 * Math.trunc(this.maxIter / 10)) this.status = M_MAX_ITERATIONS_EXCEEDED;
        if (this.status !== M_SUCCESS) break;
      }
      return best;
    }

    getVertexAndEvaluate(center, worstVertex, howFar, newVertex) {
      for (let i = 0; i < this.numParams; i++) newVertex[i] = (1.0 - howFar) * center[i] + howFar * worstVertex[i];
      this.evaluate(newVertex);
    }

    getCenter(simp, excludeVertex, center) {
      center.fill(0);
      let nV = 0;
      for (let v = 0; v < this.numVertices; v++) {
        if (v !== excludeVertex) {
          for (let i = 0; i < this.numParams; i++) center[i] += simp[v][i];
          nV++;
        }
      }
      const norm = 1.0 / nV;
      for (let i = 0; i < this.numParams; i++) center[i] *= norm;
    }

    shrinkSimplexAndEvaluate(simp, best) {
      for (let v = 0; v < this.numVertices; v++) {
        if (v !== best) {
          for (let i = 0; i < this.numParams; i++) simp[v][i] = C_SHRINK * simp[v][i] + (1 - C_SHRINK) * simp[best][i];
          this.evaluate(simp[v]);
        }
      }
    }

    belowErrorLimit(highest, lowest, sensitivity) {
      const absError = sensitivity * Math.abs(highest - lowest);
      const relError = absError / (Math.max(Math.abs(highest), Math.abs(lowest)) + 1e-100);
      return relError < this.maxRelError || absError < this.maxAbsError;
    }

    makeSimplex(initialParams, initialParamVariations, random) {
      const simp = [];
      for (let v = 0; v < this.numVertices; v++) simp.push(new Array(this.numParams + 1 + this.numExtraArrayElements).fill(0));
      if (initialParams) {
        const n = Math.min(initialParams.length, this.numParams);
        for (let i = 0; i < n; i++) simp[0][i] = initialParams[i];
      }
      this.evaluate(simp[0]);
      if (Number.isNaN(this.value(simp[0]))) this.findValidInitalParams(simp[0], initialParamVariations, random);
      if (Number.isNaN(this.value(simp[0]))) return null;
      return this.initializeSimplex(simp, initialParamVariations, random) ? simp : null;
    }

    belowResolutionLimit(simp, best) {
      for (let v = 0; v < this.numVertices; v++) if (v !== best && !this.belowResolutionLimit2(simp[v], simp[best])) return false;
      return true;
    }
    belowResolutionLimit2(v1, v2) {
      for (let i = 0; i < this.numParams; i++) if (Math.abs(v1[i] - v2[i]) >= this.paramResolutions[i]) return false;
      return true;
    }

    // Minimizer.java:672-698
    findValidInitalParams(params, initialParamVariations, random) {
      const n = this.numParams;
      const maxAttempts = 50 * n * n;
      const rangeMultiplyLog = Math.log(1e20) / (maxAttempts - 1);
      const firstParams = new Array(n), variations = new Array(n);
      for (let i = 0; i < n; i++) {
        firstParams[i] = Number.isNaN(params[i]) ? 0 : params[i];
        variations[i] = initialParamVariations ? initialParamVariations[i] : 0.1 * firstParams[i];
        if (Number.isNaN(variations[i]) || Math.abs(variations[i]) < 1e-10 || Math.abs(variations[i]) > 1e10) variations[i] = 0.1;
      }
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        for (let i = 0; i < n; i++) {
          const multiplier = attempt < Math.trunc(maxAttempts / 10) ? 1 : Math.exp(rangeMultiplyLog * attempt * 2 * (random.nextDouble() - 0.5));
          params[i] = multiplier * (firstParams[i] + 2 * (random.nextDouble() - 0.5) * variations[i]);
        }
        this.evaluate(params);
        if (!Number.isNaN(this.value(params))) return;
      }
    }

    reInitializeSimplex(simp, bestVertexNumber, paramVariations, random) {
      if (bestVertexNumber !== 0) { const swap = simp[0]; simp[0] = simp[bestVertexNumber]; simp[bestVertexNumber] = swap; }
      return this.initializeSimplex(simp, paramVariations, random);
    }

    // Minimizer.java:714-762
    initializeSimplex(simp, paramVariations, random) {
      const n = this.numParams;
      const variations = new Array(n);
      for (let i = 0; i < n; i++) {
        let range = paramVariations && i < paramVariations.length ? paramVariations[i] : 0.1 * Math.abs(simp[0][i]);
        if (range < 1e-100 || Number.isNaN(range)) range = 0.01;   // range must be nonzero
        if (Math.abs(range / simp[0][i]) < 1e-10) range = Math.abs(simp[0][i] * 1e-10);   // range must be more than very last digits
        variations[i] = range;
      }
      const maxAttempts = 100 * n;
      for (let v = 1; v < this.numVertices; v++) {
        let numTries = 0;
        do {
          if (numTries++ > maxAttempts) return false;
          // "Create a vector orthogonal to all others in a coordinate system where every value is normalized to its
          //  respective variations value."
          for (let i = 0; i < n; i++) simp[v][i] = 2 * random.nextFloat() - 1.0;
          if (numTries < Math.trunc(maxAttempts / 3)) {
            for (let v2 = 1; v2 < v; v2++) {   // to avoid a degenerate simplex, make orthogonal to all others
              let lengthSqr = 0, innerProduct = 0;
              for (let i = 0; i < n; i++) {
                const x2 = (simp[v2][i] - simp[0][i]) / variations[i];
                lengthSqr += x2 * x2;
                innerProduct += x2 * simp[v][i];
              }
              for (let i = 0; i < n; i++) simp[v][i] -= ((simp[v2][i] - simp[0][i]) / variations[i]) * (innerProduct / lengthSqr);
            }
          }
          let sumSqr = 0;   // normalize the 'excursion vector' to length = 1
          for (let i = 0; i < n; i++) sumSqr += simp[v][i] * simp[v][i];
          if (sumSqr < 1e-14) continue;   // bad luck with random numbers, excursion vector almost zero
          if (numTries > 2 && sumSqr > 1e-6) sumSqr = 1;   // don't normalize if attempts with normalized were unsuccessful
          for (let i = 0; i < n; i++) simp[v][i] = simp[0][i] + simp[v][i] / Math.sqrt(sumSqr) * variations[i];
          this.evaluate(simp[v]);
        } while (Number.isNaN(this.value(simp[v])) && (this.status === M_SUCCESS || this.status === M_REINITIALIZATION_FAILURE));
      }
      return true;
    }

    // Minimizer.java:777-807
    makeNewParamVariations(simp, bestVertexNumber, initialParams, initialParamVariations) {
      const n = this.numParams;
      const paramVariations = new Array(n).fill(0), relatedTo = new Array(n).fill(0);
      let logTypicalRelativeVariation = 0;
      for (let i = 0; i < n; i++) {
        for (let v = 0; v < this.numVertices; v++) {
          if (v !== bestVertexNumber) {
            const delta = Math.abs(simp[v][i] - simp[bestVertexNumber][i]);
            paramVariations[i] += delta * delta;
          }
        }
        paramVariations[i] = 10 * Math.sqrt(paramVariations[i]);   // make the new simplex larger than the old one
        relatedTo[i] = initialParamVariations && initialParamVariations.length >= n ? initialParamVariations[i]
          : Math.max(Math.abs(initialParams[i]), Math.abs(simp[bestVertexNumber][i]));
        const logRelativeVariation = paramVariations[i] > relatedTo[i] ? 0 : Math.log(paramVariations[i] / relatedTo[i]);
        logTypicalRelativeVariation += logRelativeVariation;
      }
      logTypicalRelativeVariation /= n;
      const typicalRelativeVariation = Math.exp(logTypicalRelativeVariation);
      const WORST_RATIO = 1e-3;
      for (let i = 0; i < n; i++) {
        if (paramVariations[i] < relatedTo[i] && paramVariations[i] / relatedTo[i] < typicalRelativeVariation * WORST_RATIO) {
          paramVariations[i] = relatedTo[i] * typicalRelativeVariation * WORST_RATIO;
        }
        if (this.paramResolutions !== null && paramVariations[i] < 10 * this.paramResolutions[i]) paramVariations[i] = 10 * this.paramResolutions[i];
      }
      return paramVariations;
    }

    copyVertex(newVertex, vertex) { for (let i = 0; i < newVertex.length; i++) vertex[i] = newVertex[i]; }

    order(simp, wnb) {
      let worst = 0, nextWorst = 0, best = 0;
      for (let i = 0; i < this.numVertices; i++) {
        if (this.value(simp[i]) < this.value(simp[best])) best = i;
        if (this.value(simp[i]) > this.value(simp[worst])) worst = i;
      }
      nextWorst = best;
      for (let i = 0; i < this.numVertices; i++) if (i !== worst && this.value(simp[i]) > this.value(simp[nextWorst])) nextWorst = i;
      wnb[WORST] = worst; wnb[NEXT_WORST] = nextWorst; wnb[BEST] = best;
    }
  }

  // ---- CurveFitter.java ----
  const F = {
    STRAIGHT_LINE: 0, POLY2: 1, POLY3: 2, POLY4: 3, EXPONENTIAL: 4, POWER: 5, LOG: 6, RODBARD: 7, GAMMA_VARIATE: 8, LOG2: 9,
    RODBARD2: 10, EXP_WITH_OFFSET: 11, GAUSSIAN: 12, EXP_RECOVERY: 13, INV_RODBARD: 14, EXP_REGRESSION: 15, POWER_REGRESSION: 16,
    POLY5: 17, POLY6: 18, POLY7: 19, POLY8: 20, GAUSSIAN_NOOFFSET: 21, EXP_RECOVERY_NOOFFSET: 22, CHAPMAN: 23, ERF: 24
  };
  const CUSTOM = 100, GAUSSIAN_INTERNAL = 101, RODBARD_INTERNAL = 102;
  // CurveFitter.java:59-67 "Nicer sequence of the built-in function types"
  const SORTED_TYPES = [F.STRAIGHT_LINE, F.POLY2, F.POLY3, F.POLY4, F.POLY5, F.POLY6, F.POLY7, F.POLY8, F.POWER, F.POWER_REGRESSION,
    F.EXPONENTIAL, F.EXP_REGRESSION, F.EXP_WITH_OFFSET, F.EXP_RECOVERY, F.EXP_RECOVERY_NOOFFSET, F.LOG, F.LOG2, F.GAUSSIAN,
    F.GAUSSIAN_NOOFFSET, F.ERF, F.RODBARD, F.RODBARD2, F.INV_RODBARD, F.GAMMA_VARIATE, F.CHAPMAN];
  // CurveFitter.java:70-79 (index = fit type)
  const FIT_LIST = ['Straight Line', '2nd Degree Polynomial', '3rd Degree Polynomial', '4th Degree Polynomial', 'Exponential', 'Power',
    'Log', 'Rodbard', 'Gamma Variate', 'y = a+b*ln(x-c)', 'Rodbard (NIH Image)', 'Exponential with Offset', 'Gaussian', 'Exponential Recovery',
    'Inverse Rodbard', 'Exponential (linear regression)', 'Power (linear regression)', '5th Degree Polynomial', '6th Degree Polynomial',
    '7th Degree Polynomial', '8th Degree Polynomial', 'Gaussian (no offset)', 'Exponential Recovery (no offset)', 'Chapman-Richards', 'Error Function'];
  // CurveFitter.java:82-102
  const F_LIST = ['y = a+bx', 'y = a+bx+cx^2', 'y = a+bx+cx^2+dx^3', 'y = a+bx+cx^2+dx^3+ex^4', 'y = a*exp(bx)', 'y = a*x^b', 'y = a*ln(bx)',
    'y = d+(a-d)/(1+(x/c)^b)', 'y = b*(x-a)^c*exp(-(x-a)/d)', 'y = a+b*ln(x-c)', 'x = d+(a-d)/(1+(y/c)^b) [y = c*((x-a)/(d-x))^(1/b)]',
    'y = a*exp(-bx) + c', 'y = a + (b-a)*exp(-(x-c)*(x-c)/(2*d*d))', 'y = a*(1-exp(-b*x)) + c', 'y = c*((x-a)/(d-x))^(1/b)',
    'y = a*exp(bx)', 'y = a*x^b', 'y = a+bx+cx^2+dx^3+ex^4+fx^5', 'y = a+bx+cx^2+dx^3+ex^4+fx^5+gx^6',
    'y = a+bx+cx^2+dx^3+ex^4+fx^5+gx^6+hx^7', 'y = a+bx+cx^2+dx^3+ex^4+fx^5+gx^6+hx^7+ix^8', 'y = a*exp(-(x-b)*(x-b)/(2*c*c))',
    'y = a*(1-exp(-b*x))', 'y = a*(1-exp(-b*x))^c', 'y = a+b*erf((x-c)/d)'];

  // CurveFitter.getNumParams(int) :260-286
  function numParamsOf(t) {
    switch (t) {
      case F.STRAIGHT_LINE: return 2;
      case F.POLY2: return 3; case F.POLY3: return 4; case F.POLY4: return 5; case F.POLY5: return 6; case F.POLY6: return 7;
      case F.POLY7: return 8; case F.POLY8: return 9;
      case F.EXPONENTIAL: case F.EXP_REGRESSION: return 2;
      case F.POWER: case F.POWER_REGRESSION: return 2;
      case F.EXP_RECOVERY_NOOFFSET: return 2;
      case F.LOG: return 2;
      case F.LOG2: return 3;
      case F.GAUSSIAN_NOOFFSET: return 3;
      case F.EXP_RECOVERY: return 3;
      case F.CHAPMAN: return 3;
      case F.EXP_WITH_OFFSET: return 3;
      case F.RODBARD: case F.RODBARD2: case F.INV_RODBARD: case RODBARD_INTERNAL: return 4;
      case F.GAMMA_VARIATE: return 4;
      case F.GAUSSIAN: case GAUSSIAN_INTERNAL: return 4;
      case F.ERF: return 4;
      default: return 0;
    }
  }

  // CurveFitter.f(int fitType, double[] p, double x) :435-519 — the horner forms keep Java's operation order
  function fValue(fitType, p, x) {
    switch (fitType) {
      case F.STRAIGHT_LINE: return p[0] + x * p[1];
      case F.POLY2: return p[0] + x * (p[1] + x * p[2]);
      case F.POLY3: return p[0] + x * (p[1] + x * (p[2] + x * p[3]));
      case F.POLY4: return p[0] + x * (p[1] + x * (p[2] + x * (p[3] + x * p[4])));
      case F.POLY5: return p[0] + x * (p[1] + x * (p[2] + x * (p[3] + x * (p[4] + x * p[5]))));
      case F.POLY6: return p[0] + x * (p[1] + x * (p[2] + x * (p[3] + x * (p[4] + x * (p[5] + x * p[6])))));
      case F.POLY7: return p[0] + x * (p[1] + x * (p[2] + x * (p[3] + x * (p[4] + x * (p[5] + x * (p[6] + x * p[7]))))));
      case F.POLY8: return p[0] + x * (p[1] + x * (p[2] + x * (p[3] + x * (p[4] + x * (p[5] + x * (p[6] + x * (p[7] + x * p[8])))))));
      case F.EXPONENTIAL: case F.EXP_REGRESSION: return p[0] * Math.exp(p[1] * x);
      case F.EXP_WITH_OFFSET: return p[0] * Math.exp(-p[1] * x) + p[2];
      case F.EXP_RECOVERY: return p[0] * (1 - Math.exp(-p[1] * x)) + p[2];
      case F.EXP_RECOVERY_NOOFFSET: return p[0] * (1 - Math.exp(-p[1] * x));
      case F.CHAPMAN: return p[0] * (Math.pow((1 - (Math.exp(-p[1] * x))), p[2]));   // a*(1-exp(-b*x))^c
      case F.GAUSSIAN: return p[0] + (p[1] - p[0]) * Math.exp(-(x - p[2]) * (x - p[2]) / (2.0 * p[3] * p[3]));
      case GAUSSIAN_INTERNAL: return p[0] + p[1] * Math.exp(-(x - p[2]) * (x - p[2]) / (2.0 * p[3] * p[3]));   // replaces GAUSSIAN for the fit
      case F.GAUSSIAN_NOOFFSET: return p[0] * Math.exp(-(x - p[1]) * (x - p[1]) / (2.0 * p[2] * p[2]));
      case F.POWER: case F.POWER_REGRESSION: return p[0] * Math.pow(x, p[1]);
      case F.LOG:
        if (x === 0.0) return -1000 * p[0];
        return p[0] * Math.log(p[1] * x);
      case F.RODBARD: { const ex = Math.pow(x / p[2], p[1]); return p[3] + (p[0] - p[3]) / (1.0 + ex); }   // d+(a-d)/(1+(x/c)^b)
      case RODBARD_INTERNAL: { const ex = Math.pow(x / p[2], p[1]); return p[3] + p[0] / (1.0 + ex); }   // d+a/(1+(x/c)^b)
      case F.GAMMA_VARIATE: {   // b*(x-a)^c*exp(-(x-a)/d)
        if (p[0] >= x) return 0.0;
        if (p[1] <= 0) return NaN;
        if (p[2] <= 0) return NaN;
        if (p[3] <= 0) return NaN;
        const pw = Math.pow((x - p[0]), p[2]);
        const e = Math.exp((-(x - p[0])) / p[3]);
        return p[1] * pw * e;
      }
      case F.LOG2: {
        const tmp = x - p[2];
        if (tmp <= 0) return NaN;
        return p[0] + p[1] * Math.log(tmp);
      }
      case F.INV_RODBARD: case F.RODBARD2: {   // c*((x-a)/(d-x))^(1/b); RODBARD2 is also used after the 'Rodbard NIH Image' fit
        let y;
        // "avoid x>=d (singularity) and x<a (negative exponent)"; Double.MIN_VALUE = 4.9e-324
        if (p[3] - x < 2 * Number.MIN_VALUE || x < p[0]) y = fitType === F.INV_RODBARD ? NaN : 0.0;
        else {
          y = (x - p[0]) / (p[3] - x);
          y = Math.pow(y, 1.0 / p[1]);
          y = y * p[2];
        }
        return y;
      }
      case F.ERF: return p[0] + p[1] * erf((x - p[2]) / p[3]);
      default: return 0.0;
    }
  }

  const sqr = (d) => d * d;
  const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : v);   // Math.signum (NaN and ±0 returned as they are)

  class CurveFitter {
    constructor(xData, yData, hooks) {
      // CurveFitter.java:150-168: pairs containing a NaN are removed
      let clean = 0;
      for (let j = 0; j < xData.length; j++) if (!Number.isNaN(xData[j] + yData[j])) clean++;
      if (clean === xData.length) { this.xData = Array.from(xData); this.yData = Array.from(yData); } else {
        this.xData = []; this.yData = [];
        for (let j = 0; j < xData.length; j++) if (!Number.isNaN(xData[j] + yData[j])) { this.xData.push(xData[j]); this.yData.push(yData[j]); }
      }
      this.numPoints = this.xData.length;
      this.fitType = -1;
      this.weights = null; this.xDataSave = null; this.yDataSave = null;
      this.ySign = 0; this.sumY = NaN; this.sumY2 = NaN; this.sumWeights = NaN;
      this.numParams = 0; this.initialParams = null; this.initialParamVariations = null;
      this.minimizerInitialParams = null; this.minimizerInitialParamVariations = null;
      this.maxRelError = 1e-10;
      this.numRegressionParams = 0; this.offsetParam = -1; this.factorParam = -1; this.hasSlopeParam = false;
      this.finalParams = null; this.linearRegressionUsed = false; this.restrictPower = false;
      this.minimizer = new Minimizer(hooks);
      this.minimizerStatus = M_INITIALIZATION_FAILURE;
      this.errorString = null;
    }

    getNumParams() { return numParamsOf(this.fitType); }

    // CurveFitter.doFit(int, boolean) :195-253 (no settings dialog)
    async doFit(fitType) {
      if (!(fitType >= F.STRAIGHT_LINE && fitType < FIT_LIST.length)) throw ijError('IJ_BAD_ARGS', 'Invalid fit type');
      this.fitType = fitType;
      if (this.isModifiedFitType(fitType)) if (!this.prepareModifiedFitType(fitType)) return;   // these fits don't use the original data
      this.numParams = this.getNumParams();
      this.getOffsetAndFactorParams();
      this.calculateSumYandY2();   // sumY, sumY2 needed for regression, abs Error; R, goodness of modified fit functions
      if (this.fitType === F.STRAIGHT_LINE) {   // no minimizer needed
        this.finalParams = [0, 0, 0];   // (does not work with 0 initial slope)
        this.doRegression(this.finalParams);   // fit by regression; save sum(Residuals^2) as last array element
        this.linearRegressionUsed = true;
      } else {   // use simplex minimizer
        this.minimizer.setFunction(this, this.numParams - this.numRegressionParams);
        this.minimizer.setExtraArrayElements(this.numRegressionParams);
        if (!this.makeInitialParamsAndVariations(fitType)) return;   // initialization failure (also includes some data checking)
        if (this.numRegressionParams > 0) this.modifyInitialParamsAndVariations();
        else { this.minimizerInitialParams = this.initialParams; this.minimizerInitialParamVariations = this.initialParamVariations; }
        // "The maximum absolute error of the fit must be specified in case the fit function fits perfectly"
        const maxAbsError = Math.min(1e-6, this.maxRelError) * Math.sqrt(this.sumY2);
        this.minimizer.setMaxError(this.maxRelError, maxAbsError);
        this.minimizerStatus = await this.minimizer.minimize(this.minimizerInitialParams, this.minimizerInitialParamVariations);
        this.finalParams = this.minimizer.getParams();
        if (this.numRegressionParams > 0) this.minimizerParamsToFullParams(this.finalParams, false);
      }
      if (this.isModifiedFitType(fitType)) this.postProcessModifiedFitType(fitType);   // params of actual fit to user params
      if (fitType === F.ERF) {   // "make it nicer": negative d inverted into b
        if (this.finalParams[3] < 0) { this.finalParams[1] = -this.finalParams[1]; this.finalParams[3] = -this.finalParams[3]; }
      }
      switch (fitType) {   // postprocessing for nicer output: Gaussian widths (std deviation) should be > 0
        case F.GAUSSIAN: this.finalParams[3] = Math.abs(this.finalParams[3]); break;
        case F.GAUSSIAN_NOOFFSET: this.finalParams[2] = Math.abs(this.finalParams[2]); break;
        default: break;
      }
    }

    f(p, x) { return fValue(this.fitType, p, x); }

    getParams() { return this.finalParams === null ? this.minimizer.getParams() : this.finalParams; }

    getResiduals() {
      const params = this.getParams(), res = new Array(this.xData.length);
      for (let i = 0; i < this.xData.length; i++) res[i] = this.yData[i] - this.f(params, this.xData[i]);
      return res;
    }
    getSumResidualsSqr() { return this.getParams()[this.numParams]; }   // stored as last element by the minimizer

    getSD() {   // CurveFitter.java:553-564
      const residuals = this.getResiduals(), n = residuals.length;
      let sum = 0.0, sum2 = 0.0;
      for (let i = 0; i < n; i++) { sum += residuals[i]; sum2 += residuals[i] * residuals[i]; }
      const stdDev = (sum2 - sum * sum / n);
      return Math.sqrt(stdDev / (n - 1.0));
    }
    getRSquared() {
      if (Number.isNaN(this.sumY)) this.calculateSumYandY2();
      const sumMeanDiffSqr = this.sumY2 - this.sumY * this.sumY / this.sumWeights;
      let rSquared = 0.0;
      if (sumMeanDiffSqr > 0.0) rSquared = 1.0 - this.getSumResidualsSqr() / sumMeanDiffSqr;
      return rSquared;
    }
    getFitGoodness() {
      if (Number.isNaN(this.sumY)) this.calculateSumYandY2();
      const sumMeanDiffSqr = this.sumY2 - this.sumY * this.sumY / this.sumWeights;
      let fitGoodness = 0.0;
      const degreesOfFreedom = this.numPoints - this.getNumParams();
      if (sumMeanDiffSqr > 0.0 && degreesOfFreedom > 0) fitGoodness = 1.0 - (this.getSumResidualsSqr() / sumMeanDiffSqr) * this.numPoints / degreesOfFreedom;
      return fitGoodness;
    }
    getStatus() { return this.linearRegressionUsed ? M_SUCCESS : this.minimizerStatus; }
    getStatusString() { return this.errorString !== null ? this.errorString : STATUS_STRING[this.getStatus()]; }
    getIterations() { return this.linearRegressionUsed ? 1 : this.minimizer.getIterations(); }

    // CurveFitter.userFunction :603-625 — called by the Minimizer
    userFunction(params) {
      let sumResidualsSqr = 0.0;
      if (this.numRegressionParams === 0) {   // simply calculate sum of residuals
        for (let i = 0; i < this.numPoints; i++) {
          const fv = this.f(params, this.xData[i]);
          let resSqr = sqr(fv - this.yData[i]);
          if (this.weights !== null) resSqr *= this.weights[i];
          sumResidualsSqr += resSqr;
        }
      } else {   // handle simple linear dependencies by linear regression
        this.minimizerParamsToFullParams(params, true);
        this.doRegression(params);
        sumResidualsSqr = this.fullParamsToMinimizerParams(params);
      }
      return sumResidualsSqr;
    }

    // CurveFitter.java:636-662
    minimizerParamsToFullParams(params, forRegression) {
      let offset = 0;
      let factor = this.hasSlopeParam ? 0 : 1;   // for regression, calculate function value without x*slope, but multiplied with 1
      let sumResidualsSqr = 0;
      if (!forRegression) {   // recover regression-calculated parameters from extra array elements
        let i = params.length - 1;
        if (this.factorParam >= 0) factor = params[i--];
        if (this.offsetParam >= 0) offset = params[i];
        sumResidualsSqr = params[this.numParams - this.numRegressionParams];
        params[this.numParams] = sumResidualsSqr;
      }
      for (let i = this.numParams - 1, iM = this.numParams - this.numRegressionParams - 1; i >= 0; i--) {
        if (i === this.offsetParam) params[i] = offset;
        else if (i === this.factorParam) params[i] = factor;
        else if (iM >= 0) params[i] = params[iM--];
        else params[i] = NaN;
      }
      params[this.numParams] = sumResidualsSqr;
    }

    // CurveFitter.java:668-737
    doRegression(params) {
      let sumX = 0, sumX2 = 0, sumXY = 0, sumY = 0, sumY2 = 0, sumWeights = 0;
      for (let i = 0; i < this.numPoints; i++) {
        const fv = this.fitType === F.STRAIGHT_LINE ? 0 : this.f(params, this.xData[i]);
        if (Number.isNaN(fv)) { params[this.numParams] = NaN; return; }   // sum of squared residuals is NaN if any value is NaN
        const w = this.weights === null ? 1 : this.weights[i];
        sumWeights += w;
        if (this.hasSlopeParam) {   // fit y = offset + slope*x + function(of other params)
          const x = this.xData[i], y = this.yData[i] - fv;
          sumX += x * w; sumX2 += x * x * w; sumXY += x * y * w; sumY2 += y * y * w; sumY += y * w;
        } else {   // fit y = offset + factor * function(of other params)
          sumX += fv * w; sumX2 += fv * fv * w; sumXY += fv * this.yData[i] * w;
        }
      }
      if (!this.hasSlopeParam) { sumY = this.sumY; sumY2 = this.sumY2; }
      let factor = 0, sumResidualsSqr = 0;
      if (this.offsetParam < 0) {   // only 'factor' parameter, no offset
        factor = sumXY / sumX2;
        if (Number.isNaN(factor) || !Number.isFinite(factor)) factor = 0;   // all 'x' values are 0, any factor (slope) will fit
        sumResidualsSqr = sumY2 + factor * (factor * sumX2 - 2 * sumXY);
        if (sumResidualsSqr < 2e-15 * sumY2) sumResidualsSqr = 2e-15 * sumY2;
      } else {   // full linear regression or offset only. Slope is named 'factor' here
        if (this.factorParam >= 0) {
          factor = (sumXY - sumX * sumY / sumWeights) / (sumX2 - sumX * sumX / sumWeights);
          if (this.restrictPower && factor <= 0) factor = 1e-100;   // power-law fit with (0,0) point: power must be >0
          else if (Number.isNaN(factor) || !Number.isFinite(factor)) factor = 0;   // all 'x' values are equal, any factor (slope) will fit
        }
        const offset = (sumY - factor * sumX) / sumWeights;
        params[this.offsetParam] = offset;
        sumResidualsSqr = sqr(factor) * sumX2 + sumWeights * sqr(offset) + sumY2 + 2 * factor * offset * sumX - 2 * factor * sumXY - 2 * offset * sumY;
        // "Don't report unrealistic or even negative values"
        if (sumResidualsSqr < 2e-15 * (sqr(factor) * sumX2 + sumWeights * sqr(offset) + sumY2)) {
          sumResidualsSqr = 2e-15 * (sqr(factor) * sumX2 + sumWeights * sqr(offset) + sumY2);
        }
      }
      params[this.numParams] = sumResidualsSqr;
      if (this.factorParam >= 0) params[this.factorParam] = factor;
    }

    // CurveFitter.java:743-758
    fullParamsToMinimizerParams(params) {
      const offset = this.offsetParam >= 0 ? params[this.offsetParam] : 0;
      const factor = this.factorParam >= 0 ? params[this.factorParam] : 0;
      const sumResidualsSqr = params[this.numParams];
      for (let i = 0, iNew = 0; i < this.numParams; i++) if (i !== this.factorParam && i !== this.offsetParam) params[iNew++] = params[i];
      let i = params.length - 1;
      if (this.factorParam >= 0) params[i--] = factor;
      if (this.offsetParam >= 0) params[i--] = offset;
      params[i--] = sumResidualsSqr;
      return sumResidualsSqr;
    }

    modifyInitialParamsAndVariations() {
      this.minimizerInitialParams = this.initialParams.slice();
      this.minimizerInitialParamVariations = this.initialParamVariations.slice();
      if (this.numRegressionParams > 0) {
        for (let i = 0, iNew = 0; i < this.numParams; i++) {
          if (i !== this.factorParam && i !== this.offsetParam) {
            this.minimizerInitialParams[iNew] = this.minimizerInitialParams[i];
            this.minimizerInitialParamVariations[iNew] = this.minimizerInitialParamVariations[i];
            iNew++;
          }
        }
      }
    }

    // CurveFitter.java:782-1015: initial parameters and their typical range
    makeInitialParamsAndVariations(fitType) {
      const n = this.numPoints, nP = this.numParams;
      if (n === 0) { this.errorString = 'No data to fit'; return false; }
      const hasInitialParams = this.initialParams !== null, hasInitialParamVariations = this.initialParamVariations !== null;
      if (!hasInitialParams) this.initialParams = new Array(nP).fill(0);
      if (!hasInitialParamVariations) this.initialParamVariations = new Array(nP).fill(0);
      const xData = this.xData, yData = this.yData;
      const firstx = xData[0], firsty = yData[0], lastx = xData[n - 1], lasty = yData[n - 1];
      let xMin = firstx, xMax = firstx, yMin = firsty, yMax = firsty, xMean = firstx, yMean = firsty, xOfMax = firstx;
      for (let i = 1; i < n; i++) {
        xMean += xData[i]; yMean += yData[i];
        if (xData[i] > xMax) xMax = xData[i];
        if (xData[i] < xMin) xMin = xData[i];
        if (yData[i] > yMax) { yMax = yData[i]; xOfMax = xData[i]; }
        if (yData[i] < yMin) yMin = yData[i];
      }
      xMean /= n; yMean /= n;
      let slope = (lasty - firsty) / (lastx - firstx);
      if (Number.isNaN(slope) || !Number.isFinite(slope)) slope = 0;
      // "We cannot fit the following cases because we would always get NaN function values"
      if (xMin < 0 && (fitType === F.POWER || fitType === F.CHAPMAN)) { this.errorString = 'Cannot fit ' + FIT_LIST[fitType] + ' when x<0'; return false; }
      if (xMin < 0 && xMax > 0 && fitType === F.RODBARD) { this.errorString = 'Cannot fit ' + FIT_LIST[fitType] + ' to mixture of x<0 and x>0'; return false; }
      if (xMin <= 0 && fitType === F.LOG) { this.errorString = 'Cannot fit ' + FIT_LIST[fitType] + ' when x<=0'; return false; }
      const ip = this.initialParams, iv = this.initialParamVariations;
      if (!hasInitialParams) {
        switch (fitType) {
          case F.EXPONENTIAL:   // a*exp(bx) assuming change by factor of e between xMin & xMax
            ip[1] = 1.0 / (xMax - xMin + 1e-100) * sign(yMean) * sign(slope);
            ip[0] = yMean / Math.exp(ip[1] * xMean);
            break;
          case F.EXP_WITH_OFFSET: case F.EXP_RECOVERY:
            ip[1] = 1 / (xMax - xMin + 1e-100);
            // ImageJ's source line is `(yMax-yMin+1e-100)/Math.exp(..) * Math.signum(slope) * fitType==EXP_RECOVERY ? 1 : -1;`
            // — Java's precedence makes it `((a*b*fitType) == EXP_RECOVERY) ? 1 : -1`: a double compared to 13. Kept as is
            // (the value is "don't care": parameter 0 is the factor parameter, done by regression).
            ip[0] = ((yMax - yMin + 1e-100) / Math.exp(ip[1] * xMean) * sign(slope) * fitType === F.EXP_RECOVERY) ? 1 : -1;
            ip[2] = 0.5 * yMean;
            break;
          case F.EXP_RECOVERY_NOOFFSET:
            ip[1] = 1.0 / (xMax - xMin + 1e-100) * sign(yMean) * sign(slope);
            ip[0] = yMean / Math.exp(ip[1] * xMean);
            break;
          case F.POWER:   // ax^b, assume linear for the beginning
            ip[0] = yMean / (Math.abs(xMean + 1e-100));
            ip[1] = 1.0;
            break;
          case F.LOG:   // a*ln(bx), assume b=e/xMax
            ip[0] = yMean;
            ip[1] = Math.E / (xMax + 1e-100);
            break;
          case F.LOG2:   // y = a+b*ln(x-c)
            ip[0] = yMean;
            ip[1] = (yMax - yMin + 1e-100) / (xMax - xMin + 1e-100);
            ip[2] = Math.min(0, -xMin - 0.1 * (xMax - xMin) - 1e-100);
            break;
          case F.RODBARD:   // d+(a-d)/(1+(x/c)^b)
            ip[0] = firsty; ip[1] = 1.0; ip[2] = xMin < 0 ? xMin : xMax; ip[3] = lasty;
            break;
          case F.INV_RODBARD: case F.RODBARD2:   // c*((x-a)/(d-x))^(1/b)
            ip[0] = xMin - 0.1 * (xMax - xMin);
            ip[1] = slope >= 0 ? 1.0 : -1.0;
            ip[2] = yMax;
            ip[3] = xMax + (xMax - xMin);
            break;
          case F.GAMMA_VARIATE: {   // b*(x-a)^c*exp(-(x-a)/d)
            ip[0] = xMin;
            let cd = xOfMax - xMin;
            if (cd < 0.1 * (xMax - xMin)) cd = 0.1 * (xMax - xMin);
            ip[2] = Math.sqrt(cd);
            ip[3] = Math.sqrt(cd);
            ip[1] = yMax / (Math.pow(cd, ip[2]) * Math.exp(-cd / ip[3]));
            break;
          }
          case F.GAUSSIAN:   // a + (b-a)*exp(-(x-c)^2/(2d^2))
            ip[0] = yMin; ip[1] = yMax; ip[2] = xOfMax;
            ip[3] = 0.39894 * (xMax - xMin) * (yMean - yMin) / (yMax - yMin + 1e-100);
            break;
          case F.GAUSSIAN_NOOFFSET:   // a*exp(-(x-b)^2/(2c^2))
            ip[0] = yMax; ip[1] = xOfMax;
            ip[2] = 0.39894 * (xMax - xMin) * yMean / (yMax + 1e-100);
            break;
          case F.CHAPMAN:   // a*(1-exp(-b*x))^c
            ip[0] = yMax;
            ip[2] = 1.5;
            for (let i = 1; i < n; i++) {   // find when we reach 50% of maximum
              if (yData[i] > 0.5 * yMax) { ip[1] = 1 / xData[i]; break; }
            }
            if (Number.isNaN(ip[1]) || ip[1] > 1000 / xMax) ip[1] = 10 / xMax;   // in case an outlier at the beginning has fooled us
            break;
          case F.ERF:   // a+b*erf((x-c)/d)
            ip[0] = 0.5 * (yMax + yMin);
            ip[1] = 0.5 * (yMax - yMin + 1e-100) * (lasty > firsty ? 1 : -1);
            ip[2] = xMin + (xMax - xMin) * (lasty > firsty ? yMax - yMean : yMean - yMin) / (yMax - yMin + 1e-100);
            ip[3] = 0.1 * (xMax - xMin + 1e-100);
            break;
          default: break;   // polynomials: offset & slope by regression, the others stay 0
        }
      }
      if (!hasInitialParamVariations) {   // estimate initial range for parameters
        for (let i = 0; i < nP; i++) iv[i] = 0.1 * ip[i];
        switch (fitType) {
          case F.POLY2: case F.POLY3: case F.POLY4: case F.POLY5: case F.POLY6: case F.POLY7: case F.POLY8: {
            const xFactor = 0.5 * Math.max(Math.abs(xMax + xMin), (xMax - xMin));
            iv[nP - 1] = (yMax - yMin) / (Math.pow(0.5 * (xMax - xMin), nP - 1) + 1e-100);
            for (let i = nP - 2; i >= 0; i--) iv[i] = iv[i + 1] * xFactor;
            break;
          }
          case F.EXPONENTIAL: case F.EXP_WITH_OFFSET: case F.EXP_RECOVERY:
            iv[1] = 0.1 / (xMax - xMin + 1e-100);
            break;
          case F.RODBARD:
            iv[2] = 0.5 * Math.max((xMax - xMin), Math.abs(xMean));
            iv[3] = 0.5 * Math.max(yMax - yMin, Math.abs(yMax));
            break;
          case F.INV_RODBARD:
            iv[0] = 0.01 * Math.max(xMax - xMin, Math.abs(xMax));
            iv[2] = 0.1 * Math.max(yMax - yMin, Math.abs(yMax));
            iv[3] = 0.1 * Math.max((xMax - xMin), Math.abs(xMean));
            break;
          case F.GAMMA_VARIATE: {
            iv[0] = 0.1 * Math.max(yMax - yMin, Math.abs(yMax));
            const ab = xOfMax - firstx + 0.1 * (xMax - xMin + 1e-100);
            iv[2] = 0.1 * Math.sqrt(ab);
            iv[3] = 0.1 * Math.sqrt(ab);
            break;
          }
          case F.GAUSSIAN: iv[2] = 0.2 * ip[3]; break;
          case F.GAUSSIAN_NOOFFSET: iv[1] = 0.2 * ip[2]; break;
          case F.ERF:
            iv[2] = 0.1 * (xMax - xMin + 1e-100);
            iv[3] = 0.5 * ip[3];
            break;
          default: break;
        }
      }
      return true;
    }

    // CurveFitter.java:1018-1081 "Set multiplyParams and offsetParam for built-in functions"
    getOffsetAndFactorParams() {
      this.offsetParam = -1; this.factorParam = -1; this.hasSlopeParam = false;
      switch (this.fitType) {
        case F.STRAIGHT_LINE: case F.POLY2: case F.POLY3: case F.POLY4: case F.POLY5: case F.POLY6: case F.POLY7: case F.POLY8:
          this.offsetParam = 0; this.factorParam = 1; this.hasSlopeParam = true; break;
        case F.EXPONENTIAL: this.factorParam = 0; break;
        case F.EXP_WITH_OFFSET: case F.EXP_RECOVERY: this.offsetParam = 2; this.factorParam = 0; break;
        case F.EXP_RECOVERY_NOOFFSET: this.factorParam = 0; break;
        case F.CHAPMAN: this.factorParam = 0; break;
        case F.POWER: this.factorParam = 0; break;
        case F.LOG: this.factorParam = 0; break;
        case F.LOG2: this.offsetParam = 0; this.factorParam = 1; break;
        case RODBARD_INTERNAL: this.offsetParam = 3; this.factorParam = 0; break;
        case F.INV_RODBARD: this.factorParam = 2; break;
        case F.GAMMA_VARIATE: this.factorParam = 1; break;
        case GAUSSIAN_INTERNAL: this.offsetParam = 0; this.factorParam = 1; break;
        case F.GAUSSIAN_NOOFFSET: this.factorParam = 0; break;
        case F.ERF: this.offsetParam = 0; this.factorParam = 1; break;
        default: break;
      }
      this.numRegressionParams = 0;
      if (this.offsetParam >= 0) this.numRegressionParams++;
      if (this.factorParam >= 0) this.numRegressionParams++;
    }

    calculateSumYandY2() {
      this.sumY = 0.0; this.sumY2 = 0.0; this.sumWeights = 0.0;
      let w = 1.0;
      for (let i = 0; i < this.numPoints; i++) {
        const y = this.yData[i];
        if (this.weights !== null) w = this.weights[i];
        this.sumY += y * w; this.sumY2 += y * y * w; this.sumWeights += w;
      }
    }

    isModifiedFitType(t) {
      return t === F.POWER_REGRESSION || t === F.EXP_REGRESSION || t === F.RODBARD || t === F.RODBARD2 || t === F.GAUSSIAN;
    }

    // CurveFitter.java:1099-1146
    prepareModifiedFitType(fitType) {
      if (fitType === F.GAUSSIAN) { this.fitType = GAUSSIAN_INTERNAL; return true; }   // different definition of parameters for using regression
      if (fitType === F.RODBARD) { this.fitType = RODBARD_INTERNAL; return true; }
      if (fitType === F.POWER_REGRESSION || fitType === F.EXP_REGRESSION) {
        if (fitType === F.POWER_REGRESSION) { this.xDataSave = this.xData; this.xData = new Array(this.numPoints).fill(0); }
        this.yDataSave = this.yData;
        this.yData = new Array(this.numPoints).fill(0);
        this.ySign = 0;
        this.numPoints = 0;   // we may have lower number of points if there is a (0,0) point that we ignore
        for (let i = 0; i < this.xData.length; i++) {
          const y = this.yDataSave[i];
          if (fitType === F.POWER_REGRESSION) {
            const x = this.xDataSave[i];
            if (x === 0 && y === 0) { this.restrictPower = true; continue; }   // ignore (0,0) point in power law
            if (x <= 0) { this.errorString = 'Cannot fit x<=0'; return false; }
            this.xData[this.numPoints] = Math.log(x);
          }
          if (this.ySign === 0) this.ySign = sign(y);   // if unknown, determine whether y data are positive or negative
          if (y * this.ySign <= 0) { this.errorString = 'Cannot fit y=0 or mixture of y>0, y<0'; return false; }
          this.yData[this.numPoints] = Math.log(y * this.ySign);
          this.numPoints++;
        }
        this.fitType = F.STRAIGHT_LINE;
      } else if (fitType === F.RODBARD2) {   // 'Rodbard (NIH Image)' fit is the inverse Rodbard function, by fitting x(y)
        this.xDataSave = this.xData; this.yDataSave = this.yData;
        this.xData = this.yDataSave; this.yData = this.xDataSave;   // swap
        this.fitType = RODBARD_INTERNAL;
      }
      return true;
    }

    postProcessModifiedFitType(fitType) {
      if (fitType === F.POWER_REGRESSION || fitType === F.EXP_REGRESSION) this.finalParams[0] = this.ySign * Math.exp(this.finalParams[0]);   // ln y = ln a + b ln x
      if (fitType === F.GAUSSIAN) this.finalParams[1] += this.finalParams[0];   // a + b exp(-...) to a + (b-a)*exp(-...)
      else if (fitType === F.RODBARD || fitType === F.RODBARD2) this.finalParams[0] += this.finalParams[3];   // d+a/(1+(x/c)^b) to d+(a-d)/(1+(x/c)^b)
      if (this.xDataSave !== null) { this.xData = this.xDataSave; this.numPoints = this.xData.length; }
      if (this.yDataSave !== null) this.yData = this.yDataSave;
      this.fitType = fitType;
    }
  }

  /* The curve of CurveFitter.getPlot(points) (:1294-1330): npoints = max(points, data length) up to 1000, `float` abscissae and ordinates. */
  function plotCurve(cf, points) {
    const x = cf.xData, y = cf.yData;
    let npoints = points;
    if (npoints < x.length) npoints = x.length;
    if (npoints > 1000) npoints = 1000;
    let xmin = Infinity, xmax = -Infinity;
    for (const v of x) { if (v < xmin) xmin = v; if (v > xmax) xmax = v; }
    const inc = (xmax - xmin) / (npoints - 1);
    let tmp = xmin;
    const px = new Array(npoints), py = new Array(npoints), params = cf.getParams();
    for (let i = 0; i < npoints; i++) { px[i] = Math.fround(tmp); tmp += inc; }
    for (let i = 0; i < npoints; i++) py[i] = Math.fround(cf.f(params, px[i]));
    return { x: px, y: py };
  }

  function checkCurveParams(p) {
    if (!p || typeof p !== 'object') throw ijError('IJ_BAD_ARGS', 'params');
    if (!Number.isInteger(p.fitType) || p.fitType < 0 || p.fitType >= FIT_LIST.length) throw ijError('IJ_BAD_ARGS', 'fitType');
    if (!Array.isArray(p.x) || !Array.isArray(p.y) || p.x.length !== p.y.length || p.x.length < 2) throw ijError('IJ_BAD_ARGS', 'data');
    if (p.x.length > 100000) throw ijError('IJ_TOO_LARGE', 'too many points');
    for (let i = 0; i < p.x.length; i++) if (typeof p.x[i] !== 'number' || typeof p.y[i] !== 'number') throw ijError('IJ_BAD_ARGS', 'data');
    if (p.randomSeed !== undefined && !Number.isInteger(p.randomSeed)) throw ijError('IJ_BAD_ARGS', 'randomSeed');
    if (p.maxRestarts !== undefined && !(Number.isInteger(p.maxRestarts) && p.maxRestarts >= 0 && p.maxRestarts <= 20)) throw ijError('IJ_BAD_ARGS', 'maxRestarts');
  }

  /* fitCurve({ fitType, x, y, randomSeed?, maxRestarts? }, hooks?) → Promise<result>. `status` is Minimizer's status code; a fit that
   * could not start (INITIALIZATION_FAILURE) answers `ok:false` with `statusString` (CurveFitter.getStatusString: the reason). */
  async function fitCurve(p, hooks) {
    checkCurveParams(p);
    const cf = new CurveFitter(p.x, p.y, hooks);
    cf.minimizer.setRandomSeed(p.randomSeed === undefined ? 0 : p.randomSeed);
    if (p.maxRestarts !== undefined) cf.minimizer.setMaxRestarts(p.maxRestarts);
    await cf.doFit(p.fitType);
    const status = cf.getStatus();
    const sse = cf.getSumResidualsSqr();
    const out = {
      fitType: p.fitType, name: FIT_LIST[p.fitType], formula: F_LIST[p.fitType], numParams: numParamsOf(p.fitType),
      status, statusString: cf.getStatusString(), ok: status !== M_INITIALIZATION_FAILURE && !Number.isNaN(sse),
      iterations: cf.getIterations(), restarts: cf.minimizer.maxRestarts, maxIterations: cf.minimizer.maxIter,
      completedMinimizations: cf.linearRegressionUsed ? 0 : cf.minimizer.numCompletedMinimizations, linearRegressionUsed: !!cf.linearRegressionUsed, points: cf.numPoints
    };
    if (status === M_INITIALIZATION_FAILURE) return out;
    const nP = numParamsOf(p.fitType);
    out.params = cf.getParams().slice(0, nP);
    out.sumResidualsSqr = sse;
    out.rSquared = cf.getRSquared();
    out.sd = cf.getSD();
    out.fitGoodness = cf.getFitGoodness();
    out.residuals = cf.getResiduals();
    out.curve = plotCurve(cf, 100);
    return out;
  }

  const IJCurveFit = { fitCurve, CurveFitter, Minimizer, erf, fValue, FIT_LIST, F_LIST, SORTED_TYPES, STATUS_STRING, TYPES: F };
  root.IJCurveFit = IJCurveFit;

  if (R && S) {
    R.define('curveFit', {
      kind: 'compute', version: 1, bitDepths: [8, 16, 32], channels: 'one', roi: 'ignore', preview: false,
      validate(p) { checkCurveParams(p); },
      scratchBytes(info, p) { return 1048576 + 8 * 40 * ((p && p.x ? p.x.length : 0) + 1000); },
      async run(view, p, roi, io) {
        io.tick(0, 'op.curveFit');
        return fitCurve(p, { check: () => io.check(), tick: (f) => io.tick(f, 'op.curveFit') });
      }
    });
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // 2. Fractal Box Count — ij.plugin.filter.FractalBoxCounter (ImageJ 1.54p, public domain)
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  // FractalBoxCounter.s2ints: "StringTokenizer(s, ", \t")"; a token that is not an int makes the whole string invalid (null).
  function parseBoxSizes(s) {
    const toks = String(s).split(/[, \t]+/).filter((t) => t.length > 0);
    const out = [];
    for (const t of toks) {
      if (!/^[+-]?\d+$/.test(t)) return null;   // Integer.parseInt: NumberFormatException
      const v = Number(t);
      if (!(v >= -2147483648 && v <= 2147483647)) return null;
      out.push(v);
    }
    return out;
  }

  function checkBoxParams(p) {
    if (!p || typeof p !== 'object') throw ijError('IJ_BAD_ARGS', 'params');
    if (!Array.isArray(p.boxSizes) || p.boxSizes.length < 1 || p.boxSizes.length > 64) throw ijError('IJ_BAD_ARGS', 'boxSizes');
    // a size of 0 would never advance FractalBoxCounter.count's loop (x += size): refused, as are sizes no image can hold
    for (const s of p.boxSizes) if (!Number.isInteger(s) || s < 1 || s > 65536) throw ijError('IJ_BAD_ARGS', 'box size');
    if (p.foreground !== 0 && p.foreground !== 255) throw ijError('IJ_BAD_ARGS', 'foreground');
  }

  /* FractalBoxCounter.doBoxCounts / FindMargins / count on an 8-bit binary image. `foreground` = the value counted as the object:
   * "if (blackBackground) foreground = 255; else foreground = 0; if (ip.isInvertedLut()) foreground = 255 - foreground;" — resolved
   * by the command and journaled here. ip.getHistogram() of each box is replaced by a scan that stops at the first foreground
   * pixel (counts[histogram[foreground]]++ then sums counts[i>=1]: only "box holds at least one object pixel" matters). The box walk
   * is the source's own (:131-155), including its odd `w = size` reset: ip.setRoi clips every box to the image. */
  async function boxCount(data, w, h, boxSizes, foreground, hooks) {
    // FindMargins (:93-129): the bounding box of the object pixels
    let left = w, right = -1, top = h, bottom = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (data[row + x] === foreground) {
          if (x < left) left = x;
          if (x > right) right = x;
          if (y < top) top = y;
          bottom = y;
        }
      }
      if ((y & 63) === 63) { hooks.check(); await hooks.tick(0.2 * y / h); }
    }
    if (right < 0) throw ijError('IJ_FIJI_NO_FOREGROUND', 'No non-backround pixels found.');   // "IJ.error("No non-backround pixels found.")"
    const roi = { x: left, y: top, width: right + 1 - left, height: bottom + 1 - top };
    const anyIn = (x0, y0, bw, bh) => {   // ip.setRoi(x, y, w, h) clips the rectangle to the image
      const xa = Math.max(0, x0), ya = Math.max(0, y0), xb = Math.min(w, x0 + bw), yb = Math.min(h, y0 + bh);
      for (let y = ya; y < yb; y++) {
        const row = y * w;
        for (let x = xa; x < xb; x++) if (data[row + x] === foreground) return true;
      }
      return false;
    };
    const counts = [];
    for (let i = 0; i < boxSizes.length; i++) {
      const size = boxSizes[i];
      let x = roi.x, y = roi.y;
      let bw = size <= roi.width ? size : roi.width, bh = size <= roi.height ? size : roi.height;
      const rightEdge = roi.x + roi.width, bottomEdge = roi.y + roi.height;
      let sum = 0, done = false, steps = 0;
      do {
        if (anyIn(x, y, bw, bh)) sum++;
        x += size;
        if (x + size >= rightEdge) {
          bw = rightEdge - x;
          if (x >= rightEdge) {
            bw = size;
            x = roi.x;
            y += size;
            if (y + size >= bottomEdge) bh = bottomEdge - y;
            done = y >= bottomEdge;
          }
        }
        if ((++steps & 1023) === 0) { hooks.check(); await hooks.tick(0.2 + 0.8 * (i + (y - roi.y) / Math.max(1, roi.height)) / boxSizes.length); }
      } while (!done);
      counts.push(sum);
    }
    return { roi, counts };
  }

  async function fractalBoxCount(data, w, h, p, hooks) {
    checkBoxParams(p);
    for (let i = 0; i < data.length; i++) if (data[i] !== 0 && data[i] !== 255) throw ijError('IJ_FIJI_NOT_BINARY', '8-bit binary image (0 and 255) required.');
    const bc = await boxCount(data, w, h, p.boxSizes, p.foreground, hooks);
    // plot(): float[] sizes = ln(boxSize), float[] boxCountSums = ln(boxSum) — fitted with the straight-line CurveFitter, D = -slope
    const n = p.boxSizes.length, lx = new Array(n), ly = new Array(n);
    for (let i = 0; i < n; i++) { lx[i] = Math.fround(Math.log(p.boxSizes[i])); ly[i] = Math.fround(Math.log(bc.counts[i])); }
    const cf = new CurveFitter(lx, ly);
    await cf.doFit(F.STRAIGHT_LINE);
    const pr = cf.getParams();
    const D = -pr[1];
    // the plot: 100 points between the extreme sizes ("float[] px = new float[100]", step (xmax-xmin)/99.0)
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (let i = 0; i < n; i++) { xmin = Math.min(xmin, lx[i]); xmax = Math.max(xmax, lx[i]); ymin = Math.min(ymin, ly[i]); ymax = Math.max(ymax, ly[i]); }
    const inc = (xmax - xmin) / 99.0, line = { x: [], y: [] };
    let tmp = xmin;
    for (let i = 0; i < 100; i++) { const px = Math.fround(tmp); line.x.push(px); line.y.push(Math.fround(fValue(F.STRAIGHT_LINE, pr, px))); tmp += inc; }
    return { sizes: p.boxSizes.slice(), counts: bc.counts, D, logSizes: lx, logCounts: ly, line, bounds: bc.roi, slope: pr[1], intercept: pr[0] };
  }

  if (R && S) {
    R.define('fractalBoxCount', {
      kind: 'compute', version: 1, bitDepths: [8], channels: 'one', roi: 'ignore', preview: false,
      validate(p) { checkBoxParams(p); },
      scratchBytes() { return 1048576; },
      async run(view, p, roi, io) {
        const c = io.channel !== null && io.channel !== undefined ? io.channel : view.active;
        const ch = view.channels[c] || view.channels[0];
        io.tick(0, 'op.fractalBoxCount');
        return fractalBoxCount(ch.data, view.width, view.height, p, { check: () => io.check(), tick: (f) => io.tick(f, 'op.fractalBoxCount') });
      }
    });
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // 3. Local Thickness — Hildebrand & Rüegsegger 1997, J. Microsc. 185:67-75
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  /* The local thickness of a point p of the object is the diameter of the LARGEST sphere that contains p and fits entirely inside the
   * object: LT(p) = 2 · max{ r(q) : |p − q| ≤ r(q) }, r(q) the distance from q to the nearest background pixel (the distance map).
   * Everything is done on SQUARED INTEGER distances: a pixel is inside the disc of q when dx² + dy² ≤ r²(q) exactly (a float sqrt then
   * squared again loses that equality on the circle). Only "distance ridge" centres need painting (the others' discs are contained in a
   * neighbour's); they are painted from the largest radius down, so a pixel keeps the first value it receives, and each row of a disc
   * jumps over the already painted pixels (one union-find per row): the cost is the number of pixels plus the number of disc rows.
   * The map includes the background pixels the discs reach (a disc of the inside-most pixel of a 3-px strip covers the pixels one step
   * beyond it), which is how the thickness image of Fiji is supported too. No pixel outside every disc is ever written (0).
   * Image borders are not background (a particle cut by the border keeps its distance to the real background only).
   * Pixel units; a pixel's radius is the exact Euclidean value, the output is float32. */
  async function edtSquared(fg, w, h, hooks) {
    // two-pass exact squared EDT (Felzenszwalb & Huttenlocher 2012: columns, then lower envelope of parabolas per row)
    const n = w * h, INF = 1e15;
    const out = new Int32Array(n);
    const f = new Float64Array(Math.max(w, h) + 1), d = new Float64Array(Math.max(w, h) + 1), z = new Float64Array(Math.max(w, h) + 2), v = new Int32Array(Math.max(w, h) + 1);
    const BIG = 2147483647;
    function line(len) {   // d[q] = min_p ((q - p)^2 + f[p]): lower envelope of the parabolas rooted at (p, f[p])
      let k = 0;
      v[0] = 0; z[0] = -INF; z[1] = INF;
      for (let q = 1; q < len; q++) {
        let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
        k++; v[k] = q; z[k] = s; z[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < len; q++) {
        while (z[k + 1] < q) k++;
        const dq = q - v[k];
        d[q] = dq * dq + f[v[k]];
      }
    }
    // pass 1: columns
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = fg[y * w + x] ? INF : 0;
      line(h);
      for (let y = 0; y < h; y++) out[y * w + x] = d[y] >= BIG ? BIG : d[y];
      if ((x & 127) === 127) { hooks.check(); await hooks.tick(0.1 * x / w); }
    }
    // pass 2: rows
    let none = true;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) { const o = out[row + x]; f[x] = o >= BIG ? INF : o; }
      line(w);
      for (let x = 0; x < w; x++) {
        const dv = d[x];
        out[row + x] = dv >= BIG ? BIG : dv;
        if (dv < INF) none = false;
      }
      if ((y & 127) === 127) { hooks.check(); await hooks.tick(0.1 + 0.1 * y / h); }
    }
    return { edt2: out, hasBackground: !none };
  }

  /* Fiji's "Local Thickness (complete process)" ends with a clean-up of the map's surface. Reproduced from what the plugin DOES (GPL code was
   * never read): the 3465 pixels of the 16 fixtures (fiji/localthickness) that the raw map above gets wrong are ALL explained by one rule, and no other
   * pixel changes: a SURFACE pixel (non-zero, with an in-image 8-neighbour that is 0) takes the mean of those of its 8-neighbours that are non-zero and
   * not on the surface themselves; with none, it keeps its value. The mean is a float sum, as Fiji's. Only non-surface pixels are read and only
   * surface pixels written, so it is done in place. */
  async function cleanUpThickness(out, w, h, hooks) {
    const surf = (x, y) => {
      if (!(out[y * w + x] > 0)) return false;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx >= 0 && xx < w && !(out[yy * w + xx] > 0)) return true; }
      }
      return false;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!surf(x, y)) continue;
        let sum = 0, cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            if (out[yy * w + xx] > 0 && !surf(xx, yy)) { sum = Math.fround(sum + out[yy * w + xx]); cnt++; }
          }
        }
        if (cnt) out[y * w + x] = Math.fround(sum / cnt);
      }
      if ((y & 63) === 63) { hooks.check(); await hooks.tick(0.95 + 0.05 * y / h); }
    }
  }

  async function localThickness(fgMask, w, h, hooks, reserve, opts) {
    const n = w * h;
    let any = false;
    for (let i = 0; i < n; i++) if (fgMask[i]) { any = true; break; }
    if (!any) throw ijError('IJ_FIJI_EMPTY', 'no object pixel');
    let e = await edtSquared(fgMask, w, h, hooks);
    if (!e.hasBackground) throw ijError('IJ_FIJI_NO_BACKGROUND', 'no background pixel');
    const edt2 = e.edt2;
    // distance ridge: p is skipped when a neighbour q has r(q) >= r(p) + |p - q| (disc(p) ⊆ disc(q))
    let m = 0;
    const NB = [[-1, -1, 2], [0, -1, 1], [1, -1, 2], [-1, 0, 1], [1, 0, 1], [-1, 1, 2], [0, 1, 1], [1, 1, 2]];
    const isCentre = (x, y, r2) => {
      const rp = Math.sqrt(r2);
      for (let k = 0; k < 8; k++) {
        const nx = x + NB[k][0], ny = y + NB[k][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q2 = edt2[ny * w + nx];
        if (q2 > r2 && Math.sqrt(q2) >= rp + Math.sqrt(NB[k][2]) - 1e-9) return false;
      }
      return true;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) { const r2 = edt2[y * w + x]; if (fgMask[y * w + x] && r2 > 0 && isCentre(x, y, r2)) m++; }
      if ((y & 63) === 63) { hooks.check(); await hooks.tick(0.2 + 0.1 * y / h); }
    }
    reserve(m * 12);
    const cPix = new Int32Array(m), cR = new Int32Array(m);
    let j = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const r2 = edt2[y * w + x]; if (fgMask[y * w + x] && r2 > 0 && isCentre(x, y, r2)) { cPix[j] = y * w + x; cR[j] = r2; j++; } }
    const order = new Int32Array(m);
    for (let i = 0; i < m; i++) order[i] = i;
    // decreasing radius; equal radii in raster order (the value painted is the same whichever comes first)
    order.sort((a, b) => (cR[b] - cR[a]) || (cPix[a] - cPix[b]));
    e = null;
    const buf = new Int32Array(n), next = new Int32Array(n);
    for (let i = 0; i < n; i++) next[i] = i;
    const isqrt = (v) => { let s = Math.floor(Math.sqrt(v)); while (s * s > v) s--; while ((s + 1) * (s + 1) <= v) s++; return s; };
    for (let oi = 0; oi < m; oi++) {
      const c = order[oi], pix = cPix[c], R2 = cR[c];
      const cy = Math.floor(pix / w), cx = pix - cy * w, r = isqrt(R2);
      const y0 = Math.max(0, cy - r), y1 = Math.min(h - 1, cy + r);
      for (let y = y0; y <= y1; y++) {
        const dy = y - cy, half = isqrt(R2 - dy * dy);
        const xa = Math.max(0, cx - half), xb = Math.min(w - 1, cx + half);
        const rowEnd = (y + 1) * w, base = y * w;
        let p = base + xa;
        const last = base + xb;
        for (;;) {
          let q = p;
          while (q < rowEnd && next[q] !== q) q = next[q];
          // path compression
          let t = p;
          while (t < rowEnd && next[t] !== t) { const nt = next[t]; next[t] = q; t = nt; }
          if (q > last) break;
          buf[q] = R2; next[q] = q + 1;
          p = q + 1;
        }
      }
      if ((oi & 255) === 255) { hooks.check(); await hooks.tick(0.3 + 0.7 * oi / m); }
    }
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) { const r2 = buf[i]; if (r2 > 0) out[i] = 2 * Math.sqrt(r2); }
    if (!opts || opts.clean !== false) await cleanUpThickness(out, w, h, hooks);   // clean:false = the raw map of the definition (the tests' brute force)
    let max = 0;
    for (let i = 0; i < n; i++) if (out[i] > max) max = out[i];
    return { data: out, max };
  }

  function checkThicknessParams(p) {
    if (!p || typeof p !== 'object') throw ijError('IJ_BAD_ARGS', 'params');
    if (!Number.isInteger(p.threshold) || p.threshold < 1 || p.threshold > 255) throw ijError('IJ_BAD_ARGS', 'threshold');
    if (p.inverse !== undefined && typeof p.inverse !== 'boolean') throw ijError('IJ_BAD_ARGS', 'inverse');
  }

  if (R && S) {
    R.define('localThickness', {
      kind: 'newdoc', version: 1, bitDepths: [8], channels: 'one', roi: 'ignore', preview: false,
      validate(p) { checkThicknessParams(p); },
      // object mask (1 B) + squared distances (4 B) + painted radii (4 B) + row jump table (4 B) + the float output (4 B), + the centre lists
      scratchBytes(info) { return info.width * info.height * 17 + 4194304; },
      async run(view, p, roi, io) {
        checkThicknessParams(p);
        const c = io.channel !== null && io.channel !== undefined ? io.channel : view.active;
        const ch = view.channels[c] || view.channels[0];
        const w = view.width, h = view.height, n = w * h, data = ch.data;
        const fg = new Uint8Array(n);
        // "Threshold (1 to 255; value < thresh is background)" / "Inverse case (background when value >= thresh)"
        if (p.inverse) for (let i = 0; i < n; i++) fg[i] = data[i] < p.threshold ? 1 : 0;
        else for (let i = 0; i < n; i++) fg[i] = data[i] >= p.threshold ? 1 : 0;
        io.tick(0, 'op.localThickness');
        const res = await localThickness(fg, w, h, { check: () => io.check(), tick: (f) => io.tick(f, 'op.localThickness') }, (b) => io.reserve(b));
        const base = String(view.name || 'Untitled').replace(/\.(tiff?|png|jpe?g|bmp|gif)$/i, '');
        return [{
          name: base + '_LocThk', width: w, height: h, bitDepth: 32, calibration: view.calibration ? Object.assign({}, view.calibration) : view.calibration,
          channels: [{ data: res.data, name: 'Local thickness', color: '#ffffff', display: { min: 0, max: res.max > 0 ? res.max : 1, lut: 'Fire', invert: false } }]
        }];
      }
    });
  }

  const IJLocalThickness = { localThickness, edtSquared };
  root.IJLocalThickness = IJLocalThickness;
  root.IJFractal = { parseBoxSizes, boxCount, fractalBoxCount };

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // 4. Analyze Skeleton (2D) — Arganda-Carreras, Fernandez-Gonzalez, Munoz-Barrutia, Ortiz-De-Solorzano (2010),
  //    "3D reconstruction of histological sections: application to mammary gland tissue", Microsc. Res. Tech. 73:1019-1029
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  /* Definitions (paper). A skeleton voxel is classified by its 8-connected neighbours: end-point < 2, slab = 2, junction > 2.
   * Junction voxels that touch are ONE junction (vertex). A branch is a chain of slab voxels between two vertices (junctions or
   * end-points; both ends may be the same junction: a loop). A tree is a connected skeleton. Triple / quadruple points are the
   * junctions with exactly 3 / 4 branches (a loop counts twice at its junction).
   *
   * Conventions that are NOT in the paper and were measured on the numbers a real Fiji prints (tests/fixtures/ij-wave3/fiji/skeleton,
   * 4 graphs × 8 option sets, reproduced exactly by tests/js/test_ij_fiji_skeleton.mjs):
   *   - voxels, trees and junctions are visited column by column (x outer, y inner); trees are found from the end-points first.
   *   - a junction is located at its FIRST voxel in that order; a branch length is its voxel-to-voxel Euclidean path from the first
   *     voxel of one vertex to the first voxel of the other, so the way across a junction (entry voxel → first voxel) is included at each
   *     junction end; the closing step of a loop is not.
   *   - "Prune ends" removes every branch that has an end-point and a junction (one pass, end-point voxel and slabs, never the junction) and,
   *     of an isolated branch between two end-points, all but the last end-point. The table keeps the branch / junction counts and the
   *     lengths of the unpruned graph and reports the voxel counts and triple / quadruple points of what is left. The tagged image shows
   *     the skeleton before this step.
   *   - "Prune cycle method": the cycles are found one after the other by a depth-first search (vertices: junctions, then end-points, in scan
   *     order); in each cycle the branch with the fewest slab voxels (shortest branch) or the lowest intensity (a voxel / the mean of a
   *     branch) is cut by removing ONE slab voxel (the middle one of the branch, or the lowest voxel). When several cycles / branches are
   *     equal (same slab count, same intensity: always the case on a binary skeleton) which one is cut can differ from Fiji's order.
   *   - Longest shortest path: Dijkstra from every vertex over the graph in which a pair of vertices is joined by one branch (loops
   *     are ignored); the start reported (spx, spy) is the far vertex of the first longest path found, sources in scan order.
   *   Known difference: for a tree made of one end-point and a loop Fiji reports twice the length of the end branch; this port reports it once. */
  const SK_END = 30, SK_JUNCTION = 70, SK_SLAB = 127, SK_PATH = 96;
  const SK_N8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  const SK_PRUNE = ['none', 'shortest', 'lowestVoxel', 'lowestBranch'];

  function checkSkeletonParams(p) {
    if (!p || typeof p !== 'object') throw ijError('IJ_BAD_ARGS', 'params');
    if (SK_PRUNE.indexOf(p.prune) < 0) throw ijError('IJ_BAD_ARGS', 'prune');
    for (const k of ['pruneEnds', 'excludeRoi', 'shortestPath', 'detailed', 'labeled']) if (p[k] !== undefined && typeof p[k] !== 'boolean') throw ijError('IJ_BAD_ARGS', k);
    if (p.pixelWidth !== undefined && !(p.pixelWidth > 0 && isFinite(p.pixelWidth))) throw ijError('IJ_BAD_ARGS', 'pixelWidth');
    if (p.pixelHeight !== undefined && !(p.pixelHeight > 0 && isFinite(p.pixelHeight))) throw ijError('IJ_BAD_ARGS', 'pixelHeight');
    if (p.ch !== undefined && !(Number.isInteger(p.ch) && p.ch >= 0)) throw ijError('IJ_BAD_ARGS', 'ch');
  }

  /* The graph of a skeleton mask (Uint8Array, nonzero = skeleton). Everything is by voxel number k (0..N-1) in column-major order. */
  async function skeletonGraph(mask, w, h, pw, ph, hooks) {
    const n = w * h;
    let N = 0;
    for (let i = 0; i < n; i++) if (mask[i]) N++;
    const keys = new Int32Array(N);
    let j = 0;
    for (let y = 0; y < h; y++) { const row = y * w; for (let x = 0; x < w; x++) if (mask[row + x]) keys[j++] = x * h + y; }
    keys.sort();
    const pix = new Int32Array(N), vx = new Int32Array(N), vy = new Int32Array(N), idx = new Int32Array(n);
    for (let k = 0; k < N; k++) {
      const x = Math.floor(keys[k] / h), y = keys[k] - x * h;
      vx[k] = x; vy[k] = y; pix[k] = y * w + x; idx[pix[k]] = k + 1;
    }
    const tmp = new Int32Array(8);
    function nbr(k, buf) {   // neighbours of voxel k in the order SK_N8; returns the count
      const x = vx[k], y = vy[k];
      let c = 0;
      for (let d = 0; d < 8; d++) {
        const xx = x + SK_N8[d][0], yy = y + SK_N8[d][1];
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const t = idx[yy * w + xx];
        if (t) buf[c++] = t - 1;
      }
      return c;
    }
    const dist = (a, b) => Math.hypot((vx[a] - vx[b]) * pw, (vy[a] - vy[b]) * ph);
    const tag = new Uint8Array(N);
    for (let k = 0; k < N; k++) { const c = nbr(k, tmp); tag[k] = c < 2 ? SK_END : (c === 2 ? SK_SLAB : SK_JUNCTION); }
    // trees: found from the end-points (in order), then from whatever is left (closed loops)
    const tree = new Int32Array(N).fill(-1), stack = new Int32Array(N);
    let nTrees = 0;
    const flood = (s) => {
      let sp = 0;
      stack[sp++] = s; tree[s] = nTrees;
      while (sp) {
        const q = stack[--sp];
        const c = nbr(q, tmp);
        for (let i = 0; i < c; i++) { const r = tmp[i]; if (tree[r] < 0) { tree[r] = nTrees; stack[sp++] = r; } }
      }
      nTrees++;
    };
    for (let k = 0; k < N; k++) if (tag[k] === SK_END && tree[k] < 0) flood(k);
    for (let k = 0; k < N; k++) if (tree[k] < 0) flood(k);
    await hooks.tick(0.1);
    const byTree = [];
    for (let t = 0; t < nTrees; t++) byTree.push([]);
    for (let k = 0; k < N; k++) byTree[tree[k]].push(k);
    // junctions: touching junction voxels, numbered by their first voxel
    const grp = new Int32Array(N).fill(-1), gFirst = [], gTree = [];
    for (let k = 0; k < N; k++) {
      if (tag[k] !== SK_JUNCTION || grp[k] >= 0) continue;
      const g = gFirst.length;
      gFirst.push(k); gTree.push(tree[k]);
      let sp = 0;
      stack[sp++] = k; grp[k] = g;
      while (sp) {
        const q = stack[--sp];
        const c = nbr(q, tmp);
        for (let i = 0; i < c; i++) { const r = tmp[i]; if (tag[r] === SK_JUNCTION && grp[r] < 0) { grp[r] = g; stack[sp++] = r; } }
      }
    }
    // branches, tree after tree, from the vertex voxels in order
    const visited = new Uint8Array(N);
    const edges = [];
    const nb2 = new Int32Array(8), nb3 = new Int32Array(8);
    let vCount = 0, steps = 0;
    for (let t = 0; t < nTrees; t++) {
      const list = byTree[t];
      for (const v of list) {
        if (tag[v] === SK_SLAB) continue;
        if ((++vCount & 8191) === 0) { hooks.check(); await hooks.tick(0.1 + 0.2 * vCount / Math.max(1, N)); }
        const c = nbr(v, nb2);
        const around = Array.from(nb2.subarray(0, c));
        for (const nn of around) {
          if (tag[nn] === SK_SLAB) {
            if (visited[nn]) continue;
            const path = [v, nn];
            visited[nn] = 1;
            let prev = v, cur = nn;
            for (;;) {
              const cc = nbr(cur, nb3);
              let nx = -1, first = -1;
              for (let i = 0; i < cc; i++) {
                const r = nb3[i];
                if (r === prev) continue;
                if (tag[r] !== SK_SLAB) { nx = r; break; }
                if (first < 0 && !visited[r]) first = r;
              }
              if (nx < 0) nx = first;
              if (nx < 0) break;
              path.push(nx); prev = cur; cur = nx;
              if ((++steps & 16383) === 0) { hooks.check(); await hooks.tick(0.1 + 0.2 * steps / Math.max(1, N)); }
              if (tag[nx] !== SK_SLAB) break;
              visited[nx] = 1;
            }
            edges.push({ t, a: v, b: path[path.length - 1], tagB: tag[path[path.length - 1]], path: Int32Array.from(path), ring: false, len: 0 });
          } else if (v < nn && !(tag[v] === SK_JUNCTION && tag[nn] === SK_JUNCTION)) {
            edges.push({ t, a: v, b: nn, tagB: tag[nn], path: Int32Array.from([v, nn]), ring: false, len: 0 });
          }
        }
      }
      // a ring of slab voxels with no vertex at all: one branch
      for (const s of list) {
        if (tag[s] !== SK_SLAB || visited[s]) continue;
        const path = [s];
        visited[s] = 1;
        let cur = s;
        for (;;) {
          const cc = nbr(cur, nb3);
          let nx = -1;
          for (let i = 0; i < cc; i++) if (!visited[nb3[i]]) { nx = nb3[i]; break; }
          if (nx < 0) break;
          visited[nx] = 1; path.push(nx); cur = nx;
        }
        edges.push({ t, a: -1, b: -1, tagB: 0, path: Int32Array.from(path), ring: true, len: 0 });
      }
    }
    // lengths (see the header: junction first voxel at each junction end, no closing step of a loop)
    for (const e of edges) {
      const p = e.path;
      let L = 0;
      for (let i = 0; i + 1 < p.length; i++) L += dist(p[i], p[i + 1]);
      if (e.ring) { L += dist(p[p.length - 1], p[0]); e.len = L; continue; }
      const ta = tag[e.a], tb = e.tagB;
      if (ta === SK_JUNCTION) L += dist(e.a, gFirst[grp[e.a]]);
      if (tb === SK_JUNCTION) L += dist(e.b, gFirst[grp[e.b]]);
      if (ta === SK_JUNCTION && tb === SK_JUNCTION && grp[e.a] === grp[e.b]) L -= dist(p[p.length - 2], e.b);
      e.len = L;
    }
    return { w, h, pw, ph, N, vx, vy, pix, tag, tree, nTrees, byTree, grp, gFirst, gTree, edges, dist, nbr };
  }

  /* Cut the cycles of the graph (one voxel each). Returns the voxel numbers to remove. */
  async function skeletonCycleCuts(G, method, data, inRoi, hooks) {
    const nG = G.gFirst.length;
    const vid = (k) => (G.tag[k] === SK_JUNCTION ? G.grp[k] : nG + k);
    const alive = G.edges.map(() => true);
    const cuts = [];
    const intensity = (k) => data[G.pix[k]];
    // Measured on Fiji 2.x (46 of 46 cut voxels over 18 runs with non-tied intensities): the voxel a lowest-intensity method cuts is the minimum of the
    // MEAN OF THREE consecutive voxels of its branch, the voxel and its two neighbours along the path (the vertex voxel at an end counts as a neighbour;
    // a ring wraps), not of the voxel's own value. The branch itself is still chosen by the mean of its slab voxels.
    const smoothCache = new Map();
    const smoothed = (ei) => {
      let m = smoothCache.get(ei);
      if (m) return m;
      m = new Map();
      const e = G.edges[ei], P = e.path, n = P.length;
      const from = e.ring ? 0 : 1, to = e.ring ? n : n - 1;
      for (let i = from; i < to; i++) {
        const prev = e.ring ? P[(i - 1 + n) % n] : P[i - 1], next = e.ring ? P[(i + 1) % n] : P[i + 1];
        m.set(P[i], (intensity(prev) + intensity(P[i]) + intensity(next)) / 3);
      }
      smoothCache.set(ei, m);
      return m;
    };
    // vertex order: junctions (first voxel order), then end-points (scan order)
    const order = [];
    for (let g = 0; g < nG; g++) order.push(g);
    for (let k = 0; k < G.N; k++) if (G.tag[k] === SK_END) order.push(nG + k);
    // the slab voxels of a branch in the direction Fiji walks it: from the first traced vertex voxel; a loop (a branch from a junction to
    // itself, or a ring) is walked the other way round
    const listOf = (e) => {
      const s = [];
      if (e.ring) for (let i = 0; i < e.path.length; i++) s.push(e.path[i]);
      else for (let i = 1; i < e.path.length - 1; i++) s.push(e.path[i]);
      return e.ring || vid(e.a) === vid(e.b) ? s.reverse() : s;
    };
    const pick = (cyc) => {   // -> [voxel, edge] to cut, or null
      const lists = cyc.map((ei) => listOf(G.edges[ei]));
      if (method === 'shortest') {
        let best = -1, bestN = Infinity;
        lists.forEach((l, i) => { if (l.length >= 1 && l.length < bestN) { best = i; bestN = l.length; } });
        return best < 0 ? null : [lists[best][Math.floor(bestN / 2)], cyc[best]];
      }
      if (method === 'lowestVoxel') {
        let bestV = Infinity, vox = -1, ed = -1;
        lists.forEach((l, i) => { const sm = smoothed(cyc[i]); for (const k of l) { const v = sm.get(k); if (v < bestV) { bestV = v; vox = k; ed = cyc[i]; } } });
        return vox < 0 ? null : [vox, ed];
      }
      let bestV = Infinity, bi = -1;   // lowestBranch: the branch of the lowest mean, then its lowest voxel
      lists.forEach((l, i) => {
        if (!l.length) return;
        let sum = 0;
        for (const k of l) sum += intensity(k);
        if (sum / l.length < bestV) { bestV = sum / l.length; bi = i; }
      });
      if (bi < 0) return null;
      let lo = Infinity, vox = -1;
      const smb = smoothed(cyc[bi]);
      for (const k of lists[bi]) { const v = smb.get(k); if (v < lo) { lo = v; vox = k; } }
      return [vox, cyc[bi]];
    };
    // adjacency of ALL branches, built once (reverse order per vertex); a branch that was cut is skipped while walking. Rings are cycles by themselves.
    const adj = new Map();
    for (let ei = 0; ei < G.edges.length; ei++) {
      const e = G.edges[ei];
      if (e.ring) continue;
      const a = vid(e.a), b = vid(e.b);
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a).push([ei, b]);
      if (b !== a) { if (!adj.has(b)) adj.set(b, []); adj.get(b).push([ei, a]); }
    }
    for (const l of adj.values()) l.reverse();
    let ringPtr = 0, steps = 0;
    const budget = async () => { if ((++steps & 2047) === 0) { hooks.check(); await hooks.tick(0.05 + 0.25 * Math.min(1, cuts.length / Math.max(1, G.edges.length))); } };
    for (;;) {
      let cyc = null;
      while (ringPtr < G.edges.length && !(alive[ringPtr] && G.edges[ringPtr].ring)) ringPtr++;
      if (ringPtr < G.edges.length) cyc = [ringPtr];
      if (!cyc) {
        const seen = new Set();
        for (const s of order) {
          if (cyc) break;
          if (seen.has(s) || !adj.has(s)) continue;
          seen.add(s);
          const path = [s], pedges = [], onstack = new Map([[s, 0]]);
          const frames = [{ u: s, pe: -1, i: 0 }];
          while (frames.length && !cyc) {
            const f = frames[frames.length - 1];
            const list = adj.get(f.u);
            let advanced = false;
            while (f.i < list.length) {
              const [ei, v] = list[f.i++];
              if (!alive[ei] || ei === f.pe) continue;
              if (v === f.u) { cyc = [ei]; break; }
              if (onstack.has(v)) { cyc = pedges.slice(onstack.get(v)).concat([ei]); break; }
              if (!seen.has(v)) {
                seen.add(v); onstack.set(v, path.length); path.push(v); pedges.push(ei);
                frames.push({ u: v, pe: ei, i: 0 }); advanced = true; break;
              }
            }
            if (cyc) break;
            if (!advanced) { frames.pop(); onstack.delete(f.u); path.pop(); if (pedges.length) pedges.pop(); }
            await budget();
          }
        }
      }
      if (!cyc) break;
      const hit = pick(cyc);
      // the branch that was cut leaves the graph; a voxel inside the excluded ROI is kept (the cycle is then left as it is)
      alive[hit ? hit[1] : cyc[0]] = false;
      if (hit && !(inRoi && inRoi(G.pix[hit[0]]))) cuts.push(hit[0]);
      await budget();
    }
    return cuts;
  }

  /* The measurements of a graph. Returns { rows, trees, branchRows, sp, pruned: removed voxel numbers } */
  async function skeletonMeasure(G, o, data, inRoi, hooks) {
    const nG = G.gFirst.length, tag = G.tag, pw = G.pw, ph = G.ph;
    const vid = (k) => (tag[k] === SK_JUNCTION ? G.grp[k] : nG + k);
    const trees = [];
    for (let t = 0; t < G.nTrees; t++) trees.push({ branches: 0, junctions: 0, ends: 0, jvox: 0, slabs: 0, sum: 0, max: 0, deg: new Map(), edges: [] });
    for (let k = 0; k < G.N; k++) {
      const T = trees[G.tree[k]];
      if (tag[k] === SK_END) T.ends++; else if (tag[k] === SK_JUNCTION) T.jvox++; else T.slabs++;
    }
    for (let g = 0; g < nG; g++) { trees[G.gTree[g]].junctions++; trees[G.gTree[g]].deg.set(g, 0); }
    G.edges.forEach((e, i) => {
      const T = trees[e.t];
      T.branches++; T.sum += e.len; if (e.len > T.max) T.max = e.len; T.edges.push(i);
      if (!e.ring) {
        if (tag[e.a] === SK_JUNCTION) T.deg.set(G.grp[e.a], T.deg.get(G.grp[e.a]) + 1);
        if (e.tagB === SK_JUNCTION) T.deg.set(G.grp[e.b], T.deg.get(G.grp[e.b]) + 1);
      }
    });
    const removed = [];
    const removedSet = new Uint8Array(G.N);
    const prunedEdges = new Set();   // end branches Prune ends took away: Fiji's Branch information lists the graph that is left
    if (o.pruneEnds) {
      for (const e of G.edges) {
        if (e.ring) continue;
        const aE = tag[e.a] === SK_END, bE = e.tagB === SK_END;
        if (!aE && !bE) continue;
        const T = trees[e.t];
        const endVox = aE ? e.a : e.b;
        if (inRoi && inRoi(G.pix[endVox])) continue;
        prunedEdges.add(e);
        const dropped = [];
        for (let i = 1; i < e.path.length - 1; i++) dropped.push(e.path[i]);
        if (aE && bE) {   // isolated: all but the last end-point
          dropped.push(e.a);
          T.ends--;
        } else {
          dropped.push(endVox);
          T.ends--;
          const jv = aE ? e.b : e.a;
          const gj = G.grp[jv];
          T.deg.set(gj, T.deg.get(gj) - 1);
        }
        T.slabs -= e.path.length - 2;
        for (const k of dropped) if (!removedSet[k]) { removedSet[k] = 1; removed.push(k); }
      }
    }
    const rows = trees.map((T) => {
      let tri = 0, quad = 0;
      for (const d of T.deg.values()) { if (d === 3) tri++; else if (d === 4) quad++; }
      return [T.branches, T.junctions, T.ends, T.jvox, T.slabs, T.branches ? T.sum / T.branches : 0, tri, quad, T.max];
    });
    // longest shortest path per tree
    let sp = null;
    if (o.shortestPath) {
      sp = [];
      const vOrder = [];
      for (let g = 0; g < nG; g++) vOrder.push(g);
      for (let k = 0; k < G.N; k++) if (tag[k] === SK_END) vOrder.push(nG + k);
      const point = (v) => { const k = v < nG ? G.gFirst[v] : v - nG; return [G.vx[k], G.vy[k]]; };
      for (let t = 0; t < G.nTrees; t++) {
        const T = trees[t];
        const verts = vOrder.filter((v) => (v < nG ? G.gTree[v] : G.tree[v - nG]) === t);
        const index = new Map(verts.map((v, i) => [v, i]));
        const adj = verts.map(() => []);
        // Two vertices joined by several branches: the one the longest-path search uses is the lower median of their lengths
        // (measured: Fiji took the shorter of two parallel branches in one skeleton and the middle one of three in another).
        const pairs = new Map();
        for (const ei of T.edges) {
          const e = G.edges[ei];
          if (e.ring) continue;
          const a = vid(e.a), b = vid(e.b);
          if (a === b) continue;
          const key = a < b ? a + ':' + b : b + ':' + a;
          if (!pairs.has(key)) pairs.set(key, []);
          pairs.get(key).push(ei);
        }
        for (const list of pairs.values()) {
          const sorted = list.slice().sort((x, y) => (G.edges[x].len - G.edges[y].len) || (x - y));
          const ei = sorted[Math.floor((sorted.length - 1) / 2)], e = G.edges[ei];
          adj[index.get(vid(e.a))].push([index.get(vid(e.b)), e.len, ei]);
          adj[index.get(vid(e.b))].push([index.get(vid(e.a)), e.len, ei]);
        }
        let best = 0, bestSrc = -1, bestDst = verts.length ? 0 : -1, bestPrev = null;
        for (let s = 0; s < verts.length; s++) {
          const D = new Float64Array(verts.length).fill(Infinity), prev = new Int32Array(verts.length).fill(-1), pe = new Int32Array(verts.length).fill(-1);
          D[s] = 0;
          const heap = [[0, s]];
          const push = (it) => { heap.push(it); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
          const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { let l = 2 * c + 1, r = l + 1, m = c; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } } return top; };
          while (heap.length) {
            const [dd, u] = pop();
            if (dd > D[u]) continue;
            for (const [v, L, ei] of adj[u]) if (dd + L < D[v]) { D[v] = dd + L; prev[v] = u; pe[v] = ei; push([D[v], v]); }
          }
          for (let v = 0; v < verts.length; v++) {
            if (D[v] < Infinity && D[v] > best + 1e-12) { best = D[v]; bestSrc = s; bestDst = v; bestPrev = { prev: prev.slice(), pe: pe.slice() }; }
          }
          if ((s & 15) === 15) { hooks.check(); await hooks.tick(0.5 + 0.4 * (t + s / verts.length) / G.nTrees); }
        }
        const pathVox = [];
        if (bestPrev) { for (let v = bestDst; v !== bestSrc && v >= 0; v = bestPrev.prev[v]) { const e = G.edges[bestPrev.pe[v]]; for (let i = 1; i < e.path.length - 1; i++) pathVox.push(e.path[i]); } }
        const pt = bestDst >= 0 ? point(verts[bestDst]) : [0, 0];
        sp.push({ length: best, x: pt[0], y: pt[1], z: 0, pathVox });
      }
    }
    // Branch information
    let branchRows = null;
    if (o.detailed) {
      branchRows = [];
      const run = new Map();
      G.edges.forEach((e) => {
        if (prunedEdges.has(e)) return;
        const T = run.get(e.t) || { n: 0, sum: 0 };
        T.n++; T.sum += e.len; run.set(e.t, T);
        let v1, v2;
        if (e.ring) { v1 = v2 = [G.vx[e.path[0]], G.vy[e.path[0]]]; } else {
          const k1 = tag[e.a] === SK_JUNCTION ? G.gFirst[G.grp[e.a]] : e.a, k2 = e.tagB === SK_JUNCTION ? G.gFirst[G.grp[e.b]] : e.b;
          v1 = [G.vx[k1], G.vy[k1]]; v2 = [G.vx[k2], G.vy[k2]];
        }
        const slabs = [];
        for (let i = e.ring ? 0 : 1; i < (e.ring ? e.path.length : e.path.length - 1); i++) slabs.push(data[G.pix[e.path[i]]]);
        const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
        const third = Math.floor(slabs.length / 3);
        const inner = slabs.length >= 3 ? slabs.slice(third, slabs.length - third) : slabs;
        branchRows.push([e.t + 1, e.len, v1[0], v1[1], 0, v2[0], v2[1], 0, Math.hypot((v1[0] - v2[0]) * pw, (v1[1] - v2[1]) * ph), T.sum / T.n, mean(inner), mean(slabs)]);
      });
    }
    return { rows, sp, branchRows, removed };
  }

  /* analyzeSkeletonImage(data (8-bit, nonzero = skeleton), w, h, params, hooks, inRoi) → { rows, sp, branchRows, tagged, paths, labeled, pruned, ... }.
   * The images are Uint8Array / Uint16Array of w*h (null when not asked): tagged 30 / 70 / 127, paths = the skeleton at 255 and the longest
   * shortest path's slab voxels at 96, labeled = the tree number (1..), pruned = the skeleton left at 255. */
  async function analyzeSkeletonImage(data, w, h, p, hooks, inRoi) {
    checkSkeletonParams(p);
    hooks = Object.assign({ check: noop, tick: noopAsync }, hooks || {});
    const pw = p.pixelWidth || 1, ph = p.pixelHeight || 1, n = w * h;
    let mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (data[i] !== 0) mask[i] = 1;
    const roi = p.excludeRoi && inRoi ? inRoi : null;
    let G = await skeletonGraph(mask, w, h, pw, ph, hooks);
    let nCut = 0;
    if (p.prune !== 'none' && G.edges.length) {
      const cuts = await skeletonCycleCuts(G, p.prune, data, roi, hooks);
      nCut = cuts.length;
      if (cuts.length) {
        for (const k of cuts) mask[G.pix[k]] = 0;
        G = await skeletonGraph(mask, w, h, pw, ph, hooks);
      }
    }
    await hooks.tick(0.3);
    const m = await skeletonMeasure(G, p, data, roi, hooks);
    const tagged = new Uint8Array(n);
    for (let k = 0; k < G.N; k++) tagged[G.pix[k]] = G.tag[k];
    const pruned = new Uint8Array(n);
    for (let k = 0; k < G.N; k++) pruned[G.pix[k]] = 255;
    for (const k of m.removed) pruned[G.pix[k]] = 0;
    let paths = null, labeled = null;
    if (p.shortestPath) {
      paths = new Uint8Array(n);
      for (let k = 0; k < G.N; k++) paths[G.pix[k]] = 255;
      for (const s of m.sp) for (const k of s.pathVox) paths[G.pix[k]] = SK_PATH;
    }
    if (p.labeled) {
      labeled = new Uint16Array(n);
      for (let k = 0; k < G.N; k++) labeled[G.pix[k]] = Math.min(65535, G.tree[k] + 1);
    }
    return { rows: m.rows, sp: m.sp, branchRows: m.branchRows, tagged, paths, labeled, pruned, nTrees: G.nTrees, cycleCuts: nCut, removedEnds: m.removed.length };
  }

  // The columns of the Results table, in Fiji's order (verbatim headings).
  const SKELETON_COLUMNS = ['# Branches', '# Junctions', '# End-point voxels', '# Junction voxels', '# Slab voxels', 'Average Branch Length', '# Triple points', '# Quadruple points', 'Maximum Branch Length'];
  const SKELETON_PATH_COLUMNS = ['Longest Shortest Path', 'spx', 'spy', 'spz'];
  const BRANCH_COLUMNS = ['Skeleton ID', 'Branch length', 'V1 x', 'V1 y', 'V1 z', 'V2 x', 'V2 y', 'V2 z', 'Euclidean distance', 'running average length', 'average intensity (inner 3rd)', 'average intensity'];

  function skeletonInputs(view, io, p) {
    const c = p.ch !== undefined ? p.ch : (io.channel !== null && io.channel !== undefined ? io.channel : view.active);
    const ch = view.channels[c] || view.channels[0];
    return ch.data;
  }
  function roiTester(io, roi, w) {
    if (!roi) return null;
    const m = io.roiMask(roi);
    if (!m) return null;
    return (pixel) => {
      const y = Math.floor(pixel / w), x = pixel - y * w;
      if (x < m.x || y < m.y || x >= m.x + m.w || y >= m.y + m.h) return false;
      return m.data ? m.data[(y - m.y) * m.w + (x - m.x)] !== 0 : true;
    };
  }
  const skeletonHooks = (io, key) => ({ check: () => io.check(), tick: (f) => io.tick(f, key) });

  if (R && S) {
    R.define('analyzeSkeleton', {
      kind: 'compute', version: 1, bitDepths: [8], channels: 'one', roi: 'mask', preview: false,
      validate(p) { checkSkeletonParams(p); },
      // the voxel index map (4 B / px), the masks and images (1 B each, 2 B for the labels), the voxel lists (about 24 B per skeleton voxel,
      // reserved through io.reserve once the skeleton is counted)
      scratchBytes(info) { return info.width * info.height * 10 + 4194304; },
      async run(view, p, roi, io) {
        checkSkeletonParams(p);
        const data = skeletonInputs(view, io, p);
        let nz = 0;
        for (let i = 0; i < data.length; i++) if (data[i] !== 0) nz++;
        if (nz === 0) throw ijError('IJ_FIJI_NO_SKELETON', 'no skeleton pixel');
        io.reserve(nz * 48);
        io.tick(0, 'op.analyzeSkeleton');
        const r = await analyzeSkeletonImage(data, view.width, view.height, p, skeletonHooks(io, 'op.analyzeSkeleton'), roiTester(io, p.excludeRoi ? roi : null, view.width));
        const out = { version: 1, columns: SKELETON_COLUMNS.concat(p.shortestPath ? SKELETON_PATH_COLUMNS : []), nTrees: r.nTrees, cycleCuts: r.cycleCuts, pruneEndsRemoved: r.removedEnds, rows: [] };
        r.rows.forEach((row, i) => out.rows.push(p.shortestPath ? row.concat([r.sp[i].length, r.sp[i].x, r.sp[i].y, r.sp[i].z]) : row.slice()));
        if (p.detailed) { out.branchColumns = BRANCH_COLUMNS; out.branchRows = r.branchRows; }
        return out;
      }
    });

    // The images of the same analysis: [Tagged skeleton, (Longest shortest paths), (Labeled skeletons), (<name>-pruned when something was pruned)]
    R.define('skeletonTagged', {
      kind: 'newdoc', version: 1, bitDepths: [8], channels: 'one', roi: 'mask', preview: false,
      validate(p) { checkSkeletonParams(p); },
      scratchBytes(info) { return info.width * info.height * 16 + 4194304; },
      async run(view, p, roi, io) {
        checkSkeletonParams(p);
        const data = skeletonInputs(view, io, p);
        let nz = 0;
        for (let i = 0; i < data.length; i++) if (data[i] !== 0) nz++;
        if (nz === 0) throw ijError('IJ_FIJI_NO_SKELETON', 'no skeleton pixel');
        io.reserve(nz * 48);
        io.tick(0, 'op.skeletonTagged');
        const r = await analyzeSkeletonImage(data, view.width, view.height, p, skeletonHooks(io, 'op.skeletonTagged'), roiTester(io, p.excludeRoi ? roi : null, view.width));
        const cal = view.calibration ? Object.assign({}, view.calibration) : view.calibration;
        const mk = (name, bd, arr, max) => ({ name, width: view.width, height: view.height, bitDepth: bd, calibration: cal,
          channels: [{ data: arr, name, color: '#ffffff', display: { min: 0, max, lut: 'Grays', invert: false } }] });
        const docs = [mk('Tagged skeleton', 8, r.tagged, 255)];
        if (r.paths) docs.push(mk('Longest shortest paths', 8, r.paths, 255));
        // Fiji: a 32-bit "<title>-labeled-skeletons" holding the tree number (1..) of every skeleton voxel (fixtures fiji/skeleton, case labeled)
        if (r.labeled) docs.push(mk(String(view.name || 'Untitled').replace(/\.(tiff?|png)$/i, '') + '-labeled-skeletons', 32, Float32Array.from(r.labeled), Math.max(1, r.nTrees)));
        // Fiji prunes the source image in place; a document of this plugin never writes into its input, so the pruned skeleton is a new image
        if (p.prune !== 'none' || p.pruneEnds) docs.push(mk(String(view.name || 'Untitled').replace(/\.(tiff?|png)$/i, '') + '-pruned', 8, r.pruned, 255));
        return docs;
      }
    });
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // 5. Cell Counter, Measure: the pixel value of every channel at each marker
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  function checkMarkerParams(p) {
    if (!p || !Array.isArray(p.points) || p.points.length % 2 !== 0 || p.points.length > 2000000) throw ijError('IJ_BAD_ARGS', 'points');
    for (const v of p.points) if (!Number.isInteger(v)) throw ijError('IJ_BAD_ARGS', 'points');
  }
  if (R && S) {
    R.define('cellMarkerValues', {
      kind: 'compute', version: 1, bitDepths: [8, 16, 32], channels: 'one', roi: 'ignore', preview: false,
      validate(p) { checkMarkerParams(p); },
      scratchBytes() { return 1048576; },
      run(view, p) {
        checkMarkerParams(p);
        const w = view.width, h = view.height, n = p.points.length / 2, nc = view.channels.length;
        const values = [];
        for (let i = 0; i < n; i++) {
          const x = p.points[2 * i], y = p.points[2 * i + 1];
          const row = [];
          for (let c = 0; c < nc; c++) row.push(x >= 0 && y >= 0 && x < w && y < h ? view.channels[c].data[y * w + x] : null);
          values.push(row);
        }
        return { values, channels: view.channels.map((c) => c.name) };
      }
    });
  }

  root.IJSkeleton = { analyze: analyzeSkeletonImage, SKELETON_COLUMNS, SKELETON_PATH_COLUMNS, BRANCH_COLUMNS, TAGS: { END: SK_END, JUNCTION: SK_JUNCTION, SLAB: SK_SLAB, PATH: SK_PATH } };

})(typeof self !== 'undefined' ? self : globalThis);
