import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

/**
 * Генератор иконки приложения.
 *
 * Иконка рисуется кодом, а не лежит бинарником, по двум причинам. Во-первых,
 * знак геометрический: круг, линия и три ветви — описать его тридцатью
 * строками честнее, чем хранить картинку, которую никто не сможет поправить.
 * Во-вторых, размеры и цвета берутся из тех же величин, что и тема
 * приложения, поэтому иконка не разъезжается с ним при смене палитры.
 *
 * Формат — PNG без зависимостей: zlib есть в Node, а CRC32 занимает восемь
 * строк. Остальное electron-builder соберёт сам: из одного PNG 512×512 он
 * делает и .ico, и .icns.
 *
 * Знак — по названию: сома, отходящий от неё аксон и терминали на конце.
 */

const SIZE = 512;
/** Рисуем вчетверо крупнее и уменьшаем — так получаются гладкие края. */
const SCALE = 4;

const BG = [10, 10, 12];
const FG = [244, 244, 248];

const canvas = SIZE * SCALE;
const pixels = new Float64Array(canvas * canvas * 4);

// ─── Примитивы ──────────────────────────────────────────────────────────────

function put(x, y, color, alpha = 1) {
  if (x < 0 || y < 0 || x >= canvas || y >= canvas || alpha <= 0) return;
  const at = (y * canvas + x) * 4;
  const keep = 1 - alpha;
  pixels[at] = pixels[at] * keep + color[0] * alpha;
  pixels[at + 1] = pixels[at + 1] * keep + color[1] * alpha;
  pixels[at + 2] = pixels[at + 2] * keep + color[2] * alpha;
  pixels[at + 3] = Math.min(255, pixels[at + 3] * keep + 255 * alpha);
}

function fillRoundedRect(x0, y0, x1, y1, radius, color) {
  for (let y = Math.floor(y0); y < y1; y++) {
    for (let x = Math.floor(x0); x < x1; x++) {
      // Скругление: точка внутри, если она не выходит за дугу ближайшего угла.
      const dx = Math.max(x0 + radius - x, 0, x - (x1 - radius));
      const dy = Math.max(y0 + radius - y, 0, y - (y1 - radius));
      if (dx * dx + dy * dy <= radius * radius) put(x, y, color, 1);
    }
  }
}

function fillCircle(cx, cy, radius, color) {
  const r2 = radius * radius;
  for (let y = Math.floor(cy - radius); y <= cy + radius; y++) {
    for (let x = Math.floor(cx - radius); x <= cx + radius; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) put(x, y, color, 1);
    }
  }
}

/** Толстый отрезок с круглыми концами — из них собраны и аксон, и ветви. */
function stroke(x0, y0, x1, y1, width, color) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    fillCircle(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, width / 2, color);
  }
}

// ─── Знак ───────────────────────────────────────────────────────────────────

const u = canvas / 512;

fillRoundedRect(0, 0, canvas, canvas, 114 * u, BG);

const midY = canvas / 2;
// Числа подобраны так, чтобы знак стоял по центру с запасом по краям: сома
// начинается на 88, дальняя терминаль кончается на 424 — середина ровно 256.
const somaX = 146 * u;
const branchX = 306 * u;
const tipX = 396 * u;
const somaRadius = 58 * u;
const tipRadius = 28 * u;
const axonWidth = 24 * u;

// Аксон: от сомы к точке ветвления.
stroke(somaX, midY, branchX, midY, axonWidth, FG);

// Три терминали. Верхняя и нижняя уходят под углом, средняя идёт прямо.
for (const dy of [-88 * u, 0, 88 * u]) {
  stroke(branchX, midY, tipX, midY + dy, axonWidth, FG);
  fillCircle(tipX, midY + dy, tipRadius, FG);
}

// Сома — крупнее терминалей: с неё начинается сигнал.
fillCircle(somaX, midY, somaRadius, FG);

// ─── Уменьшение и запись ────────────────────────────────────────────────────

const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SCALE; sy++) {
      for (let sx = 0; sx < SCALE; sx++) {
        const at = ((y * SCALE + sy) * canvas + (x * SCALE + sx)) * 4;
        r += pixels[at];
        g += pixels[at + 1];
        b += pixels[at + 2];
        a += pixels[at + 3];
      }
    }
    const n = SCALE * SCALE;
    const at = (y * SIZE + x) * 4;
    out[at] = Math.round(r / n);
    out[at + 1] = Math.round(g / n);
    out[at + 2] = Math.round(b / n);
    out[at + 3] = Math.round(a / n);
  }
}

fs.writeFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'icon.png'),
  encodePng(out, SIZE, SIZE),
);
console.log(`Иконка готова: ${SIZE}×${SIZE}`);

// ─── PNG ────────────────────────────────────────────────────────────────────

function encodePng(rgba, width, height) {
  // Каждой строке предшествует байт фильтра; ноль — «без фильтра».
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // сжатие deflate
  ihdr[11] = 0; // фильтрация по умолчанию
  ihdr[12] = 0; // без чересстрочности

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');

  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);

  return Buffer.concat([head, data, tail]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
