struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

struct ExtractParams {
  filterParams : vec4<f32>,
  intensity : vec4<f32>,
};

@group(0) @binding(0) var srcTex : texture_2d<f32>;
@group(0) @binding(1) var srcSampler : sampler;
@group(0) @binding(2) var<uniform> params : ExtractParams;

fn is_nan(value : f32) -> bool {
  return value != value;
}

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
  var color = textureSample(srcTex, srcSampler, sampleUv).rgb;

  if (is_nan(color.r)) {
    color.r = 0.0;
  }
  if (is_nan(color.g)) {
    color.g = 0.0;
  }
  if (is_nan(color.b)) {
    color.b = 0.0;
  }

  let brightness = dot(color, vec3<f32>(0.299, 0.587, 0.114));

  var soft = brightness - params.filterParams.y;
  soft = clamp(soft, 0.0, params.filterParams.z);
  soft = soft * soft * params.filterParams.w;

  var contribution = max(soft, brightness - params.filterParams.x);
  contribution = contribution / max(brightness, 0.00001);

  return vec4<f32>(color * contribution * params.intensity.x, 1.0);
}
