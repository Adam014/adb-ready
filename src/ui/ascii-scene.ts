export interface TorusFrameOptions {
  angleX: number;
  angleZ: number;
  width?: number;
  height?: number;
}

const SHADES = ".,-~:;=!*#$@";

export function renderTorusFrame(options: TorusFrameOptions): string[] {
  const width = Math.max(20, Math.floor(options.width ?? 36));
  const height = Math.max(10, Math.floor(options.height ?? 14));
  const pixels = Array.from({ length: width * height }, () => " ");
  const depth = new Float64Array(width * height);
  const sinX = Math.sin(options.angleX);
  const cosX = Math.cos(options.angleX);
  const sinZ = Math.sin(options.angleZ);
  const cosZ = Math.cos(options.angleZ);
  const scale = width * 0.58;

  for (let theta = 0; theta < Math.PI * 2; theta += 0.11) {
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    for (let phi = 0; phi < Math.PI * 2; phi += 0.045) {
      const sinPhi = Math.sin(phi);
      const cosPhi = Math.cos(phi);
      const ring = 2 + cosTheta;
      const inverseDepth = 1 / (sinX * ring * sinPhi + sinTheta * cosX + 5);
      const projectedX = ring * (cosZ * cosPhi + sinX * sinZ * sinPhi) - sinTheta * cosX * sinZ;
      const projectedY = ring * (sinZ * cosPhi - sinX * cosZ * sinPhi) + sinTheta * cosX * cosZ;
      const x = Math.floor(width / 2 + scale * inverseDepth * projectedX);
      const y = Math.floor(height / 2 - scale * 0.5 * inverseDepth * projectedY);
      const luminance =
        cosPhi * cosTheta * sinZ -
        cosX * cosTheta * sinPhi -
        sinX * sinTheta +
        cosZ * (cosX * sinTheta - cosTheta * sinX * sinPhi);

      if (x < 0 || x >= width || y < 0 || y >= height || luminance <= 0) {
        continue;
      }
      const index = x + width * y;
      if (inverseDepth <= (depth[index] ?? 0)) {
        continue;
      }
      depth[index] = inverseDepth;
      const shadeIndex = Math.min(SHADES.length - 1, Math.max(0, Math.floor(luminance * 7)));
      pixels[index] = SHADES[shadeIndex] ?? SHADES[0] ?? ".";
    }
  }

  return Array.from({ length: height }, (_, row) =>
    pixels
      .slice(row * width, (row + 1) * width)
      .join("")
      .trimEnd(),
  );
}
