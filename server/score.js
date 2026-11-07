import { validateAnswers } from './checklists.js';

const round = value => Math.round((value + Number.EPSILON) * 100) / 100;

export function calculateScore(version, results) {
  if (new Set(results.map(r => r.criterion_id)).size !== results.length)
    throw Object.assign(new Error('Критерии не должны повторяться'), { status: 400 });
  validateAnswers(version, results);
  const answers = new Map(results.map(r => [r.criterion_id, r]));
  const applicableWeight = version.criteria.reduce((sum, c) => sum + (answers.get(c.criterion_id).answer === 'na' || c.is_gross_error ? 0 : c.weight), 0);
  let earned = 0;
  const sections = new Map();
  const criteria = version.criteria.map(c => {
    const answer = answers.get(c.criterion_id);
    const applicable = answer.answer !== 'na' && !c.is_gross_error;
    const fraction = !applicable ? 0 : c.answer_type === 'scale'
      ? answer.raw_score / Math.max(...c.scale.map(s => s.value)) : answer.answer === 'yes' ? 1 : 0;
    const points = c.weight * fraction;
    earned += points;
    const section = sections.get(c.section) ?? { section: c.section, earned: 0, weight: 0 };
    section.earned += points;
    section.weight += applicable ? c.weight : 0;
    sections.set(c.section, section);
    return { criterion_id: c.criterion_id, weight: c.weight,
      effective_weight: applicableWeight ? round(applicable ? 100 * c.weight / applicableWeight : 0) : null,
      weighted_points: round(points), points: applicableWeight ? round(100 * points / applicableWeight) : null };
  });
  return { total: applicableWeight ? round(100 * earned / applicableWeight) : null,
    applicable_weight: applicableWeight,
    gross_error: version.criteria.some(c => c.is_gross_error && answers.get(c.criterion_id).answer === 'yes'),
    criteria, sections: [...sections.values()].map(s => ({ section: s.section,
      points: applicableWeight ? round(100 * s.earned / applicableWeight) : null,
      maximum: applicableWeight ? round(100 * s.weight / applicableWeight) : null })) };
}

export function applyDecisions(results, decisions) {
  // Decisions arrive in database insertion order. Confirmation preserves earlier changes.
  return decisions.reduce((current, d) => d.action !== 'change' ? current : current.map(r =>
    r.criterion_id === d.criterion_id ? { ...r, ...d.replacement, na_reason: d.replacement.na_reason ?? null } : r), results);
}

export function evaluationView(store, evaluation) {
  const version = store.get('checklist_version', evaluation.checklist_version);
  const decisions = store.list('decision').filter(d => d.evaluation_id === evaluation.id);
  const final_results = applyDecisions(evaluation.results, decisions);
  return { ...evaluation, decisions, final_results,
    original_score: calculateScore(version, evaluation.results), final_score: calculateScore(version, final_results) };
}
