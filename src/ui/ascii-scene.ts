export interface LinkCoreFrameOptions {
  angleX: number;
  angleY: number;
  width?: number;
  height?: number;
}

interface Point3D {
  x: number;
  y: number;
  z: number;
}

const FACE_SHADES = ".,:;=+*#%@";
const LINK_PATH: readonly Point3D[] = [
  { x: 1.34, y: -0.42, z: 0 },
  { x: 0.72, y: -1.02, z: 0 },
  { x: -0.7, y: -1.02, z: 0 },
  { x: -1.34, y: -0.42, z: 0 },
  { x: -1.34, y: 0.42, z: 0 },
  { x: -0.7, y: 1.02, z: 0 },
  { x: 0.72, y: 1.02, z: 0 },
  { x: 1.34, y: 0.42, z: 0 },
];

function rotate(point: Point3D, angleX: number, angleY: number): Point3D {
  const sinX = Math.sin(angleX);
  const cosX = Math.cos(angleX);
  const sinY = Math.sin(angleY);
  const cosY = Math.cos(angleY);
  const afterX = {
    x: point.x,
    y: point.y * cosX - point.z * sinX,
    z: point.y * sinX + point.z * cosX,
  };
  return {
    x: afterX.x * cosY + afterX.z * sinY,
    y: afterX.y,
    z: -afterX.x * sinY + afterX.z * cosY,
  };
}

function orientForLink(point: Point3D, link: 0 | 1, offset = true): Point3D {
  if (link === 0) {
    return point;
  }
  return {
    x: point.z + (offset ? 0.2 : 0),
    y: point.y,
    z: -point.x,
  };
}

function normalize(point: Point3D): Point3D {
  const length = Math.hypot(point.x, point.y, point.z) || 1;
  return { x: point.x / length, y: point.y / length, z: point.z / length };
}

function mix(
  origin: Point3D,
  along: Point3D,
  alongAmount: number,
  across: Point3D,
  acrossAmount: number,
  depthAmount: number,
): Point3D {
  return {
    x: origin.x + along.x * alongAmount + across.x * acrossAmount,
    y: origin.y + along.y * alongAmount + across.y * acrossAmount,
    z: origin.z + depthAmount,
  };
}

/** Renders ADB Ready's split-link core: two solid, open angular links locked in 3D. */
export function renderLinkCoreFrame(options: LinkCoreFrameOptions): string[] {
  const width = Math.max(20, Math.floor(options.width ?? 36));
  const height = Math.max(10, Math.floor(options.height ?? 14));
  const pixels = Array.from({ length: width * height }, () => " ");
  const depth = new Float64Array(width * height);
  const camera = 4.8;
  const focalX = width * 1.18;
  const focalY = focalX * 0.48;
  const light = normalize({ x: -0.45, y: 0.7, z: 1 });

  const plot = (localPoint: Point3D, localNormal: Point3D, link: 0 | 1, edge = false) => {
    const point = rotate(orientForLink(localPoint, link), options.angleX, options.angleY);
    const normal = normalize(
      rotate(orientForLink(localNormal, link, false), options.angleX, options.angleY),
    );
    const inverseDepth = 1 / (camera - point.z);
    const x = Math.round(width / 2 + point.x * focalX * inverseDepth);
    const y = Math.round(height / 2 - point.y * focalY * inverseDepth);
    if (x < 0 || x >= width || y < 0 || y >= height) {
      return;
    }
    const index = x + y * width;
    const biasedDepth = inverseDepth + (edge ? 0.0008 : 0);
    if (biasedDepth <= (depth[index] ?? 0)) {
      return;
    }
    depth[index] = biasedDepth;
    const diffuse = Math.max(0, normal.x * light.x + normal.y * light.y + normal.z * light.z);
    const rim = (1 - Math.abs(normal.z)) ** 2 * 0.22;
    const luminance = Math.min(1, 0.16 + diffuse * 0.72 + rim + link * 0.04);
    const shadeIndex = Math.min(FACE_SHADES.length - 1, Math.floor(luminance * FACE_SHADES.length));
    pixels[index] = edge ? (luminance > 0.58 ? "@" : "#") : (FACE_SHADES[shadeIndex] ?? ".");
  };

  const halfBand = 0.19;
  const halfDepth = 0.16;
  const step = 0.045;

  for (const link of [0, 1] as const) {
    for (let segment = 0; segment < LINK_PATH.length - 1; segment += 1) {
      const from = LINK_PATH[segment];
      const to = LINK_PATH[segment + 1];
      if (from === undefined || to === undefined) {
        continue;
      }
      const delta = { x: to.x - from.x, y: to.y - from.y, z: 0 };
      const length = Math.hypot(delta.x, delta.y);
      const along = { x: delta.x / length, y: delta.y / length, z: 0 };
      const across = { x: -along.y, y: along.x, z: 0 };

      for (let distance = 0; distance <= length; distance += step) {
        for (let lateral = -halfBand; lateral <= halfBand; lateral += step) {
          plot(mix(from, along, distance, across, lateral, halfDepth), { x: 0, y: 0, z: 1 }, link);
          plot(
            mix(from, along, distance, across, lateral, -halfDepth),
            { x: 0, y: 0, z: -1 },
            link,
          );
        }
        for (let extrusion = -halfDepth; extrusion <= halfDepth; extrusion += step) {
          plot(mix(from, along, distance, across, halfBand, extrusion), across, link);
          plot(
            mix(from, along, distance, across, -halfBand, extrusion),
            { x: -across.x, y: -across.y, z: 0 },
            link,
          );
        }

        for (const lateral of [-halfBand, halfBand]) {
          for (const extrusion of [-halfDepth, halfDepth]) {
            plot(
              mix(from, along, distance, across, lateral, extrusion),
              { x: 0, y: 0, z: extrusion > 0 ? 1 : -1 },
              link,
              true,
            );
          }
        }
      }
    }
  }

  return Array.from({ length: height }, (_, row) =>
    pixels
      .slice(row * width, (row + 1) * width)
      .join("")
      .trimEnd(),
  );
}
