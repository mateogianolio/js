import {
  IPT,
  TypedArrayConstructor,
} from './types';

const initGLFromCanvas: (canvas: HTMLCanvasElement) => WebGLRenderingContext = (
  canvas: HTMLCanvasElement
): WebGLRenderingContext => {
  const attr: {
    alpha: boolean;
    antialias: boolean;
  } = {
    alpha: false,
    antialias: false,
  };

  let ctx: WebGLRenderingContext | CanvasRenderingContext2D | null = canvas.getContext('webgl', attr);
  if (ctx === null) {
    ctx = canvas.getContext('experimental-webgl', attr);
  }

  if (ctx === null) {
    throw new Error('turbojs: gl.getContext() returned null.');
  }

  return ctx as WebGLRenderingContext;
};

const gl: WebGLRenderingContext = initGLFromCanvas(document.createElement('canvas'));

if (gl.getExtension('OES_texture_float') === null) {
  throw new Error('turbojs: Required texture format OES_texture_float not supported.');
}

// GPU texture buffer from JS typed array
const newBuffer: (data: number[], f?: TypedArrayConstructor, e?: number) => WebGLBuffer = (
  data: number[],
  f: TypedArrayConstructor = Float32Array,
  e: number = gl.ARRAY_BUFFER
): WebGLBuffer => {
  const buf: WebGLBuffer | null = gl.createBuffer();
  if (buf === null) {
    throw new Error('turbojs: gl.createBuffer() returned null.');
  }

  gl.bindBuffer(e, buf);
  gl.bufferData(e, new f(data), gl.STATIC_DRAW);

  return buf;
};

const positionBuffer: WebGLBuffer = newBuffer([-1, -1, 1, -1, 1, 1, -1, 1]);
const textureBuffer: WebGLBuffer = newBuffer([0, 0, 1, 0, 1, 1, 0, 1]);
const indexBuffer: WebGLBuffer = newBuffer([1, 2, 0, 3, 0, 2], Uint16Array, gl.ELEMENT_ARRAY_BUFFER);

const vertexShaderCode: string = `
attribute vec2 position;
varying vec2 pos;
attribute vec2 texture;

void main(void) {
  pos = texture;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const stdlib: string = `
precision mediump float;
uniform sampler2D u_texture;
varying vec2 pos;

vec4 read(void) {
  return texture2D(u_texture, pos);
}

void commit(vec4 val) {
  gl_FragColor = val;
}

// user code begins here
`;

const vertexShader: WebGLShader | null = gl.createShader(gl.VERTEX_SHADER);
if (vertexShader === null) {
  throw new Error('turbojs: gl.createShader() returned null.');
}

gl.shaderSource(vertexShader, vertexShaderCode);
gl.compileShader(vertexShader);

// This should not fail.
if (gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS) === null) {
  throw new Error(`
    turbojs: Could not build internal vertex shader (fatal).

    INFO: >REPORT< THIS. That's our fault!

    --- CODE DUMP ---
    ${vertexShaderCode}

    --- ERROR LOG ---
    ${gl.getShaderInfoLog(vertexShader)}
  `);
}

// Transfer data onto clamped texture and turn off any filtering
const createTexture: (data: Float32Array, size: number) => WebGLTexture = (
  data: Float32Array,
  size: number
): WebGLTexture => {
  const texture: WebGLTexture | null = gl.createTexture();
  if (texture === null) {
    throw new Error('turbojs: gl.createTexture() returned null.');
  }

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.FLOAT, data);

  // tslint:disable-next-line: no-null-keyword
  gl.bindTexture(gl.TEXTURE_2D, null);

  return texture;
};

// Run code against a pre-allocated array
export const run: (ipt: IPT, code: string) => Float32Array = (
  ipt: IPT,
  code: string
): Float32Array => {
  const fragmentShader: WebGLShader | null = gl.createShader(gl.FRAGMENT_SHADER);
  if (fragmentShader === null) {
    throw new Error('turbojs: gl.createShader() returned null.');
  }

  gl.shaderSource(fragmentShader, stdlib + code);
  gl.compileShader(fragmentShader);

  // Use this output to debug the shader
  // Keep in mind that WebGL GLSL is **much** stricter than e.g. OpenGL GLSL
  if (gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS) === null) {
    const lines: string[] = code.split('\n');

    throw new Error(`
ERROR: Could not build shader (fatal).

------------------ KERNEL CODE DUMP ------------------
${lines
  .map((line: string, i: number): string => `${stdlib.split('\n').length + i}> ${line}`)
  .join('\n')
}

--------------------- ERROR  LOG ---------------------
${gl.getShaderInfoLog(fragmentShader)}
    `);
  }

  const program: WebGLProgram | null = gl.createProgram();
  if (program === null) {
    throw new Error('turbojs: gl.createProgram() returned null.');
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  if (gl.getProgramParameter(program, gl.LINK_STATUS) === null) {
    throw new Error('turbojs: Failed to link GLSL program code.');
  }

  const uTexture: WebGLUniformLocation | null = gl.getUniformLocation(program, 'u_texture');
  if (uTexture === null) {
    throw new Error('turbojs: gl.getUniformLocation() returned null.');
  }

  const aPosition: number = gl.getAttribLocation(program, 'position');
  const aTexture: number = gl.getAttribLocation(program, 'texture');

  gl.useProgram(program);

  const size: number = Math.sqrt(ipt.data.length) / 4;
  const texture: WebGLTexture = createTexture(ipt.data, size);

  gl.viewport(0, 0, size, size);
  gl.bindFramebuffer(gl.FRAMEBUFFER, gl.createFramebuffer());

  // Typed arrays speed this up tremendously.
  const nTexture: WebGLTexture = createTexture(new Float32Array(ipt.data.length), size);

  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, nTexture, 0);

  // Test for mobile bug MDN->WebGL_best_practices, bullet 7
  switch (gl.checkFramebufferStatus(gl.FRAMEBUFFER)) {
    case gl.FRAMEBUFFER_COMPLETE:
      break;
    case gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT:
      throw new Error(`
turbojs: The attachment types are mismatched or not all framebuffer attachment points
are framebuffer attachment complete.`
      );
    case gl.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT:
      throw new Error(`turbojs: There is no attachment.`);
    case gl.FRAMEBUFFER_INCOMPLETE_DIMENSIONS:
      throw new Error(`turbojs: Height and width of the attachment are not the same.`);
    case gl.FRAMEBUFFER_UNSUPPORTED:
      throw new Error(`
turbojs: The format of the attachment is not supported or if depth and stencil attachments
are not the same renderbuffer.`
      );
    default:
      throw new Error('turbojs: Unknown framebuffer status returned.');
  }

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.activeTexture(gl.TEXTURE0);
  gl.uniform1i(uTexture, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, textureBuffer);
  gl.enableVertexAttribArray(aTexture);
  gl.vertexAttribPointer(aTexture, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.enableVertexAttribArray(aPosition);
  gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  gl.readPixels(0, 0, size, size, gl.RGBA, gl.FLOAT, ipt.data);

  return ipt.data.subarray(0, ipt.length);
};

export const alloc: (size: number) => IPT = (
  size: number
): IPT => {
  // A sane limit for most GPUs out there.
  // JS falls apart before GLSL limits could ever be reached.
  if (size > 16777216) {
    throw new Error(`turbojs: Whoops, the maximum array size is exceeded!`);
  }

  const ns: number = Math.pow(Math.pow(2, Math.ceil(Math.log(size) / 1.386) - 1), 2);

  return {
    data: new Float32Array(ns * 16),
    length: size,
  };
};
