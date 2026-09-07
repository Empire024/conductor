import test from 'node:test';
import assert from 'node:assert/strict';
import { updatePanel } from './panel.mjs';

test('adds loading state without querying existing state', () => {
  const added = [];
  const el = {
    classList: {
      contains() {
        throw new Error('contains must not be called');
      },
      add(name) {
        added.push(name);
      }
    }
  };
  updatePanel(el, true);
  assert.deepEqual(added, ['is-loading']);
});
