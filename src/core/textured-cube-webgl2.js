/*
 * Purpose: WebGL2 compact BPAL cube renderer factory.
 * Processing blocks:
 * - Select GLSL ES 3.00 shaders with integer samplers.
 * - Configure the shared cube renderer for packed R32UI BPAL atlases.
 * - Keep the public renderer API identical to the WebGL1 implementation.
 */
(function (global) {
  "use strict";

  const COMPACT_VERTEX_SHADER = "src/shaders/cube-webgl2.vert.glsl?v=bpdh-split-1";
  const BPDH_FRAGMENT_SHADER = "src/shaders/cube-webgl2-bpdh.frag.glsl?v=bpdh-split-1";
  const DCT_PROFILE_FRAGMENT_SHADERS = Object.freeze({
    "0.75": "src/shaders/cube-webgl2-dctbs2-0_75bpp.frag.glsl?v=dct-zigzag-1",
    "1": "src/shaders/cube-webgl2-dctbs2-1bpp.frag.glsl?v=dct-zigzag-1",
    "1.5": "src/shaders/cube-webgl2-dctbs2-1_5bpp.frag.glsl?v=dct-zigzag-1",
    "2": "src/shaders/cube-webgl2-dctbs2-2bpp.frag.glsl?v=dct-zigzag-1",
    "3": "src/shaders/cube-webgl2-dctbs2-3bpp.frag.glsl?v=dct-zigzag-1",
    "4.5": "src/shaders/cube-webgl2-dctbs2-4_5bpp.frag.glsl?v=dct-zigzag-1",
    "6": "src/shaders/cube-webgl2-dctbs2-6bpp.frag.glsl?v=dct-zigzag-1",
  });

  class CompactTexturedCubeRenderer {
    static async create(gl, options) {
      if (!gl || typeof gl.uniform1ui !== "function" || gl.R32UI === undefined) {
        throw new Error("Compact BPAL rendering requires WebGL2");
      }

      const rendererOptions = options || {};
      const dctProfile = String(rendererOptions.dctProfile || "1.5");
      const fragmentShader = DCT_PROFILE_FRAGMENT_SHADERS[dctProfile];

      if (!fragmentShader) {
        throw new RangeError(`Unsupported compact Cube DCTBS2 profile: ${dctProfile}`);
      }

      return global.TexturedCubeRenderer.create(gl, {
        ...rendererOptions,
        compactBpal: true,
        bpdhFragmentShaderUrl: BPDH_FRAGMENT_SHADER,
        shaderUrls: {
          vertex: COMPACT_VERTEX_SHADER,
          fragment: fragmentShader,
        },
      });
    }
  }

  global.CompactTexturedCubeRenderer = CompactTexturedCubeRenderer;
})(typeof self !== "undefined" ? self : globalThis);
