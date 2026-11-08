import test from 'node:test';
import assert from 'node:assert/strict';
import { project, pickPeg, slotCenter, CENTER_Z, DEFAULT_CAMERA } from '../shared/cubemath.ts';

test('the point the camera looks at is the middle of the canvas', () => {
  const p = project({ x: 0, y: 0, z: CENTER_Z }, DEFAULT_CAMERA, 400);
  assert.ok(Math.abs(p.x - 200) < 1e-9 && Math.abs(p.y - 200) < 1e-9);
});

test('higher slots are drawn higher on screen', () => {
  const ys = [0, 1, 2, 3].map((layer) => project(slotCenter(5, layer), DEFAULT_CAMERA, 400).y);
  assert.ok(ys[0] > ys[1] && ys[1] > ys[2] && ys[2] > ys[3]);
});

test('every peg can be picked from where it is drawn, from several viewpoints', () => {
  for (const [yaw, pitch] of [[0.6, 0.6], [2.2, 0.9], [-1, 0.4], [0.35, 1.2], [4, 0.7]]) {
    const cam = { yaw, pitch, zoom: 1 };
    for (let peg = 0; peg < 16; peg++) {
      const p = project(slotCenter(peg, 1), cam, 400);
      const got = pickPeg(p.x, p.y, cam, 400);
      // When two rods overlap on screen at this angle, the one nearer the viewer is picked.
      const ok = got === peg || (got >= 0 && project(slotCenter(got, 1), cam, 400).depth < p.depth);
      assert.ok(ok, `peg ${peg} at yaw ${yaw}, pitch ${pitch} gave ${got}`);
    }
  }
});

test('a tap well away from the cube picks nothing', () => {
  assert.equal(pickPeg(-300, -300, DEFAULT_CAMERA, 400), -1);
  assert.equal(pickPeg(700, 200, DEFAULT_CAMERA, 400), -1);
});
