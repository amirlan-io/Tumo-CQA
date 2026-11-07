import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, validateConfig } from '../server/checklists.js';
test('checklist supports adding and removing criteria while preserving weight validation', () => {
  const config = structuredClone(defaultConfig);
  config.criteria.push({ ...config.criteria[0], criterion_id: 'new', weight: 0 });
  assert.equal(validateConfig(config).criteria.length, 9);
  config.criteria.splice(0, 1);
  config.criteria[0].weight += 10;
  assert.equal(validateConfig(config).criteria.length, 8);
  assert.throws(() => validateConfig({ ...config, criteria: [] }));
});
