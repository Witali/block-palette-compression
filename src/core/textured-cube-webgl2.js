/*
 * Purpose: WebGL2 compact BPAL cube renderer factory.
 * Processing blocks:
 * - Select GLSL ES 3.00 shaders with integer samplers.
 * - Configure the shared cube renderer for packed R32UI BPAL atlases.
 * - Keep the public renderer API identical to the WebGL1 implementation.
 */
(function (global) {
  "use strict";

  const COMPACT_SHADER_URLS = {
    vertex: "src/shaders/cube-webgl2.vert.glsl?v=compact-bpal-1",
    fragment: "src/shaders/cube-webgl2.frag.glsl?v=dct-cube-2",
  };

  class CompactTexturedCubeRenderer {
    static async create(gl, options) {
      if (!gl || typeof gl.uniform1ui !== "function" || gl.R32UI === undefined) {
        throw new Error("Compact BPAL rendering requires WebGL2");
      }

      return global.TexturedCubeRenderer.create(gl, {
        ...(options || {}),
        compactBpal: true,
        shaderUrls: COMPACT_SHADER_URLS,
      });
    }
  }

  global.CompactTexturedCubeRenderer = CompactTexturedCubeRenderer;
})(typeof self !== "undefined" ? self : globalThis);
