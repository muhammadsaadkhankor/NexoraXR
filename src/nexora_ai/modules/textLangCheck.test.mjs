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

// ---- foreign-script zero tolerance (observed CJK leak in ar output) ----

test('ar with CJK tail rejected', () => {
  const t = 'التعلم الآلي هو مجال دراسة يتيح للمستعرضات الحوسبة أن تتعلم دون الحاجة إلى البرمجة الصريحة، كما تعريف أرثر سامويل عام 1959.将在下面继续您的翻译。';
  const r = validateTranslation(t, 'ar');
  assert.equal(r.ok, false);
  assert.match(r.reason, /script:cjk/);
});

test('fr with CJK meta rejected', () => {
  const r = validateTranslation('Voici un exemple. 示例结束，这是阿拉伯语翻译的部分', 'fr');
  assert.equal(r.ok, false);
});

test('zh with Arabic script rejected', () => {
  const r = validateTranslation('机器学习是一个研究领域。هذا نص عربي', 'zh');
  assert.equal(r.ok, false);
  assert.match(r.reason, /script:arabic/);
});

// ---- per-language script audit (observed: Cyrillic/Thai inside Arabic) ----

test('ar with Cyrillic letters rejected', () => {
  const r = validateTranslation('في مجال الهندسة الكهربائية يتم استخدام التعلم الآلي للتنبؤ ب нагрузات الطاقة بشكل دقيق وفعال', 'ar');
  assert.equal(r.ok, false);
  assert.match(r.reason, /unexpected-script:cyrillic/);
});

test('ar with Thai letters rejected', () => {
  const r = validateTranslation('فهم هذه الاستخدامات سيساعدك فيเข้า الفهم لأهمية تعلم الآلات', 'ar');
  assert.equal(r.ok, false);
  assert.match(r.reason, /unexpected-script:thai/);
});

test('replacement char rejected', () => {
  const r = validateTranslation('التعلم الآلي هو مجال دراسة يتيح للحواسيب التعل�م بسهولة', 'ar');
  assert.equal(r.ok, false);
  assert.match(r.reason, /invalid-glyph/);
});

// ---- foreign-word check ----

const AR_SRC = 'Machine Learning is a field of study that enables computers to learn without being explicitly programmed, as defined by Arthur Samuel.';

test('ar with Latin word absent from source rejected', () => {
  const r = validateTranslation('التعلم الآلي هو مجال دراسة و fundamentos الرياضيات القائمة عليه', 'ar', { source: AR_SRC });
  assert.equal(r.ok, false);
  assert.match(r.reason, /foreign-word:fundamentos/);
});

test('ar with Latin technical term present in source passes script/word checks', () => {
  // enough Arabic to clear the fraction, latin only from the source
  const t = 'التعلم الآلي هو مجال دراسة يتيح للحواسيب التعلم دون البرمجة الصريحة كما عرفه Arthur Samuel وهو مفهوم أساسي في الحوسبة الحديثة';
  const r = validateTranslation(t, 'ar', { source: AR_SRC });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('zh with Latin word absent from source rejected', () => {
  const r = validateTranslation('机器学习是推动marketing效果的关键应用，它帮助公司理解用户行为', 'zh', { source: 'Machine learning models analyze user behavior to deliver targeted ads.' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /foreign-word/);
});

test('zh keeps ALL-CAPS acronyms and source terms', () => {
  const r = validateTranslation('机器学习让计算机能够在不被明确编程的情况下进行学习，ML算法从数据中学习模式，这使它们能够不断改进并适应新的任务和数据集', 'zh', { source: 'Machine learning enables computers to learn. ML algorithms learn patterns.' });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('de with Spanish function word rejected', () => {
  const t = 'Maschinelles Lernen basiert auf drei mathematischen Bereichen. Esto permite para Vorhersagen basierend auf Daten zu treffen und Modelle zu verbessern.';
  const r = validateTranslation(t, 'de', { source: 'Machine learning relies on three mathematical areas.' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /foreign-word/);
});

test('fr with ñ (Spanish diacritic) rejected', () => {
  const r = validateTranslation("L'apprentissage automatique es una técnica que permite a los niños aprender formas y mejorar leurs performances au fil du temps", 'fr', { source: 'Machine learning is a technique.' });
  assert.equal(r.ok, false);
});

// ---- leaked instruction/meta text ----

test('fr with English meta phrase rejected when source lacks it', () => {
  const t = 'La régression est une technique supervisée. Below is the translation of the text into French for this lecture segment.';
  const r = validateTranslation(t, 'fr', { source: 'Regression is a supervised technique.' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /leaked-meta|foreign-word/);
});

test('word "translation" allowed when the source discusses translation', () => {
  const t = "Cela inclut des tâches comme la reconnaissance d'images et la traduction (language translation), très utilisées en pratique.";
  const r = validateTranslation(t, 'fr', { source: 'This includes tasks like image recognition and language translation.' });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('zh with Chinese meta phrase rejected when source lacks it', () => {
  const t = '机器学习是一个研究领域。让我继续翻译这段话';
  const r = validateTranslation(t, 'zh', { source: 'Machine learning is a field of study.' });
  assert.equal(r.ok, false);
});

// ---- meta check: normal vocabulary passes, only real meta phrases block ----

test('zh normal words 以下/继续/示例 are not meta', () => {
  const t = '以下三个原因解释了为什么机器学习有效，我们将继续讨论更多示例。';
  const r = validateTranslation(t, 'zh', { source: 'Three reasons explain why machine learning works.' });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('zh real meta phrase 以下是翻译 rejected', () => {
  const t = '以下是翻译：机器学习是一个使计算机无需明确编程即可学习的研究领域。';
  const r = validateTranslation(t, 'zh', { source: 'Machine learning is a field of study.' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /leaked-meta/);
});

test('zh real meta phrase 翻译如下 rejected', () => {
  const t = '翻译如下：机器学习是一个研究领域，它使计算机能够学习。';
  const r = validateTranslation(t, 'zh', { source: 'Machine learning is a field of study.' });
  assert.equal(r.ok, false);
});

// ---- technical terms in Latin script inside ar/zh are allowed ----

test('zh keeps Latin technical terms absent from source (machine, ML)', () => {
  const t = '在电气工程领域，ML被用于负荷预测，即利用machine learning和时间序列神经网络基于历史数据预测能源需求。';
  const r = validateTranslation(t, 'zh', {
    source: 'In electrical engineering, ML is used for load prediction based on historical data.' });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('zh keeps product names absent from source (Siri, Alexa)', () => {
  const t = '智能助手如Siri和Alexa使用机器学习来理解语音命令，这是最常见的应用之一。';
  const r = validateTranslation(t, 'zh', { source: 'Smart assistants use ML to understand voice commands.' });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('zh still rejects genuine foreign bleed', () => {
  const t = '机器学习是推动marketing效果的关键应用，它帮助公司理解用户行为';
  const r = validateTranslation(t, 'zh', { source: 'Machine learning models analyze user behavior.' });
  assert.equal(r.ok, false);
});
