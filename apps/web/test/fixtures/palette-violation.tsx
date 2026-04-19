// Intentional ESLint palette-rule violation. Ignored by the normal
// lint sweep (see eslint.config.mjs ignores); loaded explicitly by
// scripts/test-eslint-palette-rule.sh to verify the rule actually
// reports. Do NOT import this from production code.
export const bad = <div className="bg-red-500 text-slate-900 border-blue-300">nope</div>;
