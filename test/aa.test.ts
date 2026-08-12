import { describe, expect, it } from "vitest";
import {
  costForRanking,
  decryptManifestPayload,
  extractManifestsFromHtml,
  isScoreable,
  parseEmbeddedHtmlToResults,
  parseHtmlToResults,
} from "../src/lib/aa";

/** Sync wrapper matching the pre-manifest API used by most unit tests. */
function parseHtml(html: string) {
  return parseEmbeddedHtmlToResults(html);
}

/**
 * Encode a JSON string the way Next.js flight payloads embed it in HTML:
 * inside a JS string literal where `\` becomes `\\` and `"` becomes `\"`.
 */
function rscEscape(json: string): string {
  return json.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** A minimal models page carrying the payload as an RSC flight chunk. */
function flightHtml(payloadJson: string): string {
  return `<!doctype html><html><head><title>Models</title></head><body>
<div id="app">irrelevant [brackets] and "quotes"</div>
<script>self.__next_f.push([1,"${rscEscape(payloadJson)}"])</script>
</body></html>`;
}

const FULL_MODEL = {
  id: "gold-id",
  slug: "gold-1",
  name: 'Tricky "[2]" Gold',
  short_name: "Gold",
  model_creators: { name: "Aurum", slug: "aurum" },
  release_date: "2026-01-15",
  knowledge_cutoff_date: "2025-10-01",
  intelligence_index: 62.5,
  agentic_index: 49.7,
  mmmu_pro: 0.71,
  intelligence_index_cost: {
    total_cost: 845.2,
    input_cost: 200.5,
    output_cost: 400,
    reasoning_cost: 144.7,
    answer_cost: 100,
  },
  intelligence_index_cost_per_task: {
    cost: {
      total_cost: 0.8452,
      input_cost: 0.2005,
      output_cost: 0.4,
      reasoning_cost: 0.1447,
      answer_cost: 0.1,
    },
  },
  intelligence_index_time_per_task: 123.45,
  price_1m_input_tokens: 2.5,
  price_1m_output_tokens: 10,
  inference_parameters_active_billions: 30,
  is_open_weights: false,
  reasoning_model: true,
};

const BUDGET_MODEL = {
  id: "budget-id",
  slug: "budget-1",
  name: "Budget One",
  intelligence_index: 41,
  intelligence_index_cost: { total_cost: 12.5 },
  intelligenceIndexCostPerTask: { cost: { total: 0.0125 } },
  intelligenceIndexTimePerTask: 45,
};

describe("parseHtmlToResults", () => {
  it("extracts and normalizes a snake_case defaultData payload from flight HTML", () => {
    const html = flightHtml(
      JSON.stringify({ requestId: "abc", defaultData: [FULL_MODEL, BUDGET_MODEL], tail: true }),
    );
    const results = parseHtml(html);

    expect(results).toHaveLength(2);
    const gold = results[0];
    expect(gold.modelKey).toBe("gold-1");
    expect(gold.sourceId).toBe("gold-id");
    expect(gold.name).toBe('Tricky "[2]" Gold');
    expect(gold.shortName).toBe("Gold");
    expect(gold.creatorName).toBe("Aurum");
    expect(gold.creatorSlug).toBe("aurum");
    expect(gold.releaseDate).toBe("2026-01-15");
    expect(gold.cutoffDate).toBe("2025-10-01");
    expect(gold.totalCost).toBe(845.2);
    expect(gold.inputCost).toBe(200.5);
    expect(gold.outputCost).toBe(400);
    expect(gold.reasoningCost).toBe(144.7);
    expect(gold.answerCost).toBe(100);
    expect(gold.costPerTask).toBe(0.8452);
    expect(gold.inputCostPerTask).toBe(0.2005);
    expect(gold.outputCostPerTask).toBe(0.4);
    expect(gold.reasoningCostPerTask).toBe(0.1447);
    expect(gold.answerCostPerTask).toBe(0.1);
    expect(gold.timePerTask).toBe(123.45);
    expect(gold.intelligence).toBe(62.5);
    expect(gold.agentic).toBe(49.7);
    expect(gold.mmmu).toBe(0.71);
    expect(gold.priceInput1m).toBe(2.5);
    expect(gold.priceOutput1m).toBe(10);
    expect(gold.activeParams).toBe(30);
    expect(gold.isOpenWeights).toBe(false);
    expect(gold.isReasoning).toBe(true);
    expect(JSON.parse(gold.rawResultJson).name).toBe('Tricky "[2]" Gold');
  });

  it("normalizes camelCase payload field spellings", () => {
    const html = flightHtml(
      JSON.stringify({
        defaultData: [
          {
            id: "camel-id",
            slug: "camel-1",
            name: "Camel",
            shortName: "Cml",
            creator: { name: "Dromedary", slug: "dromedary" },
            releaseDate: "2025-12-01",
            knowledgeCutoffDate: "2025-09-01",
            intelligenceIndex: 55,
            agenticIndex: 47,
            mmmuPro: 0.6,
            intelligenceIndexCost: { totalCost: 99.9, inputCost: 10 },
            intelligenceIndexCostPerTask: {
              cost: { total: 0.0999, input: 0.01 },
            },
            intelligenceIndexTimePerTask: 12,
            priceInput1m: 1.25,
            priceOutput1m: 5,
            activeParams: 12,
            isOpenWeights: true,
            isReasoning: false,
          },
        ],
      }),
    );
    const [camel] = parseHtml(html);

    expect(camel.shortName).toBe("Cml");
    expect(camel.creatorName).toBe("Dromedary");
    expect(camel.releaseDate).toBe("2025-12-01");
    expect(camel.cutoffDate).toBe("2025-09-01");
    expect(camel.intelligence).toBe(55);
    expect(camel.agentic).toBe(47);
    expect(camel.mmmu).toBe(0.6);
    expect(camel.totalCost).toBe(99.9);
    expect(camel.inputCost).toBe(10);
    expect(camel.costPerTask).toBe(0.0999);
    expect(camel.inputCostPerTask).toBe(0.01);
    expect(camel.timePerTask).toBe(12);
    expect(camel.priceInput1m).toBe(1.25);
    expect(camel.activeParams).toBe(12);
    expect(camel.isOpenWeights).toBe(true);
    expect(camel.isReasoning).toBe(false);
  });

  it('treats "$undefined" and "$NaN" sentinel values as null', () => {
    const model = {
      ...BUDGET_MODEL,
      agentic_index: "$undefined",
      mmmu_pro: "$NaN",
      release_date: "$undefined",
    };
    // JSON.stringify keeps the sentinels as plain strings, matching the page.
    const html = flightHtml(JSON.stringify({ defaultData: [model] }));
    const [budget] = parseHtml(html);

    expect(budget.agentic).toBeNull();
    expect(budget.mmmu).toBeNull();
    expect(budget.releaseDate).toBeNull();
    expect(budget.totalCost).toBe(12.5);
    expect(budget.costPerTask).toBe(0.0125);
  });

  it("falls back to the models array when defaultData is absent", () => {
    const html = flightHtml(JSON.stringify({ models: [BUDGET_MODEL] }));
    const results = parseHtml(html);

    expect(results).toHaveLength(1);
    expect(results[0].modelKey).toBe("budget-1");
  });

  it("prefers a scoreless models array over a scoreless defaultData array", () => {
    const html = flightHtml(
      JSON.stringify({
        defaultData: [{ id: "stub", slug: "stub", name: "Stub" }],
        models: [BUDGET_MODEL],
      }),
    );
    const results = parseHtml(html);

    expect(results.map((result) => result.modelKey)).toEqual(["budget-1"]);
  });

  it("parses an unescaped plain-JSON payload marker", () => {
    const html = `<script type="application/json">${JSON.stringify({
      defaultData: [BUDGET_MODEL],
    })}</script>`;
    const results = parseHtml(html);

    expect(results).toHaveLength(1);
    expect(results[0].totalCost).toBe(12.5);
  });

  it("derives modelKey from slug, then source id, then a slugified name", () => {
    const html = flightHtml(
      JSON.stringify({
        defaultData: [
          { ...BUDGET_MODEL, id: "id-a", slug: "slug-a", name: "A" },
          { ...BUDGET_MODEL, id: "id-b", slug: null, name: "B" },
          { ...BUDGET_MODEL, id: null, slug: null, name: "Hello World 2.0!" },
        ],
      }),
    );
    const keys = parseHtml(html).map((result) => result.modelKey);

    expect(keys).toEqual(["slug-a", "id-b", "hello-world-2-0"]);
  });

  it("drops entries without any usable name or key", () => {
    const html = flightHtml(
      JSON.stringify({ defaultData: [BUDGET_MODEL, { intelligence_index: 10 }] }),
    );

    expect(parseHtml(html)).toHaveLength(1);
  });

  it("throws when the HTML has no models payload at all", () => {
    expect(() => parseHtml("<html><body>maintenance page</body></html>")).toThrow(
      /Could not find Artificial Analysis models payload/,
    );
  });

  it("throws when models parse but none carry score/cost fields", () => {
    const html = flightHtml(JSON.stringify({ defaultData: [{ id: "x", slug: "x", name: "X" }] }));

    expect(() => parseHtml(html)).toThrow(/did not include score\/cost fields/);
  });

  it("extracts score-bearing initialModels when defaultData is absent", () => {
    const html = flightHtml(
      JSON.stringify({
        initialModels: [
          {
            id: "init-id",
            slug: "init-1",
            name: "Init One",
            intelligenceIndex: 41,
            intelligenceIndexCost: { total: 12.5, input: 2, output: 10, reasoning: 1, answer: 1 },
            intelligenceIndexCostPerTask: {
              cost: {
                total: 0.0125,
                input: 0.002,
                output: 0.01,
                reasoning: 0.0005,
                answer: 0.0005,
              },
            },
            intelligenceIndexTimePerTask: 45,
          },
        ],
      }),
    );
    const [budget] = parseHtml(html);

    expect(budget.modelKey).toBe("init-1");
    expect(budget.totalCost).toBe(12.5);
    expect(budget.inputCost).toBe(2);
    expect(budget.costPerTask).toBe(0.0125);
    expect(budget.timePerTask).toBe(45);
  });

  it("prefers scoreable initialModels over a scoreless models index", () => {
    const html = flightHtml(
      JSON.stringify({
        models: [{ id: "stub", slug: "stub", name: "Stub", isReasoning: true }],
        initialModels: [BUDGET_MODEL],
      }),
    );
    const results = parseHtml(html);

    expect(results.map((result) => result.modelKey)).toEqual(["budget-1"]);
  });
});

describe("encrypted manifests", () => {
  const MANIFEST_KEY = "e656395420364e21be7e52f6b3b6adb685471d4885084dbf75e2e5712956c4d1";

  async function encryptManifest(payload: unknown, keyHex = MANIFEST_KEY): Promise<ArrayBuffer> {
    const keyBytes = hexToBytes(keyHex);
    const keyBuffer = toArrayBuffer(keyBytes);
    const iv = new Uint8Array(await crypto.subtle.digest("SHA-256", keyBuffer)).slice(0, 12);
    const cryptoKey = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-GCM" }, false, [
      "encrypt",
    ]);
    const json = new TextEncoder().encode(JSON.stringify(payload));
    const gzipped = await gzipBytes(json);
    return crypto.subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      cryptoKey,
      toArrayBuffer(gzipped),
    );
  }

  it("extracts unique manifest path/key pairs from flight HTML", () => {
    const html = flightHtml(
      JSON.stringify({
        children: [
          {
            manifest: {
              path: "/data/models.txt",
              key: MANIFEST_KEY,
            },
          },
          {
            // duplicate should be ignored
            manifest: {
              path: "/data/models.txt",
              key: MANIFEST_KEY,
            },
          },
          {
            manifest: {
              path: "/data/hosts.txt",
              key: "448ac6a3fb7f389e3d98f578e9ddcab0f51a24e839ee5671de0645747367e9d9",
            },
          },
        ],
      }),
    );

    expect(extractManifestsFromHtml(html)).toEqual([
      { path: "/data/models.txt", key: MANIFEST_KEY },
      {
        path: "/data/hosts.txt",
        key: "448ac6a3fb7f389e3d98f578e9ddcab0f51a24e839ee5671de0645747367e9d9",
      },
    ]);
  });

  it("decrypts an AES-GCM + gzip manifest payload", async () => {
    const payload = {
      models: [
        {
          id: "m1",
          slug: "manifest-1",
          name: "Manifest One",
          intelligenceIndex: 40,
          intelligenceIndexCost: { total: 20 },
          intelligenceIndexCostPerTask: { cost: { total: 0.02 } },
          intelligenceIndexTimePerTask: 9,
          price1mInputTokens: 1,
          price1mOutputTokens: 2,
          creator: { name: "Acme", slug: "acme" },
        },
      ],
    };
    const encrypted = await encryptManifest(payload);
    const decrypted = await decryptManifestPayload(encrypted, MANIFEST_KEY);

    expect(decrypted).toEqual(payload);
  });

  it("loads scoreable models from encrypted manifests when HTML only has a slim index", async () => {
    const fullModels = {
      models: [
        {
          id: "m1",
          slug: "manifest-1",
          name: "Manifest One",
          shortName: "M1",
          intelligenceIndex: 40,
          agenticIndex: 20,
          mmmuPro: 0.5,
          intelligenceIndexCost: {
            total: 20,
            input: 5,
            output: 15,
            reasoning: 10,
            answer: 5,
          },
          intelligenceIndexCostPerTask: {
            cost: { total: 0.02, input: 0.005, output: 0.015, reasoning: 0.01, answer: 0.005 },
          },
          intelligenceIndexTimePerTask: 9.5,
          price1mInputTokens: 1.1,
          price1mOutputTokens: 2.2,
          inferenceParametersActiveBillions: 7,
          isOpenWeights: true,
          isReasoning: true,
          creator: { name: "Acme", slug: "acme" },
          releaseDate: "2026-06-01",
          knowledgeCutoffDate: "2026-01-01",
        },
      ],
    };
    const encrypted = await encryptManifest(fullModels);
    const html = flightHtml(
      JSON.stringify({
        models: [{ id: "stub", slug: "stub", name: "Stub Index" }],
        manifest: { path: "/data/models.txt", key: MANIFEST_KEY },
      }),
    );

    const results = await parseHtmlToResults(html, {
      resolveUrl: (path) => `https://example.test${path}`,
      fetchBinary: async (url) => {
        expect(url).toBe("https://example.test/data/models.txt");
        return encrypted;
      },
    });

    expect(results).toHaveLength(1);
    const model = results[0];
    expect(model.modelKey).toBe("manifest-1");
    expect(model.intelligence).toBe(40);
    expect(model.agentic).toBe(20);
    expect(model.mmmu).toBe(0.5);
    expect(model.totalCost).toBe(20);
    expect(model.inputCost).toBe(5);
    expect(model.outputCost).toBe(15);
    expect(model.costPerTask).toBe(0.02);
    expect(model.timePerTask).toBe(9.5);
    expect(model.priceInput1m).toBe(1.1);
    expect(model.priceOutput1m).toBe(2.2);
    expect(model.activeParams).toBe(7);
    expect(model.creatorName).toBe("Acme");
    expect(model.isOpenWeights).toBe(true);
    expect(model.isReasoning).toBe(true);
  });

  it("throws instead of falling back to the embedded preview when no manifest loads", async () => {
    const html = flightHtml(
      JSON.stringify({
        initialModels: [BUDGET_MODEL],
        manifest: { path: "/data/models.txt", key: MANIFEST_KEY },
      }),
    );

    await expect(
      parseHtmlToResults(html, {
        resolveUrl: (path) => `https://example.test${path}`,
        fetchBinary: async () => encryptManifest({ models: [] }, `f${MANIFEST_KEY.slice(1)}`),
      }),
    ).rejects.toThrow(/Could not load any Artificial Analysis manifest/);
  });
});

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(toArrayBuffer(bytes)).body?.pipeThrough(
    new CompressionStream("gzip"),
  );
  if (!stream) throw new Error("CompressionStream unavailable");
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("isScoreable", () => {
  const base = {
    modelKey: "m",
    sourceId: null,
    slug: null,
    name: "M",
    shortName: null,
    creatorName: null,
    creatorSlug: null,
    releaseDate: null,
    cutoffDate: null,
    totalCost: 10,
    inputCost: null,
    outputCost: null,
    reasoningCost: null,
    answerCost: null,
    costPerTask: null,
    inputCostPerTask: null,
    outputCostPerTask: null,
    reasoningCostPerTask: null,
    answerCostPerTask: null,
    timePerTask: null,
    intelligence: 50,
    agentic: null,
    mmmu: null,
    priceInput1m: null,
    priceOutput1m: null,
    activeParams: null,
    isOpenWeights: null,
    isReasoning: null,
    rawResultJson: "{}",
  };

  it("requires a positive ranking cost plus intelligence", () => {
    expect(isScoreable(base)).toBe(true);
    expect(costForRanking({ ...base, costPerTask: 0.25 })).toBe(0.25);
    expect(isScoreable({ ...base, totalCost: null, costPerTask: 0.25 })).toBe(true);
    expect(isScoreable({ ...base, totalCost: 10, costPerTask: 0 })).toBe(false);
    expect(isScoreable({ ...base, totalCost: 0 })).toBe(false);
    expect(isScoreable({ ...base, totalCost: null })).toBe(false);
    expect(isScoreable({ ...base, intelligence: null })).toBe(false);
    expect(isScoreable({ ...base, agentic: null, mmmu: null })).toBe(true);
  });
});
