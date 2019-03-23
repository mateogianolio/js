import {
  deepStrictEqual,
} from 'assert';

import {
  alloc,
  run,
} from './';
import { IPT } from './types';

describe('turbo', () => {
  describe('alloc', () => {
    it('should work as expected', () => {
      const x: IPT = alloc(4);
      const y: IPT = {
        data: new Float32Array(64),
        length: 4,
      };

      deepStrictEqual(x, y);
    });
  });

  describe('run', () => {
    it('should work as expected', () => {
      const x: IPT = alloc(4);
      for (let i: number = 0; i < 4; i += 1) {
        x.data[i] = i;
      }

      const y: Float32Array = new Float32Array([0, 2, 4, 6]);

      deepStrictEqual(
        run(x, `
          void main(void) {
            commit(read() * 2.);
          }
        `),
        y
      );
    });
  });
});
