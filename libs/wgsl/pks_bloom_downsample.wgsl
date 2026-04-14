struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

struct SourceSize {
  size : vec4<f32>,
};

@group(0) @binding(0) var srcTex : texture_2d<f32>;
@group(0) @binding(1) var srcSampler : sampler;
@group(0) @binding(2) var<uniform> sourceSize : SourceSize;

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
  let size = sourceSize.size.xy;
  let sampleUv = vec2<f32>(in.uv.x, 1.0 - in.uv.y);
  let color1 = textureSample(srcTex, srcSampler, sampleUv + (vec2<f32>(-0.5, -0.5) / size));
  let color2 = textureSample(srcTex, srcSampler, sampleUv + (vec2<f32>(0.5, -0.5) / size));
  let color3 = textureSample(srcTex, srcSampler, sampleUv + (vec2<f32>(-0.5, 0.5) / size));
  let color4 = textureSample(srcTex, srcSampler, sampleUv + (vec2<f32>(0.5, 0.5) / size));
  return (color1 + color2 + color3 + color4) * 0.25;
}
