#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outputDirectory = path.join(workspaceRoot, 'apps', 'desktop', 'build');

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function smoothstep(edge0, edge1, value) {
  const normalized = clamp((value - edge0) / (edge1 - edge0));
  return normalized * normalized * (3 - 2 * normalized);
}

function roundedBoxDistance(x, y, centerX, centerY, halfWidth, halfHeight, radius) {
  const offsetX = Math.abs(x - centerX) - halfWidth + radius;
  const offsetY = Math.abs(y - centerY) - halfHeight + radius;
  return (
    Math.hypot(Math.max(offsetX, 0), Math.max(offsetY, 0)) +
    Math.min(Math.max(offsetX, offsetY), 0) -
    radius
  );
}

function circleDistance(x, y, centerX, centerY, radius) {
  return Math.hypot(x - centerX, y - centerY) - radius;
}

function mix(left, right, amount) {
  return Math.round(left + (right - left) * amount);
}

function blendPixel(buffer, offset, color, alpha) {
  const sourceAlpha = clamp(alpha);
  const destinationAlpha = buffer[offset + 3] / 255;
  const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  if (outputAlpha <= 0) return;
  for (let channel = 0; channel < 3; channel += 1) {
    const source = color[channel] / 255;
    const destination = buffer[offset + channel] / 255;
    buffer[offset + channel] = Math.round(
      ((source * sourceAlpha + destination * destinationAlpha * (1 - sourceAlpha)) / outputAlpha) *
        255,
    );
  }
  buffer[offset + 3] = Math.round(outputAlpha * 255);
}

/**
 * 生成高对比、缩小后仍清晰的 E Agent 图标像素。
 */
