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

// ---- regression: real full-length Ollama outputs from gen_18b7cc52_L1 ----
// These were wrongly rejected by the old absolute 'eng >= 0.9' gate
// (english-plausible) even though the translations are fluent and correct.

const REAL_FR = "L'apprentissage automatique est un domaine d'étude qui permet aux ordinateurs d'apprendre sans être programmés explicitement. Cela signifie que, plutôt que de rédiger des instructions détaillées pour chaque tâche, nous fournissons à l'ordinateur des données et lui laissons le soin de trouver les patterns et de prendre ses propres décisions. Imaginez que vous apprenez à un enfant à reconnaître les formes. Au lieu de lui donner tous les détails sur un cercle, vous lui montrez de nombreux exemples de cercles et lui laissez l'apprendre ce qui fait qu'une forme est un cercle. Cette approche est puissante car elle permet aux ordinateurs d'adapter et d'améliorer leurs performances au fil du temps, les rendant plus efficaces dans des tâches comme la reconnaissance d'image, la traduction de langues, et même le jeu de jeux.";

const REAL_DE = 'Maschinelles Lernen basiert auf drei wesentlichen mathematischen Gebieten: Wahrscheinlichkeitstheorie, Lineare Algebra und Differentialrechnung. Die Wahrscheinlichkeitstheorie hilft uns dabei, Unsicherheiten zu verstehen und Vorhersagen auf der Grundlage von Daten zu treffen. Zum Beispiel, wenn wir das Wetter vorhersagen wollen, nutzen wir die Wahrscheinlichkeit, um anhand historischer Daten die Wahrscheinlichkeit für Regen zu bestimmen. Die Lineare Algebra ist essentiell, um große Datensätze effizient zu verwalten und zu manipulieren. Sie ermöglicht es uns, Daten in Matrizen und Vektoren darzustellen, was Operationen wie Transformationen und Projektionen viel einfacher macht. Differentialrechnung, insbesondere Ableitungen und Integrale, wird zum Optimieren von Modellen genutzt, indem wir die besten Parameter finden, die den Fehler minimieren. Diese mathematischen Werkzeuge bilden das Fundament von Maschinellem Lernen und ermöglichen es uns, Modelle zu erstellen, die aus Daten lernen und präzise Vorhersagen treffen können.';

const REAL_ES = 'La Máquina de Aprendizaje se basa en tres áreas matemáticas clave: la teoría de probabilidad, el álgebra lineal y el cálculo. La teoría de probabilidad nos ayuda a entender la incertidumbre y hacer predicciones basadas en datos. Por ejemplo, si queremos predecir el clima, usamos probabilidades para determinar la probabilidad de lluvia basándonos en datos históricos. El álgebra lineal es esencial para manejar y manipular grandes conjuntos de datos eficientemente. Permite representar los datos en matrices y vectores, lo que facilita operaciones como transformaciones y proyecciones. El cálculo, especialmente derivadas e integrales, se utiliza para optimizar modelos encontrando los mejores parámetros que minimicen el error. Estas herramientas matemáticas forman la base de la Máquina de Aprendizaje, permitiéndonos construir modelos que puedan aprender de datos y hacer predicciones precisas.';

const REAL_EN = 'Machine Learning relies on three key mathematical areas: probability theory, linear algebra, and calculus. Probability theory helps us understand uncertainty and make predictions based on data. For example, if we want to predict the weather, we use probability to determine the likelihood of rain based on historical data. Linear algebra is essential for handling and manipulating large datasets efficiently. It allows us to represent data in matrices and vectors, which makes operations like transformations and projections much easier. Calculus, particularly derivatives and integrals, is used to optimize models by finding the best parameters that minimize error. These mathematical tools form the backbone of Machine Learning, enabling us to build models that can learn from data and make accurate predictions.';

for (const [lang, text] of [['fr', REAL_FR], ['de', REAL_DE], ['es', REAL_ES]]) {
  test(`regression: real full-length ${lang} translation passes`, () => {
    const r = validateTranslation(text, lang);
    assert.equal(r.ok, true, `expected pass, got ${JSON.stringify(r)}`);
  });
}

for (const lang of ['fr', 'de', 'es']) {
  test(`regression: real full-length English paragraph rejected as ${lang}`, () => {
    const r = validateTranslation(REAL_EN, lang);
    assert.equal(r.ok, false, `expected rejection, got ${JSON.stringify(r)}`);
  });
}
