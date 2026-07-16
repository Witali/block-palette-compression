/*
 * Purpose: Shared WebGL textured cube renderer used by the main demo and the
 * benchmark GPU warm-up panel.
 * Processing blocks:
 * - Load the cube GLSL shaders and upload a pre-tessellated cube geometry/tangent basis.
 * - Maintain model/view/projection matrices, lighting uniforms, material state, and texture maps.
 * - Draw one or many passes of the same lit rotating stone cube.
 */
(function (global) {
  "use strict";

  const SCRIPT_URL = resolveScriptUrl();
  const PROJECT_ROOT_URL = new URL("../../", SCRIPT_URL).href;
  const DEFAULT_SHADER_URLS = {
    vertex: resolveProjectUrl("src/shaders/cube.vert.glsl?v=material-maps"),
    fragment: resolveProjectUrl("src/shaders/cube.frag.glsl?v=bpdh-split-1"),
  };
  const DEFAULT_BPDH_FRAGMENT_SHADER_URL = resolveProjectUrl(
    "src/shaders/cube-bpdh.frag.glsl?v=bpdh-split-1"
  );
  const DEFAULT_TESSELLATION_SEGMENTS = 64;
  const DEFAULT_GEOMETRY_DISPLACEMENT_SCALE = 0.28;
  const MAX_BPAL_MIP_LEVELS = 16;
  const BPAL_FILTER_MODES = {
    nearest: 0,
    bilinear: 1,
    trilinear: 2,
    anisotropic: 3,
  };
  const FACE_DEFINITIONS = [
    { origin: [-1, -1,  1], uAxis: [ 2, 0,  0], vAxis: [0, 2,  0], normal: [ 0,  0,  1] },
    { origin: [ 1, -1, -1], uAxis: [-2, 0,  0], vAxis: [0, 2,  0], normal: [ 0,  0, -1] },
    { origin: [-1,  1,  1], uAxis: [ 2, 0,  0], vAxis: [0, 0, -2], normal: [ 0,  1,  0] },
    { origin: [-1, -1, -1], uAxis: [ 2, 0,  0], vAxis: [0, 0,  2], normal: [ 0, -1,  0] },
    { origin: [ 1, -1,  1], uAxis: [ 0, 0, -2], vAxis: [0, 2,  0], normal: [ 1,  0,  0] },
    { origin: [-1, -1, -1], uAxis: [ 0, 0,  2], vAxis: [0, 2,  0], normal: [-1,  0,  0] },
  ];
  const MATERIAL_PRESETS = {
    matte: {
      specularStrength: 0.06,
      shininess: 10,
      heightStrength: 0.2,
    },
    glossy: {
      specularStrength: 0.78,
      shininess: 72,
      heightStrength: 0.2,
    },
  };
  class TexturedCubeRenderer {
    static async create(gl, options) {
      const rendererOptions = options || {};
      const shaderUrls = rendererOptions.shaderUrls || DEFAULT_SHADER_URLS;
      const shaderSources = await loadShaderPair(shaderUrls);

      return new TexturedCubeRenderer(gl, shaderSources, {
        ...rendererOptions,
        bpdhFragmentShaderUrl: rendererOptions.bpdhFragmentShaderUrl ||
          DEFAULT_BPDH_FRAGMENT_SHADER_URL,
      });
    }

    constructor(gl, shaderSources, options) {
      this.gl = gl;
      this.options = options || {};
      this.reliefEnabled = this.options.relief !== false;
      this.vertexShaderSource = shaderSources.vertex;
      this.bpdhFragmentShaderUrl = this.options.bpdhFragmentShaderUrl;
      this.programStates = {
        default: createProgramState(gl, shaderSources.vertex, shaderSources.fragment),
        bpdh: null,
      };
      this.programStatePromises = { bpdh: null };
      this.shaderMode = "default";
      this.program = this.programStates.default.program;
      this.locations = this.programStates.default.locations;
      this.tessellationSegments = clampInteger(
        this.options.tessellationSegments,
        1,
        96,
        DEFAULT_TESSELLATION_SEGMENTS
      );
      this.geometryDisplacementScale = Number.isFinite(this.options.geometryDisplacementScale)
        ? this.options.geometryDisplacementScale
        : DEFAULT_GEOMETRY_DISPLACEMENT_SCALE;
      this.heightField = null;
      this.material = { ...MATERIAL_PRESETS.matte };
      this.geometryStats = null;
      this.positionBuffer = gl.createBuffer();
      this.normalBuffer = gl.createBuffer();
      this.tangentBuffer = gl.createBuffer();
      this.bitangentBuffer = gl.createBuffer();
      this.texCoordBuffer = gl.createBuffer();
      this.indexBuffer = gl.createBuffer();
      this.replaceGeometry(this.createGeometry(), gl.STATIC_DRAW);
      this.viewPosition = this.options.eye || [0, 0, 6];
      this.view = mat4LookAt(
        this.viewPosition,
        this.options.target || [0, 0, 0],
        this.options.up || [0, 1, 0]
      );
      this.model = mat4Create();
      this.projection = mat4Create();
      this.fallbackTexture = createSolidTexture(
        gl,
        this.options.placeholderColor || [120, 120, 120, 255],
        0
      );
      this.texture = this.fallbackTexture;
      this.heightTexture = this.reliefEnabled
        ? createSolidTexture(gl, [128, 128, 128, 255], 1)
        : null;
      this.specularTexture = createSolidTexture(gl, [255, 255, 255, 255], 2);
      this.bpalTextures = this.options.compactBpal
        ? {
          pixelIndices: createSolidUintTexture(gl, 0, 3),
          blockPalettes: createSolidUintTexture(gl, 0, 4),
          globalPalette: createSolidUintTexture(gl, 0, 5),
          paletteSelectors: createSolidUintTexture(gl, 0, 6),
        }
        : {
          pixelIndices: createSolidTexture(gl, [0, 0, 0, 255], 3),
          blockPalettes: createSolidTexture(gl, [0, 0, 0, 255], 4),
          globalPalette: createSolidTexture(gl, [120, 120, 120, 255], 5),
          paletteSelectors: createSolidTexture(gl, [0, 0, 0, 255], 6),
        };
      this.bpalTextureInfo = null;
      this.bpalShaderTextureEnabled = false;
      this.dctTexture = this.options.compactBpal
        ? createSolidDctTexture(gl, 7)
        : null;
      this.dctTextureInfo = null;
      this.dctShaderTextureEnabled = false;
      this.bpdhDataTexture = createSolidTexture(gl, [0, 0, 0, 0], 0);
      this.bpdhTextureInfo = null;
      this.bpdhShaderTextureEnabled = false;
      this.bpalSamplerOptions = {
        filterMode: "trilinear",
        maxAnisotropy: 4,
        lodBias: 0,
      };
      this.heightTexelSize = [1, 1];

      this.initializeActiveProgram();
      this.setMaterial(this.options.material || "matte");
    }

    async prepareTextureShaderMode(mode) {
      if (mode !== "default" && mode !== "bpdh") {
        throw new RangeError(`Unsupported cube texture shader mode: ${mode}`);
      }

      if (!this.programStates[mode]) {
        if (!this.programStatePromises[mode]) {
          this.programStatePromises[mode] = loadText(this.bpdhFragmentShaderUrl)
            .then((fragmentSource) => createProgramState(
              this.gl,
              this.vertexShaderSource,
              fragmentSource
            ))
            .then((programState) => {
              this.programStates[mode] = programState;
              return programState;
            })
            .finally(() => {
              this.programStatePromises[mode] = null;
            });
        }

        await this.programStatePromises[mode];
      }
    }

    setTextureShaderMode(mode) {
      if (mode !== "default" && mode !== "bpdh") {
        throw new RangeError(`Unsupported cube texture shader mode: ${mode}`);
      }

      if (!this.programStates[mode]) {
        throw new Error(`Cube texture shader mode is not prepared: ${mode}`);
      }

      if (this.shaderMode === mode) {
        return;
      }

      this.shaderMode = mode;
      this.program = this.programStates[mode].program;
      this.locations = this.programStates[mode].locations;
      this.initializeActiveProgram();
      this.applyBpalTextureUniforms();
      this.applyDctTextureUniforms();
      this.applyBpdhTextureUniforms();
    }

    initializeActiveProgram() {
      const gl = this.gl;

      gl.useProgram(this.program);
      gl.uniformMatrix4fv(this.locations.view, false, this.view);
      gl.uniform1i(this.locations.stoneTexture, 0);
      gl.uniform1i(this.locations.heightTexture, 1);
      gl.uniform1i(this.locations.specularTexture, 2);
      gl.uniform1i(this.locations.bpalPixelIndices, 3);
      gl.uniform1i(this.locations.bpalBlockPalettes, 4);
      gl.uniform1i(this.locations.bpalGlobalPalette, 5);
      gl.uniform1i(this.locations.bpalPaletteSelectors, 6);
      gl.uniform1i(this.locations.dctData, 7);
      gl.uniform1i(this.locations.bpdhData, 0);
      gl.uniform1f(this.locations.useBpalTexture, 0);
      gl.uniform1f(this.locations.useDctTexture, 0);
      gl.uniform3fv(this.locations.lightPosition, this.options.lightPosition || [3.0, 4.0, 5.0]);
      gl.uniform3fv(this.locations.lightColor, this.options.lightColor || [0.92, 0.9, 0.82]);
      gl.uniform3fv(this.locations.ambientColor, this.options.ambientColor || [0.22, 0.22, 0.22]);
      gl.uniform3fv(this.locations.viewPosition, this.viewPosition);
      gl.uniform2fv(this.locations.heightTexelSize, this.heightTexelSize);
      this.applyMaterialUniforms();
      this.applyBpalSamplerUniforms();
    }

    async loadTexture(url, options) {
      const textureOptions = options || {};
      const textureUrl = resolveProjectUrl(url);
      const materialMapPromise = textureOptions.materialMaps === false
        ? Promise.resolve()
        : this.loadMaterialMapsForTexture(textureUrl, textureOptions).catch((error) => {
            console.warn("Material map load failed, keeping placeholder maps.", error);
          });

      if (textureOptions.preferGpuJpeg !== false && global.GpuJpegDecoder) {
        try {
          const decoder = await global.GpuJpegDecoder.create(this.gl);
          const decoded = await decoder.decodeUrl(textureUrl);

          this.replaceTexture(decoded.texture);
          await materialMapPromise;
          return;
        } catch (error) {
          console.warn("GPU JPEG decode failed, falling back to browser image decode.", error);
        }
      }

      try {
        await this.loadTextureWithBrowserDecoder(textureUrl);
      } catch (error) {
        console.warn("Browser texture decode failed, keeping placeholder texture.", error);
      }

      await materialMapPromise;
    }

    async loadTextureWithBrowserDecoder(url) {
      await loadImageTexture(this.gl, this.texture, resolveProjectUrl(url), 0, {
        flipY: true,
      });
    }

    loadTexturePixels(pixels, width, height, options) {
      const textureOptions = options || {};
      const texture = this.gl.createTexture();

      if (!texture) {
        throw new Error("Could not create WebGL texture for RGBA pixels");
      }

      try {
        const textureInfo = uploadPixelTexture(
          this.gl,
          texture,
          pixels,
          width,
          height,
          0,
          { flipY: textureOptions.flipY !== false }
        );

        if (textureOptions.resetMaterialMaps !== false) {
          this.resetMaterialMaps();
        }

        this.replaceTexture(texture);

        return textureInfo;
      } catch (error) {
        this.gl.deleteTexture(texture);
        throw error;
      }
    }

    createBpalTextureResource(shaderData) {
      validateBpalShaderTextureData(shaderData);

      const gl = this.gl;
      const bpalTextures = {
        pixelIndices: gl.createTexture(),
        blockPalettes: gl.createTexture(),
        globalPalette: gl.createTexture(),
        paletteSelectors: gl.createTexture(),
      };

      if (
        !bpalTextures.pixelIndices ||
        !bpalTextures.blockPalettes ||
        !bpalTextures.globalPalette ||
        !bpalTextures.paletteSelectors
      ) {
        deleteTextureSet(gl, bpalTextures);
        throw new Error("Could not create WebGL textures for a BPAL resource");
      }

      try {
        uploadBpalDataTexture(gl, bpalTextures.pixelIndices, shaderData.pixelAtlas, 3);
        uploadBpalDataTexture(gl, bpalTextures.blockPalettes, shaderData.blockPaletteAtlas, 4);
        uploadBpalDataTexture(gl, bpalTextures.globalPalette, shaderData.paletteAtlas, 5);
        uploadBpalDataTexture(gl, bpalTextures.paletteSelectors, shaderData.paletteSelectorAtlas, 6);
      } catch (error) {
        deleteTextureSet(gl, bpalTextures);
        throw error;
      }

      return {
        texture: null,
        bpalTextures,
        bpalTextureInfo: shaderData,
        dctTexture: null,
        dctTextureInfo: null,
        bpdhDataTexture: null,
        bpdhTextureInfo: null,
      };
    }

    createDctTextureResource(shaderData) {
      validateDctShaderTextureData(shaderData);

      if (!this.options.compactBpal) {
        throw new Error("DCTBS2 texture sampling requires WebGL2");
      }

      const texture = this.gl.createTexture();

      if (!texture) {
        throw new Error("Could not create a WebGL2 DCTBS2 texture resource");
      }

      try {
        uploadDctDataTexture(this.gl, texture, shaderData.dataAtlas, 7);
      } catch (error) {
        this.gl.deleteTexture(texture);
        throw error;
      }

      return {
        texture: null,
        bpalTextures: null,
        bpalTextureInfo: null,
        dctTexture: texture,
        dctTextureInfo: createDctRuntimeTextureInfo(shaderData),
        bpdhDataTexture: null,
        bpdhTextureInfo: null,
      };
    }

    createBpdhTextureResource(shaderData) {
      validateBpdhShaderTextureData(shaderData);

      const texture = this.gl.createTexture();

      if (!texture) {
        throw new Error("Could not create a WebGL texture for BPDH shader data");
      }

      try {
        uploadBpalDataTexture(this.gl, texture, shaderData.dataAtlas, 0);
      } catch (error) {
        this.gl.deleteTexture(texture);
        throw error;
      }

      return {
        texture: null,
        bpalTextures: null,
        bpalTextureInfo: null,
        dctTexture: null,
        dctTextureInfo: null,
        bpdhDataTexture: texture,
        bpdhTextureInfo: shaderData,
      };
    }

    deleteBpalTextureResource(resource) {
      if (!resource) {
        return;
      }

      if (resource.texture && resource.texture !== this.fallbackTexture) {
        this.gl.deleteTexture(resource.texture);
      }
      deleteTextureSet(this.gl, resource.bpalTextures);
      if (resource.dctTexture && resource.dctTexture !== this.dctTexture) {
        this.gl.deleteTexture(resource.dctTexture);
      }
      if (resource.bpdhDataTexture && resource.bpdhDataTexture !== this.bpdhDataTexture) {
        this.gl.deleteTexture(resource.bpdhDataTexture);
      }
      resource.texture = null;
      resource.dctTexture = null;
      resource.bpdhDataTexture = null;
    }

    getCurrentBpalTextureResource() {
      return {
        texture: this.texture,
        bpalTextures: this.bpalTextures,
        bpalTextureInfo: this.bpalTextureInfo,
        dctTexture: this.dctTexture,
        dctTextureInfo: this.dctTextureInfo,
        bpdhDataTexture: this.bpdhDataTexture,
        bpdhTextureInfo: this.bpdhTextureInfo,
      };
    }

    discardColorTexture() {
      if (this.texture && this.texture !== this.fallbackTexture) {
        this.gl.deleteTexture(this.texture);
      }
      this.texture = this.fallbackTexture;
    }

    loadBpalShaderTexture(shaderData) {
      validateBpalShaderTextureData(shaderData);

      const gl = this.gl;
      const textures = {
        pixelIndices: gl.createTexture(),
        blockPalettes: gl.createTexture(),
        globalPalette: gl.createTexture(),
        paletteSelectors: gl.createTexture(),
      };

      if (
        !textures.pixelIndices ||
        !textures.blockPalettes ||
        !textures.globalPalette ||
        !textures.paletteSelectors
      ) {
        deleteTextureSet(gl, textures);
        throw new Error("Could not create WebGL textures for BPAL indices");
      }

      try {
        uploadBpalDataTexture(gl, textures.pixelIndices, shaderData.pixelAtlas, 3);
        uploadBpalDataTexture(gl, textures.blockPalettes, shaderData.blockPaletteAtlas, 4);
        uploadBpalDataTexture(gl, textures.globalPalette, shaderData.paletteAtlas, 5);
        uploadBpalDataTexture(gl, textures.paletteSelectors, shaderData.paletteSelectorAtlas, 6);
      } catch (error) {
        deleteTextureSet(gl, textures);
        throw error;
      }

      deleteTextureSet(gl, this.bpalTextures);
      this.bpalTextures = textures;
      this.bpalTextureInfo = shaderData;
      this.applyBpalTextureUniforms();

      return shaderData;
    }

    loadDctShaderTexture(shaderData) {
      validateDctShaderTextureData(shaderData);

      if (!this.options.compactBpal) {
        throw new Error("DCTBS2 texture sampling requires WebGL2");
      }

      const texture = this.gl.createTexture();

      if (!texture) {
        throw new Error("Could not create a WebGL2 DCTBS2 data texture");
      }

      try {
        uploadDctDataTexture(this.gl, texture, shaderData.dataAtlas, 7);
      } catch (error) {
        this.gl.deleteTexture(texture);
        throw error;
      }

      if (this.dctTexture) {
        this.gl.deleteTexture(this.dctTexture);
      }
      this.dctTexture = texture;
      this.dctTextureInfo = createDctRuntimeTextureInfo(shaderData);
      this.applyDctTextureUniforms();

      return shaderData;
    }

    setBpalShaderTextureEnabled(enabled) {
      if (enabled && !this.bpalTextureInfo) {
        throw new Error("Load a BPAL texture before enabling shader indexing");
      }

      this.bpalShaderTextureEnabled = Boolean(enabled);
      if (this.bpalShaderTextureEnabled) {
        this.dctShaderTextureEnabled = false;
        this.bpdhShaderTextureEnabled = false;
      }
      this.applyBpalTextureUniforms();
      this.applyDctTextureUniforms();
      this.applyBpdhTextureUniforms();
    }

    setDctShaderTextureEnabled(enabled) {
      if (enabled && !this.dctTextureInfo) {
        throw new Error("Load a DCTBS2 texture before enabling shader IDCT");
      }

      this.dctShaderTextureEnabled = Boolean(enabled);
      if (this.dctShaderTextureEnabled) {
        this.bpalShaderTextureEnabled = false;
        this.bpdhShaderTextureEnabled = false;
      }
      this.applyBpalTextureUniforms();
      this.applyDctTextureUniforms();
      this.applyBpdhTextureUniforms();
    }

    loadBpdhShaderTexture(shaderData) {
      validateBpdhShaderTextureData(shaderData);

      const texture = this.gl.createTexture();

      if (!texture) {
        throw new Error("Could not create a WebGL texture for BPDH shader data");
      }

      try {
        uploadBpalDataTexture(this.gl, texture, shaderData.dataAtlas, 0);
      } catch (error) {
        this.gl.deleteTexture(texture);
        throw error;
      }

      if (this.bpdhDataTexture) {
        this.gl.deleteTexture(this.bpdhDataTexture);
      }
      this.bpdhDataTexture = texture;
      this.bpdhTextureInfo = shaderData;
      this.applyBpdhTextureUniforms();

      return shaderData;
    }

    setBpdhShaderTextureEnabled(enabled) {
      if (enabled && !this.bpdhTextureInfo) {
        throw new Error("Load a BPDH texture before enabling shader decoding");
      }

      this.bpdhShaderTextureEnabled = Boolean(enabled);
      if (this.bpdhShaderTextureEnabled) {
        this.bpalShaderTextureEnabled = false;
        this.dctShaderTextureEnabled = false;
      }
      this.applyBpalTextureUniforms();
      this.applyDctTextureUniforms();
      this.applyBpdhTextureUniforms();
    }

    applyBpdhTextureUniforms(textureInfo, enabled) {
      const gl = this.gl;
      const info = textureInfo === undefined ? this.bpdhTextureInfo : textureInfo;
      const shaderTextureEnabled = enabled === undefined
        ? this.bpdhShaderTextureEnabled
        : Boolean(enabled);

      gl.useProgram(this.program);

      if (!shaderTextureEnabled || !info) {
        return;
      }

      gl.uniform2f(this.locations.bpdhImageSize, info.width, info.height);
      gl.uniform1f(this.locations.bpdhBlocksX, info.blocksX);
      gl.uniform1f(this.locations.bpdhLocalColorCount, info.localColorCount);
      gl.uniform1f(this.locations.bpdhGlobalColorCount, info.globalColorCount);
      gl.uniform1f(this.locations.bpdhBlockMapOffset, info.blockMapOffset);
      gl.uniform1f(this.locations.bpdhBpalRecordsOffset, info.bpalRecordsOffset);
      gl.uniform1f(this.locations.bpdhBpalRecordStride, info.bpalRecordStride);
      gl.uniform1f(this.locations.bpdhDctRecordsOffset, info.dctRecordsOffset);
      gl.uniform1f(this.locations.bpdhDctRecordStride, info.dctRecordStride);
      gl.uniform2f(
        this.locations.bpdhDataAtlasSize,
        info.dataAtlas.width,
        info.dataAtlas.height
      );
    }

    applyBpalTextureUniforms(textureInfo, enabled) {
      const gl = this.gl;
      const info = textureInfo === undefined ? this.bpalTextureInfo : textureInfo;
      const shaderTextureEnabled = enabled === undefined
        ? this.bpalShaderTextureEnabled
        : Boolean(enabled);

      gl.useProgram(this.program);
      gl.uniform1f(this.locations.useBpalTexture, shaderTextureEnabled && info ? 1 : 0);

      if (!info) {
        return;
      }

      if (info.compact) {
        gl.uniform2ui(this.locations.bpalImageSize, info.width, info.height);
        gl.uniform1ui(this.locations.bpalBlockSize, info.blockSize);
        gl.uniform1ui(this.locations.bpalBlocksX, info.blocksX);
        gl.uniform1ui(this.locations.bpalLocalColorCount, info.localColorCount);
        gl.uniform1ui(this.locations.bpalGlobalColorCount, info.globalColorCount);
        gl.uniform1ui(this.locations.bpalLocalIndexBits, info.localIndexBits);
        gl.uniform1ui(this.locations.bpalGlobalIndexBits, info.globalIndexBits);
        gl.uniform1ui(this.locations.bpalPaletteIndexBits, info.paletteIndexBits);
        gl.uniform1ui(this.locations.bpalPaletteColorBits, info.paletteColorBits);
        gl.uniform2ui(
          this.locations.bpalPixelAtlasSize,
          info.pixelAtlas.width,
          info.pixelAtlas.height
        );
        gl.uniform2ui(
          this.locations.bpalBlockPaletteAtlasSize,
          info.blockPaletteAtlas.width,
          info.blockPaletteAtlas.height
        );
        gl.uniform2ui(
          this.locations.bpalPaletteAtlasSize,
          info.paletteAtlas.width,
          info.paletteAtlas.height
        );
        gl.uniform2ui(
          this.locations.bpalPaletteSelectorAtlasSize,
          info.paletteSelectorAtlas.width,
          info.paletteSelectorAtlas.height
        );
        return;
      }

      gl.uniform2f(this.locations.bpalImageSize, info.width, info.height);
      gl.uniform1f(this.locations.bpalBlockSize, info.blockSize);
      gl.uniform1f(this.locations.bpalBlocksX, info.blocksX);
      gl.uniform1f(this.locations.bpalLocalColorCount, info.localColorCount);
      gl.uniform1f(this.locations.bpalGlobalColorCount, info.globalColorCount);
      gl.uniform2f(
        this.locations.bpalPixelAtlasSize,
        info.pixelAtlas.width,
        info.pixelAtlas.height
      );
      gl.uniform2f(
        this.locations.bpalBlockPaletteAtlasSize,
        info.blockPaletteAtlas.width,
        info.blockPaletteAtlas.height
      );
      gl.uniform2f(
        this.locations.bpalPaletteAtlasSize,
        info.paletteAtlas.width,
        info.paletteAtlas.height
      );
      gl.uniform2f(
        this.locations.bpalPaletteSelectorAtlasSize,
        info.paletteSelectorAtlas.width,
        info.paletteSelectorAtlas.height
      );

      if (Array.isArray(info.levels)) {
        const fallback = info.levels[info.levels.length - 1];

        gl.uniform1f(this.locations.bpalMipCount, info.mipCount);

        for (let index = 0; index < MAX_BPAL_MIP_LEVELS; index += 1) {
          const level = info.levels[index] || fallback;

          gl.uniform4f(
            this.locations.bpalMipInfo[index],
            level.width,
            level.height,
            level.pixelOffset,
            level.blockPaletteOffset
          );
          gl.uniform4f(
            this.locations.bpalMipBlockInfo[index],
            level.blocksX,
            level.blockSize,
            level.localColorCount,
            level.direct ? 1 : 0
          );
          gl.uniform1f(
            this.locations.bpalMipPaletteSelectorOffset[index],
            level.paletteSelectorOffset
          );
        }
      }

      this.applyBpalSamplerUniforms();
    }

    applyDctTextureUniforms(textureInfo, enabled) {
      const gl = this.gl;
      const info = textureInfo === undefined ? this.dctTextureInfo : textureInfo;
      const shaderTextureEnabled = enabled === undefined
        ? this.dctShaderTextureEnabled
        : Boolean(enabled);

      gl.useProgram(this.program);
      gl.uniform1f(this.locations.useDctTexture, shaderTextureEnabled && info ? 1 : 0);

      if (!info || !this.options.compactBpal) {
        return;
      }

      gl.uniform2i(this.locations.dctImageSize, info.width, info.height);
      gl.uniform1i(this.locations.dctMcuColumns, info.mcuColumns);
      gl.uniform1i(this.locations.dctQuality, info.quality);
      gl.uniform1i(this.locations.dctDataTexWidth, info.dataAtlas.width);
      gl.uniform1i(this.locations.dctDecodeMode, info.decodeMode === "fast" ? 1 : 0);
      gl.uniform1i(this.locations.dctChroma420, info.chroma420 ? 1 : 0);
      gl.uniform1i(
        this.locations.dctCacheMcusPerRow,
        info.decodeMode === "fast" ? info.dataAtlas.mcusPerRow : 1
      );
      gl.uniform1i(
        this.locations.dctCacheRecordTexels,
        info.decodeMode === "fast" ? info.dataAtlas.recordTexels : 0
      );
      gl.uniform1i(this.locations.dctCacheCbOffset, info.componentCbOffset || 0);
      gl.uniform1i(this.locations.dctCacheCrOffset, info.componentCrOffset || 0);
    }

    bindInstanceTextureResource(resource) {
      const gl = this.gl;
      const texture = resource
        ? resource.texture || this.fallbackTexture
        : this.texture;
      const bpalTextures = resource
        ? resource.bpalTextures || this.bpalTextures
        : this.bpalTextures;
      const textureInfo = resource ? resource.bpalTextureInfo : this.bpalTextureInfo;
      const shaderTextureEnabled = resource
        ? Boolean(resource.bpalTextureInfo)
        : this.bpalShaderTextureEnabled;
      const dctTexture = resource
        ? resource.dctTexture || this.dctTexture
        : this.dctTexture;
      const dctTextureInfo = resource ? resource.dctTextureInfo : this.dctTextureInfo;
      const dctShaderTextureEnabled = resource
        ? Boolean(resource.dctTextureInfo)
        : this.dctShaderTextureEnabled;
      const bpdhDataTexture = resource
        ? resource.bpdhDataTexture || this.bpdhDataTexture
        : this.bpdhDataTexture;
      const bpdhTextureInfo = resource ? resource.bpdhTextureInfo : this.bpdhTextureInfo;
      const bpdhShaderTextureEnabled = resource
        ? Boolean(resource.bpdhTextureInfo)
        : this.bpdhShaderTextureEnabled;

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bpdhShaderTextureEnabled ? bpdhDataTexture : texture);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, bpalTextures.pixelIndices);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, bpalTextures.blockPalettes);
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, bpalTextures.globalPalette);
      gl.activeTexture(gl.TEXTURE6);
      gl.bindTexture(gl.TEXTURE_2D, bpalTextures.paletteSelectors);
      if (this.options.compactBpal && dctTexture) {
        gl.activeTexture(gl.TEXTURE7);
        gl.bindTexture(gl.TEXTURE_2D, dctTexture);
      }
      this.applyBpalTextureUniforms(textureInfo, shaderTextureEnabled);
      this.applyDctTextureUniforms(dctTextureInfo, dctShaderTextureEnabled);
      this.applyBpdhTextureUniforms(bpdhTextureInfo, bpdhShaderTextureEnabled);
    }

    setBpalSamplerOptions(options) {
      const values = options || {};
      const filterMode = values.filterMode || this.bpalSamplerOptions.filterMode;

      if (!Object.prototype.hasOwnProperty.call(BPAL_FILTER_MODES, filterMode)) {
        throw new RangeError(`Unsupported BPAL filter mode: ${filterMode}`);
      }

      this.bpalSamplerOptions = {
        filterMode,
        maxAnisotropy: clamp(Number(
          values.maxAnisotropy === undefined
            ? this.bpalSamplerOptions.maxAnisotropy
            : values.maxAnisotropy
        ), 1, 8),
        lodBias: clamp(Number(
          values.lodBias === undefined ? this.bpalSamplerOptions.lodBias : values.lodBias
        ), -4, 4),
      };
      this.applyBpalSamplerUniforms();
    }

    applyBpalSamplerUniforms() {
      const gl = this.gl;

      gl.useProgram(this.program);
      gl.uniform1f(
        this.locations.bpalFilterMode,
        BPAL_FILTER_MODES[this.bpalSamplerOptions.filterMode]
      );
      gl.uniform1f(this.locations.bpalMaxAnisotropy, this.bpalSamplerOptions.maxAnisotropy);
      gl.uniform1f(this.locations.bpalLodBias, this.bpalSamplerOptions.lodBias);
    }

    resetMaterialMaps() {
      if (this.reliefEnabled) {
        uploadPixelTexture(
          this.gl,
          this.heightTexture,
          new Uint8Array([128, 128, 128, 255]),
          1,
          1,
          1,
          { flipY: false }
        );
      }
      uploadPixelTexture(
        this.gl,
        this.specularTexture,
        new Uint8Array([255, 255, 255, 255]),
        1,
        1,
        2,
        { flipY: false }
      );

      this.heightField = null;
      this.heightTexelSize = [1, 1];
      if (this.reliefEnabled) {
        this.replaceGeometry(this.createGeometry(), this.gl.DYNAMIC_DRAW);
        this.gl.useProgram(this.program);
        this.gl.uniform2fv(this.locations.heightTexelSize, this.heightTexelSize);
      }
    }

    async loadMaterialMapsForTexture(textureUrl, options) {
      const mapUrls = createMaterialMapUrls(textureUrl, options);
      const [heightResult] = await Promise.all([
        this.reliefEnabled
          ? loadOptionalHeightMap(this.gl, this.heightTexture, mapUrls.height, 1)
          : Promise.resolve(null),
        loadOptionalMaterialTexture(this.gl, this.specularTexture, mapUrls.specular, 2, "specular"),
      ]);

      if (heightResult) {
        this.heightTexelSize = [
          1 / Math.max(1, heightResult.width),
          1 / Math.max(1, heightResult.height),
        ];
        this.heightField = heightResult.heightField;
        this.replaceGeometry(this.createGeometry(), this.gl.DYNAMIC_DRAW);
        this.gl.useProgram(this.program);
        this.gl.uniform2fv(this.locations.heightTexelSize, this.heightTexelSize);
      }
    }

    replaceTexture(texture) {
      if (this.texture && this.texture !== this.fallbackTexture) {
        this.gl.deleteTexture(this.texture);
      }

      this.texture = texture || this.fallbackTexture;
    }

    setMaterial(material) {
      const preset = typeof material === "string" ? MATERIAL_PRESETS[material] : null;
      const values = preset || material || MATERIAL_PRESETS.matte;

      this.material = {
        ...this.material,
        ...values,
      };

      this.replaceGeometry(this.createGeometry(), this.gl.DYNAMIC_DRAW);
      this.applyMaterialUniforms();
    }

    setHeightStrength(heightStrength) {
      this.material.heightStrength = clamp(Number(heightStrength), 0, 1);
      this.replaceGeometry(this.createGeometry(), this.gl.DYNAMIC_DRAW);
      this.applyMaterialUniforms();
    }

    applyMaterialUniforms() {
      const gl = this.gl;

      gl.useProgram(this.program);
      gl.uniform1f(this.locations.specularStrength, this.material.specularStrength);
      gl.uniform1f(this.locations.shininess, this.material.shininess);
      gl.uniform1f(this.locations.heightStrength, this.material.heightStrength);
    }

    resizeToDisplaySize(devicePixelRatio) {
      const pixelRatio = Number.isFinite(devicePixelRatio)
        ? devicePixelRatio
        : global.devicePixelRatio || 1;
      const canvas = this.gl.canvas;
      const width = Math.max(1, Math.floor(canvas.clientWidth * pixelRatio));
      const height = Math.max(1, Math.floor(canvas.clientHeight * pixelRatio));

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    }

    draw(options) {
      const drawOptions = options || {};
      const gl = this.gl;
      const drawPasses = drawOptions.drawPasses || 1;
      const clearColor = drawOptions.clearColor || [0.07, 0.08, 0.1, 1.0];

      if (drawOptions.resizeToDisplaySize) {
        this.resizeToDisplaySize(drawOptions.devicePixelRatio);
      }

      const width = drawOptions.width || gl.drawingBufferWidth;
      const height = drawOptions.height || gl.drawingBufferHeight;
      const instances = Array.isArray(drawOptions.instances) && drawOptions.instances.length > 0
        ? drawOptions.instances
        : [{ translation: [0, 0, 0], scale: 1 }];

      mat4Perspective(
        this.projection,
        drawOptions.fovY || Math.PI / 4,
        width / Math.max(1, height),
        drawOptions.near || 0.1,
        drawOptions.far || 100
      );
      gl.useProgram(this.program);
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.depthFunc(gl.LEQUAL);
      gl.viewport(0, 0, width, height);

      if (drawOptions.clear !== false) {
        gl.clearColor(clearColor[0], clearColor[1], clearColor[2], clearColor[3]);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      }

      this.bindGeometry();
      if (this.reliefEnabled) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.heightTexture);
      }
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.specularTexture);
      gl.uniformMatrix4fv(this.locations.projection, false, this.projection);
      this.applyMaterialUniforms();

      for (const instance of instances) {
        this.bindInstanceTextureResource(instance.textureResource);
        mat4Identity(this.model);
        mat4Translate(this.model, this.model, instance.translation || [0, 0, 0]);
        mat4RotateY(this.model, this.model, drawOptions.angleY || 0);
        mat4RotateX(this.model, this.model, drawOptions.angleX || 0);
        mat4Scale(this.model, this.model, Number.isFinite(instance.scale) ? instance.scale : 1);
        gl.uniformMatrix4fv(this.locations.model, false, this.model);
        gl.uniformMatrix3fv(this.locations.normalMatrix, false, mat3FromMat4(this.model));

        for (let pass = 0; pass < drawPasses; pass += 1) {
          gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
        }
      }
    }

    bindGeometry() {
      const gl = this.gl;

      bindAttributeBuffer(gl, this.locations.position, this.positionBuffer, 3);
      bindAttributeBuffer(gl, this.locations.normal, this.normalBuffer, 3);
      bindAttributeBuffer(gl, this.locations.tangent, this.tangentBuffer, 3);
      bindAttributeBuffer(gl, this.locations.bitangent, this.bitangentBuffer, 3);
      bindAttributeBuffer(gl, this.locations.texCoord, this.texCoordBuffer, 2);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    }

    createGeometry() {
      return createTessellatedCubeGeometry({
        segments: this.tessellationSegments,
        heightField: this.reliefEnabled ? this.heightField : null,
        heightStrength: this.reliefEnabled ? this.material.heightStrength : 0,
        displacementScale: this.geometryDisplacementScale,
      });
    }

    replaceGeometry(geometry, usage) {
      const gl = this.gl;
      const bufferUsage = usage || gl.STATIC_DRAW;

      uploadArrayBuffer(gl, this.positionBuffer, geometry.positions, bufferUsage);
      uploadArrayBuffer(gl, this.normalBuffer, geometry.normals, bufferUsage);
      uploadArrayBuffer(gl, this.tangentBuffer, geometry.tangents, bufferUsage);
      uploadArrayBuffer(gl, this.bitangentBuffer, geometry.bitangents, bufferUsage);
      uploadArrayBuffer(gl, this.texCoordBuffer, geometry.texCoords, bufferUsage);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, bufferUsage);
      this.indexCount = geometry.indices.length;
      this.geometryStats = {
        displaced: Boolean(this.heightField),
        displacementScale: this.geometryDisplacementScale,
        indexCount: geometry.indices.length,
        segments: this.tessellationSegments,
        vertexCount: geometry.positions.length / 3,
      };
    }
  }

  async function loadShaderPair(urls) {
    const [vertex, fragment] = await Promise.all([
      loadText(urls.vertex),
      loadText(urls.fragment),
    ]);

    return { vertex, fragment };
  }

  async function loadText(url) {
    const response = await fetch(resolveProjectUrl(url));

    if (!response.ok) {
      throw new Error(`Failed to fetch shader ${url}: ${response.status} ${response.statusText}`);
    }

    return response.text();
  }

  function createLocations(gl, program) {
    return {
      position: gl.getAttribLocation(program, "aPosition"),
      normal: gl.getAttribLocation(program, "aNormal"),
      tangent: gl.getAttribLocation(program, "aTangent"),
      bitangent: gl.getAttribLocation(program, "aBitangent"),
      texCoord: gl.getAttribLocation(program, "aTexCoord"),
      model: gl.getUniformLocation(program, "uModel"),
      view: gl.getUniformLocation(program, "uView"),
      projection: gl.getUniformLocation(program, "uProjection"),
      normalMatrix: gl.getUniformLocation(program, "uNormalMatrix"),
      stoneTexture: gl.getUniformLocation(program, "uStoneTexture"),
      heightTexture: gl.getUniformLocation(program, "uHeightTexture"),
      specularTexture: gl.getUniformLocation(program, "uSpecularTexture"),
      bpalPixelIndices: gl.getUniformLocation(program, "uBpalPixelIndices"),
      bpalBlockPalettes: gl.getUniformLocation(program, "uBpalBlockPalettes"),
      bpalGlobalPalette: gl.getUniformLocation(program, "uBpalGlobalPalette"),
      bpalPaletteSelectors: gl.getUniformLocation(program, "uBpalPaletteSelectors"),
      dctData: gl.getUniformLocation(program, "uDctData"),
      useBpalTexture: gl.getUniformLocation(program, "uUseBpalTexture"),
      useDctTexture: gl.getUniformLocation(program, "uUseDctTexture"),
      bpalImageSize: gl.getUniformLocation(program, "uBpalImageSize"),
      bpalBlockSize: gl.getUniformLocation(program, "uBpalBlockSize"),
      bpalBlocksX: gl.getUniformLocation(program, "uBpalBlocksX"),
      bpalLocalColorCount: gl.getUniformLocation(program, "uBpalLocalColorCount"),
      bpalGlobalColorCount: gl.getUniformLocation(program, "uBpalGlobalColorCount"),
      bpalLocalIndexBits: gl.getUniformLocation(program, "uBpalLocalIndexBits"),
      bpalGlobalIndexBits: gl.getUniformLocation(program, "uBpalGlobalIndexBits"),
      bpalPaletteIndexBits: gl.getUniformLocation(program, "uBpalPaletteIndexBits"),
      bpalPaletteColorBits: gl.getUniformLocation(program, "uBpalPaletteColorBits"),
      bpalPixelAtlasSize: gl.getUniformLocation(program, "uBpalPixelAtlasSize"),
      bpalBlockPaletteAtlasSize: gl.getUniformLocation(program, "uBpalBlockPaletteAtlasSize"),
      bpalPaletteAtlasSize: gl.getUniformLocation(program, "uBpalPaletteAtlasSize"),
      bpalPaletteSelectorAtlasSize: gl.getUniformLocation(program, "uBpalPaletteSelectorAtlasSize"),
      dctImageSize: gl.getUniformLocation(program, "uDctImageSize"),
      dctMcuColumns: gl.getUniformLocation(program, "uDctMcuColumns"),
      dctQuality: gl.getUniformLocation(program, "uDctQuality"),
      dctDataTexWidth: gl.getUniformLocation(program, "uDctDataTexWidth"),
      dctDecodeMode: gl.getUniformLocation(program, "uDctDecodeMode"),
      dctCacheMcusPerRow: gl.getUniformLocation(program, "uDctCacheMcusPerRow"),
      dctCacheRecordTexels: gl.getUniformLocation(program, "uDctCacheRecordTexels"),
      dctCacheCbOffset: gl.getUniformLocation(program, "uDctCacheCbOffset"),
      dctCacheCrOffset: gl.getUniformLocation(program, "uDctCacheCrOffset"),
      dctChroma420: gl.getUniformLocation(program, "uDctChroma420"),
      bpdhData: gl.getUniformLocation(program, "uBpdhData"),
      bpdhImageSize: gl.getUniformLocation(program, "uBpdhImageSize"),
      bpdhBlocksX: gl.getUniformLocation(program, "uBpdhBlocksX"),
      bpdhLocalColorCount: gl.getUniformLocation(program, "uBpdhLocalColorCount"),
      bpdhGlobalColorCount: gl.getUniformLocation(program, "uBpdhGlobalColorCount"),
      bpdhBlockMapOffset: gl.getUniformLocation(program, "uBpdhBlockMapOffset"),
      bpdhBpalRecordsOffset: gl.getUniformLocation(program, "uBpdhBpalRecordsOffset"),
      bpdhBpalRecordStride: gl.getUniformLocation(program, "uBpdhBpalRecordStride"),
      bpdhDctRecordsOffset: gl.getUniformLocation(program, "uBpdhDctRecordsOffset"),
      bpdhDctRecordStride: gl.getUniformLocation(program, "uBpdhDctRecordStride"),
      bpdhDataAtlasSize: gl.getUniformLocation(program, "uBpdhDataAtlasSize"),
      bpalMipCount: gl.getUniformLocation(program, "uBpalMipCount"),
      bpalMipInfo: Array.from(
        { length: MAX_BPAL_MIP_LEVELS },
        (_, index) => gl.getUniformLocation(program, `uBpalMipInfo${index}`)
      ),
      bpalMipBlockInfo: Array.from(
        { length: MAX_BPAL_MIP_LEVELS },
        (_, index) => gl.getUniformLocation(program, `uBpalMipBlockInfo${index}`)
      ),
      bpalMipPaletteSelectorOffset: Array.from(
        { length: MAX_BPAL_MIP_LEVELS },
        (_, index) => gl.getUniformLocation(program, `uBpalMipPaletteSelectorOffset${index}`)
      ),
      bpalFilterMode: gl.getUniformLocation(program, "uBpalFilterMode"),
      bpalMaxAnisotropy: gl.getUniformLocation(program, "uBpalMaxAnisotropy"),
      bpalLodBias: gl.getUniformLocation(program, "uBpalLodBias"),
      heightTexelSize: gl.getUniformLocation(program, "uHeightTexelSize"),
      heightStrength: gl.getUniformLocation(program, "uHeightStrength"),
      lightPosition: gl.getUniformLocation(program, "uLightPosition"),
      lightColor: gl.getUniformLocation(program, "uLightColor"),
      ambientColor: gl.getUniformLocation(program, "uAmbientColor"),
      viewPosition: gl.getUniformLocation(program, "uViewPosition"),
      specularStrength: gl.getUniformLocation(program, "uSpecularStrength"),
      shininess: gl.getUniformLocation(program, "uShininess"),
    };
  }

  function createProgramState(gl, vertexSource, fragmentSource) {
    const program = createProgram(gl, vertexSource, fragmentSource);

    return {
      program,
      locations: createLocations(gl, program),
    };
  }

  function createProgram(gl, vertexSource, fragmentSource) {
    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const shaderProgram = gl.createProgram();

    gl.attachShader(shaderProgram, vertexShader);
    gl.attachShader(shaderProgram, fragmentShader);
    gl.linkProgram(shaderProgram);

    if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(shaderProgram);

      gl.deleteProgram(shaderProgram);
      throw new Error(`Textured cube program link failed: ${message}`);
    }

    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    return shaderProgram;
  }

  function createShader(gl, type, source) {
    const shader = gl.createShader(type);

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);

      gl.deleteShader(shader);
      throw new Error(`Textured cube shader compile failed: ${message}`);
    }

    return shader;
  }

  function createTessellatedCubeGeometry(options) {
    const segments = options.segments;
    const heightField = options.heightField;
    const heightStrength = Number.isFinite(options.heightStrength) ? options.heightStrength : 0;
    const displacementScale = Number.isFinite(options.displacementScale) ? options.displacementScale : 0;
    const positions = [];
    const normals = [];
    const tangents = [];
    const bitangents = [];
    const texCoords = [];
    const indices = [];
    const faceStride = segments + 1;
    const displacementAmount = heightField ? displacementScale * heightStrength : 0;

    FACE_DEFINITIONS.forEach((face) => {
      const baseIndex = positions.length / 3;
      const tangent = normalize(face.uAxis);
      const bitangent = normalize(face.vAxis);

      for (let row = 0; row <= segments; row += 1) {
        const v = row / segments;

        for (let column = 0; column <= segments; column += 1) {
          const u = column / segments;
          const heightSample = heightField ? sampleHeightField(heightField, u, v) : 0.5;
          const displacement = (heightSample - 0.5) * displacementAmount;

          positions.push(
            face.origin[0] + face.uAxis[0] * u + face.vAxis[0] * v + face.normal[0] * displacement,
            face.origin[1] + face.uAxis[1] * u + face.vAxis[1] * v + face.normal[1] * displacement,
            face.origin[2] + face.uAxis[2] * u + face.vAxis[2] * v + face.normal[2] * displacement
          );
          normals.push(face.normal[0], face.normal[1], face.normal[2]);
          tangents.push(tangent[0], tangent[1], tangent[2]);
          bitangents.push(bitangent[0], bitangent[1], bitangent[2]);
          texCoords.push(u, v);
        }
      }

      for (let row = 0; row < segments; row += 1) {
        for (let column = 0; column < segments; column += 1) {
          const topLeft = baseIndex + row * faceStride + column;
          const topRight = topLeft + 1;
          const bottomLeft = baseIndex + (row + 1) * faceStride + column;
          const bottomRight = bottomLeft + 1;

          indices.push(topLeft, topRight, bottomRight, topLeft, bottomRight, bottomLeft);
        }
      }
    });

    return {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      tangents: new Float32Array(tangents),
      bitangents: new Float32Array(bitangents),
      texCoords: new Float32Array(texCoords),
      indices: new Uint16Array(indices),
    };
  }

  function uploadArrayBuffer(gl, buffer, data, usage) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, usage);
  }

  function bindAttributeBuffer(gl, location, buffer, size) {
    if (location < 0) {
      return;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
  }

  function createSolidTexture(gl, color, unit) {
    const texture = gl.createTexture();

    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(color)
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    return texture;
  }

  function createSolidUintTexture(gl, value, unit) {
    const texture = gl.createTexture();

    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R32UI,
      1,
      1,
      0,
      gl.RED_INTEGER,
      gl.UNSIGNED_INT,
      new Uint32Array([value >>> 0])
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    return texture;
  }

  function createSolidDctTexture(gl, unit) {
    const texture = gl.createTexture();

    uploadDctDataTexture(gl, texture, {
      width: 1,
      height: 1,
      data: new Uint8Array(4),
    }, unit);

    return texture;
  }

  async function loadImageTexture(gl, texture, url, unit, options) {
    const image = await loadImage(resolveProjectUrl(url));

    return uploadImageTexture(gl, texture, image, unit, options);
  }

  function uploadImageTexture(gl, texture, image, unit, options) {
    const uploadOptions = options || {};

    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, Boolean(uploadOptions.flipY));
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    return {
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
    };
  }

  function uploadPixelTexture(gl, texture, pixels, width, height, unit, options) {
    const uploadOptions = options || {};

    if (!(pixels instanceof Uint8Array) && !(pixels instanceof Uint8ClampedArray)) {
      throw new TypeError("Texture pixels must be Uint8Array or Uint8ClampedArray");
    }

    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
      throw new RangeError("Texture dimensions must be positive integers");
    }

    if (pixels.length !== width * height * 4) {
      throw new RangeError("Texture RGBA buffer length does not match its dimensions");
    }

    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, Boolean(uploadOptions.flipY));
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    return { width, height };
  }

  function uploadDataTexture(gl, texture, atlas, unit) {
    const format = atlas.channels === 1 ? gl.LUMINANCE : gl.RGBA;

    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      format,
      atlas.width,
      atlas.height,
      0,
      format,
      gl.UNSIGNED_BYTE,
      atlas.data
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }

  function uploadBpalDataTexture(gl, texture, atlas, unit) {
    if (atlas.data instanceof Uint32Array) {
      uploadPackedUintTexture(gl, texture, atlas, unit);
      return;
    }

    uploadDataTexture(gl, texture, atlas, unit);
  }

  function uploadPackedUintTexture(gl, texture, atlas, unit) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R32UI,
      atlas.width,
      atlas.height,
      0,
      gl.RED_INTEGER,
      gl.UNSIGNED_INT,
      atlas.data
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  function uploadDctDataTexture(gl, texture, atlas, unit) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8UI,
      atlas.width,
      atlas.height,
      0,
      gl.RGBA_INTEGER,
      gl.UNSIGNED_BYTE,
      atlas.data
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  function validateBpalShaderTextureData(data) {
    const atlases = data && [
      data.pixelAtlas,
      data.paletteSelectorAtlas,
      data.blockPaletteAtlas,
      data.paletteAtlas,
    ];

    if (
      !data ||
      !Number.isInteger(data.width) ||
      !Number.isInteger(data.height) ||
      !Number.isInteger(data.blockSize) ||
      !Number.isInteger(data.blocksX) ||
      !Number.isInteger(data.localColorCount) ||
      !Number.isInteger(data.globalColorCount) ||
      !atlases ||
      atlases.some((atlas) => (
        !atlas ||
        !(atlas.data instanceof Uint8Array) &&
        !(atlas.data instanceof Uint32Array)
      ))
    ) {
      throw new TypeError("BPAL shader texture data is invalid");
    }
  }

  function validateDctShaderTextureData(data) {
    const formatValid = data && (
      data.format === "dctbs2-rgba8ui" ||
      data.format === "dctbs2-component-cache-rgba8ui"
    );
    const decodeModeValid = data && (
      data.decodeMode === "low-memory" ||
      data.decodeMode === "fast"
    );
    const expectedChromaSamples = data && data.chroma420 ? 64 : 128;
    const componentLayoutValid = !data || data.decodeMode !== "fast" || (
      data.componentBytesPerMcu === 256 + expectedChromaSamples * 2 &&
      data.componentYOffset === 0 &&
      data.componentCbOffset === 256 &&
      data.componentCrOffset === 256 + expectedChromaSamples
    );

    if (
      !data ||
      !formatValid ||
      !decodeModeValid ||
      !componentLayoutValid ||
      !Number.isInteger(data.width) ||
      !Number.isInteger(data.height) ||
      !Number.isInteger(data.mcuColumns) ||
      !Number.isInteger(data.quality) ||
      !data.dataAtlas ||
      !Number.isInteger(data.dataAtlas.width) ||
      !Number.isInteger(data.dataAtlas.height) ||
      !(data.dataAtlas.data instanceof Uint8Array) ||
      data.decodeMode === "fast" && (
        !Number.isInteger(data.dataAtlas.mcusPerRow) ||
        data.dataAtlas.mcusPerRow < 1 ||
        data.dataAtlas.recordTexels !== data.componentBytesPerMcu / 4
      )
    ) {
      throw new TypeError("DCTBS2 shader texture data is invalid");
    }
  }

  function createDctRuntimeTextureInfo(data) {
    return {
      ...data,
      dataAtlas: {
        width: data.dataAtlas.width,
        height: data.dataAtlas.height,
        channels: data.dataAtlas.channels,
        mcusPerRow: data.dataAtlas.mcusPerRow,
        recordTexels: data.dataAtlas.recordTexels,
      },
    };
  }

  function validateBpdhShaderTextureData(data) {
    if (
      !data ||
      !Number.isInteger(data.width) ||
      !Number.isInteger(data.height) ||
      !Number.isInteger(data.blocksX) ||
      !Number.isInteger(data.localColorCount) ||
      !Number.isInteger(data.globalColorCount) ||
      !data.dataAtlas ||
      !(data.dataAtlas.data instanceof Uint8Array) ||
      data.dataAtlas.channels !== 4
    ) {
      throw new TypeError("BPDH shader texture data is invalid");
    }
  }

  function deleteTextureSet(gl, textures) {
    if (!textures) {
      return;
    }

    Object.values(textures).forEach((texture) => {
      if (texture) {
        gl.deleteTexture(texture);
      }
    });
  }

  async function loadOptionalHeightMap(gl, texture, url, unit) {
    if (!url) {
      return null;
    }

    try {
      return await loadHeightMap(gl, texture, url, unit);
    } catch (error) {
      console.warn(`Failed to load height map ${url}; keeping placeholder texture.`, error);
      return null;
    }
  }

  async function loadHeightMap(gl, texture, url, unit) {
    const image = await loadImage(resolveProjectUrl(url));
    const textureInfo = uploadImageTexture(gl, texture, image, unit, { flipY: true });

    return {
      ...textureInfo,
      heightField: createHeightFieldFromImage(image),
    };
  }

  async function loadOptionalMaterialTexture(gl, texture, url, unit, label) {
    if (!url) {
      return null;
    }

    try {
      return await loadImageTexture(gl, texture, url, unit, { flipY: true });
    } catch (error) {
      console.warn(`Failed to load ${label} map ${url}; keeping placeholder texture.`, error);
      return null;
    }
  }

  function createHeightFieldFromImage(image) {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const canvas = document.createElement("canvas");

    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d", { willReadFrequently: true });

    if (!context) {
      return null;
    }

    context.drawImage(image, 0, 0, width, height);

    const pixels = context.getImageData(0, 0, width, height).data;
    const values = new Float32Array(width * height);

    for (let source = 0, target = 0; source < pixels.length; source += 4, target += 1) {
      values[target] = pixels[source] / 255;
    }

    return { width, height, values };
  }

  function sampleHeightField(heightField, u, v) {
    if (!heightField || !heightField.values.length) {
      return 0.5;
    }

    const x = clamp(u, 0, 1) * (heightField.width - 1);
    const y = (1 - clamp(v, 0, 1)) * (heightField.height - 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(heightField.width - 1, x0 + 1);
    const y1 = Math.min(heightField.height - 1, y0 + 1);
    const tx = x - x0;
    const ty = y - y0;
    const topOffset = y0 * heightField.width;
    const bottomOffset = y1 * heightField.width;
    const top = lerp(
      heightField.values[topOffset + x0],
      heightField.values[topOffset + x1],
      tx
    );
    const bottom = lerp(
      heightField.values[bottomOffset + x0],
      heightField.values[bottomOffset + x1],
      tx
    );

    return lerp(top, bottom, ty);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function createMaterialMapUrls(textureUrl, options) {
    const mapOptions = options || {};

    return {
      height: mapOptions.heightMapUrl === false
        ? null
        : mapOptions.heightMapUrl
          ? resolveProjectUrl(mapOptions.heightMapUrl)
          : createSiblingMapUrl(textureUrl, "-height"),
      specular: mapOptions.specularMapUrl === false
        ? null
        : mapOptions.specularMapUrl
          ? resolveProjectUrl(mapOptions.specularMapUrl)
          : createSiblingMapUrl(textureUrl, "-specular"),
    };
  }

  function createSiblingMapUrl(textureUrl, suffix) {
    const url = new URL(resolveProjectUrl(textureUrl));

    if (!/\.[^/.]+$/.test(url.pathname)) {
      return null;
    }

    url.pathname = url.pathname.replace(/\.[^/.]+$/, `${suffix}.png`);
    url.search = "";
    url.hash = "";

    return url.href;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();

      image.addEventListener("load", () => resolve(image), { once: true });
      image.addEventListener("error", () => {
        reject(new Error(`Failed to load cube texture ${url}`));
      }, { once: true });
      image.src = url;
    });
  }

  function resolveProjectUrl(path) {
    if (/^(?:[a-z]+:)?\/\//i.test(path) || path.startsWith("blob:") || path.startsWith("data:")) {
      return path;
    }

    return new URL(path, PROJECT_ROOT_URL).href;
  }

  function resolveScriptUrl() {
    if (global.document && global.document.currentScript && global.document.currentScript.src) {
      return global.document.currentScript.src;
    }

    if (global.location && global.location.href) {
      return global.location.href;
    }

    return "";
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function clampInteger(value, min, max, fallback) {
    const numericValue = Number(value);

    if (!Number.isFinite(numericValue)) {
      return fallback;
    }

    return Math.round(clamp(numericValue, min, max));
  }

  function mat4Create() {
    return new Float32Array(16);
  }

  function mat4Identity(out) {
    out[0] = 1;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    out[5] = 1;
    out[6] = 0;
    out[7] = 0;
    out[8] = 0;
    out[9] = 0;
    out[10] = 1;
    out[11] = 0;
    out[12] = 0;
    out[13] = 0;
    out[14] = 0;
    out[15] = 1;
    return out;
  }

  function mat4Perspective(out, fovY, aspect, near, far) {
    const f = 1 / Math.tan(fovY / 2);
    const nf = 1 / (near - far);

    out[0] = f / aspect;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    out[5] = f;
    out[6] = 0;
    out[7] = 0;
    out[8] = 0;
    out[9] = 0;
    out[10] = (far + near) * nf;
    out[11] = -1;
    out[12] = 0;
    out[13] = 0;
    out[14] = 2 * far * near * nf;
    out[15] = 0;

    return out;
  }

  function mat4LookAt(eye, target, up) {
    const z = normalize([
      eye[0] - target[0],
      eye[1] - target[1],
      eye[2] - target[2],
    ]);
    const x = normalize(cross(up, z));
    const y = cross(z, x);
    const out = mat4Create();

    out[0] = x[0];
    out[1] = y[0];
    out[2] = z[0];
    out[3] = 0;
    out[4] = x[1];
    out[5] = y[1];
    out[6] = z[1];
    out[7] = 0;
    out[8] = x[2];
    out[9] = y[2];
    out[10] = z[2];
    out[11] = 0;
    out[12] = -dot(x, eye);
    out[13] = -dot(y, eye);
    out[14] = -dot(z, eye);
    out[15] = 1;

    return out;
  }

  function mat4RotateX(out, matrix, angle) {
    const s = Math.sin(angle);
    const c = Math.cos(angle);
    const a10 = matrix[4];
    const a11 = matrix[5];
    const a12 = matrix[6];
    const a13 = matrix[7];
    const a20 = matrix[8];
    const a21 = matrix[9];
    const a22 = matrix[10];
    const a23 = matrix[11];

    if (matrix !== out) {
      out[0] = matrix[0];
      out[1] = matrix[1];
      out[2] = matrix[2];
      out[3] = matrix[3];
      out[12] = matrix[12];
      out[13] = matrix[13];
      out[14] = matrix[14];
      out[15] = matrix[15];
    }

    out[4] = a10 * c + a20 * s;
    out[5] = a11 * c + a21 * s;
    out[6] = a12 * c + a22 * s;
    out[7] = a13 * c + a23 * s;
    out[8] = a20 * c - a10 * s;
    out[9] = a21 * c - a11 * s;
    out[10] = a22 * c - a12 * s;
    out[11] = a23 * c - a13 * s;

    return out;
  }

  function mat4RotateY(out, matrix, angle) {
    const s = Math.sin(angle);
    const c = Math.cos(angle);
    const a00 = matrix[0];
    const a01 = matrix[1];
    const a02 = matrix[2];
    const a03 = matrix[3];
    const a20 = matrix[8];
    const a21 = matrix[9];
    const a22 = matrix[10];
    const a23 = matrix[11];

    if (matrix !== out) {
      out[4] = matrix[4];
      out[5] = matrix[5];
      out[6] = matrix[6];
      out[7] = matrix[7];
      out[12] = matrix[12];
      out[13] = matrix[13];
      out[14] = matrix[14];
      out[15] = matrix[15];
    }

    out[0] = a00 * c - a20 * s;
    out[1] = a01 * c - a21 * s;
    out[2] = a02 * c - a22 * s;
    out[3] = a03 * c - a23 * s;
    out[8] = a00 * s + a20 * c;
    out[9] = a01 * s + a21 * c;
    out[10] = a02 * s + a22 * c;
    out[11] = a03 * s + a23 * c;

    return out;
  }

  function mat4Translate(out, matrix, translation) {
    const x = translation[0];
    const y = translation[1];
    const z = translation[2];

    if (matrix !== out) {
      for (let index = 0; index < 12; index += 1) {
        out[index] = matrix[index];
      }
    }

    out[12] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    out[13] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    out[14] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    out[15] = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];

    return out;
  }

  function mat4Scale(out, matrix, scale) {
    out[0] = matrix[0] * scale;
    out[1] = matrix[1] * scale;
    out[2] = matrix[2] * scale;
    out[3] = matrix[3] * scale;
    out[4] = matrix[4] * scale;
    out[5] = matrix[5] * scale;
    out[6] = matrix[6] * scale;
    out[7] = matrix[7] * scale;
    out[8] = matrix[8] * scale;
    out[9] = matrix[9] * scale;
    out[10] = matrix[10] * scale;
    out[11] = matrix[11] * scale;

    if (matrix !== out) {
      out[12] = matrix[12];
      out[13] = matrix[13];
      out[14] = matrix[14];
      out[15] = matrix[15];
    }

    return out;
  }

  function mat3FromMat4(matrix) {
    return new Float32Array([
      matrix[0],
      matrix[1],
      matrix[2],
      matrix[4],
      matrix[5],
      matrix[6],
      matrix[8],
      matrix[9],
      matrix[10],
    ]);
  }

  function normalize(vector) {
    const length = Math.hypot(vector[0], vector[1], vector[2]);

    if (length === 0) {
      return [0, 0, 0];
    }

    return [vector[0] / length, vector[1] / length, vector[2] / length];
  }

  function cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }

  function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  global.TexturedCubeRenderer = TexturedCubeRenderer;
})(typeof globalThis !== "undefined" ? globalThis : window);
