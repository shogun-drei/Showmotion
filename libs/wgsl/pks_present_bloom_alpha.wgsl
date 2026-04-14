struct VSOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
};

@vertex
fn vs_fullscreen(@builtin(vertex_index) vi : u32) -> VSOut {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -3.0),
    vec2f(-1.0,  1.0),
    vec2f( 3.0,  1.0)
  );

  var out : VSOut;
  let p = pos[vi];
  out.pos = vec4f(p, 0.0, 1.0);
  out.uv = p * 0.5 + vec2f(0.5);
  return out;
}

@group(0) @binding(0) var sceneTex : texture_2d<f32>;
@group(0) @binding(1) var bloomTex : texture_2d<f32>;
@group(0) @binding(2) var linearSmp : sampler;

fn linearToSrgb(c : vec3f) -> vec3f {
  let cutoff = vec3f(0.0031308);
  let lower = c * 12.92;
  let higher = 1.055 * pow(c, vec3f(1.0 / 2.4)) - vec3f(0.055);
  return select(higher, lower, c <= cutoff);
}

@fragment
fn fs_present(in : VSOut) -> @location(0) vec4f {
  let sampleUv = vec2f(in.uv.x, 1.0 - in.uv.y);
  let scene = textureSample(sceneTex, linearSmp, sampleUv);
  let bloom = textureSample(bloomTex, linearSmp, sampleUv) * 2.0;
  let combined = max(scene.rgb + bloom.rgb, vec3f(0.0));
  let alpha = clamp(max(scene.a, dot(bloom.rgb, vec3f(0.299, 0.587, 0.114))), 0.0, 1.0);
  let presented = linearToSrgb(combined);
  return vec4f(presented * alpha, alpha);
}
