import { describe, expect, it } from 'bun:test';
import { ModelRegistryService } from './model-registry.service';

describe('ModelRegistryService', () => {
  it('exposes free models with no plan requirements', () => {
    const registry = new ModelRegistryService();
    const model = registry.getById('gpt-4o');

    expect(model).toBeDefined();
    expect(model?.multiplier).toBe(0);
    expect(model?.baseCost).toBe(0);
    expect(model?.planRequirements).toEqual([]);
    expect(registry.hasAccess('gpt-4o', 'free')).toBe(true);
    expect(registry.getModelsByPlan('free')).toContain(model);
  });
});