function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = size / 1024;
  const backgroundDistance = (x, y) =>
    roundedBoxDistance(x, y, 512 * scale, 512 * scale, 468 * scale, 468 * scale, 190 * scale);
  const strokes = [
    [310, 512, 62, 274],
    [500, 318, 250, 62],
    [470, 512, 220, 62],
    [500, 706, 250, 62],
  ];
  const nodes = [
    [774, 318, 42, [93, 242, 255]],
    [726, 512, 34, [120, 216, 255]],
    [774, 706, 42, [162, 128, 255]],
  ];

  for (let pixelY = 0; pixelY < size; pixelY += 1) {
    for (let pixelX = 0; pixelX < size; pixelX += 1) {
      const offset = (pixelY * size + pixelX) * 4;
      const x = pixelX + 0.5;
      const y = pixelY + 0.5;
      const backgroundAlpha = smoothstep(1.5 * scale, -1.5 * scale, backgroundDistance(x, y));
      if (backgroundAlpha > 0) {
        const vertical = pixelY / Math.max(1, size - 1);
        const glow = clamp(
          1 - Math.hypot(pixelX - size * 0.74, pixelY - size * 0.27) / (size * 0.75),
        );
        blendPixel(
          pixels,
          offset,
          [
            mix(10, 28, vertical) + Math.round(glow * 5),
            mix(22, 40, vertical) + Math.round(glow * 14),
            mix(48, 84, vertical) + Math.round(glow * 24),
          ],
          backgroundAlpha,
        );
      }

      for (const [centerX, centerY, halfWidth, halfHeight] of strokes) {
        const distance = roundedBoxDistance(
          x,
          y,
          centerX * scale,
          centerY * scale,
          halfWidth * scale,
          halfHeight * scale,
          45 * scale,
        );
        const alpha = smoothstep(1.3 * scale, -1.3 * scale, distance);
        if (alpha > 0) {
          const horizontal = clamp((pixelX / size - 0.24) / 0.56);
          blendPixel(
            pixels,
            offset,
            [mix(238, 116, horizontal), mix(250, 222, horizontal), 255],
            alpha,
          );
        }
      }

      for (const [centerX, centerY, radius, color] of nodes) {
        const outer = circleDistance(x, y, centerX * scale, centerY * scale, radius * scale);
        const inner = circleDistance(x, y, centerX * scale, centerY * scale, (radius - 14) * scale);
        blendPixel(
          pixels,
          offset,
          color,
          smoothstep(1.4 * scale, -1.4 * scale, outer) *
            smoothstep(-1.4 * scale, 1.4 * scale, inner),
        );
      }
    }
  }
  return pixels;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let checksum = 0xffffffff;
  for (const byte of buffer) {
    checksum = crcTable[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function createPng(size) {
  const pixels = renderIcon(size);
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let row = 0; row < size; row += 1) {
    const rowOffset = row * (size * 4 + 1);
    rows[rowOffset] = 0;
    pixels.copy(rows, rowOffset + 1, row * size * 4, (row + 1) * size * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createIco(images) {
  const iconSizes = [16, 24, 32, 48, 64, 128, 256];
  const directoryLength = 6 + iconSizes.length * 16;
  const header = Buffer.alloc(directoryLength);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(iconSizes.length, 4);
  let imageOffset = directoryLength;
  const payloads = [];
  iconSizes.forEach((size, index) => {
    const png = images.get(size);
    const entryOffset = 6 + index * 16;
    header[entryOffset] = size === 256 ? 0 : size;
    header[entryOffset + 1] = size === 256 ? 0 : size;
    header[entryOffset + 2] = 0;
    header[entryOffset + 3] = 0;
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(png.length, entryOffset + 8);
    header.writeUInt32LE(imageOffset, entryOffset + 12);
    imageOffset += png.length;
    payloads.push(png);
  });
  return Buffer.concat([header, ...payloads]);
}

function icnsEntry(type, data) {
  const header = Buffer.alloc(8);
  header.write(type, 0, 'ascii');
  header.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([header, data]);
}

function createIcns(images) {
  const entries = Buffer.concat([
    icnsEntry('ic08', images.get(256)),
    icnsEntry('ic09', images.get(512)),
    icnsEntry('ic10', images.get(1024)),
    icnsEntry('ic13', images.get(512)),
    icnsEntry('ic14', images.get(1024)),
  ]);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(entries.length + header.length, 4);
  return Buffer.concat([header, entries]);
}

function mixColor(left, right, amount) {
  return [
    mix(left[0], right[0], amount),
    mix(left[1], right[1], amount),
    mix(left[2], right[2], amount),
  ];
}

function compositeColor(background, foreground, alpha) {
  const amount = clamp(alpha);
  return [
    mix(background[0], foreground[0], amount),
    mix(background[1], foreground[1], amount),
    mix(background[2], foreground[2], amount),
  ];
}

/**
 * 生成 NSIS 原生界面使用的 24 位 BMP，避免安装器依赖浏览器或 HTML 渲染。
 */
function createBmp(width, height, renderPixel) {
  const rowLength = Math.ceil((width * 3) / 4) * 4;
  const pixelData = Buffer.alloc(rowLength * height);

  for (let y = 0; y < height; y += 1) {
    const targetRow = height - y - 1;
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = renderPixel(x + 0.5, y + 0.5).map((channel) =>
        Math.round(clamp(channel, 0, 255)),
      );
      const offset = targetRow * rowLength + x * 3;
      pixelData[offset] = blue;
      pixelData[offset + 1] = green;
      pixelData[offset + 2] = red;
    }
  }

  const header = Buffer.alloc(54);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(header.length + pixelData.length, 2);
  header.writeUInt32LE(header.length, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixelData.length, 34);
  header.writeInt32LE(3780, 38);
  header.writeInt32LE(3780, 42);
  return Buffer.concat([header, pixelData]);
}

function compositeIcon(background, iconPixels, iconSize, x, y, originX, originY) {
  const iconX = Math.floor(x - originX);
  const iconY = Math.floor(y - originY);
  if (iconX < 0 || iconX >= iconSize || iconY < 0 || iconY >= iconSize) return background;
  const offset = (iconY * iconSize + iconX) * 4;
  return compositeColor(
    background,
    [iconPixels[offset], iconPixels[offset + 1], iconPixels[offset + 2]],
    iconPixels[offset + 3] / 255,
  );
}

function createInstallerSidebar(kind) {
  const scale = 3;
  const logicalWidth = 164;
  const logicalHeight = 314;
  const width = logicalWidth * scale;
  const height = logicalHeight * scale;
  const iconSize = 82 * scale;
  const iconPixels = renderIcon(iconSize);
  const isUninstaller = kind === 'uninstall';
  const backgroundTop = isUninstaller ? [27, 18, 43] : [7, 18, 40];
  const backgroundBottom = isUninstaller ? [59, 28, 58] : [15, 35, 73];
  const primary = isUninstaller ? [255, 181, 90] : [89, 226, 255];
  const secondary = isUninstaller ? [219, 132, 255] : [151, 132, 255];
  const cards = [
    { centerY: 164, accent: primary, lineWidths: [31, 49] },
    { centerY: 214, accent: secondary, lineWidths: [46, 26] },
    { centerY: 264, accent: primary, lineWidths: [36, 54] },
  ];

  return createBmp(width, height, (x, y) => {
    const logicalX = x / scale;
    const logicalY = y / scale;
    let color = mixColor(backgroundTop, backgroundBottom, logicalY / logicalHeight);
    const topGlow = clamp(1 - Math.hypot(logicalX - 139, logicalY - 30) / 132);
    const bottomGlow = clamp(1 - Math.hypot(logicalX - 8, logicalY - 288) / 118);
    color = compositeColor(color, primary, topGlow * 0.18);
    color = compositeColor(color, secondary, bottomGlow * 0.13);

    const dotX = Math.min(logicalX % 18, 18 - (logicalX % 18));
    const dotY = Math.min(logicalY % 18, 18 - (logicalY % 18));
    if (Math.hypot(dotX, dotY) < 0.72) {
      color = compositeColor(color, [214, 229, 255], 0.11);
    }

    const diagonalBand = Math.abs(((logicalX + logicalY * 0.24) % 86) - 43);
    if (diagonalBand < 0.45) {
      color = compositeColor(color, secondary, 0.06);
    }

    color = compositeIcon(color, iconPixels, iconSize, x, y, 41 * scale, 34 * scale);

    for (const card of cards) {
      const cardDistance = roundedBoxDistance(logicalX, logicalY, 82, card.centerY, 58, 19, 7);
      if (cardDistance < 0) {
        color = compositeColor(color, [235, 244, 255], 0.095);
      }
      if (Math.abs(cardDistance) < 0.7) {
        color = compositeColor(color, [226, 237, 255], 0.16);
      }

      const statusDistance = circleDistance(logicalX, logicalY, 39, card.centerY, 4);
      if (statusDistance < 0) color = compositeColor(color, card.accent, 0.92);
      const firstLine = roundedBoxDistance(
        logicalX,
        logicalY,
        77,
        card.centerY - 5,
        card.lineWidths[0] / 2,
        1.35,
        1.35,
      );
      const secondLine = roundedBoxDistance(
        logicalX,
        logicalY,
        77,
        card.centerY + 5,
        card.lineWidths[1] / 2,
        1.15,
        1.15,
      );
      if (firstLine < 0) color = compositeColor(color, [229, 240, 255], 0.72);
      if (secondLine < 0) color = compositeColor(color, card.accent, 0.5);

      const actionDistance = circleDistance(logicalX, logicalY, 125, card.centerY, 2.2);
      if (actionDistance < 0) {
        color = compositeColor(color, [229, 240, 255], 0.55);
      }
    }

    const statusRail = roundedBoxDistance(logicalX, logicalY, 82, 298, 44, 2.2, 2.2);
    if (statusRail < 0) color = compositeColor(color, primary, 0.56);
    return color;
  });
}

function createInstallerHeader() {
  const scale = 3;
  const width = 150 * scale;
  const height = 57 * scale;
  const iconSize = 42 * scale;
  const iconPixels = renderIcon(iconSize);

  return createBmp(width, height, (x, y) => {
    const logicalX = x / scale;
    const logicalY = y / scale;
    let color = mixColor([248, 250, 253], [235, 243, 255], logicalX / 150);
    const glow = clamp(1 - Math.hypot(logicalX - 126, logicalY - 10) / 82);
    color = compositeColor(color, [117, 198, 255], glow * 0.15);
    const separator = Math.abs(logicalX - 91);
    if (separator < 0.6) color = compositeColor(color, [173, 191, 218], 0.44);
    return compositeIcon(color, iconPixels, iconSize, x, y, 102 * scale, 7 * scale);
  });
}

await mkdir(outputDirectory, { recursive: true });
const images = new Map([
  [16, createPng(16)],
  [24, createPng(24)],
  [32, createPng(32)],
  [48, createPng(48)],
  [64, createPng(64)],
  [128, createPng(128)],
  [256, createPng(256)],
  [512, createPng(512)],
  [1024, createPng(1024)],
]);
await Promise.all([
  writeFile(path.join(outputDirectory, 'icon.png'), images.get(1024)),
  writeFile(path.join(outputDirectory, 'icon.ico'), createIco(images)),
  writeFile(path.join(outputDirectory, 'icon.icns'), createIcns(images)),
  writeFile(path.join(outputDirectory, 'installer-header.bmp'), createInstallerHeader()),
  writeFile(path.join(outputDirectory, 'installer-sidebar.bmp'), createInstallerSidebar('install')),
  writeFile(
    path.join(outputDirectory, 'uninstaller-sidebar.bmp'),
    createInstallerSidebar('uninstall'),
  ),
]);
console.log(`Desktop icons and native installer artwork generated in ${outputDirectory}`);
