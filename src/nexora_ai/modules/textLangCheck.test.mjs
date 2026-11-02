import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTranslation } from './textLangCheck.mjs';

const EN = 'Regression is a supervised learning technique used to predict continuous values from labeled training data.';

// ---- target-language text passes ----

test('zh: CJK text passes', () => {
  assert.equal(validateTranslation('回归是一种监督学习技术，用于从标记的训练数据中预测连续值。这种方法在机器学习中非常常见。', 'zh').ok, true);
});

test('ar: Arabic-script text passes', () => {
  assert.equal(validateTranslation('الانحدار هو تقنية تعلم خاضعة للإشراف تستخدم للتنبؤ بقيم مستمرة من بيانات التدريب الموسومة.', 'ar').ok, true);
});

test('fr: French text passes', () => {
  assert.equal(validateTranslation("La régression est une technique d'apprentissage supervisée utilisée pour prédire des valeurs continues.", 'fr').ok, true);
});

test('de: German text passes', () => {
  assert.equal(validateTranslation('Regression ist eine Technik des überwachten Lernens, die verwendet wird, um kontinuierliche Werte vorherzusagen.', 'de').ok, true);
});

test('es: Spanish text passes', () => {
  assert.equal(validateTranslation('La regresión es una técnica de aprendizaje supervisado que se utiliza para predecir valores continuos.', 'es').ok, true);
});

// ---- English text fails for every target language ----

for (const lang of ['zh', 'ar', 'fr', 'de', 'es']) {
  test(`en text rejected as ${lang}`, () => {
    const r = validateTranslation(EN, lang);
    assert.equal(r.ok, false, `expected rejection, got ${JSON.stringify(r)}`);
  });
}

// ---- empty input fails ----

for (const lang of ['zh', 'ar', 'fr', 'de', 'es']) {
  test(`empty text rejected as ${lang}`, () => {
    assert.equal(validateTranslation('', lang).ok, false);
    assert.equal(validateTranslation('   ', lang).ok, false);
  });
}

// ---- edge cases ----

test('short latin text skips franc (technical term survives)', () => {
  assert.equal(validateTranslation('régression linéaire', 'fr').ok, true); // <40 chars
});

test('en always passes', () => {
  assert.equal(validateTranslation(EN, 'en').ok, true);
});

test('French text with English technical terms still passes', () => {
  assert.equal(validateTranslation("La régression linéaire est une méthode de supervised learning très utilisée en machine learning.", 'fr').ok, true);
});
