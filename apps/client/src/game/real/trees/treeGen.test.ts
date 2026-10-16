import { describe, expect, it } from 'vitest';
import { SPECIES } from './species';
import { generateTree, triangleCount, MAX_TRIANGLES } from './treeGen';

const SEEDS = [1, 2, 3];

describe('generateTree', () => {
  for (const [id, p] of Object.entries(SPECIES)) {
    describe(id, () => {
      it.each(SEEDS)('seed %i: budget, height, normals, wind weights', (seed) => {
        const g = generateTree(p!, seed);
        expect(triangleCount(g)).toBeLessThanOrEqual(MAX_TRIANGLES);
        expect(g.height).toBeGreaterThanOrEqual(p!.height[0]);
        expect(g.height).toBeLessThanOrEqual(p!.height[1]);

        for (const part of [g.wood, g.leaves]) {
          for (let i = 0; i < part.normals.length; i += 3) {
            const l = Math.hypot(part.normals[i]!, part.normals[i + 1]!, part.normals[i + 2]!);
            expect(Math.abs(l - 1)).toBeLessThan(1e-3);
          }
          for (let i = 0; i < part.uvs2.length; i += 2) {
            expect(part.uvs2[i]).toBeGreaterThanOrEqual(0);
            expect(part.uvs2[i]).toBeLessThanOrEqual(1);
          }
        }

        let ymin = Infinity;
        let ymax = -Infinity;
        for (const part of [g.wood, g.leaves]) {
          for (let i = 1; i < part.positions.length; i += 3) {
            ymin = Math.min(ymin, part.positions[i]!);
            ymax = Math.max(ymax, part.positions[i]!);
          }
        }
        expect(ymax - ymin).toBeGreaterThanOrEqual(p!.height[0] - 1e-3);
        expect(ymax - ymin).toBeLessThanOrEqual(p!.height[1] + 1e-3);
      });

      it('same seed gives identical arrays', () => {
        const a = generateTree(p!, 2);
        const b = generateTree(p!, 2);
        expect(a.leaves.positions).toEqual(b.leaves.positions);
        expect(a.wood.indices).toEqual(b.wood.indices);
        expect(a.leaves.uvs).toEqual(b.leaves.uvs);
      });
    });
  }
});
