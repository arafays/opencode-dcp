import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildStatsSnapshot,
  estimateTokens,
  measureMessagesChars,
  resolveTuiStateDirs,
  writeTuiStats,
  type CompressionEventRecord,
  type TuiStatsSnapshot,
} from "../lib/tui-bridge";
import { sessionTotals } from "../lib/transform";
import { createSessionState } from "../lib/state/types";

function tempRoot(): string {
  return path.join(
    os.tmpdir(),
    `dcp-tui-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
}

test("estimateTokens approximates chars/4", () => {
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(8), 2);
  assert.equal(estimateTokens(3), 1);
});

test("measureMessagesChars sums text sizes across message shapes", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "abcd" }] },
    { role: "assistant", content: [{ type: "text", text: "abcdef" }] },
  ];
  // "abcd"=4 + role/type keys + "abcdef"=6 plus structural strings.
  const chars = measureMessagesChars(messages);
  assert.ok(chars >= 10);
  assert.equal(measureMessagesChars(undefined), 0);
  assert.equal(measureMessagesChars([]), 0);
});

test("buildStatsSnapshot records dispatch deltas and keeps other sessions", () => {
  const previous = {
    version: 1 as const,
    generatedAt: 1,
    sessions: {
      other: {
        sessionId: "other",
        updatedAt: 5,
        totals: {
          dispatches: 1,
          compressRuns: 0,
          blocksActive: 0,
          blocksTotal: 0,
          blockTokensCovered: 0,
          blockTokensSummaries: 0,
          prunedTokensTotal: 0,
          messagesCompressedActive: 0,
        },
        recentCompressions: [],
      },
    },
  };

  const snapshot = buildStatsSnapshot(previous as TuiStatsSnapshot, {
    sessionId: "s1",
    model: "p/m",
    dispatch: { at: 10, model: "p/m", messagesIn: 4, tokensBefore: 1000, tokensAfter: 600 },
    totals: {
      dispatches: 1,
      compressRuns: 0,
      blocksActive: 0,
      blocksTotal: 0,
      blockTokensCovered: 0,
      blockTokensSummaries: 0,
      prunedTokensTotal: 0,
      messagesCompressedActive: 0,
    },
  });

  assert.ok(snapshot.sessions.other, "other session must survive the merge");
  const entry = snapshot.sessions.s1;
  assert.ok(entry);
  assert.equal(entry.lastDispatch?.savedTokens, 400);
  assert.equal(entry.lastDispatch?.savedPercent, 40);
  assert.equal(snapshot.sessions.s1?.model, "p/m");
});

test("buildStatsSnapshot reports negative percent when boundary-ID overhead exceeds savings", () => {
  // Early-session dispatches can grow: injected <dcp-message-id> tags cost
  // tokens before the first compression pays them back. savedTokens clamps at
  // zero, but savedPercent stays signed so the TUI can render "+N%" overhead.
  const snapshot = buildStatsSnapshot(undefined, {
    sessionId: "s1",
    dispatch: { at: 10, messagesIn: 4, tokensBefore: 78200, tokensAfter: 78900 },
    totals: {
      dispatches: 1,
      compressRuns: 0,
      blocksActive: 0,
      blocksTotal: 0,
      blockTokensCovered: 0,
      blockTokensSummaries: 0,
      prunedTokensTotal: 0,
      messagesCompressedActive: 0,
    },
  });
  const entry = snapshot.sessions.s1;
  assert.ok(entry?.lastDispatch);
  assert.equal(entry.lastDispatch.savedTokens, 0);
  assert.equal(entry.lastDispatch.savedPercent, -1);
});

test("buildStatsSnapshot caps recent compressions at 10", () => {
  let snapshot: TuiStatsSnapshot | undefined;
  for (let index = 0; index < 14; index++) {
    snapshot = buildStatsSnapshot(snapshot, {
      sessionId: "s",
      compression: {
        at: index,
        blockId: index,
        topic: `t${index}`,
        ranges: 1,
        messagesCovered: 2,
        toolsCovered: 3,
        tokensBefore: 100,
        tokensAfter: 20,
        tokensSaved: 80,
      },
      totals: {
        dispatches: index,
        compressRuns: index,
        blocksActive: 1,
        blocksTotal: index,
        blockTokensCovered: 100,
        blockTokensSummaries: 20,
        prunedTokensTotal: 0,
        messagesCompressedActive: 2,
      },
    });
  }
  const list = snapshot?.sessions.s?.recentCompressions ?? [];
  assert.equal(list.length, 10);
  assert.equal(list.at(-1)?.topic, "t13");
  assert.equal(list.at(-1)?.toolsCovered, 3);
});

test("buildStatsSnapshot prefers store-provided history over the in-memory prior", () => {
  // A plugin reload (dist rebuild, restart) resets the in-memory snapshot;
  // the next publish must not rewrite the TUI file without the history the
  // persisted store still owns.
  const stale: CompressionEventRecord = {
    at: 1,
    blockId: 1,
    topic: "stale",
    ranges: 1,
    messagesCovered: 2,
    tokensBefore: 100,
    tokensAfter: 20,
    tokensSaved: 80,
  };
  const fresh: CompressionEventRecord = {
    at: 2,
    blockId: 2,
    topic: "fresh",
    ranges: 1,
    messagesCovered: 3,
    tokensBefore: 200,
    tokensAfter: 30,
    tokensSaved: 170,
  };
  const previous: TuiStatsSnapshot = {
    version: 1,
    generatedAt: 1,
    sessions: {
      s1: {
        sessionId: "s1",
        updatedAt: 1,
        totals: {
          dispatches: 1,
          compressRuns: 1,
          blocksActive: 1,
          blocksTotal: 1,
          blockTokensCovered: 100,
          blockTokensSummaries: 20,
          prunedTokensTotal: 0,
          messagesCompressedActive: 2,
        },
        recentCompressions: [stale],
      },
    },
  };

  const snapshot = buildStatsSnapshot(previous, {
    sessionId: "s1",
    compression: fresh,
    recentCompressions: [fresh],
    totals: {
      dispatches: 2,
      compressRuns: 2,
      blocksActive: 1,
      blocksTotal: 2,
      blockTokensCovered: 200,
      blockTokensSummaries: 30,
      prunedTokensTotal: 0,
      messagesCompressedActive: 3,
    },
  });

  const list = snapshot.sessions.s1?.recentCompressions ?? [];
  assert.equal(list.length, 1, "record already in the provided history must not duplicate");
  assert.equal(list[0]?.topic, "fresh");
});

test("buildStatsSnapshot appends a compression missing from the provided history", () => {
  const fresh: CompressionEventRecord = {
    at: 2,
    blockId: 2,
    topic: "fresh",
    ranges: 1,
    messagesCovered: 3,
    tokensBefore: 200,
    tokensAfter: 30,
    tokensSaved: 170,
  };
  const snapshot = buildStatsSnapshot(undefined, {
    sessionId: "s1",
    compression: fresh,
    recentCompressions: [],
    totals: {
      dispatches: 2,
      compressRuns: 2,
      blocksActive: 1,
      blocksTotal: 2,
      blockTokensCovered: 200,
      blockTokensSummaries: 30,
      prunedTokensTotal: 0,
      messagesCompressedActive: 3,
    },
  });
  const list = snapshot.sessions.s1?.recentCompressions ?? [];
  assert.equal(list.length, 1);
  assert.equal(list[0]?.topic, "fresh");
});

test("sessionTotals summarizes active blocks and pruning", () => {
  const state = createSessionState("s");
  state.blocks["1"] = {
    blockId: 1,
    active: true,
    topic: "a",
    summary: "sum",
    summaryTokens: 20,
    compressedTokens: 100,
    coveredKeys: ["k1", "k2"],
    coveredToolIds: [],
    anchorKey: "tail",
    consumedBlockIds: [],
    createdAt: 0,
  };
  state.activeBlockIds = [1];
  state.stats.totalPrunedTokens = 55;
  const totals = sessionTotals(state);
  assert.equal(totals.blocksActive, 1);
  assert.equal(totals.blockTokensCovered, 100);
  assert.equal(totals.blockTokensSummaries, 20);
  assert.equal(totals.messagesCompressedActive, 2);
  assert.equal(totals.prunedTokensTotal, 55);
});

test("writeTuiStats writes into every existing channel tui dir atomically", () => {
  const root = tempRoot();
  try {
    mkdirSync(path.join(root, "opencode", "beta", "tui"), { recursive: true });
    mkdirSync(path.join(root, "opencode", "local", "tui"), { recursive: true });
    writeTuiStats({ version: 1, generatedAt: 7, sessions: {} }, root);
    for (const channel of ["beta", "local"]) {
      const file = path.join(
        root,
        "opencode",
        channel,
        "tui",
        "plugin.opencode.dcp.tui.stats.json",
      );
      const parsed = JSON.parse(readFileSync(file, "utf8")) as TuiStatsSnapshot;
      assert.equal(parsed.version, 1);
      assert.equal(parsed.generatedAt, 7);
    }
    // No tmp leftovers.
    const entries = readdirSync(path.join(root, "opencode", "beta", "tui"));
    assert.equal(entries.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveTuiStateDirs creates missing tui dirs and tolerates absent roots", () => {
  const root = tempRoot();
  try {
    mkdirSync(path.join(root, "opencode", "beta"), { recursive: true });
    const dirs = resolveTuiStateDirs(root);
    assert.deepEqual(dirs, [path.join(root, "opencode", "beta", "tui")]);
    assert.deepEqual(resolveTuiStateDirs(path.join(root, "does-not-exist")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- media-aware measurement -------------------------------------------------
//
// Production evidence (session ses_f1263c7d3ffeEhiJ39nrwHNlPd): 14,368,764
// base64 characters across 26 images. One dispatch carried a single
// 4,028,684-char image that the old estimate priced at 1,007,200 "tokens"
// (96% of a 1,048,576-token window) while the provider reported 119,300
// tokens (11%) of real occupancy, driving a runaway prune loop.

/** The `Tool.FileContent` shape the Read/MCP/codemode tools emit for images. */
function fileContent(dataUrl: string): unknown {
  return [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: "call_1",
          name: "read",
          result: {
            type: "content",
            value: [
              { type: "text", text: "Image read successfully" },
              { type: "file", uri: dataUrl, mime: "image/png", name: "shot.png" },
            ],
          },
        },
      ],
    },
  ];
}

function tokensFor(messages: unknown): number {
  return estimateTokens(measureMessagesChars(messages));
}

test("a 4MB inline image is charged a flat allowance, not chars/4", () => {
  // The exact production size, and the shape it arrived in.
  const production = `data:image/png;base64,${"A".repeat(4_028_662)}`;
  assert.equal(production.length, 4_028_684);

  // 1,600 tokens = Anthropic's (1568*1568)/750 for their documented maximum
  // image, rounded up. The band absorbs the ~30 structural characters of the
  // surrounding tool-result wrapper.
  const tokens = tokensFor(fileContent(production));
  assert.ok(tokens >= 1_600, `expected at least the 1600-token image allowance, got ${tokens}`);
  assert.ok(tokens < 1_700, `expected far below 1,000,000, got ${tokens}`);
  assert.ok(tokens < 1_048_576 / 100, "must not read as a percent-scale share of a 1M window");

  // Payload size is irrelevant: the small and large images price identically.
  const small = tokensFor(fileContent("data:image/png;base64,AAAA"));
  assert.equal(tokens, small);

  // For contrast, the pre-fix behaviour: 4,028,684 chars / 4.
  assert.equal(Math.round(production.length / 4), 1_007_171);
});

test("the same image is charged once through every wire shape that carries it", () => {
  const payload = "A".repeat(4_000_000);
  const base64DataUrl = `data:image/png;base64,${payload}`;
  const rawBase64 = { type: "base64", data: payload, mediaType: "image/png" };

  // Tool.FileContent -> data URI under `uri` (Read/MCP/codemode tool output).
  const viaFileContent = tokensFor(fileContent(base64DataUrl));
  // MediaPart -> Media.Asset -> Media.Source (user file attachments), both as
  // the `Asset` class instance's own-field shape and the JSON-encoded form.
  const viaSource = tokensFor([
    { role: "user", content: [{ type: "media", media: { source: rawBase64 }, filename: "a.png" }] },
  ]);
  // Flattened `{ type, mediaType, data }` form modelled by lib/types.ts.
  const viaFlattened = tokensFor([
    { role: "user", content: [{ type: "media", mediaType: "image/png", data: payload }] },
  ]);
  // Raw base64 with no media wrapper at all (no `type`, no data URI).
  const viaBareString = tokensFor([
    { role: "user", content: [{ type: "text", text: payload }] },
  ]);
  // Media.Source bytes variant: a Uint8Array must not be walked per byte.
  const viaBytes = tokensFor([
    {
      role: "user",
      content: [
        {
          type: "media",
          media: {
            source: { type: "bytes", data: new Uint8Array(4_000_000), mediaType: "image/png" },
          },
        },
      ],
    },
  ]);

  for (const [label, tokens] of Object.entries({
    viaFileContent,
    viaSource,
    viaFlattened,
    viaBytes,
  })) {
    assert.ok(
      tokens >= 1_600 && tokens < 1_750,
      `${label} should price one image at ~1600 tokens, got ${tokens}`,
    );
  }
  // A bare base64 string has no media marker, so it stays text. This is the
  // documented boundary: only a data URI or a media part is re-priced.
  assert.ok(viaBareString > 1_000_000, `bare base64 is text, got ${viaBareString}`);
});

test("text alongside a large image still dominates and stays at 4 chars/token", () => {
  const image = `data:image/png;base64,${"A".repeat(4_028_662)}`;
  const TEXT_CHARS = 40_000; // 10,000 tokens
  const body = "x".repeat(TEXT_CHARS);

  const textOnly = tokensFor([{ role: "user", content: [{ type: "text", text: body }] }]);
  const withImage = tokensFor([
    { role: "user", content: [{ type: "text", text: body }, { type: "text", text: image }] },
  ]);

  // The text is priced at exactly 4 chars/token, wrapper included.
  assert.ok(textOnly >= 10_000 && textOnly < 10_100, `got ${textOnly}`);
  // The image adds its flat allowance and essentially nothing else: 4M payload
  // chars cannot outweigh 10k tokens of prose. The band's slack covers the
  // `text` key and discriminator of the second part plus `estimateTokens`
  // rounding.
  assert.ok(withImage - textOnly >= 1_600 && withImage - textOnly < 1_610, `got ${withImage - textOnly}`);
  assert.ok(withImage / textOnly < 1.2, "text must still dominate proportionally");

  // The same holds for the `Tool.FileContent` shape, where the delta also
  // picks up the `type`/`mime` discriminator strings of the wrapper part.
  const viaFile = tokensFor([
    {
      role: "user",
      content: [
        { type: "text", text: body },
        { type: "file", uri: image, mime: "image/png" },
      ],
    },
  ]);
  const delta = viaFile - textOnly;
  assert.ok(delta >= 1_600 && delta < 1_620, `got ${delta}`);
});

test("each media item is charged the allowance for its own kind", () => {
  const dataUrl = (mime: string, size = 1_000_000) =>
    `data:${mime};base64,${"A".repeat(size)}`;

  const image = tokensFor(fileContent(dataUrl("image/png")));
  const audio = tokensFor(fileContent(dataUrl("audio/mpeg")));
  const video = tokensFor(fileContent(dataUrl("video/mp4")));
  const pdf = tokensFor(fileContent(dataUrl("application/pdf")));
  const unknown = tokensFor(fileContent(dataUrl("application/octet-stream")));

  // 1,600 / 25,000 / 100,000 / 8,000 / 4,000, each plus a small wrapper.
  const within = (actual: number, allowance: number): boolean =>
    actual >= allowance && actual < allowance + 100;
  assert.ok(within(image, 1_600), `image got ${image}`);
  assert.ok(within(audio, 25_000), `audio got ${audio}`);
  assert.ok(within(video, 100_000), `video got ${video}`);
  assert.ok(within(pdf, 8_000), `pdf got ${pdf}`);
  assert.ok(within(unknown, 4_000), `unknown got ${unknown}`);

  // Three images in one transcript cost three allowances, not one.
  const imagePart = (name: string) => ({
    role: "tool",
    content: [
      {
        type: "tool-result",
        id: `c_${name}`,
        name: "read",
        result: {
          type: "content",
          value: [{ type: "file", uri: dataUrl("image/png"), mime: "image/png", name }],
        },
      },
    ],
  });
  const one = tokensFor([imagePart("a")]);
  const three = tokensFor([imagePart("a"), imagePart("b"), imagePart("c")]);
  // One image plus its tool-result wrapper lands on the flat allowance.
  assert.ok(within(one, 1_600), `got ${one}`);
  // Two extra allowances, plus the differing `b`/`c` and `c_b`/`c_c` name
  // strings and `estimateTokens` rounding.
  assert.ok(three - one >= 3_200 && three - one < 3_250, `got ${three - one}`);
});

test("pure-text transcripts measure exactly as before the media change", () => {
  // Reference implementation: the pre-change algorithm, a pure recursive walk
  // summing string lengths.
  const legacyChars = (value: unknown): number => {
    if (typeof value === "string") return value.length;
    if (typeof value !== "object" || value === null) return 0;
    if (Array.isArray(value)) {
      let total = 0;
      for (const item of value) total += legacyChars(item);
      return total;
    }
    let total = 0;
    for (const item of Object.values(value as Record<string, unknown>)) total += legacyChars(item);
    return total;
  };

  const messages = [
    { id: "m1", role: "system", content: [{ type: "text", text: "you are helpful" }] },
    {
      id: "m2",
      role: "user",
      content: [
        { type: "text", text: "read the file please" },
        { type: "text", text: "and the other one" },
      ],
    },
    {
      id: "m3",
      role: "assistant",
      content: [
        { type: "reasoning", text: "thinking about it" },
        { type: "tool-call", id: "c1", name: "read", input: { path: "/tmp/x", limit: 20 } },
      ],
    },
    {
      id: "m4",
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: "c1",
          name: "read",
          result: { type: "json", value: { lines: ["one", "two"], ok: true, n: 3 } },
        },
        { type: "tool-result", id: "c2", name: "grep", result: { type: "text", value: "hit" } },
      ],
    },
  ];

  assert.equal(measureMessagesChars(messages), legacyChars(messages));
  assert.equal(estimateTokens(measureMessagesChars(messages)), estimateTokens(legacyChars(messages)));
  assert.equal(measureMessagesChars(undefined), 0);
  assert.equal(measureMessagesChars([]), 0);
  assert.equal(measureMessagesChars([null, "str", 7]), 0);
});

test("opaque non-media strings and text/* data URIs are still counted as text", () => {
  const opaque = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eg==".repeat(
    20_000,
  );
  // Long, base64-shaped, and starts with "data" - but not a data URI.
  const notADataUri = `data${"A".repeat(1_000_000)}`;

  const texts = [
    { role: "user", content: [{ type: "text", text: opaque }] },
    { role: "user", content: [{ type: "text", text: notADataUri }] },
    // `data:text/plain;base64,...` decodes to text, so chars/4 is a bounded
    // 1.33x over-count of the truth and no special case is warranted.
    { role: "user", content: [{ type: "text", text: "data:text/plain;base64,QUJD" }] },
    // A `file` content whose uri is a plain path, not a data URI.
    { role: "tool", content: [{ type: "text", text: "read /tmp/a.txt" }] },
  ];

  for (const message of texts) {
    const part = message.content[0];
    assert.ok(part, "fixture must have a first part");
    assert.ok(
      measureMessagesChars([message]) >= part.text.length,
      "text must be counted in full",
    );
  }
  assert.ok(tokensFor([texts[0]!]) > 100_000, "opaque base64 text stays text");
  assert.ok(tokensFor([texts[1]!]) > 100_000, "a 'data'-prefixed non-URI stays text");
  assert.ok(tokensFor([texts[2]!]) < 10, "a tiny text data URI stays text");

  // A file content with an ordinary path uri keeps counting that path.
  const filePath = [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: "c1",
          name: "read",
          result: { type: "content", value: [{ type: "file", uri: "/tmp/report.pdf", mime: "application/pdf" }] },
        },
      ],
    },
  ];
  assert.ok(measureMessagesChars(filePath) > "/tmp/report.pdf".length);
});
