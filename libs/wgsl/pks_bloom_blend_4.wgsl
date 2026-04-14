struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@group(0) @binding(0) var bloom0 : texture_2d<f32>;
@group(0) @binding(1) var bloom1 : texture_2d<f32>;
@group(0) @binding(2) var bloom2 : texture_2d<f32>;
@group(0) @binding(3) var bloom3 : texture_2d<f32>;
@group(0) @binding(4) var bloomSampler : sampler;

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex : u32) -> VSOut {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -3.0),
    vec2<f32>(-1.0, 1.0),
    vec2<f32>(3.0, 1.0)
  );

  var out : VSOut;
  let pos = positions[vertexIndex];
  out.position = vec4<f32>(pos, 0.0, 1.0);
  out.uv = pos * 0.5 + vec2<f32>(0.5, 0.5);
  return out;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  let sampleUv = vec2<f32>(in.uv.x, 1.0 - in.uv.y);
  let c0 = textureSample(bloom0, bloomSampler, sampleUv).rgb;
  let c1 = textureSample(bloom1, bloomSampler, sampleUv).rgb;
  let c2 = textureSample(bloom2, bloomSampler, sampleUv).rgb;
  let c3 = textureSample(bloom3, bloomSampler, sampleUv).rgb;
  return vec4<f32>(c0 + c1 + c2 + c3, 1.0);
}
